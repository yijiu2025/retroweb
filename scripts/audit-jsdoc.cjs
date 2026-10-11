/**
 * JSDoc 缺口普查（一次性）。
 *
 * 三条判据，逐文件统计：
 *   ① 文件头是否有 @author / @since（约定：只在文件头标，函数级不加）
 *   ② 每个**导出**的函数/方法是否有 @param（无参可豁免）
 *   ③ 每个**导出**的函数/方法是否有 @returns
 *
// 只扫 src 下的 .ts（.vue 的 script setup 本就禁止顶层 export，另算）。
// 注意：本文件头刻意用行注释 —— 块注释里出现 `**` 加 `/` 会提前闭合。
 * 输出按缺口数排序，方便按"最缺"的先补。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// 关键字白名单：只认这些，绝不把 if / for / return / catch 当函数。
// ⚠️ 第一版用「行首两空格 + 标识符 + (」匹配，把 `if (`、`for (` 全收进来了，
//    导致 423 个函数 / 缺 371 的假象。方法名必须是合法标识符且不在关键字表里。
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'typeof',
  'await', 'yield', 'new', 'delete', 'void', 'in', 'of', 'case', 'throw'
]);

/** 取出每个函数/方法定义前面的 JSDoc 块 */
function collectDecls(src) {
  const lines = src.split('\n');
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name = null;
    let m = line.match(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    if (m) name = m[1];
    if (!name) {
      // 对象方法 / 类方法：行首缩进 + 名字 + (，且名字不是关键字
      m = line.match(/^\s+(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/);
      if (m && !KEYWORDS.has(m[1])) name = m[1];
    }
    if (!name) continue;
    // 往上找紧邻的注释块结尾
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    let doc = null;
    if (j >= 0 && lines[j].trim().endsWith('*/')) {
      const start = j;
      while (j >= 0 && !lines[j].includes('/**')) j--;
      if (j >= 0) doc = lines.slice(j, start + 1).join('\n');
    }
    decls.push({ line: i + 1, lineIndex: src.split('\n').slice(0, i).join('\n').length, name, doc });
  }
  return decls;
}

// 判断该函数是否会被导出。
// ⚠️ 第一版有两条错：① `src.slice(src.lastIndexOf('export'))` 在"最后一个 export"之后
//    才找，而本仓约定 export 全在末尾，多数文件能中，但含 `export type {...}` 的文件会截断；
//    ② 兜底规则"源码里出现 name( 即算导出"把**内部函数**也算进来了（虚高到 445/393）。
// 现在改成：只看文件末尾连续的 export 语句块；对象字面量（xxxApi = {…}）里的方法，
// 若该对象本身被导出，则**全部计入**（它们是对外契约）。
function isExported(src, name) {
  const lines = src.split('\n');
  // 从末尾往上收集所有 export 行（允许中间夹空行与注释行）
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '*/') continue;
    if (t.startsWith('export')) start = i;
    else if (start < lines.length) break;
  }
  const tail = lines.slice(start).join('\n');
  return new RegExp(`\\b${name}\\b`).test(tail);
}

/** 该文件是否导出了某个对象字面量（如 const xxxApi = {…}; export { xxxApi }） */
function exportsObjectWithMethods(src) {
  const lines = src.split('\n');
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t === '*/') continue;
    if (t.startsWith('export')) start = i;
    else if (start < lines.length) break;
  }
  return /\b\w+\s*[,}]/.test(lines.slice(start).join('\n'));
}

const files = walk(SRC);
const report = [];
let totalFn = 0;
let missParam = 0;
let missReturns = 0;
let missHeader = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(path.join(__dirname, '..'), f);
  // 🔴 扫描范围必须是**整个文件头块注释**，不能只取前 1200 字符：
  //    endpoint-config.ts 的文件头很长（有档位对照表），标签在 1500+ 处，
  //    固定窗口会把它误报成"缺 @author"。
  const headEnd = src.indexOf('*/');
  const head = headEnd === -1 ? src : src.slice(0, headEnd + 2);
  const hasAuthor = /@author/.test(head);
  const hasSince = /@since/.test(head);
  // 生成文件（unplugin-vue-components 自动产出）不纳入人工维护口径
  const generated = /\.d\.ts$/.test(rel);

  const decls = collectDecls(src).filter((d) => isExported(src, d.name));
  const gaps = [];
  for (const d of decls) {
    totalFn++;
    const problems = [];
    const doc = d.doc || '';
    // 参数量：数签名括号里的顶层逗号。无参函数不该有 @param（写了是噪音）
    const sigEnd = src.indexOf('{', d.lineIndex);
    const sig = src.slice(d.lineIndex, sigEnd > 0 ? sigEnd : d.lineIndex + 220);
    const paramCount = Math.max(0, (sig.match(/[,()]/g) || []).length - 2);
    if (!doc) {
      problems.push('无 JSDoc');
      if (paramCount > 0) missParam++;
      missReturns++;
    } else {
      const hasParamTag = /@param\b/.test(doc);
      const hasReturnsTag = /@returns\b/.test(doc);
      if (!hasParamTag && paramCount > 0) {
        problems.push('缺 @param');
        missParam++;
      }
      if (!hasReturnsTag) {
        problems.push('缺 @returns');
        missReturns++;
      }
    }
    if (problems.length) gaps.push(`    L${d.line} ${d.name}: ${problems.join(' + ')}`);
  }

  const headerGap = !generated && (!hasAuthor || !hasSince);
  if (headerGap) missHeader++;

  if (gaps.length || headerGap) {
    report.push({ rel, gaps, headerGap, hasAuthor, hasSince, count: gaps.length });
    void 0;
  }
}

report.sort((a, b) => b.count - a.count);

console.log('=== 文件头缺口（@author / @since）===');
for (const r of report.filter((x) => x.headerGap)) {
  console.log(`  ${r.rel}  author=${r.hasAuthor ? 'Y' : 'N'} since=${r.hasSince ? 'Y' : 'N'}`);
}
console.log(`\n文件头缺口合计：${missHeader} / ${files.length} 个文件\n`);

console.log('=== 函数级 JSDoc 缺口 ===');
for (const r of report) {
  if (!r.gaps.length) continue;
  console.log(`  ${r.rel}  (${r.count})`);
  r.gaps.forEach((g) => console.log(g));
}

console.log(
  `\n=== 汇总：导出函数 ${totalFn} 个，缺 @param ${missParam}，缺 @returns ${missReturns}，文件头缺 ${missHeader} ===`
);

// 🔴 有缺口必须以非 0 退出，否则接进 CI 也是装饰（反向证明：删掉一个 @returns 即变红）。
//    基线：导出函数 62，缺口全 0，文件头缺 0。
if (missParam || missReturns || missHeader) {
  console.error('\n❌ JSDoc 不完整 —— 补齐 @param / @returns / 文件头 @author+@since 后再提交');
  process.exit(1);
}
console.log('✅ JSDoc 完整');
