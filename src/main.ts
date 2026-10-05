import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setUnauthorizedHandler } from '@/api/http';
import { useAuthStore } from '@/stores/auth';

// Element Plus：样式全量引入（组件本身按需自动引入，见 vite.config.ts 的 ElementPlusResolver）
import 'element-plus/dist/index.css';
// 暗色 CSS 变量（html.dark 下生效）
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles/index.scss';

const app = createApp(App);

app.use(createPinia());
app.use(router);

// 401 / 会话过期 → 交给 auth store 打开登录弹窗（依赖方向：main → http，不反向）
setUnauthorizedHandler((reason: string) => useAuthStore().markExpired(reason));

app.mount('#app');
