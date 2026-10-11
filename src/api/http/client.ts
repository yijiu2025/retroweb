/**
 * 平台（Node / Fastify 3000）的 axios 实例 —— **传输层**。
 *
 * 本文件只负责三件事，都与"哪个业务接口"无关：
 *   ① 建实例（baseURL / 超时 / 带 cookie / 设备头）
 *   ② 拆响应信封 `{code,message,data}` → `data`
 *   ③ 把 401 交给会话模块（`./session`）处理
 *
 * ── 分层约定 ──
 *   传输层（`http/`）的判据：**只认"有没有收到响应"，不认"哪个业务字段"**。
 *   任何业务专用的字段解读（`{error}` vs `{message}` 的差异、模型状态、任务快照……）
 *   都不许出现在这一层，否则换个业务域就得复制一份实例。
 *   ⚠️ 反面教材就在本项目里：`retro.ts` 里的 `fail()` 曾在传输层解读 `{error}`，
 *      因为那层同时服务两个后端、两种错误形状 ⇒ 只能各写各的。
 *      现在 `fail()` 已下沉到 `api/retro/errors.ts`。
 *
 * ── 与直连 Python 的区别 ──
 *   直连算法服务（`api/retro/client.ts`）**不拆信封** —— Flask 回的是裸 JSON。
 *   两套实例因此必须分开，不是重复代码，是协议不同。
 *
 * @author yijiu2025
 * @since 2026-10-11
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
import { intercept401, setRefreshFn } from './session';

/** Node 后端的统一响应信封 */
interface Envelope<T = unknown> {
  /** 业务码：200 / 0 视为成功，其余一律 reject（约定与 posecraft 同款） */
  code: number;
  /** 失败时的说明，成功时通常缺省 */
  message?: string;
  /** 真正的业务负载 —— 拆包后交给调用方的就是它 */
  data?: T;
}

/**
 * 续期专用实例：**不进 401 拦截器**。
 *
 * 🔴 为什么必须独立：若它走同一个拦截器，续期请求自己返回 401 时会被再次接管 →
 *    再发一次续期 → 无限递归。要让 session 模块知道续期端点，又不能让它 import
 *    本模块（成环），故在这里用 `setRefreshFn` 反向注入。
 */
const refreshClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' }
});

setRefreshFn(() => refreshClient.post('/auth/v1/refresh-session'));

/**
 * 建一个**已拆信封**的 axios 实例。
 *
 * @param baseURL 服务根（通常是 `API_BASE_URL`）
 * @returns 装好「设备头 + 拆信封 + 401 接管」的实例；业务拿到的响应值就是 `data`
 *          （返回类型被断言成 `HttpClient`，见上方注释里为什么可以这么做）
 */
function createHttp(baseURL: string): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 30000,
    withCredentials: true,
    headers: { 'Content-Type': 'application/json' }
  });

  // 设备标识：后端按它做「换设备免切登录」等判定，前端是唯一知道它的层
  instance.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    config.headers['x-device-id'] = getDeviceId();
    return config;
  });

  // 拆信封：把 `{code,message,data}` 变成 `data` 直接返回 ——
  // 这与 axios 的签名（应返回 AxiosResponse）不一致是**有意为之**，故显式断言；
  // 调用侧拿到的就是业务数据（见下方 `HttpClient` 接口）。
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
    // 401 → 续期 / 登录流（与 retro 的三个实例共用同一套）
    const handled = intercept401(error, instance);
    if (handled) return handled;
    const message = error?.response?.data?.message || error?.message || '网络异常';
    return Promise.reject(new Error(message));
  });

  return instance;
}

/**
 * 拆信封后的客户端形态：调用方 `apiClient.get<UserInfo>(...)` 直接得到 `UserInfo`。
 *
 * 每个方法都返回**业务数据**（`Envelope.data`），而非 axios 的 `AxiosResponse`。
 * 🔴 这不是笔误：`createHttp` 的响应拦截器刻意做了拆包（信封是 Node 后端的统一约定），
 *    业务侧不该在每个调用点重复 `.data.data`。
 */
interface HttpClient {
  /** GET；`config` 可传 params / timeout / signal 等 */
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>;
  /** POST；`data` 为请求体 */
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  /** PUT；`data` 为请求体 */
  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  /** DELETE；部分参数走 query，用 `config.params` */
  delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>;
  /** 其余方法（自定义 verb 等） */
  request<T = unknown>(config: AxiosRequestConfig): Promise<T>;
}

const rawClient = createHttp(API_BASE_URL);

/**
 * 对外：已拆信封的平台客户端（`apiClient` 是 `authApi` / `nodeLlmApi` 等的唯一通道）。
 *
 * @throws 非 2xx 时 reject：401 走登录流并带哨兵；其余错误已被归一成
 *         `new Error(后端 message || '网络异常')`（不再有 axios 的壳）
 */
const apiClient = rawClient as unknown as HttpClient;

export { apiClient, refreshClient };

export type { HttpClient, Envelope };

export default apiClient;
