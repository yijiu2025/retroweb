/**
 * oauth21 iframe 登录的 postMessage 收发（单一入口）。
 *
 * 🔴 安全校验两条都要（缺一条就能被伪造 LOGIN_SUCCESS 注入攻击者会话）：
 *   ① event.origin === ssoOrigin
 *   ② event.source === iframe.contentWindow
 *
 * 握手语义：真正的就绪信号是 `SSO_READY`（iframe 内 Vue 已 mount），
 * **不是** `@load` —— @load 只保证 HTML 拉完，此时同步主题会丢消息导致闪白。
 * @load 只用来启动 3s 兜底定时器。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { onMounted, onUnmounted } from 'vue';
import { parseSsoMessage, type SsoMessage, type SsoUser } from '@/types/sso';

interface SsoHandlers {
  /** iframe 内应用就绪 */
  onReady?: () => void;
  onLoginSuccess?: (payload: { token?: string; sessionToken?: string; user?: SsoUser; deviceId?: string }) => void;
  onMaxSessions?: (payload: { sessions?: number; maxSessions?: number }) => void;
  onDenied?: (payload: { error?: string; description?: string }) => void;
}

/**
 * @param options.ssoOrigin  允许的来源 origin（**必须校验**，否则任意页面可伪造登录消息）
 * @param options.getIframe 取 iframe 的函数（可能还没挂载，故用函数而非元素）
 * @param options.handlers   各类消息的处理回调
 * @returns 无（void）；在组件 setup 里调用即自动注册/注销 message 监听。
 *          🔴 origin + source **双校验**，两者任一不符即静默丢弃
 */
function useSsoMessage(options: {
  ssoOrigin: string;
  getIframe: () => HTMLIFrameElement | null;
  handlers: SsoHandlers;
}) {
  const { ssoOrigin, getIframe, handlers } = options;

  const handleMessage = (event: MessageEvent): void => {
    if (event.origin !== ssoOrigin) return;
    const iframe = getIframe();
    if (!iframe || event.source !== iframe.contentWindow) return;

    const message: SsoMessage | null = parseSsoMessage(event.data);
    if (!message) return; // 非法消息静默丢弃（不崩、不告警刷屏）

    switch (message.type) {
      case 'SSO_READY':
        handlers.onReady?.();
        break;
      case 'LOGIN_SUCCESS':
        handlers.onLoginSuccess?.({
          token: message.token,
          sessionToken: message.sessionToken,
          user: message.user,
          deviceId: message.deviceId
        });
        break;
      case 'MAX_SESSIONS':
        handlers.onMaxSessions?.({ sessions: message.sessions, maxSessions: message.maxSessions });
        break;
      case 'SSO_DENIED':
        handlers.onDenied?.({ error: message.error, description: message.description });
        break;
    }
  };

  /** 父 → iframe：主题同步（oauth21 侧 useParentThemeSync 接收） */
  function postTheme(isDark: boolean): void {
    const iframe = getIframe();
    if (!iframe?.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'THEME_CHANGE', isDark }, ssoOrigin);
  }

  onMounted(() => window.addEventListener('message', handleMessage));
  onUnmounted(() => window.removeEventListener('message', handleMessage));

  return { postTheme };
}

export { useSsoMessage };

export type { SsoHandlers };
