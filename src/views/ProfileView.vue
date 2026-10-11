<script setup lang="ts">
/** 个人中心 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { safeRemoteUrl } from '@/utils/safe-url';

const authStore = useAuthStore();
const router = useRouter();

const user = computed(() => authStore.user);
/** 头像地址过协议白名单（`avatar` 用户可控，见 utils/safe-url.ts 的说明） */
const avatarUrl = computed(() => safeRemoteUrl(user.value?.avatar));

async function onLogout(): Promise<void> {
  await authStore.logout();
  ElMessage.success('已退出登录');
  void router.push('/');
}
</script>

<template>
  <section class="rw-card profile">
    <div class="rw-card__head">
      <div class="rw-card__title">个人中心</div>
    </div>
    <div class="rw-card__body profile__body">
      <div class="profile__hero">
        <span class="profile__avatar">
          <img v-if="avatarUrl" :src="avatarUrl" :alt="user?.username" />
          <span v-else>{{ (user?.username || '?').charAt(0).toUpperCase() }}</span>
        </span>
        <div>
          <div class="profile__name">{{ user?.username || '未登录' }}</div>
          <div class="profile__uid">UID：{{ user?.uid || '—' }}</div>
        </div>
      </div>

      <el-descriptions :column="1" border size="small">
        <el-descriptions-item label="用户名">{{ user?.username || '—' }}</el-descriptions-item>
        <el-descriptions-item label="邮箱">{{ user?.email || '—' }}</el-descriptions-item>
        <el-descriptions-item label="登录方式">
          {{ authStore.bypass ? '开发模式（免登录）' : 'oauth21 统一身份' }}
        </el-descriptions-item>
      </el-descriptions>

      <div class="profile__ops">
        <el-button v-if="authStore.loggedIn" type="danger" plain @click="onLogout">退出登录</el-button>
        <el-button v-else type="primary" @click="authStore.openLogin()">立即登录</el-button>
      </div>

      <el-alert
        v-if="authStore.bypass"
        type="warning"
        :closable="false"
        title="当前为开发模式，未做真实鉴权；生产环境请将 VITE_AUTH_BYPASS 设为 false"
      />
    </div>
  </section>
</template>

<style scoped>
.profile__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}

.profile__hero {
  display: flex;
  align-items: center;
  gap: 14px;
}

.profile__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(135deg, #3b76f0, #1d4ed8);
  color: #fff;
  font-size: 22px;
  font-weight: 700;
}

.profile__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile__name {
  font-size: 18px;
  font-weight: 600;
}

.profile__uid {
  font-size: 12px;
  color: var(--rw-text-3);
}

.profile__ops {
  display: flex;
  gap: 8px;
}
</style>
