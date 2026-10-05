/**
 * 后端（Fastify 3000）请求封装。
 *
 * 响应信封统一为 `{ code, message, data }`，code===200 才返回 data，否则抛错
 * （与 posecraft/src/utils/request.ts 同口径）。
 *
 * 401 语义：先尝试用 sid_r 续期一次；续期失败才打开登录弹窗（不跳页、不重试）。
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
 * 401 回调由 main.ts 注册。
 *
 * 刻意**不用**动态 `import('@/stores/auth')`：auth store 静态依赖 api/auth → http，
 * 再在 http 里反向 import 就成环（且打包器会报 INEFFECTIVE_DYNAMIC_IMPORT）。
 * 改成「http 只暴露一个注册口，装配方注入处理器」，依赖方向保持单向。
 */
let onUnauthorized: ((reason: string) => void) | null = null;

export function setUnauthorizedHandler(handler: (reason: string) => void): void {
  onUnauthorized = handler;
}

function requestLogin(reason: string): void {
  onUnauthorized?.(reason);
}

/** 401 重试用原始实例（避免再次触发拦截器递归） */
let replay: (config: AxiosRequestConfig) => Promise<unknown> = () => Promise.reject(new Error('未初始化'));

async function handle401(config: AxiosRequestConfig): Promise<unknown> {
  if (!isRefreshing) {
    isRefreshing = true;
    try {
      await refreshClient.post('/auth/v1/refresh-session');
      pendingQueue.forEach((cb) => cb(true));
      pendingQueue = [];
      return replay(config);
    } catch {
      pendingQueue.forEach((cb) => cb(false));
      pendingQueue = [];
      requestLogin('登录已过期，请重新登录');
      return Promise.reject(new Error('登录已过期，请重新登录'));
    } finally {
      isRefreshing = false;
    }
  }
  return new Promise((resolve, reject) => {
    pendingQueue.push((ok) => {
      if (ok) resolve(replay(config));
      else reject(new Error('登录已过期，请重新登录'));
    });
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
    if (error?.response?.status === 401 && error.config) {
      return handle401(error.config as AxiosRequestConfig);
    }
    const message = error?.response?.data?.message || error?.message || '网络异常';
    return Promise.reject(new Error(message));
  });

  return instance;
}

/**
 * 拆信封后的客户端形态：调用方 `apiClient.get<UserInfo>(...)` 直接得到 `UserInfo`。
 */
export interface HttpClient {
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  put<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T>;
  delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<T>;
  request<T = unknown>(config: AxiosRequestConfig): Promise<T>;
}

const rawClient = createHttp(API_BASE_URL);
replay = (config: AxiosRequestConfig) => rawClient(config);

/** 对外：已拆信封的客户端 */
export const apiClient = rawClient as unknown as HttpClient;

export default apiClient;
