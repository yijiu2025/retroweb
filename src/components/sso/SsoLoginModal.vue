<script setup lang="ts">
/**
 * 登录弹窗壳 —— 登录 UI 完全由 oauth21 的 iframe（/mini-login）提供。
 *
 * 本组件只做三件事：
 *  ① iframe 握手（SSO_READY 才关 loading，@load 只启动 3s 兜底）
 *  ② 收 LOGIN_SUCCESS → adoptDeviceId → bind-session 换本域 cookie
 *  ③ 多账号免切（有历史账号时先出账号列表）
 *
 * 🔴 注册 / 忘记密码 / 邮箱二次验证 / 设备超限全部由 iframe 内 oauth21 提供，
 *    本应用不自建 —— 视觉永远与 oauth21 一致，协议变更由它自己消化。
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { authApi } from '@/api/auth';
import { buildSsoLoginUrl, LOGIN_COPY, SSO_URL } from '@/config/services';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import { useSsoMessage } from '@/composables/useSsoMessage';
import { adoptDeviceId } from '@/utils/device';
import type { AuthUser, SavedAccount } from '@/types/sso';

const router = useRouter();
const authStore = useAuthStore();
const settings = useSettingsStore();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const loading = ref(true);
const mode = ref<'accounts' | 'login'>('accounts');
const switching = ref(false);
/** SSO_READY 兜底句柄（3s 未握手则强制关 loading，防永久转圈） */
let readyTimer: number | null = null;

const visible = computed({
  get: () => authStore.loginVisible,
  set: (v: boolean) => {
    if (!v) authStore.closeLogin();
  }
});

const accounts = computed<Array<SavedAccount & { accountKey: string }>>(() =>
  Object.entries(authStore.savedAccounts).map(([accountKey, acct]) => ({ accountKey, ...acct }))
);

/** iframe 地址：主题变化时 URL 重新生成（带 theme 参数，首屏不闪白） */
const loginUrl = computed(() => buildSsoLoginUrl(settings.isDark ? 'dark' : 'light'));

/** postMessage 只信任这个 origin */
const ssoOrigin = (() => {
  try {
    return new URL(SSO_URL).origin;
  } catch {
    return SSO_URL;
  }
})();

const { postTheme } = useSsoMessage({
  ssoOrigin,
  getIframe: () => iframeRef.value,
  handlers: {
    onReady: () => {
      if (readyTimer) {
        window.clearTimeout(readyTimer);
        readyTimer = null;
      }
      loading.value = false;
      postTheme(settings.isDark);
    },
    onLoginSuccess: handleLoginSuccess,
    onMaxSessions: (p) => {
      ElMessage.warning(`登录设备数已达上限（${p.sessions ?? '?'} / ${p.maxSessions ?? '?'}），请先退出其他设备`);
      authStore.closeLogin();
    },
    onDenied: (p) => {
      ElMessage.error(p.description || p.error || '授权被拒绝');
    }
  }
});

/** iframe HTML 拉完：只启动兜底，不关 loading（Vue 未必已 mount） */
function onIframeLoad(): void {
  if (readyTimer) window.clearTimeout(readyTimer);
  readyTimer = window.setTimeout(() => {
    console.warn('[SSO] SSO_READY 超时（3s 兜底）。若 oauth21 控制台报「父 origin 未授权」，请把本应用 origin 加进 VITE_ALLOWED_PARENT_ORIGINS');
    loading.value = false;
    postTheme(settings.isDark);
  }, 3000);
}

async function handleLoginSuccess(payload: {
  token?: string;
  sessionToken?: string;
  user?: { uid?: string; username?: string; name?: string; email?: string; avatar?: string };
  deviceId?: string;
}): Promise<void> {
  // 设备 ID 归一必须在 bind-session 之前（否则绑定请求指纹与后续请求不一致）
  if (payload.deviceId) adoptDeviceId(payload.deviceId);

  // 🔴 Session 模式：拿 session_token 换本域 sid cookie。
  //    失败必须中断 —— 后端没换到 cookie 前端却关窗 = 假登录。
  if (!payload.sessionToken) {
    ElMessage.error('登录结果缺少 session_token，无法建立会话');
    return;
  }
  try {
    const res = await authApi.bindSession(payload.sessionToken);
    const merged: AuthUser = {
      uid: res?.user?.uid || payload.user?.uid || '',
      username: res?.user?.username || payload.user?.username || payload.user?.name || '用户',
      email: res?.user?.email || payload.user?.email,
      avatar: res?.user?.avatar || payload.user?.avatar,
      name: res?.user?.name || payload.user?.name
    };
    authStore.applyLogin(merged, res?.accountKey ?? null, !!res?.rememberMe);
    authStore.closeLogin();
    ElMessage.success(`欢迎回来，${merged.username}`);
    const redirect = authStore.pendingRedirect;
    authStore.pendingRedirect = null;
    if (redirect) void router.push(redirect);
  } catch (e) {
    ElMessage.error((e as Error).message || '登录会话绑定失败');
  }
}

/** 免密切换；rememberMe=false 的账号无凭证 → 跳 iframe 登录 */
async function onSwitchAccount(acct: SavedAccount & { accountKey: string }): Promise<void> {
  if (!acct.rememberMe) {
    mode.value = 'login';
    return;
  }
  switching.value = true;
  try {
    const ok = await authStore.switchAccount(acct.accountKey);
    if (ok) {
      authStore.closeLogin();
      ElMessage.success(`已切换到 ${acct.username}`);
    } else if (!accounts.value.length) {
      mode.value = 'login';
    }
  } finally {
    switching.value = false;
  }
}

async function onRevoke(acct: SavedAccount & { accountKey: string }): Promise<void> {
  await authStore.revokeSavedAccount(acct.accountKey);
  if (!accounts.value.length) mode.value = 'login';
}

function formatLastLogin(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

watch(
  () => authStore.loginVisible,
  (open) => {
    if (!open) return;
    loading.value = true;
    mode.value = accounts.value.length ? 'accounts' : 'login';
  }
);

// 弹窗开着时宿主切主题 → 同步给 iframe
watch(
  () => settings.isDark,
  (dark) => {
    if (authStore.loginVisible && mode.value === 'login' && !loading.value) postTheme(dark);
  }
);
</script>

<template>
  <el-dialog
    v-model="visible"
    :width="440"
    align-center
    :close-on-click-modal="false"
    :show-close="true"
    class="sso-dialog"
  >
    <template #header>
      <div class="sso-dialog__title">
        <span class="sso-dialog__logo">R</span>
        <span>{{ LOGIN_COPY.title }}</span>
      </div>
    </template>

    <!-- 模式 A：多账号免切 -->
    <div v-if="mode === 'accounts' && accounts.length" class="sso-accounts">
      <p class="sso-accounts__sub">{{ LOGIN_COPY.subtitle }}</p>
      <div class="sso-accounts__list">
        <div v-for="acct in accounts" :key="acct.accountKey" class="sso-account">
          <div class="sso-account__avatar">
            <img v-if="acct.avatar" :src="acct.avatar" :alt="acct.username" />
            <span v-else>{{ acct.username.charAt(0) }}</span>
          </div>
          <div class="sso-account__meta">
            <div class="sso-account__name">{{ acct.username }}</div>
            <div class="sso-account__time">
              {{ acct.rememberMe ? `上次登录 ${formatLastLogin(acct.lastLoginAt)}` : '临时登录，需重新验证' }}
            </div>
          </div>
          <el-button
            type="primary"
            size="small"
            :loading="switching"
            @click="onSwitchAccount(acct)"
          >
            {{ acct.rememberMe ? '一键登录' : '去登录' }}
          </el-button>
          <el-button link type="danger" size="small" @click="onRevoke(acct)">忘掉</el-button>
        </div>
      </div>
      <div class="sso-accounts__foot">
        <el-button link type="primary" @click="mode = 'login'">登录其他账号</el-button>
      </div>
    </div>

    <!-- 模式 B：iframe 登录 -->
    <div v-else class="sso-frame">
      <iframe
        ref="iframeRef"
        class="rw-sso-iframe"
        :src="loginUrl"
        allow="payment"
        @load="onIframeLoad"
      ></iframe>

      <el-button
        v-if="accounts.length"
        class="sso-frame__back"
        link
        type="info"
        size="small"
        @click="mode = 'accounts'"
      >
        ‹ 返回账号列表
      </el-button>

      <div v-if="loading" class="sso-frame__loading">
        <span class="sso-frame__spinner"></span>
        <span>{{ LOGIN_COPY.ssoLoading }}</span>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.sso-dialog__title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--rw-text);
}

.sso-dialog__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: linear-gradient(135deg, #16265c 0%, #1e40af 48%, #2f6df0 100%);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
}

/* ---------- 账号列表 ---------- */
.sso-accounts__sub {
  margin: -4px 0 12px;
  font-size: 12px;
  color: var(--rw-text-3);
}

.sso-accounts__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sso-account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.sso-account:hover {
  border-color: var(--rw-brand);
}

.sso-account__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(135deg, #3b76f0, #2563eb);
  color: #fff;
  font-weight: 700;
}

.sso-account__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.sso-account__meta {
  flex: 1;
  min-width: 0;
}

.sso-account__name {
  font-weight: 600;
  color: var(--rw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sso-account__time {
  font-size: 11px;
  color: var(--rw-text-3);
}

.sso-accounts__foot {
  display: flex;
  justify-content: center;
  margin-top: 14px;
}

/* ---------- iframe ---------- */
.sso-frame {
  position: relative;
  height: 560px;
  overflow: hidden;
  border-radius: var(--rw-radius-sm);
  border: 1px solid var(--rw-border);
  background: var(--rw-surface);
}

.sso-frame__back {
  position: absolute;
  top: 6px;
  left: 8px;
  z-index: 2;
  background: var(--rw-surface);
  padding: 2px 8px;
  border-radius: 999px;
}

.sso-frame__loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 12px;
  color: var(--rw-text-3);
  background: var(--rw-surface);
  z-index: 3;
}

.sso-frame__spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--rw-border);
  border-top-color: var(--rw-brand);
  border-radius: 50%;
  animation: sso-spin 0.8s linear infinite;
}

@keyframes sso-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
