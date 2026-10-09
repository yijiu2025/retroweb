/**
 * 工作台 store 的「公共件」—— 纯常量与纯函数。
 *
 * 放这里的判据只有一条：**不依赖任何 store 状态**（不读节点、不读参数、不发请求）。
 * 这样它既能被主 store 用，也能被各个零件用，还能被组件直接 import，
 * 而不会引起循环依赖。
 */
import type { AnalysisModuleKey, Reaction, RunParams } from '@/types/retro';

/**
 * 候选反应的**确定性 id**：由「节点 + 前体组合」推出。
 *
 * 🔴 为什么不能用随机 uid：一个节点会被反复分析（保留历史 runs），也可能复用别的节点的
 *    相同分子分析。若 id 随机，切换 runs / 复用结果时 `chosenReactionId` 就对不上，
 *    已建的子树会被误判成「无效选择」而清掉。用确定性 id ⇒ 同样的前体组合永远同一个 id，
 *    选择、复用、切换全都稳定。
 */
export function reactionIdFor(nodeId: string, precursors: string): string {
  let h = 5381;
  const s = String(precursors || '');
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return `rxn_${nodeId}_${h.toString(36)}`;
}

/** 把任意来源的候选整理成「属于 nodeId」的形状（复用别人结果时必须重挂） */
export function materializeCandidates(nodeId: string, list: Reaction[]): Reaction[] {
  return list.map((r) => ({
    ...r,
    id: reactionIdFor(nodeId, r.precursors),
    productNodeId: nodeId,
    childNodeIds: []
  }));
}

export const DEFAULT_PARAMS: RunParams = {
  model: 'pistachio',
  numResults: 5,
  maxDepth: 4,
  // 阈值定 10 时阿司匹林拆一步就到底了（前体普遍 ≤10 重原子），「多次一步」形同虚设。
  // 6 = 苯环量级（苯 6、甲苯 7 继续拆），才是可购买起始物料的常用口径。
  heavyAtomThreshold: 6,
  startingMaterials: [],
  budgetCalls: 40,
  // 「可行性过滤」默认**关**：它要额外常驻一份正向模型（约 1 GB），而且要等它
  // 加载完才用得上 —— 没打算用的人不该被迫先下 835 MB。
  forwardFilter: false,
  // top-5 = 官方 evaluation 里 ForwardReactionFilterModel 的常用取值：放宽到 50 几乎
  // 不过滤（失去意义），收到 1 会误杀大量真反应。详见「拆分约束」里的说明。
  forwardTopK: 5
};

/**
 * AI 工艺分析可勾选的模块（默认全选）。
 * 🔴 顺序即面板展示顺序；`summary`（总述+反应类型）是每次分析的兜底，不在这里展示，
 *    但永远随请求带上。与后端 `_MODULE_FIELDS` 的 key 对齐。
 */
export const ALL_ANALYSIS_MODULES: AnalysisModuleKey[] = [
  'mechanism',
  'order',
  'conditions',
  'workup',
  'outcome',
  'byproducts',
  'lcms',
  'nmr',
  'tlc',
  'safety'
];

/** 模块 key → 中文名（RunParams 勾选面板用） */
export const ANALYSIS_MODULE_LABELS: Record<AnalysisModuleKey, string> = {
  summary: '总述与反应类型',
  mechanism: '反应机理',
  order: '投料顺序',
  conditions: '反应条件',
  workup: '后处理分析',
  outcome: '预期结果与收率',
  byproducts: '可能的副产物',
  lcms: 'LCMS 解读',
  nmr: 'NMR 谱图归属',
  tlc: '点板与过柱极性',
  safety: '安全与放大提示'
};

/** axios 的取消错误（用户点停止 / 组件卸载）—— 不该当失败弹错误条 */
export function isAbort(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ERR_CANCELED' || (err instanceof Error && err.name === 'CanceledError');
}

/** 可被打断的 sleep：abort 时立即 resolve，让轮询循环能尽快退出 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
