/**
 * 逆合成工作台：路线树状态机。
 *
 * 核心原则 ——「多次一步」：
 *   每一次「展开」只发**一次** `/api/predict`（单步逆合成），
 *   候选由用户采纳后前体各新增一行；路线树由前端自己长出来。
 *   刻意不调 `/api/search`（Retro* 一次搜到底）。
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { llmApi, retroApi, RetroApiError, streamAnalyze } from '@/api/retro';
import type {
  AnalysisRun,
  AnalyzeRequest,
  HistoryTask,
  JobProgress,
  LlmStatus,
  MolNode,
  ParseSuccess,
  Reaction,
  RetroModel,
  RouteScheme,
  RouteStep,
  RunParams,
  Session,
  SessionStatus,
  StepAnalysis,
  WorkspaceSnapshot
} from '@/types/retro';
import { countHeavyAtoms, levelOf, uid } from '@/utils/smiles';

const HISTORY_KEY = 'retroweb_history';
const HISTORY_LIMIT = 30;
const SESSIONS_KEY = 'retroweb_sessions';
const SESSIONS_LIMIT = 10;
/** 每个节点最多保留几次分析结果（多了 localStorage 会撑爆） */
const MAX_RUNS = 6;
/** 每个节点最多保留几份 AI 工艺分析 */
const MAX_ANALYSES = 6;

/**
 * 候选反应的**确定性 id**：由「节点 + 前体组合」推出。
 *
 * 🔴 为什么不能用随机 uid：一个节点会被反复分析（保留历史 runs），也可能复用别的节点的
 *    相同分子分析。若 id 随机，切换 runs / 复用结果时 `chosenReactionId` 就对不上，
 *    已建的子树会被误判成「无效选择」而清掉。用确定性 id ⇒ 同样的前体组合永远同一个 id，
 *    选择、复用、切换全都稳定。
 */
export function reactionIdFor(nodeId: string, precursors: string): string {
  let h = 5381;
  const s = String(precursors || '');
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return `rxn_${nodeId}_${h.toString(36)}`;
}

/** 把任意来源的候选整理成「属于 nodeId」的形状（复用别人结果时必须重挂） */
function materializeCandidates(nodeId: string, list: Reaction[]): Reaction[] {
  return list.map((r) => ({
    ...r,
    id: reactionIdFor(nodeId, r.precursors),
    productNodeId: nodeId,
    childNodeIds: []
  }));
}

/** 一条路线方案的「体检结果」（用于多条路线横向对比） */
export interface SchemeStat {
  schemeId: string;
  name: string;
  /** 已采纳的步骤数 */
  steps: number;
  /** 各步概率连乘 */
  probability: number;
  /** 走到起始物料（可购买 / 低于阈值）的叶子数 */
  terminals: number;
  /** 方案里的叶子总数（含尚未拆下去的中间体） */
  leaves: number;
  depth: number;
  /** 所有叶子都到起始物料了 = 这条路线完整 */
  complete: boolean;
}

const DEFAULT_PARAMS: RunParams = {
  model: 'pistachio',
  numResults: 5,
  maxDepth: 4,
  // 阈值定 10 时阿司匹林拆一步就到底了（前体普遍 ≤10 重原子），「多次一步」形同虚设。
  // 6 = 苯环量级（苯 6、甲苯 7 继续拆），才是可购买起始物料的常用口径。
  heavyAtomThreshold: 6,
  startingMaterials: [],
  budgetCalls: 40
};

function readHistory(): HistoryTask[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryTask[]) : [];
  } catch {
    return [];
  }
}

function readSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Session[]) : [];
  } catch {
    return [];
  }
}

function writeSessions(list: Session[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, SESSIONS_LIMIT)));
    return;
  } catch {
    /* 可能是 quota 超了 —— 下面用「瘦身版」再试一次 */
  }
  try {
    // 🔴 兜底：把每步 AI 分析的**原始输出**丢掉（结构化 data 与 RDKit 质量表都留着）。
    //    raw 是唯一可能几 KB 级膨胀的字段；丢了它只是不能再看「模型原文」，
    //    界面该显示的内容一个不少。不这么兜底的话，quota 一超就会**静默**丢失
    //    整个会话 → 「刷新后任务不见了」。
    const slim = list.slice(0, SESSIONS_LIMIT).map((s) => ({
      ...s,
      snapshot: {
        ...s.snapshot,
        nodes: Object.fromEntries(
          Object.entries(s.snapshot.nodes).map(([id, n]) => {
            if (!n.analyses) return [id, n];
            const analyses: NonNullable<MolNode['analyses']> = {};
            for (const [k, rec] of Object.entries(n.analyses)) {
              analyses[k] = { ...rec, raw: '' };
            }
            return [id, { ...n, analyses }];
          })
        )
      }
    }));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(slim));
  } catch {
    /* 仍然失败（隐私模式 / 配额硬上限）：放弃落盘，不影响当前会话使用 */
  }
}

function isAbort(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ERR_CANCELED' || (err instanceof Error && err.name === 'CanceledError');
}

/** 可被打断的 sleep：abort 时立即 resolve，让轮询循环能尽快退出 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export const useWorkspaceStore = defineStore('workspace', () => {
  // ---------- 状态 ----------
  const rootId = ref<string | null>(null);
  const nodes = ref<Record<string, MolNode>>({});
  const params = ref<RunParams>({ ...DEFAULT_PARAMS });
  const models = ref<RetroModel[]>([]);
  const modelsLoading = ref(false);
  const modelLoadingKey = ref<string | null>(null);

  /** 当前展开候选面板的节点 */
  const activeNodeId = ref<string | null>(null);
  const autoRunning = ref(false);
  const autoProgress = ref({ done: 0, budget: 0, label: '' });
  const globalError = ref<string | null>(null);
  const history = ref<HistoryTask[]>(readHistory());

  /**
   * 任务会话列表（持久化到 localStorage）：刷新网页后用来恢复「未完成 / 进行中」的任务。
   * 每个会话是一棵完整的路线树快照；当前正在编辑的会话 id 记录在 currentSessionId。
   */
  const sessions = ref<Session[]>(readSessions());
  const currentSessionId = ref<string | null>(null);

  /**
   * nodeId → 后端 job_id 的镜像（与 jobProgress 同步）。
   * 只有「正在 loading 且已拿到 jobId」的节点才会出现在这里；
   * 节点跑完即删除 ⇒ 刷新后只要某节点还在这里，就说明它对应的后端 job 仍可恢复轮询。
   */
  const jobIds = ref<Record<string, string>>({});

  /**
   * 已保存的「路线方案」：每条方案 = 一组选择（nodeId → reactionId）。
   * 同一个目标分子下可以存多条，随时切换显示 / 横向对比 ——
   * 这就是「切换显示同一个起始原料的多条路线」。
   */
  const schemes = ref<RouteScheme[]>([]);
  const currentSchemeId = ref<string | null>(null);

  /** 大模型配置状态（决定「AI 分析」按钮能用 / 还是指引去填 .env） */
  const llmStatus = ref<LlmStatus | null>(null);

  /** 工艺分析面板要聚焦的节点（从路线树点「工艺分析」跳转过来） */
  const analysisFocus = ref<string | null>(null);
  /** 右栏当前页签（放 store 里，方便路线树里点「工艺分析」直接跳到流程页） */
  const mainTab = ref<'tree' | 'route' | 'flow'>('tree');
  /** 正在流式输出的工艺分析的中止句柄（key = nodeId） */
  const analysisAborts = new Map<string, AbortController>();

  /**
   * 标定面板是否打开 —— 工作台版式的**唯一开关**。
   *
   *   - true  （首次进入 / 点「换目标」）→ 整屏居中的标定卡片（画布 + 粘贴框 + 参数）
   *   - false（点了「确定目标，开始分析」）→ 路线态：目标降级成顶部一条，参数在右栏
   *
   * 🔴 不变量：**没有目标时它必须为 true** —— 否则工作台会是一屏空白，
   *    用户不知道下一步该干什么。`closeTargetSetup()` 里守了这条。
   *
   * 🔴 注意它与 `rootId` 的分工：**解析成功 ≠ 关闭面板**。
   *    `setTarget()` 不碰它；只有用户显式点「确定目标，开始分析」（走 closeTargetSetup）
   *    才关 —— 这样用户才有机会先调模型参数再开跑。
   *    反过来「换目标」时 rootId 还是旧的、非空，所以面板可见性**绝不能**用 `!rootId` 判。
   */
  const targetSetupOpen = ref(true);
  /** 本次标定是否被用户动过（用于「换目标」后提示"改动未保存"之类的场景） */
  const targetSetupDirty = ref(false);
  /** 运行参数栏是否收起（路线态的右栏，可伸缩） */
  const paramsCollapsed = ref(false);
  /** 请求取消句柄（长任务可取消） */
  const aborts = new Map<string, AbortController>();
  /**
   * 每个正在跑分析的节点 → 它的 job 进度快照（阶段时间线 / 日志 / 百分比）。
   * 驱动 StepRow 里的 JobProgress 面板渲染；节点结束（成功/失败/取消）即清除。
   */
  const jobProgress = ref<Record<string, JobProgress>>({});
  let autoStopFlag = false;

  // ---------- 派生 ----------
  // 🔴 过滤掉 detached（被方案切换摘下来的子树）—— 它们仍在内存里等着被接回去，
  //    但不该出现在统计、起始物料汇总、路线回溯里。
  const nodeList = computed(() => Object.values(nodes.value).filter((n) => !n.detached));
  /** 含隐藏节点在内的全部节点（方案对比、复用查找需要看到它们） */
  const allNodes = computed(() => Object.values(nodes.value));

  const stats = computed(() => {
    const list = nodeList.value;
    const terminal = list.filter((n) => n.role === 'starting' || n.status === 'terminated').length;
    const leaves = list.filter((n) => n.children.length === 0).length;
    const maxDepth = list.reduce((m, n) => Math.max(m, n.depth), 0);
    return {
      total: list.length,
      terminal,
      leaves,
      maxDepth,
      reactions: list.filter((n) => n.chosenReactionId).length
    };
  });

  /** 由选定分支回溯出的完整合成路线 */
  const route = computed<RouteStep[]>(() => {
    const out: RouteStep[] = [];
    const root = rootId.value;
    if (!root) return out;
    const walk = (id: string): void => {
      const node = nodes.value[id];
      if (!node || !node.chosenReactionId) return;
      const rxn = node.candidates.find((r) => r.id === node.chosenReactionId);
      if (!rxn) return;
      out.push({
        step: node.depth + 1,
        branchNo: 0,
        nodeId: node.id,
        product: node.smiles,
        productFormula: node.formula,
        precursors: rxn.precursorList,
        probability: rxn.probability,
        model: params.value.model
      });
      // ⚠️ 必须写成箭头：直接 forEach(walk) 会把 index 当作第二个实参传进去
      node.children.forEach((cid) => walk(cid));
    };
    walk(root);
    out.sort((a, b) => a.step - b.step);
    // 同层分支编号：多分支合成时「第 2 步」会有好几条，靠 branchNo 区分
    const seen = new Map<number, number>();
    for (const s of out) {
      const n = (seen.get(s.step) ?? 0) + 1;
      seen.set(s.step, n);
      s.branchNo = n;
    }
    return out;
  });

  /** 路线的总概率（各步连乘） */
  const routeProbability = computed(() =>
    route.value.reduce((acc, s) => acc * (s.probability || 0), 1)
  );

  /** 起始物料：已终止且不再往下拆的叶子 */
  const startingMaterials = computed(() =>
    nodeList.value.filter((n) => n.id !== rootId.value && n.children.length === 0)
  );

  // ---------- 工具 ----------
  function heavyAtoms(node: MolNode): number {
    return node.atoms ?? countHeavyAtoms(node.smiles);
  }

  function isTerminal(node: MolNode): boolean {
    if (node.purchased) return true;
    if (heavyAtoms(node) <= params.value.heavyAtomThreshold) return true;
    return params.value.startingMaterials.includes(node.smiles);
  }

  /** 刷新节点角色 / 终止态（参数变了要全量刷一次） */
  function refreshRole(node: MolNode): void {
    const terminal = isTerminal(node);
    if (terminal) {
      if (node.id !== rootId.value) node.role = 'starting';
      if (node.status !== 'loading') node.status = 'terminated';
    } else {
      if (node.role === 'starting') node.role = node.id === rootId.value ? 'target' : 'intermediate';
      if (node.status === 'terminated') node.status = node.fetched ? 'expanded' : 'idle';
    }
  }

  function refreshAllRoles(): void {
    nodeList.value.forEach(refreshRole);
  }

  /** 祖先链上的 SMILES（防环：A→B→A 死循环） */
  function ancestorSmiles(nodeId: string): string[] {
    const out: string[] = [];
    let cur = nodes.value[nodeId];
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      const pid: string | null | undefined = cur.parentReactionId;
      if (!pid) break;
      // 走全量节点：即使中间某层当前被 detach，祖先关系也依然成立
      const parent = allNodes.value.find((n) => n.candidates.some((r) => r.id === pid));
      if (!parent) break;
      out.push(parent.smiles);
      cur = parent;
    }
    return out;
  }

  function makeNode(partial: Partial<MolNode> & { smiles: string; depth: number }): MolNode {
    const node: MolNode = {
      id: uid('mol'),
      role: partial.depth === 0 ? 'target' : 'intermediate',
      status: 'idle',
      probabilityChain: 1,
      fetched: false,
      candidates: [],
      chosenReactionId: null,
      children: [],
      duplicateOf: null,
      reusedFrom: null,
      runs: [],
      activeRunId: null,
      analyses: {},
      ...partial
    };
    refreshRole(node);
    return node;
  }

  /** 追加一次分析结果并切为当前展示（历史结果保留，最多 MAX_RUNS 条） */
  function pushRun(node: MolNode, run: AnalysisRun): void {
    const list = node.runs ? [...node.runs] : [];
    list.push(run);
    while (list.length > MAX_RUNS) list.shift();
    node.runs = list;
    node.activeRunId = run.id;
    // 🔴 新分析的候选成为当前候选；但若「历史上已采纳的那个反应」不在新候选里，
    //    把它并回来 —— 否则用户手滑点一次「重新分析」，已建的整棵子树就变成
    //    「选了个不存在的反应」而被判无效。
    const merged = [...run.candidates];
    const chosen = node.chosenReactionId;
    if (chosen && !merged.some((r) => r.id === chosen)) {
      const old = (node.candidates || []).find((r) => r.id === chosen);
      if (old) merged.push(old);
    }
    node.candidates = merged;
  }

  /** 切回某一次历史分析结果（已采纳的反应若仍在这批候选里则原样保留） */
  function switchRun(nodeId: string, runId: string): void {
    const node = nodes.value[nodeId];
    if (!node?.runs) return;
    const run = node.runs.find((r) => r.id === runId);
    if (!run) return;
    node.activeRunId = runId;
    const merged = [...run.candidates];
    const keep = node.chosenReactionId;
    if (keep && !merged.some((r) => r.id === keep)) {
      const old = (node.candidates || []).find((r) => r.id === keep);
      if (old) merged.push(old);
    }
    node.candidates = merged;
    // 这次分析当时采纳过某步 ⇒ 恢复它（选择随分析走，切回来还是那条路线）
    if (run.chosenReactionId && merged.some((r) => r.id === run.chosenReactionId)) {
      adopt(run.chosenReactionId);
    }
  }

  /**
   * 在整棵树里找另一个**相同分子**且已经有分析结果的节点（用于「相同中间体直接复用」）。
   * 刻意排除自身与自己的祖先（祖先命中属于防环，另有 duplicateOf 处理）。
   */
  function findReusableNode(selfId: string, smiles: string): MolNode | null {
    const ancestors = new Set(ancestorSmilesIds(selfId));
    for (const n of nodeList.value) {
      if (n.id === selfId || ancestors.has(n.id)) continue;
      if (n.smiles !== smiles) continue;
      if (n.fetched && n.candidates.length) return n;
    }
    return null;
  }

  /** 祖先节点 id 列表（含自身） */
  function ancestorSmilesIds(nodeId: string): string[] {
    const out: string[] = [nodeId];
    let cur = nodes.value[nodeId];
    const guard = new Set<string>([nodeId]);
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      const pid: string | null | undefined = cur.parentReactionId;
      if (!pid) break;
      const parent = allNodes.value.find((n) => n.candidates.some((r) => r.id === pid));
      if (!parent) break;
      out.push(parent.id);
      cur = parent;
    }
    return out;
  }

  /** 把 source 的分析历史整套搬到 target（相同分子 ⇒ 结果可复用） */
  function copyAnalysis(target: MolNode, source: MolNode): void {
    target.runs = JSON.parse(
      JSON.stringify(source.runs ?? [])
    ) as AnalysisRun[];
    // 复用来的候选/历史必须重挂到 target 上（reaction id 与 productNodeId 都是节点相关的）
    target.runs = target.runs.map((run) => ({
      ...run,
      candidates: materializeCandidates(target.id, run.candidates),
      // 复用不复制「当时采纳了谁」，由用户在新位置自己决定
      chosenReactionId: null
    }));
    target.candidates = target.runs.length
      ? materializeCandidates(target.id, source.candidates)
      : [];
    target.activeRunId = target.runs.length ? target.runs[target.runs.length - 1].id : null;
    target.fetched = target.candidates.length > 0;
    target.reusedFrom = source.id;
    target.status = 'expanded';
  }

  /**
   * 「相同中间体直接拿来用」：把树上另一个相同分子的分析结果复制过来，
   * 免去再跑一次模型（也免去为同一个分子消耗一次调用预算）。
   */
  function reuseSiblingAnalysis(nodeId: string): boolean {
    const node = nodes.value[nodeId];
    if (!node) return false;
    const src = findReusableNode(nodeId, node.smiles);
    if (!src) return false;
    copyAnalysis(node, src);
    return true;
  }

  /** 删除子树（保留自身）。⚠️ 标记为 detached 而不是真删 —— 别的路线方案可能还在用它 */
  function detachChildren(node: MolNode): void {
    const hide = (id: string): void => {
      const n = nodes.value[id];
      if (!n) return;
      n.detached = true;
      n.children.forEach(hide);
      delete jobProgress.value[id];
    };
    node.children.forEach(hide);
    node.children = [];
    node.chosenReactionId = null;
    node.candidates.forEach((r) => {
      r.childNodeIds = [];
    });
    delete jobProgress.value[node.id];
    if (activeNodeId.value && nodes.value[activeNodeId.value]?.detached) activeNodeId.value = null;
    syncCurrentScheme();
  }

  /** 把一棵被藏起来的子树接回来（含自身及其所有后代） */
  function attachSubtree(id: string): void {
    const n = nodes.value[id];
    if (!n) return;
    n.detached = false;
    n.children.forEach(attachSubtree);
  }

  /** 某个反应**当初建出来的**子节点（不管现在是否被藏着） */
  function childrenOfReaction(reactionId: string): MolNode[] {
    return Object.values(nodes.value).filter((n) => n.parentReactionId === reactionId);
  }

  /** 从父节点上摘掉某个子节点 */
  function detachFromParent(nodeId: string): void {
    const node = nodes.value[nodeId];
    if (!node) return;
    // 父节点在**可见树**里找：删除是「从当前显示的路线上摘掉」，只该看可见节点。
    const parent = nodeList.value.find((n) => n.children.includes(nodeId));
    if (parent) {
      parent.children = parent.children.filter((c) => c !== nodeId);
      if (!parent.children.length) {
        parent.chosenReactionId = null;
        parent.candidates.forEach((r) => {
          r.childNodeIds = [];
        });
      }
    } else if (nodeId === rootId.value) {
      // 🔴 只有「确实是根」才清 rootId。原实现只要找不到父节点就把 rootId 置空，
      //    而「查找父节点」只看可见节点，可能误清（比如删的是隐藏子树里的节点）。
      rootId.value = null;
    }
    const remove = (id: string): void => {
      const n = nodes.value[id];
      if (!n) return;
      n.children.forEach(remove);
      delete nodes.value[id];
      delete jobProgress.value[id];
    };
    remove(nodeId);
    if (activeNodeId.value === nodeId) activeNodeId.value = null;
  }

  // ---------- 动作 ----------
  async function loadModels(): Promise<void> {
    modelsLoading.value = true;
    try {
      const res = await retroApi.models();
      models.value = res.models ?? [];
      if (models.value.length && !models.value.some((m) => m.key === params.value.model)) {
        params.value.model = models.value[0].key;
      }
    } catch (e) {
      globalError.value = (e as Error).message;
      models.value = [];
    } finally {
      modelsLoading.value = false;
    }
  }

  /** 预热模型（首次预测要加载模型 + 起规则子进程，可达数十秒） */
  async function warmModel(): Promise<void> {
    modelLoadingKey.value = params.value.model;
    try {
      const res = await retroApi.loadModel(params.value.model);
      await loadModels();
      if (res && res.ok === false) globalError.value = res.error || '模型加载失败';
    } catch (e) {
      globalError.value = (e as Error).message;
    } finally {
      modelLoadingKey.value = null;
    }
  }

  /** 设置目标分子：重置整棵树，并开一个新会话 */
  function setTarget(parsed: ParseSuccess): void {
    reset({ keepParams: true });
    const root = makeNode({
      smiles: parsed.smiles,
      depth: 0,
      atoms: parsed.atoms,
      formula: parsed.formula,
      mw: parsed.mw
    });
    nodes.value[root.id] = root;
    rootId.value = root.id;
    activeNodeId.value = null;
    // 新目标 = 新会话（旧会话若还挂着会被保留在列表里，可稍后继续）
    currentSessionId.value = uid('sess');
    // 🔴 这里**有意不关面板**：解析成功只代表「目标填好了」，用户可能还要改模型参数。
    //    关面板的职责归 `closeTargetSetup()`，由标定卡片底部的「确定目标，开始分析」触发。
    persistSession();
  }

  /**
   * 重新打开标定面板（「换目标」按钮）—— 相当于开始一个新任务的准备阶段。
   *
   * 🔴 顺手把旧目标清掉（`reset`）。理由：
   *   ① 「换目标」的语义就是**不要旧的了**，留着它会让输入框里的 SMILES 回填成旧的；
   *   ② 更要命的是旧路线树还挂在界面上 —— 面板是盖在它上面的，一旦 store 里有 rootId，
   *      `TargetInput` 的「已设定」标签、`canStart` 判断都会指向上一个任务，容易误开跑。
   *   面板可见性由 `targetSetupOpen` 独立控制，所以清 rootId 不会把面板一并关掉。
   */
  function openTargetSetup(): void {
    reset({ keepParams: true });
    targetSetupOpen.value = true;
    targetSetupDirty.value = true;
  }

  /** 关掉标定面板（只有已经有目标时才允许，否则工作台会空无一物） */
  function closeTargetSetup(): void {
    if (!rootId.value) return; // 没有目标 → 面板必须开着，没得商量
    targetSetupOpen.value = false;
  }

  /**
   * 展开一步：创建后台 job → 轮询进度，直到成功/失败/取消。
   *
   * 🔴 与旧版直接 `await /api/predict` 不同：这里把长任务交给后端的 jobhub，
   *    前端按 0.8s 节奏拉快照，把「分析到哪一步了」实时画出来（阶段时间线 +
   *    滚动日志 + 进度条）。模型首次加载可达十几分钟，这一步不再干等转圈。
   *
   * 🔴 支持「恢复轮询」：`options.resumeJobId` 非空时，不新建 job，而是直接拿
   *    这个已有的 job_id 继续轮询 —— 这是「刷新网页后能恢复进行中的任务」的关键：
   *    节点 + 它的 job_id 都随会话快照存进了 localStorage，刷新后拿 job_id 重新
   *    拉快照即可（后端 job 在 1h TTL 内仍有效；已算完则立即拿到结果）。
   *
   * @param silent 自动拆分时为真（不打开候选面板）
   */
  async function predictNode(
    id: string,
    options: { force?: boolean; silent?: boolean; resumeJobId?: string } = {}
  ): Promise<void> {
    const node = nodes.value[id];
    if (!node) return;
    if (node.status === 'loading') return;

    if (node.fetched && node.candidates.length && !options.force && !options.resumeJobId) {
      activeNodeId.value = activeNodeId.value === id ? null : id;
      return;
    }

    refreshRole(node);
    if (isTerminal(node)) {
      node.status = 'terminated';
      return;
    }
    if (node.duplicateOf) return;

    node.status = 'loading';
    node.error = undefined;
    node.errorReasons = undefined;
    const controller = new AbortController();
    aborts.set(id, controller);
    jobProgress.value[id] = {
      jobId: options.resumeJobId ?? '',
      state: 'queued',
      progress: 0,
      current: options.resumeJobId ? '正在恢复任务进度…' : '正在创建分析任务…',
      currentDetail: '',
      cancelable: true,
      stages: [],
      logs: [],
      logSeq: 0
    };

    const finish = (): void => {
      aborts.delete(id);
      delete jobProgress.value[id];
    };

    try {
      // —— 创建 or 恢复 job ——
      let jobId = options.resumeJobId;
      if (!jobId) {
        const created = await retroApi.createJob(
          node.smiles,
          params.value.model,
          params.value.numResults
        );
        if (!created.ok || !created.job_id) {
          throw new Error(created.error || '创建分析任务失败');
        }
        jobId = created.job_id;
      }
      // 立刻把 job_id 记进可持久化的镜像，并落盘会话快照
      // （此时节点还是 loading，刷新后就能拿这个 job_id 续轮询）
      jobIds.value[id] = jobId;
      const jp0 = jobProgress.value[id];
      if (jp0) jp0.jobId = jobId;
      persistSession();

      let transientFails = 0;
      while (!controller.signal.aborted) {
        await sleep(800, controller.signal);
        const live = jobProgress.value[id];
        if (!live) break; // 被 reset / 删除 → 退出轮询

        let snap;
        try {
          snap = await retroApi.getJob(live.jobId, live.logSeq);
        } catch (pollErr) {
          // 瞬时错误（超时 / 网络抖动）：最多重试若干次，超过则判失败
          if (pollErr instanceof RetroApiError && !pollErr.transient) {
            // 404 = 后端任务已不存在（Flask 重启 / TTL 到期），明确告知用户重开
            throw pollErr;
          }
          transientFails += 1;
          if (transientFails > 30) {
            // 带上 cause：保留最后一次的真实错误，便于用户/日志定位是超时还是网络断开
            throw new Error('轮询任务进度连续超时，请检查后端服务是否还在运行', {
              cause: pollErr
            });
          }
          live.current = '网络抖动，正在重试…';
          continue;
        }
        transientFails = 0;
        if (!snap.ok) throw new Error('任务进度查询失败');

        // 把快照同步进前端持有对象（整体替换数组，保证响应式）
        live.state = snap.state;
        live.progress = snap.progress;
        live.current = snap.current;
        live.currentDetail = snap.current_detail;
        live.cancelable = snap.cancelable;
        live.stages = snap.stages;
        if (snap.logs?.length) {
          live.logs.push(...snap.logs);
          live.logSeq = snap.log_seq;
        }

        if (snap.state === 'succeeded') {
          const res = snap.result!;
          const candidates = materializeCandidates(
            id,
            res.results.map<Reaction>((c) => ({
              id: '',
              productNodeId: id,
              rank: c.rank,
              probability: c.probability,
              level: c.level || levelOf(c.probability),
              precursors: c.precursors,
              precursorList: c.precursor_list?.length
                ? c.precursor_list
                : String(c.precursors).split('.'),
              numMolecules: c.num_molecules,
              childNodeIds: []
            }))
          );
          // 🔴 每次分析都**追加一条 run**（不是覆盖）⇒ 历史结果全保留，可来回切换
          pushRun(node, {
            id: uid('run'),
            at: Date.now(),
            model: params.value.model,
            numResults: params.value.numResults,
            inferSeconds: res.infer_seconds,
            candidates,
            chosenReactionId: null
          });
          node.fetched = true;
          node.status = 'expanded';
          // 这次是真正跑了一遍模型，不再算「复用别人的结果」
          node.reusedFrom = null;
          if (!options.silent) activeNodeId.value = id;
          break;
        } else if (snap.state === 'failed') {
          node.status = 'failed';
          node.error = snap.error || '预测失败';
          node.errorReasons = snap.error_reasons ?? [];
          break;
        } else if (snap.state === 'cancelled') {
          node.status = node.fetched ? 'expanded' : 'idle';
          break;
        }
      }
    } catch (e) {
      if (e instanceof RetroApiError && !e.transient) {
        // 后端任务丢失（如 Flask 重启）：节点退回可重新展开状态，给出明确提示
        node.status = node.fetched ? 'expanded' : 'idle';
        node.error = e.message;
      } else if (isAbort(e) || controller.signal.aborted) {
        node.status = node.fetched ? 'expanded' : 'idle';
      } else {
        node.status = 'failed';
        node.error = (e as Error).message;
      }
    } finally {
      delete jobIds.value[id];
      persistSession();
      finish();
    }
  }

  /**
   * 取消某个节点的分析：先请求后端 job 取消（在阶段边界生效），
   * 再 abort 本地轮询（立即让 UI 退出 loading）。模型加载/推理本身不可中断，
   * 因此后端 job 会在下一阶段边界正式置为 cancelled。
   */
  function cancelNode(id: string): void {
    const jp = jobProgress.value[id];
    if (jp?.jobId) retroApi.cancelJob(jp.jobId).catch(() => {});
    aborts.get(id)?.abort();
    const node = nodes.value[id];
    if (node && node.status === 'loading') node.status = node.fetched ? 'expanded' : 'idle';
  }

  /** 采纳某个候选反应：前体各新增一行 */
  function adopt(reactionId: string): void {
    // 🔴 父节点要在**全部节点**里找，不能只看「当前可见」的：切换路线方案时要能
    //    把已经被摘下去（detached）的节点重新采纳回来。reaction id 是「节点 + 前体」
    //    推导出来的，全局唯一，所以放大搜索范围不会误命中别人。
    const parent = allNodes.value.find((n) => n.candidates.some((r) => r.id === reactionId));
    if (!parent) return;
    const reaction = parent.candidates.find((r) => r.id === reactionId);
    if (!reaction) return;

    // 🔴 只要已有子树就先整棵摘掉再重建。
    //    原实现只在「换了一个反应」时 detach，重复采纳**同一个**反应时旧子节点
    //    会留在 nodes 里变成孤儿 —— 统计、起始物料汇总都会多出幽灵条目。
    if (parent.children.length) detachChildren(parent);

    parent.chosenReactionId = reactionId;
    // 把「这一步选了谁」记到当前这次分析上 ⇒ 以后切回这次分析，选择还在
    const activeRun = parent.runs?.find((r) => r.id === parent.activeRunId);
    if (activeRun) activeRun.chosenReactionId = reactionId;

    const seen = ancestorSmiles(parent.id);
    const used = new Set<string>();
    const childIds = reaction.precursorList.map((smi) => {
      // ① 这个反应**以前建过**这个前体吗（可能是被别的方案摘下来藏着的）？
      //    建过就整棵接回来 —— 已分析过的分子不用重跑模型，结果也全在。
      const existing = childrenOfReaction(reaction.id).find(
        (n) => n.smiles === smi && !used.has(n.id)
      );
      if (existing) {
        used.add(existing.id);
        attachSubtree(existing.id);
        existing.probabilityChain = parent.probabilityChain * reaction.probability;
        if (seen.includes(smi)) {
          existing.duplicateOf = parent.id;
          existing.status = 'terminated';
        } else {
          existing.duplicateOf = null;
          refreshRole(existing);
        }
        return existing.id;
      }

      const child = makeNode({
        smiles: smi,
        depth: parent.depth + 1,
        parentReactionId: reaction.id,
        probabilityChain: parent.probabilityChain * reaction.probability,
        atoms: countHeavyAtoms(smi)
      });
      used.add(child.id);
      nodes.value[child.id] = child;
      if (seen.includes(smi)) {
        // 同分支上游出现过 ⇒ 防环，终止（拆下去就是死循环）
        child.duplicateOf = parent.id;
        child.status = 'terminated';
      } else {
        // 「相同的中间体可以直接使用」：树上别处已分析过这个分子 ⇒ 直接复用结果，
        //  不必再花一次模型调用；用户不满意可以再点「重新分析」。
        const src = findReusableNode(child.id, smi);
        if (src) copyAnalysis(child, src);
      }
      return child.id;
    });
    reaction.childNodeIds = childIds;
    parent.children = childIds;
    parent.collapsed = false;
    syncCurrentScheme();
  }

  /** 撤销采纳（丢弃该步以下的子树） */
  function unadopt(nodeId: string): void {
    const node = nodes.value[nodeId];
    if (!node) return;
    detachChildren(node);
  }

  function toggleCollapse(nodeId: string): void {
    const node = nodes.value[nodeId];
    if (node) node.collapsed = !node.collapsed;
  }

  function markPurchased(nodeId: string, value: boolean): void {
    const node = nodes.value[nodeId];
    if (!node) return;
    node.purchased = value;
    refreshRole(node);
  }

  function removeBranch(nodeId: string): void {
    detachFromParent(nodeId);
  }

  function collapseAll(): void {
    nodeList.value.forEach((n) => {
      if (n.children.length) n.collapsed = true;
    });
  }

  function expandAll(): void {
    nodeList.value.forEach((n) => {
      n.collapsed = false;
    });
  }

  function stopAuto(): void {
    autoStopFlag = true;
    aborts.forEach((c) => c.abort());
  }

  /**
   * 自动往下拆 K 层：内部**串行多次调用同一个单步接口**（不是 /api/search）。
   * 每层取 Top-1，随时可停止；受 maxDepth 与 budgetCalls 双重约束。
   */
  async function autoRun(): Promise<void> {
    const root = rootId.value;
    if (!root || autoRunning.value) return;
    autoRunning.value = true;
    autoStopFlag = false;
    let calls = 0;
    const queue: string[] = [root];
    autoProgress.value = { done: 0, budget: params.value.budgetCalls, label: '' };

    try {
      while (queue.length && !autoStopFlag && calls < params.value.budgetCalls) {
        const id = queue.shift();
        if (!id) break;
        const node = nodes.value[id];
        if (!node) continue;
        refreshRole(node);
        if (node.depth >= params.value.maxDepth || isTerminal(node) || node.duplicateOf) continue;

        calls += 1;
        autoProgress.value = {
          done: calls,
          budget: params.value.budgetCalls,
          label: `第 ${node.depth + 1} 层 · ${node.smiles.slice(0, 28)}`
        };
        await predictNode(id, { force: true, silent: true });
        if (autoStopFlag) break;
        const chosen = node.candidates[0];
        if (!chosen) continue;
        adopt(chosen.id);
        queue.push(...node.children);
      }
    } finally {
      autoRunning.value = false;
      autoProgress.value = { ...autoProgress.value, label: autoStopFlag ? '已停止' : '完成' };
    }
  }

  function reset(options: { keepParams?: boolean } = {}): void {
    nodes.value = {};
    rootId.value = null;
    activeNodeId.value = null;
    globalError.value = null;
    aborts.forEach((c) => c.abort());
    aborts.clear();
    analysisAborts.forEach((c) => c.abort());
    analysisAborts.clear();
    analysisFocus.value = null;
    jobProgress.value = {};
    schemes.value = [];
    currentSchemeId.value = null;
    if (!options.keepParams) params.value = { ...DEFAULT_PARAMS };
  }

  // ---------- 历史（localStorage） ----------
  function persistHistory(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value.slice(0, HISTORY_LIMIT)));
    } catch {
      /* ignore */
    }
  }

  function saveHistory(name: string): void {
    if (!rootId.value) return;
    const task: HistoryTask = {
      id: uid('task'),
      name: name || `任务 ${new Date().toLocaleString('zh-CN')}`,
      target: nodes.value[rootId.value]?.smiles ?? '',
      createdAt: Date.now(),
      params: { ...params.value },
      rootId: rootId.value,
      nodes: JSON.parse(JSON.stringify(nodes.value)) as Record<string, MolNode>
    };
    history.value = [task, ...history.value].slice(0, HISTORY_LIMIT);
    persistHistory();
  }

  function loadHistory(id: string): void {
    const task = history.value.find((t) => t.id === id);
    if (!task) return;
    reset({ keepParams: true });
    nodes.value = JSON.parse(JSON.stringify(task.nodes)) as Record<string, MolNode>;
    rootId.value = task.rootId;
    params.value = { ...task.params };
    activeNodeId.value = null;
  }

  function removeHistory(id: string): void {
    history.value = history.value.filter((t) => t.id !== id);
    persistHistory();
  }

  // ---------- 会话（刷新可恢复） ----------
  /** 计算当前会话状态：进行中 / 未完成 / 已完成 */
  function computeSessionStatus(): SessionStatus {
    if (nodeList.value.some((n) => n.status === 'loading')) return 'running';
    const leaves = nodeList.value.filter((n) => n.children.length === 0);
    const allResolved = leaves.every((n) => isTerminal(n) || n.status === 'failed');
    return allResolved && leaves.length > 0 ? 'done' : 'incomplete';
  }

  /** 落盘用的节点快照：把 AI 分析的**原始输出**截断（结构化结果与质量表完整保留） */
  function snapshotNodes(): Record<string, MolNode> {
    const clone = JSON.parse(JSON.stringify(nodes.value)) as Record<string, MolNode>;
    for (const n of Object.values(clone)) {
      if (!n.analyses) continue;
      for (const rec of Object.values(n.analyses)) {
        if (rec.raw && rec.raw.length > 2000) {
          rec.raw = rec.raw.slice(0, 2000) + '\n…（原始输出已截断，仅保留结构化结果）';
        }
      }
    }
    return clone;
  }

  /** 把当前工作台落盘成一个会话快照（覆盖 currentSessionId 对应的那条） */
  function persistSession(): void {
    if (!rootId.value) {
      // 没有活动工作台：清掉「当前会话」记录（若有）
      if (currentSessionId.value) {
        sessions.value = sessions.value.filter((s) => s.id !== currentSessionId.value);
        currentSessionId.value = null;
        writeSessions(sessions.value);
      }
      return;
    }
    const snap: WorkspaceSnapshot = {
      rootId: rootId.value,
      nodes: snapshotNodes(),
      params: { ...params.value },
      activeNodeId: activeNodeId.value,
      jobIds: { ...jobIds.value },
      schemes: JSON.parse(JSON.stringify(schemes.value)) as RouteScheme[],
      currentSchemeId: currentSchemeId.value
    };
    const target = nodes.value[rootId.value]?.smiles ?? '';
    const status = computeSessionStatus();
    let session = sessions.value.find((s) => s.id === currentSessionId.value);
    if (!session) {
      session = {
        id: currentSessionId.value || uid('sess'),
        name: `任务 ${new Date().toLocaleString('zh-CN')}`,
        target,
        model: params.value.model,
        status,
        updatedAt: Date.now(),
        snapshot: snap
      };
      if (!currentSessionId.value) currentSessionId.value = session.id;
      sessions.value = [session, ...sessions.value].slice(0, SESSIONS_LIMIT);
    } else {
      session.snapshot = snap;
      session.status = status;
      session.updatedAt = Date.now();
      session.target = target;
      session.model = params.value.model;
    }
    writeSessions(sessions.value);
  }

  /** 防抖落盘：节点 / 参数 / 轮询进度变化都触发，但合并成 400ms 一次写 */
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persistSession(), 400);
  }

  /**
   * 把一个节点补全成合法形状。
   *
   * 🔴 为什么必须有这一步：快照是**从 localStorage 读回来的、可能来自旧版本**，
   *    也可能被手工改坏。而 store 里到处直接解引用节点的结构字段
   *    （`rxn.precursorList.join()`、`node.children.forEach()`、`node.candidates.find()`），
   *    缺一个数组字段就是整页白屏 —— 实测踩过：手写快照漏了 `precursorList`，
   *    报 `Cannot read properties of undefined (reading 'join')`，应用直接起不来，
   *    而且报错发生在计算属性里，控制台只有一堆 promise 重复报错，很难定位。
   *    这里的策略是**缺什么补什么**（而不是丢弃这条会话）——
   *    用户宁可看到一条"结构残缺但能打开"的任务，也不要打不开的历史。
   */
  function normalizeNode(raw: Partial<MolNode>, fallbackId: string): MolNode {
    const smiles = typeof raw.smiles === 'string' ? raw.smiles : '';
    const node: MolNode = {
      id: raw.id || fallbackId,
      smiles,
      role: raw.role ?? 'intermediate',
      depth: typeof raw.depth === 'number' ? raw.depth : 0,
      status: raw.status ?? 'idle',
      formula: raw.formula,
      mw: raw.mw ?? null,
      atoms: raw.atoms,
      parentReactionId: raw.parentReactionId ?? null,
      probabilityChain: typeof raw.probabilityChain === 'number' ? raw.probabilityChain : 1,
      fetched: !!raw.fetched,
      // 这三个数组是解引用重灾区，必须保证是数组
      candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
      chosenReactionId: raw.chosenReactionId ?? null,
      children: Array.isArray(raw.children) ? raw.children : [],
      purchased: !!raw.purchased,
      collapsed: !!raw.collapsed,
      duplicateOf: raw.duplicateOf ?? null,
      reusedFrom: raw.reusedFrom ?? null,
      runs: Array.isArray(raw.runs) ? raw.runs : [],
      activeRunId: raw.activeRunId ?? null,
      // analyses 是「按 reactionId 键控的对象」，不是数组
      analyses:
        raw.analyses && typeof raw.analyses === 'object' && !Array.isArray(raw.analyses)
          ? raw.analyses
          : {}
    };
    // 候选反应自身也要补：rank/precursorList 等被直接读
    node.candidates = node.candidates.map((r) => ({
      ...r,
      probability: typeof r.probability === 'number' ? r.probability : 0,
      precursorList: Array.isArray(r.precursorList)
        ? r.precursorList
        : String(r.precursors ?? '').split('.').filter(Boolean),
      childNodeIds: Array.isArray(r.childNodeIds) ? r.childNodeIds : []
    }));
    return node;
  }

  /** 把某个已存会话的快照灌回当前工作台（不触发新的预测） */
  function restoreSnapshot(s: Session): void {
    reset({ keepParams: true });
    const rawNodes = (s.snapshot?.nodes ?? {}) as Record<string, Partial<MolNode>>;
    const next: Record<string, MolNode> = {};
    for (const [id, raw] of Object.entries(rawNodes)) {
      next[id] = normalizeNode(raw ?? {}, id);
    }
    nodes.value = next;
    rootId.value = s.snapshot.rootId;
    params.value = { ...DEFAULT_PARAMS, ...s.snapshot.params };
    activeNodeId.value = s.snapshot.activeNodeId ?? null;
    jobIds.value = { ...(s.snapshot.jobIds ?? {}) };
    schemes.value = (s.snapshot.schemes ? JSON.parse(JSON.stringify(s.snapshot.schemes)) : []) as RouteScheme[];
    currentSchemeId.value = s.snapshot.currentSchemeId ?? null;
  }

  /** 恢复「正在 loading」的节点的轮询：拿 job_id 接着问后端 */
  function resumeLoading(): void {
    for (const [nodeId, jobId] of Object.entries(jobIds.value)) {
      const node = nodes.value[nodeId];
      if (node && node.status === 'loading' && jobId) {
        void predictNode(nodeId, { resumeJobId: jobId, silent: true });
      }
    }
  }

  /**
   * 刷新网页后调用：自动恢复最近一个「未完成 / 进行中」的会话，
   * 并恢复那些还在跑的节点的轮询。若当前已有工作台则跳过（避免覆盖）。
   */
  function resumeSessions(): void {
    if (rootId.value) return;
    const candidates = sessions.value
      .filter((s) => s.status !== 'done' && s.snapshot?.rootId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const s of candidates) {
      // 🔴 逐条 try：一条坏快照不该让整个应用起不来（restoreSnapshot 里已尽量补全字段，
      //    但真遇到结构完全不对的旧数据，仍然要能跳过它去试下一条）
      try {
        restoreSnapshot(s);
        if (!rootId.value) continue;
        currentSessionId.value = s.id;
        // 恢复出来的会话有根节点 ⇒ 直接进路线态（与 loadSession 同理）
        targetSetupOpen.value = false;
        resumeLoading();
        return;
      } catch (e) {
        console.warn('[retroweb] 跳过一条无法恢复的会话：', s.id, e);
      }
    }
  }

  /** 从列表里手动打开一个会话（点击「继续」） */
  function loadSession(id: string): void {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    try {
      restoreSnapshot(s);
    } catch (e) {
      globalError.value = `这条任务的数据已损坏，无法打开：${(e as Error).message}`;
      return;
    }
    currentSessionId.value = s.id;
    // 打开的会话已经在跑/有路线了 ⇒ 直接进路线态，别让标定卡片盖在上面
    if (rootId.value) targetSetupOpen.value = false;
    resumeLoading();
  }

  /** 删除一个会话（同时清掉它挂着的 jobIds） */
  function removeSession(id: string): void {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    for (const nodeId of Object.keys(s.snapshot.jobIds)) {
      const jid = s.snapshot.jobIds[nodeId];
      if (jid) retroApi.cancelJob(jid).catch(() => {});
    }
    sessions.value = sessions.value.filter((x) => x.id !== id);
    if (currentSessionId.value === id) {
      currentSessionId.value = null;
      // 若当前正显示这个会话的内容，一并清空工作台
      if (rootId.value && s.snapshot.rootId === rootId.value) reset({ keepParams: true });
    }
    writeSessions(sessions.value);
  }

  // ---------- 路线方案（同一目标分子的多条路线，随时切换 / 对比） ----------
  /** 应用方案期间禁止把中间态同步回方案（否则会把方案写坏） */
  let applyingScheme = false;

  /** 当前树上所有「已采纳」的选择 */
  function collectChoices(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of nodeList.value) {
      if (n.chosenReactionId) out[n.id] = n.chosenReactionId;
    }
    return out;
  }

  /**
   * 当前树是否**改掉了**当前方案已经定下的某一步？
   *
   * 用来区分两种编辑意图：
   *   · 「继续往下拆」= 纯扩展（方案里没有的新节点）→ 直接写回当前方案，方案自然变长；
   *   · 「把某一步换成别的候选 / 撤销某一步」= 改了已定的选择 → 这是**另一条路线**，
   *     必须分叉，绝不能在原方案上就地改写。
   *
   * 🔴 这条区分是必需的：早先「任何改动都写回当前方案」的实现会让用户在方案 A 上
   *    「试着换个候选看看」时**静默把方案 A 改掉** —— 已保存的路线就没了。
   *    （集成测试 .harness/store-harness.ts 逮到过这个）。
   */
  function currentSchemeConflicted(): boolean {
    const id = currentSchemeId.value;
    if (!id) return false;
    const s = schemes.value.find((x) => x.id === id);
    if (!s) return false;
    const now = collectChoices();
    // 🔴 s.choices 来自 localStorage，可能是旧结构（例如早先嵌在 snapshot 里）⇒ 必须兜底，
    //    否则 Object.entries(undefined) 会直接抛，把整个 schemeStats 计算链带崩。
    for (const [nodeId, rid] of Object.entries(s.choices ?? {})) {
      if (now[nodeId] !== rid) return true;
    }
    return false;
  }

  /**
   * 用户在「当前方案」上继续改动 → 方案跟着长。
   * 若改的是已定下的选择，则**分叉出一条新方案**（老方案原样保留，随时可切回）。
   */
  function syncCurrentScheme(): void {
    if (applyingScheme) return;
    const id = currentSchemeId.value;
    if (!id) return;
    const s = schemes.value.find((x) => x.id === id);
    if (!s) return;
    if (currentSchemeConflicted()) {
      const forked: RouteScheme = {
        id: uid('sch'),
        name: `${s.name} · 变体${schemes.value.length}`,
        createdAt: Date.now(),
        choices: collectChoices()
      };
      schemes.value = [...schemes.value, forked];
      currentSchemeId.value = forked.id;
      return;
    }
    s.choices = collectChoices();
  }

  /** 把当前这棵树的路线存成一条方案 */
  function saveScheme(name?: string): void {
    if (!rootId.value) return;
    const scheme: RouteScheme = {
      id: uid('sch'),
      name: name?.trim() || `路线 ${schemes.value.length + 1}`,
      createdAt: Date.now(),
      choices: collectChoices()
    };
    schemes.value = [...schemes.value, scheme];
    currentSchemeId.value = scheme.id;
    schedulePersist();
  }

  /**
   * 用一条方案覆盖当前树。
   *
   * 🔴 设计要点：切换方案**不删任何节点**。别的方案用过的子树只是被 detach（藏起来），
   *    所以切来切去不丢工作、也不用重跑模型（见 detachChildren / attachSubtree）。
   * 🔴 按 depth 从浅到深处理，保证父节点先接好子树再处理子节点。
   */
  function applyScheme(id: string): void {
    const scheme = schemes.value.find((s) => s.id === id);
    if (!scheme) return;
    applyingScheme = true;
    try {
      // 🔴 必须遍历**全量节点**（含当前被 detach 的）：一条方案里可能包含现在藏起来的子树，
      //    只看可见节点会导致「被摘下去的步骤永远接不回来」。按 depth 从浅到深，
      //    保证父节点先接好子树再处理子节点。
      const ordered = [...allNodes.value].sort((a, b) => a.depth - b.depth);
      // 方案可能来自旧结构（choices 缺失/嵌套过）⇒ 统一兜底成空对象，别让整轮应用中断
      const choices = scheme.choices ?? {};
      for (const n of ordered) {
        const want = choices[n.id];
        if (want && !n.candidates.some((r) => r.id === want)) {
          // 🔴 方案里记的那一步可能只存在于**更早的一次分析**里（后来「重新分析」
          //    换了候选，把它挤出了当前列表）。从历史 runs 里捞回来并并回 candidates，
          //    否则这条方案会因为「找不到那一步」而残缺。
          const fromRun = (n.runs ?? [])
            .flatMap((run) => run.candidates)
            .find((r) => r.id === want);
          if (fromRun) n.candidates = [...n.candidates, fromRun];
        }
        const has = !!want && n.candidates.some((r) => r.id === want);
        if (has && want) adopt(want);
        else if (n.children.length) detachChildren(n);
      }
      currentSchemeId.value = id;
      activeNodeId.value = null;
    } finally {
      applyingScheme = false;
    }
    schedulePersist();
  }

  function removeScheme(id: string): void {
    schemes.value = schemes.value.filter((s) => s.id !== id);
    if (currentSchemeId.value === id) currentSchemeId.value = null;
    schedulePersist();
  }

  function renameScheme(id: string, name: string): void {
    const s = schemes.value.find((x) => x.id === id);
    if (s) {
      s.name = name.trim() || s.name;
      schedulePersist();
    }
  }

  /**
   * 模拟一条方案的路线，**不改动当前树** —— 用于多条路线横向对比。
   *
   * 走的是 `childrenOfReaction`（按 parentReactionId 找子节点），所以即使某些子树
   * 当前被藏着，也能算出这条方案真实的步数 / 总概率 / 起始物料数。
   */
  function simulateScheme(scheme: RouteScheme): SchemeStat {
    const root = rootId.value;
    const empty: SchemeStat = {
      schemeId: scheme.id,
      name: scheme.name,
      steps: 0,
      probability: 1,
      terminals: 0,
      leaves: 0,
      depth: 0,
      complete: false
    };
    if (!root) return empty;
    let steps = 0;
    let prob = 1;
    let terminals = 0;
    let leaves = 0;
    let depth = 0;
    const seen = new Set<string>();
    const queue: string[] = [root];
    while (queue.length) {
      const nid = queue.shift() as string;
      if (seen.has(nid)) continue;
      seen.add(nid);
      const node = nodes.value[nid];
      if (!node) continue;
      const rid = scheme.choices[nid];
      const rxn = rid ? node.candidates.find((r) => r.id === rid) : undefined;
      if (!rxn) {
        leaves += 1;
        if (isTerminal(node)) terminals += 1;
        continue;
      }
      steps += 1;
      prob *= rxn.probability;
      depth = Math.max(depth, node.depth + 1);
      for (const child of childrenOfReaction(rxn.id)) queue.push(child.id);
    }
    return {
      schemeId: scheme.id,
      name: scheme.name,
      steps,
      probability: prob,
      terminals,
      leaves,
      depth,
      complete: leaves > 0 && terminals === leaves
    };
  }

  /** 所有方案的对比数据 */
  const schemeStats = computed<SchemeStat[]>(() =>
    schemes.value.map((s) => simulateScheme(s))
  );

  // ---------- 大模型工艺分析 ----------
  /**
   * 拉取大模型配置状态。
   * `probe=true` 时后端会真发一次最小请求验证 key + 模型，结果放在 `status.probe`。
   * 🔴 只在用户点「刷新 / 验证」时才 probe —— 每次进页面都 probe 会白打一次网络，
   *    而且很多网关有 tpm/rpm 限流（实测连打几次就 429）。
   */
  async function loadLlmStatus(probe = false): Promise<void> {
    llmStatus.value = await llmApi.status(probe);
  }

  /** 该节点在「当前采纳的那一步」上的 AI 分析记录 */
  function analysisOf(nodeId: string): StepAnalysis | undefined {
    const node = nodes.value[nodeId];
    const rid = node?.chosenReactionId;
    if (!node || !rid) return undefined;
    return node.analyses?.[rid];
  }

  /** 从目标分子到该节点，已经走过的步骤（作为大模型的路线上下文） */
  function routeContext(nodeId: string): AnalyzeRequest['context'] {
    const chain: MolNode[] = [];
    let cur: MolNode | undefined = nodes.value[nodeId];
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.unshift(cur);
      // 🔴 显式标注类型：cur 由下面那行的 find 赋值，而 find 的条件又用了 pid ⇒
      //    TS 无法自行推导（TS7022 循环引用），加注解打断这个环。
      const pid: string | null | undefined = cur.parentReactionId;
      if (!pid) break;
      cur = Object.values(nodes.value).find((n): boolean =>
        n.candidates.some((r): boolean => r.id === pid)
      );
    }
    const steps: string[] = [];
    for (const n of chain) {
      const r = n.candidates.find((x) => x.id === n.chosenReactionId);
      if (r) steps.push(`${n.smiles} ← ${r.precursorList.join(' + ')}`);
    }
    return {
      target: rootId.value ? nodes.value[rootId.value]?.smiles : undefined,
      step_no: chain.length,
      prior_steps: steps.slice(0, -1)
    };
  }

  function trimAnalyses(node: MolNode): void {
    const map = node.analyses;
    if (!map) return;
    const keys = Object.keys(map);
    while (keys.length > MAX_ANALYSES) {
      const k = keys.shift() as string;
      delete map[k];
    }
  }

  /**
   * 对「该节点当前采纳的那一步反应」跑一次 AI 工艺分析（流式）。
   *
   * 结果按 reactionId 存在节点上 ⇒ 天然保留：同一个分子换过几种拆法就有几份分析。
   * 已有 done 的结果默认不重复跑（要看就展开），想重跑传 `force`。
   */
  async function analyzeStep(nodeId: string, opts: { force?: boolean } = {}): Promise<void> {
    const node = nodes.value[nodeId];
    if (!node) return;
    const rid = node.chosenReactionId;
    if (!rid) return;
    const rxn = node.candidates.find((r) => r.id === rid);
    if (!rxn) return;

    if (!node.analyses) node.analyses = {};
    const prev = node.analyses[rid];
    if (prev?.status === 'streaming') return;
    if (prev?.status === 'done' && !opts.force) return;

    analysisAborts.get(nodeId)?.abort();
    const controller = new AbortController();
    analysisAborts.set(nodeId, controller);

    node.analyses[rid] = {
      reactionId: rid,
      status: 'streaming',
      raw: '',
      data: null,
      computed: null,
      model: llmStatus.value?.model,
      at: Date.now()
    };

    /** 一律通过响应式代理写回（直接改本地裸对象不会触发 Vue 更新） */
    const patch = (p: Partial<StepAnalysis>): void => {
      const cur = node.analyses?.[rid];
      if (cur) Object.assign(cur, p);
    };
    const appended = (text: string): void => {
      const cur = node.analyses?.[rid];
      if (cur) cur.raw = (cur.raw || '') + text;
    };
    /** 推理模型的思考增量单独累积 —— 不能混进 raw，否则 JSON 抽取会先撞上思考文本 */
    const appendedThinking = (text: string): void => {
      const cur = node.analyses?.[rid];
      if (cur) cur.reasoning = (cur.reasoning || '') + text;
    };

    const t0 = Date.now();
    const req: AnalyzeRequest = {
      product: node.smiles,
      precursors: rxn.precursorList,
      probability: rxn.probability,
      model: params.value.model,
      context: routeContext(nodeId)
    };

    try {
      await streamAnalyze(
        req,
        {
          onMeta: (m) => patch({ model: m }),
          onThinking: (t) => appendedThinking(t),
          onDelta: (t) => appended(t),
          onDone: (p) => {
            patch({
              raw: p.raw || node.analyses?.[rid]?.raw || '',
              reasoning: p.reasoning || node.analyses?.[rid]?.reasoning || '',
              data: p.data,
              computed: p.computed,
              model: p.model,
              status: 'done',
              elapsed: Math.round((Date.now() - t0) / 100) / 10
            });
            analysisAborts.delete(nodeId);
          },
          onError: (m) => {
            patch({ status: 'failed', error: m, elapsed: Math.round((Date.now() - t0) / 100) / 10 });
            analysisAborts.delete(nodeId);
          }
        },
        controller.signal
      );
    } finally {
      const cur = node.analyses?.[rid];
      // 被 abort 时既走不到 done 也走不到 error ⇒ 这里收尾，避免永远停在「分析中」
      if (cur && cur.status === 'streaming') {
        cur.status = 'failed';
        cur.error = cur.error || '分析已中断';
      }
      analysisAborts.delete(nodeId);
      trimAnalyses(node);
      schedulePersist();
    }
  }

  function cancelAnalysis(nodeId: string): void {
    analysisAborts.get(nodeId)?.abort();
    analysisAborts.delete(nodeId);
    const node = nodes.value[nodeId];
    const rid = node?.chosenReactionId;
    const rec = node && rid ? node.analyses?.[rid] : undefined;
    if (rec && rec.status === 'streaming') {
      rec.status = 'failed';
      rec.error = '已手动停止';
    }
  }

  /** 把所有节点的 AI 分析一次性生成（沿当前路线的每一步） */
  async function analyzeRoute(): Promise<void> {
    const steps = route.value;
    for (const step of steps) {
      const node = nodes.value[step.nodeId];
      if (!node?.chosenReactionId) continue;
      const rec = node.analyses?.[node.chosenReactionId];
      if (rec?.status === 'done' || rec?.status === 'streaming') continue;
      await analyzeStep(step.nodeId);
    }
  }

  // ---------- 导出 ----------
  function exportJson(): string {
    return JSON.stringify(
      {
        app: 'retroweb',
        exportedAt: new Date().toISOString(),
        disclaimer: '模型预测结果可能包含错误，实验前须经专业人员验证。',
        params: params.value,
        target: rootId.value ? nodes.value[rootId.value]?.smiles : null,
        route: route.value,
        routeProbability: routeProbability.value,
        startingMaterials: startingMaterials.value.map((n) => ({
          smiles: n.smiles,
          formula: n.formula
        })),
        // 多条路线方案 + 每步的 AI 工艺分析一起带走
        schemes: schemeStats.value,
        stepAnalyses: route.value.map((s) => {
          const node = nodes.value[s.nodeId];
          const rec = node?.chosenReactionId ? node.analyses?.[node.chosenReactionId] : undefined;
          return {
            step: s.step,
            product: s.product,
            analysis: rec?.data ?? null,
            analysis_raw: rec?.raw ?? '',
            computed: rec?.computed ?? null
          };
        })
      },
      null,
      2
    );
  }

  function exportCsv(): string {
    const head = '步骤,分支,产物SMILES,产物分子式,前体SMILES,概率,模型';
    const rows = route.value.map((s) =>
      [
        s.step,
        s.branchNo,
        s.product,
        s.productFormula ?? '',
        s.precursors.join(' + '),
        s.probability.toFixed(4),
        s.model
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    return [head, ...rows].join('\n');
  }

  // 参数变化 → 重算所有终止态
  watch(
    () => [params.value.heavyAtomThreshold, params.value.startingMaterials.length],
    () => refreshAllRoles()
  );

  // 工作台任何变化（节点树 / 参数 / 当前节点 / 轮询进度 / job 映射 / 路线方案）→ 防抖落盘会话
  // 🔴 这样刷新网页时 localStorage 里永远有「最新的未完成 / 进行中」任务快照
  watch(
    [nodes, params, activeNodeId, jobProgress, jobIds, schemes, currentSchemeId],
    schedulePersist,
    { deep: true }
  );

  return {
    rootId,
    nodes,
    nodeList,
    allNodes,
    params,
    models,
    modelsLoading,
    modelLoadingKey,
    activeNodeId,
    jobProgress,
    autoRunning,
    autoProgress,
    globalError,
    history,
    sessions,
    currentSessionId,
    stats,
    route,
    routeProbability,
    startingMaterials,
    // —— 路线方案（同一目标分子的多条路线） ——
    schemes,
    currentSchemeId,
    schemeStats,
    saveScheme,
    applyScheme,
    removeScheme,
    renameScheme,
    simulateScheme,
    // —— 分析历史 / 相同中间体复用 ——
    switchRun,
    reuseSiblingAnalysis,
    findReusableNode,
    // —— 大模型工艺分析 ——
    llmStatus,
    analysisFocus,
    mainTab,
    loadLlmStatus,
    analysisOf,
    analyzeStep,
    analyzeRoute,
    cancelAnalysis,
    loadModels,
    warmModel,
    setTarget,
    targetSetupOpen,
    targetSetupDirty,
    paramsCollapsed,
    openTargetSetup,
    closeTargetSetup,
    predictNode,
    cancelNode,
    adopt,
    unadopt,
    toggleCollapse,
    markPurchased,
    removeBranch,
    collapseAll,
    expandAll,
    autoRun,
    stopAuto,
    reset,
    saveHistory,
    loadHistory,
    removeHistory,
    resumeSessions,
    loadSession,
    removeSession,
    persistSession,
    exportJson,
    exportCsv,
    isTerminal,
    heavyAtoms
  };
});
