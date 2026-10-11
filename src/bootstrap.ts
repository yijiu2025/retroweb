/**
 * RetroWeb 启动编排器。
 *
 * 按序初始化：全局错误处理 → 状态管理 → 路由 → 401 处理器注入 → 等待路由就绪 → 挂载。
 *
 * 🔴 为什么入口要拆成 `main.ts + bootstrap.ts`（与 posecraft / firewall 同构）：
 *    `main.ts` 只当"门牌"（文件头 + 样式 + `import './bootstrap'`），**启动顺序**全部收在这里。
 *    好处是读代码时不必在样式 import 与装配语句之间来回跳；也让"启动流程"成为一个
 *    可被单独阅读、单独讨论的单元。三个前端 + 本应用共用同一套入口形态。
 *
 * 🔴 启动引导（拉 userinfo 探活）**不在这里** —— 由 router 守卫与 App.vue 共同触发，
 *    auth store 内部有 `initialized` 幂等守卫，两条路都走到也只请求一次。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setUnauthorizedHandler } from '@/api/http';
import { API_BASE_URL, AUTH_BYPASS, RETRO_VIA_NODE } from '@/config/services';
import { useAuthStore } from '@/stores/auth';

/** 日志前缀：全仓统一用它，便于在控制台按 `[RetroWeb]` 过滤 */
const LOG_TAG = '[RetroWeb]';

const app = createApp(App);
const pinia = createPinia();

// ---------------------------------------------------------------------------
// 1. 全局错误处理
// ---------------------------------------------------------------------------
/**
 * 组件渲染 / 侦听器里抛出的异常**不会**冒泡到任何业务 try-catch，没有这一层就只能靠
 * 用户描述"页面白了一块"，且控制台里混着框架噪声、无法检索。打统一标签后可过滤、可上报。
 *
 * ⚠️ 与 oauth21 的差异：那边 `reportError()` 上报到后端监控；retroweb 暂无监控端点，
 *    故只落 console。将来接上监控时，把 `console.error` 换成上报即可（接口已收敛在此处）。
 */
app.config.errorHandler = (err: unknown, instance: unknown, info: string): void => {
  console.error(`${LOG_TAG} 未捕获的组件异常`, { err, info, instance });
};

// ---------------------------------------------------------------------------
// 2. 插件注册（顺序：pinia → router）
// ---------------------------------------------------------------------------
app.use(pinia);
app.use(router);

// ---------------------------------------------------------------------------
// 3. 注入 401 处理器
// ---------------------------------------------------------------------------
// 依赖方向：bootstrap → http，不反向。http 只暴露一个注册口，装配方注入处理器，
// 避免 auth store → http 与 http → auth store 成环（见 api/http.ts 文件头）。
setUnauthorizedHandler((reason: string) => useAuthStore().markExpired(reason));

// ---------------------------------------------------------------------------
// 4. dev 专用：未捕获的 Promise 拒绝
// ---------------------------------------------------------------------------
if (import.meta.env.DEV) {
  /**
   * 覆盖 fire-and-forget 的 `void someAsync()` 里炸掉的情况（这类拒绝不会有 catch）。
   * 生产不挂 —— `import.meta.env.DEV` 恒为 false，整块会被打包器 DCE 掉。
   */
  window.addEventListener('unhandledrejection', (e) => {
    console.error(`${LOG_TAG} 未捕获的 Promise 拒绝`, e.reason);
  });
}

// ---------------------------------------------------------------------------
// 5. 启动横幅
// ---------------------------------------------------------------------------
/**
 * 把"这次跑的是哪一档"打出来。排障价值极高 —— 免登录开着 / 算法走 Node 还是直连 Python /
 * API 根打哪，全是靠 env 决定的隐性状态，出问题时第一个要确认的就是它们。
 * ⚠️ 生产构建会由 vite.config.ts 的 `compress.dropConsole` 整体删除，不进用户产物。
 */
console.info(`${LOG_TAG} 启动`, {
  api: API_BASE_URL || '(同源相对路径)',
  authBypass: AUTH_BYPASS,
  retroViaNode: RETRO_VIA_NODE,
  mode: import.meta.env.MODE
});

// ---------------------------------------------------------------------------
// 6. 等待路由就绪后挂载
// ---------------------------------------------------------------------------
// 🔴 为什么不直接 `app.mount()`：router 守卫是 async 的，它在首次导航里跑 authStore.init()。
//    不等 isReady 会先渲染一帧"路由未定"的内容（本应用表现为先闪未登录态再跳登录弹窗）。
//    `.catch` 是降级兜底：路由初始化失败（路由表循环/配置错误，极罕见）时仍挂载，
//    避免整页白屏 —— 这条对齐 oauth21/src/main.ts 第 62-66 行。
router
  .isReady()
  .then(() => {
    app.mount('#app');
  })
  .catch((err: unknown) => {
    console.error(`${LOG_TAG} router.isReady 失败，降级直接挂载`, err);
    app.mount('#app');
  });
