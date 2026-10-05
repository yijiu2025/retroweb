<script setup lang="ts">
/**
 * 应用根。
 *
 * - ElConfigProvider 提供中文文案（组件是按需自动引入的，locale 只能这样注入）
 * - SsoLoginModal 全局常驻：任何 401 / 需要登录的场景都由它弹 iframe 登录
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
