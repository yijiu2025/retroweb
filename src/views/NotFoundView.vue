<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <section class="rw-card notfound">
    <div class="rw-card__body notfound__body">
      <div class="notfound__code">404</div>
      <p>页面不存在或已被移动。</p>
      <el-button type="primary" @click="router.push('/')">回到工作台</el-button>
    </div>
  </section>
</template>

<style scoped>
.notfound__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 60px 20px;
}

.notfound__code {
  font-size: 64px;
  font-weight: 800;
  color: var(--rw-brand);
  line-height: 1;
}

.notfound__body p {
  margin: 0;
  color: var(--rw-text-2);
}
</style>
