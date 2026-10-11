/**
 * 时间文案。
 *
 * 抽出来的理由：侧栏「最近的任务」和整页「任务列表」都要显示"多久之前"，
 * 两处各写一份迟早漂移（一处改了文案口径，另一处还是旧的）。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
/** 「刚刚 / N 分钟前 / N 小时前 / MM-DD」—— 近的给相对值，远的给日期
 * @param ts 目标时间戳（毫秒）
 * @returns 近 1 小时内给「刚刚 / N 分钟前 / N 小时前」，超过 24 小时退化为 `shortDate`
 *          （即「MM-DD」）
 */
function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return shortDate(ts);
}

/**
 * 同 `relativeTime`，但**超过一天后继续往下数「N 天前」而不是退回日期**。
 *
 * 用在登录弹窗的账号列表（「上次登录 3 天前」）：那里用户关心的是"多久没用了"，
 * 一个 `10-09` 的日期反而要自己算。而任务列表/历史要的是"这条什么时候动的"，
 * 远期给日期更好定位 —— 两种口径各有道理，所以是两个函数而不是一个带开关的。
 * @param ts 目标时间戳（毫秒）
 * @returns 近 24 小时内给相对值，超过则给「N 天前」（**不退化为日期**，见文件头说明）
 */
function relativeDays(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/** 「MM-DD」—— 相对时间退化为日期时用（列表里只放得下这么长）
 * @param ts 目标时间戳（毫秒）
 * @returns 「MM-DD」，月日各补零到两位
 */
function shortDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 「2026-10-09 21:35」—— 元信息归档用：精确到分、比绝对时间短一截不折行
 * @param ts 目标时间戳（毫秒）
 * @returns 「YYYY-MM-DD HH:mm」（本地时区，精确到分）
 */
function dateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「2026/10/09 11:04:11」—— 悬停提示用，相对时间说不清时要能查到精确值
 * @param ts 目标时间戳（毫秒）
 * @returns 本地化完整时间串（`toLocaleString('zh-CN', {hour12:false})`）
 */
function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export { relativeTime, relativeDays, shortDate, dateTime, absoluteTime };
