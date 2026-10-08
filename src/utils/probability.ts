/**
 * 「这一步 / 这条路线有多少概率」的**统一文案口径**。
 *
 * 为什么必须收在一处：手动步（`Reaction.origin === 'manual'`）的概率是 `null` ——
 * 那是**"模型没表态"**，既不是"概率为 0"（渲染成 `0.0%` 会被读成此路不通），
 * 也不是"稳稳的 100%"（渲染成 `100.0%` 会被读成模型很有把握）。
 * 所以凡是要显示概率的地方一律走这里，**不要**再自己写 `(p * 100).toFixed(1)`。
 *
 * 🔴 连乘口径：手动步按 **1** 计入（见 `stores/workspace.ts` 的 `simulateScheme`），
 *    所以含手动步的"总概率"与纯模型路线**不可比** —— `routePct` 会把这件事
 *    直接写在文案里，不留给使用者去猜。
 */

/** 单步概率文案：手动步给「手动」两个字，其余按百分比 */
export function stepPct(probability: number, manual?: boolean): string {
  if (manual) return '手动';
  if (!Number.isFinite(probability)) return '—';
  return `${(probability * 100).toFixed(1)}%`;
}

/** 单步概率的 tooltip（鼠标悬停时要说清"为什么这里没有数字"） */
export function stepPctTitle(probability: number, manual?: boolean): string {
  if (manual) return '这一步是你手动指定的，没有模型概率';
  if (!Number.isFinite(probability)) return '这一步没有概率数据';
  return `该步概率 ${(probability * 100).toFixed(1)}%`;
}

/**
 * 整条路线的总概率文案。
 *
 * `manualSteps > 0` 时**必须**带上后缀 —— 否则那个数字看着像"模型的整体评估"，
 * 实际里面有几步是用户自己定的，两者不可比。
 *
 * @param digits 小数位。默认 2；只有 1 位小数历史的调用点传 1，避免改变既有显示。
 */
export function routePct(probability: number, manualSteps = 0, digits = 2): string {
  if (!Number.isFinite(probability)) return '—';
  const base = `${(probability * 100).toFixed(digits)}%`;
  return manualSteps > 0 ? `${base}（含 ${manualSteps} 步手动）` : base;
}

/** 含手动步时的补充说明（给 tooltip 用）；没有手动步时返回空串，调用方就别加 title 了 */
export function manualStepsNote(manualSteps: number): string {
  if (manualSteps <= 0) return '';
  return `这条路线里有 ${manualSteps} 步是你手动指定的，没有模型概率（连乘时按 1 计），与纯模型路线的总概率不可比。`;
}
