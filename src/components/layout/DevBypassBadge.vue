<script setup lang="ts">
/**
 * 开发模式角标。
 *
 * `VITE_AUTH_BYPASS=true` 时显示 —— 提示「当前未做鉴权」，避免线上误以为已登录。
 */
import { computed } from 'vue';
import { WarnTriangleFilled } from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const visible = computed(() => authStore.bypass && authStore.loggedIn);
</script>

<template>
  <el-tooltip
    v-if="visible"
    content="开发模式：已跳过登录校验（VITE_AUTH_BYPASS=true），生产环境必须关闭"
    placement="bottom"
  >
    <span class="dev-badge">
      <el-icon><WarnTriangleFilled /></el-icon>
      开发模式 · 免登录
    </span>
  </el-tooltip>
</template>

<style scoped>
.dev-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: #b45309;
  background: var(--rw-warn-l);
  border: 1px solid rgba(180, 83, 9, 0.25);
}
</style>
