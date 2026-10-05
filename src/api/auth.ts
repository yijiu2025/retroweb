/**
 * 账号 / 会话 API（对齐 posecraft/src/api/auth.ts 的端点口径）
 */
import { apiClient } from './http';
import type { AuthUser } from '@/types/sso';

export interface BindSessionResult {
  user?: Partial<AuthUser> & { uid?: string };
  /** uid 明文，前端存 localStorage 作多账号 key */
  accountKey: string | null;
  /** true=已写凭证 cookie 可免密切换 */
  rememberMe: boolean;
}

export interface UserInfo {
  uid?: string;
  userId?: number | string;
  username?: string;
  email?: string;
  avatar?: string;
  name?: string;
  roles?: string[];
}

export const authApi = {
  /** 当前用户信息（未登录返回 401） */
  getUserInfo: () => apiClient.get<UserInfo>('/user/v1/userinfo'),

  /**
   * 用 iframe 下发的 session_token 换取本域 sid/sid_r cookie。
   * 🔴 失败必须中断登录流程 —— 否则后端没换到 cookie、前端却关了弹窗 = 假登录。
   */
  bindSession: (sessionToken: string) =>
    apiClient.post<BindSessionResult>('/auth/v1/bind-session', { session_token: sessionToken }),

  /** 退出登录（清 sid/sid_r，保留免切凭证 cookie） */
  clearCookie: () => apiClient.post('/auth/v1/clear-cookie'),

  /** sid 过期时用 sid_r 换新 sid */
  refreshSession: () => apiClient.post('/auth/v1/refresh-session'),

  /** 免密切换账号（accountKey = uid） */
  switchAccount: (accountKey: string) =>
    apiClient.post<BindSessionResult & { user?: UserInfo }>('/auth/v1/switch-account', { accountKey }),

  /** 忘掉该账号（撤销记住我凭证） */
  revokeSavedAccount: (accountKey: string) =>
    apiClient.post('/auth/v1/saved-accounts/revoke', { accountKey })
};
