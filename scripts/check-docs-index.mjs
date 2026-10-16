/**
 * 两级入口体系校验（docs 文档地图）
 *
 * 判据（与 fullstack-rules → references/docs-conventions.md 同口径）：
 *   ① 含 >=2 个 md 的目录必须自持 README 入口；只 1 个 md 的目录由上级 README 展开登记
 *   ② 每个 md（README 自身 / 站点首页除外）必须被**最近的有 README 的祖先目录**登记
 *   ③ 全站相对链接无死链（GitHub 可点口径：链接必须带 .md 后缀）
 *
 * 用法：
 *   node check-docs-index.mjs [docsDir] [ignoreDir...]
 *   node check-docs-index.mjs docs .vitepress public
 *
 * 退出码：0 = 全部通过；1 = 有问题（逐条打印）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const docsDir = resolve(process.argv[2] || 'docs').replace(/\\/g, '/');
const ignoreDirs = (process.argv.slice(3) || []).map((d) => `${d.replace(/\/+$/, '')}/`);
let fail = 0;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (ignoreDirs.some((ig) => `${p.replace(/\\/g, '/')}/`.includes(ig))) continue;
      walk(p, out);
    } else if (name.endsWith('.md')) {
      out.push(p.replace(/\\/g, '/'));
    }
  }
  return out;
}

const all = walk(docsDir).sort();

// ① 目录级入口强制
const dirs = [...new Set(all.map((f) => dirname(f)))].sort();
for (const d of dirs) {
  const own = all.filter((f) => dirname(f) === d && !f.endsWith('/README.md'));
  if (own.length === 0) continue;
  if (own.length >= 2 && !existsSync(join(d, 'README.md'))) {
    console.log(`❌ ${d} 有 ${own.length} 个 md 但缺 README 入口`);
    fail++;
  } else if (own.length === 1 && !existsSync(join(d, 'README.md'))) {
    console.log(`ⓘ ${d} 单文件，由上级 README 登记`);
  } else {
    console.log(`✅ ${d}/README.md`);
  }
}

// ② 每个 md 必须被最近的祖先入口登记
function entryFor(f) {
  let dir = dirname(f);
  while (dir.startsWith(docsDir)) {
    const readme = join(dir, 'README.md');
    if (existsSync(readme)) return readme;
    dir = dirname(dir);
  }
  return null;
}
let unindexed = 0;
for (const f of all) {
  if (f.endsWith('/README.md')) continue;
  const entry = entryFor(f);
  if (!entry) { console.log(`❌ ${f} 无任何祖先入口`); fail++; continue; }
  const base = f.split('/').pop();
  if (!readFileSync(entry, 'utf8').includes(base)) {
    console.log(`❌ 未登记: ${f}（应登记进 ${entry}）`);
    fail++; unindexed++;
  }
}
if (!unindexed) console.log(`✅ ${all.length} 个 md 全部登记进入口`);

// ③ 相对链接死链
let dead = 0;
for (const f of all) {
  const content = readFileSync(f, 'utf8');
  const re = /\]\((\.[^)#]+)(?:#[^)]*)?\)/g;
  let m;
  while ((m = re.exec(content))) {
    const target = join(dirname(f), m[1]);
    if (!existsSync(target)) { console.log(`❌ 死链: ${f} -> ${m[1]}`); fail++; dead++; }
  }
}
if (!dead) console.log('✅ 相对链接无死链');

console.log(fail ? `\n共 ${fail} 处问题` : '\n全部通过');
process.exit(fail ? 1 : 0);
