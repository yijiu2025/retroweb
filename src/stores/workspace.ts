/**
 * 逆合成工作台：路线树状态机。
 *
 * 两条并存的推进方式：
 *   - 「单步」：每次「展开」只发一次 `/api/jobs`（kind=predict，单步逆合成），
 *     候选由用户采纳后前体各新增一行；路线树由前端自己长出来。
 *   - 「一次搜到底」：`autoRun`（自动往下拆）提交 kind=search 的任务，
 *     后端 Retro* 一次搜完整棵 AND/OR 树、吃满调用预算，返回多条完整路线；
 *     最优路线重建为树，其余存成备选方案（schemes）。
 */
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import {
  llmApi,
  retroApi,
  RetroApiError,
  streamAnalyze,
  streamConditions,
  streamFollowup
} from '@/api/retro';
import type {
  AnalysisModuleKey,
  AnalysisRun,
  AnalyzeRequest,
  ConditionOption,
  ConditionsRequest,
  FeedbackEntry,
  FollowupRequest,
  HistoryTask,
  JobProgress,
  LlmStatus,
  MolNode,
  ParseSuccess,
  PredictOk,
  Reaction,
  RetroModel,
  RouteScheme,
  RouteStep,
  RunParams,
  SearchOk,
  Session,
  SessionStatus,
  StepAnalysis,
  StepConditions,
  StepFollowup,
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
/** 每份工艺分析最多保留几条追问（追问会累积，不设上限 localStorage 迟早爆） */
const MAX_FOLLOWUPS = 10;
/** 候选反应条件枚举的偏好（跨会话保留，属"用户习惯"而非任务数据） */
const COND_PREF_KEY = 'retroweb_cond_pref';

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
  /**
   * 多组分反应的步数 —— 即这条路线在几个地方「分叉」。
   *
   * 一步把分子拆成 2 个以上前体时，树会在这里分成多条支线，
   * 这条路线的形状就不是一条链而是一张网。这个数就是网的规模感：
   * 0 分支 = 纯线性路线；>0 = 真正的「路线网络」。
   */
  branches: number;
  /** 已确认为采用中的路线网络（未确认的只是备选草稿） */
  confirmed: boolean;
  confirmedAt?: number;
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

/**
 * AI 工艺分析可勾选的模块（默认全选）。
 * 🔴 顺序即面板展示顺序；`summary`（总述+反应类型）是每次分析的兜底，不在这里展示，
 *    但永远随请求带上。与后端 `_MODULE_FIELDS` 的 key 对齐。
 */
export const ALL_ANALYSIS_MODULES: AnalysisModuleKey[] = [
  'mechanism',
  'order',
  'conditions',
  'workup',
  'outcome',
  'byproducts',
  'lcms',
  'nmr',
  'tlc',
  'safety'
];

/** 模块 key → 中文名（RunParams 勾选面板用） */
export const ANALYSIS_MODULE_LABELS: Record<AnalysisModuleKey, string> = {
  summary: '总述与反应类型',
  mechanism: '反应机理',
  order: '投料顺序',
  conditions: '反应条件',
  workup: '后处理分析',
  outcome: '预期结果与收率',
  byproducts: '可能的副产物',
  lcms: 'LCMS 解读',
  nmr: 'NMR 谱图归属',
  tlc: '点板与过柱极性',
  safety: '安全与放大提示'
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
              // 候选条件枚举的模型原文（condOptions.raw）与 rec.raw 同量级，一起丢掉
              analyses[k] = {
                ...rec,
                raw: '',
                ...(rec.condOptions ? { condOptions: { ...rec.condOptions, raw: '' } } : {})
              };
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

/**
 * 候选条件枚举的偏好。属于「用户习惯」而非任务数据 ⇒ 单独存一个 key，
 * 不进会话快照（换个任务不该把上一个人的偏好带过去）。
 *
 * 🔴 读写都要 try：SSR 测试环境（vue-pinia-real-store-harness 用 node 跑 store）
 *    里没有 localStorage，直接访问会抛 ReferenceError，一抛就连 store 都建不起来。
 */
function readCondPref(): { planFirst: boolean; count: number } {
  const def = { planFirst: true, count: 4 };
  try {
    const raw = localStorage.getItem(COND_PREF_KEY);
    if (!raw) return def;
    const obj = JSON.parse(raw) as { planFirst?: unknown; count?: unknown };
    const count = Number(obj?.count);
    return {
      // 只有显式存成 false 才算关（老数据/坏数据都当默认开启）
      planFirst: obj?.planFirst !== false,
      count: Number.isFinite(count) ? Math.max(2, Math.min(6, Math.round(count))) : def.count
    };
  } catch {
    return def;
  }
}

function writeCondPref(v: { planFirst: boolean; count: number }): void {
  try {
    localStorage.setItem(COND_PREF_KEY, JSON.stringify(v));
  } catch {
    /* 隐私模式 / 配额满：偏好存不上不影响本次使用 */
  }
}

function isAbort(err: unknown): boolean {
  const code = (err as { code?: string })?.code;  return code === 'ERR_CANCELED' || (err instanceof Error && err.name === 'CanceledError');
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
  /** AI 工艺分析勾选的模块（默认全选）。空数组 = 全量分析（与后端语义一致） */
  const analysisModules = ref<AnalysisModuleKey[]>([...ALL_ANALYSIS_MODULES]);
  /**
   * 「先列候选条件再深入分析」—— 反应条件本就有多套组合，默认先枚举让用户挑一套。
   * 关掉 = 老行为：直接按模型的第一直觉给一套条件做深入分析。
   */
  const condPlanFirst = ref(readCondPref().planFirst);
  /** 一次枚举几套候选条件方案（后端夹到 2~6） */
  const condOptionCount = ref(readCondPref().count);
  watch([condPlanFirst, condOptionCount], () => {
    writeCondPref({ planFirst: condPlanFirst.value, count: condOptionCount.value });
  });
  const models = ref<RetroModel[]>([]);
  const modelsLoading = ref(false);
  const modelLoadingKey = ref<string | null>(null);

  /** 当前展开候选面板的节点 */
  const activeNodeId = ref<string | null>(null);
  const autoRunning = ref(false);
  const autoProgress = ref({ done: 0, budget: 0, label: '' });
  const globalError = ref<string | null>(null);
  /**
   * 最近一次失败动作的「重试」入口 —— 顶部错误条上的重试按钮用。
   *
   * 🔴 每个 setGlobalError 调用点**自己给闭包**（重试模型加载 / 重试预热 / 重开任务），
   *    这样「重试」永远重做**刚才失败的那件事**，而不是笼统地刷新页面
   *    （刷新页面会丢掉正在编辑的路线树）。
   */
  const errorRetry = ref<(() => void) | null>(null);

  /** 报错：文案 + 可选的「重试」动作（不传则该错误只能关闭） */
  function setGlobalError(msg: string, retry: (() => void) | null = null): void {
    globalError.value = msg;
    errorRetry.value = retry;
  }

  function clearGlobalError(): void {
    globalError.value = null;
    errorRetry.value = null;
  }

  /** 错误条上「重试」被点击：清错误 → 重做上次失败的动作用 */
  function retryError(): void {
    const fn = errorRetry.value;
    clearGlobalError();
    fn?.();
  }
  const history = ref<HistoryTask[]>(readHistory());

  /**
   * 任务会话列表（持久化到 localStorage）：刷新网页后用来恢复「未完成 / 进行中」的任务。
   * 每个会话是一棵完整的路线树快照；当前正在编辑的会话 id 记录在 currentSessionId。
   */
  const sessions = ref<Session[]>(readSessions());
  const currentSessionId = ref<string | null>(null);
  /**
   * 标定面板当前「正在编辑」的会话 id（null = 全新任务，还没有归属）。
   *
   * 🔴 为什么需要它（真实 bug）：`setTarget()` 之前**无条件** `currentSessionId = uid('sess')`
   *   新建会话，于是「打开一个标定态任务 → 清空 → 点示例 / 重新粘贴」会在列表里
   *   **多冒出一条新任务**（并把原任务顶下去）；用户明明是想改手头这个任务。
   *   有了这个字段，就能区分两种语境：
   *     · 从侧栏「打开」某任务 → editingSessionId = 该任务 id ⇒ 后续 setTarget **编辑它**；
   *     · 「＋新任务」/「换目标」→ editingSessionId = null ⇒ 后续 setTarget **新建**。
   */
  const editingSessionId = ref<string | null>(null);

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
  /**
   * 主区当前页签。
   *
   * 🔴 默认是 `overview`（目标分析总览）：打开一个任务先看到「在拆什么 + 已确认到哪一步」，
   *    而不是一屏还没长开的逆合成树 —— 树/网络/详情都在页签里，随时可进。
   *    `loadSession` / `resumeSessions` 会把它复位成 `overview`（换任务 = 换上下文）。
   */
  const mainTab = ref<'overview' | 'tree' | 'route' | 'flow'>('overview');
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
      setGlobalError((e as Error).message, () => void loadModels());
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
      if (res && res.ok === false) setGlobalError(res.error || '模型加载失败', () => void warmModel());
    } catch (e) {
      setGlobalError((e as Error).message, () => void warmModel());
    } finally {
      modelLoadingKey.value = null;
    }
  }

  /** 设置目标分子：重置整棵树，并（按上下文）编辑现有会话或开一个新会话 */
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
    // 🔴 **解析结构不创建任务**。任务由 `closeTargetSetup()`（「确定目标，开始分析」/
    //    自动往下拆）那一刻诞生 —— 那里才分配会话 id 并落第一次盘。
    //    这里只做一件事：**认领**「标定面板正在编辑的那条已有会话」（从侧栏打开一条
    //    草稿任务再改结构 ⇒ 改的仍是它）；没有归属就保持无归属（不建、不写盘）。
    //
    //    ⚠️ 原实现在没有归属时**无条件** `uid('sess')`，于是同一次标定里每点一次
    //    「解析结构」就在侧栏「最近的任务」里多出一条同名任务（实测点 3 次 → 3 条，
    //    用户报的正是这个）；而「＋新任务」「换目标」只会在**开始**标定时把
    //    editingSessionId 置 null，挡不住解析阶段的重复调用。
    const reuse = editingSessionId.value;
    if (reuse && sessions.value.some((s) => s.id === reuse)) {
      currentSessionId.value = reuse;
    } else {
      // 清掉可能残留的旧 id —— 否则接下来那次落盘可能写到**别的任务**身上
      currentSessionId.value = null;
      editingSessionId.value = null;
    }
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
    // 🔴 「＋新任务」与「换目标」都表示**开始一个全新任务**：把「正在编辑的会话」清掉，
    //    这样接下来 `setTarget()` 才会新建会话，而不是改写上一个任务。
    editingSessionId.value = null;
    currentSessionId.value = null;
    targetSetupOpen.value = true;
    targetSetupDirty.value = true;
    // 换任务 = 换上下文：页签回到「目标分析」总览
    mainTab.value = 'overview';
  }

  /** 关掉标定面板（只有已经有目标时才允许，否则工作台会空无一物） */
  function closeTargetSetup(): void {
    if (!rootId.value) return; // 没有目标 → 面板必须开着，没得商量
    targetSetupOpen.value = false;
    // 🔴 **任务在这一刻诞生**：分配会话 id + 落第一次盘。
    //    放在解析时（setTarget）会变成「点几次解析就多几条任务」；
    //    只靠那个 deep watcher 兜则会漏 —— 目标本身就是可购买起始物料时，
    //    节点状态从 makeNode 起就是终态，watcher 一次都不触发，
    //    任务永远不会出现在侧栏、刷新也就丢了。
    //    （打开草稿再点开始分析的那条路：currentSessionId 已经是那条会话，原样写回。）
    if (!currentSessionId.value) currentSessionId.value = uid('sess');
    persistSession();
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
          // 🔴 predict 任务的 result 一定是 PredictOk（search 走另一条 runSearch 路径）。
          //    JobSnapshot.result 是 `PredictOk | SearchOk` 的 union，这里收窄。
          const res = snap.result as PredictOk;
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
   * 把后端 search 返回的**多条完整路线**灌进工作台。
   *
   * 呈现策略（最小侵入、复用现有「路线方案」机制）：
   *   - `routes[0]`（按总概率降序后的最优路线）**重建当前树**；
   *   - 其余路线各存成一条 `RouteScheme`（choices = nodeId → reactionId 映射），
   *     用户可在「路线网络」栏 / 方案里随时切换查看、横向对比。
   *
   * 🔴 route → 树的转换：search 的 route 是 `steps: [{product, reactants, probability}]`
   *    从目标往起始物料逐层展开。这里按「SMILES → 节点」建树：
   *    每个 step 的 product 是一个节点，reactants 是它的前体（children），
   *    该 step 就是这条路线在 product 节点上**已选定的反应**（chosenReactionId）。
   *    一条 route 内每个分子只出现一次（Retro* 提取的是无环路径）⇒ 用 SMILES 做 key 安全。
   */
  function applySearchRoutes(search: SearchOk): void {
    const routes = search.routes ?? [];
    if (!routes.length) return;

    // 1) 清空当前树（"一次搜到底"直接替换，不做增量合并）
    nodes.value = {};
    schemes.value = [];
    currentSchemeId.value = null;

    const rootSmiles = search.target;
    const root = makeNode({ smiles: rootSmiles, depth: 0 });
    nodes.value[root.id] = root;
    rootId.value = root.id;
    root.fetched = true;
    root.status = 'expanded';
    root.activeRunId = null;

    /** SMILES → 节点 id（所有路线共享同一份节点池，相同分子只建一次） */
    const bySmiles = new Map<string, string>([[rootSmiles, root.id]]);
    /** Retro* 给出的「不再往下拆」的叶子（起始物料）—— 重原子数可能超阈值，须显式标可购买 */
    const startSet = new Set(search.starting_materials ?? []);

    /**
     * 取（或建）某个分子的节点。作为某个反应的「前体」被引入时带上 parentReactionId，
     * 这样 `adopt` / `simulateScheme` 里的 `childrenOfReaction(reactionId)` 才能凭
     * parentReactionId 把它找回来 —— 多路线共用同一个中间体时不会重复建、统计也不漏。
     */
    const ensureNode = (smi: string, parentDepth: number, parentReactionId?: string): string => {
      const existing = bySmiles.get(smi);
      if (existing && nodes.value[existing]) return existing;
      const node = makeNode({
        smiles: smi,
        depth: parentDepth + 1,
        parentReactionId: parentReactionId ?? null,
        purchased: startSet.has(smi),
        atoms: countHeavyAtoms(smi)
      });
      node.fetched = true;
      nodes.value[node.id] = node;
      bySmiles.set(smi, node.id);
      return node.id;
    };

    /**
     * 沿一条 route 把「节点 + 候选反应」铺进节点池（只填 candidates，不采纳），
     * 返回这条路线对应的 choices（nodeId → reactionId）。
     *
     * 🔴 刻意**不改** `chosenReactionId` / `children`：采纳（把候选接到树上）统一在
     *    下面 `applyToTree` 做。否则多路线共用同一个根/中间节点时，后处理的路线会
     *    把先处理路线已经建好的子树覆盖掉（两条路线都从同一个 target 出发，实测
     *    「最优路线」的树被「备选路线」顶掉了）。
     */
    const layRoute = (route: SearchOk['routes'][number]): Record<string, string> => {
      const choices: Record<string, string> = {};
      for (const step of route.steps) {
        const productNodeId = bySmiles.get(step.product);
        if (!productNodeId) continue; // 目标之外的 product 都应在前面步骤（作为前体）建过了
        const product = nodes.value[productNodeId];
        if (!product) continue;

        const precursors = step.reactants.join('.');
        const reaction: Reaction = {
          id: reactionIdFor(productNodeId, precursors),
          productNodeId,
          rank: 0,
          probability: step.probability ?? 0,
          level: levelOf(step.probability ?? 0),
          precursors,
          precursorList: step.reactants,
          numMolecules: step.reactants.length,
          childNodeIds: []
        };
        // 🔴 追加而非覆盖：多条路线可能共享同一个 product（例如都从 target 出发），
        //    每条路线在这个节点上各有一个候选反应，必须都留着，adopt/applyScheme 才能
        //    按 reactionId 找到自己那条。
        if (!product.candidates.some((c) => c.id === reaction.id)) {
          product.candidates = [...product.candidates, reaction];
        }
        product.fetched = true;
        choices[productNodeId] = reaction.id;

        for (const smi of step.reactants) ensureNode(smi, product.depth, reaction.id);
      }
      return choices;
    };

    // 2) 先把**所有**路线的节点/候选铺进池子（备选方案切过去时 applyScheme 要能找到反应）
    const routeChoices = routes.map((r) => layRoute(r));

    // 3) 最优路线（routes[0]）接上树：按 depth 从浅到深，把 choices 里每一步的候选
    //    直接设为 chosenReactionId + 建 children（节点都在池子里，无需再走 adopt 建节点，
    //    也就不会与「铺池子」那步打架）。
    const applyToTree = (choices: Record<string, string>): void => {
      const ordered = Object.values(nodes.value).sort((a, b) => a.depth - b.depth);
      for (const node of ordered) {
        const rid = choices[node.id];
        if (!rid) continue;
        const reaction = node.candidates.find((c) => c.id === rid);
        if (!reaction) continue;
        node.chosenReactionId = rid;
        node.children = reaction.precursorList
          .map((smi) => bySmiles.get(smi))
          .filter((id): id is string => !!id);
        reaction.childNodeIds = node.children;
        node.status = 'expanded';
      }
    };
    applyToTree(routeChoices[0]);
    refreshAllRoles();

    // 4) 其余路线存成备选方案（choices 映射；切过去时 applyScheme 会用 adopt 重建）
    for (let i = 1; i < routeChoices.length; i += 1) {
      schemes.value = [
        ...schemes.value,
        {
          id: uid('sch'),
          name: `搜索路线 ${i + 1}`,
          createdAt: Date.now(),
          choices: routeChoices[i]
        }
      ];
    }
    // 当前展示的是最优路线（已在树上），不挂 currentSchemeId（它是一条"活的"树，非快照）
    currentSchemeId.value = null;
    activeNodeId.value = null;
    schedulePersist();
  }

  /**
   * 自动往下拆 = 提交 kind=search 的任务，一次 Retro* 搜到底、吃满预算。
   *
   * 🔴 取代旧的「单步循环 Top-1」：旧实现每层只 adopt `candidates[0]`、再被
   *    `depth >= maxDepth` 封顶 ⇒ 调用次数 ≤ 层级数，`budgetCalls`（默认 40）永远
   *    够不着（实测只发了 4 次）。改成交给后端 Retro*（best-first 广度搜索），
   *    预算在 worker 里真吃满，一次返回多条完整路线。
   */
  async function autoRun(): Promise<void> {
    const root = rootId.value;
    if (!root || autoRunning.value) return;
    const target = nodes.value[root];
    if (!target) return;

    autoRunning.value = true;
    autoStopFlag = false;
    autoProgress.value = { done: 0, budget: params.value.budgetCalls, label: '正在创建搜索任务…' };

    try {
      const created = await retroApi.createSearchJob(target.smiles, {
        model: params.value.model,
        maxRoutes: 8,
        maxCalls: params.value.budgetCalls,
        timeLimit: 300,
        maxDepth: params.value.maxDepth,
        maxHeavyAtoms: params.value.heavyAtomThreshold,
        valueFn: 'complexity',
        purchasable: params.value.startingMaterials,
        requiredMaterials: []
      });
      if (!created.ok || !created.job_id) {
        throw new Error(created.error || '创建路线搜索任务失败');
      }
      const jobId = created.job_id;
      autoProgress.value = { done: 0, budget: params.value.budgetCalls, label: '搜索中…' };

      let logSeq = 0;
      while (!autoStopFlag) {
        await sleep(1000);
        const snap = await retroApi.getJob(jobId, logSeq);
        if (snap.logs?.length) logSeq = snap.log_seq;
        if (snap.state === 'succeeded') {
          const result = snap.result as SearchOk | undefined;
          if (result && result.ok) {
            applySearchRoutes(result);
            autoProgress.value = {
              done: params.value.budgetCalls,
              budget: params.value.budgetCalls,
              label: `完成 · ${result.routes?.length ?? 0} 条路线`
            };
          } else {
            throw new Error((result as { error?: string } | undefined)?.error || '搜索无结果');
          }
          return;
        }
        if (snap.state === 'failed') {
          throw new Error(snap.error || '搜索失败');
        }
        if (snap.state === 'cancelled') {
          autoProgress.value = { ...autoProgress.value, label: '已取消' };
          return;
        }
        // running / queued：更新进度条文案
        const cur = snap.current ? ` · ${snap.current}` : '';
        autoProgress.value = {
          done: Math.round(snap.progress * params.value.budgetCalls),
          budget: params.value.budgetCalls,
          label: `搜索中${cur}`
        };
      }
    } catch (e) {
      if (isAbort(e) || autoStopFlag) {
        autoProgress.value = { ...autoProgress.value, label: '已停止' };
      } else {
        autoProgress.value = { ...autoProgress.value, label: '搜索失败' };
        setGlobalError((e as Error).message, () => void autoRun());
      }
    } finally {
      autoRunning.value = false;
    }
  }

  function reset(options: { keepParams?: boolean } = {}): void {
    nodes.value = {};
    rootId.value = null;
    activeNodeId.value = null;
    clearGlobalError();
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

/**
 * 会话「内容签名」—— 用来判断这次落盘到底是**真的改了内容**，还是只是打开看一眼。
 *
 * 🔴 为什么需要它（真实 bug）：`persistSession()` 被一个 deep watcher 驱动，
 *    而「打开某个任务」就会触发它（restoreSnapshot 换掉了 nodes / params / jobIds）。
 *    原实现在这里无条件写 `session.updatedAt = Date.now()` ⇒ **点一下旧任务，它就跳到
 *    「最近的任务」第一位**，用户正要找的邻居全被挤走；而侧栏又是按 updatedAt 排的。
 *
 * 🔴 为什么不能直接 `JSON.stringify(snapshot)` 当签名：节点对象在运行期是
 *    `{...默认值, ...partial}` 拼出来的，从 localStorage 恢复时走的是 `normalizeNode()`
 *    的固定字段顺序 ⇒ **同一个节点两次序列化的键顺序不同**，字符串必然不等，
 *    签名恒变 = 白做。所以这里只取「与字段顺序无关、且能被 normalizeNode 完整保留」的字段，
 *    并**排序**后再拼。
 */
function sessionSignature(snap: WorkspaceSnapshot): string {
  const p = snap.params;
  const nodes = Object.entries(snap.nodes)
    .map(([id, n]) => {
      const analyses = Object.entries(n.analyses ?? {})
        .map(([rid, rec]) => `${rid}:${rec.status}`)
        .sort()
        .join(',');
      return [
        id,
        n.status,
        n.role,
        n.chosenReactionId ?? '',
        n.duplicateOf ?? '',
        n.reusedFrom ?? '',
        n.children.join(','),
        n.fetched ? 1 : 0,
        n.purchased ? 1 : 0,
        n.collapsed ? 1 : 0,
        n.candidates.length,
        analyses
      ].join('|');
    })
    .sort();

  const schemes = (snap.schemes ?? [])
    // 🔴 必须带上「确认」标记：确认一条路线网络是**内容变化**，
    //    漏了它 ⇒ 点确认后侧栏时间不刷新、任务也不上浮，用户以为没生效。
    .map((s) => `${s.id}:${Object.keys(s.choices ?? {}).length}:${s.confirmed ? 1 : 0}`)
    .join(',');

  return [
    snap.rootId ?? '',
    snap.currentSchemeId ?? '',
    // 参数逐字段取，别 JSON.stringify 整个对象（键顺序同样不稳）
    p.model,
    p.numResults,
    p.maxDepth,
    p.heavyAtomThreshold,
    p.budgetCalls,
    p.startingMaterials.join(','),
    Object.keys(snap.jobIds ?? {}).sort().join(','),
    schemes,
    nodes.join(';')
  ].join('#');
}

/** 把当前工作台落盘成一个会话快照（覆盖 currentSessionId 对应的那条） */
function persistSession(): void {
  if (!rootId.value) {
    // 没有活动工作台。
    // 🔴 这里**只解除「当前会话」标记，绝不删除会话** —— 原实现顺手把
    //    currentSessionId 那条从列表里 filter 掉，于是「换目标 / 新建任务」
    //    （都会先 reset() 把 rootId 清空）会把**上一个任务整个删掉**，
    //    用户看到的就是「点了个新任务，旧任务没了」。任务只能由用户显式删除。
    currentSessionId.value = null;
    return;
  }
  // 🔴 **还没有任务归属 ⇒ 不落盘、也不新建**。
  //    标定态里刚解析出来的结构只活在内存中：用户连点几次「解析结构」、
  //    或点示例换来换去，都不该在侧栏「最近的任务」里堆出一串同名任务。
  //    任务从「确定目标，开始分析」那一刻诞生（closeTargetSetup 先发 id 再调这里）。
  //    ⚠️ 判据是**有没有归属**，不是「在不在标定态」：从侧栏打开一条草稿任务、
  //       在标定面板里改结构，仍然要写回**那一条**（否则改动会静默丢掉）。
  if (!currentSessionId.value) return;
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
    const sig = sessionSignature(snap);
    let session = sessions.value.find((s) => s.id === currentSessionId.value);
    if (!session) {
      session = {
        id: currentSessionId.value || uid('sess'),
        name: `任务 ${new Date().toLocaleString('zh-CN')}`,
        target,
        model: params.value.model,
        status,
        updatedAt: Date.now(),
        snapshot: snap,
        sig
      };
      if (!currentSessionId.value) currentSessionId.value = session.id;
      sessions.value = [session, ...sessions.value].slice(0, SESSIONS_LIMIT);
    } else {
      session.snapshot = snap;
      session.status = status;
      session.target = target;
      session.model = params.value.model;
      // 🔴 排序用的 updatedAt 只在**内容真的变了**时才刷新。
      //    内容没变（典型场景：点开一个旧任务，store 回写一次同样的快照）⇒ 时间不动，
      //    列表里的位置也就不动。
      if (session.sig === undefined) {
        session.sig = sig; // 旧数据第一次载入：只登记签名，不算「刚动过」
      } else if (session.sig !== sig) {
        session.sig = sig;
        session.updatedAt = Date.now();
      }
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
        editingSessionId.value = s.id;
        // 🔴 口径必须与 `loadSession` 一致（同一份快照，点侧栏打开 vs 刷新自动恢复
        //    不能落到两个不同阶段）：**已开始**的任务直接进路线态；
        //    **草稿**（只解析了目标、还没点「开始分析」）回标定面板让用户接着编 ——
        //    否则刷新后面板凭空消失，只剩一棵光秃秃的单目标树，用户以为任务没了。
        if (!isDraftSession(s)) {
          targetSetupOpen.value = false;
        } else {
          targetSetupOpen.value = true;
        }
        mainTab.value = 'overview'; // 打开任务先看目标 + 已确认路线，不直接甩一屏树
        resumeLoading();
        return;
      } catch (e) {
        console.warn('[retroweb] 跳过一条无法恢复的会话：', s.id, e);
      }
    }
  }

  /**
   * 这个会话是不是还停留在「标定态」—— 即只设了目标分子、还没点过「开始分析」。
   *
   * 判据：根节点还是 `idle`。一旦 `startAnalysis()` 开跑，`predictNode` 会把根节点从
   * `idle` 置成 `loading`（最终 `expanded` / `failed` / `terminated`）—— 所以
   * **根节点 status === 'idle' ⇔ 还没开始分析**，与有没有子节点无关：
   *   目标分子本身就是「可购买原料」时，`predictNode` 会直接把它置 `terminated`
   *   （一步都不用拆、也没有子节点），但那已经是「分析过」的完成态，不是草稿。
   * 草稿任务被打开时应**回到标定面板**让用户继续编辑，而不是显示一屏路线态。
   */
  function isDraftSession(s: Session): boolean {
    const snap = s.snapshot;
    if (!snap?.rootId) return true; // 连目标都没设 = 一定是草稿
    const root = snap.nodes?.[snap.rootId];
    if (!root) return false;
    return root.status === 'idle';
  }

  /** 从列表里手动打开一个会话（点击「继续」） */
  function loadSession(id: string): void {
    const s = sessions.value.find((x) => x.id === id);
    if (!s) return;
    try {
      restoreSnapshot(s);
    } catch (e) {
      setGlobalError(
        `这条任务的数据已损坏，无法打开：${(e as Error).message}`,
        () => loadSession(s.id)
      );
      return;
    }
    currentSessionId.value = s.id;
    // 🔴 打开的任务就是接下来「继续 / 编辑」的对象：记下来，后续在标定面板里
    //    setTarget（清空→点示例 / 重粘 / 画图）都改写**它**，而不是另起新任务。
    editingSessionId.value = s.id;
    // 🔴 已开始分析（有路线 / 正在跑）的任务 ⇒ 直接进路线态，别让标定卡片盖在上面；
    //    但**标定态**任务（只设了目标、还没点「开始分析」）⇒ 打开标定面板让用户继续填。
    if (rootId.value && !isDraftSession(s)) {
      targetSetupOpen.value = false;
    } else {
      targetSetupOpen.value = true;
    }
    // 换任务 = 换上下文：页签回到「目标分析」总览（不直接展示逆合成树）
    mainTab.value = 'overview';
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
      // 没给名字时（「确认路线网络」走的就是这条）默认叫「网络 N」—— 与界面上的叫法一致
      name: name?.trim() || `网络 ${schemes.value.length + 1}`,
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
    // 🔴 老数据的 choices 可能是旧结构 / 缺失 ⇒ 先兜底，否则 undefined[xxx] 会把
    //    整个 schemeStats 计算链带崩（与 currentSchemeConflicted 同一处理）。
    const choices = scheme.choices ?? {};
    // 确认标记不是"算"出来的，是方案自带的属性 ⇒ 一起带进结果
    const confirmed = { confirmed: !!scheme.confirmed, confirmedAt: scheme.confirmedAt };
    const empty: SchemeStat = {
      schemeId: scheme.id,
      name: scheme.name,
      steps: 0,
      probability: 1,
      terminals: 0,
      leaves: 0,
      depth: 0,
      complete: false,
      branches: 0,
      ...confirmed
    };
    if (!root) return empty;
    let steps = 0;
    let branches = 0;
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
      const rid = choices[nid];
      const rxn = rid ? node.candidates.find((r) => r.id === rid) : undefined;
      if (!rxn) {
        leaves += 1;
        if (isTerminal(node)) terminals += 1;
        continue;
      }
      steps += 1;
      // 一步拆成 ≥2 个前体 = 这里分叉 ⇒ 路线从「一条链」变成「一张网」
      if ((rxn.precursorList?.length ?? 0) > 1) branches += 1;
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
      complete: leaves > 0 && terminals === leaves,
      branches,
      ...confirmed
    };
  }

  /** 所有方案的对比数据 */
  const schemeStats = computed<SchemeStat[]>(() =>
    schemes.value.map((s) => simulateScheme(s))
  );

  /**
   * 当前采纳树的体检结果 —— 就是「当前这条路线网络」。
   *
   * 🔴 口径复用 `simulateScheme`（临时造一个 choices 等于当前树的假方案），
   *    绝不在别处再写一遍统计逻辑：侧栏显示的步数 / 分支 / 起始物料必须和
   *    网络列表里那一行**永远一致**，否则用户会看到「同一张网两个步数」。
   */
  const networkStats = computed<SchemeStat>(() =>
    simulateScheme({ id: '__current__', name: '当前路线', createdAt: 0, choices: collectChoices() })
  );

  /**
   * 「路线网络」列表：已确认的排前面（按确认时间 新→旧），未确认的保持创建顺序。
   * 侧栏与逆合成树工具条都读它，两处顺序才一致。
   *
   * ⚠️ 同一毫秒内确认的两条 `confirmedAt` 相同（Date.now() 就是 1ms 分辨率）⇒
   *    比较函数返回 0，靠 Array.sort 的**稳定序**回落成"先创建的在前"。
   *    这是可接受的（两条都是"刚确认"），但**别在测试里写死它们的先后**。
   */
  const routeNetworks = computed<SchemeStat[]>(() =>
    [...schemeStats.value].sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
      if (a.confirmed) return (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0);
      return 0;
    })
  );

  /** 已确认的路线网络条数（树工具条 / 侧栏共用，别再各自 filter 一遍） */
  const confirmedNetworkCount = computed(
    () => schemeStats.value.filter((s) => s.confirmed).length
  );

  /**
   * 把当前这条路线**确认为一条路线网络**。
   *
   * 两条分支：
   *   · 当前选中某条方案、且树没有改动过它 ⇒ 就地标为已确认（不新建，
   *     免得同一张网出现两条一模一样的记录）；
   *   · 否则（还没存过方案，或已经把某一步换成了别的候选）⇒ 先存一条新的再确认。
   *     🔴 这是「改已保存的路线必须分叉」那条约定的延伸：新路线就得是新记录，
   *        绝不能在原方案上就地改写。
   *
   * @returns 被确认的方案 id；没有目标分子时 null
   */
  function confirmRouteNetwork(): string | null {
    if (!rootId.value) return null;
    const id = currentSchemeId.value;
    const cur = id ? schemes.value.find((s) => s.id === id) : undefined;
    if (cur && !currentSchemeConflicted()) {
      cur.choices = collectChoices();
      cur.confirmed = true;
      cur.confirmedAt = Date.now();
      schedulePersist();
      return cur.id;
    }
    saveScheme();
    const created = schemes.value.find((s) => s.id === currentSchemeId.value);
    if (!created) return null;
    created.confirmed = true;
    created.confirmedAt = Date.now();
    schedulePersist();
    return created.id;
  }

  /**
   * 直接把**某一条记录**标为已确认 —— 不动当前树。
   *
   * 与 `confirmRouteNetwork()` 的分工：
   *   · 树工具条走 confirmRouteNetwork（判据是"当前树"，该分叉就分叉）；
   *   · 网络列表 / 方案栏里的那一行走这个（用户点的是**那一条**，语义就是它本身）。
   */
  function confirmScheme(id: string): void {
    const s = schemes.value.find((x) => x.id === id);
    if (!s) return;
    s.confirmed = true;
    s.confirmedAt = Date.now();
    schedulePersist();
  }

  /** 取消确认 —— 退回「只是保存过的备选方案」，记录本身保留、节点一个不动 */
  function unconfirmRouteNetwork(id: string): void {
    const s = schemes.value.find((x) => x.id === id);
    if (!s) return;
    s.confirmed = false;
    s.confirmedAt = undefined;
    schedulePersist();
  }

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

  /**
   * 该节点「用户选定的候选条件」对应的那套方案（没选过 = undefined）。
   *
   * 🔴 从 condOptions 里**按 id 现查**，不缓存对象引用：枚举结果可能被重新枚举覆盖，
   *    缓存引用会指向一份已经不在界面上显示的旧方案。
   */
  function chosenCondition(nodeId: string): ConditionOption | undefined {
    const rec = analysisOf(nodeId);
    const id = rec?.chosenConditionId;
    if (!id) return undefined;
    return rec?.condOptions?.data?.options.find((o) => o.id === id);
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
   *
   * 🔴 `continue`（接着分析）：LLM 是无状态的，普通重跑会从头再来。上次失败（截断/中断）
   *    若已收到部分正文，把那段正文作为 assistant 前缀续写，让模型从断点接着补完，
   *    而不是重头再写一遍。传 `continue: true` 时内部自动带上 `continue_from`。
   */
  async function analyzeStep(
    nodeId: string,
    opts: { force?: boolean; continue?: boolean } = {}
  ): Promise<void> {
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

    // 接着分析：把上次已收到的正文接上续写（保留思考过程不被丢弃）
    const continueFrom = opts.continue && prev?.raw ? prev.raw : undefined;

    node.analyses[rid] = {
      reactionId: rid,
      status: 'streaming',
      raw: '',
      data: null,
      computed: null,
      model: llmStatus.value?.model,
      at: Date.now(),
      // 🔴 候选条件与「已选条件」必须跨「重新分析」保留：不带上就会在这次分析开始时被抹掉，
      //    于是界面上「已选条件方案」的标记与本轮枚举结果一起消失（枚举等于白跑）。
      ...(prev?.condOptions ? { condOptions: prev.condOptions } : {}),
      ...(prev?.chosenConditionId ? { chosenConditionId: prev.chosenConditionId } : {})
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
      context: routeContext(nodeId),
      // 勾选的模块；空数组 = 全量（后端据此裁剪 prompt，只输出勾选字段）
      modules: [...analysisModules.value],
      // 用户选定的候选条件：锁定这套条件，否则模型会另换一套溶剂/温度，用户的选择就白做了
      chosen_condition: chosenCondition(nodeId) ?? null,
      ...(continueFrom ? { continue_from: continueFrom } : {})
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

  /* ---------- 候选反应条件（先枚举 → 选一套 → 深入分析） ---------- */

  /**
   * 枚举「这一步反应可能的反应条件」—— 先让模型列出几套方案，再由用户挑一套深入分析。
   *
   * 反应条件（溶剂 / 温度 / 碱与缩合剂 / 浓度 / 投料方式）本就是组合空间，一次只给一套
   * 等于把模型的第一直觉当唯一答案。结果挂在 `analysis.condOptions` 上（按 reactionId 存 ⇒
   * 同一个分子换过不同拆法，各有各的枚举结果）。
   *
   * 已有 done 的结果默认不重跑（要看就展开展示），想重新枚举传 `force`。
   */
  async function analyzeConditions(nodeId: string, opts: { force?: boolean } = {}): Promise<void> {
    const node = nodes.value[nodeId];
    const rid = node?.chosenReactionId;
    if (!node || !rid) return;
    const rxn = node.candidates.find((r) => r.id === rid);
    if (!rxn) return;

    if (!node.analyses) node.analyses = {};
    // 🔴 枚举通常发生在「还没做过深入分析」的时候 ⇒ 记录不存在要自己建出来，
    //    否则 condOptions 无处安放（沿用 StepAnalysis 的状态字段形状，status 先 idle）。
    if (!node.analyses[rid]) {
      node.analyses[rid] = { reactionId: rid, status: 'idle', raw: '' };
    }
    const prev = node.analyses[rid];
    if (prev.condOptions?.status === 'streaming') return;
    if (prev.condOptions?.status === 'done' && !opts.force) return;

    // 用独立 key：枚举与深入分析可以并存（选了条件就立刻跑分析，两者是两条流）
    const ak = `cond:${nodeId}`;
    analysisAborts.get(ak)?.abort();
    const controller = new AbortController();
    analysisAborts.set(ak, controller);

    const t0 = Date.now();
    prev.condOptions = {
      status: 'streaming',
      raw: '',
      data: null,
      computed: null,
      model: llmStatus.value?.model,
      at: Date.now()
    };

    /** 一律重新从响应式对象上取 —— 记录可能刚被 analyzeStep 重建过，别缓存引用 */
    const cur = (): StepConditions | undefined =>
      node.analyses?.[rid]?.condOptions ?? undefined;
    const patch = (p: Partial<StepConditions>): void => {
      const c = cur();
      if (c) Object.assign(c, p);
    };
    const append = (key: 'raw' | 'reasoning', text: string): void => {
      const c = cur();
      if (c) c[key] = (c[key] || '') + text;
    };

    const req: ConditionsRequest = {
      product: node.smiles,
      precursors: rxn.precursorList,
      probability: rxn.probability,
      model: params.value.model,
      context: routeContext(nodeId),
      count: condOptionCount.value
    };

    try {
      await streamConditions(
        req,
        {
          onMeta: (m) => patch({ model: m }),
          onThinking: (t) => append('reasoning', t),
          onDelta: (t) => append('raw', t),
          onDone: (p) => {
            patch({
              raw: p.raw || cur()?.raw || '',
              reasoning: p.reasoning || cur()?.reasoning || '',
              data: p.data,
              computed: p.computed,
              model: p.model,
              status: 'done',
              elapsed: Math.round((Date.now() - t0) / 100) / 10
            });
            analysisAborts.delete(ak);
          },
          onError: (m) => {
            patch({ status: 'failed', error: m, elapsed: Math.round((Date.now() - t0) / 100) / 10 });
            analysisAborts.delete(ak);
          }
        },
        controller.signal
      );
    } finally {
      const c = cur();
      // 被 abort 时既走不到 done 也走不到 error ⇒ 这里收尾，避免永远停在「枚举中」
      if (c && c.status === 'streaming') {
        c.status = 'failed';
        c.error = c.error || '枚举已中断';
      }
      analysisAborts.delete(ak);
      schedulePersist();
    }
  }

  /**
   * 选定一套候选条件（`optionId = null` = 取消选择，恢复「不限条件」）。
   *
   * 🔴 只改 `chosenConditionId`、**不动 condOptions** —— 用户要能来回切换比较；
   *    分析侧读的是 `chosenCondition(nodeId)`（按 id 现查），所以这里不用同步改别的字段。
   * opts.analyze 默认 true：选定即用这套条件跑一次深入分析。
   */
  function chooseCondition(
    nodeId: string,
    optionId: string | null,
    opts: { analyze?: boolean } = {}
  ): void {
    const rec = analysisOf(nodeId);
    if (!rec) return;
    if (optionId === null) {
      rec.chosenConditionId = undefined;
    } else {
      const exists = rec.condOptions?.data?.options.some((o) => o.id === optionId);
      if (!exists) return;
      rec.chosenConditionId = optionId;
    }
    schedulePersist();
    if (opts.analyze !== false) void analyzeStep(nodeId, { force: true });
  }

  function cancelConditions(nodeId: string): void {
    const ak = `cond:${nodeId}`;
    analysisAborts.get(ak)?.abort();
    analysisAborts.delete(ak);
    const c = analysisOf(nodeId)?.condOptions;
    if (c && c.status === 'streaming') {
      c.status = 'failed';
      c.error = '已手动停止';
    }
  }

  /**
   * 对「该节点这一步反应」追问一个问题 —— **携带上下文**。
   *
   * 带过去的东西：产物 / 前体 / 路线上下文 / 已生成的结构化分析 / 本份分析上的历史问答。
   * 结果追加到 `analysis.followups`（随会话落盘）⇒ 刷新后问答还在。
   *
   * 🔴 与首轮分析的区别：追问要的是**自由文本**回答（后端已显式关掉 json 模式），
   *    所以这里不抽 JSON，直接累积文本。
   * 🔴 写回必须走**响应式代理**：用 `find()` 从响应式数组里取当前那条再改；
   *    抓着 push 时的裸对象引用改，Vue 收不到更新（界面会一直空着）。
   */
  async function askFollowup(nodeId: string, question: string): Promise<void> {
    const node = nodes.value[nodeId];
    const rid = node?.chosenReactionId;
    if (!node || !rid) return;
    const rxn = node.candidates.find((r) => r.id === rid);
    const rec = node.analyses?.[rid];
    const q = question.trim();
    if (!rxn || !rec || !q) return;
    if (rec.followups?.some((f) => f.status === 'streaming')) return; // 一次只跑一条

    if (!rec.followups) rec.followups = [];
    const items = rec.followups;
    // 只留最近 MAX_FOLLOWUPS 条：追问会累积，不设上限 localStorage 迟早爆
    if (items.length >= MAX_FOLLOWUPS) items.splice(0, items.length - MAX_FOLLOWUPS + 1);
    const myId = uid('fu');
    items.push({ id: myId, q, a: '', status: 'streaming', at: Date.now() });

    /** 每次都重新从响应式数组里取 —— 数组可能刚被 trim 过，别缓存下标 */
    const cur = (): StepFollowup | undefined =>
      node.analyses?.[rid]?.followups?.find((f) => f.id === myId);

    const ak = `fu:${nodeId}`;
    analysisAborts.get(ak)?.abort();
    const controller = new AbortController();
    analysisAborts.set(ak, controller);

    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const f of items) {
      if (f.id === myId) continue;
      if (f.status !== 'done' || !f.a) continue;
      history.push({ role: 'user', content: f.q });
      history.push({ role: 'assistant', content: f.a });
    }

    const req: FollowupRequest = {
      product: node.smiles,
      precursors: rxn.precursorList,
      probability: rxn.probability,
      model: params.value.model,
      context: routeContext(nodeId),
      analysis: rec.data ?? null,
      history,
      question: q
    };

    try {
      await streamFollowup(
        req,
        {
          onDelta: (t) => {
            const c = cur();
            if (c) c.a += t;
          },
          onDone: (p) => {
            const c = cur();
            if (c) {
              c.a = p.text || c.a;
              c.status = 'done';
            }
          },
          onError: (m) => {
            const c = cur();
            if (c) {
              c.status = 'failed';
              c.error = m;
            }
          }
        },
        controller.signal
      );
    } finally {
      // abort 时既走不到 done 也走不到 error ⇒ 这里收尾，别永远停在「回答中」
      const c = cur();
      if (c && c.status === 'streaming') {
        c.status = 'failed';
        c.error = c.error || '追问已中断';
      }
      analysisAborts.delete(ak);
      schedulePersist();
    }
  }

  /** 停止正在流式的那条追问 */
  function cancelFollowup(nodeId: string): void {
    const ak = `fu:${nodeId}`;
    analysisAborts.get(ak)?.abort();
    analysisAborts.delete(ak);
  }

  /**
   * 提交一条「预测 vs 实测」错误反馈：用户做实验后发现预测与实际偏差较大，
   * 把差异记录下来。后端落盘到 feedback.jsonl，供后续微调/蒸馏训练。
   *
   * 🔴 与 AI 分析解耦：反馈只是「记录」，不触发新的模型调用，也不影响已生成的分析。
   *    即使后端大模型没配置，反馈也能提交（后端 /api/feedback 不依赖 llm 模块）。
   */
  async function submitFeedback(nodeId: string, entry: Omit<FeedbackEntry, 'product' | 'precursors' | 'reaction_id' | 'model'>): Promise<boolean> {
    const node = nodes.value[nodeId];
    if (!node) return false;
    const rid = node.chosenReactionId;
    const rxn = rid ? node.candidates.find((r) => r.id === rid) : undefined;
    const payload: FeedbackEntry = {
      ...entry,
      product: node.smiles,
      precursors: rxn?.precursorList ?? [],
      reaction_id: rid ?? undefined,
      model: llmStatus.value?.model
    };
    const res = await llmApi.submitFeedback(payload);
    return !!res?.ok;
  }

  /** 把所有节点的 AI 分析一次性生成（沿当前路线的每一步） */
  async function analyzeRoute(): Promise<void> {    const steps = route.value;
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
    analysisModules,
    models,
    modelsLoading,
    modelLoadingKey,
    activeNodeId,
    jobProgress,
    autoRunning,
    autoProgress,
    globalError,
    errorRetry,
    retryError,
    clearGlobalError,
    history,
    sessions,
    currentSessionId,
    editingSessionId,
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
    // —— 路线网络（已确认的多步路线；一条任务下可以有多个） ——
    routeNetworks,
    networkStats,
    confirmedNetworkCount,
    confirmRouteNetwork,
    confirmScheme,
    unconfirmRouteNetwork,
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
    condPlanFirst,
    condOptionCount,
    chosenCondition,
    analyzeConditions,
    chooseCondition,
    cancelConditions,
    askFollowup,
    cancelFollowup,
    submitFeedback,
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
