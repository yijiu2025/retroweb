/**
 * 真实加载 workspace store 跑一遍新增逻辑（方案切换 / 分析保留 / 相同分子复用）。
 *
 * 🔴 刻意不复制任何被测逻辑：全部走 store 的公开动作（setTarget / adopt / saveScheme /
 *    applyScheme / switchRun / schemeStats），断言的是真实运行结果。
 */
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import { reactionIdFor, useWorkspaceStore } from '../src/stores/workspace';
import { retroClient, retroJobClient } from '../src/api/retro';
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
/**
 * scope 里建好的 store —— 第 18 节要用它，但那一节是 **异步** 的（等轮询），
 * 而 `scope.run` 的回调是同步的 ⇒ 需要从这里带出来。
 */
let store!: ReturnType<typeof useWorkspaceStore>;
scope.run(() => {
  setActivePinia(createPinia());
  store = useWorkspaceStore();

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

  console.log('\n=== 17) 手动指定前体（自己改一条路线） ===');
  // 全部走 store 的公开动作，不复制任何被测逻辑
  store.applyScheme(schA);
  const T2 = store.rootId as string;
  check('起点：当前是方案 A（2 步）', store.networkStats.steps === 2, String(store.networkStats.steps));
  check('起点：没有手动步', store.networkStats.manualSteps === 0, String(store.networkStats.manualSteps));

  // ── 17.1 准入校验：空 / 自己 / 成环，一律拒绝且**不动树** ──────────────
  const schemesBeforeReject = JSON.stringify(store.schemes.map((s) => s.choices));
  check('空前体被拒', store.setPrecursors(T2, ['  ', '']) === null);
  check('🔴 前体不能是产物自己', store.setPrecursors(T2, [TARGET]) === null);
  check('自环的不同写法也拒（按规范 SMILES 判）', store.setPrecursors(T2, [TARGET]) === null);
  check(
    '🔴 三次被拒之后方案选择一个字都没变',
    JSON.stringify(store.schemes.map((s) => s.choices)) === schemesBeforeReject
  );
  check(
    'manualPrecursorIssue 与 setPrecursors 同口径（界面用它提前提示）',
    !!store.manualPrecursorIssue(T2, []) && store.setPrecursors(T2, []) === null
  );
  check('准入判据对不存在的节点也返回原因', !!store.manualPrecursorIssue('nope', [C]));

  // ── 17.2 合法手改：T ← C（单前体）顶掉模型给的 T ← A + B ───────────────
  const schemesBeforeManual = store.schemes.length;
  const schAChoicesBefore = JSON.stringify(store.schemes.find((s) => s.id === schA)?.choices);
  const rid = store.setPrecursors(T2, [C]);
  check('手改成功并返回 reactionId', !!rid);
  const manualRxn = store.nodes[T2].candidates.find((r) => r.id === rid);
  check('🔴 手工候选 origin = manual', manualRxn?.origin === 'manual');
  check(
    '🔴 概率是 null 而不是 0（0 会被读成"此路不通"）',
    manualRxn?.probability === null,
    String(manualRxn?.probability)
  );
  check('id 就是 reactionIdFor(节点, 前体)', rid === reactionIdFor(T2, C), String(rid));
  check('已采纳这一步', store.nodes[T2].chosenReactionId === rid);
  const nodeC = store.nodes[T2].children[0] as string;
  check(
    '子节点建出来了，就是 C',
    store.nodes[T2].children.length === 1 && store.nodes[nodeC].smiles === C,
    JSON.stringify(store.nodes[T2].children.map((id) => store.nodes[id].smiles))
  );
  check(
    '🔴 改掉已定的一步 ⇒ 自动分叉（不得就地改写方案 A）',
    store.schemes.length === schemesBeforeManual + 1,
    `${schemesBeforeManual} → ${store.schemes.length}`
  );
  check(
    '🔴 方案 A 的选择原封不动',
    JSON.stringify(store.schemes.find((s) => s.id === schA)?.choices) === schAChoicesBefore
  );
  check('当前指向新分叉出来的那条', store.currentSchemeId !== schA);

  // ── 17.3 确定性：同一次手改再来一遍 ⇒ 同 id、不新增候选 ────────────────
  const candCount = store.nodes[T2].candidates.length;
  check('🔴 同一前体组合 ⇒ 同一 id（方案恢复才认得回来）', store.setPrecursors(T2, [C]) === rid);
  check(
    '🔴 不重复塞候选',
    store.nodes[T2].candidates.length === candCount,
    `${candCount} → ${store.nodes[T2].candidates.length}`
  );

  // ── 17.4 统计口径：手动步按 1 计入连乘，且单独计数 ─────────────────────
  check('网络步数 = 1', store.networkStats.steps === 1, String(store.networkStats.steps));
  check('manualSteps = 1', store.networkStats.manualSteps === 1, String(store.networkStats.manualSteps));
  check(
    '🔴 只有手动步时总概率 = 1（既不归零也不虚高）',
    store.networkStats.probability === 1,
    String(store.networkStats.probability)
  );
  check('route 里那一步带 manual 标记', store.route[0]?.manual === true);
  check(
    'route 里的概率折成 1（不是 null —— 下游展示层用的是 number）',
    store.route[0]?.probability === 1,
    String(store.route[0]?.probability)
  );

  // ── 17.5 手动步与模型步混合：连乘只吃模型那一半 ────────────────────────
  const E = 'CCO';
  const r5 = rxn(nodeC, [E], 0.5);
  store.nodes[nodeC].candidates = [r5];
  store.adopt(r5.id);
  check(
    '🔴 混合路线总概率 = 1 × 0.5（手动步不参与惩罚）',
    Math.abs(store.networkStats.probability - 0.5) < 1e-9,
    String(store.networkStats.probability)
  );
  check('manualSteps 仍是 1（模型步不算手动）', store.networkStats.manualSteps === 1, String(store.networkStats.manualSteps));

  // ── 17.6 存方案 → 切走 → 切回来：手动步必须原样回来 ────────────────────
  store.saveScheme('手改网络');
  const schManual = store.currentSchemeId as string;
  store.applyScheme(schA);
  check('切回方案 A：手动步不在了', store.networkStats.manualSteps === 0, String(store.networkStats.manualSteps));
  store.applyScheme(schManual);
  check(
    '🔴 切回手改方案：那一步还在（确定性 reactionId 换来的）',
    store.nodes[T2].chosenReactionId === rid,
    String(store.nodes[T2].chosenReactionId)
  );
  check(
    '🔴 切回来之后 manualSteps 仍是 1',
    store.networkStats.manualSteps === 1,
    String(store.networkStats.manualSteps)
  );

  // ── 17.7 切到另一次分析：**未采纳**的手动候选也不许被冲掉 ───────────────
  store.unadopt(T2);
  const otherRun = {
    id: 'run_manual_other',
    at: Date.now(),
    model: 'pistachio',
    numResults: 1,
    candidates: [rxn(T2, [A, B], 0.9)],
    chosenReactionId: null
  };
  store.nodes[T2].runs = [...(store.nodes[T2].runs ?? []), otherRun];
  store.switchRun(T2, otherRun.id);
  check(
    '🔴 换过一次分析后，手动候选仍在列表里（否则它的子树会悬空）',
    store.nodes[T2].candidates.some((r) => r.id === rid),
    store.nodes[T2].candidates.map((r) => r.id).join(',')
  );
  store.adopt(rid);
  check('重新采纳手动步：子树接回来了', store.nodes[T2].children.length === 1);

  // ── 17.8 落盘 → 恢复：概率不能从 null 变成 0 ──────────────────────────
  store.persistSession();
  const sid = store.currentSessionId as string;
  store.loadSession(sid);
  const restoredRxn = store.nodes[T2]?.candidates.find((r) => r.id === rid);
  check('恢复后手动候选还在', !!restoredRxn);
  check(
    '🔴 恢复后概率仍是 null（写成 0 会让总概率连乘归零）',
    restoredRxn?.probability === null,
    String(restoredRxn?.probability)
  );
  check('恢复后 origin 仍是 manual', restoredRxn?.origin === 'manual');
  check(
    '🔴 模型候选恢复后被标成 model（老数据没有 origin 字段，不能漏判成手动）',
    store.nodes[T2]?.candidates.filter((r) => r.id !== rid).every((r) => r.origin === 'model')
  );

  // ── 17.9 复制 / 导出的口径：手动步不能被写成 0% 或 100% ────────────────
  store.adopt(rid);
  const manualCopyIn = {
    ...copyIn,
    route: store.route,
    totalProbability: store.routeProbability,
    manualSteps: store.networkStats.manualSteps
  };
  const mSteps = buildRouteCopy('steps', manualCopyIn);
  check('🔴 复制清单里把手动步写明白了', mSteps.includes('手动指定'), mSteps.split('\n').slice(0, 3).join(' | '));
  check('🔴 总概率带上「含 N 步手动」', mSteps.includes('含 1 步手动'), mSteps.split('\n')[0]);
  const mTable = buildRouteCopy('table', manualCopyIn);
  check('表格里那一格不是 100.0%', mTable.includes('手动') && !mTable.includes('100.0%'), mTable.split('\n')[1]);
  const mCsv = buildRouteCopy('csv', manualCopyIn);
  check('CSV 概率列写「手动」（不是 1.0000）', mCsv.includes('"手动"'), mCsv);
  const mJson = JSON.parse(buildRouteCopy('json', manualCopyIn)) as {
    manualSteps: number;
    steps: Array<{ probability: number | null; manual: boolean }>;
  };
  check('JSON 手动步 probability = null 且 manual = true', mJson.steps.some((s) => s.probability === null && s.manual === true));
  check('JSON 带 manualSteps 字段', mJson.manualSteps === 1, String(mJson.manualSteps));
  check(
    '🔴 没有手动步时，总概率文案与旧实现逐字相同（不引入格式回归）',
    buildRouteCopy('steps', { ...manualCopyIn, manualSteps: 0 }).split('\n')[0].includes('总概率') &&
      !buildRouteCopy('steps', { ...manualCopyIn, manualSteps: 0 }).includes('含 1 步手动')
  );

  // ── 17.10 前体顺序不影响 id（否则方案里会出现两条"一模一样"的步骤）─────
  check(
    '🔴 A.B 与 B.A 得到同一个 id',
    store.setPrecursors(T2, [A, B]) === store.setPrecursors(T2, [B, A]),
    String(store.setPrecursors(T2, [A, B]))
  );

});

// ═══════════════════════════════════════════════════════════════════════════
// 18) 模型状态矩阵 + 就绪轮询
// ═══════════════════════════════════════════════════════════════════════════
// 只换 **传输层**（axios 适配器），store 的动作、状态机、轮询都是真的。
// 起一个真后端来测是不现实的：模型加载要 40~90 秒、18 GB 内存。
//
// 契约来自 web/model_client.py 的 catalog()：
//   { ok, service:{running,state,pid,port,phase,error,elapsed,load_seconds,source},
//     current, models:[{key,label,exists,state,is_current,...}] }

interface FakeModel {
  key: string;
  label: string;
  exists: boolean;
  state: string;
  is_current: boolean;
}

/** 服务端"当下"的状态：用例改写它，适配器按它作答 —— 这样才验得出轮询真的在重读 */
const srv: {
  svcState: string;
  cur: string;
  phase: string;
  elapsed: number | null;
  loadSeconds: number | null;
  models: FakeModel[];
  /** 正向模型（可行性过滤判据）的服务端状态；`present=false` 模拟老后端（不给该字段） */
  fwd: {
    present: boolean;
    key: string;
    state: string;
    error: string;
    loadSeconds: number | null;
  };
  /** 记录最后一次 POST /jobs 的请求体（用来验开关有没有真的透传下去） */
  lastJobBody: Record<string, unknown> | null;
  hits: string[];
  fail: boolean;
} = {
  svcState: 'stopped',
  cur: '',
  phase: '',
  elapsed: null,
  loadSeconds: null,
  models: [
    { key: 'pistachio', label: 'Pistachio（主推，性能最强）', exists: true, state: 'idle', is_current: false },
    { key: 'uspto50k', label: 'USPTO-50K（基准模型，较弱）', exists: true, state: 'idle', is_current: false }
  ],
  fwd: { present: true, key: 'forward_pistachio', state: 'idle', error: '', loadSeconds: null },
  lastJobBody: null,
  hits: [],
  fail: false
};

function snapshot(): unknown {
  return {
    ok: true,
    service: {
      running: srv.svcState === 'ready' || srv.svcState === 'loading',
      state: srv.svcState,
      pid: srv.svcState === 'stopped' ? null : 4321,
      port: 8001,
      phase: srv.phase,
      error: srv.svcState === 'failed' ? 'ValueError: 模型文件损坏' : '',
      elapsed: srv.elapsed,
      load_seconds: srv.loadSeconds,
      source: srv.svcState === 'ready' ? 'http' : 'file'
    },
    current: srv.cur,
    // 🔴 必须**每次克隆**。真实后端每次响应都是刚 parse 出来的新对象；
    //    这里若把 srv.models 原样交出去，store 拿到的是同一个数组引用，
    //    `ref.value = 同一个引用` 因 Object.is 相等而**不触发** reactivity，
    //    于是依赖它的 computed（modelReady / currentModel）永远停在旧值 ——
    //    这是夹具的假象，不是产品的 bug（第一版就是这么被骗了两条红）。
    models: srv.models.map((m) => ({ ...m })),
    // 正向模型：**同样每次克隆**（理由同上）；老后端整个字段都没有 ⇒ 用 present 模拟。
    forward: srv.fwd.present
      ? {
          key: srv.fwd.key,
          label: 'ForwardChimera（Pistachio 预训练）',
          exists: srv.fwd.state !== 'unavailable',
          state: srv.fwd.state,
          error: srv.fwd.error,
          load_seconds: srv.fwd.loadSeconds
        }
      : undefined
  };
}

/**
 * 搜索任务夹具（只覆盖一条最坑的分支：**跑完但 0 条路线**）。
 *
 * 🔴 为什么要专门测它：`applySearchRoutes` 在 routes 为空时**第一行就 return**，
 *    树 / 页签 / 统计一个都不动；而「完成 · 0 条路线」这句只在 `autoRunning`
 *    为真时可见（RouteStats.stateText）⇒ autoRunning 一落回 false，状态条就变回
 *    「还没有展开任何一步」。用户看到的因此是「点了没反应 / 不运行」。
 */
const searchJob = {
  id: 'job-empty',
  polls: 0,
  target: '',
  /**
   * 任务状态。默认 `succeeded`（18.9 要的正是"跑完了、但 0 条路线"）；
   * 18.17 要验「搜索进行中」的中间态，所以做成**可切**。
   */
  state: 'succeeded' as string,
  /** running 时上报的总进度（0~1）—— 用来验进度条口径 */
  progress: 1
};

const adapter = async (config: { url?: string; method?: string; data?: unknown }) => {
  const url = String(config.url || '');
  srv.hits.push(url);
  if (srv.fail) throw new Error('boom');

  // GET /models
  if (url.endsWith('/models')) {
    return { data: snapshot(), status: 200, statusText: 'OK', headers: {}, config };
  }
  // POST /forward/load —— 立刻受理，转入 loading。**不动 service**（正向模型可热挂，
  // 不需要重启模型服务）—— 这一点正是本组用例要盯住的差别。
  //
  // 🔴 这条必须排在下面 `/load` 那条**前面**：`'/forward/load'.endsWith('/load')` 为真，
  //    顺序反了的话这条永远不执行、请求被 `/load` 那条吞掉（夹具把它当成「重载逆向模型」：
  //    service 被切到 loading、forward 一直 idle），表现为「热挂却把服务重启了」的
  //    一片假红 —— 是夹具的坑，不是产品的 bug。
  if (url.endsWith('/forward/load')) {
    srv.fwd.state = 'loading';
    srv.fwd.error = '';
    return {
      data: { ok: true, started: true, key: srv.fwd.key, state: 'loading' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    };
  }
  // POST /load —— 立刻返回"已受理"，并把服务端状态切到 loading
  if (url.endsWith('/load')) {
    const body = (typeof config.data === 'string' ? JSON.parse(config.data) : config.data) as {
      model?: string;
    };
    const key = String(body?.model || '');
    srv.cur = key;
    srv.svcState = 'loading';
    srv.phase = '准备加载';
    srv.elapsed = 0;
    for (const m of srv.models) {
      m.is_current = m.key === key;
      m.state = m.key === key ? 'loading' : 'idle';
    }
    return { data: { ok: true, model: key, started: true }, status: 200, statusText: 'OK', headers: {}, config };
  }
  // POST /model-service/stop
  if (/\/model-service\/stop$/.test(url)) {
    srv.svcState = 'stopped';
    srv.cur = '';
    srv.phase = '';
    srv.elapsed = null;
    for (const m of srv.models) {
      m.is_current = false;
      m.state = 'idle';
    }
    // 服务停了 ⇒ 内存里那份正向模型也一并没了（真实 model_client.catalog 同口径）
    srv.fwd.state = 'idle';
    srv.fwd.loadSeconds = null;
    return { data: { ok: true, action: 'stop' }, status: 200, statusText: 'OK', headers: {}, config };
  }
  // POST /jobs —— 建搜索任务（立刻返回 job_id，与真实后端一致）
  if (url.endsWith('/jobs')) {
    searchJob.polls = 0;
    srv.lastJobBody = (typeof config.data === 'string'
      ? JSON.parse(config.data)
      : config.data) as Record<string, unknown>;
    return { data: { ok: true, job_id: searchJob.id }, status: 200, statusText: 'OK', headers: {}, config };
  }
  // GET /jobs/<id>?since=N —— 状态由 `searchJob.state` 决定。
  // 默认 'succeeded' + **0 条路线**（18.9 那条分支）；18.17 会把它切成 running。
  if (/\/jobs\/[^/?]+/.test(url)) {
    searchJob.polls += 1;
    return {
      data: {
        ok: true,
        job_id: searchJob.id,
        kind: 'search',
        state: searchJob.state,
        progress: searchJob.progress,
        current: searchJob.state === 'running' ? 'Retro* 扩展第 12 层' : '',
        current_detail: '',
        elapsed: 187.5,
        queued_for: 0,
        cancelable: searchJob.state === 'running',
        stages: [],
        logs: [],
        log_seq: 0,
        result: {
          ok: true,
          target: searchJob.target,
          routes: [],
          starting_materials: [],
          stats: { or_nodes: 12, and_nodes: 4, expansions: 4 }
        }
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config
    };
  }
  return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
};
(retroClient.defaults as unknown as { adapter: unknown }).adapter = adapter;
(retroJobClient.defaults as unknown as { adapter: unknown }).adapter = adapter;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

void (async () => {
  console.log('\n=== 18) 模型状态矩阵 + 就绪轮询 ===');

  // ── 18.1 服务没跑：两个模型都该是 idle，且界面不该说"已加载" ──────────
  await store.loadModels();
  check('服务未运行时，两份模型都在列表里', store.models.length === 2, String(store.models.length));
  check(
    '🔴 没加载的模型 state = idle（旧实现共用全局 loaded ⇒ 两个都显示「已加载」）',
    store.models.every((m) => m.state === 'idle'),
    JSON.stringify(store.models.map((m) => [m.key, m.state]))
  );
  check('默认选中的是文件存在的那个', store.params.model === 'pistachio', store.params.model);
  check('服务概览被带上来了', store.modelService?.port === 8001, JSON.stringify(store.modelService));
  check('服务 state = stopped', store.modelService?.state === 'stopped');
  check('此时没有"就绪"', store.modelReady === false);
  check('此时也没有"在忙"', store.modelBusy === false);
  check('未在加载 ⇒ 不轮询', srv.hits.filter((u) => u.endsWith('/models')).length === 1,
    `models 请求数 ${srv.hits.filter((u) => u.endsWith('/models')).length}`);

  // ── 18.2 点「加载」：立刻受理，随即进入轮询 ───────────────────────────
  srv.hits.length = 0;
  const loadP = store.warmModel();
  await loadP;
  check('POST /load 发出去了', srv.hits.some((u) => u.endsWith('/load')), srv.hits.join(' '));
  check(
    '🔴 受理后该模型变 loading（不是"已就绪"—— 后端只保证"已开始"）',
    store.models.find((m) => m.key === 'pistachio')?.state === 'loading',
    JSON.stringify(store.models.map((m) => [m.key, m.state]))
  );
  check('modelBusy = true', store.modelBusy === true);
  check('modelReady 仍是 false', store.modelReady === false);

  // ── 18.3 轮询真的在重读：等 ~3.4 秒应至少多打 2 次 ────────────────────
  const before = srv.hits.filter((u) => u.endsWith('/models')).length;
  await sleep(3600);
  const after = srv.hits.filter((u) => u.endsWith('/models')).length;
  check(
    '🔴 加载期间每 1.5 秒重读一次 /api/models（不轮询 ⇒ 界面永远停在"加载中"）',
    after - before >= 2,
    `${before} → ${after}`
  );

  // ── 18.4 服务端就绪 ⇒ 轮询必须自己停 ─────────────────────────────────
  srv.svcState = 'ready';
  srv.phase = '';
  srv.elapsed = 12.3;
  srv.loadSeconds = 12.3;
  for (const m of srv.models) m.state = m.key === srv.cur ? 'ready' : 'idle';
  await sleep(1800); // 让下一次轮询抓到 ready
  check('抓到 ready', store.modelReady === true, JSON.stringify(store.models.map((m) => [m.key, m.state])));
  // 🔴 这一条是下一条的**前提**：轮询根本没启动时，「就绪后自己停」会假绿。
  //    必须证明"停之前确实在轮"。
  check('🔴 就绪之前确实轮询过（否则下一条是空断言）', after >= 2, `轮询次数 ${after}`);
  check('modelBusy 归 false', store.modelBusy === false);
  const settled = srv.hits.filter((u) => u.endsWith('/models')).length;
  await sleep(3600);
  const later = srv.hits.filter((u) => u.endsWith('/models')).length;
  check(
    '🔴 就绪后**自己停**轮询（不停 ⇒ 每秒白打后端一辈子）',
    later === settled && settled > after,
    `${after} → ${settled} → ${later}`
  );
  check('load_seconds 带得出来', store.modelService?.load_seconds === 12.3);

  // ── 18.5 加载失败：状态如实呈现，且不谎报就绪 ────────────────────────
  srv.svcState = 'failed';
  srv.models.forEach((m) => (m.state = m.key === srv.cur ? 'failed' : 'idle'));
  await store.loadModels();
  check('失败如实报 failed', store.currentModel?.state === 'failed');
  check('失败不是"就绪"', store.modelReady === false);
  check('错误原因透出来了', (store.modelService?.error || '').includes('损坏'), store.modelService?.error);

  // ── 18.6 轮询期间连续失败要收手（后端都没了不该每秒打一辈子）─────────
  // 先让服务回到 loading 并把轮询**正常跑起来**，再让传输开始失败 ——
  // 一上来就失败的话轮询根本不会启动，那条断言就是空的（假绿）。
  srv.fail = false;
  srv.svcState = 'loading';
  srv.models.forEach((m) => (m.state = m.key === srv.cur ? 'loading' : 'idle'));
  await store.loadModels();
  store.clearGlobalError();
  srv.hits.length = 0;
  srv.fail = true;
  await sleep(6000); // 1.5s 一次 ⇒ 大约 4 次尝试，上限 3 次后应该停
  const failedHits = srv.hits.filter((u) => u.endsWith('/models')).length;
  await sleep(3600);
  const failedLater = srv.hits.filter((u) => u.endsWith('/models')).length;
  check(
    '🔴 连续失败到上限就停止轮询（不无限重试）',
    failedLater === failedHits && failedHits >= 2 && failedHits <= 4,
    `${failedHits} → ${failedLater}`
  );
  check(
    '🔴 轮询失败不刷错误条（网络抖一下不该给用户弹报错）',
    store.globalError === null,
    String(store.globalError)
  );

  // ── 18.7 单发失败（用户手动点刷新）仍要如实报错 + 清空残留状态 ────────
  await store.loadModels();
  check('手动的失败照旧弹错（不是静默）', !!store.globalError, String(store.globalError));
  check('失败后不留半截模型列表', store.models.length === 0, String(store.models.length));
  check('失败后不留服务概览', store.modelService === null);

  // ── 18.8 停止模型服务：状态归 idle，且不谎报"仍在就绪" ───────────────
  srv.fail = false;
  srv.svcState = 'ready';
  srv.loadSeconds = 40;
  srv.models.forEach((m) => (m.state = m.key === srv.cur ? 'ready' : 'idle'));
  await store.loadModels();
  check('先回到就绪', store.modelReady === true);
  await store.stopModelService();
  check('停止后 service.state = stopped', store.modelService?.state === 'stopped', store.modelService?.state);
  check('停止后模型全归 idle（不留"已就绪"）', store.models.every((m) => m.state === 'idle'));
  check('停止后 modelReady = false', store.modelReady === false);
  check('停止后 modelBusy = false', store.modelBusy === false);

  // ── 18.9 搜索跑完但 0 条路线：**不许静默**（用户报的「点了没反应」） ──────
  //  真实链路：applySearchRoutes 在 routes 为空时第一行就 return（树一个节点都不动），
  //  而「完成 · 0 条路线」只在 autoRunning 期间可见 ⇒ 状态条随后变回「还没有展开
  //  任何一步」。这条断言的是「必须留下一条不会自己消失的说明」。
  console.log('\n=== 18.9) 搜索 0 条路线：不许静默 ===');
  store.reset({ keepParams: true });
  const TARGET2 = 'CCCCCCCC(=O)O';
  store.setTarget({
    ok: true,
    smiles: TARGET2,
    kind: 'SMILES',
    atoms: 9,
    formula: 'C8H16O2',
    mw: 144.21,
    error: ''
  } as never);
  searchJob.target = TARGET2;
  const nodesBefore = Object.keys(store.nodes).length;
  await store.autoRun();
  check('0 条路线 ⇒ 树不变（applySearchRoutes 直接 return）',
    Object.keys(store.nodes).length === nodesBefore);
  check('🔴 0 条路线必须留下说明（静默 = 用户以为没运行）', !!store.globalError,
    String(store.globalError));
  check('说明里给可操作项（调用预算 / 最大深度）',
    /调用预算|最大深度/.test(store.globalError ?? ''), String(store.globalError));
  check('autoRunning 已复位（否则停止按钮会一直挂着）', store.autoRunning === false);
  check('进度条预算仍是界面的 budgetCalls', store.autoProgress.budget === store.params.budgetCalls,
    `${store.autoProgress.budget} vs ${store.params.budgetCalls}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 18.10~18.15 正向模型（「可行性过滤」的判据）
  // ═══════════════════════════════════════════════════════════════════════
  // 为什么值得单独一组：正向模型与逆向模型的生命周期**不同** —— 它可以在模型服务的
  // HTTP 起来之后热挂（构造时不 spawn 规则子进程）。于是多出三类只有它会踩的坑：
  //   ① 热挂期间 `service.state` 已经是 ready、`models` 也全是 ready，**只看这两者的
  //      轮询会立刻停** ⇒ 按钮永远停在"加载中"；
  //   ② 它不该被混进「预测模型」下拉（那是能当搜索主模型的清单，它是判别器）；
  //   ③ 开关开着但没有判据时要**拦在提交之前**，不能等搜索跑完才失败。
  console.log('\n=== 18.10) 正向模型：状态、热挂与开关 ===');

  // ── 18.10a 回到「服务就绪」并把正向模型置为未加载 ─────────────────────
  srv.fail = false;
  srv.svcState = 'ready';
  srv.cur = 'pistachio';
  srv.loadSeconds = 40;
  srv.models.forEach((m) => (m.state = m.key === 'pistachio' ? 'ready' : 'idle'));
  srv.fwd = { present: true, key: 'forward_pistachio', state: 'idle', error: '', loadSeconds: null };
  await store.loadModels();
  check('正向模型被单独带上来（不在 models 里）',
    store.forwardModel?.key === 'forward_pistachio', JSON.stringify(store.forwardModel));
  check('🔴 正向模型**不混进**「预测模型」清单（混进去会冒出一格必然失败的选项）',
    !store.models.some((m) => m.key === 'forward_pistachio'),
    JSON.stringify(store.models.map((m) => m.key)));
  check('未加载 ⇒ 不能开可行性过滤', store.canUseForwardFilter === false);
  check('未加载 ⇒ forwardBusy = false', store.forwardBusy === false);

  // ── 18.11 老后端不返回 forward：不许崩，按「没有正向模型」渲染 ──────────
  srv.fwd.present = false;
  await store.loadModels();
  check('🔴 老后端缺 forward 字段 ⇒ 模型为 null（不是崩、也不是"就绪"）',
    store.forwardModel === null, JSON.stringify(store.forwardModel));
  check('缺字段时开关也不可用', store.canUseForwardFilter === false);
  srv.fwd.present = true;
  srv.fwd.state = 'ready';
  srv.fwd.loadSeconds = 21.4;
  await store.loadModels();
  check('主模型 + 正向模型都就绪 ⇒ 可以开过滤',
    store.canUseForwardFilter === true,
    JSON.stringify({ fwd: store.forwardModel?.state, ready: store.modelReady }));
  check('正向模型耗时能带出来', store.forwardModel?.load_seconds === 21.4);

  // ── 18.12 热挂正向模型：**不能重启模型服务** ──────────────────────────
  // 这是它与「换逆向模型」的核心差别：换逆向模型要 stop→start（那会顺带把已加载的
  // 模型全丢一遍），正向模型只是挂上去。用 pid / service.state 两个可观测的痕迹盯住。
  srv.fwd.state = 'idle';
  await store.loadModels();
  srv.hits.length = 0;
  await store.loadForward();
  check('POST /forward/load 发出去了', srv.hits.some((u) => u.endsWith('/forward/load')), srv.hits.join(' '));
  check('🔴 加载正向模型**没有**停/重启模型服务（也没顺手重载逆向模型）',
    !srv.hits.some((u) => /\/model-service\/(stop|restart)$/.test(u)) &&
      // 🔴 这里不能写 `endsWith('/load')`：`/forward/load` 也以 `/load` 结尾，
      //    那样写等于「请求里出现了 forward/load 就判失败」，本用例必红。
      //    只排除**逆向模型**那条重载（loadModel → '/load'）。
      !srv.hits.some((u) => u === '/load'),
    srv.hits.join(' '));
  check('受理后 forward.state = loading', store.forwardModel?.state === 'loading',
    JSON.stringify(store.forwardModel));
  check('受理后逆向模型**照常就绪**（没被踢掉）', store.modelReady === true);

  // ── 18.13 🔴 正向模型加载中，轮询必须继续（旧口径会立刻停） ─────────────
  // 这一刻服务端的样子：service.state=ready、models 全是 ready、只有 forward 在 loading。
  // 只按「service + models」判忙的话，syncModelsPolling 会立刻 stopModelsPolling()，
  // 界面就永远停在"加载中"（用户只能手动刷新页面）。
  const fwdBefore = srv.hits.filter((u) => u.endsWith('/models')).length;
  await sleep(3400);
  const fwdAfter = srv.hits.filter((u) => u.endsWith('/models')).length;
  check(
    '🔴 正向模型热挂期间仍每 1.5 秒重读 /api/models（漏了它就永远停在"加载中"）',
    fwdAfter - fwdBefore >= 2,
    `${fwdBefore} → ${fwdAfter}`
  );

  // ── 18.14 挂好之后轮询自己停 ─────────────────────────────────────────
  srv.fwd.state = 'ready';
  srv.fwd.loadSeconds = 19.8;
  await sleep(1800);
  check('正向模型就绪', store.forwardModel?.state === 'ready');
  check('就绪后可开过滤', store.canUseForwardFilter === true);
  const fwdSettled = srv.hits.filter((u) => u.endsWith('/models')).length;
  await sleep(3400);
  const fwdLater = srv.hits.filter((u) => u.endsWith('/models')).length;
  check(
    '🔴 正向模型就绪后轮询自己停（不停 ⇒ 每秒白打后端一辈子）',
    fwdLater === fwdSettled && fwdSettled > fwdBefore,
    `${fwdBefore} → ${fwdSettled} → ${fwdLater}`
  );

  // ── 18.15 开关开着但没有判据 ⇒ 拦在提交之前，不发任务 ─────────────────
  store.reset({ keepParams: true });
  const TARGET3 = 'CCC(=O)O';
  store.setTarget({
    ok: true, smiles: TARGET3, kind: 'SMILES', atoms: 5, formula: 'C3H6O2', mw: 74.08, error: ''
  } as never);
  searchJob.target = TARGET3;
  srv.fwd.state = 'idle';
  await store.loadModels(); // 让 store 看到"正向模型没就绪"
  store.params.forwardFilter = true;
  store.clearGlobalError();
  srv.hits.length = 0;
  await store.autoRun();
  check(
    '🔴 开了过滤但正向模型未就绪 ⇒ 不发搜索任务（不能等跑完才失败）',
    !srv.hits.some((u) => u.endsWith('/jobs')),
    srv.hits.join(' ')
  );
  check('并且留下可操作的说明', /加载正向模型|download_model/.test(store.globalError ?? ''),
    String(store.globalError));
  check('autoRunning 已复位', store.autoRunning === false);

  // ── 18.16 判据齐备 ⇒ 开关真的透传到搜索请求体 ─────────────────────────
  srv.fwd.state = 'ready';
  await store.loadModels();
  store.params.forwardFilter = true;
  store.params.forwardTopK = 7;
  store.clearGlobalError();
  srv.lastJobBody = null;
  await store.autoRun();
  check('搜索请求带上 use_forward_filter = true',
    srv.lastJobBody?.use_forward_filter === true, JSON.stringify(srv.lastJobBody));
  check('搜索请求带上 forward_top_k = 7',
    srv.lastJobBody?.forward_top_k === 7, JSON.stringify(srv.lastJobBody));

  // 关掉过滤再跑一次：请求体必须如实变成 false —— 不能是「界面关了、请求还开着」。
  store.params.forwardFilter = false;
  srv.lastJobBody = null;
  await store.autoRun();
  check('🔴 关掉过滤后请求体如实变为 false（否则是"界面关了、后端还开着"）',
    srv.lastJobBody?.use_forward_filter === false, JSON.stringify(srv.lastJobBody));

  // ═══════════════════════════════════════════════════════════════════════
  // 18.17 多步搜索的**计时起点**（「搜索进行中」动画面板「已用 N 秒」的数据源）
  // ═══════════════════════════════════════════════════════════════════════
  // 为什么放在 store 里而不是组件里：面板挂在页签上，用户可以在搜索跑到一半
  // 才切过来（甚至可以刷新页面后恢复会话）。组件自己在 onMounted 起表的话，
  // 「已用」永远从 0 开始 —— 比真实时长**少一截**，而这个数字正是"到底跑了多久"
  // 的唯一依据（预算和百分比都不反映时间）。所以起点必须由发起方落下。
  //
  // 🔴 反过来的坑同样要防：跑完忘记归零 ⇒ 下一次开跑前残留上一次的读数。
  console.log('\n=== 18.17) 多步搜索计时：起点由 store 落下、跑完归零 ===');
  store.reset({ keepParams: true });
  const TARGET4 = 'CCCCCCC(=O)O';
  store.setTarget({
    ok: true,
    smiles: TARGET4,
    kind: 'SMILES',
    atoms: 8,
    formula: 'C7H14O2',
    mw: 130.18,
    error: ''
  } as never);
  searchJob.target = TARGET4;
  store.params.forwardFilter = false;

  check('开跑前 autoStartedAt 为 null', store.autoStartedAt === null, String(store.autoStartedAt));

  // 让任务**停在 running**：不切的话第一次轮询就 succeeded，量不到中间态
  searchJob.state = 'running';
  searchJob.progress = 0.35;
  // 🔴 故意**不 await**：await 的话 autoRun 一口气跑完，中间态根本没机会被观察
  const runningPromise = store.autoRun();
  await sleep(150);

  check('搜索进行中 autoRunning = true', store.autoRunning === true);
  check('🔴 进行中 autoStartedAt 已落下（组件只负责减去 Date.now，不许自己起表）',
    typeof store.autoStartedAt === 'number' && store.autoStartedAt > 0,
    String(store.autoStartedAt));

  // 轮询周期是 1s ⇒ 等过一轮才拿得到后端快照
  await sleep(1250);
  check('进度取自后端快照（0.35 × 40 次预算 = 14）',
    store.autoProgress.done === 14, `${store.autoProgress.done}/${store.autoProgress.budget}`);
  check('running 期间阶段文案带后端 current', /搜索中/.test(store.autoProgress.label),
    store.autoProgress.label);
  check('running 期间依然 autoRunning（面板据此显示）', store.autoRunning === true);

  searchJob.state = 'succeeded';
  await runningPromise;

  check('跑完 autoRunning 复位', store.autoRunning === false);
  check('🔴 跑完 autoStartedAt 归零（否则下次开跑前会显示上一次的用时）',
    store.autoStartedAt === null, String(store.autoStartedAt));

  console.log(`\n========== 总结: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ==========`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
