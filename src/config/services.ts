/**
 * 服务地址与文案配置（对齐 posecraft/src/config/services.ts）
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
  APP_NAME,
  LOGIN_COPY,
  SSO_LOGIN_PARAMS,
  buildSsoLoginUrl,
  AUTH_BYPASS
};
