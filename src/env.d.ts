/// <reference types="vite/client" />

/**
 * 本项目自定义环境变量（声明收口）。
 *
 * 🔴 只有 `VITE_` 前缀才会被 Vite 注入到客户端；改了 .env 必须重启 dev server。
 * 🔴 反过来说：**任何带 `VITE_` 的值都会原样打进 JS 产物**，浏览器 F12 就能读到
 *    ⇒ 绝对不要往里放密钥（LLM key / DB 密码 / JWT secret）。
 *
 * ⚠️ dev 代理上游（`DEV_API_TARGET` / `DEV_RETRO_TARGET`）**刻意不带 VITE_ 前缀** ——
 *    它们只被 `vite.config.ts` 读取、不进产物，所以**不在本接口里**（也不要加）。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */

/**
 * 🔴 Vite 的「严格 env 模式」开关 —— 靠**声明合并**打开的，别看它长得像废代码。
 *
 * 背景：`vite/client` 里 `ImportMetaEnv extends Record<string, any>`（其 `ViteTypeOptions`
 * 为空时才如此）。那个 index signature 会让**任何** `import.meta.env.XXX` 都合法 ⇒
 * 下面这份清单**形同虚设**：把 `VITE_API_URL` 拼成 `VITE_API_UR` 也能过 `vue-tsc`，
 * 直到运行时静默拿到 `undefined`（表现为"配置没生效"，极难排查）。
 *
 * 实测（2026-10-11）：
 *   · 不加本块 → `import.meta.env.VITE_TYPO_NOT_DECLARED` **编译通过**（TS 不报错）
 *   · 加上本块 → 报 `TS2339: Property 'VITE_TYPO_NOT_DECLARED' does not exist on type 'ImportMetaEnv'`
 *
 * 原理：`vite/client` 里 `type ImportMetaEnvFallbackKey = 'strictImportMetaEnv' extends
 * keyof ViteTypeOptions ? never : string`。本块给 `ViteTypeOptions` 加上该键 ⇒ 键集非空
 * ⇒ FallbackKey 收敛为 `never` ⇒ `Record<never, any>` 不含任何键 ⇒ 只有下面显式声明的
 * 变量才存在。开关是全局的、没有逐个变量粒度，也不影响 `DEV`/`MODE`/`PROD`（它们在
 * `vite/client` 里已显式声明）。
 *
 * ⚠️ 必须放在文件**顶部**（`interface` 是全局声明，放哪都能合并；但这样最直观）。
 */
interface ViteTypeOptions {
  /** 非空即启用严格模式 —— 值本身无意义，只看这个键**在不在** */
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  /** 开发阶段免登录开关：'true' 时路由全放行并注入 dev 用户（生产严禁开启） */
  readonly VITE_AUTH_BYPASS?: string;
  /** 后端 API 根（Fastify 3000）；留空则走同源相对路径 + vite proxy */
  readonly VITE_API_URL?: string;
  /** oauth21 登录页根（dev 为 http://localhost:5174） */
  readonly VITE_SSO_URL?: string;
  /**
   * 逆合成算法服务的调用路径 —— 含义随 `VITE_RETRO_VIA_NODE` 变化：
   *  · false（直连 Python）：直接作为 API 根；dev 为 `/retro`，经 vite proxy 到 Flask 的 `/api`
   *  · true（走 Node 中转）：**不生效**，实际根为 `${VITE_API_URL}/retroweb/v1`
   */
  readonly VITE_RETRO_URL?: string;
  /** 算法请求走 Node 中转（'true'）还是直连 Python（'false'/未设） */
  readonly VITE_RETRO_VIA_NODE?: string;
  /** 任务持久化走服务端（'true'）；未登录 / 离线自动回落 localStorage */
  readonly VITE_PERSIST_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
