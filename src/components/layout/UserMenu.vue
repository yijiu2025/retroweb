<script setup lang="ts">
/** 右上角用户区：未登录 → 登录按钮；已登录 → 头像菜单 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';

const authStore = useAuthStore();
const router = useRouter();

const username = computed(() => authStore.user?.username || '未登录');
const initial = computed(() => username.value.charAt(0).toUpperCase());

async function onLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      type: 'warning',
      confirmButtonText: '退出',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  await authStore.logout();
  ElMessage.success('已退出登录');
  void router.push('/');
}

function goProfile(): void {
  void router.push('/profile');
}
</script>

<template>
  <div class="user-menu">
    <template v-if="authStore.loggedIn">
      <el-dropdown trigger="click" @command="(c: string) => (c === 'profile' ? goProfile() : onLogout())">
        <div class="user-menu__trigger">
          <span class="user-menu__avatar">
            <img v-if="authStore.user?.avatar" :src="authStore.user.avatar" :alt="username" />
            <span v-else>{{ initial }}</span>
          </span>
          <span class="user-menu__name">{{ username }}</span>
          <el-icon><ArrowDown /></el-icon>
        </div>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="profile">个人中心</el-dropdown-item>
            <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>
    <el-button v-else type="primary" size="small" @click="authStore.openLogin()">登录</el-button>
  </div>
</template>

<style scoped>
.user-menu__trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s;
  outline: none;
}

.user-menu__trigger:hover {
  background: var(--rw-surface-3);
}

.user-menu__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(135deg, #3b76f0, #1d4ed8);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
}

.user-menu__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.user-menu__name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--rw-text);
}
</style>
