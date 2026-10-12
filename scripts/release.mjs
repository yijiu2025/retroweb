/**
 * retroweb 发版脚本 —— 按提交类型自动决定版本并发布。
 *
 * 覆盖两条通道（本仓不发布 npm 包，故无第三条）：
 *   ① git annotated tag
 *   ② GitHub Release（说明由提交类型自动分中文组）
 *
 * 用法：
 *   node scripts/release.mjs                      # 预览（默认，不写任何东西）
 *   node scripts/release.mjs --apply              # 执行
 *   node scripts/release.mjs --from v1.0.0        # 指定起算点（复盘/补发）
 *   node scripts/release.mjs --apply --allow-dirty
 *   node scripts/release.mjs --apply --skip-checks
 *
 * 判定规则（与父仓 nodeServers 的 AGENTS.md 一致）
 *
 * | 提交类型                                   | 是否发布 | 递增（以最新 tag 为基线）  |
 * | ------------------------------------------ | -------- | -------------------------- |
 * | 破坏性（`!:` 或 footer 的 BREAKING CHANGE） | 发       | major                      |
 * | 含 `feat`                                  | 发       | minor：`1.0.2` → `1.1.0`   |
 * | 仅 `fix` / `perf`                          | 发       | patch：`1.0.2` → `1.0.3`   |
 * | 仅 chore/docs/test/style/ci/refactor/build  | **不发** | —                          |
 *
 * 纯逻辑在 `./release-lib.mjs`（带单元测试），本文件只做宿主职责。
 *
 * 🔴 **版本源是 git tag**，`package.json` 的 `version` 单向跟随 ——
 *    脚本会在打 tag 前把它对齐（不一致时单独提交一个 `chore(release): x.y.z`），
 *    这样 tag 指向的提交里版本号就是对的。**不要反过来拿 package.json 推版本号。**
 *
 * @author yijiu2025
 * @since 2026-10-12
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify,
  decideBump,
  bumpVersion,
  buildNotes,
  findSensitive
} from './release-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const ALLOW_DIRTY = process.argv.includes('--allow-dirty');
/** 跳过发版前的闸门（默认会跑）。仅在明确知道自己在做什么时用。 */
const SKIP_CHECKS = process.argv.includes('--skip-checks');

const FROM_OVERRIDE = (() => {
  const i = process.argv.indexOf('--from');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

/** 父仓的工具：本机 git 不写松散 ref，packed-refs 需同步修正，否则 status 会长期谎报 ahead */
const FIX_REFS_TOOL = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'tools', 'fix-packed-refs.mjs');

/* ---------- 子进程执行 ---------- */

const TMP_DIR = mkdtempSync(path.join(tmpdir(), 'retroweb-release-'));
const STDOUT_FILE = path.join(TMP_DIR, 'stdout.log');
const STDERR_FILE = path.join(TMP_DIR, 'stderr.log');
const STDIN_FILE = path.join(TMP_DIR, 'stdin.txt');
process.on('exit', () => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不是错误 */
  }
});

/**
 * 同步执行子进程并取回输出。
 *
 * 🔴 **刻意不用 `execFileSync` / `execSync`**：本机环境下「同步 + 管道」恒定失败 ——
 *    对任何可执行文件都抛 `EBUSY`（errno -4082），换 Node 版本、加 `shell: true`、
 *    脱离沙箱都一样；而异步 spawn 与 `stdio: 'inherit'` 正常。
 *    可靠的是 `spawnSync` 配**文件型 stdio**：stdout/stderr 落临时文件再读回，语义等价。
 *    （这条是父仓实测沉淀，本次移植时又验证了一次：我先前用 execFileSync 取凭据同样 EBUSY。）
 *
 * @param cmd 可执行文件
 * @param args 参数列表
 * @param opts.cwd 工作目录，默认本仓根
 * @param opts.timeout 毫秒，默认 10 分钟（本机 push 可达数分钟）
 * @param opts.input 经临时文件作为 stdin 传入（`git credential fill` 需要）
 * @returns stdout（已 trim）
 */
function run(cmd, args, opts = {}) {
  const outFd = openSync(STDOUT_FILE, 'w');
  const errFd = openSync(STDERR_FILE, 'w');
  let inFd = 'ignore';
  if (opts.input !== undefined) {
    writeFileSync(STDIN_FILE, opts.input);
    inFd = openSync(STDIN_FILE, 'r');
  }

  let result;
  try {
    result = spawnSync(cmd, args, {
      cwd: opts.cwd || ROOT,
      timeout: opts.timeout ?? 600000,
      shell: opts.shell ?? false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: [inFd, outFd, errFd]
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
    if (typeof inFd === 'number') closeSync(inFd);
  }

  const stdout = readFileSync(STDOUT_FILE, 'utf8');
  const stderr = readFileSync(STDERR_FILE, 'utf8');

  if (result.error) {
    result.error.stdout = stdout;
    result.error.stderr = stderr;
    throw result.error;
  }
  if (result.status !== 0) {
    const err = new Error(`命令失败（退出码 ${result.status}）：${cmd} ${args.join(' ')}`);
    err.stdout = stdout;
    err.stderr = stderr;
    err.status = result.status;
    throw err;
  }
  return stdout.trim();
}

function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const git = (...args) => run('git', args);
const gitTry = (...args) => tryRun('git', args);
const log = (line = '') => process.stdout.write(`${line}\n`);

/* ---------- 仓库状态 ---------- */

function latestTag() {
  const r = gitTry('describe', '--tags', '--abbrev=0');
  return r.ok ? r.out.split('\n').pop().trim() : null;
}

function collectCommitsBetween(from, to = 'HEAD') {
  const range = from ? `${from}..${to}` : to;
  return git('log', range, '--format=%s%x00%b%x01')
    .split('\x01')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [subject, body = ''] = chunk.split('\x00');
      return { subject: subject.trim(), body };
    });
}

/** 上一个 tag（按创建时间取相邻），补建 Release 时用它划定变更区间 */
function previousTag(tag) {
  const r = gitTry('tag', '--sort=-creatordate');
  if (!r.ok) return null;
  const tags = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  const i = tags.indexOf(tag);
  return i !== -1 && i + 1 < tags.length ? tags[i + 1] : null;
}

/** 从 origin 解析 `owner/repo`；解析不到返回 null（不致命，降级为"只打 tag"） */
function remoteSlug() {
  const r = gitTry('remote', 'get-url', 'origin');
  if (!r.ok) return null;
  const m = /github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(r.out.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * 取 GitHub token（Git Credential Manager）。
 *
 * ⚠️ 超时不能省：本机 `git credential fill` 有永久挂住的历史，没超时会让发版卡死。
 * ⚠️ 也不能太紧：GCM 冷启动偶尔越 30s，而超时的后果是**这条通道被静默跳过** ——
 *    只打 tag、不建 Release，事后极难发现。取 90s。
 *
 * @returns token 字符串，取不到返回 null
 */
function readGithubToken() {
  try {
    const out = run('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      timeout: 90000
    });
    const map = Object.fromEntries(
      out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i), line.slice(i + 1)];
        })
    );
    return map.password || null;
  } catch {
    return null;
  }
}

/* ---------- GitHub API ---------- */

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'retroweb-release',
    'Content-Type': 'application/json'
  };
}

/** 本机网络对 GitHub 不稳定（push 都常耗时数分钟），网络类错误要重试而非直接失败 */
async function fetchWithRetry(url, options, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const waitMs = 1000 * 2 ** (i - 1);
        log(`  ⚠ 网络请求失败（第 ${i}/${attempts} 次）：${err.cause?.code || err.message}，${waitMs / 1000}s 后重试`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw lastErr;
}

async function apiGetRelease({ owner, repo, tag, token }) {
  try {
    const res = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, {
      headers: ghHeaders(token)
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null; // 查不到就按"没有"处理，由后续创建步骤决定
  }
}

async function apiCreateRelease({ owner, repo, tag, body, token }) {
  try {
    const res = await fetchWithRetry(`https://api.github.com/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false })
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch (err) {
    // 网络层失败不抛：tag 可能已推送成功，此处崩溃会把"已完成的部分"也当成失败
    return { status: 0, error: err.cause?.code || err.message };
  }
}

/* ---------- 补齐：修复 tag 与 Release 的漂移 ---------- */

/**
 * tag 已推但 Release 没建成（网络中断、token 失效等）会让两者永久漂移。
 * 重跑时若只判"有无新提交"就直接返回，就再也补不上了 —— 所以单独兜一次。
 */
async function syncReleaseIfMissing({ tag, slug, token }) {
  if (!tag || !slug || !token) return;
  if (await apiGetRelease({ owner: slug.owner, repo: slug.repo, tag, token })) return;

  const prev = previousTag(tag);
  const between = collectCommitsBetween(prev, tag);
  const { buckets } = classify(between);
  const notes = buildNotes({ from: prev, to: tag, buckets, count: between.length });

  log('');
  log(`→ ${tag} 缺 Release（tag 已推、Release 未建）`);
  if (!APPLY) {
    log('   （预览模式）加 --apply 可补建');
    return;
  }
  const res = await apiCreateRelease({ owner: slug.owner, repo: slug.repo, tag, body: notes, token });
  if (res.status === 201) log(`  ✓ Release 已补建：${res.json.html_url}`);
  else log(`  ✗ 补建失败（${res.status === 0 ? `网络错误 ${res.error}` : `HTTP ${res.status}`}）`);
}

/* ---------- 发版前闸门 ---------- */

/**
 * 跑一遍本仓的静态闸门。
 *
 * 🔴 为什么发版前必须跑：本仓出过两次「**类型检查与 lint 全绿、但界面是坏的**」
 *    （拦截器返回形状失真、Element Plus 函数式样式未引入）。发版是不可撤回的对外动作，
 *    至少要让"能构建、类型自洽、文档守门通过"这三件事在打 tag 前成立。
 *
 * ⚠️ 浏览器探针（verify:ep-style / verify:retro-envelope / verify:about）需要 dev server，
 *    这里**不跑** —— 发版脚本不该去起服务。需要时请单独执行。
 *
 * @returns 全部通过返回 true
 */
function runGates() {
  const gates = [
    ['类型检查', 'npm', ['run', 'type-check']],
    ['Lint', 'npm', ['run', 'lint']],
    ['JSDoc 审计', 'npm', ['run', 'audit:jsdoc']],
    ['README 一致性', 'npm', ['run', 'verify:readme']],
    ['构建', 'npm', ['run', 'build']]
  ];

  log('── 发版前闸门 ──────────────────────');
  for (const [name, cmd, args] of gates) {
    const r = tryRun(cmd, args, { shell: true, timeout: 900000 });
    if (!r.ok) {
      log(`   ✗ ${name} 未通过：`);
      const tail = r.out.split('\n').filter(Boolean).slice(-8);
      for (const line of tail) log(`       ${line}`);
      log('');
      log('   发版已中止。修好后重跑；确要跳过请加 --skip-checks');
      return false;
    }
    log(`   ✓ ${name}`);
  }
  return true;
}

/* ---------- package.json 版本对齐 ---------- */

/**
 * 把 package.json 的 version 对齐到目标版本（**单向跟随 git tag**）。
 *
 * @returns 是否发生了变化
 */
function alignPackageVersion(next) {
  const p = path.join(ROOT, 'package.json');
  const raw = readFileSync(p, 'utf8');
  const cur = JSON.parse(raw).version;
  if (cur === next) return false;
  // 只替换 version 那一行，别整体重排 JSON（会制造无意义的 diff）
  const updated = raw.replace(/(\n\s*"version":\s*")[^"]+(")/, `$1${next}$2`);
  if (updated === raw) throw new Error(`package.json 里没找到 version 字段，无法对齐到 ${next}`);
  writeFileSync(p, updated);
  return true;
}

/* ---------- 主流程 ---------- */

async function main() {
  log(`\n═══ retroweb 发版决策${APPLY ? '（执行模式）' : '（预览模式 · 加 --apply 才会真正执行）'} ═══\n`);

  // 1) 前置检查
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') {
    log(`✗ 当前在 ${branch} 分支，发版只允许在 main 上进行`);
    process.exitCode = 1;
    return;
  }

  const porcelain = git('status', '--porcelain').split('\n').filter(Boolean);
  if (porcelain.length) {
    if (APPLY && !ALLOW_DIRTY) {
      log('✗ 工作区有未提交改动，发版前应先提交（避免把该发的内容漏在版本之外）：');
      for (const line of porcelain) log(`    ${line}`);
      log('  若这些改动属于并行任务、本次要发的内容已提交，可加 --allow-dirty 继续');
      process.exitCode = 1;
      return;
    }
    log(`⚠ 工作区有 ${porcelain.length} 项未提交改动${APPLY && ALLOW_DIRTY ? '（已用 --allow-dirty 放行）' : ''}：`);
    for (const line of porcelain.slice(0, 8)) log(`    ${line}`);
    if (porcelain.length > 8) log(`    …另有 ${porcelain.length - 8} 项`);
  } else {
    log(`✓ 分支 ${branch}，工作区干净`);
  }

  // 2) 判定该不该发、发什么版本
  const from = FROM_OVERRIDE || latestTag();
  if (FROM_OVERRIDE && !gitTry('rev-parse', '-q', '--verify', `${FROM_OVERRIDE}^{commit}`).ok) {
    log(`✗ --from ${FROM_OVERRIDE} 不是有效 ref`);
    process.exitCode = 1;
    return;
  }

  const slug = remoteSlug();
  const token = readGithubToken();

  const commits = collectCommitsBetween(from);
  if (!commits.length) {
    log(`✓ 自 ${from ?? '初始'} 以来无新提交 → 无需发版`);
    await syncReleaseIfMissing({ tag: from, slug, token });
    return;
  }

  const { buckets, breaking } = classify(commits);
  const kind = decideBump({ buckets, breaking });
  const summary = Object.entries(buckets)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, list]) => `${list.length} ${type}`)
    .join(' / ');
  log(`  自 ${from ?? '初始'} 起 ${commits.length} 个提交（${summary}）`);

  if (!kind) {
    log('✓ 提交类型只有 chore/docs/test/style/ci/refactor/build → 按规则不发版');
    return;
  }

  const next = bumpVersion(from || '0.0.0', kind);
  const tag = `v${next}`;
  log(`→ 判定：${kind} 递增，${from ?? '(无)'} → ${tag}`);

  if (gitTry('rev-parse', '-q', '--verify', `refs/tags/${tag}`).ok) {
    log(`✗ tag ${tag} 已存在，请先确认版本号`);
    process.exitCode = 1;
    return;
  }

  // 3) 发版前的静态闸门
  if (APPLY && !SKIP_CHECKS) {
    log('');
    if (!runGates()) {
      process.exitCode = 1;
      return;
    }
  } else if (!APPLY) {
    log('');
    log('── 发版前闸门 ──────────────────────');
    log('   （预览模式跳过；--apply 时会依次跑 type-check / lint / audit:jsdoc / verify:readme / build）');
  } else {
    log('');
    log('⚠ 已用 --skip-checks 跳过发版前闸门');
  }

  const notes = buildNotes({ from, to: tag, buckets, count: commits.length });
  // 先查后建：422 只说明"校验没过"，原因可能是别的字段，不能拿它当"已存在"的判据
  const existingRelease = slug && token ? await apiGetRelease({ owner: slug.owner, repo: slug.repo, tag, token }) : null;

  log('');
  log('── 通道 1/2：git tag ───────────────');
  log(`   ${APPLY ? '打' : '将打'} annotated tag ${tag}（当前 HEAD ${git('rev-parse', '--short', 'HEAD')}）`);
  log(`   ${APPLY ? '对齐' : '将对齐'} package.json version → ${next}`);

  log('── 通道 2/2：GitHub Release ────────');
  if (!slug) log('   ✗ 无法从 origin 解析 GitHub 仓库 → 跳过');
  else if (!token) log('   ✗ 未取到 GitHub 凭据 → 跳过（⚠️ tag 仍会打，但不会建 Release；GCM 冷启动偶发超时，可重跑一次）');
  else if (existingRelease) log(`   ✓ ${tag} 已有 Release → 跳过（${existingRelease.html_url}）`);
  else log(`   ${APPLY ? '创建' : '将创建'} ${slug.owner}/${slug.repo} 的 Release（说明 ${notes.split('\n').length} 行）`);

  const hits = findSensitive(commits);
  if (hits.length) {
    log('');
    log('   ⚠ 以下提交标题含敏感表述，而 Release 说明**对公网可见**，请先确认是否适合原文外发：');
    for (const subject of hits) log(`      · ${subject}`);
  }

  if (!APPLY) {
    log('');
    log('预览结束。确认无误后执行：node scripts/release.mjs --apply');
    return;
  }

  // 4) 执行：对齐版本号 → 提交 → 打 tag → 推送
  log('');
  log('执行中…');

  if (alignPackageVersion(next)) {
    git('add', 'package.json');
    git('commit', '-m', `chore(release): ${next}`);
    log(`  ✓ package.json 已对齐到 ${next} 并单独提交`);
  } else {
    log(`  · package.json 已是 ${next}，无需改动`);
  }

  git('tag', '-a', tag, '-m', notes);
  log(`  ✓ 已创建 tag ${tag}`);

  log('  推送中（本机 push 可能耗时数分钟且全程无输出，属已知现象）…');
  // main 与 tag 一条命令推；退出码不可信，下面一律以 ls-remote 为准
  const push = tryRun('git', ['push', 'origin', 'main', tag], { timeout: 900000 });
  if (!push.ok) log(`  ⚠ push 返回非零：${push.out.split('\n').filter(Boolean).slice(-2).join(' | ')}`);

  // 无论退出码如何，一律以远端实际状态为准（本机出现过"零输出假成功"）
  const remoteSha = gitTry('ls-remote', 'origin', 'main').out.split('\t')[0];
  const localSha = git('rev-parse', 'HEAD');
  if (remoteSha !== localSha) {
    log(`  ✗ 推送后远端 main=${remoteSha || '(空)'} 与本地 ${localSha} 不一致`);
    log('    本机 push 偶发"零输出假成功"，请重试后核对 git ls-remote origin main');
  } else {
    log(`  ✓ 远端 main 已更新至 ${remoteSha.slice(0, 8)}`);
    const tagOnRemote = gitTry('ls-remote', '--tags', 'origin', tag).out;
    log(tagOnRemote.includes(tag) ? `  ✓ tag ${tag} 已在远端` : `  ✗ tag ${tag} 未出现在远端，需重推`);

    // 本机 git 不写松散 ref，packed-refs 需同步修正，否则 status 会长期谎报 ahead。
    // 🔴 **只在 packed-refs 真的存在时才修**：该工具是给父仓写的 —— 那边的 git
    //    确实不写松散 ref；而本仓的 ref 就是松散的，这里压根没有 packed-refs
    //    文件，无条件调用只会打一条莫名其妙的"找不到文件"警告，让发版看起来没跑干净。
    //    判据用文件是否存在，而不是"工具存不存在"（工具在父仓的 HOME 下，往往是在的）。
    if (existsSync(FIX_REFS_TOOL) && existsSync(path.join(ROOT, '.git', 'packed-refs'))) {
      const fix = tryRun('node', [FIX_REFS_TOOL, remoteSha]);
      log(fix.ok ? '  ✓ packed-refs 已同步' : `  ⚠ packed-refs 修正失败：${fix.out.split('\n')[0]}`);
    }
  }

  // 5) 建 Release
  if (slug && token && !existingRelease) {
    const res = await apiCreateRelease({ owner: slug.owner, repo: slug.repo, tag, body: notes, token });
    if (res.status === 201) log(`  ✓ Release 已创建：${res.json.html_url}`);
    else if (res.status === 0) log(`  ✗ Release 创建失败（网络错误 ${res.error}）→ 重跑本脚本可补建`);
    else log(`  ✗ Release 创建失败（HTTP ${res.status}）：${res.json?.message ?? ''}`);
  } else if (existingRelease) {
    log(`  · Release ${tag} 已存在，跳过`);
  }

  log('');
  log('═══ 发版流程结束 ═══\n');
}

// 仅在被直接执行时跑主流程；被 import（单元测试）时不产生任何副作用
const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
