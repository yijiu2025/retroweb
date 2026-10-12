/**
 * 发版纯逻辑层的单元测试（Node 内置 `node:test`，零依赖）。
 *
 * 运行：`npm run test:release`
 *
 * 🔴 这里最值钱的两组用例，都是**照着真实踩过的坑**写的，不是想象出来的：
 *    ① 破坏性变更**不能**退化成子串匹配 —— 提交正文里"提到"这个词就该不生效；
 *    ② 只有 chore/docs/refactor 时**必须**判定为不发版，否则会发出空版本。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSubject,
  classify,
  decideBump,
  bumpVersion,
  compareSemver,
  buildNotes,
  findSensitive,
  BREAKING_RE
} from './release-lib.mjs';

/* ---------- parseSubject ---------- */

test('parseSubject：带 scope 与类型', () => {
  assert.deepEqual(parseSubject('fix(api): 修好拆包'), { type: 'fix', bang: false, text: '修好拆包' });
});

test('parseSubject：带 ! 标记破坏性', () => {
  assert.deepEqual(parseSubject('feat(api)!: 换掉旧契约'), { type: 'feat', bang: true, text: '换掉旧契约' });
});

test('parseSubject：非 Conventional Commits 归 other', () => {
  const r = parseSubject('顺手改了点东西');
  assert.equal(r.type, 'other');
  assert.equal(r.text, '顺手改了点东西');
});

test('parseSubject：空/非法输入不抛', () => {
  assert.doesNotThrow(() => parseSubject(''));
  assert.equal(parseSubject('').type, 'other');
});

/* ---------- classify / decideBump ---------- */

test('decideBump：feat → minor', () => {
  const { buckets } = classify([{ subject: 'feat: 加导出' }]);
  assert.equal(decideBump({ buckets }), 'minor');
});

test('decideBump：fix / perf → patch', () => {
  assert.equal(decideBump({ buckets: classify([{ subject: 'fix: 修 bug' }]).buckets }), 'patch');
  assert.equal(decideBump({ buckets: classify([{ subject: 'perf: 快一点' }]).buckets }), 'patch');
});

test('decideBump：只有 chore/docs/test/style/ci/refactor/build → 不发版', () => {
  const only = ['chore: 杂事', 'docs: 改说明', 'test: 补用例', 'style: 排版', 'ci: 改流水线', 'refactor: 挪文件', 'build: 改配置'];
  const { buckets } = classify(only.map((subject) => ({ subject })));
  assert.equal(decideBump({ buckets }), null);
});

test('decideBump：breaking 优先于一切 → major', () => {
  const { buckets, breaking } = classify([{ subject: 'fix: 小事', body: 'BREAKING CHANGE: 契约变了' }]);
  assert.equal(breaking, true);
  assert.equal(decideBump({ buckets, breaking }), 'major');
});

test('decideBump：空提交不发版', () => {
  assert.equal(decideBump({ buckets: {}, breaking: false }), null);
});

/* ---------- 🔴 破坏性变更「只认 footer」那条规则 ---------- */

test('BREAKING_RE 不匹配「正文里只是提到」的情况（父仓实测踩过）', () => {
  // 写发版规则自身时，正文里必然出现这个词；若用子串匹配，会把 patch 误升成 major
  const body = '本文件说明：破坏性变更只认 footer 形式的 BREAKING CHANGE: 这一行，中间提到不算。';
  assert.equal(BREAKING_RE.test(body), false, '行中提及不应被判定为破坏性变更');
});

test('BREAKING_RE 匹配行首 footer（含连字符写法）', () => {
  assert.equal(BREAKING_RE.test('正文\n\nBREAKING CHANGE: 契约变了'), true);
  assert.equal(BREAKING_RE.test('正文\n\nBREAKING-CHANGE: 契约变了'), true);
});

test('带 ! 的提交也算破坏性（不依赖 footer）', () => {
  const { breaking } = classify([{ subject: 'feat!: 换契约' }]);
  assert.equal(breaking, true);
});

/* ---------- bumpVersion ---------- */

test('bumpVersion：三档递增', () => {
  assert.equal(bumpVersion('1.0.2', 'patch'), '1.0.3');
  assert.equal(bumpVersion('1.0.2', 'minor'), '1.1.0');
  assert.equal(bumpVersion('1.0.2', 'major'), '2.0.0');
});

test('bumpVersion：接受带 v 前缀', () => {
  assert.equal(bumpVersion('v1.2.3', 'patch'), '1.2.4');
});

test('bumpVersion：跨位进位', () => {
  assert.equal(bumpVersion('1.9.9', 'patch'), '1.9.10');
  assert.equal(bumpVersion('1.9.9', 'minor'), '1.10.0');
});

test('bumpVersion：非法版本号抛错', () => {
  assert.throws(() => bumpVersion('abc', 'patch'));
  assert.throws(() => bumpVersion('1.0', 'patch'));
});

test('bumpVersion：未知档位抛错（防拼错静默返回）', () => {
  assert.throws(() => bumpVersion('1.0.0', 'pathc'), /未知的递增档位/);
});

/* ---------- compareSemver ---------- */

test('compareSemver：三段比较', () => {
  assert.ok(compareSemver('1.0.1', '1.0.0') > 0);
  assert.ok(compareSemver('1.0.0', '1.0.1') < 0);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  // 数值比较而非字符串比较（'10' < '9' 是字符串陷阱）
  assert.ok(compareSemver('1.10.0', '1.9.0') > 0);
});

/* ---------- buildNotes ---------- */

test('buildNotes：含分组标题与提交，且不含空组', () => {
  const { buckets } = classify([{ subject: 'feat: 新功能甲' }, { subject: 'fix: 修缺陷乙' }]);
  const notes = buildNotes({ from: 'v1.0.0', to: 'v1.1.0', buckets, count: 2 });
  assert.match(notes, /### 新功能/);
  assert.match(notes, /### 修复/);
  assert.match(notes, /- 新功能甲/);
  assert.match(notes, /- 修缺陷乙/);
  assert.ok(!notes.includes('### 性能'), '没有 perf 提交时不该出现「性能」分组');
  assert.match(notes, /自 `v1\.0\.0` 起共 2 个提交/);
});

test('buildNotes：from 为空时写「仓库初始」', () => {
  const notes = buildNotes({ from: null, to: 'v1.0.0', buckets: { feat: ['feat: 首版'] }, count: 1 });
  assert.match(notes, /仓库初始/);
});

/* ---------- findSensitive ---------- */

test('findSensitive：挑出含敏感表述的标题', () => {
  const hits = findSensitive([
    { subject: 'fix: 修好越权访问' },
    { subject: 'docs: 改说明' },
    { subject: 'fix: token 泄漏' }
  ]);
  assert.equal(hits.length, 2);
  assert.ok(hits.some((s) => s.includes('越权')));
});

test('findSensitive：干净提交返回空', () => {
  assert.deepEqual(findSensitive([{ subject: 'feat: 加个按钮' }]), []);
});
