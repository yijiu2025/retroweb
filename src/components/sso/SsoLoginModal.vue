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
 *
 * 🔴 必须挂在 `App.vue`（与 `AppShell` 平级），不能挂进某个页面：
 *    触发源是**全局**的 —— HTTP 401（`api/http.ts` 的 `intercept401`）、
 *    路由守卫未登录拦截、用户手动点「登录」。「不在那个页面就弹不出来」是不可接受的。
 *
 * 🔴 它是 `AppShell` 的**兄弟**而非后代：AppShell 根元素 `overflow:hidden`，
 *    放进去会被裁剪；el-dialog 默认 Teleport 到 body，挂在外面才不受布局约束。
 *
 * @author yijiu2025
 * @since 2026-10-05
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { authApi } from '@/api/auth';
import { buildSsoLoginUrl, LOGIN_COPY, SSO_URL } from '@/config/services';
import { useAuthStore } from '@/stores/auth';
import { useSettingsStore } from '@/stores/settings';
import { useSsoMessage } from '@/composables/useSsoMessage';
import { adoptDeviceId } from '@/utils/device';
import { safeRemoteUrl } from '@/utils/safe-url';
import { relativeDays } from '@/utils/time';
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
/** 慢加载提示：iframe 拉取后超过 6s 仍未完成 SSO_READY 握手 → 给用户一个「重新加载」出口 */
const loadSlow = ref(false);
/** 握手是否已成功（收到过 SSO_READY）—— 决定 6s 慢加载提示要不要显示 */
const handshaked = ref(false);
let slowTimer: number | null = null;

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

/**
 * iframe 尺寸常量 —— 与 oauth21 的实际渲染高度对齐（实测，非估算）。
 *
 * 🔴 为什么必须量而不是估：oauth21 的 `.auth-viewport{height:100vh; overflow:hidden}`
 *    ⇒ **给它多高就撑多高、给它矮了不报错也不出滚动条，只会静默裁掉底部**
 *    （登录按钮 /「立即注册」那一行会消失，看起来只是"少了点什么"）。
 *    所以这里的数字必须有实测依据。
 *
 * 🔴 **宽度决定档位（这是"只能显示一半"的真正成因）** —— oauth21 的 AuthContainer
 *    以 `600px` / `854px` 划三档，各档高度模型完全不同：
 *
 *    | iframe 内视口宽 | 档位     | .auth-card 高度        | 左栏品牌 | 实测内容高 |
 *    |---------------|---------|----------------------|---------|-----------|
 *    | `< 600`       | 单栏     | `auto; min-height:100vh` ← 撑满整个 iframe | 隐藏 | **699px** |
 *    | `600~853`     | 双栏压缩 | `auto; min-height:484px`           | 按比例缩 | 483px |
 *    | `>= 854`      | 双栏固定 | **`height:484px`（定值）**          | 400px  | 483px |
 *
 *    ⇒ 若把 iframe 放在 **< 600px** 宽（如旧版 440px），卡片 `min-height:100vh` 会
 *      跟着 iframe 高度走，而 form 在 100vh 里**垂直居中** ⇒ 内容要 ~699px 才装得下；
 *      此时若 iframe 只有 460px 高，就会**把居中的表单上下各切掉一截** = 用户看到的
 *      「只能显示一半」。**修法不是加高，而是把宽度提到 ≥854px 换到双栏固定档**
 *      （484px 定高、内部自己排得下）。
 *
 * 🔴 **必须量的是「iframe 内视口宽」，不是弹窗宽**（踩过）：
 *      el-dialog 默认有 `padding:16px`、`.sso-frame` 又有 `border:1px`
 *      ⇒ 弹窗给 856px 时，iframe 内实际只有 `856 - 32 - 2 = 822px < 854`
 *      ⇒ **掉进「600~853 双栏压缩档」**（`min-height:484px`，靠内容恰好撑到 484，
 *      脆弱：内容一多就被撑高、超过 iframe 定高就被 `.auth-viewport{overflow:hidden}` 静默裁）。
 *      posecraft 的弹窗虽然也是 856px，但它的 iframe 是 `w-full` 塞在**无内边距**的
 *      容器里 ⇒ 内宽 856 ≥ 854，落在固定档。**照抄 posecraft 的 856 而不看内宽就会踩这个坑。**
 *      ⇒ 修法：**把 el-dialog 的左右 padding 去掉**（`.sso-dialog{padding:16px 0}`），
 *        此时 `DIALOG_WIDTH = 854` 与 iframe 内视口**1:1**，恰好落在稳定档。
 *
 * ⚠️ 实测数据（`oauth21`，三档各页"卡片内非 absolute 后代最深 bottom vs 卡片底边"）：
 *    · 440px 宽：卡片高 = iframe 高（100vh），内容需 699px ⇒ **必裁**
 *    · 640px 宽：卡片 484px，内容底 483px，溢出 -1 ⇒ 不裁（左栏 286 / 表单 352）
 *    · 856px 宽：卡片 484px，内容底 483px，溢出 -1 ⇒ 不裁（左栏 400 / 表单 454）
 *    三页（/mini-login、/register?from=mini、/forgot-password?from=mini）同上，
 *    扫码态（qrCodeFirst=true）同样是 484px 不裁。
 *
 * ⚠️ 另外两个坑（都踩过，别重犯）：
 *  ① oauth21 **只单开了 `/mini-login`** 一条 mini 路由；register / forgot 的 mini 形态
 *     由分发器按 `?from=mini` 判定。写 `/mini-forgot` 会落到 404 → `NotFound.vue`
 *     再 `replace('/mini-login')`，于是**量的其实是登录页**，被误读成"忘记密码 313px"。
 *  ② 不传 `appName` 直接访问会渲染「应用标识缺失」错误卡（228px），同样是个假数字。
 *
 * ⚠️ FRAME_HEIGHT 必须与 CSS 里 `.sso-frame{height:484px}` 手动同步 —— 本项目
 *    Vite 8 下 scoped `v-bind()` 不生效（原因见那段 CSS 的注释），无法自动关联。
 *    ⇒ 运行时用 assertFrameHeight() 兜住：两边一旦不一致就**在开发期喊出来**，
 *      而不是等用户看到一个被裁掉一半的登录框。
 */
const FRAME_HEIGHT = 484;

/**
 * 断言真实渲染出来的 iframe 内视口尺寸与预期档位一致。
 *
 * 为什么值得写：CSS 那个 484px 是**手抄**的常量（v-bind 在 Vite 8 下不生效，
 * 见 `<style>` 里 .sso-frame 的注释），改一处忘另一处不会有任何编译期报错，
 * 只会让 iframe 高度与实测值脱节 —— 给矮了就是**静默裁剪**（底部链接消失），
 * 给高了就是又出现弹性空白。两者都很难被肉眼第一时间发现。
 *
 * 🔴 **量的是 iframe 的 clientWidth/Height，不是 `.sso-frame` 的盒子**（踩过）：
 *    oauth21 的媒体查询吃的是 **iframe 内视口宽**（`100vw`），而 `.sso-frame`
 *    比它宽了「左右 border 2px」—— 拿 `.sso-frame` 的宽度去比 854 会**少数 2px**
 *    而与真实档位错位判断。`iframe.clientWidth` 才是 iframe 内 `window.innerWidth`。
 *
 * 天真的做法是"只审查高度"，但那还不够：**高度对了、宽度掉回低档一样会裁**。
 * 所以这里**同时**断言高度与宽度档位。
 *
 * 只在 dev（`import.meta.env.DEV`）跑：生产上多一次查询没意义，且 Vite 会把它 DCE 掉。
 */
function assertFrameHeight(): void {
  if (!import.meta.env.DEV) return;
  const frame = document.querySelector<HTMLElement>('.sso-frame');
  const iframe = document.querySelector<HTMLIFrameElement>('.rw-sso-iframe');
  if (!frame || !iframe) return;

  const actualH = Math.round(frame.getBoundingClientRect().height);
  if (actualH !== FRAME_HEIGHT) {
    console.error(
      `[SSO] .sso-frame 实际高度 ${actualH}px ≠ FRAME_HEIGHT ${FRAME_HEIGHT}px。` +
        `CSS 与 script 常量已脱节 —— 偏小会静默裁剪 oauth21 页面底部（登录/注册链接消失）。`
    );
  }

  // 🔴 宽度档位：吃的是 iframe **内视口**宽（= clientWidth），不是 .sso-frame 外框宽。
  //    < 600 落单栏档（min-height:100vh ⇒ 内容按 iframe 高居中、必被裁）；
  //    < 854 落「双栏压缩档」（min-height:484px，靠内容恰好撑住，脆弱）；
  //    ≥ 854 才是「双栏固定 height:484px」档（稳妥）。
  const inner = Math.round(iframe.clientWidth);
  if (inner < 854) {
    console.error(
      `[SSO] iframe 内视口宽 ${inner}px < 854px —— oauth21 未进入「双栏固定 484px」档。` +
        `600~853 是 min-height:484px（脆弱，可能被内容撑破后静默裁），< 600 是单栏 100vh 档（必被裁）。` +
        `请注意 el-dialog 的左右 padding 与 .sso-frame 的 border 会吃掉宽度` +
        `（需让 DIALOG_WIDTH ≥ 854 + 左右 padding×2 + border×2；当前 DIALOG_WIDTH=${DIALOG_WIDTH}）。`
    );
  }
}

/**
 * 弹窗宽度 = oauth21 的稳定档宽度 **854px**（与 iframe 内口 1:1）。
 *
 * 为什么是 854 而不是 856/880：
 *   · 854 是 oauth21 `AuthContainer` 的**档位临界值**（`@media (min-width:854px)`
 *     才进入「双栏固定 height:484px」档，卡片定高、内容不会被裁）；
 *   · 本组件的全局 `<style>` 已把 el-dialog 的 padding 归零、`.sso-frame` 不画 border
 *     ⇒ el-dialog 宽 = iframe 内视口宽，**1:1 无损耗**，取 854 即精确落在稳定档。
 *   · 想留余量取 880 也行（同样在稳定档内），但 854 与 oauth21 的档位刻度对齐、
 *     视觉尺寸也和 posecraft（856）基本一致。
 *
 * 🔴 **必须与全局 `<style>` 里的 `--el-dialog-padding-primary: 0` 成对**：
 *    只改宽度不改 padding，左右会被吃掉 32px ⇒ 854 − 32 = 822 < 854 ⇒ 掉档。
 *    dev 期由 assertFrameHeight() 量 iframe.clientWidth 兜住。
 */
const DIALOG_WIDTH = 854;

const { postTheme } = useSsoMessage({
  ssoOrigin,
  getIframe: () => iframeRef.value,
  handlers: {
    onReady: () => {
      handshaked.value = true;
      if (readyTimer) {
        window.clearTimeout(readyTimer);
        readyTimer = null;
      }
      if (slowTimer) {
        window.clearTimeout(slowTimer);
        slowTimer = null;
      }
      loadSlow.value = false;
      loading.value = false;
      postTheme(settings.isDark);
    },
    onLoginSuccess: handleLoginSuccess,
    onMaxSessions: p => {
      ElMessage.warning(`登录设备数已达上限（${p.sessions ?? '?'} / ${p.maxSessions ?? '?'}），请先退出其他设备`);
      authStore.closeLogin();
    },
    onDenied: p => {
      ElMessage.error(p.description || p.error || '授权被拒绝');
    }
  }
});

/** iframe HTML 拉完：只启动兜底，不关 loading（Vue 未必已 mount） */
function onIframeLoad(): void {
  if (readyTimer) window.clearTimeout(readyTimer);
  readyTimer = window.setTimeout(() => {
    // 3s 兜底：握手没来也把遮罩撤掉（否则用户永远对着转圈）——
    // 但**记下"没握手成功"**，6s 时给一条可见的排障提示（见下）。
    console.warn(
      '[SSO] SSO_READY 超时（3s 兜底）。若 oauth21 控制台报「父 origin 未授权」，请把本应用 origin 加进 VITE_ALLOWED_PARENT_ORIGINS'
    );
    loading.value = false;
    postTheme(settings.isDark);
  }, 3000);

  // 🔴 6s 仍未收到 SSO_READY（= handshaked 还是 false）→ 极可能是 oauth21(5174) 没起
  //    / 网络不通 / 父 origin 未白名单。此时遮罩虽已被 3s 兜底撤掉，但用户看到的会是一个
  //    **空白/报错的 iframe**，无从下手 ⇒ 单独给一条常驻的排障条 + 「重新加载」出口。
  //    不能把提示挂在遮罩里（遮罩已撤），要独立于 loading 显示。
  if (slowTimer) window.clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    if (!handshaked.value) loadSlow.value = true;
  }, 6000);
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

watch(
  () => authStore.loginVisible,
  open => {
    // 锁背景滚动（学 posecraft）：弹窗开着时宿主页面不跟着滚。
    document.body.style.overflow = open ? 'hidden' : '';
    if (!open) return;
    loading.value = true;
    handshaked.value = false;
    loadSlow.value = false;
    mode.value = accounts.value.length ? 'accounts' : 'login';
    // 弹窗打开后才量得到 .sso-frame（mode='accounts' 时不渲染 iframe 分支）
    void nextTick(() => {
      if (mode.value === 'login') assertFrameHeight();
    });
  }
);

/** 手动重载 iframe —— 「一直转圈」时的兜底出口（oauth21 未起 / 网络抖动后可自救） */
function reloadFrame(): void {
  if (readyTimer) {
    window.clearTimeout(readyTimer);
    readyTimer = null;
  }
  if (slowTimer) {
    window.clearTimeout(slowTimer);
    slowTimer = null;
  }
  loadSlow.value = false;
  handshaked.value = false;
  loading.value = true;
  const f = iframeRef.value;
  if (f) f.src = loginUrl.value;
}

// 弹窗开着时宿主切主题 → 同步给 iframe
watch(
  () => settings.isDark,
  dark => {
    if (authStore.loginVisible && mode.value === 'login' && !loading.value) postTheme(dark);
  }
);
</script>

<template>
  <!--
    🔴 `destroy-on-close` **必须有**，否则「关掉再打开一直转圈」（踩过）：
    el-dialog 默认**不销毁内容**（只是 CSS 隐藏），iframe 元素与它的 `src` 都还在；
    重开时 `loading` 又被置 true，但 **src 没变 ⇒ 浏览器不重新加载 ⇒ `@load` 不触发**
    ⇒ 既没有 3s 兜底、也没有新的 SSO_READY ⇒ **永久「正在加载安全登录…」**。
    posecraft 用 `<div v-if="isOpen">` 包整个弹窗（关闭即卸载子树、重开全新创建 iframe），
    天然不会卡；el-dialog 这边用 `destroy-on-close` 等价达成「每次打开都是新 iframe」。
  -->
  <el-dialog
    v-model="visible"
    :width="DIALOG_WIDTH"
    align-center
    :close-on-click-modal="false"
    :show-close="true"
    destroy-on-close
    class="sso-dialog"
  >
    <!--
      🔴 **不要自己在 el-dialog 的 #header 里造标题栏**（用户明确否掉过）。
      posecraft 的登录弹窗**没有 header 栏**：它的标题（LOGIN_COPY.title）
      是画在**内容区里、居中**的（`<h2 class="text-center">`），关掉按钮是右上角
      一个 absolute 的 ×。这里保持与 oauth21 一致 —— iframe 内部自己带标题
      （「欢迎回来」），宿主不该再叠一条 header。关掉按钮用 el-dialog 自带的（:show-close）。
    -->

    <!-- 模式 A：多账号免切 -->
    <div v-if="mode === 'accounts' && accounts.length" class="sso-accounts">
      <p class="sso-accounts__sub">{{ LOGIN_COPY.subtitle }}</p>
      <div class="sso-accounts__list">
        <div v-for="acct in accounts" :key="acct.accountKey" class="sso-account">
          <div class="sso-account__avatar">
            <img v-if="safeRemoteUrl(acct.avatar)" :src="safeRemoteUrl(acct.avatar)!" :alt="acct.username" />
            <span v-else>{{ acct.username.charAt(0) }}</span>
          </div>
          <div class="sso-account__meta">
            <div class="sso-account__name">{{ acct.username }}</div>
            <div class="sso-account__time">
              {{
                acct.rememberMe
                  ? `上次登录 ${acct.lastLoginAt ? relativeDays(acct.lastLoginAt) : ''}`
                  : '临时登录，需重新验证'
              }}
            </div>
          </div>
          <el-button type="primary" size="small" :loading="switching" @click="onSwitchAccount(acct)">
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
      <iframe ref="iframeRef" class="rw-sso-iframe" :src="loginUrl" allow="payment" @load="onIframeLoad"></iframe>

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

      <!-- 🔴 握手超时排障条：**独立于 loading**（3s 兜底已把遮罩撤了，但 iframe 是空白/报错的）
           —— 放遮罩里就永远不会被看到。用户能据此自查 + 一键重载。 -->
      <div v-if="loadSlow && !loading" class="sso-frame__trouble">
        <p class="sso-frame__trouble-title">登录服务未能就绪</p>
        <p class="sso-frame__trouble-text">请确认 oauth21 登录服务（:5174）已启动、网络正常，然后重试。</p>
        <el-button size="small" type="primary" @click="reloadFrame">重新加载</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
/* ---------- 账号列表 ---------- */
.sso-accounts {
  padding: 20px 20px 16px;
}

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
/**
 * 🔴 **学 posecraft：iframe 贴边铺满，自己不加边框/圆角**（这是「为什么还有一个边框」的答案）。
 *
 * posecraft 的写法是 iframe `class="w-full h-full border-none"`，塞在
 * `.modal-content{border + overflow:hidden + rounded-[10px]}` 里 ——
 * **整个弹窗只有最外一层框**，iframe 铺到圆角边缘，里外没有第二道线。
 *
 * 而这里原先给 `.sso-frame` 自己画了 `border:1px + border-radius + overflow:hidden`，
 * 叠在 el-dialog 自己的外框里 ⇒ **双边框**（内嵌一个方框，用户在截图里看到的那个）。
 * ⇒ 删掉 `.sso-frame` 的边框与圆角；圆角由 el-dialog 承担（见文件末全局块的 border-radius）。
 *
 * 🔴 484px = oauth21 在「双栏档」下的卡片定高（实测，理由见 script 里 FRAME_HEIGHT 注释）。
 *    前提是 **iframe 内视口宽 ≥854px**（DIALOG_WIDTH=854 + 左右 padding 归零）——两者成对成立：
 *      · 宽度掉到 <600 ⇒ 单栏档、卡片 min-height:100vh、内容需 ~699px ⇒ 上下都被裁
 *      · 高度给矮了 ⇒ `.auth-viewport{overflow:hidden}` **静默裁剪**底部，无滚动条无报错
 *
 * 🔴 这里**不能用** `v-bind()` / CSS 自定义属性传 JS 常量：
 *    本项目 Vite 8（Rolldown + Oxc）下 `<style scoped>` 的 `v-bind()` 会被编译成
 *    `height: var(--<hash>-\`\$\{FRAME_HEIGHT\}px\`)` —— 表达式**没有被求值**，
 *    于是 var() 解析失败、height 声明整条失效，`.sso-frame` 退化成内容高度。
 *    实测症状：弹窗只有 224px 高，登录表单被裁掉一半。
 *    保持与上面 `FRAME_HEIGHT` 常量同步即可（两处都在本文件内，dev 期有断言兜底）。
 */
.sso-frame {
  position: relative;
  height: 484px;
  overflow: hidden;
  background: var(--rw-surface);
}

/* iframe 由全局 `index.scss` 的 `.rw-sso-iframe{display:block;width:100%;height:100%;border:0}` 负责
   —— 不在这里重复，避免两处漂移（单一来源）。 */

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
  /* 学 posecraft：**半透明 + 模糊**而不是纯色全遮 —— iframe 内容会透出来，
     加载中不再像"卡死的白屏"，视觉上更连续（且主题切换时不会闪）。 */
  background: color-mix(in srgb, var(--rw-surface) 85%, transparent);
  backdrop-filter: blur(4px);
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

/* 握手超时排障条（独立于 loading 遮罩） */
.sso-frame__trouble {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 24px;
  text-align: center;
  background: color-mix(in srgb, var(--rw-surface) 92%, transparent);
  backdrop-filter: blur(4px);
  z-index: 4;
}

.sso-frame__trouble-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--rw-text);
}

.sso-frame__trouble-text {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--rw-text-3);
}

@keyframes sso-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<!--
  🔴 全局（非 scoped）覆盖 —— **必须独立成块**，不能并进上面的 scoped block。

  原因：el-dialog 内容被 Teleport 到 body，**弹窗根元素（.el-dialog.sso-dialog）不带
  本组件的 data-v-xxx scope 属性**（实测确认），于是 scoped 的
  `.sso-dialog:deep(.el-dialog)` 编译成 `.sso-dialog[data-v-xxx] .el-dialog` 恒不命中
  （根上没有那个属性），只剩 EP 自己的 `.el-dialog{padding:var(--el-dialog-padding-primary)}` 生效
  ⇒ iframe 两侧被吃掉 32px ⇒ 内视口 846 < 854 ⇒ 掉进 oauth21「双栏压缩档」（脆弱、可能被裁）。

  用 `.sso-dialog`（类名唯一）限定作用域，不会误伤本应用其它 el-dialog。
  覆盖 EP 旋钮而非硬写 padding：`--el-dialog-padding-primary` 被用作 `padding: var(...)`。

  🔴 这里承担「**整个弹窗只有一层框**」的职责（学 posecraft 的 .modal-content）：
     · `padding: 0` —— **四周全 0**：iframe 从弹窗最上沿铺到最下沿、左右铺满，
       这样才和 posecraft「iframe 直接铺满无内边距容器」一致；
       左右为 0 也顺带保证 iframe 内视口宽不被吃掉（否则 <854 掉档）；
     · `rounded + overflow:hidden` —— 圆角由**弹窗自己**提供，iframe 铺到圆角边缘，
       于是不再需要 `.sso-frame` 自己再画一层 border/radius（那正是双边框的来源）。
     · 关掉按钮由 EP 自带（`.el-dialog__headerbtn`）—— 没有 header 时它仍会
       absolute 定位在右上角浮在 iframe 上；样式**照抄 posecraft**：纯透明热区 +
       细线 ×（见下），**不要给它加背景/圆角底**。
-->
<style>
.sso-dialog.el-dialog {
  --el-dialog-padding-primary: 0;
  border-radius: var(--rw-radius);
  overflow: hidden;
}

.sso-dialog.el-dialog .el-dialog__body {
  padding: 0;
}

/*
  🔴 **不要给 `.el-dialog__body` 加 `margin: -1px` 去盖白缝**（我踩过，反而制造白缝）。

  错的推导：以为"圆角抗锯齿留 1px 缝 ⇒ 把 body 向外扩 1px 盖住"。实际后果是
    body 变成 `(880+2) × (484+2)`，而 `.sso-frame`/`iframe` 都有 `height:100%`
    ⇒ **高度也跟着取 486px** ⇒ iframe 比弹窗内口高 2px、又被 `.el-dialog{overflow:hidden}`
    裁掉 ⇒ 圆角那一圈里 iframe 的实际边**缩回内侧**，于是**左右各露出约 1px 的白**。
    这就是那张图上"左右两条竖白缝"的来历。

  ⇒ 正确做法：让 **iframe 精确等于弹窗内口**（body 不偏移、不留 border），
    再靠弹窗自身的 `overflow:hidden` 把 iframe 的四角裁成与圆角一致。
    圆角处若有亚像素淡边，属于抗锯齿的正常表现，不应该用"外扩"去掩盖。
*/
/*
  🔴 关闭按钮 **照抄 posecraft**（不要自己发明）：
    posecraft 是 `<button class="absolute top-2.5 right-2.5 z-10 w-6 h-6 flex
    items-center justify-center text-slate-800 ..."><X class="w-5 h-5" /></button>`
    —— **24×24 热区、20px 细线 X、无背景、无边框、无圆角底**，hover 只变图标色。

    反面教材（我上一版干的，被用户否掉）：
      · 加了 `border-radius:50% + background: color-mix(...)` ⇒ 变成一个**圆形灰底**，
        和 posecraft 完全不同；用户截图里那个"被方框框住/一团灰"的就是它；
      · 又给了 `width:32px;height:32px` 覆盖 EP 的 48px，反而把图标挤在正中显得更重。

    ⇒ 这里把 EP 的 headerbtn 还原成"透明热区 + 细线图标"：
      · 容器 24×24、`top/right:10px`（= posecraft 的 `top-2.5 right-2.5`）；
      · `background:transparent; border-radius:0`（**没有任何底**）；
      · 图标用 CSS 自己画一根 1.5px 细线 ×（EP 自带的 16px SVG 描边偏粗、且尺寸
        受 `--el-message-close-size` 牵连，调不干净）⇒ 直接把 EP 的 svg 藏掉，
        用 `::before/::after` 两条 1.5px 旋转线画字符"×"，颜色走 `--rw-text`。
      · EP 默认 `:focus/:hover` 有 `box-shadow` 描边（用户截图里的方框）⇒ 必须连同
        hover/focus 一起 `box-shadow:none; outline:none`。
*/
.sso-dialog.el-dialog .el-dialog__headerbtn {
  width: 24px;
  height: 24px;
  top: 10px;
  right: 10px;
  z-index: 10;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  outline: none;
  /* 便于用伪元素画图标 */
  position: absolute;
}

/* 藏掉 EP 自带的 16px SVG 图标，改用下面的两根细线 */
.sso-dialog.el-dialog .el-dialog__headerbtn .el-dialog__close {
  display: none;
}

/* 细线 ×（1.5px、20px 见方）—— 与 posecraft 的 lucide X 同观感 */
.sso-dialog.el-dialog .el-dialog__headerbtn::before,
.sso-dialog.el-dialog .el-dialog__headerbtn::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--rw-text);
  transition: background 0.15s;
}
.sso-dialog.el-dialog .el-dialog__headerbtn::before {
  transform: translate(-50%, -50%) rotate(45deg);
}
.sso-dialog.el-dialog .el-dialog__headerbtn::after {
  transform: translate(-50%, -50%) rotate(-45deg);
}

/* hover / focus 只变图标颜色（与 posecraft 的 hover:text-slate-600 一致），
   不带任何背景、描边、方框 */
.sso-dialog.el-dialog .el-dialog__headerbtn:hover,
.sso-dialog.el-dialog .el-dialog__headerbtn:focus,
.sso-dialog.el-dialog .el-dialog__headerbtn:focus-visible {
  background: transparent;
  box-shadow: none;
  outline: none;
}
.sso-dialog.el-dialog .el-dialog__headerbtn:hover::before,
.sso-dialog.el-dialog .el-dialog__headerbtn:hover::after,
.sso-dialog.el-dialog .el-dialog__headerbtn:focus::before,
.sso-dialog.el-dialog .el-dialog__headerbtn:focus::after {
  background: var(--rw-text-2);
}
</style>
