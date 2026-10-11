/**
 * oauth21 iframe（/mini-login）与宿主之间的 postMessage 契约。
 *
 * 用 zod 判别联合收敛，避免 `event.data as any` —— 外部输入必须过窄接口。
 * 消息类型与 posecraft / firewall 的实现完全一致（SSO_READY / LOGIN_SUCCESS /
 * MAX_SESSIONS / SSO_DENIED），oauth21 侧的发送方在 `oauth21/src/utils/parent.ts`。
 */
import { z } from 'zod';

const SsoUserSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  uid: z.string().optional(),
  username: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  avatar: z.string().optional()
});

type SsoUser = z.infer<typeof SsoUserSchema>;

const SsoMessageSchema = z.discriminatedUnion('type', [
  /** iframe 内 Vue 已 mount、监听器已就绪 —— 真正的握手信号（不是 @load） */
  z.object({ type: z.literal('SSO_READY') }),
  z.object({
    type: z.literal('LOGIN_SUCCESS'),
    /** JWT 模式才有 */
    token: z.string().optional(),
    /** Session 模式：一次性凭证，宿主拿它换自家域 cookie */
    sessionToken: z.string().optional(),
    user: SsoUserSchema.optional(),
    deviceId: z.string().optional(),
    data: z.unknown().optional()
  }),
  z.object({
    type: z.literal('MAX_SESSIONS'),
    sessions: z.number().optional(),
    maxSessions: z.number().optional()
  }),
  z.object({
    type: z.literal('SSO_DENIED'),
    error: z.string().optional(),
    description: z.string().optional()
  })
]);

type SsoMessage = z.infer<typeof SsoMessageSchema>;

/** 父 → iframe：主题同步 */
interface ThemeChangeMessage {
  type: 'THEME_CHANGE';
  isDark: boolean;
}

/** 解析一条 postMessage；非法消息返回 null（宿主静默丢弃，不崩） */
function parseSsoMessage(data: unknown): SsoMessage | null {
  const parsed = SsoMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** 当前登录用户（宿主侧规范化后的形态） */
interface AuthUser {
  uid: string;
  username: string;
  email?: string;
  avatar?: string;
  name?: string;
}

/** 多账号免切用的账号条目 */
interface SavedAccount {
  username: string;
  avatar?: string;
  rememberMe: boolean;
  lastLoginAt: number;
}

export { SsoMessageSchema, parseSsoMessage };

export type { SsoUser, SsoMessage, ThemeChangeMessage, AuthUser, SavedAccount };
