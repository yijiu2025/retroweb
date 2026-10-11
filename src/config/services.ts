/**
 * 服务地址与文案配置（对齐 posecraft/src/config/services.ts）
 *
 * @author yijiu2025
 * @since 2026-10-11
 */

/** API 服务（Fastify 3000）。留空 → 走同源相对路径（由 vite proxy 转发） */
const API_BASE_URL: string = import.meta.env.VITE_API_URL || '';

/** SSO 登录服务（oauth21 dev server） */
const SSO_URL: string = import.meta.env.VITE_SSO_URL || 'http://localhost:5174';

/** SSO 登录页路径：紧凑版，适合弹窗 */
const SSO_LOGIN_PATH = '/mini-login';

/** 逆合成模型服务：dev 为 /retro（vite proxy → Flask 8000 的 /api） */
const RETRO_BASE_URL: string = import.meta.env.VITE_RETRO_URL || '/retro';

/**
 * 算法调用是否改走 Node 中转（S3）。
 *
 * 🔴 关（默认）：`retroApi` / `llmApi` / SSE 直连 Python（现状，行为不变）。
 * 🔴 开：baseURL 指向 `API_BASE_URL + '/retroweb/v1'`，响应拆 `{code,message,data}` 信封，
 *    Python 从公网下线（只在 Node 后端内网可见，`RETRO_PYTHON_URL`）。
 */
const RETRO_VIA_NODE: boolean = import.meta.env.VITE_RETRO_VIA_NODE === 'true';

/**
 * 前端**是否有权启停模型**（加载 / 切换 / 停止模型服务、热挂正向模型）。
 *
 * 取值（`VITE_RETRO_MODEL_CONTROL`）：
 *  · `auto`（默认）—— 由档位决定：**直连 Python = 允许**、**走 Node 中转 = 禁止**
 *  · `on`          —— 强制允许（Node 侧暂时只是转发时，可临时用它保住现有体验）
 *  · `off`         —— 强制禁止
 *
 * 🔴 为什么「中转档」要禁止：走 Node 后**模型加载归 Node 管** —— 下盘、fork 子进程、
 *    阶段进度都是它的局部实现细节。前后端**都能点"加载"= 两个控制源抢同一个模型进程**
 *    （一个说在加载、另一个把进程停了），这类竞态极难复现。前端只该问"能不能用"。
 *    Node 侧现在虽然把 `/load` `/model-service/*` 原样转发了，但那是过渡状态，
 *    不能当作"前端继续负责启停"的依据。
 *
 * 🔴 为什么「直连档」必须允许：没有 Node 时**没有任何人能替用户拉起模型服务** ——
 *    禁掉就等于这个档位彻底不可用。所以默认跟随档位（auto），而不是写死。
 *
 * 见 `docs/plan-node-backend.md` §6.7 / §6.8。
 */
const MODEL_CONTROL_MODE: string = (import.meta.env.VITE_RETRO_MODEL_CONTROL || 'auto')
  .trim()
  .toLowerCase();

if (import.meta.env.DEV && !['auto', 'on', 'off'].includes(MODEL_CONTROL_MODE)) {
  // 取值写错时如实告警，别静默按 auto 走 —— 否则"配了没生效"又要查半天
  console.warn(
    `[config] VITE_RETRO_MODEL_CONTROL 取值无法识别：「${MODEL_CONTROL_MODE}」，按 auto 处理（可选 auto | on | off）`
  );
}

/** 前端此刻是否有权启停模型（见 `MODEL_CONTROL_MODE` 的说明） */
const MODEL_CONTROL_ENABLED: boolean =
  MODEL_CONTROL_MODE === 'on' ? true : MODEL_CONTROL_MODE === 'off' ? false : !RETRO_VIA_NODE;

/** 应用名（透传给 oauth21，登录页会显示"正在登录 XX"） */
const APP_NAME = 'retroweb';

/** 登录弹窗文案 */
const LOGIN_COPY = {
  title: '登录 RetroWeb 逆合成工作台',
  subtitle: '选择账号一键登录，或登录其他账号',
  ssoLoading: '正在加载安全登录…'
};

/** SSO 登录默认参数 */
const SSO_LOGIN_PARAMS: Record<string, string> = {
  lang: 'zh_cn',
  appName: APP_NAME,
  appEntrance: 'web',
  site: '01',
  isMobile: 'false',
  qrCodeFirst: 'false',
  notLoadSsoView: 'false'
  // 刻意不传 notKeepLogin：不干预 oauth21 登录页的「保持登录」勾选，
  // 勾选结果经 bind-session 的 accountKey / rememberMe 反向同步给宿主。
};

/**
 * 构建 iframe 登录地址。
 *
 * @param theme 'dark' | 'light' —— 由宿主当前主题传入，避免 iframe 首屏闪白
 *
 * 不需要 client_id：iframe 内走 directLogin，与 OAuth client 注册解耦。
 * @param theme 'dark' | 'light' —— 由宿主当前主题传入，避免 iframe 首屏闪白
 * @returns 完整的 `/mini-login?…` URL（`URLSearchParams` 已 encode）。
 *          每次都带随机 `rnd`，避免 iframe 命中旧缓存
 */
function buildSsoLoginUrl(theme?: 'dark' | 'light'): string {
  const base: Record<string, string> = {
    ...SSO_LOGIN_PARAMS,
    rnd: String(Math.random())
  };
  if (theme) base.theme = theme;
  const params = new URLSearchParams(base);
  return `${SSO_URL}${SSO_LOGIN_PATH}?${params.toString()}`;
}

/** dev 阶段免登录开关（生产严禁开启） */
const AUTH_BYPASS: boolean = import.meta.env.VITE_AUTH_BYPASS === 'true';

export {
  API_BASE_URL,
  SSO_URL,
  SSO_LOGIN_PATH,
  RETRO_BASE_URL,
  RETRO_VIA_NODE,
  MODEL_CONTROL_MODE,
  MODEL_CONTROL_ENABLED,
  APP_NAME,
  LOGIN_COPY,
  SSO_LOGIN_PARAMS,
  buildSsoLoginUrl,
  AUTH_BYPASS
};
