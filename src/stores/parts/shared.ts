/**
 * 工作台 store 的「公共件」—— 纯常量与纯函数。
 *
 * 放这里的判据只有一条：**不依赖任何 store 状态**（不读节点、不读参数、不发请求）。
 * 这样它既能被主 store 用，也能被各个零件用，还能被组件直接 import，
 * 而不会引起循环依赖。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import type { AnalysisModuleKey, Reaction, RunParams } from '@/types/retro';

/**
 * 候选反应的**确定性 id**：由「节点 + 前体组合」推出。
 *
 * 🔴 为什么不能用随机 uid：一个节点会被反复分析（保留历史 runs），也可能复用别的节点的
 *    相同分子分析。若 id 随机，切换 runs / 复用结果时 `chosenReactionId` 就对不上，
 *    已建的子树会被误判成「无效选择」而清掉。用确定性 id ⇒ 同样的前体组合永远同一个 id，
 *    选择、复用、切换全都稳定。
 * @param nodeId     所属节点 id（树上的位置）
 * @param precursors 该步的前体组合（拼接串，作为哈希输入）
 * @returns 该步的**确定性** id（`rxn_<nodeId>_<hash>`）。🔴 必须确定：
 *          它是「切方案不重建树」「复用结果对齐原步」的地基；
 *          用随机 id 会让切换方案时 `chosenReactionId` 对不上、已建子树被误判清除
 */
function reactionIdFor(nodeId: string, precursors: string): string {
  let h = 5381;
  const s = String(precursors || '');
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return `rxn_${nodeId}_${h.toString(36)}`;
}

/** 把任意来源的候选整理成「属于 nodeId」的形状（复用别人结果时必须重挂）
 * @param nodeId 要挂到哪个节点下
 * @param list   任意来源的候选反应
 * @returns 重挂了 id 与归属的候选列表（复用别人结果时**必须**过这里，否则子树认不出父节点）
 */
function materializeCandidates(nodeId: string, list: Reaction[]): Reaction[] {
  return list.map((r) => ({
    ...r,
    id: reactionIdFor(nodeId, r.precursors),
    productNodeId: nodeId,
    childNodeIds: []
  }));
}

const DEFAULT_PARAMS: RunParams = {
  model: 'pistachio',
  numResults: 5,
  maxDepth: 4,
  // 默认 Retro*：它是 paper 里那个「用价值函数挑着拆」的最佳优先 —— 同样的调用预算
  // 下能往深里走得更多。BFS 不用价值函数、逐层铺开，覆盖是全但要给足预算才跑得动。
  searchAlgorithm: 'retro_star',
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
const ALL_ANALYSIS_MODULES: AnalysisModuleKey[] = [
  'mechanism',
  'order',
  'conditions',
  'workup',
  'outcome',
  'byproducts',
  'lcms',
  'nmr',
  'tlc',
  'safety',
  'toxicity'
];

/** 模块 key → 中文名（RunParams 勾选面板用） */
const ANALYSIS_MODULE_LABELS: Record<AnalysisModuleKey, string> = {
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
  safety: '安全与放大提示',
  // 🔴 与 `safety` 分工不同：safety 是**过程安全**（放热/产气/压力/放大失控），
  //    toxicity 是**物质本身的毒性**（哪个原料/溶剂毒、怎么防、能否替代）。两者都保留、各自独立渲染。
  toxicity: '毒性与防护要点'
};

/** axios 的取消错误（用户点停止 / 组件卸载）—— 不该当失败弹错误条
 * @param err 捕获到的异常
 * @returns 是否是 axios 的取消错误（`ERR_CANCELED` / `CanceledError`）。
 *          取消**不算故障**，不该弹错误条
 */
function isAbort(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'ERR_CANCELED' || (err instanceof Error && err.name === 'CanceledError');
}

/** 可被打断的 sleep：abort 时立即 resolve，让轮询循环能尽快退出
 * @param ms     等待毫秒数
 * @param signal 取消信号；🔴 给了它就变成**可打断**的 sleep ——
 *                  abort 时立即 resolve（不 reject），让轮询循环尽快退出
 * @returns 到点或被中断后 resolve（无 reject 路径）
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export {
  reactionIdFor,
  materializeCandidates,
  DEFAULT_PARAMS,
  ALL_ANALYSIS_MODULES,
  ANALYSIS_MODULE_LABELS,
  isAbort,
  sleep
};
