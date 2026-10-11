<script setup lang="ts">
/**
 * 个人中心 —— 账号信息 + 会话 + 「关于本项目」。
 *
 * 「关于本项目」（项目介绍 / GitHub 仓库 / 打赏码）与「运行设置」弹窗里是
 * **同一个组件**，文案单一来源在 `@/config/about.ts`。两处各写一份必然漂移。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { safeRemoteUrl } from '@/utils/safe-url';
import AboutProject from '@/components/common/AboutProject.vue';

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

      <!-- 关于本项目：介绍 + GitHub 仓库 + 自愿支持（与「运行设置」弹窗同一个组件） -->
      <el-divider class="profile__divider" />
      <AboutProject />
    </div>
  </section>
</template>

<style scoped>
.profile__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 🔴 别把上限压太窄：下面的「关于本项目」要并排放两张二维码，
   *    640px 会让它们挤成上下两行、且每张被压小。
   *    这个宽度是「账号信息那一段」的舒适宽度，不是整页的。 */
  max-width: 880px;
}

.profile__divider {
  margin: 4px 0 0;
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
