#!/usr/bin/env node
/**
 * 共享门禁完整性自检（ci-quality-check）
 *
 * 判据：.github/workflows/ci-quality.yml 末尾的
 *   # canonical-sha256: <64 位十六进制>
 * 一章，记录「删掉该行后全文（CRLF 归一为 LF）」的 SHA-256。
 * 重算值与记录值不符 ⇒ 文件被手改或已过期 ⇒ CI 红。
 *
 * 设计意图：共享门禁在各仓是字节级一致的副本，「禁止手改」不能只靠文档 ——
 * 本脚本把「一致」变成可执行判据。它是算法型脚本（不内嵌 canonical 内容），
 * 因此自身在所有仓也字节一致，不存在第二处漂移点。
 *
 * 修复方式（不要手改本文件所在的 workflows）：
 *   改技能 canonical 后重新分发：
 *   node .claude/skills/fullstack-rules/scripts/distribute-ci.mjs <仓路径...>
 *
 * 用法：
 *   node scripts/ci-quality-check.mjs [--root <仓库根，默认当前目录>]
 *
 * 退出码：0 = 一致；1 = 不一致 / 缺盖章 / 文件缺失（CI 应失败）
 *
 * @author yijiu2025
 * @since 2026-10-17
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
let root = process.cwd();
const rootIdx = args.indexOf('--root');
if (rootIdx !== -1) {
  root = args[rootIdx + 1];
  if (!root) {
    console.error('用法: node scripts/ci-quality-check.mjs [--root <仓库根>]');
    process.exit(1);
  }
}

const REL = '.github/workflows/ci-quality.yml';
const file = resolve(root, REL);

if (!existsSync(file)) {
  console.error(`❌ 缺少 ${REL} —— 共享门禁未接入？`);
  console.error('   接入三件套：ci-quality.yml + scripts/ci-quality-check.mjs + 入口 ci.yml，');
  console.error('   规范见 fullstack-rules → references/ci-conventions.md。');
  process.exit(1);
}

const content = readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
const match = content.match(/^# canonical-sha256: ([0-9a-f]{64})$/m);
if (!match) {
  console.error(`❌ ${REL} 缺少 canonical-sha256 盖章行 —— 文件被手改或来源不正规`);
  console.error('   修复：改技能 canonical 后用 distribute-ci.mjs 重新分发，勿手改。');
  process.exit(1);
}

const recorded = match[1];
// 盖章行自身不参与哈希（自引用不可能），删掉该行（含换行）后对全文哈希
const stripped = content.replace(/^# canonical-sha256: [0-9a-f]{64}\n?/m, '');
const actual = createHash('sha256').update(stripped, 'utf-8').digest('hex');

if (actual !== recorded) {
  console.error(`❌ ${REL} 与 canonical 不一致（被手改或已过期）`);
  console.error(`   记录值: ${recorded}`);
  console.error(`   重算值: ${actual}`);
  console.error('   修复：改技能 canonical 后用 distribute-ci.mjs 重新分发，勿手改。');
  process.exit(1);
}

console.log(`✅ 共享门禁完整性自检通过（${REL} 与 canonical 一致）`);
