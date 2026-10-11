/**
 * 后端（Fastify 3000）请求封装。
 *
 * 响应信封统一为 `{ code, message, data }`，code===200 才返回 data，否则抛错
 * （与 posecraft/src/utils/request.ts 同口径）。
 *
 * 401 语义：先尝试用 sid_r 续期一次；续期失败才打开登录弹窗（不跳页、不重试）。
 *  - **单飞**：并发 N 个 401 只发一次 `/auth/v1/refresh-session`，其余排队等结果。
 *  - **一次性重放守卫**：重放后若仍 401，不再续期（否则无界循环，见 `intercept401`）。
 *  - **全客户端统一**：本文件的 `apiClient` 与 `api/retro.ts` 的三个 client 都走
 *    `attachUnauthorizedInterceptor`，语义一致（否则 retro 侧的 401 会被静默吞掉）。
 */
import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios';
import { API_BASE_URL } from '@/config/services';
import { getDeviceId } from '@/utils/device';

interface Envelope {
  code?: number;
  message?: string;
  data?: unknown;
}

/** 刷新会话专用实例：不进 401 拦截器，避免 refresh 自身 401 造成递归死锁 */
const refreshClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
});

let isRefreshing = false;
let pendingQueue: Array<(ok: boolean) => void> = [];

/**
 * 401 回调由 bootstrap.ts 注册。
 *
 * 刻意**不用**动态 `import('@/stores/auth')`：auth store 静态依赖 api/auth → http，
 * 再在 http 里反向 import 就成环（且打包器会报 INEFFECTIVE_DYNAMIC_IMPORT）。
 * 改成「http 只暴露一个注册口，装配方注入处理器」，依赖方向保持单向。
 */
let onUnauthorized: ((reason: string) => void) | null = null;

function setUnauthorizedHandler(handler: (reason: string) => void): void {
  onUnauthorized = handler;
}

function requestLogin(reason: string): void {
  onUnauthorized?.(reason);
}

/** 会话过期文案：唯一来源，避免在多处各写一遍导致措辞漂移 */
const SESSION_EXPIRED = '登录已过期，请重新登录';

/**
 * 手动通知「会话已失效」。
 *
 * 供**不走 axios 拦截器**的出口使用：`api/retro.ts` 的 SSE 路径（fetch）与
 * `fail()` 的兜底分支。保证全局只有一个登录弹窗来源，语义与其他客户端一致。
 *
 * @param reason 展示给用户的说明，默认「登录已过期，请重新登录」
 */
function notifyUnauthorized(reason: string = SESSION_EXPIRED): void {
  requestLogin(reason);
}

/**
 * 带「一次性重放」守卫的请求配置。
 *
 * 用局部类型而不是 module augmentation：`AxiosRequestConfig` 是泛型接口，
 * 声明合并要连类型参数一起对齐，为一个私有字段不值当。
 */
type RetriableConfig = AxiosRequestConfig & { _retry?: boolean };

/**
 * 401 专用哨兵。
 *
 * 🔴 为什么需要它：http 拦截器遇到 401 会先尝试续期，彻底失败后 reject 出来的
 *    `Error` 长得跟普通业务错误一模一样（只有 message 不同）。业务侧的 catch
 *    分不清"这次失败已经被登录弹窗接管了"还是"真出了别的岔子"，于是会在
 *    **已经弹窗的同时**再挂一条业务错误条 —— 用户从没登录过，却看到
 *    「登录已过期，请重新登录」，这就是那类误导的来源。
 *    打上标记后，业务侧可以显式判断并让位给统一的登录流。
 */
const UNAUTHORIZED = '__rw_unauthorized__';

/** 造一个「已被登录流接管」的错误 */
function createUnauthorizedError(message: string): Error {
  return Object.assign(new Error(message), { [UNAUTHORIZED]: true });
}

/** 判定：这个错误是不是 401 且已被登录流接管 */
function isUnauthorizedError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as Record<string, unknown>)[UNAUTHORIZED] === true;
}

/**
 * 401 的统一处理：**单飞续期 → 成功则重放，失败则弹登录窗**。
 *
 * 单飞（`isRefreshing` + `pendingQueue`）的意义：并发 N 个请求同时 401 时，
 * 只发**一次** `/auth/v1/refresh-session`，其余排队等结果 —— 否则会打出 N 次续期。
 *
 * @param config - 原始请求配置，重放时原样再发一次
 * @param replay - 重放函数。**必须由调用方传入**：不同 axios 实例的 baseURL 与
 *   拦截器链都不同，用同一个实例重放 retro 的请求会打错地址。
 * @returns 续期成功 → 重放结果；失败 → reject 一个带哨兵的 `createUnauthorizedError`
 */
async function handle401(
  config: AxiosRequestConfig,
  replay: (config: AxiosRequestConfig) => Promise<unknown>
): Promise<unknown> {
  if (!isRefreshing) {
    isRefreshing = true;
    try {
      await refreshClient.post('/auth/v1/refresh-session');
      pendingQueue.forEach((cb) => cb(true));
      pendingQueue = [];
      return replay(config);
    } catch (e) {
      // 🔴 必须留痕：原先这里是空 `catch {}`，线上「用户为什么突然弹登录窗」无从查证
      //    —— 401（续期票也废了）/ 网络断 / 超时，三种原因的处置完全不同。
      console.warn('[http] 会话续期失败，转入登录流程', e);
      pendingQueue.forEach((cb) => cb(false));
      pendingQueue = [];
      requestLogin(SESSION_EXPIRED);
      return Promise.reject(createUnauthorizedError(SESSION_EXPIRED));
    } finally {
      isRefreshing = false;
    }
  }
  return new Promise((resolve, reject) => {
    pendingQueue.push((ok) => {
      if (ok) resolve(replay(config));
      else reject(createUnauthorizedError(SESSION_EXPIRED));
    });
  });
}

/**
 * 401 判定 + 接管（所有 axios 实例共用的唯一入口）。
 *
 * 🔴 `_retry` 守卫为什么必须有：续期成功后重放请求，若**仍然 401**，
 *    没有守卫就会再进一次续期 → 再重放 → **无界循环**，把 `/auth/v1/refresh-session`
 *    和目标接口打成风暴。
 *
 *    为什么原先用 `isRefreshing` 挡不住：`handle401` 里是
 *    `try { return replay(config) } finally { isRefreshing = false }` ——
 *    JS 中 `finally` 在处理完 return 表达式后**立即**执行，**不等**那个 promise settle。
 *    实测（2026-10-11）重放回来时 `isRefreshing` 早已是 false ⇒ 重放再 401 就会
 *    重新进入续期分支。所以守卫必须记在**请求配置**上（随请求走），而不是记在模块状态上。
 *
 * @param error - axios 抛出的错误
 * @param instance - 该错误所属的实例（重放走它自己）
 * @returns 非 401、或没有 config 时返回 null（调用方自行处理）；否则返回接管后的 Promise
 *   —— 首轮 401 走「续期 + 重放」，重放后仍 401 则直接弹登录窗并抛哨兵。
 */
function intercept401(error: AxiosError, instance: AxiosInstance): Promise<unknown> | null {
  if (error?.response?.status !== 401) return null;
  const config = error?.config as RetriableConfig | undefined;
  if (!config) return null;

  if (config._retry) {
    // 已经「续期 + 重放」过一轮，**仍然 401** ⇒ 会话确实是坏的（不是票过期那种可自愈的）。
    // 此时要把话说完：弹登录窗，并抛**哨兵**（而不是让原生 AxiosError 冒上去）。
    // 🔴 若只让原生错误冒泡，调用方拿到的是「长得像普通业务错误」的东西 ⇒
    //    业务侧不会让位，于是界面既没有登录窗、又多一条看不懂的错误条。
    requestLogin(SESSION_EXPIRED);
    return Promise.reject(createUnauthorizedError(SESSION_EXPIRED));
  }

  config._retry = true;
  return handle401(config, (c) => instance(c));
}

/**
 * 给任意 axios 实例挂上 401 拦截器。
 *
 * 抽成公开函数是为了让 `api/retro.ts` 的三个 client 复用**同一套**语义：
 * 原先只有本文件的 `apiClient` 会弹登录窗，retro 侧的 401 只打哨兵、不触发登录流
 * ⇒ 会话在**使用中**过期时会被「静默吞掉」（既不报错也不弹窗，因为业务侧的
 * `isAuthFailure` 看见哨兵就让位了）。首屏之所以还能弹窗，只是因为
 * `authStore.init()` 恰好走了 apiClient 路径 —— 这种隐性耦合不该存在。
 *
 * ⚠️ 只处理 401，其余错误**原样透传** —— retro 自己的错误语义在 `fail()` 里，
 *    不能被这里的 message 改写覆盖。
 *
 * @param instance - 目标实例；重放走它自己，保证 baseURL / 拦截器链一致
 */
function attachUnauthorizedInterceptor(instance: AxiosInstance): void {
  instance.interceptors.response.use(undefined, (error: AxiosError) => {
    return intercept401(error, instance) ?? Promise.reject(error);
  });
}

function createHttp(baseURL: string): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 30000,
    withCredentials: true,
    headers: { 'Content-Type': 'application/json' }
  });

  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    config.headers['x-device-id'] = getDeviceId();
    return config;
  });

  // 拦截器把 `{code,message,data}` 拆成 data 返回 —— 这与 axios 的签名
  // （应返回 AxiosResponse）不一致是**有意为之**，故显式断言；调用侧拿到的
  // 就是业务数据（见下方 HttpClient 接口）。
  const onFulfilled = ((response: AxiosResponse<Envelope>) => {
    const res = response.data;
    if (res && (res.code === 200 || res.code === 0)) return res.data;
    const error = new Error(res?.message || '请求失败');
    (error as Error & { code?: number }).code = res?.code;
    return Promise.reject(error);
  }) as unknown as (
    value: AxiosResponse<Envelope>
  ) => AxiosResponse<Envelope> | Promise<AxiosResponse<Envelope>>;

  instance.interceptors.response.use(onFulfilled, (error: AxiosError<Envelope>) => {
    // 401 → 续期 / 登录流（与 retro 的三个 client 共用同一套）
    const handled = intercept401(error, instance);
    if (handled) return handled;
    const message = error?.response?.data?.message || error?.message || '网络异常';
    return Promise.reject(new Error(message));
  });

  return instance;
}

/**
 * 拆信封后的客户端形态：调用方 `apiClient.get<UserInfo>(...)` 直接得到 `UserInfo`。
 */
interface HttpClient {
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>;
  request<T = unknown>(config: AxiosRequestConfig): Promise<T>;
}

const rawClient = createHttp(API_BASE_URL);

/** 对外：已拆信封的客户端 */
const apiClient = rawClient as unknown as HttpClient;

export {
  setUnauthorizedHandler,
  notifyUnauthorized,
  createUnauthorizedError,
  isUnauthorizedError,
  attachUnauthorizedInterceptor,
  apiClient
};

export type { HttpClient };

export default apiClient;
