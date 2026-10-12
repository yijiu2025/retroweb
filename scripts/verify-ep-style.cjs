/**
 * Element Plus 函数式 API 样式守门。
 *
 * 🔴 为什么需要这个脚本：
 *    项目用 `ElementPlusResolver({ importStyle: 'css' })` **按需**注入组件样式，
 *    而该解析器是靠扫描**模板里的组件标签**工作的。`ElMessageBox.confirm(...)` /
 *    `ElMessage.success(...)` 是 **JS 调用、模板里没有标签** ⇒ 解析器认为"没用到"
 *    ⇒ 样式永不注入。症状是弹窗没有底板、文字穿透叠在底层内容上、按钮跑到左上角 ——
 *    **JS 逻辑全对、类型检查和 lint 全绿**，只能靠肉眼或本脚本发现。
 *
 * 判据（两层，都从源码派生，不手抄清单）：
 *   ① 从 `src/**` 里扫出**从 element-plus 具名导入**的组件，
 *      凡「有非空主题样式文件」的，其 css **必须真的被加载**（按 dev 请求到的 css 文件名判）。
 *      ⇒ 将来有人新增 `ElNotification` / `ElLoading` 之类的函数式调用，这条会自动要求补样式，
 *        不需要有人记得改本脚本。
 *   ② 行为兜底：`ElMessageBox` 的实际渲染尺寸必须是"对话框"而不是"整屏" ——
 *      样式缺失时它的宽度会等于视口宽度、定位到 (0,0)（实测）。
 *
 * ⚠️ 本脚本需要 dev server 在 5177 上跑（`npm run dev`）。
 *    它检查的是「样式模块有没有被引入」这个**构建期不变式**，dev 模式下最直观；
 *    生产产物会把 CSS 打成一个文件，届时需换判据（见文末说明）。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const THEME = path.join(ROOT, 'node_modules/element-plus/theme-chalk');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP_URL = 'http://localhost:5177/';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
};

// ── ① 从源码派生「需要样式的 EP 组件」清单 ──
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** ElMessageBox → message-box */
function toKebab(name) {
  return name.replace(/^El/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const imported = new Set();
for (const f of walk(SRC)) {
  const src = fs.readFileSync(f, 'utf8');
  // 只取 `import { … } from 'element-plus'` 里的具名导入
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]element-plus['"]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '');
      if (/^El[A-Z]/.test(name)) imported.add(name);
    }
  }
}

/** 有非空主题样式的组件才需要检查（config-provider 的 css 是 0 字节，跳过） */
const required = [];
const skipped = [];
for (const name of [...imported].sort()) {
  const kebab = toKebab(name);
  const cssFile = path.join(THEME, `el-${kebab}.css`);
  if (!fs.existsSync(cssFile) || fs.statSync(cssFile).size === 0) {
    skipped.push(`${name}(无样式)`);
    continue;
  }
  required.push({ name, kebab });
}

console.log(`源码头具名导入的 EP 组件：${[...imported].sort().join(', ')}`);
console.log(`需要样式的：${required.map((r) => r.name).join(', ')}`);
console.log(`跳过（无独立样式）：${skipped.join(', ') || '无'}\n`);

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const cssFiles = new Set();
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() === 200 && /\.css(\?|$)/.test(u)) cssFiles.add(u.split('/').pop().split('?')[0]);
  });

  await page.route('**/retro/models**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        models: [
          { key: 'pistachio', label: 'Pistachio', exists: true, state: 'ready', is_current: true, size: 1 },
          { key: 'uspto_full', label: 'USPTO-FULL', exists: true, state: 'idle', is_current: false, size: 1 }
        ],
        service: { state: 'ready', phase: '就绪' },
        forward: { key: 'fx', label: 'Forward', state: 'ready', exists: true },
        current: 'pistachio'
      })
    })
  );
  await page.route('**/retro/llm/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, has_key: false, profiles: [], active_id: '' }) })
  );
  await page.route('**/auth/**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));

  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });
  } catch {
    console.error(`\n❌ 打不开 ${APP_URL} —— 请先 npm run dev`);
    await browser.close();
    process.exit(2);
  }
  await page.waitForTimeout(2500);

  // 打开设置弹窗（让 ElMessageBox / ElMessage 相关的组件都可能被实例化）
  await page.evaluate(() => {
    const bt = [...document.querySelectorAll('button, [role=button]')].find((x) => (x.textContent || '').trim() === '设置');
    if (bt) bt.click();
  });
  await page.waitForTimeout(1500);

  // ── 判据 ①：每个需要的组件，其 css 必须被加载 ──
  const missingCss = required.filter((r) => !cssFiles.has(`el-${r.kebab}.css`));
  check(
    `① 已加载的 EP 组件样式覆盖全部 ${required.length} 个源码引用`,
    missingCss.length === 0,
    missingCss.length ? `缺：${missingCss.map((m) => `el-${m.kebab}.css`).join(', ')}` : '全部已加载'
  );

  // 逐项列证据
  for (const r of required) {
    const ok = cssFiles.has(`el-${r.kebab}.css`);
    console.log(`      ${ok ? '·' : '✗'} ${r.name.padEnd(16)} → el-${r.kebab}.css`);
  }

  // ── 判据 ②：行为兜底 —— MessageBox 必须真的像对话框 ──
  // 触发一次确认框：切到一个 idle 状态的模型
  await page.locator('.params__model .el-select').click();
  await page.waitForTimeout(700);
  const opt = page.locator('.el-select-dropdown__item:visible').filter({ hasText: 'USPTO-FULL' }).first();
  let box = null;
  if (await opt.count()) {
    await opt.click();
    await page.waitForTimeout(1200);
    box = await page.evaluate(() => {
      const el = document.querySelector('.el-message-box');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.left),
        pad: getComputedStyle(el).padding,
        viewportW: window.innerWidth
      };
    });
  }

  if (!box) {
    check('② ElMessageBox 已实例化', false, '没能触发确认框（模型下拉里没有 idle 状态的项？）');
  } else {
    // 样式缺失时：宽度 == 视口宽度、(0,0) 定位、padding 0
    check('② MessageBox 宽度是对话框而非整屏', box.w < box.viewportW * 0.5, `${box.w}px / 视口 ${box.viewportW}px`);
    check('② MessageBox 有内边距（样式已生效）', box.pad !== '0px', `padding: ${box.pad}`);
  }

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== EP 样式守门：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('\n修复方式：在 src/main.ts 补上对应样式入口，例如');
    console.log("  import 'element-plus/es/components/<kebab>/style/css';");
    process.exit(1);
  }
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
