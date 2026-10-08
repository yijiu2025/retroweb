/**
 * 真实加载 workspace store 跑一遍新增逻辑（方案切换 / 分析保留 / 相同分子复用）。
 *
 * 🔴 刻意不复制任何被测逻辑：全部走 store 的公开动作（setTarget / adopt / saveScheme /
 *    applyScheme / switchRun / schemeStats），断言的是真实运行结果。
 */
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import { reactionIdFor, useWorkspaceStore } from '../src/stores/workspace';
import { buildRouteCopy, routeCopyOkMsg } from '../src/utils/route-copy';
import { buildMolIdents, molCasNote } from '../src/composables/useMolIdents';
import type { MolNode, Reaction } from '../src/types/retro';

// ---- localStorage shim：必须在 useWorkspaceStore() 之前装好（store 会在 setup 里读历史/会话）
const memory: Record<string, string> = {};
const localStorageShim = {
  getItem: (k: string): string | null => (k in memory ? memory[k] : null),
  setItem: (k: string, v: string): void => {
    memory[k] = v;
  },
  removeItem: (k: string): void => {
    delete memory[k];
  }
};
(globalThis as unknown as { localStorage: unknown }).localStorage = localStorageShim;

let failures = 0;
function check(label: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  [OK ] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`);
  }
}

function rxn(nodeId: string, precursors: string[], prob: number): Reaction {
  const joined = precursors.join('.');
  return {
    id: reactionIdFor(nodeId, joined),
    productNodeId: nodeId,
    rank: 1,
    probability: prob,
    level: 'high',
    precursors: joined,
    precursorList: precursors,
    numMolecules: precursors.length,
    childNodeIds: []
  };
}

const scope = effectScope();
scope.run(() => {
  setActivePinia(createPinia());
  const store = useWorkspaceStore();

  const TARGET = 'CC(=O)Oc1ccccc1C(=O)O'; // 阿司匹林
  const A = 'CC(=O)OC(C)=O'; // 乙酸酐
  const B = 'O=C(O)c1ccccc1O'; // 水杨酸
  const C = 'CC(=O)Cl'; // 乙酰氯（备选路线，单前体）
  const D = 'CC(=O)O'; // 乙酸（A 往下拆）

  console.log('\n=== 0) reactionIdFor 确定性 ===');
  check('同一节点+同一前体 ⇒ 同一 id', reactionIdFor('n1', 'C.C') === reactionIdFor('n1', 'C.C'));
  check('不同前体 ⇒ 不同 id', reactionIdFor('n1', 'C.C') !== reactionIdFor('n1', 'C.O'));

  console.log('\n=== 1) setTarget / 注入候选 / adopt ===');
  store.setTarget({
    ok: true,
    smiles: TARGET,
    kind: 'SMILES',
    atoms: 13,
    formula: 'C9H8O4',
    mw: 180.16,
    error: ''
  } as never);
  const rootId = store.rootId as string;
  check('根节点已建立', !!rootId);
  // 🔴 解析**不建任务**：任务要等「确定目标，开始分析」（closeTargetSetup）才诞生。
  //    旧实现在这里无条件新建会话 ⇒ 每点一次「解析结构」就在侧栏多一条任务
  //    （用户报的 bug，端到端见 .tmp-probe/verify-parse-notask.cjs）。
  check(
    '🔴 只解析、还没开始分析 ⇒ 一条任务都不建',
    store.sessions.length === 0,
    `会话数 ${store.sessions.length}`
  );

  const r1 = rxn(rootId, [A, B], 0.98);
  const r2 = rxn(rootId, [C], 0.41);
  store.nodes[rootId].candidates = [r1, r2];

  store.adopt(r1.id);
  check('采纳 R1 ⇒ 2 个前体子节点', store.nodes[rootId].children.length === 2);
  const childSmiles = store.nodes[rootId].children.map((id) => store.nodes[id].smiles);
  check('子节点就是 A / B', childSmiles.includes(A) && childSmiles.includes(B), JSON.stringify(childSmiles));
  const nodeA = store.nodes[rootId].children.find((id) => store.nodes[id].smiles === A) as string;
  const nodeB = store.nodes[rootId].children.find((id) => store.nodes[id].smiles === B) as string;

  console.log('\n=== 2) 往下拆一层 ===');
  const r3 = rxn(nodeA, [D], 0.88);
  store.nodes[nodeA].candidates = [r3];
  // 第一次分析的结果落进 runs（真实路径里由 predictNode → pushRun 完成）
  store.nodes[nodeA].runs = [
    { id: 'runA_1', at: Date.now(), model: 'pistachio', numResults: 5, candidates: [r3], chosenReactionId: null }
  ];
  store.nodes[nodeA].activeRunId = 'runA_1';
  store.adopt(r3.id);
  const nodeD = store.nodes[nodeA].children[0];
  check(
    'A 拆出 D',
    store.nodes[nodeA].children.length === 1 && store.nodes[nodeD].smiles === D
  );

  console.log('\n=== 3) 存下路线方案 A ===');
  store.saveScheme('路线A');
  const schA = store.schemes[0].id;
  const schemeAChoices = JSON.parse(JSON.stringify(store.schemes[0].choices)) as Record<string, string>;
  check('方案已保存且为当前', store.schemes.length === 1 && store.currentSchemeId === schA);
  check('方案A 记下了 2 步选择', Object.keys(schemeAChoices).length === 2, JSON.stringify(schemeAChoices));
  const statA = store.schemeStats[0];
  check('方案A 步数 = 2', statA.steps === 2, `实际 ${statA.steps}`);
  check(
    '方案A 总概率 = 0.98 × 0.88',
    Math.abs(statA.probability - 0.98 * 0.88) < 1e-9,
    String(statA.probability)
  );

  console.log('\n=== 4) 换一条路线（R2 单前体）⇒ 必须**分叉**，不得改写方案 A ===');
  store.adopt(r2.id);
  check('R1 的子树被摘下来了（T 现在只有 1 个子节点 C）', store.nodes[rootId].children.length === 1);
  check('新子节点是 C', store.nodes[store.nodes[rootId].children[0]].smiles === C);
  check('自动分叉出一条新方案', store.schemes.length === 2, String(store.schemes.length));
  check('当前方案已是新分叉（不再是 A）', store.currentSchemeId !== schA);
  check(
    '🔴 方案 A 的选择**没有被改写**',
    JSON.stringify(store.schemes[0].choices) === JSON.stringify(schemeAChoices),
    JSON.stringify(store.schemes[0].choices)
  );
  const schB = store.currentSchemeId as string;

  const statB = store.schemeStats.find((s) => s.schemeId === schB) as (typeof store.schemeStats)[number];
  check('方案B 步数 = 1', statB.steps === 1, `实际 ${statB.steps}`);
  check('方案B 总概率 = 0.41', Math.abs(statB.probability - 0.41) < 1e-9, String(statB.probability));

  console.log('\n=== 5) 切回方案 A：子树必须**原样接回**，不重跑、不丢结果 ===');
  store.applyScheme(schA);
  const backSmiles = store.nodes[rootId].children.map((id) => store.nodes[id].smiles);
  check('T 的子节点恢复为 A / B', backSmiles.includes(A) && backSmiles.includes(B), JSON.stringify(backSmiles));
  const nodeA2 = store.nodes[rootId].children.find((id) => store.nodes[id].smiles === A) as string;
  check('切回后仍是同一个节点 id（没被重建）', nodeA2 === nodeA, `${nodeA2} vs ${nodeA}`);
  check(
    'A 的子树 D 也被接回来了',
    store.nodes[nodeA2].children.length === 1 && store.nodes[store.nodes[nodeA2].children[0]].smiles === D,
    `children=${JSON.stringify(store.nodes[nodeA2].children.map((id) => store.nodes[id].smiles))}`
  );
  check('当前方案标记为 A', store.currentSchemeId === schA);

  console.log('\n=== 6) 再切到方案 B，然后回 A（来回切多轮）===');
  store.applyScheme(schB);
  check(
    'B：T 只有 C',
    store.nodes[rootId].children.length === 1 &&
      store.nodes[store.nodes[rootId].children[0]].smiles === C
  );
  store.applyScheme(schA);
  store.applyScheme(schB);
  store.applyScheme(schA);
  check(
    '来回切后 A 依然完整',
    store.nodes[rootId].children.length === 2 && store.nodes[nodeA].children.length === 1
  );

  console.log('\n=== 7) 相同中间体直接复用分析结果 ===');
  // 给 B 造一次「已有分析结果」，再让另一个分支产出同一个分子 B
  const seedRun = rxn(nodeB, ['O=C([O-])c1ccccc1O'], 0.58);
  store.nodes[nodeB].runs = [
    {
      id: 'run_seed',
      at: Date.now(),
      model: 'pistachio',
      numResults: 5,
      candidates: [seedRun],
      chosenReactionId: null
    }
  ];
  store.nodes[nodeB].activeRunId = 'run_seed';
  store.nodes[nodeB].candidates = store.nodes[nodeB].runs[0].candidates;
  store.nodes[nodeB].fetched = true;
  store.nodes[nodeB].status = 'expanded';

  // 让 A 的下一步产出「和 B 相同的分子」。同时模拟一次真实「重新分析」：
  // 候选被新结果取代（r3 只留在 runs 里）——顺带考验方案 A 的复原健壮性。
  const r4 = rxn(nodeA, [B], 0.77);
  store.nodes[nodeA].runs = [
    ...(store.nodes[nodeA].runs || []),
    { id: 'runA_2', at: Date.now() + 500, model: 'pistachio', numResults: 5, candidates: [r4], chosenReactionId: null }
  ];
  store.nodes[nodeA].candidates = [r4];
  store.adopt(r4.id);
  const reusedChildId = store.nodes[nodeA].children[0];
  const reusedChild = store.nodes[reusedChildId] as MolNode;
  check('新子节点标出了复用来源', reusedChild.reusedFrom === nodeB, String(reusedChild.reusedFrom));
  check('复用带来了候选（没有重跑模型）', reusedChild.candidates.length > 0);
  check('复用也带来了分析历史', (reusedChild.runs?.length ?? 0) > 0);
  check('复用后状态是已展开', reusedChild.status === 'expanded');

  console.log('\n=== 8) 每次分析结果保留 + switchRun ===');
  const nB = store.nodes[nodeB] as MolNode;
  const run1 = nB.runs && nB.runs[0];
  const altCands = [rxn(nodeB, ['O=C([O-])c1ccccc1O', 'C'], 0.31)];
  nB.runs = [
    ...(nB.runs || []),
    {
      id: 'run_second',
      at: Date.now() + 1000,
      model: 'pistachio',
      numResults: 5,
      candidates: altCands,
      chosenReactionId: null
    }
  ];
  check('两次分析结果都在（保留）', nB.runs.length === 2, String(nB.runs.length));

  store.switchRun(nodeB, 'run_seed');
  check('切到第 1 次分析：候选回到第 1 次', store.nodes[nodeB].candidates.length === 1);
  check(
    '切到第 1 次分析：id 与第 1 次一致',
    store.nodes[nodeB].candidates[0].id === (run1?.candidates[0].id ?? 'x')
  );
  store.switchRun(nodeB, 'run_second');
  check('切回第 2 次分析：候选数 = 1', store.nodes[nodeB].candidates.length === 1);
  check('历史仍在（切换不会删历史）', (store.nodes[nodeB].runs?.length ?? 0) === 2);

  console.log('\n=== 9) 统计口径：detached 子树不进统计 ===');
  store.applyScheme(schB); // T 只有 C，其它全部被摘
  const visible = store.nodeList.map((n) => n.smiles);
  check(
    '树上看不到 A/B/D',
    !visible.includes(A) && !visible.includes(B) && !visible.includes(D),
    JSON.stringify(visible)
  );
  check(
    '但节点仍在内存里（切回去还在）',
    !!store.nodes[nodeA] && !!store.nodes[nodeB] && !!store.nodes[nodeD]
  );
  check('allNodes 仍能看到它们', store.allNodes.length >= 5, String(store.allNodes.length));

  console.log('\n=== 10) 切回 A：被摘的子树仍能完整恢复（且能从未选中列表里捞回旧步骤）===');
  store.applyScheme(schA);
  const visible2 = store.nodeList.map((n) => n.smiles);
  check('A/B 又回到树上了', visible2.includes(A) && visible2.includes(B), JSON.stringify(visible2));
  check(
    '🔴 A 的下一步（r3，已不在当前候选列表里）从历史分析中捞回并复原',
    store.nodes[nodeA].children.length === 1 && store.nodes[store.nodes[nodeA].children[0]].smiles === D,
    JSON.stringify(store.nodes[nodeA].children.map((id) => store.nodes[id].smiles))
  );

  console.log('\n=== 11) 会话快照落盘包含方案 ===');
  // 🔴 必须先「开始分析」才有任务可落盘：解析（setTarget）只把结构放进工作台，
  //    会话由 `closeTargetSetup()`（真实 UI 里 = 「确定目标，开始分析」/「自动往下拆」）
  //    那一刻诞生 —— 否则「每点一次解析就在侧栏多一条任务」（2026-10-07 修的 bug）。
  store.closeTargetSetup();
  store.persistSession();
  const json = JSON.parse(store.exportJson()) as { schemes: unknown[]; stepAnalyses: unknown[] };
  const raw = localStorageShim.getItem('retroweb_sessions') || '[]';
  const parsed = JSON.parse(raw) as {
    snapshot: { schemes?: unknown[]; currentSchemeId?: string; nodes: Record<string, MolNode> };
  }[];
  check('导出 JSON 带上了方案对比', Array.isArray(json.schemes) && json.schemes.length >= 2, String(json.schemes?.length));
  check('会话快照里有 schemes', Array.isArray(parsed[0]?.snapshot?.schemes));
  check('会话快照里有 currentSchemeId', 'currentSchemeId' in (parsed[0]?.snapshot ?? {}));
  check(
    '🔴 方案 A 的选择始终未被改写',
    JSON.stringify(store.schemes[0].choices) === JSON.stringify(schemeAChoices),
    JSON.stringify(store.schemes[0].choices)
  );

  console.log('\n=== 12) 路线网络：确认 / 多条并存 / 分支计数 ===');
  // 此刻当前是方案 A（T ← A + B，A 再往下拆一步）
  check('当前网络步数 = 2', store.networkStats.steps === 2, String(store.networkStats.steps));
  check(
    '🔴 当前网络分支数 = 1（根那一步是 A + B 双前体 ⇒ 路线是一张网，不是一条链）',
    store.networkStats.branches === 1,
    String(store.networkStats.branches)
  );
  check('一条网络都还没确认', store.confirmedNetworkCount === 0, String(store.confirmedNetworkCount));

  // 🔴 记录确认前的条数：确认"当前这条"不该让列表变长
  const schemesBeforeConfirm = store.schemes.length;
  const netA = store.confirmRouteNetwork();
  check('确认成功并返回网络 id', !!netA && netA === store.currentSchemeId);
  check(
    '🔴 确认的是**已有的那条**（就地确认，不新建重复记录）',
    netA === schA && store.schemes.length === schemesBeforeConfirm,
    `netA=${netA} schA=${schA} schemes=${store.schemes.length}`
  );
  check('已确认计数 = 1', store.confirmedNetworkCount === 1, String(store.confirmedNetworkCount));
  const statNetA = store.schemeStats.find((s) => s.schemeId === netA) as (typeof store.schemeStats)[number];
  check('这条网络的指标与模拟口径一致', statNetA.steps === 2 && statNetA.branches === 1);
  check('网络列表把已确认的排最前', store.routeNetworks[0].schemeId === netA);

  console.log('\n=== 13) 多条网络并存 + 取消确认只改标记 ===');
  store.applyScheme(schB);
  const netB = store.confirmRouteNetwork();
  check('第二条网络确认成功，与前一条并存', !!netB && netB !== netA && store.confirmedNetworkCount === 2);
  // 🔴 只断言「已确认的都排在未确认的前面」，**不**断言两条已确认之间的先后：
  //    它们可能在同一毫秒内确认（Date.now() 分辨率就是 1ms），此时排序按稳定序回落，
  //    谁在前都对。写死顺序会让这条断言随机变红（实测 5 次里抖 4 次）。
  const order = store.routeNetworks.map((s) => `${s.schemeId}:${s.confirmed ? 'Y' : 'N'}`);
  check(
    '🔴 已确认的排在未确认的之前（两条已确认占前两位）',
    store.routeNetworks.slice(0, 2).every((s) => s.confirmed) &&
      store.routeNetworks.slice(2).every((s) => !s.confirmed) &&
      new Set([store.routeNetworks[0].schemeId, store.routeNetworks[1].schemeId]).size === 2,
    JSON.stringify(order)
  );
  check(
    '两条已确认的就是刚确认的那两条',
    [store.routeNetworks[0].schemeId, store.routeNetworks[1].schemeId].sort().join(',') ===
      [netA, netB].sort().join(','),
    JSON.stringify(order)
  );
  store.unconfirmRouteNetwork(netB as string);
  check('取消确认后计数回落', store.confirmedNetworkCount === 1, String(store.confirmedNetworkCount));
  check('🔴 记录本身仍在（只是退回备选，节点一个没删）', store.schemes.some((s) => s.id === netB));

  console.log('\n=== 14) 改掉已定的一步后确认 ⇒ 必须分叉，不得就地改写已确认的那条 ===');
  store.applyScheme(netA as string);
  const beforeNetA = JSON.stringify(store.schemes.find((s) => s.id === netA)?.choices);
  const schemesBeforeFork = store.schemes.length;
  store.adopt(r2.id); // 把根那一步换成单前体的 C（R1 的子树被 detach）
  check('换候选后自动分叉出一条新记录', store.schemes.length === schemesBeforeFork + 1, String(store.schemes.length));
  const netFork = store.confirmRouteNetwork();
  check('新记录可以单独确认', !!netFork && netFork !== netA && store.confirmedNetworkCount === 2);
  check(
    '🔴 原来那条已确认网络的选择**没有被改写**',
    JSON.stringify(store.schemes.find((s) => s.id === netA)?.choices) === beforeNetA
  );
  check('分叉后的当前网络不分支（单前体路线）', store.networkStats.branches === 0, String(store.networkStats.branches));

  // ── 复制格式：直接调 utils/route-copy 的真实实现（不复制逻辑）──────────
  console.log('\n=== 15) 复制路线：多格式生成（真调 utils/route-copy） ===');
  const CAS_MAP: Record<string, { cas: string; cid: number; name: string }> = {
    [TARGET]: { cas: '50-78-2', cid: 2244, name: 'Aspirin' },
    [A]: { cas: '108-24-7', cid: 6507, name: 'Acetic anhydride' }
    // B / C 故意不给 ⇒ 走"没查到"分支
  };
  const copyIn = {
    route: store.route,
    target: TARGET,
    materials: store.startingMaterials.map((n) => ({ smiles: n.smiles, formula: n.formula })),
    totalProbability: store.routeProbability,
    casOf: (s: string) => CAS_MAP[s] ?? null,
    at: '2026-10-08T00:00:00.000Z'
  };

  const rxnText = buildRouteCopy('rxn', copyIn);
  check('rxn：一行一步且含 >>', rxnText.split('\n').length === store.route.length && rxnText.includes('>>'));
  check('rxn：注释里带 CAS 查到的名称', rxnText.includes('Aspirin'), rxnText.split('\n')[0]);
  check('🔴 查不到 CAS 也不能漏出 undefined/null 字面量', !/undefined|null/.test(rxnText), rxnText);

  const stepsText = buildRouteCopy('steps', copyIn);
  check('steps：有表头行', stepsText.includes('目标：') && stepsText.includes('总概率'));
  check('steps：逐步列出前体', stepsText.includes('前体 1：'));
  check('steps：CAS 紧跟在产物后面', /产物：.*CAS 50-78-2/.test(stepsText), stepsText.split('\n')[2]);

  const smiText = buildRouteCopy('smiles', copyIn);
  check('smiles：只列产物、每行一个', smiText.split('\n').length === store.route.length && !smiText.includes('>>'));

  const tsv = buildRouteCopy('table', copyIn);
  const tsvHead = tsv.split('\n')[0];
  check('table：表头含 CAS 与概率列', tsvHead.includes('CAS') && tsvHead.includes('概率'), tsvHead);
  check('table：行数 = 步数 + 表头', tsv.split('\n').length === store.route.length + 1);
  check('🔴 table：列数一致（没被前体里的分隔符打乱）', new Set(tsv.split('\n').slice(1).map((l) => l.split('\t').length)).size === 1, tsv);

  const csv = buildRouteCopy('csv', copyIn);
  check('csv：字段带引号', csv.split('\n')[0].startsWith('"步骤"'), csv.split('\n')[0]);
  check('csv：产物含引号时被转义成两个', !buildRouteCopy('csv', { ...copyIn, route: [{ ...store.route[0], product: 'a"b' }] }).includes('a"b'));

  const routeJson = JSON.parse(buildRouteCopy('json', copyIn)) as {
    steps: Array<{ cas: string | null; name: string | null; cid: number | null }>;
    startingMaterials: Array<{ cas: string | null }>;
    disclaimer: string;
  };
  check('json：解析得回且带免责说明', !!routeJson.disclaimer);
  check('json：目标那步带上了 CAS/名称/CID', routeJson.steps.some((s) => s.cas === '50-78-2' && s.name === 'Aspirin' && s.cid === 2244));
  check('🔴 json：查不到的一律 null（不是字符串 "null"）', routeJson.steps.every((s) => s.cas === null || typeof s.cas === 'string'));

  const mats = buildRouteCopy('materials', copyIn);
  check('materials：行数 = 起始物料数', mats.split('\n').length === copyIn.materials.length, mats);
  // 断言按实际第一行取值，不写死是哪一行（换条路线起始物料就变）
  const mrow = mats.split('\n')[0].split('\t');
  check('materials：四列（SMILES/分子式/CAS/名称）', mrow.length === 4, JSON.stringify(mrow));
  check('materials：第 1 列就是起始物料 SMILES', copyIn.materials.some((m) => m.smiles === mrow[0]), mrow[0]);
  check('🔴 materials：查不到 CAS 的行留空而不是填 null', !/null|undefined/.test(mats), mats);

  check('🔴 空路线返回空串（不编占位内容）', buildRouteCopy('rxn', { ...copyIn, route: [] }) === '');
  check('每种模式的 okMsg 都量化了步数', routeCopyOkMsg('rxn', copyIn).includes(String(store.route.length)));

  console.log('\n=== 16) 标识列表口径（真调 composables/useMolIdents 的纯函数） ===');
  const plain = buildMolIdents({ smiles: TARGET, formula: 'C9H8O4', mw: 180.16 }, CAS_MAP[TARGET]);
  check('有 CAS 时列全六项', plain.length === 6, String(plain.map((i) => i.key).join(',')));
  check('🔴 顺序固定：SMILES 优先，CAS/名称/CID 在后', plain.map((i) => i.key).join(',') === 'smiles,formula,mw,cas,name,cid', plain.map((i) => i.key).join(','));
  check('SMILES 标了 primary（预览弹窗靠它加粗）', plain[0].primary === true);
  check('没有 CAS 时只剩三项，且不出现空行', buildMolIdents({ smiles: TARGET }, null).length === 1);
  check('没有 CAS 时也不漏 undefined', !buildMolIdents({ smiles: TARGET }, undefined).some((i) => /undefined/.test(i.value)));
  check('🔴 空 SMILES 返回空数组', buildMolIdents({ smiles: '' }, CAS_MAP[TARGET]).length === 0);
  check('mw 为 0 时不列（0 分子量不是真值）', !buildMolIdents({ smiles: 'C', mw: 0 }, null).some((i) => i.key === 'mw'));
  check('casNote：没要过 = 空串', molCasNote(false, null) === '');
  check('casNote：查过没有要说清是"未收录"', molCasNote(true, null) === 'CAS：PubChem 未收录');
  check('casNote：查询中', molCasNote(true, undefined) === 'CAS 查询中…');
  check('casNote：查到了就不用解释', molCasNote(true, CAS_MAP[TARGET]) === '');

  console.log(`\n========== 总结: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ==========`);
});

process.exitCode = failures === 0 ? 0 : 1;
