/**
 * 登录态。
 *
 * 登录 UI 完全由 oauth21 的 iframe 提供（/mini-login），本 store 只负责：
 *   ① 持有宿主域的登录态（bind-session 换来的 sid cookie）
 *   ② 记账多账号免切清单
 *   ③ 401 / 过期时打开登录弹窗
 *
 * 开发阶段 `VITE_AUTH_BYPASS=true` 时全放行并注入 dev 用户，
 * **不创建 iframe、不发任何登录请求**。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi, type UserInfo } from '@/api/auth';
import { AUTH_BYPASS } from '@/config/services';
import type { AuthUser, SavedAccount } from '@/types/sso';

const ACCOUNTS_KEY = 'retroweb_saved_accounts';

const DEV_USER: AuthUser = {
  uid: 'dev-user',
  username: '开发者',
  name: '本地开发账号',
  email: 'dev@localhost'
};

function readAccounts(): Record<string, SavedAccount> {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, SavedAccount>;
  } catch {
    /* ignore */
  }
  return {};
}

function normalizeUser(info: UserInfo | undefined): AuthUser | null {
  if (!info) return null;
  return {
    uid: String(info.uid ?? info.userId ?? ''),
    username: info.username || info.name || info.email || '用户',
    email: info.email,
    avatar: info.avatar,
    name: info.name
  };
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AuthUser | null>(null);
  const loggedIn = ref(false);
  const initialized = ref(false);
  const checking = ref(false);
  const loginVisible = ref(false);
  const pendingRedirect = ref<string | null>(null);
  const savedAccounts = ref<Record<string, SavedAccount>>(readAccounts());
  const lastError = ref<string | null>(null);

  /** 免登录模式（dev 默认开） */
  const bypass = AUTH_BYPASS;
  const isDevUser = computed(() => bypass && loggedIn.value);

  function persistAccounts(): void {
    try {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(savedAccounts.value));
    } catch {
      /* ignore */
    }
  }

  function setUser(next: AuthUser | null): void {
    user.value = next;
    loggedIn.value = !!next;
    // 🔴 登录态变化 = 用户身份切换：清空上个用户的任务数据 + 切持久化实现。
    //    用懒 import 避免 auth ↔ workspace 循环依赖（workspace 不依赖 auth）。
    void import('@/stores/workspace').then(({ useWorkspaceStore }) => {
      useWorkspaceStore().clearLocalData();
    });
    void import('@/stores/persist').then(({ activateServerPersist }) => {
      void activateServerPersist(!!next);
    });
  }

  /** 启动引导：bypass 直接注入 dev 用户；否则拉 userinfo 探活 */
  async function init(): Promise<void> {
    if (initialized.value) return;
    initialized.value = true;
    if (bypass) {
      setUser(DEV_USER);
      return;
    }
    checking.value = true;
    try {
      const info = await authApi.getUserInfo();
      setUser(normalizeUser(info));
    } catch {
      setUser(null);
    } finally {
      checking.value = false;
    }
  }

  function openLogin(redirect?: string): void {
    if (bypass) return;
    if (redirect) pendingRedirect.value = redirect;
    loginVisible.value = true;
  }

  /**
   * 登录成功后的落地：写用户态 + 记账多账号。
   * 只在 bind-session 成功后调用 —— 失败必须中断，绝不静默关窗（否则是假登录）。
   */
  function applyLogin(info: AuthUser, accountKey: string | null, rememberMe: boolean): void {
    setUser(info);
    lastError.value = null;
    if (accountKey) addSavedAccount(info, accountKey, rememberMe);
  }

  function closeLogin(): void {
    loginVisible.value = false;
  }

  /** 401 / 会话过期：清空登录态并弹窗（保留跳转意图） */
  function markExpired(reason?: string): void {
    if (bypass) return;
    setUser(null);
    if (reason) lastError.value = reason;
    openLogin();
  }

  async function logout(): Promise<void> {
    if (bypass) {
      // 免登录模式下"退出"只是清 UI，不调后端
      setUser(null);
      return;
    }
    try {
      await authApi.clearCookie();
    } catch {
      /* 清 cookie 失败也要清前端状态 */
    }
    setUser(null);
  }

  /** 记录已登录账号（accountKey = uid） */
  function addSavedAccount(info: AuthUser, accountKey: string, rememberMe: boolean): void {
    savedAccounts.value = {
      ...savedAccounts.value,
      [accountKey]: {
        username: info.username,
        avatar: info.avatar,
        rememberMe,
        lastLoginAt: Date.now()
      }
    };
    persistAccounts();
  }

  function removeSavedAccount(accountKey: string): void {
    const next = { ...savedAccounts.value };
    delete next[accountKey];
    savedAccounts.value = next;
    persistAccounts();
  }

  /** 免密切换（rememberMe=false 的账号无凭证，调用方应先跳 iframe 登录） */
  async function switchAccount(accountKey: string): Promise<boolean> {
    try {
      const res = await authApi.switchAccount(accountKey);
      const next = normalizeUser(res?.user);
      if (next) {
        setUser(next);
        const exist = savedAccounts.value[accountKey];
        if (exist) {
          savedAccounts.value = { ...savedAccounts.value, [accountKey]: { ...exist, lastLoginAt: Date.now() } };
          persistAccounts();
        }
      }
      return true;
    } catch {
      // 凭证失效：删掉这条，让 UI 走 iframe 登录
      removeSavedAccount(accountKey);
      return false;
    }
  }

  async function revokeSavedAccount(accountKey: string): Promise<void> {
    try {
      await authApi.revokeSavedAccount(accountKey);
    } catch {
      /* 后端撤销失败也要从本地移除 */
    }
    removeSavedAccount(accountKey);
  }

  return {
    user,
    loggedIn,
    initialized,
    checking,
    loginVisible,
    pendingRedirect,
    savedAccounts,
    lastError,
    bypass,
    isDevUser,
    init,
    openLogin,
    closeLogin,
    markExpired,
    logout,
    applyLogin,
    addSavedAccount,
    removeSavedAccount,
    switchAccount,
    revokeSavedAccount
  };
});
