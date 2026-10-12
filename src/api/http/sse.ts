/**
 * SSE（Server-Sent Events）读取 —— **传输层**。
 *
 * 只做一件事：把 `fetch` 回来的响应体按 SSE 分帧规则切开，逐条 `JSON.parse` 后回调。
 * 它**不认识任何业务**：不知道是"逆合成分析"还是"候选条件枚举"，也不知道事件里
 * 有 `model` 还是 `delta`。事件类型由调用方以泛型传入。
 *
 * ── 为什么单独成文件 ──
 *   这套分帧逻辑原先埋在 `api/retro.ts` 里约 220 行，但它与"逆合成"毫无关系 ——
 *   任何走 SSE 的后端都能用。放在业务文件里有两个代价：
 *   ① 读 `retro.ts` 的人要跳过一大段与本文件主题无关的代码；
 *   ② 第二条 SSE 业务要复用它时，只能整个 import `retro.ts`（连带三个 axios 实例）。
 *
 * ── 为什么不用 EventSource / axios ──
 *   · `EventSource`：只能发 **GET**、不能带 body。而这里必须把「产物 + 前体 +
 *     路线上下文」作为 JSON body 传过去 ⇒ 用 fetch。
 *   · `axios`：浏览器端拿不到**增量** body（XHR 无流式读取）⇒ 必须 fetch + ReadableStream。
 *
 * ── SSE 分帧规则 ──
 *   事件之间以**空行**分隔，行前缀 `data: `。这里按行缓冲、遇空行才 dispatch，
 *   避免把一个 JSON 从中间切断（后端每条事件都是一整行 JSON，故可安全按行切）。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { notifyUnauthorized } from './session';

/**
 * 读一条 SSE 流并逐事件回调 —— **传输层的通用能力**，分析与追问共用。
 *
 * 🔴 为什么不用 EventSource：只能发 GET、不能带 body，而这里必须把
 *    「产物 + 前体 + 路线上下文」作为 JSON body 传过去 ⇒ 用 fetch。
 * 🔴 为什么不用 axios：浏览器端拿不到**增量** body（XHR 无流式读取）⇒ fetch + ReadableStream。
 *
 * @param baseUrl 端点所在的服务根（如 `{API}/retroweb/v1`），本模块不关心它指向谁
 * @param path    相对路径（如 `/llm/analyze/stream`）
 * @param body    POST 体（EventSource 不能带 body，这是用 fetch 的原因之一）
 * @param signal  取消信号：调用方据此实现"停止生成"。**abort 不算错误**，
 *                静默收尾（否则每次正常停止都会弹一条红色错误）
 * @param onEvent 每条事件的回调（泛型 T 由调用方给定业务形状）；解析不了的
 *                分片（半截 JSON / 心跳）静默丢弃，不会打断整条流
 * @param onError 出错时的兜底文案回调。⚠️ 401 走登录流（`notifyUnauthorized`）**不调它**
 *                —— 登录窗已经说明了，再挂一条错误条只会吵
 * @returns 流读完、被取消、或出错后 resolve —— **本函数几乎不 reject**：
 *          失败一律通过 `onError` 传达，让调用方只需处理一个出口
 */
async function postSse<T extends { type: string }>(
  baseUrl: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
  onEvent: (evt: T) => void,
  onError: (message: string) => void
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      // 🔴 跨源到 Node 中转时必须带上 sid cookie，否则 SSE 请求会以 401 失败
      //    （连第一条 meta 事件都收不到）。
      credentials: 'include',
      signal
    });
  } catch (e) {
    // 🔴 **abort 不是错误**：用户点「停止」时，若请求还停在"等响应头"阶段，
    //    `await fetch` 会以 AbortError 拒绝 ⇒ 这里若不拦，界面就会显示
    //    「signal is aborted without reason」这种**浏览器内部措辞**，
    //    用户完全看不懂，还会以为是自己把程序弄坏了。
    //    ⚠️ 本函数头注释一直写着"abort 不算错误，静默收尾"，但只有下面的
    //       读取循环实现了它，这一处漏了 —— 两处必须一致。
    //    判据用 `signal.aborted` 与 `name`，**不看 message**（文案会变）。
    if (signal?.aborted || (e as Error)?.name === 'AbortError') return;
    onError((e as Error)?.message || '请求大模型失败');
    return;
  }

  if (!resp.ok) {
    // 🔴 401 归登录流管 —— 与 axios 客户端同一套语义。
    //    这条是 fetch 路径（SSE 不能用 axios），拦截器覆盖不到，**必须显式处理**；
    //    否则登录窗不会打开，而 `onError` 还会再挂一条错误条，跟登录窗吵成一团。
    if (resp.status === 401) {
      notifyUnauthorized();
      return;
    }
    let detail = `HTTP ${resp.status}`;
    try {
      // 🔴 两种走法的错误字段名**不一样**，必须都认：
      //   · 直连 Python（Flask）→ `{ error: "..." }`
      //   · Node 中转 → 统一信封 `{ code, message, data }`，拒因在 `message`
      //     （见根仓 `app/retroweb/services/upstream.service.js` 的 forwardStream）
      //   原先只读 `error` ⇒ 走 Node 时拿不到任何说明，界面上只剩一个干巴巴的
      //   「HTTP 502」，用户和排查的人都不知道到底哪里坏了。
      const payload = (await resp.json()) as { error?: string; message?: string };
      const msg = payload?.error || payload?.message;
      if (msg) detail = msg;
    } catch {
      /* 非 JSON 响应，保持 HTTP 状态码 */
    }
    onError(detail);
    return;
  }
  if (!resp.body) {
    onError('后端没有返回流式响应体');
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatch = (rawEvent: string): void => {
    // 一个事件可能有多行 data:（SSE 允许），这里只取 data 行并拼接
    const dataLines = rawEvent
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return;
    let evt: T;
    try {
      evt = JSON.parse(dataLines.join('\n')) as T;
    } catch {
      return; // 半截 JSON 或心跳，忽略
    }
    onEvent(evt);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 事件以空行分隔；统一成 \n 处理（后端用的就是 \n\n）
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (rawEvent.trim()) dispatch(rawEvent);
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } catch (e) {
    // 🔴 AbortError 是**用户主动取消**（点了"停止生成"），不是故障 ⇒ 不报错，
    //    否则每次正常停止都会弹一条红色错误。
    if ((e as Error)?.name !== 'AbortError') {
      onError((e as Error)?.message || '读取流式响应失败');
    }
  }
}

export { postSse };
