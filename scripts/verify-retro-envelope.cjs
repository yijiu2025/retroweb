/**
 * retro API「响应拆包」回归探针。
 *
 * 🔴 为什么必须用**桩响应**：本 bug（`unwrapNodeEnvelope` 返回裸负载而不是
 *    `AxiosResponse`）在**后端没起时完全不会暴露** —— 请求直接 reject，走 catch 分支。
 *    只有后端**真的返回了响应**才会走到拆包逻辑，`const { data }` 才会得到 undefined。
 *    我上一轮的探针全都跑在「后端未启」的环境里，所以全部漏过。
 *
 * 覆盖两条最容易被拆包坑到的路径：
 *   · `/retro/models`       → `stores/parts/models.ts` 读 `res.models`
 *   · `/retro/llm/settings` → `api/retro/llm.ts` 读 `data`（settings 族）
 *
 * 判据分两层：
 *   ① 桩**确实被命中**（没命中 = 探针自己失效，测试变成假绿）
 *   ② 无 "Cannot read properties of undefined" 报错，且数据真的渲染出来
 */
const { chromium } = require('playwright-core');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5177/';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
};

/** 一份真实形状的 /models 响应（后端 Flask 的裸 JSON，非 Node 信封） */
const MODELS_BODY = {
  ok: true,
  models: [
    { key: 'pistachio', label: 'Pistachio', exists: true, state: 'ready', is_current: true, size: 1234567890 },
    { key: 'uspto_full', label: 'USPTO-FULL', exists: true, state: 'ready', is_current: false, size: 987654321 }
  ],
  service: { state: 'ready', phase: '就绪', pid: 1234 },
  forward: { key: 'forward_uspto', label: 'Forward USPTO', state: 'ready', exists: true },
  current: 'pistachio'
};

/** 一份真实形状的 /llm/settings 响应 */
const LLM_SETTINGS_BODY = {
  ok: true,
  active_id: 'default',
  profiles: [
    {
      id: 'default',
      name: 'DeepSeek 官方',
      base_url: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      keys: [{ id: 'k1', masked: 'sk-****ab3f', enabled: true }],
      temperature: 0.3,
      json_mode: true,
      timeout: 300,
      max_tokens: 32768
    }
  ]
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  const hit = { models: 0, llmSettings: 0 };

  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/.test(t)) return; // 后端未起的资源失败，与本 bug 无关
    errors.push('console.error: ' + t);
  });

  // ── 桩：/models ──
  await page.route('**/retro/models**', async (route) => {
    hit.models++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MODELS_BODY)
    });
  });

  // ── 桩：/llm/settings 及 llm 其余只读端点 ──
  await page.route('**/retro/llm/settings**', async (route) => {
    hit.llmSettings++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(LLM_SETTINGS_BODY)
    });
  });
  await page.route('**/retro/llm/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, has_key: true, configured: true, model: 'deepseek-chat' })
    });
  });

  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 🔴 LLM 配置是**懒加载**的：不打开「运行设置」弹窗就不会请求 `/llm/settings`，
  //    也就覆盖不到 llm.ts 那 9 个调用点。所以必须真的把弹窗点开。
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role=button]')];
    const b = btns.find((x) => (x.textContent || '').trim() === '设置');
    if (b) b.click();
  });
  await page.waitForTimeout(2000);

  // ① 桩命中（防止探针自己失效造成假绿）
  check('桩 /retro/models 被命中', hit.models > 0, `${hit.models} 次`);
  check('桩 /retro/llm/settings 被命中', hit.llmSettings > 0, `${hit.llmSettings} 次`);

  // ② 没有 undefined 解构报错
  const undefinedErrs = errors.filter((e) => /Cannot read properties of undefined/.test(e));
  check('无 "Cannot read properties of undefined"', undefinedErrs.length === 0,
    undefinedErrs.slice(0, 2).join(' | ') || 'clean');

  // 🔴 关键判据：错误在 store 的 try/catch 里被吞进**全局错误条**，
  //    所以 pageerror / console.error 都抓不到它 —— 必须直接查**错误条文本**。
  //    （反向证明时发现的：只查 console 会让 bug 版"通过"，探针等于失效。）
  const pageText = await page.evaluate(() => document.body.innerText);
  const barHit = /Cannot read properties of undefined/.test(pageText);
  check('错误条未出现拆包 TypeError', barHit === false,
    barHit ? '错误条原文: ' + (pageText.match(/Cannot read properties of undefined[^\n]*/) || [''])[0] : 'clean');

  // ③ 模型数据真的进了界面（证明不是"没报错但也没数据"）
  const rendered = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasPistachio: text.includes('Pistachio'),
      hasUspto: text.includes('USPTO'),
      hasLoadFailMsg: /获取模型列表失败/.test(text)
    };
  });
  check('模型列表已渲染（Pistachio 可见）', rendered.hasPistachio === true);
  check('未出现「获取模型列表失败」', rendered.hasLoadFailMsg === false);

  check('无其他 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

  await page.screenshot({ path: '.tmp-probe/shot-retro-envelope.png' });
  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== 拆包回归：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  - ${f.name}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('探针异常：', e);
  process.exit(2);
});
