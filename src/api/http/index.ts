/**
 * 平台 HTTP 的**统一出口**。
 *
 * 业务代码只从这里 import。三块内容各自的职责见各子文件头：
 *   · `client`   —— axios 实例与信封拆包
 *   · `session`  —— 401 的唯一语义（单飞续期 / 登录流 / 哨兵）
 *   · `sse`      —— SSE 分帧读取
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
export { apiClient } from './client';
export type { Envelope, HttpClient } from './client';
export {
  SESSION_EXPIRED,
  setUnauthorizedHandler,
  setRefreshFn,
  notifyUnauthorized,
  createUnauthorizedError,
  isUnauthorizedError,
  attachUnauthorizedInterceptor
} from './session';
export type { LoginNotifier } from './session';
export { postSse } from './sse';
