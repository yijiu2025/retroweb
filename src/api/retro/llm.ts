/**
 * 大模型（LLM）API —— **分析类**（端点配置、模型清单、工艺分析、追问）。
 *
 * 与 `api/retro/compute.ts` 的分工：本文件只管"让模型想"，不管"让模型算"。
 * ⚠️ 与 `api/endpoint-config.ts` 的分工更关键：
 *    · 本文件的 `llmApi` 是 **Python 直连档**的 `/llm/*`，配置存后端 `web/llm_settings.json`
 *      （**全局、不绑用户**）；
 *    · `endpoint-config.ts` 是**能力层**，它把「读/写端点配置」按当前档位分派
 *      （走 Node 中转时改用 `/llm/profiles`，落库、per-user、密钥加密）。
 *    ⇒ **UI 读配置一律走 `endpointConfigApi`**，不要直接调本文件的 `settings/saveSettings`；
 *      本文件里的 `llmApi.settings` 只作为能力层的直连档实现存在。
 *
 * ── 流式为什么走 fetch 而不是 axios ──
 *   EventSource 不能发 body、axios 拿不到增量 body ⇒ 见 `api/http/sse.ts` 的说明。
 *   分帧逻辑已下沉到传输层，本文件只负责「收到事件后转成回调」。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { retroBaseURL, retroLlmClient, fail } from './client';
import { postSse } from '@/api/http/sse';
import type {
  AnalyzeRequest,
  AnalyzeStreamEvent,
  ConditionsRequest,
  ConditionsStreamEvent,
  FeedbackEntry,
  FeedbackList,
  FollowupRequest,
  LlmModels,
  LlmProfileRef,
  LlmSettings,
  LlmSettingsPayload,
  LlmStatus,
  StepAnalysis
} from '@/types/retro';

const llmApi = {
  /**
   * 大模型是否已配置（未配置时前端把「AI 分析」引导到 .env 说明）。
   * `probe=true` 会让后端**真发一次最小请求**验证 key + 模型，返回 `probe` 字段。
   * 默认不 probe —— 避免每次进页面都多打一次网络。
   *
   * @param probe 是否真发一次最小请求验证 key + 模型。`true` 时超时放宽到 60s
   * @returns 配置状态；**连不上后端也 resolve**（返回 `ok:false` + hint），
   *          不抛 —— 调用方是页面初始化，拿异常当状态用会漏掉降级文案
   */
  async status(probe = false): Promise<LlmStatus> {
    try {
      const { data } = await retroLlmClient.get<LlmStatus>('/llm/status', {
        params: probe ? { probe: 1 } : undefined,
        // 探针要等远端响应，给足时间；普通状态查询很快
        timeout: probe ? 60000 : 15000
      });
      return data;
    } catch {
      return { ok: false, configured: false, hint: '无法连接后端的大模型接口' };
    }
  },

  /**
   * 列出这套端点配置下能看到的模型（注意：列表里的模型不一定在套餐内可用）。
   * 传 `profile` = 拉「那一套」的（已保存的给 id，还没保存的给草稿字段）——
   * 新建端点时要能先看看有哪些模型可选，否则只能盲填模型名。
   *
   * @param profile 待试的端点配置；省略 = 用当前激活那套（GET，命中后端缓存，快）
   * @returns 模型清单；连不上同样 resolve 空清单（`ok:false` + error），不抛
   */
  async models(profile?: LlmProfileRef): Promise<LlmModels> {
    try {
      const { data } = profile
        ? await retroLlmClient.post<LlmModels>('/llm/models', { profile }, { timeout: 60000 })
        : await retroLlmClient.get<LlmModels>('/llm/models', { timeout: 60000 });
      return data;
    } catch {
      return { ok: false, models: [], error: '无法连接后端的大模型接口' };
    }
  },

  /**
   * 端点配置列表（key 脱敏）+ 当前激活那套的展开字段。
   * `profiles[i].keys` 是**那一套自己**的 key 池状态，切换配置时不会串。
   *
   * @returns 完整设置快照；连不上时返回一份**形状完整的空设置**（`ok:false` + error），
   *          不是 `undefined` —— 面板按 `LlmSettings` 逐字段读，少一个字段就会白屏
   */
  async settings(): Promise<LlmSettings> {
    try {
      const { data } = await retroLlmClient.get<LlmSettings>('/llm/settings', { timeout: 15000 });
      return data;
    } catch {
      return {
        ok: false,
        active_profile: '',
        profiles: [],
        base_url: '',
        model: '',
        // 0 = 无限制（与后端 `_max_tokens_in` / 前端新建配置一致）
        max_tokens: 0,
        temperature: 0.3,
        timeout: 180,
        json_mode: true,
        keys: [],
        active_index: 0,
        error: '无法连接后端的大模型接口'
      };
    }
  },

  /**
   * 保存端点配置（整包）→ 后端写 llm_settings.json（优先级高于 .env，立即生效）并复位 key 轮换。
   * 新建 / 修改 / 删除都走这里：提交什么就是什么。返回值带保存后的设置 + 最新 status。
   *
   * ⚠️ 直连档专用；走 Node 中转时**必须**用 `capability/endpoint-config.ts` 的
   *    `saveSettings`（逐条 upsert + 落库），直接调本方法会写进全局 json。
   *
   * @param p 整包设置。`profiles` 是**保存后的完整列表**（面板按整包语义组装：
   *          不在列表里的 = 删掉）；`api_keys` 元素含 `*` 表示沿用旧 key
   * @returns 保存后的设置快照 + 最新 status
   * @throws 走 `fail()`：网络错误或后端 5xx 时抛 `RetroApiError`；
   *         🔴 **本方法不吞异常**（与 `settings()` 不同）—— 保存失败必须让用户看见
   */
  async saveSettings(p: LlmSettingsPayload): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>('/llm/settings', p, { timeout: 15000 });
    return data;
  },

  /**
   * 切换当前使用的端点配置 —— 立即生效，不用先点保存。
   * 返回 `ok: false` + `error` 表示这个 id 不存在（例如在别处刚被删掉）。
   *
   * @param id 目标配置 id（面板内部统一按 string 用）
   * @returns 切换后的完整设置；id 不存在时是 `ok:false` + error 的**正常返回**，不是异常
   * @throws 走 `fail()`：网络/后端错误时抛 `RetroApiError`
   */
  async activateProfile(id: string): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>('/llm/settings/active', { id }, { timeout: 15000 });
    return data;
  },

  /**
   * 「重试失效 Key」：清空失效/冷却标记（传 profileId 只清那一套）。
   *
   * @param profileId 只重置这一套；空串 = 全部
   * @returns 重置后的完整设置
   * @throws 走 `fail()`：网络/后端错误时抛 `RetroApiError`
   */
  async resetKeys(profileId = ''): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>(
      '/llm/keys/reset',
      profileId ? { profile_id: profileId } : {},
      { timeout: 15000 }
    );
    return data;
  },

  /**
   * 非流式兜底：一次拿到完整结构化结果。
   *
   * ⚠️ 只在流式不可用时用（推理模型长思考、或后端 SSE 异常）。正常路径走 `streamAnalyze`。
   *
   * @param req 分析请求，字段同 `streamAnalyze`
   * @returns 工艺分析结果（`ok` + `StepAnalysis` 的部分字段）
   * @throws 走 `fail()`：失败抛 `RetroApiError`（业务 catch 后请用 `e.message` 呈现）
   */
  async analyze(req: AnalyzeRequest): Promise<{ ok: boolean } & Partial<StepAnalysis>> {
    try {
      const { data } = await retroLlmClient.post<{ ok: boolean } & Partial<StepAnalysis>>(
        '/llm/analyze',
        req
      );
      return data;
    } catch (e) {
      fail(e, '工艺分析失败');
    }
  },

  /**
   * 记录一条「预测 vs 实测」错误反馈（供后续训练）。
   * 🔴 独立于 llmApi 之外的 feedback 能力，但走同一个 baseURL / client。
   *
   * @param entry 反馈内容（预测结构、实测结构、差异说明等），字段见 `FeedbackEntry`
   * @returns 受理结果；`saved` = 落盘位置，`error` = 后端拒绝原因
   * @throws 走 `fail()`：网络/后端错误时抛 `RetroApiError`
   */
  async submitFeedback(entry: FeedbackEntry): Promise<{ ok: boolean; saved?: string; error?: string }> {
    try {
      const { data } = await retroLlmClient.post<{ ok: boolean; saved?: string; error?: string }>(
        '/feedback',
        entry
      );
      return data;
    } catch (e) {
      fail(e, '反馈提交失败');
    }
  },

  /**
   * 读回已收集的反馈（供导出/查看）。
   *
   * @param limit 最多取多少条，默认 200（后端有上限，超了会被裁剪）
   * @returns 反馈列表；连不上时 resolve 空列表（`ok:false` + error），不抛
   */
  async listFeedback(limit = 200): Promise<FeedbackList> {
    try {
      const { data } = await retroLlmClient.get<FeedbackList>('/feedback', {
        params: { limit },
        timeout: 15000
      });
      return data;
    } catch {
      return { ok: false, count: 0, items: [], error: '无法连接后端的反馈接口' };
    }
  }
};

/** 工艺分析的流式回调集合。字段即 `AnalyzeStreamEvent` 的各个分支，一一对应。 */
interface AnalyzeStreamHandlers {
  /** 流建立，后端告知实际用的模型（用户填的与实际生效的可能是两个） */
  onMeta?: (model: string) => void;
  /**
   * 推理模型的「思考」增量。
   * 🔴 必须接：`deepseek-v4-pro` / `kimi-k3` 这类模型开头几十秒只吐 reasoning_content，
   *    正文一直是空 —— 不接的话界面整个思考阶段一个字都不动，看着像卡死。
   */
  onThinking?: (text: string) => void;
  /** 思考结束、正文开始；`chars` = 已产出的思考字数（用来给个"思考了 N 字"的提示） */
  onThinkingEnd?: (chars: number) => void;
  /** 正文增量（**分片**，多次调用拼起来才是完整文本） */
  onDelta?: (text: string) => void;
  /** 流正常收尾：完整的结构化分析结果。**必填** —— 流只能以 done 或 error 结束 */
  onDone: (payload: Extract<AnalyzeStreamEvent, { type: 'done' }>) => void;
  /** 出错收尾（人话文案）。**必填** —— 否则失败会静默，界面停在"分析中" */
  onError: (message: string) => void;
}

/** 追问（自由文本回答）的流式事件 */
type FollowupStreamEvent =
  | { type: 'meta'; model: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end'; chars: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; model: string; reasoning?: string; finish_reason?: string }
  | { type: 'error'; error: string };

/**
 * 追问的回调（比分析少一个 done 的结构化字段 —— 追问答的是自由文本，不是 JSON）。
 * 字段与 `AnalyzeStreamHandlers` 同义，只是 `onDone` 的负载类型不同。
 */
interface FollowupStreamHandlers {
  /** 流建立，后端告知实际使用的模型 */
  onMeta?: (model: string) => void;
  /** 推理模型的思考增量（推理模型才吐；不接则思考阶段无反馈） */
  onThinking?: (text: string) => void;
  /** 思考结束、正文开始；`chars` = 思考字数 */
  onThinkingEnd?: (chars: number) => void;
  /** 正文增量（分片） */
  onDelta?: (text: string) => void;
  /** 正常收尾：完整回答文本 + 结束原因。**必填** */
  onDone: (payload: Extract<FollowupStreamEvent, { type: 'done' }>) => void;
  /** 出错收尾（人话文案）。**必填** */
  onError: (message: string) => void;
}

/**
 * 流式工艺分析（SSE over fetch）。
 *
 * 一次分析要几十秒到几分钟，全程必须逐字返回 —— 非流式会让界面整段空白。
 * 🔴 事件序列固定：`meta` → (`thinking` → `thinking_end`)? → `delta`* → `done` / `error`，
 *    分帧与传输由 `postSse` 负责，本函数只做「事件 → 回调」的转接。
 *
 * @param req      分析请求（产物结构、前体、路线上下文、条件方案等），原样作为 POST 体
 * @param handlers 事件回调集合；`onDone` / `onError` **必填**（缺任一则流无法收尾），
 *                 其余可选 —— 不给就不处理那类事件（见 `AnalyzeStreamHandlers`）
 * @param signal   取消信号：用户点「停止生成」时 abort，`postSse` 静默收尾**不视为错误**
 * @returns 流读完（或被取消）后 resolve；**不因业务失败 reject** ——
 *          失败一律走 `handlers.onError`，与 SSE 路径上其他错误保持同一出口
 */
async function streamAnalyze(
  req: AnalyzeRequest,
  handlers: AnalyzeStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  await postSse<AnalyzeStreamEvent>(
    retroBaseURL,
    '/llm/analyze/stream',
    req,
    signal,
    (evt) => {
      if (evt.type === 'meta') handlers.onMeta?.(evt.model);
      else if (evt.type === 'thinking') handlers.onThinking?.(evt.text);
      else if (evt.type === 'thinking_end') handlers.onThinkingEnd?.(evt.chars);
      else if (evt.type === 'delta') handlers.onDelta?.(evt.text);
      else if (evt.type === 'done') handlers.onDone(evt);
      else if (evt.type === 'error') handlers.onError(evt.error);
    },
    handlers.onError
  );
}

/**
 * 流式「候选反应条件枚举」：先列出这一步可以怎么做（几套条件），再由用户挑一套深入分析。
 *
 * 与 streamAnalyze 走同一套 SSE 分帧，事件序列也一致 —— 只有 done 的负载不同（条件方案数组
 * 而非工艺分析 JSON），所以回调类型直接复用 AnalyzeStreamHandlers、只换 onDone。
 */
type ConditionsStreamHandlers = Omit<AnalyzeStreamHandlers, 'onDone'> & {
  /** 正常收尾：若干套候选条件方案。**必填** */
  onDone: (payload: Extract<ConditionsStreamEvent, { type: 'done' }>) => void;
};

/**
 * 流式枚举这一步的候选反应条件。
 *
 * @param req      条件枚举请求（该步的反应物、已有/候选条件约束）
 * @param handlers 事件回调；除 `onDone` 的负载是条件方案数组外，语义同 `AnalyzeStreamHandlers`
 * @param signal   取消信号（同 `streamAnalyze`）
 * @returns 流读完（或被取消）后 resolve；失败走 `handlers.onError`，不 reject
 */
async function streamConditions(
  req: ConditionsRequest,
  handlers: ConditionsStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  await postSse<ConditionsStreamEvent>(
    retroBaseURL,
    '/llm/conditions/stream',
    req,
    signal,
    (evt) => {
      if (evt.type === 'meta') handlers.onMeta?.(evt.model);
      else if (evt.type === 'thinking') handlers.onThinking?.(evt.text);
      else if (evt.type === 'thinking_end') handlers.onThinkingEnd?.(evt.chars);
      else if (evt.type === 'delta') handlers.onDelta?.(evt.text);
      else if (evt.type === 'done') handlers.onDone(evt);
      else if (evt.type === 'error') handlers.onError(evt.error);
    },
    handlers.onError
  );
}

/**
 * 流式「追问」：带着这一步反应的上下文，问它的其他问题。
 * 与 streamAnalyze 走同一套 SSE 分帧，区别只在事件负载（自由文本而非结构化 JSON）。
 *
 * 🔴 自由文本请求必须走**非 JSON 模式**（后端 `_body(json_mode=False)`）：
 *    强制 JSON 会让模型把回答包成 `{"text":"..."}`，界面直接显示花括号。
 *
 * @param req      追问请求（问题文本 + 该步反应上下文），字段见 `FollowupRequest`
 * @param handlers 事件回调；`onDone` 收的是自由文本 + `finish_reason`
 * @param signal   取消信号（同 `streamAnalyze`）
 * @returns 流读完（或被取消）后 resolve；失败走 `handlers.onError`，不 reject
 */
async function streamFollowup(
  req: FollowupRequest,
  handlers: FollowupStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  await postSse<FollowupStreamEvent>(
    retroBaseURL,
    '/llm/followup/stream',
    req,
    signal,
    (evt) => {
      if (evt.type === 'meta') handlers.onMeta?.(evt.model);
      else if (evt.type === 'thinking') handlers.onThinking?.(evt.text);
      else if (evt.type === 'thinking_end') handlers.onThinkingEnd?.(evt.chars);
      else if (evt.type === 'delta') handlers.onDelta?.(evt.text);
      else if (evt.type === 'done') handlers.onDone(evt);
      else if (evt.type === 'error') handlers.onError(evt.error);
    },
    handlers.onError
  );
}

export { llmApi, streamAnalyze, streamConditions, streamFollowup };

export type {
  AnalyzeStreamHandlers,
  FollowupStreamHandlers,
  ConditionsStreamHandlers,
  FollowupStreamEvent
};
