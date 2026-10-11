/**
 * 逆合成模型服务 API（Flask 8000）
 *
 * 两条路径并存：
 * - `/api/jobs`（kind=predict）：**一次调用 = 一步逆合成**，前端反复调单步接口，
 *   把路线树自己长出来（`createJob` + `getJob` 轮询）。
 * - `/api/jobs`（kind=search）：**一次 Retro* 搜到底**，返回多条完整路线
 *   （`createSearchJob`），对应界面「自动往下拆」改为一次吃满预算的搜索。
 *
 * Flask 返回的是裸 JSON（没有 node 后端的 {code,message,data} 信封），
 * 所以这里独立建一个实例，不做信封拆包。
 */
import axios, { type AxiosResponse } from 'axios';
import {
  attachUnauthorizedInterceptor,
  createUnauthorizedError,
  isUnauthorizedError,
  notifyUnauthorized
} from '@/api/http';
import { RETRO_BASE_URL, API_BASE_URL, RETRO_VIA_NODE } from '@/config/services';
import type {
  AnalyzeRequest,
  AnalyzeStreamEvent,
  ConditionsRequest,
  ConditionsStreamEvent,
  FeedbackEntry,
  FeedbackList,
  FollowupRequest,
  JobCreateResponse,
  JobSnapshot,
  LlmModels,
  LlmProfileRef,
  LlmSettings,
  LlmSettingsPayload,
  LlmStatus,
  LoadForwardOk,
  LoadModelOk,
  ModelServiceActionOk,
  ModelsResponse,
  ParseResult,
  PredictResult,
  SearchAlgorithm,
  StepAnalysis
} from '@/types/retro';

/**
 * 算法服务 baseURL（S3 切换）。
 *
 * 🔴 关（默认）：`RETRO_BASE_URL`（/retro → vite proxy → Flask 直连）。
 * 🔴 开：`API_BASE_URL + '/retroweb/v1'`（走 Node 中转，Python 从公网下线）。
 */
const retroBaseURL = RETRO_VIA_NODE ? `${API_BASE_URL}/retroweb/v1` : RETRO_BASE_URL;

/**
 * 响应拆包：Node 中转回 `{code,message,data}` 信封，直连 Python 回裸 JSON。
 * 走 Node 时取 `data`；直连时原样返回。统一挂到三个 client 的响应拦截器上。
 */
function unwrapNodeEnvelope<T>(response: AxiosResponse<T>): AxiosResponse<T> {
  if (!RETRO_VIA_NODE) return response;
  const body = response.data as { code?: number; data?: unknown } | null;
  // code===200 才算成功；否则抛错（与 http.ts 同口径，但这里不触发 401 续期）
  if (body && typeof body === 'object' && 'data' in body) {
    return { ...response, data: body.data as T };
  }
  return response;
}

/**
 * 🔴 `withCredentials: true` 必须**无条件**开（三个 axios client 都一样）：
 *
 * 走 Node 中转时 baseURL 是 `http://<host>:3000/retroweb/v1` ⇒ 对 5177 页面来说是
 * **跨源**请求。不开的话浏览器不会带上 `sid` cookie —— 于是**登录成功了也一样 401**，
 * 模型列表 / 任务 / AI 分析全都拿不到。这是「真实登录后仍然空工作台」的根因。
 *
 * 直连 Python 时 baseURL 是 `/retro`（同源相对路径，经 vite proxy），开不带差价，
 * 所以这里不做条件判断 —— 条件判断本身就容易写错，而两种走法都需要它。
 */
const retroClient = axios.create({
  baseURL: retroBaseURL,
  // 首次预测要加载模型 + 起规则子进程，实测可达数十秒 ⇒ 超时放到 10 分钟
  timeout: 600000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
});
retroClient.interceptors.response.use(unwrapNodeEnvelope);

/**
 * 轮询专用客户端：进度查询必须「快失败」，否则后端一旦卡顿，前端会干等最久 10 分钟。
 * 单次轮询最多 20s，超时就让上层重试（重试 N 次仍不通才判失败）。
 */
const retroJobClient = axios.create({
  baseURL: retroBaseURL,
  timeout: 20000,
  // 同源 cases: 见 retroClient 处注释（跨源必须带 cookie，否则登录后照样 401）
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
});
retroJobClient.interceptors.response.use(unwrapNodeEnvelope);

/** 轮询/接口错误：带状态码与「是否可重试」标记 */
class RetroApiError extends Error {
  status?: number;
  transient: boolean;
  constructor(message: string, opts: { status?: number; transient?: boolean } = {}) {
    super(message);
    this.name = 'RetroApiError';
    this.status = opts.status;
    this.transient = opts.transient ?? false;
  }
}

/**
 * 统一抛出带上下文的错误。
 *
 * 🔴 两个字段都要试着取：Python 的失败体是 `{error: "..."}`，而 Node 中转义的是
 *    `{code, message, data}` 信封（见 http.ts 同口径）。只认 `error` 的话，
 *    Node 侧拒绝请求时（配额超限、正向模型未就绪、权限不足……）那些**具体的拒因**
 *    全被丢掉，用户只看到一句 `Request failed with status code 400`。
 */
function fail(err: unknown, fallback: string): never {
  const res = (err as { response?: { status?: number; data?: Record<string, string> } })?.response;
  const payload = res?.data;
  const message = payload?.error || payload?.message || (err as Error)?.message || fallback;
  // 🔴 先看哨兵：401 若已被 `attachUnauthorizedInterceptor` 接管（续期失败），
  //    冒泡上来的就是 `createUnauthorizedError` —— 它**没有 `.response`**，
  //    落到下面的 `res?.status === 401` 会判 false，于是被重新包成普通 Error、
  //    **把哨兵弄丢**，业务侧的 `isAuthFailure` 就瞎了。必须原样抛出。
  if (isUnauthorizedError(err)) throw err;
  // 401 无论从哪个 client 冒出来都归登录流管 —— 与 http.ts 打**同一个哨兵**，
  // 业务侧才能一视同仁地让位（见 stores/parts/models.ts 的 isAuthFailure）。
  // 不要在文案上做判据：Node 回的是 `{message}`、Python 回的是 `{error}`，
  // 一旦哪天措辞变了，正则判据会**静默失效**（这次就是这么红的）。
  //
  // ⚠️ 这个分支现在只在「重放后仍 401」（`_retry` 已置位，拦截器不再接管）时才走到。
  //    此时**没人**打开登录窗（续期那步是成功的），所以这里要主动补一次通知。
  if (res?.status === 401) {
    notifyUnauthorized();
    throw createUnauthorizedError(message);
  }
  throw new Error(message);
}

const retroApi = {
  /**
   * 模型状态矩阵 —— 前端只认这一个入口。
   *
   * 每行给出：文件在不在、此刻什么状态（`idle / loading / ready / failed /
   * unavailable`）、多大、是不是当前加载的那一个；外加一份 `service` 概览
   * （模型服务在不在跑、加载到哪一步、错误是什么）。
   *
   * 🔴 用 `retroJobClient`（20s 超时）而不是默认的 10 分钟客户端：
   *    这是**状态查询**，会被 1.5 秒一轮地轮询 —— 用 10 分钟超时的客户端，
   *    后端一卡就会把请求堆成山。状态查询必须「快失败」。
   */
  async models(): Promise<ModelsResponse> {
    try {
      const { data } = await retroJobClient.get<ModelsResponse>('/models');
      return data;
    } catch (e) {
      fail(e, '获取模型列表失败');
    }
  },

  /**
   * 加载 / 切换模型。
   *
   * 🔴 返回的是「**已经开始加载**」，立刻返回（不是等 40~90 秒加载完）。
   *    末尾不发 `/models` 轮询的话，前端就只能一直转圈。
   *
   * 语义：模型服务没跑 ⇒ 拉起它；跑着但加载的是别的 ⇒ 停旧起新
   * （一次只留一个模型 —— 实测每个约 18 GB，两个并存有崩机风险）。
   */
  async loadModel(model: string): Promise<LoadModelOk> {
    try {
      const { data } = await retroClient.post<LoadModelOk>('/load', { model });
      return data;
    } catch (e) {
      fail(e, '模型加载失败');
    }
  },

  /**
   * 模型服务的启停（`start` / `stop` / `restart`）。
   *
   * 🔴 单独一个口子，是为了让「模型服务」和「其他后端」真的能分开操作：
   *    改完代码重启 API 时模型服务不受影响；反过来想省内存时，可以只停模型服务，
   *    API 照常提供解析 / 绘制 / AI 分析等能力。
   */
  async modelService(
    action: 'start' | 'stop' | 'restart',
    model?: string
  ): Promise<ModelServiceActionOk> {
    try {
      const { data } = await retroClient.post<ModelServiceActionOk>(
        `/model-service/${action}`,
        model ? { model } : {}
      );
      return data;
    } catch (e) {
      fail(e, action === 'stop' ? '停止模型服务失败' : '启动模型服务失败');
    }
  },

  /**
   * 加载正向模型（「可行性过滤」的判据）。
   *
   * 🔴 与 `loadModel` 的关键区别：**不需要重启模型服务** —— 正向模型构造时不 spawn
   *    规则子进程，可以在模型服务的 HTTP 起来之后热挂。所以它不会把已加载的逆向模型
   *    踢掉，也就不用等"停旧起新"那几秒。
   *
   * 语义同 `loadModel`：返回「**已受理**」，进度看 `/api/models` 的 `forward.state`。
   */
  async loadForward(forward?: string): Promise<LoadForwardOk> {
    try {
      const { data } = await retroClient.post<LoadForwardOk>(
        '/forward/load',
        forward ? { forward } : {}
      );
      return data;
    } catch (e) {
      fail(e, '加载正向模型失败');
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

  /**
   * 创建一个后台**搜索**任务（kind=search，一次 Retro* 搜到底），立即返回 job_id。
   * 与 createJob 的区别：kind=search，且入参是搜索参数（max_depth / max_calls /
   * max_heavy_atoms / purchasable …），对应界面「拆分约束」里的设置。
   */
  async createSearchJob(
    smiles: string,
    params: {
      model: string;
      maxRoutes: number;
      maxCalls: number;
      timeLimit: number;
      maxDepth: number;
      maxHeavyAtoms: number;
      valueFn: string;
      /** 搜索算法（retro_star / bfs）；缺省后端按默认（Retro*）处理 */
      algorithm?: SearchAlgorithm;
      purchasable: string[];
      requiredMaterials: string[];
      /** 「可行性过滤」：需模型服务里已加载正向模型，否则后端会先拦下来说清原因 */
      useForwardFilter?: boolean;
      /** 正向模型保留的 top-k */
      forwardTopK?: number;
    }
  ): Promise<JobCreateResponse> {
    try {
      const { data } = await retroClient.post<JobCreateResponse>('/jobs', {
        smiles,
        kind: 'search',
        model: params.model,
        max_routes: params.maxRoutes,
        max_calls: params.maxCalls,
        time_limit: params.timeLimit,
        max_depth: params.maxDepth,
        max_heavy_atoms: params.maxHeavyAtoms,
        value_fn: params.valueFn,
        algorithm: params.algorithm ?? 'retro_star',
        purchasable: params.purchasable,
        required_materials: params.requiredMaterials,
        use_forward_filter: !!params.useForwardFilter,
        forward_top_k: params.forwardTopK ?? 5
      });
      return data;
    } catch (e) {
      fail(e, '创建路线搜索任务失败');
    }
  },

  /** 查询任务快照。since 只取 seq 大于它的日志行（增量，避免重复拉）。
   *  🔴 用短超时客户端：网络/超时错误抛 `transient:true`，由轮询循环决定是否重试。 */
  async getJob(jobId: string, since = 0): Promise<JobSnapshot> {
    try {
      const { data } = await retroJobClient.get<JobSnapshot>(`/jobs/${jobId}?since=${since}`);
      // 🔴 S3：Node 中转把「上游重启 / 结果丢失」标记成 state='stale'（非 HTTP 404）。
      //    转成 non-transient 的 RetroApiError，复用「任务已丢失，请重新展开」的提示路径。
      if ((data as { state?: string } | null)?.state === 'stale') {
        throw new RetroApiError('后端任务结果已丢失（服务可能重启过），请重新展开', {
          status: 410,
          transient: false
        });
      }
      return data;
    } catch (e) {
      if (e instanceof RetroApiError) throw e;
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
const retroLlmClient = axios.create({
  baseURL: retroBaseURL,
  timeout: 300000,
  withCredentials: true, // 同 retroClient：跨源到 Node 必须带 cookie
  headers: { 'Content-Type': 'application/json' }
});
retroLlmClient.interceptors.response.use(unwrapNodeEnvelope);

/**
 * 401 统一走 http.ts 那一套（单飞续期 → 失败则弹登录窗）。
 *
 * 🔴 三个 client **都要挂**：不挂的话 retro 侧的 401 只会打哨兵、不触发登录流，
 *    于是会话在**使用中**过期时会被「静默吞掉」—— 业务侧的 `isAuthFailure` 看见哨兵
 *    就让位（不报错），而登录窗又没人打开，用户面对一个坏了却毫无提示的界面。
 *    首屏之所以还能弹窗，只是因为 `authStore.init()` 恰好走了 apiClient 路径。
 *
 * 集中在这里挂，避免三个 client 处各写一遍。
 */
[retroClient, retroJobClient, retroLlmClient].forEach(attachUnauthorizedInterceptor);

const llmApi = {
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

  /**
   * 列出这套端点配置下能看到的模型（注意：列表里的模型不一定在套餐内可用）。
   * 传 `profile` = 拉「那一套」的（已保存的给 id，还没保存的给草稿字段）——
   * 新建端点时要能先看看有哪些模型可选，否则只能盲填模型名。
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
   */
  async saveSettings(p: LlmSettingsPayload): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>('/llm/settings', p, { timeout: 15000 });
    return data;
  },

  /**
   * 切换当前使用的端点配置 —— 立即生效，不用先点保存。
   * 返回 `ok: false` + `error` 表示这个 id 不存在（例如在别处刚被删掉）。
   */
  async activateProfile(id: string): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>('/llm/settings/active', { id }, { timeout: 15000 });
    return data;
  },

  /** 「重试失效 Key」：清空失效/冷却标记（传 profileId 只清那一套） */
  async resetKeys(profileId = ''): Promise<LlmSettings> {
    const { data } = await retroLlmClient.post<LlmSettings>(
      '/llm/keys/reset',
      profileId ? { profile_id: profileId } : {},
      { timeout: 15000 }
    );
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
  },

  /**
   * 记录一条「预测 vs 实测」错误反馈（供后续训练）。
   * 🔴 独立于 llmApi 之外的 feedback 能力，但走同一个 baseURL / client。
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

  /** 读回已收集的反馈（供导出/查看） */
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

/** 流式分析的回调（与 SSE 事件一一对应） */
interface AnalyzeStreamHandlers {
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
type FollowupStreamEvent =
  | { type: 'meta'; model: string }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_end'; chars: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; text: string; model: string; reasoning?: string; finish_reason?: string }
  | { type: 'error'; error: string };

/** 追问的回调（比分析少一个 done 的结构化字段） */
interface FollowupStreamHandlers {
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
    resp = await fetch(`${retroBaseURL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      // 🔴 与上面三个 axios client 同理：跨源到 Node 中转时必须带上 sid cookie，
      //    否则 SSE 请求会以 401 失败（连第一条 meta 事件都收不到）。
      credentials: 'include',
      signal
    });
  } catch (e) {
    onError((e as Error)?.message || '请求大模型失败');
    return;
  }

  if (!resp.ok) {
    // 🔴 401 归登录流管 —— 与 http.ts / 三个 axios client 同一套语义。
    //    这条是 fetch 路径（SSE 不能用 axios），拦截器覆盖不到，必须显式处理；
    //    否则登录窗不会打开，而 `onError` 还会再挂一条错误条，跟登录窗吵成一团。
    if (resp.status === 401) {
      notifyUnauthorized();
      return;
    }
    let detail = `HTTP ${resp.status}`;
    try {
      // 🔴 两种走法的错误字段名**不一样**，必须都认：
      //   · 直连 Python（Flask）→ `{ error: "..." }`
      //   · Node 中转 → 统一信封 `{ code, message, data }`，拒因在 `message`
      //     （见 app/retroweb/services/upstream.service.js 的 forwardStream：
      //      上游不可用时 reply.result.fail(..., 503)，502 时也是 result.fail）
      //   原先只读 `error` ⇒ 走 Node 时拿不到任何说明，界面上只剩一个干巴巴的
      //   「HTTP 502」，用户和排查的人都不知道到底哪里坏了。
      const payload = (await resp.json()) as { error?: string; message?: string };
      const msg = payload?.error || payload?.message;
      if (msg) detail = msg;
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
async function streamAnalyze(
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
type ConditionsStreamHandlers = Omit<AnalyzeStreamHandlers, 'onDone'> & {
  onDone: (payload: Extract<ConditionsStreamEvent, { type: 'done' }>) => void;
};

async function streamConditions(
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
async function streamFollowup(
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

export {
  retroClient,
  retroJobClient,
  RetroApiError,
  retroApi,
  retroLlmClient,
  llmApi,
  streamAnalyze,
  streamConditions,
  streamFollowup
};

export type {
  AnalyzeStreamHandlers,
  FollowupStreamEvent,
  FollowupStreamHandlers,
  ConditionsStreamHandlers
};
