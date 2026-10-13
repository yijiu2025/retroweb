/**
 * 路由。
 *
 * 守卫口径：
 *  - 免登录（VITE_AUTH_BYPASS=true）：全部放行，注入 dev 用户，不弹 iframe
 *  - 严格模式：需要登录的页面未登录 → 打开登录弹窗（跳到哪由 authStore 记住）
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'workspace',
    component: () => import('@/views/WorkspaceView.vue'),
    meta: { title: '逆合成工作台', desc: '一行一化合物 · 多次一步交互式拆分', requiresAuth: true }
  },
  {
    path: '/tasks',
    name: 'tasks',
    component: () => import('@/views/TasksView.vue'),
    meta: { title: '任务列表', desc: '所有进行中与已完成的目标分析任务', requiresAuth: true }
  },
  {
    path: '/history',
    name: 'history',
    component: () => import('@/views/HistoryView.vue'),
    meta: { title: '历史记录', desc: '已保存的路线任务', requiresAuth: true }
  },
  {
    path: '/profile',
    name: 'profile',
    component: () => import('@/views/ProfileView.vue'),
    meta: { title: '个人中心', desc: '账号信息与会话', requiresAuth: true }
  },
  {
    path: '/settings/models',
    name: 'model-settings',
    component: () => import('@/views/ModelSettingsView.vue'),
    meta: { title: '模型设置', desc: '模型下载 / 手动放置 / CPU 与 GPU 切换', requiresAuth: true }
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在', desc: '' }
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach(async (to) => {
  const authStore = useAuthStore();
  await authStore.init();
  if (to.meta.requiresAuth && !authStore.loggedIn) {
    authStore.openLogin(to.fullPath);
  }
  return true;
});

export { router };

export default router;
