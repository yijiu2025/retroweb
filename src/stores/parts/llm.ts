/**
 * 工作台 store 的「大模型工艺分析」零件。
 *
 * 装的是 AI 那一整层：配置状态、单步工艺分析（SSE 流式）、候选反应条件的
 * 枚举→选定→带条件深入分析、追问、错误反馈、一键分析全路线。
 *
 * 为什么单独成文件：这块 460 行与「路线树怎么长」毫无关系，它只**读**节点
 * （拿产物 / 前体 / 已采纳的反应）并把结果**挂回**节点，从不增删节点。
 * 从 3000 行的 store 里切出来，路线树那边的逻辑一行都不用动。
 *
 * 🔴 它拿到的 ctx 是**只读意图**的：`nodes` / `params` / `route` / `rootId` 只用来取数，
 *    唯一的写回通道是「改节点上的 analyses 字段」+ `ctx.schedulePersist()` 通知落盘。
 *    不要让这个零件反过来去动树的结构 —— 那说明东西放错了地方。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { ref, type Ref } from 'vue';
import {
  llmApi,
  streamAnalyze,
  streamConditions,
  streamFollowup
} from '@/api/retro';
import type {
  AnalysisModuleKey,
  AnalyzeRequest,
  ConditionOption,
  ConditionsRequest,
  FeedbackEntry,
  FollowupRequest,
  LlmStatus,
  MolNode,
  RouteStep,
  RunParams,
  StepAnalysis,
  StepConditions,
  StepFollowup
} from '@/types/retro';
import { uid } from '@/utils/smiles';
import { ALL_ANALYSIS_MODULES } from './shared';

/** 每个节点最多保留几份 AI 工艺分析 */
const MAX_ANALYSES = 6;
/** 每份工艺分析最多保留几条追问（追问会累积，不设上限 localStorage 迟早爆） */
const MAX_FOLLOWUPS = 10;

/** `route` 是 computed，用这个形状接，免得 Ref / ComputedRef 的协变问题 */
type ReadonlyBox<T> = { readonly value: T };

interface LlmPartCtx {
  nodes: Ref<Record<string, MolNode>>;
  rootId: Ref<string | null>;
  route: ReadonlyBox<RouteStep[]>;
  params: Ref<RunParams>;
  /** 一次枚举几套候选条件方案（后端夹到 2~6） */
  condOptionCount: Ref<number>;
  /** 通知主 store「有东西变了，该落盘了」（防抖） */
  schedulePersist: () => void;
}

/**
 * @returns LLM 状态分片（配置/分析/追问），供 `createWorkspaceStore` 组装
 */
function createLlmPart(ctx: LlmPartCtx) {
  const llmStatus = ref<LlmStatus | null>(null);
  /** AI 工艺分析勾选的模块（默认全选）。空数组 = 全量分析（与后端语义一致） */
  const analysisModules = ref<AnalysisModuleKey[]>([...ALL_ANALYSIS_MODULES]);
  /** 正在流式进行的分析 / 枚举 / 追问（key = nodeId 或 `cond:<id>` / `fu:<id>`） */
  const analysisAborts = new Map<string, AbortController>();
  /** 「一键分析全路线」是否在跑（按钮的 loading / 停止态） */
  const routeAnalyzing = ref(false);
  /**
   * 「一键分析全路线」的取消标志。
   *
   * 🔴 为什么不能只看 `analysisAborts` 里有没有 controller：那个 Map 是**共享**的，
   *    条件枚举 / 追问也往里放。取消批量分析时若只看"有没有 controller"，
   *    会把用户正在等的一条追问一起 abort 掉。
   *    所以批量循环用这个**自己的**标志作为"该不该继续下一步"的判据。
   */
  let routeCancelRequested = false;

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
    const node = ctx.nodes.value[nodeId];
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
    let cur: MolNode | undefined = ctx.nodes.value[nodeId];
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id);
      chain.unshift(cur);
      // 🔴 显式标注类型：cur 由下面那行的 find 赋值，而 find 的条件又用了 pid ⇒
      //    TS 无法自行推导（TS7022 循环引用），加注解打断这个环。
      const pid: string | null | undefined = cur.parentReactionId;
      if (!pid) break;
      cur = Object.values(ctx.nodes.value).find((n): boolean =>
        n.candidates.some((r): boolean => r.id === pid)
      );
    }
    const steps: string[] = [];
    for (const n of chain) {
      const r = n.candidates.find((x) => x.id === n.chosenReactionId);
      if (r) steps.push(`${n.smiles} ← ${r.precursorList.join(' + ')}`);
    }
    return {
      target: ctx.rootId.value ? ctx.nodes.value[ctx.rootId.value]?.smiles : undefined,
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
    const node = ctx.nodes.value[nodeId];
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
      probability: rxn.probability ?? undefined,
      model: ctx.params.value.model,
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
      // 🔴 走到这里还是 streaming ⇒ **只可能是被 abort**（正常结束走 onDone、
      //    报错走 onError，都会先把状态改掉）。所以这里可以确定地标记为「用户打断」，
      //    而不是靠猜 —— 界面据此仍允许「追问 / 接着分析」。
      if (cur && cur.status === 'streaming') {
        cur.status = 'failed';
        cur.error = cur.error || '分析已中断';
        cur.interrupted = true;
      }
      analysisAborts.delete(nodeId);
      trimAnalyses(node);
      ctx.schedulePersist();
    }
  }

  function cancelAnalysis(nodeId: string): void {
    analysisAborts.get(nodeId)?.abort();
    analysisAborts.delete(nodeId);
    const node = ctx.nodes.value[nodeId];
    const rid = node?.chosenReactionId;
    const rec = node && rid ? node.analyses?.[rid] : undefined;
    if (rec && rec.status === 'streaming') {
      rec.status = 'failed';
      rec.error = '已手动停止';
      rec.interrupted = true; // 显式标记：界面据此仍允许「追问 / 接着分析」
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
    const node = ctx.nodes.value[nodeId];
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
      probability: rxn.probability ?? undefined,
      model: ctx.params.value.model,
      context: routeContext(nodeId),
      count: ctx.condOptionCount.value
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
      // 🔴 与 analyzeStep 同一套推理：还能走到这里就说明是被 abort 的 ⇒ 标记为「用户打断」
      if (c && c.status === 'streaming') {
        c.status = 'failed';
        c.error = c.error || '枚举已中断';
        c.interrupted = true;
      }
      analysisAborts.delete(ak);
      ctx.schedulePersist();
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
    ctx.schedulePersist();
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
      c.interrupted = true;
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
    const node = ctx.nodes.value[nodeId];
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
      probability: rxn.probability ?? undefined,
      model: ctx.params.value.model,
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
      ctx.schedulePersist();
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
  async function submitFeedback(
    nodeId: string,
    entry: Omit<FeedbackEntry, 'product' | 'precursors' | 'reaction_id' | 'model'>
  ): Promise<boolean> {
    const node = ctx.nodes.value[nodeId];
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
  /**
   * 对**整条路线**的每一步依次跑工艺分析（「一键分析全路线」）。
   *
   * 🔴 必须可打断：每步的模型思考动辄几十秒（实测推理模型单步思考 30~55s），
   *    而这条路线上可能有十几步 —— 没有停止入口的话，用户点下去就只能干等，
   *    中途发现了问题也停不下来。所以：
   *      · `routeAnalyzing` 暴露给按钮做 loading / 停止态；
   *      · 循环在**每一步开始前**检查取消标志（已开始的那一步由 `cancelRouteAnalysis`
   *        直接 abort 掉它的 controller，不用等它自己结束）；
   *      · 取消后立刻 `break`，不再往下走。
   *
   * @returns **是否跑完**（true = 所有步都走完了；false = 被用户打断）。
   *          ⚠️ 刻意返回布尔而不是 void：调用方据此决定提示语 ——
   *          被打断时若还弹「已完成整条路线的工艺分析」，那是在撒谎。
   */
  async function analyzeRoute(): Promise<boolean> {
    const steps = ctx.route.value;
    routeCancelRequested = false;
    routeAnalyzing.value = true;
    try {
      for (const step of steps) {
        // 取消标志在**每步之前**查 —— 这样"停在两步之间"是干净的，
        // 不会留下一个半死不活的 streaming 记录
        if (routeCancelRequested) return false;
        const node = ctx.nodes.value[step.nodeId];
        if (!node?.chosenReactionId) continue;
        const rec = node.analyses?.[node.chosenReactionId];
        if (rec?.status === 'done' || rec?.status === 'streaming') continue;
        await analyzeStep(step.nodeId);
        if (routeCancelRequested) return false;
      }
      return true;
    } finally {
      routeAnalyzing.value = false;
      routeCancelRequested = false;
    }
  }

  /**
   * 打断「一键分析全路线」。
   *
   * 两件事都要做，缺一不可：
   *   ① 置取消标志 —— 让循环在下一步开始前退出（否则当前步跑完还会继续下一步）；
   *   ② abort 掉**当前正在跑的那一步** —— 否则要等它自己把几十秒思考跑完才停。
   */
  function cancelRouteAnalysis(): void {
    routeCancelRequested = true;
    // 当前正在分析的那个节点的 controller；没有则说明停在两步之间，只靠标志即可
    for (const [nodeId, controller] of analysisAborts) {
      if (nodeId.startsWith('cond:') || nodeId.startsWith('fu:')) continue;
      controller.abort();
      analysisAborts.delete(nodeId);
    }
    routeAnalyzing.value = false;
  }

  /** 停掉所有进行中的分析 / 枚举 / 追问（reset 时用，别一个个 cancel） */
  function cancelAllAnalyses(): void {
    // 🔴 「一键分析全路线」的循环**不在** analysisAborts 里（它是个 for-await），
    //    只 abort 各个 controller 的话，循环会把下一步接着跑起来 ⇒
    //    reset / 换目标之后它还在后台继续分析，很隐蔽。必须连标志一起置。
    routeCancelRequested = true;
    routeAnalyzing.value = false;
    analysisAborts.forEach((c) => c.abort());
    analysisAborts.clear();
  }

  return {
    llmStatus,
    analysisModules,
    loadLlmStatus,
    analysisOf,
    chosenCondition,
    routeContext,
    trimAnalyses,
    analyzeStep,
    cancelAnalysis,
    analyzeConditions,
    chooseCondition,
    cancelConditions,
    askFollowup,
    cancelFollowup,
    submitFeedback,
    analyzeRoute,
    routeAnalyzing,
    cancelRouteAnalysis,
    cancelAllAnalyses
  };
}

export { createLlmPart };

export type { LlmPartCtx };
