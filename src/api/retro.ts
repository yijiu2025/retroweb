/**
 * 逆合成模型服务 API（Flask 8000）
 *
 * ⚠️ 只调 `/api/predict`（**一次调用 = 一步逆合成**）。
 * 原项目的 `/api/search`（Retro* 一次搜到底）刻意不用 —— 本工作台要的是
 * 「多次一步」：由前端反复调用单步接口，把路线树自己长出来。
 *
 * Flask 返回的是裸 JSON（没有 node 后端的 {code,message,data} 信封），
 * 所以这里独立建一个实例，不做信封拆包。
 */
import axios from 'axios';
import { RETRO_BASE_URL } from '@/config/services';
import type {
  AnalyzeRequest,
  AnalyzeStreamEvent,
  ConditionsRequest,
  ConditionsStreamEvent,
  FollowupRequest,
  JobCreateResponse,
  JobSnapshot,
  LlmModels,
  LlmSettings,
  LlmSettingsPayload,
  LlmStatus,
  LoadModelOk,
  ModelsResponse,
  ParseResult,
  PredictResult,
  StepAnalysis
} from '@/types/retro';

export const retroClient = axios.create({
  baseURL: RETRO_BASE_URL,
  // 首次预测要加载模型 + 起规则子进程，实测可达数十秒 ⇒ 超时放到 10 分钟
  timeout: 600000,
  headers: { 'Content-Type': 'application/json' }
});

/**
 * 轮询专用客户端：进度查询必须「快失败」，否则后端一旦卡顿，前端会干等最久 10 分钟。
 * 单次轮询最多 20s，超时就让上层重试（重试 N 次仍不通才判失败）。
 */
export const retroJobClient = axios.create({
  baseURL: RETRO_BASE_URL,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' }
});

/** 轮询/接口错误：带状态码与「是否可重试」标记 */
export class RetroApiError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, opts: { status?: number; transient?: boolean } = {}) {
    super(message);
    this.name = 'RetroApiError';
    this.status = opts.status;
    this.transient = opts.transient ?? false;
  }
}

/** 统一抛出带上下文的错误 */
function fail(err: unknown, fallback: string): never {
  const anyErr = err as { response?: { data?: { error?: string } }; message?: string };
  const message = anyErr?.response?.data?.error || anyErr?.message || fallback;
  throw new Error(message);
}

export const retroApi = {
  /** 模型列表 + 是否已加载 */
  async models(): Promise<ModelsResponse> {
    try {
      const { data } = await retroClient.get<ModelsResponse>('/models');
      return data;
    } catch (e) {
      fail(e, '获取模型列表失败');
    }
  },

  /** 预加载模型（避免首次预测等待过久） */
  async loadModel(model: string): Promise<LoadModelOk> {
    try {
      const { data } = await retroClient.post<LoadModelOk>('/load', { model });
      return data;
    } catch (e) {
      fail(e, '模型加载失败');
    }
  },

  /**
   * 解析结构输入：CDXML / MOL / SDF / 反应式 SMILES / 纯 SMILES → canonical SMILES
   * 失败时返回 ok:false + reasons + suggestions（人话诊断 + 一键修复候选）
   *
   * ⚠️ 现在**只有 CDXML 会走到这里**（2026-10-06 起）。SMILES / MOL / SDF / 画板产物
   * 全由前端 RDKit.js（`utils/rdkit.ts`）本地解析 —— 浏览器版 `get_mol()` 读不了 CDXML，
   * 那一种才必须回落后端的 `Chem.MolsFromCDXML()`。分流入口 `needsBackendParse()`。
   */
  async parse(text: string): Promise<ParseResult> {
    try {
      const { data } = await retroClient.post<ParseResult>('/parse', { text, kind: 'auto' });
      return data;
    } catch (e) {
      fail(e, '结构解析失败');
    }
  },

  /**
   * 单步逆合成预测（同步，兼容旧调用 / 兜底）。
   *
   * ⚠️ Flask 校验失败时返回的是 **HTTP 400 + 结构化 body**（ok:false + error + reasons），
   *    axios 会把它当异常抛。这时必须把 body 原样交回去，否则 `reasons`（人话诊断）
   *    会被 catch 吞掉 —— 用户只看到一句干巴巴的 error，不知道错在哪。
   *
   * 🔴 新版工作台已改用 `createJob` + `getJob` 轮询（见 stores/workspace.predictNode），
   *    这个方法仅作为兜底保留。
   */
  async predict(
    smiles: string,
    model: string,
    numResults: number,
    signal?: AbortSignal
  ): Promise<PredictResult> {
    try {
      const { data } = await retroClient.post<PredictResult>(
        '/predict',
        { smiles, model, num_results: numResults },
        signal ? { signal } : undefined
      );
      return data;
    } catch (e) {
      const payload = (e as { response?: { data?: PredictResult } })?.response?.data;
      if (payload && payload.ok === false) return payload;
      fail(e, '预测失败');
    }
  },

  /**
   * 创建一个后台预测任务，立即返回 job_id（不阻塞）。
   * 之后用 `getJob(jobId, since)` 轮询进度，「分析到哪一步了」全靠它。
   */
  async createJob(
    smiles: string,
    model: string,
    numResults: number
  ): Promise<JobCreateResponse> {
    try {
      const { data } = await retroClient.post<JobCreateResponse>('/jobs', {
        smiles,
        model,
        num_results: numResults
      });
      return data;
    } catch (e) {
      fail(e, '创建分析任务失败');
    }
  },

  /** 查询任务快照。since 只取 seq 大于它的日志行（增量，避免重复拉）。
   *  🔴 用短超时客户端：网络/超时错误抛 `transient:true`，由轮询循环决定是否重试。 */
  async getJob(jobId: string, since = 0): Promise<JobSnapshot> {
    try {
      const { data } = await retroJobClient.get<JobSnapshot>(`/jobs/${jobId}?since=${since}`);
      return data;
    } catch (e) {
      const ae = e as { response?: { status?: number }; code?: string; message?: string };
      // 404 = 后端任务已过期/不存在（进程重启或 TTL 到期）→ 不可重试，明确告诉用户
      if (ae?.response?.status === 404) {
        throw new RetroApiError('后端任务已不存在（Flask 可能已重启），请重新展开', {
          status: 404,
          transient: false
        });
      }
      // 超时 / 网络错误 = 可重试的瞬时故障
      const transient = ae?.code === 'ECONNABORTED' || ae?.code === 'ERR_NETWORK' || !ae?.response;
      throw new RetroApiError(ae?.message || '查询任务进度失败', { transient });
    }
  },

  /** 请求取消（⚠️ 只在阶段边界生效：模型加载/推理本身不可中断） */
  async cancelJob(jobId: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const { data } = await retroClient.post<{ ok: boolean; message?: string }>(
        `/jobs/${jobId}/cancel`
      );
      return data;
    } catch (e) {
      fail(e, '取消任务失败');
    }
  }
};

// ---------------------------------------------------------------------------
// 大模型工艺分析
// ---------------------------------------------------------------------------

/**
 * 工艺分析专用客户端：LLM 首字可能要等十几秒，超时给到 5 分钟。
 * （流式路径不用 axios —— 见 streamAnalyze。）
 */
export const retroLlmClient = axios.create({
  baseURL: RETRO_BASE_URL,
  timeout: 300000,
  headers: { 'Content-Type': 'application/json' }
});

export const llmApi = {
  /**
   * 大模型是否已配置（未配置时前端把「AI 分析」引导到 .env 说明）。
   * `probe=true` 会让后端**真发一次最小请求**验证 key + 模型，返回 `probe` 字段。
   * 默认不 probe —— 避免每次进页面都多打一次网络。
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

  /** 列出该 key 能看到的模型（注意：列表里的模型不一定在套餐内可用） */
  async models(): Promise<LlmModels> {
    try {
      const { data } = await retroLlmClient.get<LlmModels>('/llm/models', { timeout: 60000 });
      return data;
    } catch {
      return { ok: false, models: [], error: '无法连接后端的大模型接口' };
    }
  },

  /** 设置面板当前值（key 脱敏）：接口地址 / 模型 / token 上限 / key 池状态 */
  async settings(): Promise<LlmSettings> {
    try {
      const { data } = await retroLlmClient.get<LlmSettings>('/llm/settings', { timeout: 15000 });
      return data;
    } catch {
      return {
        ok: false,
        base_url: '',
        model: '',
        max_tokens: 8192,
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
   * 保存设置 → 后端写 llm_settings.json（优先级高于 .env，立即生效）并复位 key 轮换。
   * 返回值带保存后的设置 + 最新 status，调用方不用再打一次 /llm/status。
   */
  async saveSettings(p: LlmSettingsPayload): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>('/llm/settings', p, { timeout: 15000 });
    return data;
  },

  /** 「重试失效 Key」：清空全部 key 的失效/冷却标记 */
  async resetKeys(): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>('/llm/keys/reset', {}, { timeout: 15000 });
    return data;
  },

  /** 非流式兜底：一次拿到完整结构化结果 */
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
  }
};

/** 流式分析的回调（与 SSE 事件一一对应） */
export interface AnalyzeStreamHandlers {
  onMeta?: (model: string) => void;
  /**
   * 推理模型的「思考」增量。
   * 🔴 必须接：`deepseek-v4-pro` / `kimi-k3` 这类模型开头几十秒只吐 reasoning_content，
   *    正文一直是空 —— 不接的话界面整个思考阶段一个字都不动，看着像卡死。
   */
  onThinking?: (text: string) => void;
  /** 思考结束、正文开始 */
  onThinkingEnd?: (chars: number) => void;
  onDelta?: (text: string) => void;
  onDone: (payload: Extract<AnalyzeStreamEvent, { type: 'done' }>) => void;
  onError: (message: string) => void;
}

/** 追问（自由文本回答）的流式事件 */
export type FollowupStreamEvent =
  | { type: 'meta'; model: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end'; chars: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; model: string; reasoning?: string; finish_reason?: string }
  | { type: 'error'; error: string };

/** 追问的回调（比分析少一个 done 的结构化字段） */
export interface FollowupStreamHandlers {
  onMeta?: (model: string) => void;
  onThinking?: (text: string) => void;
  onThinkingEnd?: (chars: number) => void;
  onDelta?: (text: string) => void;
  onDone: (payload: Extract<FollowupStreamEvent, { type: 'done' }>) => void;
  onError: (message: string) => void;
}

/**
 * 读一条 SSE 流并逐事件回调 —— 分析与追问共用同一套分帧逻辑。
 *
 * 🔴 为什么不用 EventSource：EventSource 只能发 GET、不能带 body，
 *    而这里必须把「产物 + 前体 + 路线上下文」作为 JSON body 传过去 ⇒ 用 fetch 读流。
 * 🔴 为什么不用 axios：axios 在浏览器上拿不到增量 body（XHR 无流式读取）⇒ 必须 fetch + ReadableStream。
 *
 * SSE 分帧规则：事件之间以空行分隔，行前缀 `data: `。这里按行缓冲，遇空行才 dispatch，
 * 避免把一个 JSON 从中间切断（后端每条事件都是一整行 JSON，安全）。
 */
async function postSse<T extends { type: string }>(
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  onEvent: (evt: T) => void,
  onError: (message: string) => void
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${RETRO_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    onError((e as Error)?.message || '请求大模型失败');
    return;
  }

  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const payload = (await resp.json()) as { error?: string };
      if (payload?.error) detail = payload.error;
    } catch {
      /* 非 JSON 响应，保持 HTTP 状态码 */
    }
    onError(detail);
    return;
  }
  if (!resp.body) {
    onError('后端没有返回流式响应体');
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatch = (rawEvent: string): void => {
    // 一个事件可能有多行 data:（SSE 允许），这里只取 data 行并拼接
    const dataLines = rawEvent
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    let evt: T;
    try {
      evt = JSON.parse(dataLines.join('\n')) as T;
    } catch {
      return; // 半截 JSON 或心跳，忽略
    }
    onEvent(evt);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 事件以空行分隔；统一成 \n 处理（后端用的就是 \n\n）
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (rawEvent.trim()) dispatch(rawEvent);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') {
      onError((e as Error)?.message || '读取流式响应失败');
    }
  }
}

/** 流式工艺分析（SSE over fetch） */
export async function streamAnalyze(
  req: AnalyzeRequest,
  handlers: AnalyzeStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  await postSse<AnalyzeStreamEvent>(
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
export type ConditionsStreamHandlers = Omit<AnalyzeStreamHandlers, 'onDone'> & {
  onDone: (payload: Extract<ConditionsStreamEvent, { type: 'done' }>) => void;
};

export async function streamConditions(
  req: ConditionsRequest,
  handlers: ConditionsStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  await postSse<ConditionsStreamEvent>(
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
 */
export async function streamFollowup(
  req: FollowupRequest,
  handlers: FollowupStreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  await postSse<FollowupStreamEvent>(
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
