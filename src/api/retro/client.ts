/**
 * 算法服务（Python 8000 / Node 中转）的 axios 实例与错误归一 —— **传输层**。
 *
 * 本文件只负责：
 *   ① 按当前档位决定 baseURL（直连 Python vs 走 Node 中转）
 *   ② 建三个实例（普通 / 轮询 / 长超时 LLM），并统一挂上 401 拦截器
 *   ③ 把两种后端的错误体**归一**成 `RetroApiError`
 *
 * ── 为什么与 `api/http/client.ts` 分开 ──
 *   两者的**协议不同**：Node 回 `{code,message,data}` 信封、Flask 回裸 JSON。
 *   强行合并成一个实例，只会让每个调用点都写 `if (viaNode) ...`。
 *   所以是**两套实例 + 一份档位判断**，而不是一份带分支的实例。
 *
 * ── 三个实例为什么要分开 ──
 *   · `retroClient`      默认 10 分钟超时（模型加载可能很久）
 *   · `retroJobClient`   20 秒超时：轮询 `/jobs/:id` 要频繁调，超时太长会让"停止轮询"变迟钝
 *   · `retroLlmClient`   5 分钟超时：LLM 首字可能要等十几秒
 *   共用同一个实例会让其中一项的取舍污染另外两项。
 *
 * ── 导出面上有什么、给谁用 ──
 *   · 业务层（`compute.ts` / `llm.ts`）：只用三个实例 + `fail()` + `RetroApiError`
 *   · 能力层（`capability/`）：`retroBaseURL` 供 SSE 用（fetch 拼 URL，不经 axios）
 *   · 401 相关（`isUnauthorizedError` 等）从 `@/api/http` 取，本文件只是**转发使用**
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import { API_BASE_URL, RETRO_BASE_URL, RETRO_VIA_NODE } from '@/config/services';
import {
  attachUnauthorizedInterceptor,
  createUnauthorizedError,
  isUnauthorizedError,
  notifyUnauthorized
} from '@/api/http/session';

/**
 * 算法服务 baseURL（随 `VITE_RETRO_VIA_NODE` 切换）。
 *
 * 🔴 关（默认）：`RETRO_BASE_URL`（`/retro` → vite proxy → Flask 直连）。
 * 🔴 开：`API_BASE_URL + '/retroweb/v1'`（走 Node 中转，Python 从公网下线）。
 *
 * 🔴 两套路径**不能混用**：Node 的前缀由后端 `system.json` 的 `prefix` + 组前缀
 *    `joinUrl` 拼成，不是 Python 的 `/api`。
 */
const retroBaseURL: string = RETRO_VIA_NODE ? `${API_BASE_URL}/retroweb/v1` : RETRO_BASE_URL;

/**
 * 响应拆包：Node 中转回 `{code,message,data}` 信封，直连 Python 回裸 JSON。
 * 走 Node 时把 `data` 换进去；直连时原样返回。
 *
 * 🔴 **返回的必须是 `AxiosResponse` 形状（即 `response` 本身），不能是裸负载。**
 *    本目录 **19 个调用点**（`compute.ts` 10 处 + `llm.ts` 9 处）全部写成
 *      `const { data } = await retroClient.get<T>(…)`
 *    —— 它们期待解构出 `.data`。若这里返回裸负载，`const { data }` 会得到 `undefined`，
 *    下游紧接着访问 `res.models` / `res.ok` 就抛
 *      "Cannot read properties of undefined (reading 'models')"。
 *
 *    ⚠️ 这与 `api/http/client.ts` 的**约定相反**：那边 `onFulfilled` 返回裸负载，
 *    所以那边的调用点是 `const user = await apiClient.get<UserInfo>(…)`（不解构）。
 *    **两套约定不同，移植写法时必须连调用点一起改** —— 重构时只改了这里、没改调用点，
 *    就出过上面那个错（且能通过 `vue-tsc`：axios 的类型声明说 `.get()` 返回
 *    `AxiosResponse<T>`，`const { data }` 类型上完全合法，类型检查抓不到）。
 *
 *    ⚠️ 另外「后端没起」时也**不会**暴露本问题：请求直接 reject 走 catch 分支，
 *    只有**后端真的返回了响应**才会走到这里。所以它必须用一个「桩响应」来验证
 *    （见 `.tmp-probe/verify-retro-envelope.cjs`）。
 *
 * @param response axios 响应
 * @returns 同一个 `AxiosResponse`，仅走 Node 时替换其 `data`
 */
function unwrapNodeEnvelope<T>(response: AxiosResponse<T>): AxiosResponse<T> {
  if (!RETRO_VIA_NODE) return response;
  const body = response.data as { code?: number; data?: unknown } | null;
  // 只认「有 data 字段」的信封；否则原样返回（错误体、非信封响应都走这里）
  if (body && typeof body === 'object' && 'data' in body) {
    return { ...response, data: body.data as T };
  }
  return response;
}

/**
 * 算法服务的统一错误。
 *
 * 之所以不用裸 `Error`：轮询循环需要区分「**可重试**的瞬时故障（超时/网络）」与
 * 「**不可重试**的终态（任务已丢失、上游重启）」—— 两者对用户是完全不同的处置。
 */
class RetroApiError extends Error {
  /** 后端 HTTP 状态码；网络层错误无此字段 */
  status?: number;
  /** true = 瞬时故障（可重试）；false = 终态（重试无意义，应提示用户） */
  transient: boolean;
  /**
   * @param message  展示给用户的人话文案
   * @param opts.status     HTTP 状态码（可省）
   * @param opts.transient  是否可重试，**默认 false** —— 宁可让调用方多判一次，
   *                        也不要静默进入无休止的重试
   */
  constructor(message: string, opts: { status?: number; transient?: boolean } = {}) {
    super(message);
    this.name = 'RetroApiError';
    this.status = opts.status;
    this.transient = opts.transient ?? false;
  }
}

/**
 * 统一抛出带上下文的错误 —— **错误归一**（传输层职责）。
 *
 * 🔴 两个字段都要试着取：Python 的失败体是 `{error: "..."}`，而 Node 中转包的是
 *    `{code, message, data}` 信封（见 `api/http/client.ts` 同口径）。只认 `error` 的话，
 *    Node 侧拒绝请求时（配额超限、正向模型未就绪、权限不足……）那些**具体的拒因**
 *    全被丢掉，用户只看到一句 `Request failed with status code 400`。
 *
 * 🔴 先判哨兵：401 若已被会话模块接管（续期失败），冒泡上来的就是
 *    `createUnauthorizedError` —— 它**没有 `.response`**，落到下面的
 *    `res?.status === 401` 会判 false，于是被重新包成普通 Error、**把哨兵弄丢**，
 *    业务侧的 `isAuthFailure` 就瞎了。必须原样抛出。
 *
 * ⚠️ 不要在文案上做判据：Node 回的是 `{message}`、Python 回的是 `{error}`，
 *    一旦哪天措辞变了，正则判据会**静默失效**（`models.ts` 就这么红过一次）。
 *
 * @param err      axios 抛出的原始错误
 * @param fallback 连原始错误里也读不出文案时用的兜底说明
 * @throws **本函数总是抛**（`: never`）：
 *   · 401（含已被接管的）→ 触发登录流 + 抛带哨兵的 Error，业务侧用
 *     `isUnauthorizedError(e)` 让位，**不要再弹错误条**
 *   · 其余 → 抛 `RetroApiError`（`message` 已是人话，`status` 带后端状态码）
 * @returns **永不返回**（`: never`）—— 必定以抛异常结束
 */
function fail(err: unknown, fallback: string): never {
  const res = (err as { response?: { status?: number; data?: Record<string, string> } })?.response;
  const payload = res?.data;
  const message = payload?.error || payload?.message || (err as Error)?.message || fallback;
  if (isUnauthorizedError(err)) throw err;
  // 401 无论从哪个 client 冒出来都归登录流管 —— 与会话模块打**同一个哨兵**，
  // 业务侧才能一视同仁地让位（见 `stores/parts/models.ts` 的 isAuthFailure）。
  //
  // ⚠️ 这个分支只在「重放后仍 401」（`_retry` 已置位，拦截器不再接管）时才走到。
  //    此时**没人**打开登录窗（续期那步成功了），所以这里要主动补一次通知。
  if (res?.status === 401) {
    notifyUnauthorized();
    throw createUnauthorizedError(message);
  }
  const e = new RetroApiError(message, { status: res?.status });
  throw e;
}

/**
 * 建一个不带信封处理的实例（Flask 回裸 JSON）。
 *
 * @param baseURL 服务根（`retroBaseURL`，随档位切换）
 * @param timeout 超时毫秒。**三个实例各取所需**：长任务 10min / 轮询 20s / LLM 5min
 * @returns 装好「带 cookie + 拆 Node 信封」的实例；401 拦截器由调用方集中挂
 *          （见文件末尾的 `forEach(attachUnauthorizedInterceptor)`）
 */
function createInstance(baseURL: string, timeout: number): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout,
    withCredentials: true, // 跨源到 Node 必须带 cookie，否则登录后照样 401
    headers: { 'Content-Type': 'application/json' }
  });
  instance.interceptors.response.use((response) => unwrapNodeEnvelope(response));
  return instance;
}

const retroClient = createInstance(retroBaseURL, 600000);
const retroJobClient = createInstance(retroBaseURL, 20000);
const retroLlmClient = createInstance(retroBaseURL, 300000);

// 🔴 三个实例**都要**挂 401 拦截器：不挂的话 retro 侧的 401 只打哨兵、不触发登录流，
//    于是会话在**使用中**过期时会被「静默吞掉」（既不报错也不弹窗，因为业务侧的
//    `isAuthFailure` 看见哨兵就让位了）。首屏之所以还能弹窗，只是因为
//    `authStore.init()` 恰好走了 apiClient 路径 —— 这种隐性耦合不该存在。
//    集中在这里挂，避免三个实例处各写一遍。
[retroClient, retroJobClient, retroLlmClient].forEach(attachUnauthorizedInterceptor);

export { retroBaseURL, retroClient, retroJobClient, retroLlmClient, RetroApiError, fail };
