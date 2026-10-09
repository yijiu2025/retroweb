/**
 * 时间文案。
 *
 * 抽出来的理由：侧栏「最近的任务」和整页「任务列表」都要显示"多久之前"，
 * 两处各写一份迟早漂移（一处改了文案口径，另一处还是旧的）。
 */
/** 「刚刚 / N 分钟前 / N 小时前 / MM-DD」—— 近的给相对值，远的给日期 */
export function relativeTime(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return shortDate(ts);
}

/** 「MM-DD」—— 相对时间退化为日期时用（列表里只放得下这么长） */
export function shortDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 「2026/10/09 11:04:11」—— 悬停提示用，相对时间说不清时要能查到精确值 */
export function absoluteTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
