/**
 * 逆合成算法 API —— **计算类**（模型状态、加载、解析、任务、预测、反馈）。
 *
 * 与 `api/retro/llm.ts` 的分工：**本文件只管"算"（模型与任务），不管"想"（LLM 分析）**。
 * 两者共用 `./client` 的实例与 `fail()`，但端点集互不重叠 —— 读文件时按业务语义选文件，
 * 不用在一份 700 行清单里找端点。
 *
 * ── 两条调用路径（`/api/jobs` 的两种 kind）──
 *   · `kind=predict`：**一次调用 = 一步逆合成**。前端反复调单步接口，把路线树自己
 *     长出来（`createJob` + `getJob` 轮询）。
 *   · `kind=search`：**一次 Retro* 搜到底**，返回多条完整路线（`createSearchJob`），
 *     对应界面「自动往下拆」改为一次吃满预算的搜索。
 *
 * ── 为什么本文件不自己发请求 ──
 *   baseURL 的档位判断、401 拦截器、两种错误体的归一全在 `./client`。
 *   本文件每个方法只写「打哪个端点、传什么、返回什么」，便于逐条核对。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import {
  retroClient,
  retroJobClient,
  RetroApiError,
  fail
} from './client';
import type {
  JobCreateResponse,
  JobSnapshot,
  LoadForwardOk,
  LoadModelOk,
  ModelServiceActionOk,
  ModelsResponse,
  ParseResult,
  PredictResult,
  SearchAlgorithm,
  SubstanceApi,
  SubstanceChoice,
  SubstanceInfo,
  SubstanceSource
} from '@/types/retro';

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
   *
   * @returns 模型状态矩阵 + 模型服务概览
   * @throws 走 `fail()`：失败抛 `RetroApiError`；`models.ts` 靠捕获它来区分
   *         「后端没起」与「模型没加载」
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
   *
   * ⚠️ 受 `VITE_RETRO_MODEL_CONTROL` 门控：走 Node 中转时前端**不该**调本方法，
   *    模型加载由 Node 侧管理（见 `config/services.ts` 的 `MODEL_CONTROL_ENABLED`）。
   *
   * @param model 模型目录名（`/models` 返回的那一列），不是展示名
   * @returns 「**已开始加载**」的受理结果，不等加载完
   * @throws 走 `fail()`：模型不存在 / 服务起不来时抛 `RetroApiError`（`message` 是后端原话）
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
   *
   * @param action `start` / `stop` / `restart`
   * @param model  `start` 时可指定要加载的模型；`stop` 无意义，不传
   * @returns 受理结果（同 `loadModel`：立即返回，进度看 `models()`）
   * @throws 走 `fail()`：`stop` 的兜底文案是「停止模型服务失败」，其余为「启动…失败」
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
   *
   * ⚠️ 同样受 `MODEL_CONTROL_ENABLED` 门控（中转档前端不启停模型）。
   *
   * @param forward 正向模型目录名；省略 = 用后端默认
   * @returns 「已开始加载」的受理结果
   * @throws 走 `fail()`：模型不存在 / 加载发起失败时抛 `RetroApiError`
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
   *
   * @param text 结构文本（CDXML 内容），`kind:'auto'` 让后端自己判别
   * @returns canonical SMILES；**解析失败不是异常**，而是 `ok:false` + `reasons`（人话诊断）
   *          + `suggestions`（一键修复候选）—— 界面要展示这些，所以正常返回
   * @throws 走 `fail()`：仅网络/后端 5xx 才抛
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
   * 查物质档案（CAS 号 / 名称 → 结构 + 物性）。
   *
   * 🔴 为什么 CAS 查结构要走**后端**而不是像原来那样前端直连 PubChem：
   *    ChemIndex **没有** CORS 头，浏览器直连必被拒；而且它有 JS 反爬挑战
   *    （要把响应里的 `_0x2` 写进 `HW_CHECK` cookie 再重发），纯 HTTP 客户端
   *    第一发就吃一个「安全检查」页。⇒ 只能由服务端代理。
   *    PubChem 本来能直连，但为了两个源**统一入口**，也一起走这里。
   *
   * @param terms CAS 号（如 `50-78-2`）或物质名称（如 `aspirin`）
   * @param source `pubchem`（默认，结构为主）或 `chemindex`（物性/危害更全）
   * @param choice 不传则后端按形态自己猜（像 CAS 就按 cas 查）
   * @returns 查到的字段；**查无此物不是异常**，而是 `{ok:false, found:false}`
   * @throws 走 `fail()`：网络 / 后端 5xx / 上游被反爬拦住（502）
   */
  async substance(
    terms: string,
    source: SubstanceSource = 'pubchem',
    choice?: SubstanceChoice
  ): Promise<SubstanceApi & SubstanceInfo> {
    try {
      const { data } = await retroClient.post<SubstanceApi & SubstanceInfo>(
        '/substance',
        { terms, source, choice }
      );
      return data;
    } catch (e) {
      fail(e, '物质查询失败');
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
   *
   * @param smiles     目标产物 canonical SMILES
   * @param model      模型目录名
   * @param numResults 要返回几条路线
   * @param signal     取消信号（可选）
   * @returns 预测结果；**Flask 校验失败（HTTP 400）也 resolve**，返回体里的
   *          `reasons` / `suggestions` 原样带回（见上文 why）
   * @throws 走 `fail()`：非 400 的失败才抛 `RetroApiError`
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
   *
   * @param smiles     目标产物 canonical SMILES
   * @param model      模型目录名
   * @param numResults 单步要给的路线条数
   * @returns 只含 `job_id` 的受理结果 —— **没有结果**，结果在轮询里
   * @throws 走 `fail()`：模型未加载 / 任务创建失败时抛 `RetroApiError`
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
   *
   * @param smiles 目标产物 canonical SMILES
   * @param params 搜索预算与约束（见签名内联类型）；`algorithm` 缺省 `retro_star`，
   *               `forwardTopK` 缺省 5；`useForwardFilter` 为真但正向模型未就绪时，
   *               会在**轮询首个快照**里给出原因，不是在这里报错
   * @returns 只含 `job_id` 的受理结果
   * @throws 走 `fail()`：预算非法 / 搜索任务创建失败时抛 `RetroApiError`
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

  /**
   * 查询任务快照。since 只取 seq 大于它的日志行（增量，避免重复拉）。
   * 🔴 用短超时客户端：网络/超时错误抛 `transient:true`，由轮询循环决定是否重试。
   *
   * @param jobId 任务 id（`createJob` / `createSearchJob` 返回的）
   * @param since 已消费到的日志 seq，默认 0 = 拉全量
   * @returns 任务快照（进度、增量日志、结果或失败原因）
   * @throws 抛 `RetroApiError`，调用方**必须看 `transient`**：
   *         · `transient:true`（超时/网络）→ 轮询应重试
   *         · `transient:false`（404 任务丢失 / 410 上游重启丢结果）→ 停止轮询并提示用户
   *           （`state:'stale'` 是 Node 中转专有，已在内部转成 410）
   */
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

  /**
   * 请求取消。
   * ⚠️ 只在**阶段边界**生效：模型加载、正在跑的推理本身不可中断，
   *    所以返回 `ok:true` 不代表任务已经停下。
   *
   * @param jobId 要取消的任务 id
   * @returns 后端的受理结果（`ok` + 可选 `message`）
   * @throws 走 `fail()`：任务不存在等抛 `RetroApiError`
   */
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

export { retroApi };
