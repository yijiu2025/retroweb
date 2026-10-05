/**
 * 真实加载 workspace store 跑一遍新增逻辑（方案切换 / 分析保留 / 相同分子复用）。
 *
 * 🔴 刻意不复制任何被测逻辑：全部走 store 的公开动作（setTarget / adopt / saveScheme /
 *    applyScheme / switchRun / schemeStats），断言的是真实运行结果。
 */
import { createPinia, setActivePinia } from 'pinia';
import { effectScope } from 'vue';
import { reactionIdFor, useWorkspaceStore } from '../src/stores/workspace';
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

  console.log(`\n========== 总结: ${failures === 0 ? 'ALL PASS' : failures + ' FAILED'} ==========`);
});

process.exitCode = failures === 0 ? 0 : 1;
