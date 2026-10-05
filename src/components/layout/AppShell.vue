<script setup lang="ts">
/**
 * 应用外壳：侧边导航 + 顶栏 + 内容区。
 *
 * 侧栏自下而上分三段：
 *   ① 品牌
 *   ② 主导航（工作台 / 历史记录 / 个人中心）
 *   ③ **最近的任务**（常驻列表，不是一个按钮 + 抽屉 —— 任务入口应当随手可点）
 *
 * 布局断点：
 *   ≥1280px  侧栏展开
 *   <1024px  侧栏自动收成图标条（.app.is-collapsed，此时最近任务列表隐藏）
 *   <768px   侧栏变抽屉（由 isMobile 控制覆盖层）
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Fold, Expand, Moon, Sunny } from '@element-plus/icons-vue';
import { useSettingsStore } from '@/stores/settings';
import { useWorkspaceStore } from '@/stores/workspace';
import UserMenu from './UserMenu.vue';
import DevBypassBadge from './DevBypassBadge.vue';
import SessionPanel from '@/components/workspace/SessionPanel.vue';

const settings = useSettingsStore();
const store = useWorkspaceStore();
const route = useRoute();
const router = useRouter();

const isMobile = ref(false);

const collapsed = computed({
  get: () => settings.sidebarCollapsed || isMobile.value,
  set: (v: boolean) => {
    settings.sidebarCollapsed = v;
  }
});

/** 打开某个历史任务：恢复它的路线树 + 收起标定面板，必要时跳回工作台 */
function openSession(id: string): void {
  store.loadSession(id);
  if (route.path !== '/') void router.push('/');
}


const navItems = [
  { path: '/', label: '工作台', icon: '⌗' },
  { path: '/history', label: '历史记录', icon: '⟲' },
  { path: '/profile', label: '个人中心', icon: '☺' }
];

const pageTitle = computed(() => (route.meta.title as string) || '逆合成工作台');
const pageDesc = computed(() => (route.meta.desc as string) || '');

function onResize(): void {
  isMobile.value = window.innerWidth < 768;
}

onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div class="app" :class="{ 'is-collapsed': collapsed }">
    <aside class="app__aside">
      <div class="app__brand">
        <span class="app__logo">R</span>
        <span v-show="!collapsed" class="app__brand-text">
          <b>RetroWeb</b>
          <i>逆合成工作台</i>
        </span>
      </div>

      <nav class="app__nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          type="button"
          class="app__nav-item"
          :class="{ 'is-active': route.path === item.path }"
          :title="item.label"
          @click="router.push(item.path)"
        >
          <span class="app__nav-icon">{{ item.icon }}</span>
          <span v-show="!collapsed">{{ item.label }}</span>
        </button>
      </nav>

      <!-- 最近的任务：常驻列表，点一条即恢复该任务的路线树 -->
      <div v-show="!collapsed" class="app__recent rw-scroll">
        <SessionPanel @open="openSession" />
      </div>

      <div class="app__aside-foot">
        <button type="button" class="app__collapse" @click="collapsed = !collapsed">
          <el-icon><component :is="collapsed ? Expand : Fold" /></el-icon>
          <span v-show="!collapsed">收起侧栏</span>
        </button>
      </div>
    </aside>

    <div class="app__main">
      <header class="app__header">
        <div class="app__heading">
          <h1>{{ pageTitle }}</h1>
          <p v-if="pageDesc">{{ pageDesc }}</p>
        </div>
        <div class="app__actions">
          <DevBypassBadge />
          <el-tooltip :content="settings.isDark ? '切换为浅色' : '切换为深色'" placement="bottom">
            <button type="button" class="app__icon-btn" @click="settings.toggle()">
              <el-icon><component :is="settings.isDark ? Sunny : Moon" /></el-icon>
            </button>
          </el-tooltip>
          <UserMenu />
        </div>
      </header>

      <main class="app__content rw-scroll">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ---------- 侧栏 ---------- */
.app__aside {
  display: flex;
  flex-direction: column;
  width: 236px;
  flex: 0 0 236px;
  background: var(--rw-surface);
  border-right: 1px solid var(--rw-border);
  transition: width 0.18s ease, flex-basis 0.18s ease;
}

.app.is-collapsed .app__aside {
  width: 64px;
  flex-basis: 64px;
}

.app__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 60px;
  padding: 0 16px;
  border-bottom: 1px solid var(--rw-border);
}

.app__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  border-radius: 9px;
  background: linear-gradient(135deg, #16265c 0%, #1e40af 48%, #2f6df0 100%);
  color: #fff;
  font-weight: 800;
  font-size: 16px;
}

.app__brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  overflow: hidden;
}

.app__brand-text b {
  font-size: 15px;
  color: var(--rw-text);
}

.app__brand-text i {
  font-style: normal;
  font-size: 11px;
  color: var(--rw-text-3);
}

.app__nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px 10px;
  /* 导航只占自身高度，"最近的任务"才是可伸缩的那一段 */
  flex: 0 0 auto;
}

.app__nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 0;
  border-radius: var(--rw-radius-sm);
  background: transparent;
  color: var(--rw-text-2);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}

.app__nav-item:hover {
  background: var(--rw-surface-2);
  color: var(--rw-text);
}

.app__nav-item.is-active {
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-weight: 600;
}

.app__nav-icon {
  width: 18px;
  text-align: center;
  font-size: 15px;
}

.app__aside-foot {
  padding: 10px;
  border-top: 1px solid var(--rw-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
}

/* 「最近的任务」：夹在导航与底部之间，占满剩余高度，超出滚动 */
.app__recent {
  flex: 1;
  min-height: 0;
  padding: 10px 0 4px;
  border-top: 1px solid var(--rw-border);
  overflow-y: auto;
}

.app__collapse {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--rw-radius-sm);
  background: transparent;
  color: var(--rw-text-3);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.app__collapse:hover {
  background: var(--rw-surface-2);
  color: var(--rw-text);
}

/* ---------- 主区 ---------- */
.app__main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 60px;
  padding: 0 22px;
  background: var(--rw-surface);
  border-bottom: 1px solid var(--rw-border);
}

.app__heading {
  min-width: 0;
}

.app__heading h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--rw-text);
  /* 窄屏标题不许换行（换行会把 60px 顶栏撑高、挤压内容区） */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app__heading p {
  margin: 0;
  font-size: 12px;
  color: var(--rw-text-3);
}

.app__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app__icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  cursor: pointer;
}

.app__icon-btn:hover {
  color: var(--rw-brand);
  border-color: var(--rw-brand);
}

.app__content {
  flex: 1;
  min-height: 0;
  padding: 18px 22px;
}

@media (max-width: 768px) {
  .app__content {
    padding: 12px;
  }
  .app__heading p {
    display: none;
  }
  /* 窄屏顶栏只留必要元素：标题 + 主题 + 用户，避免挤成两行 */
  .app__actions {
    gap: 6px;
  }
  .app__header {
    padding: 0 12px;
    height: 52px;
    gap: 8px;
  }
  .app__heading h1 {
    font-size: 15px;
  }
}
</style>
