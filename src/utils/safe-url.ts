/**
 * 远端资源 URL 校验 —— 所有「把后端给的字符串塞进 `:src` / `:href`」的地方都过它。
 *
 * 🔴 为什么必须有：`avatar` 字段**用户可控**。
 *    后端 `PATCH /user/v1/profile` 的 `allowedFields` 直接收 `avatar`（DAO 不做协议校验），
 *    前端又原样绑到 `<img :src>`。攻击者把 avatar 设成
 *      · `javascript:alert(1)`                     —— 点开头像即执行
 *      · `data:text/html,<script>…</script>`       —— 顶层导航时变 XSS 载体
 *    就得到一个**存储型 XSS**：所有看到该用户头像的人中招。
 *    `<img src>` 本身不执行 `javascript:`，但它会触发一次请求，且这类 URL
 *    一旦被用在 `<a href>` / 新窗口打开（个人中心就有）就是真漏洞。
 *
 * 判据：**白名单协议**，不是黑名单。只放行 http/https（以及站内相对路径），
 * 其余（`javascript:` `data:` `vbscript:` `blob:` 等）一律判废。
 *    黑名单永远漏 —— `java\nscript:`、大小写、前导空白变体太多。
 *
 * @returns 合法则返回原串（已 trim），否则返回 null（调用方应回退到默认占位）
 */
function safeRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;

  // 站内相对路径 / 协议相对：交给浏览器按当前 origin 解析，无跨协议风险
  if (url.startsWith('/') && !url.startsWith('//')) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // 连 URL 都解析不了（含相对串、含空格的畸形串）⇒ 判废
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
}

/** 便捷版：只要不是合法远端 URL 就返回 fallback（用于直接绑模板的场景） */
function safeRemoteUrlOr(raw: unknown, fallback: string): string {
  return safeRemoteUrl(raw) ?? fallback;
}

export { safeRemoteUrl, safeRemoteUrlOr };
