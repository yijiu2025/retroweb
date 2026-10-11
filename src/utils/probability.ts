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
 *
 * @author yijiu2025
 * @since 2026-10-11
 */

/** 单步概率文案：手动步给「手动」两个字，其余按百分比
 * @param probability 该步概率（0~1；`NaN`/`Infinity` 显示为「—」）
 * @param manual       是否为手动步（手动步显示「手动」两字，**不显示百分比**）
 * @returns 单步概率文案
 */
function stepPct(probability: number, manual?: boolean): string {
  if (manual) return '手动';
  if (!Number.isFinite(probability)) return '—';
  return `${(probability * 100).toFixed(1)}%`;
}

/**
 * 整条路线的总概率文案。
 *
 * 🔴 原先这里还有一个 `stepPctTitle()`（单步概率的 tooltip）和一个 `manualStepsNote()`
 *    （含手动步的补充说明），实际**零调用**：两个 tooltip 最终都直接复用了已有的
 *    `routePct` 文案，没人再单独拼单步说明。删掉 —— 留着只会让人以为"改文案要改三处"。
 *
 * `manualSteps > 0` 时**必须**带上后缀 —— 否则那个数字看着像"模型的整体评估"，
 * 实际里面有几步是用户自己定的，两者不可比。
 *
 * @param digits 小数位。默认 2；只有 1 位小数历史的调用点传 1，避免改变既有显示。
 * @param probability 整条路线概率（连乘值，0~1）
 * @param manualSteps 含手动步的数量；> 0 时文案追加「（含 N 步手动）」
 * @param digits      小数位。默认 2；只有 1 位小数历史的调用点传 1，避免改变既有显示。
 * @returns 路线总概率文案；`manualSteps > 0` 时必带后缀（否则数字会被误读为模型整体评估）
 */
function routePct(probability: number, manualSteps = 0, digits = 2): string {
  if (!Number.isFinite(probability)) return '—';
  const base = `${(probability * 100).toFixed(digits)}%`;
  return manualSteps > 0 ? `${base}（含 ${manualSteps} 步手动）` : base;
}

export { stepPct, routePct };
