/**
 * 账号 / 会话 API —— 端点口径对齐 `posecraft/src/api/auth.ts`。
 *
 * 覆盖三组端点（都走 Node 后端，直连 Python 档没有这些）：
 *   · `POST /auth/v1/bind-session` —— oauth21 登录成功后，用本域 cookie 换身份
 *   · `GET  /user/v1/userinfo`     —— 启动探活 + 当前用户资料
 *   · `GET  /user/v1/permissions`  —— 权限策略（allows / denies）
 *
 * 🔴 **权限下发的形状必须与后端 `guard.js` 同口径**：deny 优先于 allow，
 *    通配规则 `*` 全匹配 / `xxx:*` 前缀匹配。判定函数在 `stores/auth.ts`，
 *    本文件只负责把数据原样取回来。
 *
 * 依赖：只认 `@/api/http` 的 `apiClient`（已拆信封的实例），不碰任何 store。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { apiClient } from './http';
import type { AuthUser } from '@/types/sso';

/** `POST /auth/v1/bind-session` 的响应：本域身份 + 免密切换所需的账号标识 */
interface BindSessionResult {
  /** 后端认下来的用户资料（字段可能缺，调用方要容错） */
  user?: Partial<AuthUser> & { uid?: string };
  /** uid 明文，前端存 localStorage 作多账号 key */
  accountKey: string | null;
  /** true=已写凭证 cookie 可免密切换 */
  rememberMe: boolean;
}

/** `GET /user/v1/userinfo` 的响应 */
interface UserInfo {
  uid?: string;
  userId?: number | string;
  username?: string;
  email?: string;
  avatar?: string;
  name?: string;
  /** 角色 code 列表（如 `retroweb_admin`）；前端不用它判权限，只做展示 */
  roles?: string[];
}

/** 权限策略：允许 / 拒绝两张清单（口径与后端 `guard` 一致：**deny 优先**） */
interface PermissionPolicy {
  /** 允许的权限码，支持 `*`（全匹配）与 `xxx:*`（前缀匹配） */
  allows: string[];
  /** 拒绝的权限码，优先级高于 allows（同名时拒绝生效） */
  denies: string[];
}

/** `GET /user/v1/permissions` 的响应（与 posecraft 同端点、同形状） */
interface PermissionsResult {
  /** 角色 code 列表（`${appId}_admin` 这类） */
  roles?: string[];
  /** 权限策略；缺字段按空表处理（= 无权限），不要乐观默认放行 */
  permissions?: Partial<PermissionPolicy>;
}

const authApi = {
  /**
   * 当前用户信息。
   *
   * @returns 用户资料；**未登录时后端返回 401** ⇒ 抛带哨兵的 Error
   *          （`isUnauthorizedError(e)` 为 true，业务侧应让位给登录流、不要再弹错误条）
   */
  getUserInfo: () => apiClient.get<UserInfo>('/user/v1/userinfo'),

  /**
   * 当前用户的角色与权限。
   *
   * 🔴 这是**前端唯一**的权限来源（与 posecraft 完全同款端点）：
   *    Node 侧 `src/api/user/v1/user.js` 的 `GET /user/v1/permissions`，
   *    内部走 `permission-loader` / `perm-cache` 算出 `allows` / `denies`。
   *    没有它，前端就不知道该不该给某个用户显示管理入口。
   *
   * ⚠️ **只用于 UI 展示**。每个写接口仍必须由后端 `requirePermission` 兜底 ——
   *    前端隐藏只是体验，不是安全（与 posecraft `stores/auth.ts` 的注释同义）。
   *
   * @returns 角色 + 权限策略
   * @throws 拉取失败（401 / 网络）时抛 Error。**调用方须按"无权限"兜底**，
   *         不要抛错 —— 权限接口挂着不该让整个应用起不来
   */
  getPermissions: () => apiClient.get<PermissionsResult>('/user/v1/permissions'),

  /**
   * 用 iframe 下发的 session_token 换取本域 sid/sid_r cookie。
   * 🔴 失败必须中断登录流程 —— 否则后端没换到 cookie、前端却关了弹窗 = 假登录。
   *
   * @param sessionToken oauth21 `/mini-login` 通过 postMessage 下发的会话票据
   * @returns 换到的身份 + `accountKey`（存 localStorage 供多账号切换）+ `rememberMe`
   * @throws 票据无效/过期时抛 Error；调用方**必须**据此中断，不要关弹窗
   */
  bindSession: (sessionToken: string) =>
    apiClient.post<BindSessionResult>('/auth/v1/bind-session', { session_token: sessionToken }),

  /**
   * 退出登录（清 sid/sid_r，保留免切凭证 cookie）。
   *
   * @returns 后端受理结果；清完 sid 后再来的请求会 401，走正常登录流
   */
  clearCookie: () => apiClient.post('/auth/v1/clear-cookie'),

  /**
   * sid 过期时用 sid_r 换新 sid。
   *
   * ⚠️ 只应由 `http/session.ts` 的单飞续期调用（它挂了**不带 401 拦截器**的实例）；
   *    业务代码直接调会在失败时递归触发续期。
   *
   * @returns 换发结果
   */
  refreshSession: () => apiClient.post('/auth/v1/refresh-session'),

  /**
   * 免密切换账号（accountKey = uid）。
   *
   * @param accountKey 目标账号的 uid（`bindSession` 返回的 `accountKey`）
   * @returns 切换后的用户资料 + 是否仍处于"记住我"状态
   * @throws 凭证已撤销时抛 Error ⇒ 调用方应退回到登录弹窗
   */
  switchAccount: (accountKey: string) =>
    apiClient.post<BindSessionResult & { user?: UserInfo }>('/auth/v1/switch-account', { accountKey }),

  /**
   * 忘掉该账号（撤销记住我凭证）。
   *
   * @param accountKey 要忘掉的账号 uid
   * @returns 后端受理结果；撤销后 `switchAccount` 再换它会失败
   */
  revokeSavedAccount: (accountKey: string) =>
    apiClient.post('/auth/v1/saved-accounts/revoke', { accountKey })
};

export { authApi };

export type { BindSessionResult, UserInfo, PermissionPolicy, PermissionsResult };
