/**
 * 发版决策的**纯逻辑层** —— 不碰 git / 网络 / 文件系统，可直接测试。
 *
 * ── 为什么 retroweb 自己带一份，而不是 import 父仓的 ──
 * 父仓（nodeServers）有同构实现（`src/framework/release/index.js`，带 jest 覆盖）。
 * 但 **retroweb 是独立公开仓库**：脚本若 `import '../../src/framework/release/…'`，
 * 任何克隆本仓的人都拿不到那个文件，`npm run release` 直接报错。
 * 发版脚本是仓库自己的工具，必须自包含 ⇒ 此处**有意重复**这 ~60 行纯函数。
 *
 * 🔴 因此：**改判定规则时两边都要改**（父仓那份 + 这里）。规则本身很稳定
 *    （Conventional Commits + semver），重复成本远低于"公开仓引用私有父仓"的代价。
 *
 * 宿主入口见 `scripts/release.mjs`，单元测试见 `scripts/release-lib.test.mjs`。
 *
 * @author yijiu2025
 * @since 2026-10-12
 */

/** Conventional Commits 前缀：type(scope)!: subject */
const TYPE_RE = /^(feat|fix|perf|refactor|docs|test|chore|style|ci|build|revert)(?:\([^)]*\))?(!)?:\s*(.+)$/;

/** Release 说明里的分组标题 */
const SECTION_TITLES = {
  feat: '新功能',
  fix: '修复',
  perf: '性能',
  refactor: '重构',
  docs: '文档',
  test: '测试',
  build: '构建',
  ci: 'CI',
  style: '样式',
  chore: '杂项',
  revert: '回滚',
  other: '其他'
};

/**
 * Release 说明对**公网可见**（本仓已公开），先自查有没有把修复细节写成对外情报。
 * ⚠️ 误报是安全的（只是提醒人工确认），漏报才危险 ⇒ 宁可宽。
 */
const SENSITIVE_RE = /(漏洞|泄露|泄漏|未授权|越权|注入|绕过|CVE-\d|token|secret|password|密钥|凭证)/i;

/**
 * 🔴 破坏性变更**只认 Conventional Commits 的 footer 形式**（行首 + 冒号），
 *    不能退化成子串匹配 —— 否则提交正文里"提到"这个词（例如写发版规则自身）
 *    就会把自己判成破坏性变更，把本该 patch 的误升成 major。父仓实测踩过。
 */
const BREAKING_RE = /^BREAKING[ -]CHANGE:/m;

/**
 * @param subject 提交标题（首行）
 * @returns 解析出的类型 / 是否带 `!` / 去掉前缀后的正文
 */
function parseSubject(subject) {
  const m = TYPE_RE.exec(subject);
  if (!m) return { type: 'other', bang: false, text: String(subject).trim() };
  return { type: m[1], bang: m[2] === '!', text: m[3].trim() };
}

/**
 * @param commits 提交列表，每项 `{ subject, body? }`
 * @returns 按类型分桶的标题清单 + 是否存在破坏性变更
 */
function classify(commits) {
  const buckets = {};
  let breaking = false;

  for (const { subject = '', body = '' } of commits) {
    const parsed = parseSubject(subject);
    if (parsed.bang || BREAKING_RE.test(body)) breaking = true;
    (buckets[parsed.type] ||= []).push(String(subject).trim());
  }

  return { buckets, breaking };
}

/**
 * 决定版本递增档位。
 *
 * @returns `'major' | 'minor' | 'patch'`；**`null` 表示"不该发版"**
 *          （只有 chore/docs/test/style/ci/refactor/build 时）
 */
function decideBump({ buckets = {}, breaking = false } = {}) {
  if (breaking) return 'major';
  if (buckets.feat?.length) return 'minor';
  if ((buckets.fix?.length ?? 0) + (buckets.perf?.length ?? 0) > 0) return 'patch';
  return null;
}

/**
 * @param version 形如 `1.0.2` 或 `v1.0.2`
 * @param kind    `major | minor | patch`
 * @returns 递增后的版本号（不带 `v`）
 */
function bumpVersion(version, kind) {
  const [major, minor, patch] = String(version).replace(/^v/, '').split('.').map(Number);
  if (![major, minor, patch].every(Number.isFinite)) {
    throw new Error(`无法解析版本号：${version}`);
  }
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`未知的递增档位：${kind}`);
}

/**
 * @returns `a - b`（三段比较）；用于「本地版本是否已高于线上」这类判断
 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * 生成 Release 说明正文（中文分组 + 完整变更命令）。
 *
 * @param args.from  起算点 tag（可为 null = 仓库初始）
 * @param args.to    本次 tag
 * @param args.buckets `classify` 的分桶结果
 * @param args.count  提交总数
 */
function buildNotes({ from, to, buckets = {}, count }) {
  const summary = Object.entries(buckets)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, list]) => `${list.length} ${type}`)
    .join(' / ');

  const lines = [`自 \`${from || '仓库初始'}\` 起共 ${count} 个提交（${summary}）。`, ''];

  for (const [type, title] of Object.entries(SECTION_TITLES)) {
    const list = buckets[type];
    if (!list?.length) continue;
    lines.push(`### ${title}`, '');
    for (const subject of list) lines.push(`- ${parseSubject(subject).text}`);
    lines.push('');
  }

  lines.push('---', '', `完整变更：\`git log ${from || ''}..${to}\``);
  return lines.join('\n');
}

/**
 * @returns 标题含敏感表述的提交标题，供发版前人工确认
 */
function findSensitive(commits) {
  return commits.map((c) => c.subject).filter((subject) => SENSITIVE_RE.test(subject));
}

export {
  TYPE_RE,
  BREAKING_RE,
  SENSITIVE_RE,
  SECTION_TITLES,
  parseSubject,
  classify,
  decideBump,
  bumpVersion,
  compareSemver,
  buildNotes,
  findSensitive
};
