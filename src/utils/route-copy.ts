/**
 * 「复制路线」的**各种格式** —— 纯函数，无 Vue、无 DOM、无剪贴板。
 *
 * 为什么要抽出来：复制格式是要被直接驱动的逻辑（"CSV 转义对不对""JSON 里
 * 有没有带上 CAS"），写在 `.vue` 里就只能靠浏览器探针间接验，而探针验不到
 * 字符串拼接的细节。抽成纯函数后，可用 Node 直跑的方式逐条断言。
 *
 * 🔴 **口径单一来源**：`exportJson` / `exportCsv` 的数据来自 store，
 *    本模块只做"再排版一次"。两者刻意**不共用代码** ——
 *    store 那两份是**下载文件**用的（要能被 Excel / 外部工具读），
 *    这里的是**粘进聊天框/文献笔记**用的（要人眼能读）。
 *    共用一份反而会把两边都弄成四不像。
 */
import type { RouteStep } from '@/types/retro';
import type { CasInfo } from '@/utils/pubchem';
import { stepPct, routePct } from '@/utils/probability';

/** 一次复制所需的全部原料（都由调用方从 store / PubChem 缓存取好传进来） */
interface RouteCopyInput {
  /** 已采纳的路线（`store.route`） */
  route: RouteStep[];
  /** 目标产物 SMILES（`store.rootId` 对应节点） */
  target?: string;
  /** 目标产物名称（PubChem 查到的话带上，粘给同事时省一句"这是阿司匹林"） */
  targetName?: string;
  /** 起始物料：SMILES + 分子式 + CAS */
  materials: Array<{ smiles: string; formula?: string }>;
  /** 各步概率连乘（`store.routeProbability`） */
  totalProbability: number;
  /**
   * 这条路线里有几步是用户手工指定的（`store.networkStats.manualSteps`）。
   * 🔴 有它就必须在文本里标出来：连乘对手动步按 1 计，
   *    含手动步的总概率与纯模型路线**不可比**（口径见 utils/probability）。
   */
  manualSteps?: number;
  /** 产物 SMILES → PubChem 结果。**查不到就当没传**（别把 undefined 写成 "undefined"） */
  casOf?: (smiles: string) => CasInfo | null | undefined;
  /** 生成时间戳（ISO 字符串），便于测试注入固定值 */
  at?: string;
}

/** 复制模式 —— 与 UI 菜单项一一对应 */
type RouteCopyMode =
  /** 反应式 SMILES：`前体>>产物    # 第 N 步 · 概率`（原「复制路线」的行为，默认） */
  | 'rxn'
  /** 人读的逐步清单：每步一段，带产物/前体/概率/名称 */
  | 'steps'
  /** 只复制产物的 SMILES，一行一个（粘进别的工具里跑） */
  | 'smiles'
  /** 表格（TSV，粘进 Excel / 文献笔记能直接分列） */
  | 'table'
  /** CSV（带引号转义，与 store 的 exportCsv 同形但列更多） */
  | 'csv'
  /** 完整 JSON（含 CAS、名称、分子式，带 disclaimer） */
  | 'json'
  /** 起始物料清单：SMILES + 分子式 + CAS + 名称（采购/建库用） */
  | 'materials';

const ROUTE_COPY_MODES: Array<{ key: RouteCopyMode; label: string; hint: string }> = [
  { key: 'rxn', label: '反应式 SMILES', hint: '前体>>产物，一行一步（默认，可直接粘进 RDKit）' },
  { key: 'steps', label: '逐步清单', hint: '人读的完整路线：每步产物、前体、概率、名称' },
  { key: 'smiles', label: '产物 SMILES', hint: '只列每步产物，一行一个' },
  { key: 'table', label: '表格（TSV）', hint: '粘进 Excel / 文献笔记能直接分列' },
  { key: 'csv', label: 'CSV', hint: '带引号转义的 CSV，可存成文件' },
  { key: 'json', label: 'JSON', hint: '完整结构化数据，含 CAS 与名称' },
  { key: 'materials', label: '起始物料清单', hint: 'SMILES + 分子式 + CAS + 名称，采购/建库用' }
];

function casOf(input: RouteCopyInput, smiles: string): CasInfo | null {
  const c = input.casOf?.(smiles);
  // 🔴 只有"查到了"才算；undefined（没查）/ null（查过没有）都当没有，
  //    否则清单里会出现字面量 "undefined"。
  return c && c.cas ? c : null;
}

/** 产物的一行注释：`# 第 2 步 · 87.5% · 阿司匹林` */
function stepNote(input: RouteCopyInput, s: RouteStep): string {
  const bits = [`第 ${s.step} 步`, stepPct(s.probability, s.manual)];
  const name = casOf(input, s.product)?.name;
  if (name) bits.push(name);
  return bits.join(' · ');
}

/** 按 step 降序（= 离目标最近的一步在最前，与画布右侧起读的顺序一致） */
function ordered(input: RouteCopyInput): RouteStep[] {
  return [...input.route].sort((a, b) => b.step - a.step);
}

/** 复制成功时该报什么（"已复制 3 步反应式 SMILES"这种量化提示，别只说"已复制"） */
function routeCopyOkMsg(mode: RouteCopyMode, input: RouteCopyInput): string {
  const n = input.route.length;
  switch (mode) {
    case 'rxn':
      return `已复制 ${n} 步反应式 SMILES`;
    case 'steps':
      return `已复制 ${n} 步路线清单`;
    case 'smiles':
      return `已复制 ${n} 个产物 SMILES`;
    case 'table':
    case 'csv':
      return `已复制 ${n} 行表格`;
    case 'json':
      return '已复制路线 JSON';
    case 'materials':
      return `已复制 ${input.materials.length} 个起始物料`;
  }
}

function csvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function tsvCell(v: unknown): string {
  // 🔴 TSV 里 tab / 换行会直接把列和行弄乱 ⇒ 换掉，不是截断（截断等于改数据）
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * 按模式生成要写进剪贴板的文本。
 * 🔴 路线为空一律返回空串 —— 由调用方提示"还没有采纳任何一步"，
 *    别在这里编一段"第 0 步"之类的占位内容。
 */
function buildRouteCopy(mode: RouteCopyMode, input: RouteCopyInput): string {
  const steps = ordered(input);
  if (mode === 'materials') {
    return input.materials
      .map((m) => {
        const c = casOf(input, m.smiles);
        return [m.smiles, m.formula ?? '', c?.cas ?? '', c?.name ?? ''].join('\t');
      })
      .join('\n');
  }
  if (!steps.length) return '';

  switch (mode) {
    case 'rxn':
      return steps
        .map((s) => `${s.precursors.join('.')}>>${s.product}    # ${stepNote(input, s)}`)
        .join('\n');

    case 'steps': {
      const head = input.target
        ? `目标：${input.target}${input.targetName ? `（${input.targetName}）` : ''}    总概率 ${routePct(input.totalProbability, input.manualSteps)}    共 ${steps.length} 步`
        : `共 ${steps.length} 步    总概率 ${routePct(input.totalProbability, input.manualSteps)}`;
      const body = steps.map((s) => {
        const c = casOf(input, s.product);
        const lines = [
          `第 ${s.step} 步  ${s.manual ? '手动指定（无模型概率）' : `概率 ${stepPct(s.probability)}`}`,
          `  产物：${s.product}${s.productFormula ? `（${s.productFormula}）` : ''}${c?.cas ? `  CAS ${c.cas}` : ''}${c?.name ? `  ${c.name}` : ''}`
        ];
        s.precursors.forEach((p, i) => {
          const pc = casOf(input, p);
          lines.push(
            `  前体 ${i + 1}：${p}${pc?.cas ? `  CAS ${pc.cas}` : ''}${pc?.name ? `  ${pc.name}` : ''}`
          );
        });
        return lines.join('\n');
      });
      return [head, '', ...body].join('\n');
    }

    case 'smiles':
      return steps.map((s) => s.product).join('\n');

    case 'table': {
      const head = ['步骤', '产物SMILES', '产物分子式', 'CAS', '名称', '前体SMILES', '概率'];
      const rows = steps.map((s) => {
        const c = casOf(input, s.product);
        return [
          s.step,
          s.product,
          s.productFormula ?? '',
          c?.cas ?? '',
          c?.name ?? '',
          s.precursors.join(' + '),
          stepPct(s.probability, s.manual)
        ]
          .map(tsvCell)
          .join('\t');
      });
      return [head.join('\t'), ...rows].join('\n');
    }

    case 'csv': {
      const head = ['步骤', '分支', '产物SMILES', '产物分子式', 'CAS', '名称', '前体SMILES', '概率', '模型'];
      const rows = steps.map((s) => {
        const c = casOf(input, s.product);
        return [
          s.step,
          s.branchNo,
          s.product,
          s.productFormula ?? '',
          c?.cas ?? '',
          c?.name ?? '',
          s.precursors.join(' + '),
          s.manual ? '手动' : s.probability.toFixed(4),
          s.model
        ]
          .map(csvCell)
          .join(',');
      });
      return [head.map(csvCell).join(','), ...rows].join('\n');
    }

    case 'json':
      return JSON.stringify(
        {
          app: 'retroweb',
          exportedAt: input.at ?? new Date().toISOString(),
          disclaimer: '模型预测结果可能包含错误，实验前须经专业人员验证。',
          target: input.target ?? null,
          targetName: input.targetName ?? null,
          routeProbability: input.totalProbability,
          manualSteps: input.manualSteps ?? 0,
          steps: steps.map((s) => {
            const c = casOf(input, s.product);
            return {
              step: s.step,
              product: s.product,
              productFormula: s.productFormula ?? null,
              cas: c?.cas ?? null,
              name: c?.name ?? null,
              cid: c?.cid ?? null,
              precursors: s.precursors.map((p) => {
                const pc = casOf(input, p);
                return { smiles: p, cas: pc?.cas ?? null, name: pc?.name ?? null, cid: pc?.cid ?? null };
              }),
              // 手动步没有模型概率 ⇒ 写 null 并带 manual 标记。
              // 别写 1：下游会把它当成"100% 可信"。
              probability: s.manual ? null : s.probability,
              manual: !!s.manual,
              model: s.model
            };
          }),
          startingMaterials: input.materials.map((m) => {
            const c = casOf(input, m.smiles);
            return {
              smiles: m.smiles,
              formula: m.formula ?? null,
              cas: c?.cas ?? null,
              name: c?.name ?? null,
              cid: c?.cid ?? null
            };
          })
        },
        null,
        2
      );
  }
}

export { ROUTE_COPY_MODES, routeCopyOkMsg, buildRouteCopy };

export type { RouteCopyInput, RouteCopyMode };
