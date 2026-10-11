/**
 * 稳定设备标识。
 *
 * 跨 origin 场景下 cookie 不可靠，故用 `x-device-id` 请求头主动发送。
 * iframe 登录成功后，oauth21 会把它的权威 deviceId 随 LOGIN_SUCCESS 下发，
 * 宿主用 `adoptDeviceId()` 归一到同一个 ID —— 必须在 bind-session **之前**
 * 执行，否则绑定请求携带的指纹与后续请求不一致，可能触发风控误报。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
const DEVICE_KEY = 'retroweb_device_id';

/**
 * @returns 一个新的随机标识：优先 `crypto.randomUUID()`，降级为
 *          `dev-<时间戳36进制>-<随机串>`（老浏览器 / 非安全上下文）
 */
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @returns 本机稳定设备标识。首次调用生成并写入 localStorage；
 *          🔴 localStorage 不可用（隐私模式等）时**每次返回新值** ——
 *          这是可接受的降级：换设备免切登录会失效，但不会崩
 */
function getDeviceId(): string {
  try {
    const cached = localStorage.getItem(DEVICE_KEY);
    if (cached) return cached;
    const fresh = randomId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return randomId();
  }
}

/**
 * 采纳 oauth21 下发的设备 ID。
 * 只接受长得像设备 ID 的值（≥8 字符），异常值仅告警不阻断登录。
 * @param id oauth21 下发的权威 deviceId
 * @returns 无（void）；长度 < 8 的可疑值只告警、**不写也不阻断登录**
 */
function adoptDeviceId(id: string): void {
  if (!id || id.length < 8) {
    console.warn('[device] 忽略可疑的 deviceId:', id);
    return;
  }
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export { getDeviceId, adoptDeviceId };
