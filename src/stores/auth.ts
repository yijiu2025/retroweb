/**
 * 登录态。
 *
 * 登录 UI 完全由 oauth21 的 iframe 提供（/mini-login），本 store 只负责：
 *   ① 持有宿主域的登录态（bind-session 换来的 sid cookie）
 *   ② 记账多账号免切清单
 *   ③ 401 / 过期时打开登录弹窗
 *   ④ 持有当前用户的**权限策略**（allows / denies），供 UI 按权限显示
 *      —— 端点与形状对齐 posecraft（`GET /user/v1/permissions`）。
 *
 * 开发阶段 `VITE_AUTH_BYPASS=true` 时全放行并注入 dev 用户，
 * **不创建 iframe、不发任何登录请求**。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi, type PermissionPolicy, type UserInfo } from '@/api/auth';
import { AUTH_BYPASS } from '@/config/services';
import type { AuthUser, SavedAccount } from '@/types/sso';

const ACCOUNTS_KEY = 'retroweb_saved_accounts';
/** 免登录档的本地权限清单（见 `loadDevPermissions` 的用法说明） */
const DEV_PERMISSIONS_KEY = 'retroweb_dev_permissions';

const DEV_USER: AuthUser = {
  uid: 'dev-user',
  username: '开发者',
  name: '本地开发账号',
  email: 'dev@localhost'
};

/**
 * 权限策略的**唯一**判定：通配符匹配（`*` 全匹配、`xxx:*` 前缀匹配）。
 *
 * 与后端 `framework/api/guard.js` 的 `isPermissionMatch` 同规则，
 * 也与 posecraft `stores/auth.ts` 一致 —— 三处必须同口径，否则会出现
 * 「界面显示了入口、后端却 403」或反过来的割裂。
 */
function isPermissionMatch(pattern: string, target: string): boolean {
  if (pattern === '*') return true;
  if (pattern === target) return true;
  if (pattern.endsWith(':*')) return target.startsWith(pattern.slice(0, -1));
  return false;
}

/** 权限判定：**deny 优先**于 allow（与后端 guard 同口径）。 */
function evaluatePermission(policy: PermissionPolicy, required: string): boolean {
  if (policy.denies.some((p) => isPermissionMatch(p, required))) return false;
  return policy.allows.some((p) => isPermissionMatch(p, required));
}

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

const useAuthStore = defineStore('auth', () => {
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
  /** 当前用户的角色（来自 `GET /user/v1/permissions`） */
  const roles = ref<string[]>([]);
  /** 当前用户的权限策略。**deny 优先**（口径与后端 guard 一致） */
  const permissions = ref<PermissionPolicy>({ allows: [], denies: [] });

  /** 清空权限（登出 / 会话过期 / 换账号时） */
  function clearPermissions(): void {
    roles.value = [];
    permissions.value = { allows: [], denies: [] };
  }

  /**
   * 免登录档的权限来源：**本地 localStorage**。
   *
   * 🔴 为什么必须有：bypass 时后端**没有真实会话**，`/user/v1/permissions` 只会 401。
   *    若不给本地来源，按权限显示的入口（如「模型启用清单」管理页）在 dev **永远出不来**，
   *    等于这条 UI 路径无法验证 —— 只能靠改代码硬编。
   *
   * 用法（浏览器控制台）：
   *   localStorage.setItem('retroweb_dev_permissions', JSON.stringify(['retroweb:admin:model']));
   *   之后刷新页面即可看到该入口。写 `[]` 或删掉该 key ⇒ 无任何权限。
   *
   * ⚠️ 格式只支持**字符串数组**（当作 allows）。denies 的优先级逻辑用
   *    探针 `.tmp-probe/rw-perm/` 验证，不靠这条路模拟 —— 少一个格式少一处歧义。
   */
  function loadDevPermissions(): void {
    let codes: string[] = [];
    try {
      const raw = localStorage.getItem(DEV_PERMISSIONS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        codes = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
      } else {
        console.warn(`[auth] ${DEV_PERMISSIONS_KEY} 不是字符串数组，按无权限处理`);
      }
    } catch (e) {
      console.warn(`[auth] 解析 ${DEV_PERMISSIONS_KEY} 失败，按无权限处理`, e);
    }
    roles.value = [];
    permissions.value = { allows: codes, denies: [] };
  }

  /**
   * 拉当前用户的权限。
   *
   * 🔴 免登录档**不发**这个请求（后端无会话 ⇒ 401 ⇒ 会走 http 的登录流，
   *    而 dev 档本来就是要绕过登录的），改读本地 `retroweb_dev_permissions`。
   */
  async function fetchPermissions(): Promise<void> {
    if (bypass) {
      loadDevPermissions();
      return;
    }
    try {
      const res = await authApi.getPermissions();
      roles.value = res.roles ?? [];
      permissions.value = {
        allows: res.permissions?.allows ?? [],
        denies: res.permissions?.denies ?? []
      };
    } catch (e) {
      // 🔴 拉不到就按「没有任何权限」处理：宁可少显示入口，也绝不能误开放
      console.warn('[auth] 获取权限失败，按无权限处理', e);
      clearPermissions();
    }
  }

  /**
   * 是否持有某权限 —— **仅用于 UI 展示，不是安全边界**。
   *
   * 例：`v-if="auth.hasPermission('retroweb:admin:model')"` 才显示模型管理入口。
   * 🔴 每个写接口仍必须由后端 `requirePermission` 兜底：前端能改、也能被绕过。
   *
   * @param required 单个权限码，支持通配（`retroweb:*`）
   */
  function hasPermission(required: string): boolean {
    if (!loggedIn.value) return false;
    return evaluatePermission(permissions.value, required);
  }

  const isDevUser = computed(() => bypass && loggedIn.value);

  function persistAccounts(): void {
    try {
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(savedAccounts.value));
    } catch {
      /* ignore */
    }
  }

  /**
   * 登录态落地后的数据侧收尾。
   *
   * 🔴 顺序是有讲究的（串行 await，不能并行）：
   *   ① 切持久化通道 —— 必须先完成，否则新用户的数据会写进**上一套实现**里
   *      （未登录走本地 localStorage，登录后走服务端）。do这一步之前，
   *      「用哪个实现」这个问题的答案还是错的。
   *   ② 清旧用户数据 —— 防串号（见 clearLocalData 的注释）。
   *   ③ 登录了才补拉 —— 首屏那批请求是在没 cookie 的时候发的，全失败了；
   *      登录只补凭证、不重放请求，必须显式补一次，否则登录后还是空工作台。
   */
  /**
   * 免登录档首载：**只补拉、不清**（理由见 `init()` 的 bypass 分支）。
   *
   * 顺带把持久化实现钉死在本地：免登录 ⇒ 后端没有真实会话，
   * 走服务端实现只会换来一串 401。
   */
  async function loadDevUserData(): Promise<void> {
    try {
      const { activateServerPersist } = await import('@/stores/persist');
      await activateServerPersist(false);
      const { useWorkspaceStore } = await import('@/stores/workspace');
      await useWorkspaceStore().refreshAfterLogin();
    } catch (e) {
      console.warn('[auth] 免登录档装载本地数据失败', e);
    }
  }

  /** 身份切换：清空上个用户的数据 + 切持久化实现 + （登录后）补拉。 */
  async function syncUserData(next: AuthUser | null): Promise<void> {
    const { activateServerPersist } = await import('@/stores/persist');
    await activateServerPersist(!!next);
    const { useWorkspaceStore } = await import('@/stores/workspace');
    const ws = useWorkspaceStore();
    ws.clearLocalData();
    if (next) await ws.refreshAfterLogin();
  }

  function setUser(next: AuthUser | null): void {
    user.value = next;
    loggedIn.value = !!next;
    // 🔴 权限必须**跟着身份走**：换账号 / 登出 / 过期都要清，
    //    否则会看到上一个用户的权限（切换账号后仍显示管理入口）。
    if (next) void fetchPermissions();
    else clearPermissions();
    // 🔴 登录态变化 = 用户身份切换：清空上个用户的任务数据 + 切持久化实现 + （登录后）补拉。
    //    用懒 import 避免 auth ↔ workspace 循环依赖（workspace 不依赖 auth）。
    void syncUserData(next);
  }

  /** 启动引导：bypass 直接注入 dev 用户；否则拉 userinfo 探活 */
  async function init(): Promise<void> {
    if (initialized.value) return;
    initialized.value = true;
    if (bypass) {
      // 🔴 免登录档**不能走 setUser / syncUserData**（那是"身份切换"路径）：
      //    每次刷新注入的都是**同一个** dev 用户，不是换人，但那条路径会
      //    `persist.clear()` —— 而 bypass + `VITE_PERSIST_SERVER=false` 时它落到
      //    `localAdapter.clear()` ⇒ **每次刷新都抹掉 localStorage 的任务与历史**，
      //    本地持久化在 dev 下直接失效（且无处可恢复）。
      //    这里改成：注入 dev 用户 + 只补拉、**不清**。
      user.value = DEV_USER;
      loggedIn.value = true;
      void fetchPermissions(); // 权限在免登录档走本地 localStorage（见 loadDevPermissions）
      void loadDevUserData();
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
    roles,
    permissions,
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
    hasPermission,
    fetchPermissions,
    addSavedAccount,
    removeSavedAccount,
    switchAccount,
    revokeSavedAccount
  };
});

export { useAuthStore };
