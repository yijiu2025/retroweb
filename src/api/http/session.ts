/**
 * 会话失效（HTTP 401）的**唯一语义出口**。
 *
 * 本文件只做一件事：把「401 ⇒ 该弹登录窗了」这件事，定义成一处可被复用的约定。
 * 它**不认识任何业务**：不知道登录弹窗长什么样、不知道用户数据存在哪、不知道要不要跳转。
 * 那是上层（`api/session/install.ts` 注入的实现）的事。
 *
 * ── 为什么要独立成文件 ──
 *   原来这套逻辑直接写在 `api/http.ts` 里，导致三个后果：
 *   ① `http.ts` 一边是"发请求"、一边是"会话状态机"，两件事互相干扰；
 *   ② 想在**不走 axios 拦截器**的地方（`fetch` 读 SSE）复用 401 语义，只能去 import
 *      整个 `http.ts`，连带把 axios 实例也拖进来；
 *   ③ 业务侧要判断"这个错误是不是登录流接管的"，被迫依赖 `http.ts` 的一切导出。
 *   拆开后：传输层 import 本文件拿"处理 401"，业务侧 import 本文件拿"判断是不是 401 错误"，
 *   两者都不必认识 axios。
 *
 * ── 三种用法 ──
 *   ① 传输层（`api/http/client.ts`、`api/retro/client.ts`）：`intercept401(error, replay)`
 *   ② 非拦截器出口（SSE / 兜底）：`notifyUnauthorized(reason?)`
 *   ③ 业务侧让位判断：`isUnauthorizedError(err)`
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import type { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

/**
 * 401 专用哨兵（打在 error 对象上的标记位）。
 *
 * 🔴 为什么需要它：拦截器遇到 401 会先尝试续期，彻底失败后 reject 出来的 `Error`
 *    长得跟普通业务错误一模一样（只有 message 不同）。业务侧的 catch 分不清
 *    「这次失败已经被登录弹窗接管了」还是「真出了别的岔子」，于是会在**已经弹窗的同时**
 *    再挂一条业务错误条 —— 用户从没登录过，却看到「登录已过期，请重新登录」。
 *    打上标记后，业务侧可以显式判断并让位给统一的登录流。
 */
const UNAUTHORIZED = '__rw_unauthorized__';

/** 会话过期文案：**唯一来源**。多处各写一遍会导致措辞漂移。 */
const SESSION_EXPIRED = '登录已过期，请重新登录';

/**
 * 登录流回调（由 `api/session/install.ts` 在启动时注册）。
 *
 * 🔴 为什么用注册口而不是直接 import auth store：
 *    依赖链是 `stores/auth → api/auth → api/http`。若本文件反向 import auth store 就成环
 *    （打包器也会报 `INEFFECTIVE_DYNAMIC_IMPORT`）。改成「这里只暴露一个空槽，
 *    装配方时注入」，依赖方向保持单向。
 */
type LoginNotifier = (reason: string) => void;
let notifyLogin: LoginNotifier | null = null;

/**
 * 注册「会话失效时该做什么」的回调。
 *
 * ⚠️ 全局只有一个槽位，**后注册覆盖先注册**；只能在启动时调用一次
 *    （`api/session/install.ts` 是唯一调用点）。
 *
 * @param handler 收到失效原因（人话文案），由调用方决定如何呈现
 * @returns 无（void）；注册即刻生效，影响此后所有 401 处理
 */
function setUnauthorizedHandler(handler: LoginNotifier): void {
  notifyLogin = handler;
}

/**
 * 触发登录流。
 *
 * @param reason 展示给用户的失效原因
 * @returns 无（void）；**没注册回调时静默返回** —— 单测/预渲染场景下不该因此崩掉
 */
function requestLogin(reason: string): void {
  notifyLogin?.(reason);
}

/**
 * 手动通知「会话已失效」。
 *
 * 供**不走 axios 拦截器**的出口使用：SSE 路径（`fetch`，拦截器覆盖不到）与 `fail()`
 * 的兜底分支。保证全局只有一个登录弹窗来源，语义与其他客户端一致。
 *
 * @param reason 展示给用户的说明，默认「登录已过期，请重新登录」
 * @returns 无（void）；效果 = 调用已注册的登录流回调（没注册则什么都不发生）
 */
function notifyUnauthorized(reason: string = SESSION_EXPIRED): void {
  requestLogin(reason);
}

/**
 * 带「一次性重放」守卫的请求配置。
 *
 * 用局部类型而不是 module augmentation：`AxiosRequestConfig` 是泛型接口，
 * 声明合并要连类型参数一起对齐，为一个私有字段不值当。
 */
type RetriableConfig = AxiosRequestConfig & { _retry?: boolean };

/**
 * 造一个「已被登录流接管」的错误（带哨兵标记）。
 *
 * @param message 展示给用户 / 日志的文案（一般就是 `SESSION_EXPIRED`）
 * @returns 一个带 `__rw_unauthorized__` 标记的 `Error`，业务侧可用
 *          `isUnauthorizedError(e)` 判定并让位给登录流
 */
function createUnauthorizedError(message: string): Error {
  return Object.assign(new Error(message), { [UNAUTHORIZED]: true });
}

/**
 * 判定：这个错误是不是 401 且已被登录流接管。
 *
 * 🔴 业务侧的错误分支应先问这一句 —— 为真就**别再弹错误条**（登录窗已经说明了）。
 *
 * @param e 任意捕获到的错误（axios 的、我们自己造的都可以）
 * @returns 带哨兵返回 true，否则 false（`null`/`undefined`/非对象都安全返回 false）
 */
function isUnauthorizedError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as Record<string, unknown>)[UNAUTHORIZED] === true;
}

/** 续期中的飞行标记 + 排队者（单飞续期的状态） */
let isRefreshing = false;
let pendingQueue: ((ok: boolean) => void)[] = [];

/**
 * 发一次续期请求。**由本模块内部注入**（`api/http/client.ts` 在创建实例时接上），
 * 避免本文件为了知道续期端点而 import 整个 client 模块（那会成环）。
 */
type RefreshFn = () => Promise<unknown>;
let doRefresh: RefreshFn | null = null;

/**
 * 注入续期请求的实现（**由 `api/http/client.ts` 在建实例时调用**）。
 *
 * 🔴 反向注入的原因：session 需要知道续期端点，但 `client.ts` 又 import 本文件 ——
 *    直接 import 就成环。所以这里只留一个空槽，由 client 填配方。
 *
 * @param fn 实际发续期请求的函数（必须用**不带 401 拦截器**的实例，见 `refreshClient`）
 * @returns 无（void）；注入即刻生效，不传则 401 时跳过续期直接走登录流
 */
function setRefreshFn(fn: RefreshFn): void {
  doRefresh = fn;
}

/**
 * 401 的统一处理：**单飞续期 → 成功则重放，失败则弹登录窗**。
 *
 * 单飞（`isRefreshing` + `pendingQueue`）的意义：并发 N 个请求同时 401 时，
 * 只发**一次**续期请求，其余排队等结果 —— 否则会打出 N 次续期（网关会限流）。
 *
 * @param config - 原始请求配置，重放时原样再发一次（`_retry` 标记也在这上面）
 * @param replay - 重放函数。**必须由调用方传入**：不同 axios 实例的 baseURL 与
 *   拦截器链都不同，用同一个实例重放 retro 的请求会打错地址。
 * @returns 续期成功 → 重放结果；续期失败 → reject 一个带哨兵的
 *   `createUnauthorizedError`（并已触发登录流）。
 *   并发请求（续期已在飞）→ 返回一个排队中的 Promise，等同一轮续期的结果
 */
async function handle401(
  config: AxiosRequestConfig,
  replay: (config: AxiosRequestConfig) => Promise<unknown>
): Promise<unknown> {
  if (!isRefreshing) {
    isRefreshing = true;
    try {
      await doRefresh?.();
      pendingQueue.forEach((cb) => cb(true));
      pendingQueue = [];
      return replay(config);
    } catch (e) {
      // 🔴 必须留痕：原先这里是空 `catch {}`，线上「用户为什么突然弹登录窗」无从查证
      //    —— 401（续期票也废了）/ 网络断 / 超时，三种原因的处置完全不同。
      console.warn('[session] 会话续期失败，转入登录流程', e);
      pendingQueue.forEach((cb) => cb(false));
      pendingQueue = [];
      requestLogin(SESSION_EXPIRED);
      return Promise.reject(createUnauthorizedError(SESSION_EXPIRED));
    } finally {
      isRefreshing = false;
    }
  }
  return new Promise((resolve, reject) => {
    pendingQueue.push((ok) => {
      if (ok) resolve(replay(config));
      else reject(createUnauthorizedError(SESSION_EXPIRED));
    });
  });
}

/**
 * 401 判定 + 接管（所有 axios 实例共用的**唯一入口**）。
 *
 * 🔴 `_retry` 守卫为什么必须有：续期成功后重放请求，若**仍然 401**，
 *    没有守卫就会再进一次续期 → 再重放 → **无界循环**，把续期端点和目标接口打成风暴。
 *
 *    为什么原先用 `isRefreshing` 挡不住：`handle401` 里是
 *    `try { return replay(config) } finally { isRefreshing = false }` ——
 *    JS 中 `finally` 在处理完 return 表达式后**立即**执行，**不等**那个 promise settle。
 *    实测（2026-10-11）重放回来时 `isRefreshing` 早已是 false ⇒ 重放再 401 就会
 *    重新进入续期分支。**所以守卫必须记在「请求配置」上（随请求走），而不是记在模块状态上。**
 *
 * @param error - axios 抛出的错误
 * @param instance - 该错误所属的实例（重放走它自己，保证 baseURL / 拦截器链一致）
 * @returns 三种情形，调用方必须区分：
 *   · **null** —— 不是 401，或错误里没有 config（如网络错误）⇒ 调用方按普通错误处理
 *   · **Promise** —— 已接管：首轮 401 走「续期 + 重放」；重放后仍 401 则弹登录窗
 *     并 reject 带哨兵的 Error（业务侧用 `isUnauthorizedError(e)` 让位）
 *   —— 注意**接管后必然 settle**，调用方不需要再判 401。
 */
function intercept401(error: AxiosError, instance: AxiosInstance): Promise<unknown> | null {
  if (error?.response?.status !== 401) return null;
  const config = error?.config as RetriableConfig | undefined;
  if (!config) return null;

  if (config._retry) {
    // 已经「续期 + 重放」过一轮，**仍然 401** ⇒ 会话确实是坏的（不是票过期那种可自愈的）。
    // 此时要把话说完：弹登录窗，并抛**哨兵**（而不是让原生 AxiosError 冒上去）。
    // 🔴 若只让原生错误冒泡，调用方拿到的是「长得像普通业务错误」的东西 ⇒
    //    业务侧不会让位，于是界面既没有登录窗、又多一条看不懂的错误条。
    requestLogin(SESSION_EXPIRED);
    return Promise.reject(createUnauthorizedError(SESSION_EXPIRED));
  }

  config._retry = true;
  return handle401(config, (c) => instance(c));
}

/**
 * 给任意 axios 实例挂上 401 拦截器。
 *
 * 抽成公开函数是为了让 `api/retro/client.ts` 的三个实例复用**同一套**语义：
 * 原先只有 `http.ts` 自己的 `apiClient` 会弹登录窗，retro 侧的 401 只打哨兵、不触发登录流
 * ⇒ 会话在**使用中**过期时会被「静默吞掉」（既不报错也不弹窗，因为业务侧的
 * `isAuthFailure` 看见哨兵就让位了）。首屏之所以还能弹窗，只是因为
 * `authStore.init()` 恰好走了 apiClient 路径 —— 这种隐性耦合不该存在。
 *
 * ⚠️ 只处理 401，其余错误**原样透传** —— retro 自己的错误语义在 `fail()` 里，
 *    不能被这里的 message 改写覆盖。
 *
 * @param instance - 目标实例；重放走它自己，保证 baseURL / 拦截器链一致。
 *   `retro/client.ts` 的三个实例也用它挂 —— 否则 retro 侧 401 只打哨兵不弹窗
 * @returns 无（void）；拦截器在本实例上叠加注册（同一实例重复挂会重复触发，
 *   所以每个实例只应挂一次）
 */
function attachUnauthorizedInterceptor(instance: AxiosInstance): void {
  instance.interceptors.response.use(undefined, (error: AxiosError) => {
    return intercept401(error, instance) ?? Promise.reject(error);
  });
}

export {
  SESSION_EXPIRED,
  setUnauthorizedHandler,
  setRefreshFn,
  notifyUnauthorized,
  createUnauthorizedError,
  isUnauthorizedError,
  attachUnauthorizedInterceptor,
  intercept401
};

export type { LoginNotifier };
