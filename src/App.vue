<script setup lang="ts">
/**
 * 应用根（装配层）。
 *
 * 只做三件事，**业务逻辑一律不进本文件**：
 *   ① 注入 Element Plus 中文文案（`el-config-provider`）
 *   ② 摆两个**常驻**层：`AppShell`（布局，含 router-view）与 `SsoLoginModal`（登录浮层）
 *   ③ 触发一次启动引导（`authStore.init()`）
 *
 * 🔴 为什么这两个必须是**兄弟**而不是挂在某个页面里：它们都要跨路由存活。
 *    · `AppShell` 持有唯一的 `router-view` —— 5 个页面共用一套壳，路由一切换就卸载的话，
 *      侧栏/顶栏会跟着闪，且页面切换拿不到统一的壳。
 *    · `SsoLoginModal` 的触发源是**全局**的（HTTP 401 / 路由守卫 / 用户手动点登录），
 *      挂在某个页面里就等于「不在那个页面时弹不出来」。
 *    另：`AppShell` 根元素是 `overflow:hidden` 的 flex 容器，登录弹窗 Teleport 到 body
 *    挂在它外面，正好避开裁剪。
 *
 * 🔴 `el-config-provider` 必须在**最外层**：它靠 provide/inject 生效，
 *    `AppShell` 内的 `el-empty` / `el-dialog` / `RunParams` 的下拉才能拿到中文文案。
 *    （Element Plus 组件是按需自动引入的，没有全局 locale 兜底。）
 *
 * 🔴 `authStore.init()` 与 `router.beforeEach` 里的那次调用**是同一件事**，
 *    靠 store 内的 `initialized` 幂等守卫去重（见 stores/auth.ts）——
 *    两条路都走到也只会请求一次 userinfo，**不是写重了**。
 *    这里保留是为了「不依赖路由是否被触发」（例如将来出现无路由的场景）。
 *
 * @author yijiu2025
 * @since 2026-10-05
 */
import { onMounted } from 'vue';
import { ElConfigProvider } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import AppShell from '@/components/layout/AppShell.vue';
import SsoLoginModal from '@/components/sso/SsoLoginModal.vue';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();

onMounted(() => {
  void authStore.init();
});
</script>

<template>
  <el-config-provider :locale="zhCn">
    <AppShell />
    <SsoLoginModal />
  </el-config-provider>
</template>
