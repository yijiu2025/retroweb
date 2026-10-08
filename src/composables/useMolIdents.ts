/**
 * 「这个分子有哪些标识可以复制」—— 全站**唯一**的组装口径。
 *
 * 起因：这份逻辑先在 `StepRow.vue` 里长出来（复制标识下拉），后来发现另外两处
 * 要的是**同一份东西**，各写一遍必然分叉：
 *   ① `RouteCanvas.vue` 卡片上的「复制」—— 原来只有光秃秃一个 SMILES，
 *      想复制 CAS 只能先把鼠标挪到左侧树去，用户在画布里就地复制不到；
 *   ② `MolPreviewDialog.vue`（点「眼睛」放大）—— 原来只显示一行 SMILES 文本，
 *      连 CAS 都看不到。
 * 三处都是"这个分子的身份信息"，用户预期完全一致 ⇒ 收成一个 composable。
 *
 * 🔴 **懒查是硬约定**（与 §19 的"懒枚举"同一条道理）：
 *    CAS 来自 PubChem，限流 5 req/s。一棵几十个节点的树如果每行/每张卡片一挂载
 *    就查，瞬间把队列塞满，而其中绝大多数 CAS 根本没人看。所以：
 *      · 组件挂载**不查**；
 *      · 用户真的拉开菜单 / 打开预览弹窗（`askCas()`）才入队；
 *      · SMILES / 分子式 / 分子量这些**本地就有**的，不查也照样列出来。
 *
 * 🔴 `value` 就是**原样**写进剪贴板的字符串（复制时不做任何加工）——
 *    "看着一样、粘出来不一样"是最难查的一类 bug，宁可原样也别替用户修饰。
 */
import { computed, ref, watch, type ComputedRef } from 'vue';
import { casState, requestCas, type CasInfo, type CasState } from '@/utils/pubchem';
import { copyText } from '@/utils/clipboard';

/** 一行可复制的标识 */
export interface MolIdent {
  /** 稳定 key（`el-dropdown` 的 command 用） */
  key: string;
  /** 左侧标签，如 `SMILES` / `CAS` */
  label: string;
  /** 写进剪贴板的原文 */
  value: string;
  /**
   * 这一行是不是"这个分子最常被要的标识"。
   * 供调用方决定排序/强调（如预览弹窗里把 SMILES 放最上面）。
   */
  primary?: boolean;
}

/** 组装标识所需的原料（都能缺，缺了那一行就不出现） */
export interface MolIdentSource {
  smiles: string;
  /** 分子式，如 `C9H8O4`（store 节点上有；没有就不列） */
  formula?: string;
  /** 分子量 */
  mw?: number | null;
}

/**
 * 🔴 **纯函数版**（口径的单一来源，composable 只是它的响应式外壳）。
 *
 * 抽出来是因为「路线网络」的卡片是在 `v-for` 里渲染的 —— 那里**不能**调
 * composable（一个循环就是几十份订阅），但又要显示同一份标识列表。
 * 两边各写一份必然分叉：今天卡片只有 SMILES、树里有六项，就是这么来的。
 * 循环里用这份纯函数，配 `casState()` 的响应式缓存照样会自动更新。
 */
export function buildMolIdents(src: MolIdentSource, cas: CasInfo | null | undefined): MolIdent[] {
  const out: MolIdent[] = [];
  if (!src.smiles) return out;
  out.push({ key: 'smiles', label: 'SMILES', value: src.smiles, primary: true });
  if (src.formula) out.push({ key: 'formula', label: '分子式', value: src.formula });
  if (src.mw) out.push({ key: 'mw', label: '分子量', value: String(src.mw) });
  if (cas && cas.cas) {
    out.push({ key: 'cas', label: 'CAS', value: cas.cas });
    if (cas.name) out.push({ key: 'name', label: '名称', value: cas.name });
    if (cas.cid) out.push({ key: 'cid', label: 'PubChem CID', value: String(cas.cid) });
  }
  return out;
}

/**
 * CAS 为什么没出现在列表里 —— 只在**用户已经要过**之后才有意义。
 * 空串 = 不需要解释（没要过，或查到了）。
 */
export function molCasNote(
  asked: boolean,
  cas: CasInfo | null | undefined
): string {
  if (!asked) return '';
  if (cas === undefined) return 'CAS 查询中…';
  if (cas === null) return 'CAS：PubChem 未收录';
  return '';
}

export interface UseMolIdents {
  /** 有值的标识行（已按 SMILES → 分子式 → 分子量 → CAS → 名称 → CID 排好） */
  idents: ComputedRef<MolIdent[]>;
  /** PubChem 那份结果（`undefined`=没查、`null`=查过没有），供调用方显示状态 */
  cas: ComputedRef<CasState>;
  /**
   * CAS 为什么没出现 —— 只在**用户已经要过**之后才有意义。
   * 空串 = 不需要解释（没要过，或查到了）。
   */
  casNote: ComputedRef<string>;
  /** 用户真的展开菜单/打开弹窗时调它：入队查 CAS */
  askCas: () => void;
  /** 按 key 复制（`value` 为空的那条不会被列出来，所以不会复制到空串） */
  copyIdent: (key: string) => Promise<void>;
}

/**
 * @param source 反应式来源。传 getter / ref / computed 都可以，内部会 `watch`，
 *   所以分子换了标识列表会自动跟着换（🔴 否则会显示上一个分子的 CAS）。
 * @param opts.copy 注入复制实现（默认走全站唯一入口 `copyText`）——
 *   留这个口子是为了探针能在 Node 里驱动真实逻辑而不必启动浏览器。
 */
export function useMolIdents(
  source: () => MolIdentSource,
  opts: { copy?: (text: string, okMsg: string) => Promise<boolean> } = {}
): UseMolIdents {
  const src = computed<MolIdentSource>(() => source() ?? { smiles: '' });
  const cas = computed(() => casState(src.value.smiles));
  /** 用户是否已经要过一次（决定要不要显示"CAS 查询中…"这类说明） */
  const asked = ref(false);

  const askCas = (): void => {
    asked.value = true;
    const s = src.value.smiles;
    if (s) requestCas(s);
  };

  // 分子换了：如果之前要过 CAS，新分子也得跟着查，否则列表会停在旧分子的结果上
  watch(
    () => src.value.smiles,
    (s) => {
      if (asked.value && s) requestCas(s);
    }
  );

  const idents = computed<MolIdent[]>(() => buildMolIdents(src.value, cas.value));
  const casNote = computed<string>(() => molCasNote(asked.value, cas.value));

  const copyIdent = async (key: string): Promise<void> => {
    const it = idents.value.find((x) => x.key === key);
    if (!it) return;
    // 复制一律走全站唯一入口（见 utils/clipboard.ts）
    await (opts.copy
      ? opts.copy(it.value, `已复制 ${it.label}`)
      : copyText(it.value, { okMsg: `已复制 ${it.label}` }));
  };

  return { idents, cas, casNote, askCas, copyIdent };
}
