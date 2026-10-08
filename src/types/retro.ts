/** 逆合成模型服务（Flask）与工作台数据模型 */

// ---------- 服务接口 ----------

/**
 * 单个模型的可用状态。
 *
 * 🔴 后端 `/api/models` 现在**按模型**报状态，不再是「一个全局布尔」：
 *    从前所有模型共用 `loaded`，两个模型都显示「已加载」，实际只有一个真的加载了，
 *    另一个一预测就失败。现在没加载的就是 `idle`，点一下才后启动。
 */
export type ModelState = 'ready' | 'loading' | 'failed' | 'idle' | 'unavailable';

export interface RetroModel {
  key: string;
  label: string;
  /** 模型文件在不在（`false` ⇒ state 必为 `unavailable`） */
  exists: boolean;
  /** 该模型此刻的真实状态 */
  state: ModelState;
  /** 是不是模型服务当前加载的那一个 */
  is_current: boolean;
  /** 模型目录体积（字节；`exists=false` 时为 0） */
  size_bytes?: number;
  path?: string;
}

/**
 * 模型服务（独立常驻进程 :8001）的概览。
 *
 * 🔴 它和 API 服务（:8000）是**两个进程**：API 秒起，模型在它后面慢慢加载。
 *    所以「API 起来了」不等于「模型能用了」—— 这个对象就是那道区分。
 */
export interface ModelServiceInfo {
  /** HTTP 通 = true。只读 state 文件时为 false（加载早期就是这种） */
  running: boolean;
  /** `stopped | idle | loading | ready | failed` */
  state: string;
  pid?: number | null;
  port?: number;
  /** 人话，直接可展示：「导入推理依赖…」 */
  phase?: string;
  error?: string;
  /** 加载已耗时（秒） */
  elapsed?: number | null;
  /** 上次加载完成耗时（秒） */
  load_seconds?: number | null;
  /** 状态是怎么读到的：http（权威）/ file（加载早期）/ none */
  source?: 'http' | 'file' | 'none' | string;
}

/**
 * 正向模型（「可行性过滤」的判据）。
 *
 * 🔴 它**不是**搜索主模型，所以不在 `models` 数组里 —— 否则会被渲染成一格可选的
 *    "预测模型"，而选中它去跑逆合成必然失败。后端把它单独放在 `forward` 字段。
 *
 * 状态取值与 `ModelState` 同构（unavailable / idle / loading / ready / failed）。
 */
export interface ForwardModelInfo {
  key: string;
  label: string;
  exists: boolean;
  state: ModelState;
  size_bytes?: number;
  path?: string;
  /** 加载失败原因（`state === 'failed'` 时有意义） */
  error?: string;
  /** 上次加载完成耗时（秒） */
  load_seconds?: number | null;
}

export interface ModelsResponse {
  ok: boolean;
  models: RetroModel[];
  /** 模型服务概览（老后端没有这个字段 ⇒ 可选） */
  service?: ModelServiceInfo;
  /** 模型服务当前加载的模型 key（没加载为空串） */
  current?: string;
  /**
   * 正向模型（可行性过滤用）。老后端 / 没配这个模型时为 `null` 或缺失。
   * 前端必须容忍缺失 —— 升级前端后没重启后端是常态。
   */
  forward?: ForwardModelInfo | null;
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

/** 结构解析结果：成功 / 失败二选一（前端 RDKit 与后端 /api/parse 形状一致） */
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

/** 后端 search 任务返回的一条合成路线（Retro* 一次搜到底的结果） */
export interface SearchRouteStep {
  product: string;
  reactants: string[];
  reactants_joined: string;
  probability: number | null;
}

export interface SearchRoute {
  steps: SearchRouteStep[];
  num_steps: number;
  total_probability: number | null;
  material_count: number;
}

/** kind=search 的 job 成功结果 */
export interface SearchOk {
  ok: true;
  target: string;
  routes: SearchRoute[];
  starting_materials: string[];
  purchasable: string[];
  required_materials: string[];
  filtered_out: number;
  value_fn: string;
  /**
   * 本次搜索是否开了「可行性过滤」。
   *
   * 🔴 必须由后端回传、不能拿「用户在界面上勾了」反推：任务可能是恢复出来的、
   *    或在勾选被改掉之后才返回结果 —— 那时用界面当前值标注历史结果就是错的。
   */
  forward_filter?: boolean;
  /** 开过滤时用的 top-k（没开为 null） */
  forward_top_k?: number | null;
  /**
   * 过滤通过率：候选反应里通过正向校验的比例（没开为 null）。
   *
   * 它是把「过滤真的在起作用」和「过滤器把一切都放行了（等于没开）」区分开的
   * 唯一信号 —— 只比较路线条数看不出来。
   */
  acceptance_rate?: number | null;
  stats: {
    or_nodes: number;
    and_nodes: number;
    expansions: number;
    max_heavy_atoms: number;
  };
  search_seconds: number;
}

/**
 * `POST /api/load`（加载 / 切换模型）的返回。
 *
 * 🔴 它表示「**已经开始加载**」，不是「已经就绪」——加载要 40~90 秒，
 *    让 HTTP 挂在那儿等，前端只看到一个转圈，也分不清是卡死还是在正常加载。
 *    拿到这个返回后应当继续轮询 `/api/models`，直到该模型 `state === 'ready'`。
 */
export interface LoadModelOk {
  ok: boolean;
  /** 实际开始加载的模型 key（不传时由后端按 RETRO_PRELOAD / 第一个可用的补上） */
  model?: string;
  /** true = 已受理，加载在后台进行 */
  started?: boolean;
  /** true = 本来就是这个模型，没有重启进程 */
  already?: boolean;
  /** true = 停掉了旧模型、拉起了新进程（换模型 = 重启模型服务） */
  restarted?: boolean;
  /** 受理后的模型服务状态快照 */
  service?: ModelServiceInfo;
  error?: string;
}

/** `POST /api/model-service/<action>` 的返回（start / stop / restart） */
export interface ModelServiceActionOk {
  ok: boolean;
  action?: string;
  model?: string;
  service?: ModelServiceInfo | { ok?: boolean; stopped?: boolean; forced?: boolean };
  error?: string;
}

/**
 * `POST /api/forward/load`（加载正向模型）的返回。
 *
 * 语义与 `LoadModelOk` 一致：**已受理**，不是"已就绪"。
 * 🔴 但它**不需要重启模型服务**（正向模型是纯 transformer，构造时不 spawn 规则
 *    子进程 ⇒ 可热挂），所以没有 `restarted` 字段，也不会把逆向模型踢掉。
 */
export interface LoadForwardOk {
  ok: boolean;
  /** 实际开始加载的正向模型 key */
  key?: string;
  /** true = 已受理，加载在后台进行 */
  started?: boolean;
  /** true = 本来就在加载 / 已就绪同一个，没有重复加载 */
  already?: boolean;
  /** 受理那一刻的状态 */
  state?: ModelState;
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
  /** 仅 succeeded 时存在：predict 与 search 两种 job 的结构不同 */
  result?: PredictOk | SearchOk;
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
  /** 极性相关确定性数值（点板/过柱模块的输入，后端 RDKit 算） */
  logp?: number | null;
  tpsa?: number | null;
  hbd?: number;
  hba?: number;
  rotatable?: number;
  aromatic_rings?: number;
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

/** 机理里的一个基元步骤（电子转移 + 成断键） */
export interface MechanismStep {
  seq?: number;
  step?: string;
  detail?: string;
}

/** 机理里的中间体 / 过渡态 */
export interface MechanismIntermediate {
  name?: string;
  note?: string;
}

/**
 * 反应机理 —— 逐步电子转移。
 *
 * 🔴 刻意不做「只给一个机理名」的字段：光写「SN2」三个字没有任何决策价值，
 *    真正要回答的是「电子怎么走、中间体是什么、哪一步慢、选择性从哪来」。
 *    后端 prompt 里也写死了这条（硬性要求 7），并要求机理与投料顺序自洽。
 */
export interface StepMechanism {
  /** 机理类型，如 亲核加成-消除（经四面体中间体） */
  type?: string;
  steps?: MechanismStep[];
  intermediates?: MechanismIntermediate[];
  /** 决速步是哪一步、依据 */
  rate_determining?: string;
  /** 区域 / 立体 / 化学选择性的来源 */
  selectivity?: string;
  /** 支持该机理的实验判据（KIE、动力学级数、中间体捕获…） */
  evidence?: string[];
}

/**
 * 后处理分析 —— 从反应结束到拿到纯品之间的每一步操作。
 *
 * 与 `conditions.workup` 的分工：后者是**一句话概览**，这里要**能照着做**的逐步细节。
 */
export interface StepWorkup {
  /** 淬灭：加入什么、温度、放热与产气风险 */
  quench?: string;
  /** 萃取 / 分液：溶剂、次数、水相 pH 如何调节 */
  extraction?: string;
  /** 洗涤：水 / 饱和食盐水 / 稀酸 / 稀碱各几次、分别去除什么 */
  wash?: string;
  /** 干燥：干燥剂种类与用量 */
  dry?: string;
  /** 浓缩：温度与压力、是否需要共沸带水 */
  concentration?: string;
  /** 纯化：重结晶 / 柱层析 / 蒸馏 / 打浆 */
  purification?: string;
  /** 预计回收率与纯度提升 */
  recovery?: string;
  /** 放大注意点（乳化、放热、相分离、过滤堵塞…） */
  notes?: string[];
}

/**
 * 点板 / 过柱极性预测 —— TLC 点板的 Rf 估算与柱层析洗脱剂系统建议。
 *
 * 🔴 logP / TPSA / 氢键供受体等**确定性数值**由后端 RDKit 算好（见 `computed`），
 *    模型只做解读（估 Rf、给洗脱剂梯度），不在 JSON 里另造数值。
 */
export interface StepTlc {
  /** 产物在硅胶板上的估算 Rf 范围 + 展开剂，如 "0.3~0.5（PE:EA=4:1）" */
  rf_est?: string;
  /** 柱层析洗脱剂系统与梯度（体积比），如 "PE 冲低极性杂质 → PE:EA=10:1→4:1" */
  eluent?: string;
  /** 产物与各前体/杂质的极性从低到高排序及依据 */
  polarity_order?: string;
  /** 点板判据：怎么判断反应完成、怎么区分产物点与前体残留 */
  spotting?: string;
  /** 过柱注意点（拖尾 / 是否加酸加碱改性 / 吸附损失 / Rf 过高过低处理） */
  note?: string;
}

/** 大模型返回的结构化工艺分析（字段全部可选 —— 模型可能缺项，缺了就不渲染） */
export interface StepAnalysisData {
  summary?: string;
  reaction_type?: string;
  mechanism?: StepMechanism;
  order?: DoseRow[];
  conditions?: Record<string, string>;
  /** 后处理分析（勾选该模块时才有） */
  workup?: StepWorkup;
  /** 点板 / 过柱极性预测（勾选该模块时才有） */
  tlc?: StepTlc;
  outcome?: { expected?: string; yield_range?: string; purity?: string; risk?: string };
  byproducts?: SideProduct[];
  lcms?: { mz_theoretical?: string; adduct?: string; note?: string };
  nmr?: { h1?: string; c13?: string; note?: string };
  safety?: string[];
  confidence?: number;
}

export type AnalysisStatus = 'idle' | 'streaming' | 'done' | 'failed';

/**
 * 一次「追问」的问答 —— 挂在那份工艺分析上（随会话一起落盘）。
 *
 * 追问是**带上下文**的：后端会把这步反应的产物/前体/路线上下文 + 已生成的分析 +
 * 下面的历史问答一起发给模型，所以模型能接着前文答，而不是每次从零开始。
 */
export interface StepFollowup {
  id: string;
  /** 用户问的 */
  q: string;
  /** 模型答的（流式期间不断变长） */
  a: string;
  status: 'streaming' | 'done' | 'failed';
  error?: string;
  at: number;
}

/**
 * 一套**候选反应条件方案** —— 由 `/api/llm/conditions/stream` 枚举出来，供用户挑一套。
 *
 * 反应条件（溶剂 / 温度 / 碱与缩合剂 / 浓度 / 投料方式）本就是一个组合空间，
 * 一次只给一套等于把模型的第一直觉当成唯一答案。先枚举、再选定，使用者才能比较取舍；
 * 选定后深入分析会把这套条件**锁定**回模型（见 AnalyzeRequest.chosen_condition）。
 *
 * 字段名与后端 CONDITIONS_SYSTEM 的 JSON 结构一一对应，全部可选（模型可能漏字段）。
 */
export interface ConditionOption {
  /** 方案编号 A / B / C…（同一份枚举内唯一），前端选中它回传给分析 */
  id: string;
  /** 简短方案名，如「低温慢加 · DCM 体系」 */
  name: string;
  /** 设计取向，如 温和优先 / 高产率优先 / 低成本易放大 / 绿色低毒 */
  strategy?: string;
  solvent?: string;
  temperature?: string;
  time?: string;
  atmosphere?: string;
  /** 催化剂 / 碱 / 缩合剂 / 配体及当量 */
  catalyst?: string;
  /** 关键试剂当量与相对基准 */
  equiv?: string;
  concentration?: string;
  /** 后处理一句话概览 */
  workup?: string;
  pros?: string[];
  cons?: string[];
  /** 这套方案最可能出的问题与放大风险 */
  risk?: string;
  /** 什么情况下该选它 */
  best_for?: string;
  confidence?: number;
}

/** 一次候选条件枚举的结果（模型原始输出抽成 JSON 后归一化） */
export interface ConditionsResult {
  reaction_type?: string;
  /** 这一步为什么会有多套条件：最关键的变量 */
  key_variable?: string;
  options: ConditionOption[];
  /** 在什么前提下推荐哪一套 */
  recommendation?: string;
  /** 安全底线提示：条件为模型推断，实验前必须由专业人员复核 */
  note?: string;
}

/** 一次候选条件枚举的运行态（与 StepAnalysis 同构，前端复用同一套流式解析） */
export interface StepConditions {
  status: 'streaming' | 'done' | 'failed';
  raw: string;
  reasoning?: string;
  data?: ConditionsResult | null;
  computed?: MassInfo | null;
  model?: string;
  error?: string;
  at?: number;
  elapsed?: number;
}

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
  /** 这份分析上的追问记录（最新在后） */
  followups?: StepFollowup[];
  /** 候选反应条件枚举（可选：先枚举再深入分析的流程才有） */
  condOptions?: StepConditions | null;
  /** 用户选定的候选条件 id（选了之后深入分析会锁定这套条件） */
  chosenConditionId?: string;
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
  /** 接着分析：上次被截断时已收到的正文原文，作为 assistant 前缀续写 */
  continue_from?: string;
  /** 勾选的分析模块（['mechanism','order','lcms',...]）；缺省/空 = 全量分析 */
  modules?: string[];
  /**
   * 用户从候选条件里选定的那一套：给了就把整套条件写进 prompt 并**锁定** ——
   * `conditions` 字段必须沿用它，投料顺序 / 后处理 / 机理都要和它自洽。
   */
  chosen_condition?: ConditionOption | null;
}

/** 发起一次「候选反应条件枚举」的请求体（上下文与 AnalyzeRequest 完全一致） */
export interface ConditionsRequest {
  product: string;
  precursors: string[];
  probability?: number;
  model?: string;
  context?: AnalyzeRequest['context'];
  /** 想要几套方案（后端夹到 2~6，默认 4） */
  count?: number;
}

/** 发起一次「追问」的请求体 —— 带着这一步反应的上下文，问它的其他问题 */
export interface FollowupRequest {
  product: string;
  precursors: string[];
  probability?: number;
  model?: string;
  /** 与首轮分析同一份路线上下文 */
  context?: AnalyzeRequest['context'];
  /** 已生成的结构化分析：让模型与前文保持一致，不与首轮分析自相矛盾 */
  analysis?: StepAnalysisData | null;
  /** 历史问答（user / assistant 交替），后端只取最近若干条 */
  history?: { role: 'user' | 'assistant'; content: string }[];
  question: string;
}

/**
 * 一条「错误反馈」—— 用户做实验后发现预测与实际偏差较大，把「预测值 vs 实测值」记下来。
 * 后端落盘到 feedback.jsonl，后续可用来微调 / 蒸馏，让模型的点板、收率、条件等预测越用越准。
 */
export interface FeedbackEntry {
  /** 反馈类型：tlc（点板/过柱）/ yield（收率）/ condition（条件）… */
  kind?: string;
  /** 目标分子（整条路线上下文，可选） */
  target?: string;
  /** 这一步产物 SMILES */
  product?: string;
  /** 前体 SMILES */
  precursors?: string[];
  /** 这一步反应 id（前端确定性 reactionId） */
  reaction_id?: string;
  /** 预测用的模型名 */
  model?: string;
  /** 预测内容（Rf 范围 / 洗脱剂 / 收率…） */
  predicted?: string;
  /** 实测结果（用户实验后填的） */
  observed?: string;
  /** 用户对「差异多大、为什么差」的自由描述 */
  delta_note?: string;
  /** 对应哪个分析模块（tlc/outcome/conditions…） */
  module?: string;
}

export interface FeedbackList {
  ok: boolean;
  count: number;
  items: FeedbackEntry[];
  error?: string;
}

/** 可勾选的分析模块 key（与后端 _MODULE_FIELDS 对齐） */
export type AnalysisModuleKey =
  | 'summary'
  | 'mechanism'
  | 'order'
  | 'conditions'
  | 'workup'
  | 'outcome'
  | 'byproducts'
  | 'lcms'
  | 'nmr'
  | 'tlc'
  | 'safety';

export interface LlmStatus {
  ok: boolean;
  configured: boolean;
  /** 当前激活的端点配置（多套配置并存时，用来辨认「现在用的是哪一套」） */
  profile_id?: string;
  profile_name?: string;
  base_url?: string;
  model?: string;
  has_key?: boolean;
  json_mode?: boolean;
  /** key 池状态（脱敏）：多 Key 自动轮换的可视化 */
  keys?: LlmKeyState[];
  max_tokens?: number;
  hint?: string;
  /** 仅当请求带 probe=1 时返回：真发一次最小请求的验证结果 */
  probe?: LlmProbe;
}

/** /api/llm/status?probe=1 —— 真验证 key + 模型是否可用 */
export interface LlmProbe {
  ok: boolean;
  verified: boolean;
  /** 验的是哪一套端点配置 */
  profile_id?: string;
  profile_name?: string;
  model?: string;
  base_url?: string;
  /** 本次验证实际使用的 key（脱敏）；多 key 池里可能不是第一个 */
  key?: string;
  error?: string;
}

/** key 池里单个 key 的状态（设置面板展示用） */
export interface LlmKeyState {
  /** 脱敏串：sk-L7w15****ab3f。回传保存时含 `*` = 保留原 key */
  masked: string;
  /** active=使用中 / cooldown=限流冷却（自动恢复）/ bad=失效 / idle=备用 */
  state: 'active' | 'cooldown' | 'bad' | 'idle';
  /** 失效/冷却原因（错误摘要） */
  reason?: string;
  /**
   * 这把 key 从哪来：
   * - `profile` = 存在这套配置里（可删）；
   * - `env` = 后端 `.env` 的**回落默认值**（运行时会用，但面板删不掉它 ——
   *   不标出来就会出现「删了还在」的假按钮）。
   * 老后端不返回该字段 ⇒ 按 `profile` 处理。
   */
  source?: 'profile' | 'env';
}

/**
 * 一套「端点配置」：接口地址 + 模型 + 一组 Key **绑定**在一起。
 *
 * 为什么绑成一套：三者互相依赖 —— MiMo 的 key 配 DeepSeek 的地址、或 DeepSeek 的地址
 * 配 MiMo 的模型名，都是无效组合。分开存的时候，换供应商要挨个改三处，改漏一处就得到
 * 一个「看着配好了、一调就 401/404」的状态。现在切换只动一个 id。
 */
export interface LlmProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  max_tokens: number;
  temperature: number;
  timeout: number;
  json_mode: boolean;
  /** 备注（可选，纯展示） */
  note?: string;
  /** 这套自己的 key 池状态（脱敏）—— 每套一张表，互不干扰 */
  keys: LlmKeyState[];
  /** 是否是当前激活的那套 */
  active: boolean;
}

/** GET /api/llm/settings —— 全部端点配置 + 当前激活那套的展开字段 */
export interface LlmSettings {
  ok: boolean;
  active_profile: string;
  profiles: LlmProfile[];
  /** 以下扁平字段 = 当前激活配置的展开（兼容「只关心当前配置」的旧用法） */
  base_url: string;
  model: string;
  max_tokens: number;
  temperature: number;
  timeout: number;
  json_mode: boolean;
  keys: LlmKeyState[];
  active_index: number;
  error?: string;
}

/** 提交一套端点配置：api_keys 元素含 `*` = 保留**该套**原 key，明文 = 新增 */
export interface LlmProfilePayload {
  id: string;
  name: string;
  base_url: string;
  model: string;
  max_tokens?: number;
  temperature?: number;
  timeout?: number;
  json_mode?: boolean;
  note?: string;
  api_keys?: string[];
}

/** POST /api/llm/settings —— 整包提交（新建 / 修改 / 删除都走它） */
export interface LlmSettingsPayload {
  profiles?: LlmProfilePayload[];
  active_profile?: string;
  /** 兼容形态：只改当前激活配置的这几个扁平字段 */
  base_url?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  timeout?: number;
  json_mode?: boolean;
  api_keys?: string[];
}

/**
 * 「拉模型列表」时指向哪一套配置：
 * 给 `id` = 已保存的那套；给 `base_url` + `api_keys` = 还没保存的草稿
 * （新建端点时要先看看有哪些模型可选，否则只能盲填模型名）。
 */
export interface LlmProfileRef {
  id?: string;
  base_url?: string;
  model?: string;
  api_keys?: string[];
}

/** /api/llm/models —— 该 key 在 /v1/models 里能看到的模型（不等于套餐内可用） */
export interface LlmModels {
  ok: boolean;
  models: string[];
  current?: string;
  error?: string;
  /** 拉到列表用的是哪把 key（脱敏串）。这套配了多把 key 时才有意义 */
  key?: string;
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

/** SSE 事件（/api/llm/conditions/stream）—— 与 AnalyzeStreamEvent 同构，只有 done 负载不同 */
export type ConditionsStreamEvent =
  | { type: 'meta'; model: string; computed: MassInfo }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end'; chars: number }
  | { type: 'delta'; text: string }
  | {
      type: 'done';
      data: ConditionsResult | null;
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
  /**
   * 已确认为一条**路线网络**（= 真正采用的路线）。
   *
   * 为什么要有这个标记：同一目标下通常会存好几条路线做备选对比，
   * 但「存下来比一比」和「这条就是我们采用的」是两件事 ——
   * 前者是草稿，后者才是交付物。已确认的网络可以有多个
   * （例如「实验室小试」与「放大路线」各一条），确认入口在逆合成树里。
   * 缺省（老数据 / 仅保存未确认）视为未确认。
   */
  confirmed?: boolean;
  /** 最近一次确认的时间（列表排序用） */
  confirmedAt?: number;
}

/**
 * 一条候选反应的**来源**。
 *
 * - `model`（缺省） = 单步预测模型给出的；
 * - `manual` = 用户在「编辑这一步」里手工指定的前体组合。
 */
export type ReactionOrigin = 'model' | 'manual';

/** 一次单步预测的一个候选反应 */
export interface Reaction {
  id: string;
  productNodeId: string;
  rank: number;
  /**
   * 这一步的模型置信概率。
   *
   * 🔴 `null` = **用户手动指定的这一步**（见 `origin`），不是"概率为 0"。
   *    手动步没有模型意见：塞 0 会让整条路线的概率连乘归零（界面显示"总概率 0%"），
   *    塞 1 又是在撒谎。所以类型放宽成 union，由展示层显式说明
   *    「含手动步骤、概率不可比」（`stores/workspace.ts` 的 `manualSteps`）。
   */
  probability: number | null;
  level: ProbLevel;
  /** "A.B" */
  precursors: string;
  precursorList: string[];
  numMolecules: number;
  childNodeIds: string[];
  /**
   * 这条候选是谁给的。
   *
   * 🔴 必须显式区分，不能靠「概率是不是 null」反推：后端 search 路径
   *    （`applySearchRoutes`）也会给出 `probability: 0`，那是**模型给了但很低**，
   *    与「用户手写、模型根本没表态」是两件事。
   */
  origin?: ReactionOrigin;
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
  /**
   * 「可行性过滤」：用正向模型当判据，把「前体 → 产物」走不通的候选反应扔掉。
   *
   * 🔴 **只在多步拆分（kind=search）时生效** —— 手动单步「展开」走的是 `/api/predict`，
   *    不经过搜索，也就没有"过滤搜索分支"这回事。开启前必须先加载正向模型。
   */
  forwardFilter: boolean;
  /** 正向模型保留的 top-k（越小过滤越狠；后端夹到 1~50） */
  forwardTopK: number;
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
  /**
   * 这一步的概率。
   *
   * 🔴 手动步（`manual: true`）在这里记为 **1** —— `RouteStep` 是给展示/导出用的派生
   *    结构，连乘时把"没有模型意见"当作不惩罚；否则一个与模型无关的 0 会把整条路线的
   *    总概率拉平。要判断「这条路线含手工步骤」请读 `manual`（统计口径见
   *    `SchemeStat.manualSteps`），**不要**拿 `probability` 反推。
   */
  probability: number;
  /** 用户手工指定的步骤（源 `Reaction.probability === null`）⇒ 展示层显示「手动」而非百分比 */
  manual?: boolean;
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
  /**
   * **内容**最后变化的时间 —— 侧栏排序就用它。
   *
   * 🔴 不要拿「最近打开过」当排序依据：那会让「点一下某个旧任务看一眼」把它顶到列表
   *    第一位，用户正要找的邻居全被挤走。所以只有**真的动了内容**（跑分析 / 采纳分支 /
   *    改参数 / 出结果）才刷新它；单纯打开、恢复、切回来都不算。
   *    判据见 `sessionSignature()`：签名没变就不刷新。
   */
  updatedAt: number;
  snapshot: WorkspaceSnapshot;
  /**
   * 内容签名（落盘一起带走）。
   * 打开旧任务后 store 会立即回写一次快照（触发保存的 watcher 挡不住），
   * 没有这个签名的话每次打开都会刷新 `updatedAt` ⇒ 列表跳位。
   * 缺省（老数据 / 新建）时**只登记不刷新时间**。
   */
  sig?: string;
}
