/**
 * 「流式思考能否打断 + 打断后能否继续」守门脚本。
 *
 * 覆盖三条独立链路（各有自己的停止按钮与 abort）：
 *   ① 单步工艺分析   POST /llm/analyze/stream     → cancelAnalysis
 *   ② 候选条件枚举   POST /llm/conditions/stream  → cancelConditions
 *   ③ 一键分析全路线  store.analyzeRoute 的串行循环 → cancelRouteAnalysis
 *
 * 🔴 只测 ① 会漏掉大多数真实场景：「先列候选条件」是**默认开启**的，
 *    用户第一次点下去实际走的是 ②；而「一键分析全路线」是唯一**完全没有停止入口**的那条（③）。
 *
 * 桩法：把 SSE 请求**挂住不响应**，store 在发请求前就置 streaming ⇒ 界面一直停在思考态。
 * abort 是否真生效，用 Playwright 的 `requestfailed` + `net::ERR_ABORTED` 判定 ——
 * 那是"客户端真的断开"了的硬证据，比"界面看着停了"可靠。
 *
 * 🔴 批量场景必须能证明「停止后不再往下跑」：只断言"当前步断了"是不够的 ——
 *    循环若不看取消标志，会在当前步结束后**继续跑下一步**，而用户以为已经停了。
 *    所以这里用 3 步（第 1 步预置 done、第 2 步挂住、第 3 步待跑），
 *    判据 = **停止后第 3 步的请求从未发出**（SSE 请求数停在 1）。
 *
 * 需要 dev server 在 5177 上跑（`npm run dev`）。
 */
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5177/';
const SSE_RE = /\/llm\/(analyze|conditions)\/stream/;

const MODELS = {
  ok: true,
  models: [{ key: 'pistachio', label: 'Pistachio', exists: true, state: 'ready', is_current: true, size: 1 }],
  service: { state: 'ready', phase: '就绪' },
  forward: { key: 'fx', label: 'Forward', state: 'ready', exists: true },
  current: 'pistachio'
};

const rxn = (id, productNodeId, rank = 1) => ({
  id,
  productNodeId,
  rank,
  probability: 0.87,
  level: 'high',
  precursors: 'C=C.O',
  precursorList: ['C=C', 'O'],
  numMolecules: 2,
  childNodeIds: [],
  origin: 'model'
});

/**
 * @param steps 路线上的步数（1 或 3）
 * @param firstDone 是否把第 1 步预置成「已分析」（批量场景需要）
 */
function seedSession(steps = 1, firstDone = false) {
  const nodes = {
    n_root: {
      id: 'n_root', smiles: 'CCO', role: 'target', depth: 0, status: 'expanded',
      formula: 'C2H6O', mw: 46.07, atoms: 3, probabilityChain: 1, fetched: true,
      chosenReactionId: 'r1', candidates: [rxn('r1', 'n_root')], children: steps > 1 ? ['n_1'] : [],
      analyses: firstDone
        ? { r1: { reactionId: 'r1', status: 'done', raw: '{}', data: null, computed: null } }
        : {}
    }
  };
  for (let i = 1; i < steps; i += 1) {
    const id = `n_${i}`;
    nodes[id] = {
      id, smiles: `C${i}`, role: 'intermediate', depth: i, status: 'expanded',
      formula: 'CH4', mw: 16, atoms: 5, probabilityChain: 0.8, fetched: true,
      chosenReactionId: `r${i + 1}`, candidates: [rxn(`r${i + 1}`, id)],
      children: i + 1 < steps ? [`n_${i + 1}`] : [],
      analyses: {}
    };
  }
  return [
    {
      id: 's_test', name: '测试任务', target: 'CCO', model: 'pistachio', status: 'active',
      updatedAt: Date.now(), createdAt: Date.now(),
      snapshot: {
        rootId: 'n_root', activeNodeId: 'n_root', jobIds: {}, schemes: [], currentSchemeId: null,
        params: { model: 'pistachio', depth: 3, maxCalls: 100, maxAtoms: 6, candidates: 5, forwardFilter: false, autoRunning: false },
        nodes
      }
    }
  ];
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
};

/** 建好一个已装载任务、停在「步骤详情 → 展开工艺分析」的页面 */
async function openPage(browser, { steps = 1, firstDone = false, planFirst = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const state = { sse: 0, aborted: [] };

  page.on('requestfailed', (r) => {
    if (SSE_RE.test(r.url())) state.aborted.push(r.failure()?.errorText || '?');
  });

  await page.route('**/retro/models**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MODELS) }));
  await page.route('**/retro/llm/status**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, has_key: true, configured: true, model: 'test-model' }) }));
  await page.route('**/retro/llm/settings**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, active_id: 'd', profiles: [] }) }));
  // 挂住不响应 —— 制造持续的"思考中"
  await page.route('**/retro/llm/analyze/stream**', () => { state.sse += 1; });
  await page.route('**/retro/llm/conditions/stream**', () => { state.sse += 1; });

  await page.addInitScript(({ sessions, pf }) => {
    localStorage.setItem('retroweb_sessions', JSON.stringify(sessions));
    localStorage.setItem('retroweb_cond_pref', JSON.stringify({ planFirst: pf, count: 5 }));
  }, { sessions: seedSession(steps, firstDone), pf: planFirst });

  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.evaluate(() => document.querySelector('.recent__item')?.click());
  await page.waitForTimeout(2200);
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.el-tabs__item,[role=tab]')].find((x) => (x.textContent || '').includes('步骤详情'));
    if (t) t.click();
  });
  await page.waitForTimeout(1400);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.flow button')].find((x) => /展开工艺分析/.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(1400);
  return { ctx, page, state };
}

/**
 * 按文本点按钮。
 * 🔴 必须先 `trim()` 再匹配：Element Plus 按钮的 textContent 带前后空白与换行，
 *    不 trim 的话 `^停止$` 这种带锚点的正则**永远匹配不上** ——
 *    表现为"点了没反应"，很容易误判成功能坏了（我先误判了一次）。
 */
const clickText = (page, sel, re) =>
  page.evaluate(({ s, r }) => {
    const b = [...document.querySelectorAll(s)].find((x) => new RegExp(r).test((x.textContent || '').trim()));
    if (b) { b.click(); return (b.textContent || '').trim(); }
    return null;
  }, { s: sel, r: re.source });

/* ---------- 场景 ①：单步分析 ---------- */
async function scenarioAnalyze(browser) {
  console.log('\n──── ① 单步工艺分析 ────');
  const { ctx, page, state } = await openPage(browser);
  await clickText(page, '.ana button', /^开始分析$|^重试$/);
  await page.waitForTimeout(1600);

  const during = await page.evaluate(() => {
    const stop = [...document.querySelectorAll('.ana button')].find((x) => (x.textContent || '').trim() === '停止');
    return {
      streaming: !!document.querySelector('.ana__streaming'),
      stopVisible: !!stop && stop.getBoundingClientRect().width > 0,
      stopInView: stop ? (() => { const r = stop.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })() : false
    };
  });
  check('思考中：流式区块已渲染', during.streaming === true);
  check('思考中：「停止」可见且在视口内', during.stopVisible && during.stopInView);

  await clickText(page, '.ana button', /^停止$/);
  await page.waitForTimeout(2200);

  const after = await page.evaluate(() => {
    const txt = document.querySelector('.ana')?.innerText || '';
    return {
      stillStreaming: !!document.querySelector('.ana__streaming'),
      friendly: /已停止分析/.test(txt),
      rawAbortText: /signal is aborted|AbortError|without reason/.test(txt),
      followupInput: !!document.querySelector('.ana__fu-ask textarea, .ana__fu-ask input'),
      text: txt.slice(0, 160)
    };
  });
  check('打断：请求真断开（ERR_ABORTED）', state.aborted.some((a) => /ERR_ABORTED/.test(a)), state.aborted.join('|') || '无');
  check('打断后不再处于流式态', after.stillStreaming === false);
  check('打断后用中文说明（不是「分析失败」）', after.friendly === true, after.text.replace(/\n/g, ' '));
  check('🔴 打断后没有暴露浏览器内部报错', after.rawAbortText === false);
  check('🔴 打断后可直接继续追问（输入框在）', after.followupInput === true);

  // 🔴 判据不能只看**可见文本**：`interrupted` 会让模板走友好分支，
  //    于是"浏览器内部报错被写进记录"这件事在界面上**看不见** ——
  //    只查 innerText 的判据会放它过去（反向证明时发现的）。
  //    所以直接查**落盘的记录**：那里才是会被导出/回看的地方。
  await page.waitForTimeout(2000); // 等防抖落盘
  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('retroweb_sessions') || '[]';
    const bad = [];
    for (const s of JSON.parse(raw)) {
      for (const n of Object.values(s.snapshot?.nodes || {})) {
        for (const rec of Object.values(n.analyses || {})) {
          const err = String(rec.error || '');
          if (/aborted|AbortError|without reason/i.test(err)) bad.push(err);
          const cerr = String(rec.condOptions?.error || '');
          if (/aborted|AbortError|without reason/i.test(cerr)) bad.push(cerr);
        }
      }
    }
    return bad;
  });
  check('🔴 落盘记录里没有浏览器内部报错', stored.length === 0, stored.join(' | ') || '干净');

  await page.screenshot({ path: '.tmp-probe/interrupt-analyze.png' });
  await ctx.close();
}

/* ---------- 场景 ②：候选条件枚举（默认流程） ---------- */
async function scenarioConditions(browser) {
  console.log('\n──── ② 候选条件枚举（默认流程） ────');
  const { ctx, page, state } = await openPage(browser, { planFirst: true });
  await clickText(page, '.ana button', /列出候选条件|先看候选条件/);
  await page.waitForTimeout(1600);

  const during = await page.evaluate(() => {
    const stop = [...document.querySelectorAll('.ana button')].find((x) => (x.textContent || '').trim() === '停止');
    return { stopVisible: !!stop && stop.getBoundingClientRect().width > 0 };
  });
  check('枚举中：「停止」可见', during.stopVisible === true);

  await clickText(page, '.ana button', /^停止$/);
  await page.waitForTimeout(2200);

  const after = await page.evaluate(() => {
    const txt = document.querySelector('.ana')?.innerText || '';
    return {
      friendly: /已停止枚举/.test(txt),
      rawAbortText: /signal is aborted|AbortError|without reason/.test(txt),
      // 枚举被打断时**还没有任何分析结果** ⇒ 不该有"追问对象"；
      // 但必须给出一条明确的下一步（重试 / 不限条件直接分析）
      nextAction: /重试|不限条件/.test(txt),
      text: txt.slice(0, 160)
    };
  });
  check('枚举打断：请求真断开（ERR_ABORTED）', state.aborted.some((a) => /ERR_ABORTED/.test(a)), state.aborted.join('|') || '无');
  check('枚举打断后用中文说明', after.friendly === true, after.text.replace(/\n/g, ' '));
  check('🔴 枚举打断后无浏览器内部报错', after.rawAbortText === false);
  check('枚举打断后有明确的下一步入口', after.nextAction === true);

  await page.screenshot({ path: '.tmp-probe/interrupt-conditions.png' });
  await ctx.close();
}

/* ---------- 场景 ③：一键分析全路线 ---------- */
async function scenarioBatch(browser) {
  console.log('\n──── ③ 一键分析全路线（3 步：第 1 步已完成）────');
  const { ctx, page, state } = await openPage(browser, { steps: 3, firstDone: true });

  const startBtn = await clickText(page, '.flow__ops button', /一键分析全路线/);
  check('批量入口存在', !!startBtn, startBtn || '');
  await page.waitForTimeout(2000);

  const during = await page.evaluate(() => {
    const stop = [...document.querySelectorAll('.flow__ops button')].find((x) => (x.textContent || '').trim() === '停止');
    return {
      sseStarted: true,
      stopVisible: !!stop && stop.getBoundingClientRect().width > 0,
      hasStart: [...document.querySelectorAll('.flow__ops button')].some((x) => /一键分析全路线/.test(x.textContent || ''))
    };
  });
  check('运行中：「停止」按钮出现', during.stopVisible === true);
  check('运行中：不再显示「一键分析全路线」', during.hasStart === false);
  check('运行中：已发出 1 次 SSE（第 2 步，第 1 步已完成被跳过）', state.sse === 1, `sse=${state.sse}`);

  await clickText(page, '.flow__ops button', /^停止$/);
  await page.waitForTimeout(3000);

  check('批量打断：请求真断开（ERR_ABORTED）', state.aborted.some((a) => /ERR_ABORTED/.test(a)), state.aborted.join('|') || '无');
  check('🔴 停止后**不再往下跑**（第 3 步的请求从未发出）', state.sse === 1, `sse=${state.sse}（>1 说明循环没看取消标志）`);

  const after = await page.evaluate(() => ({
    stopGone: ![...document.querySelectorAll('.flow__ops button')].some((x) => (x.textContent || '').trim() === '停止'),
    startBack: [...document.querySelectorAll('.flow__ops button')].some((x) => /一键分析全路线/.test(x.textContent || ''))
  }));
  check('停止后按钮复位为「一键分析全路线」', after.startBack === true);
  check('停止后「停止」按钮消失', after.stopGone === true);

  await page.screenshot({ path: '.tmp-probe/interrupt-batch.png' });
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  await scenarioAnalyze(browser);
  await scenarioConditions(browser);
  await scenarioBatch(browser);
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 流式中断守门：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('未通过：');
    failed.forEach((f) => console.log(`  - ${f.name}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('异常:', e);
  process.exit(2);
});
