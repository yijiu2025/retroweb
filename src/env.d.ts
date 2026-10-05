/// <reference types="vite/client" />

/**
 * 本项目自定义环境变量。
 *
 * ⚠️ 只有 VITE_ 前缀才会被 Vite 注入到客户端；改了 .env 必须重启 dev server。
 */
interface ImportMetaEnv {
  /** 开发阶段免登录开关：'true' 时路由全放行并注入 dev 用户（生产严禁开启） */
  readonly VITE_AUTH_BYPASS?: string;
  /** 后端 API 根（Fastify 3000）；留空则走同源相对路径 + vite proxy */
  readonly VITE_API_URL?: string;
  /** oauth21 登录页根（dev 为 http://localhost:5174） */
  readonly VITE_SSO_URL?: string;
  /** 逆合成模型服务根（dev 为 /retro，由 vite proxy 转到 Flask 8000 的 /api） */
  readonly VITE_RETRO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
