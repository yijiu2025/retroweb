/** 逆合成模型服务（Flask）与工作台数据模型 */

// ---------- 服务接口 ----------

export interface RetroModel {
  key: string;
  label: string;
  loaded: boolean;
}

export interface ModelsResponse {
  ok: boolean;
  models: RetroModel[];
}

/** /api/parse 成功 */
export interface ParseSuccess {
  ok: true;
  smiles: string;
  kind: string;
  atoms: number;
  formula: string;
  mw: number | null;
  error: string;
}

/** /api/parse 失败（带人话诊断 + 一键修复候选） */
export interface ParseFailure {
  ok: false;
  kind?: string;
  error?: string;
  reasons?: string[];
  is_markush?: boolean;
  suggestions?: ParseSuggestion[];
}

export interface ParseSuggestion {
  label: string;
  smiles: string;
  valid: boolean;
  canonical: string;
}

/** /api/depict 响应：画板载入用，RDKit 算好 2D 坐标的 molfile */
export interface DepictResponse {
  ok: boolean;
  molfile?: string;
  smiles?: string;
  error?: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

export type ProbLevel = 'high' | 'mid' | 'low';

/** 一次 /api/predict 的一个候选反应 */
export interface PredictCandidate {
  rank: number;
  /** 前体（反应物侧）SMILES，多组分用 `.` 连接 */
  precursors: string;
  /** 拆分后的前体分子列表（用于建树，不含产物） */
  precursor_list: string[];
  /** 完整反应 SMILES：`reactants>>product`（后端解析前体用） */
  reaction?: string;
  /** 该候选反应的产物侧（应等于当前节点的分子） */
  product?: string;
  probability: number;
  num_molecules: number;
  level: ProbLevel;
}

export interface PredictOk {
  ok: true;
  product: string;
  model: string;
  results: PredictCandidate[];
  load_seconds?: number;
  infer_seconds: number;
}

export interface PredictErr {
  ok: false;
  error?: string;
  reasons?: string[];
  suggestions?: ParseSuggestion[];
}

export type PredictResult = PredictOk | PredictErr;

export interface LoadModelOk {
  ok: boolean;
  seconds?: number;
  error?: string;
}

// ---------- 后台任务（jobhub） ----------
// 把「同步长任务」改造成可查询、可取消、带阶段时间线与实时日志的 job。
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobStageState = 'running' | 'done' | 'skipped' | 'failed';

export interface JobStage {
  key: string;
  label: string;
  detail: string;
  state: JobStageState;
  /** 当前阶段内部子进度（0~1），用于展示「规则子进程就绪 3/4」之类 */
  sub: number;
  seconds: number;
  weight: number;
}

export interface JobLog {
  seq: number;
  /** 相对任务开始的时间（秒） */
  t: number;
  level: 'info' | 'stage' | 'warn' | 'error';
  text: string;
}

export interface JobSnapshot {
  ok: boolean;
  job_id: string;
  kind: string;
  state: JobState;
  /** 0~1 估算总进度 */
  progress: number;
  /** 当前阶段 label */
  current: string;
  current_detail: string;
  elapsed: number;
  queued_for: number;
  cancelable: boolean;
  stages: JobStage[];
  logs: JobLog[];
  log_seq: number;
  /** 仅 succeeded 时存在：与 PredictOk 同结构 */
  result?: PredictOk;
  /** 仅 failed/cancelled 时存在 */
  error?: string;
  error_reasons?: string[];
  error_payload?: PredictErr;
}

export interface JobCreateResponse {
  ok: boolean;
  job_id: string;
  error?: string;
}

/** 前端持有的「某节点正在跑的 job」快照（驱动进度面板渲染） */
export interface JobProgress {
  jobId: string;
  state: JobState;
  progress: number;
  current: string;
  currentDetail: string;
  cancelable: boolean;
  stages: JobStage[];
  logs: JobLog[];
  logSeq: number;
}

// ---------- 大模型「工艺分析」 ----------

/** RDKit 算出来的确定性质量信息（不交给大模型算） */
export interface MassRow {
  smiles: string;
  ok: boolean;
  error?: string;
  formula?: string;
  mw?: number;
  exact_mass?: number;
  mz_pos?: number;
  mz_neg?: number;
  mz_na?: number;
  heavy_atoms?: number;
}

export interface MassInfo {
  rows: MassRow[];
  by_smiles: Record<string, MassRow>;
}

/** 一步投料 */
export interface DoseRow {
  seq?: number;
  mode?: string;
  reagent?: string;
  equiv?: string;
  note?: string;
}

/** 可能的副产物 */
export interface SideProduct {
  name?: string;
  source?: string;
  mz?: string;
  control?: string;
}

/** 大模型返回的结构化工艺分析（字段全部可选 —— 模型可能缺项，缺了就不渲染） */
export interface StepAnalysisData {
  summary?: string;
  reaction_type?: string;
  order?: DoseRow[];
  conditions?: Record<string, string>;
  outcome?: { expected?: string; yield_range?: string; purity?: string; risk?: string };
  byproducts?: SideProduct[];
  lcms?: { mz_theoretical?: string; adduct?: string; note?: string };
  nmr?: { h1?: string; c13?: string; note?: string };
  safety?: string[];
  confidence?: number;
}

export type AnalysisStatus = 'idle' | 'streaming' | 'done' | 'failed';

/**
 * 一步反应的 AI 工艺分析（挂在节点上，按 reactionId 存 ⇒ 天然「结果保留」）。
 * `raw` 是模型原始输出（流式期间实时追加），`data` 是流结束后抽出来的结构化结果。
 */
export interface StepAnalysis {
  reactionId: string;
  status: AnalysisStatus;
  /** 模型原始输出（流式期间不断变长，可折叠查看） */
  raw: string;
  /** 推理模型的思考过程（`deepseek-v4-pro` 等）。与 `raw` 分开存，避免污染 JSON 抽取 */
  reasoning?: string;
  data?: StepAnalysisData | null;
  /** RDKit 确定性质量表（产物 + 前体） */
  computed?: MassInfo | null;
  error?: string;
  model?: string;
  at?: number;
  elapsed?: number;
}

/** 发起一次工艺分析的请求体 */
export interface AnalyzeRequest {
  product: string;
  precursors: string[];
  probability?: number;
  model?: string;
  context?: {
    target?: string;
    step_no?: number;
    prior_steps?: string[];
  };
}

export interface LlmStatus {
  ok: boolean;
  configured: boolean;
  base_url?: string;
  model?: string;
  has_key?: boolean;
  json_mode?: boolean;
  hint?: string;
  /** 仅当请求带 probe=1 时返回：真发一次最小请求的验证结果 */
  probe?: LlmProbe;
}

/** /api/llm/status?probe=1 —— 真验证 key + 模型是否可用 */
export interface LlmProbe {
  ok: boolean;
  verified: boolean;
  model?: string;
  base_url?: string;
  error?: string;
}

/** /api/llm/models —— 该 key 在 /v1/models 里能看到的模型（不等于套餐内可用） */
export interface LlmModels {
  ok: boolean;
  models: string[];
  current?: string;
  error?: string;
}

/** SSE 事件（/api/llm/analyze/stream） */
export type AnalyzeStreamEvent =
  | { type: 'meta'; model: string; computed: MassInfo }
  /** 推理模型的思考增量（`deepseek-v4-pro` 等会先吐一大段）—— 不显示的话界面像卡死 */
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end'; chars: number }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      data: StepAnalysisData | null;
      computed: MassInfo;
      raw: string;
      model: string;
      reasoning?: string;
      /** 'stop' = 正常结束；'length' = 被 max_tokens 截断 */
      finish_reason?: string;
    }
  | { type: 'error'; error: string };

// ---------- 工作台数据模型 ----------

export type MolRole = 'target' | 'intermediate' | 'starting';

export type MolStatus = 'idle' | 'loading' | 'expanded' | 'failed' | 'terminated';

/** 一行 = 一个化合物 */
export interface MolNode {
  id: string;
  smiles: string;
  role: MolRole;
  /** 第几步（缩进层级） */
  depth: number;
  status: MolStatus;
  formula?: string;
  mw?: number | null;
  atoms?: number;
  /** 由哪一步反应产生 */
  parentReactionId?: string | null;
  /** 根 → 该节点的概率连乘 */
  probabilityChain: number;
  /** 是否已拉过候选 */
  fetched: boolean;
  candidates: Reaction[];
  chosenReactionId?: string | null;
  /** 用户手动标记为可购买 → 终止 */
  purchased?: boolean;
  /** 折叠子树 */
  collapsed?: boolean;
  error?: string;
  /** 失败原因明细（后端给的「人话诊断」，用于展开失败时说清为什么） */
  errorReasons?: string[];
  /** 同分支上出现过相同 SMILES（防环） */
  duplicateOf?: string | null;
  /**
   * 该节点**复用了树上另一个相同分子**的已有分析结果（「相同中间体直接拿来用」）。
   * 存来源节点 id —— UI 显示「复用自 …」并可一键改为重新分析。
   */
  reusedFrom?: string | null;
  /**
   * 该节点的**历次分析结果**（每次「重新分析」追加一条，全部保留）。
   * 前端可来回切换查看/采纳，不会因为再跑一次就丢掉以前的候选。
   */
  runs?: AnalysisRun[];
  /** 当前展示的是哪一次分析（runs 里的 id） */
  activeRunId?: string | null;
  /**
   * 该节点产出的 **AI 工艺分析**，按 reactionId 键控
   * （一个节点换过几种前体组合就存几份，全都留着）。
   */
  analyses?: Record<string, StepAnalysis>;
  /** 子节点顺序 */
  children: string[];
  /**
   * 该节点被「摘下来」了（仍留在内存里，但不参与统计/渲染）。
   *
   * 🔴 为什么不是直接删掉：一条路线方案切换走时，别的方案还要用它建好的整棵子树。
   *    所以「撤销采纳 / 切换方案」只是把子树**摘下来藏起来**；当再次采纳同一个反应
   *    （reaction id 是确定性的）时，原样接回去 —— 已分析过的分子不用重跑模型。
   *    真正的删除只发生在用户显式点「删除」时（removeBranch）。
   */
  detached?: boolean;
}

/**
 * 一次单步分析的结果快照。
 *
 * 🔴 `Reaction.id` 是**确定性**的（由 nodeId + 前体组合哈希而来，见 stores/workspace.reactionIdFor），
 *    所以同一次分析的候选在多次运行间 id 稳定 ⇒ 切换 runs 时已采纳的选择不会丢。
 */
export interface AnalysisRun {
  id: string;
  at: number;
  model: string;
  numResults: number;
  inferSeconds?: number;
  candidates: Reaction[];
  /** 这一次分析里被采纳的候选（切回该次分析时恢复） */
  chosenReactionId?: string | null;
}

/**
 * 一条「路线方案」= 在整棵树上的一组选择（nodeId → 采纳的 reactionId）。
 *
 * 同一个起始原料（同一个目标分子）下可以存多条方案，随时切换显示 / 横向对比，
 * 这就是「切换显示同一个起始原料的多条路线」。
 */
export interface RouteScheme {
  id: string;
  name: string;
  createdAt: number;
  /** nodeId → reactionId；没有 entry 的节点表示该方案下不继续往下拆 */
  choices: Record<string, string>;
  note?: string;
}

/** 一次单步预测的一个候选反应 */
export interface Reaction {
  id: string;
  productNodeId: string;
  rank: number;
  probability: number;
  level: ProbLevel;
  /** "A.B" */
  precursors: string;
  precursorList: string[];
  numMolecules: number;
  childNodeIds: string[];
}

/** 运行参数 */
export interface RunParams {
  model: string;
  /** 每步取几个候选（1~20） */
  numResults: number;
  /** 自动拆分的最大深度 */
  maxDepth: number;
  /** 重原子数 ≤ 此值即视为可购买起始物料 */
  heavyAtomThreshold: number;
  /** 用户指定的起始物料（canonical SMILES 列表） */
  startingMaterials: string[];
  /** 自动拆分的调用预算（防跑飞） */
  budgetCalls: number;
}

/**
 * 路线步骤（由选定分支回溯生成）
 *
 * ⚠️ `step` 是**层级号**（depth+1），同层多个分支会拿到相同的 step，
 *    所以列表渲染必须用 `nodeId` 作 key —— 用 step 会在多分支时撞重复 key
 *    （Vue 会告警，且同一层的第二个分支可能渲染不出来）。
 */
export interface RouteStep {
  step: number;
  /** 同一层内的分支序号（从 1 起），仅用于展示区分 */
  branchNo: number;
  /** 产物节点 id —— 列表 key 与回溯定位都用它 */
  nodeId: string;
  product: string;
  productFormula?: string;
  precursors: string[];
  probability: number;
  model: string;
}

/** 历史任务快照 */
export interface HistoryTask {
  id: string;
  name: string;
  target: string;
  createdAt: number;
  params: RunParams;
  rootId: string;
  nodes: Record<string, MolNode>;
}

/**
 * 任务会话：一次逆合成工作（一个目标分子 + 它的整棵路线树）。
 * 持久化到 localStorage，刷新网页后能恢复「未完成 / 进行中」的任务。
 */
export type SessionStatus = 'running' | 'incomplete' | 'done';

/** 可序列化、可恢复的工作台快照 */
export interface WorkspaceSnapshot {
  rootId: string | null;
  nodes: Record<string, MolNode>;
  params: RunParams;
  activeNodeId: string | null;
  /** 每个正在跑分析的节点 → 它的后端 job_id（用于刷新后恢复轮询） */
  jobIds: Record<string, string>;
  /** 已保存的路线方案（同一目标分子的多条路线） */
  schemes?: RouteScheme[];
  currentSchemeId?: string | null;
}

export interface Session {
  id: string;
  name: string;
  target: string;
  model: string;
  status: SessionStatus;
  updatedAt: number;
  snapshot: WorkspaceSnapshot;
}
