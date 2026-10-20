<script setup lang="ts">
/**
 * 目标分子输入。
 *
 * **一个输入框吃四种格式**（2026-10-06 合并）：ChemDraw 复制的 CDXML、MOL/SDF 文件、
 * 纯 SMILES、反应式 SMILES。原来是「结构式粘贴 / SMILES」两个模式来回切 ——
 * 但格式本来就能自动认出来（见 `needsBackendParse` 与 `parseStructure`），
 * 让用户先声明"我要粘的是哪种"是多余的负担，两套占位文案也白白占了两行。
 *
 * 解析分工（2026-10-06 起）：
 *   · **纯 SMILES / MOL / SDF / 画板产物 → 前端 RDKit.js（WASM）**，粘贴即出结构，
 *     没有网络往返（见 utils/rdkit.ts）。
 *   · **CDXML → 仍走后端 `/api/parse`**。浏览器版 RDKit 的 `get_mol()` 只吃
 *     SMILES/SMARTS/Molfile/CXSMILES/JSON，读不了 CDXML —— 手写解析实测 6 个用例只过 2 个，
 *     必须用 Python 版 `Chem.MolsFromCDXML()`。判断入口是 `needsBackendParse()`。
 * 两种路径失败时都给「人话诊断 + 一键修复候选」（R 基团 / [*] 通配都能兜住）。
 *
 * 编辑器：**Ketcher**（EPAM 开源，Indigo WASM 内核），封装在 `components/mol/StructureEditor.vue`。
 *   它吐 molfile，同样丢给前端 RDKit.js 判真伪 ⇒「化学正确性由 RDKit 终审」这条分工没变。
 *   🔴 它的接口全是异步的（要过 WASM worker），`isEmpty()` / `getMolfile()` 必须 await。
 *   🔴 **打开画板要把当前结构带进去**（粘贴的、示例的、已解析的都能带）——
 *      见 `resolveSeed()`。开一张空画板等于让用户把刚粘的东西再画一遍。
 *
 * 版式：**只有输入态**。
 *   本组件嵌在「标定大卡片」（TargetSetupPanel）里，负责画布 + 粘贴框 + 解析结果。
 *   解析成功 → `store.setTarget()` → 标定面板整体消失、工作台切到路线态，
 *   目标降级成路线区顶部的 TargetBar（这条带子由 TargetBar.vue 负责，不在这里）。
 *
 * **CAS 号 / 名称输入**（2026-10-20，10-20 扩成双源）：
 *   用户手里可能只有一个 CAS 号（如 `50-78-2`），没有结构式。
 *   本组件在解析前先看输入像不像 CAS：
 *     · 像 → 查物质（`/api/substance`，**PubChem / ChemIndex 可选**）
 *       拿 SMILES → **转成 SMILES 后走完全相同的解析链路**
 *       （`parseStructure`）⇒ 分子式/分子量/原子数由 RDKit 统一算，
 *       界面表现与粘贴结构式**完全一致**。
 *     · 不像 → 照旧按原逻辑走（CDXML 走后端，其余走前端 RDKit）。
 *
 *   🔴 **刻意不新开一条「CAS 专用」的解析路径**：那会造成两套算 formula/mw
 *      的实现，将来必然分叉（上游给的分子式与 RDKit 算的在某些结构上
 *      会差一个氢的写法）。统一走 `parseStructure` ⇒ 只有一处真相。
 *
 *   🔴 **查询走后端而不是前端直连**：ChemIndex 没有 CORS 头（浏览器直连必拒），
 *      且有 JS 反爬挑战（要把响应里的 `_0x2` 写进 `HW_CHECK` cookie 再重发）
 *      ⇒ 只能服务端代理。PubChem 本来能直连，但为了两个源**统一入口**也一起走。
 *      代价：多一次本机 HTTP 往返（毫秒级），换来两个源共用一个下拉。
 *
 *   🔴 上游返回的是 **Kekulé 形式**（`C1=CC=CC=C1`），不是芳香小写形式。
 *      交给 RDKit 规范化后才进入后续链路 —— 否则缓存键、结构图、
 *      与用户粘贴的结构比对全都对不上。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { retroApi } from '@/api/retro';
import { useWorkspaceStore } from '@/stores/workspace';
import type { ParseFailure, ParseSuccess, SubstanceInfo, SubstanceSource } from '@/types/retro';
import { depictMolfile, isRdkitReady, needsBackendParse, parseStructure } from '@/utils/rdkit';
import { readFileAsText } from '@/utils/smiles';
import { copyText } from '@/utils/clipboard';
import { isValidCas, normalizeCas } from '@/utils/cas-regex';
import MolView from '@/components/mol/MolView.vue';
import StructureEditor from '@/components/mol/StructureEditor.vue';

const store = useWorkspaceStore();

const text = ref('');
const parsing = ref(false);
const parsed = ref<ParseSuccess | null>(null);
const failure = ref<ParseFailure | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * 输入区是否收起（解析成功后置 true，让位给紧凑胶囊）。
 *
 * 🔴 只归本组件管、**不进 store**：它是纯界面态 —— 面板由外层 `v-if` 控制
 *    挂载/销毁，每次打开天然回到输入态；换目标重挂载同理。进 store 反而要
 *    处理「换目标后要不要复位」的额外状态同步，没有必要。
 */
const collapsed = ref(false);


const EXAMPLES: Array<{ label: string; smiles: string }> = [
  { label: '阿司匹林', smiles: 'CC(=O)Oc1ccccc1C(=O)O' },
  { label: '布洛芬', smiles: 'CC(C)Cc1ccc(C(C)C(=O)O)cc1' },
  { label: '对乙酰氨基酚', smiles: 'CC(=O)Nc1ccc(O)cc1' },
  { label: '咖啡因', smiles: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C' },
  { label: '利多卡因', smiles: 'CCN(CC)CC(=O)Nc1c(C)cccc1C' }
];

const PLACEHOLDER =
  '粘贴 ChemDraw 结构（Ctrl+C 复制的 CDXML）、MOL / SDF 文本，直接输入 SMILES（如 CC(=O)Oc1ccccc1C(=O)O），或输入 CAS 号（如 50-78-2）';

/**
 * 输入框正下方的「支持什么」提示 —— 学 Reaxys 搜索框下面那行
 * 「Substance Molecular Formula, e.g. Pt(PPh3)3」：
 * 把「这里该填什么、长什么样」直接印在输入框底下，别让用户去猜。
 * 合并模式后只有一句：能认的格式全列出来，不再随模式变。
 */
const hintText =
  '支持 CDXML / MOL / SDF / SMILES / 反应式 SMILES（用 > 分隔）/ CAS 号，粘贴即自动识别格式';

const currentSmiles = computed(() => store.rootId ? store.nodes[store.rootId]?.smiles : '');

/**
 * 输入框当前内容**是不是一个 CAS 号**（用于界面上给「按 CAS 查」的即时提示）。
 *
 * 🔴 只判**形态**，不判校验位：`50-78-2` 形态对但校验位写错时，也该让用户
 *    去查 —— PubChem 会告诉他认不认识（"查无此 CAS"），比本地正则拦下更准。
 */
const looksLikeCas = computed(() => normalizeCas(text.value) !== '');

/**
 * 物质数据源 —— **做成可切换的**，因为两个源各有所长（实测 2026-10-20）：
 *
 *   | | PubChem | ChemIndex |
 *   |---|---|---|
 *   | CAS → 结构 | ✅ | ✅ |
 *   | 中文名 → 结构 | ✅ | ❌（只认英文名） |
 *   | 物性（熔点/沸点/闪点/溶解度） | 部分 | ✅ 齐全 |
 *   | 危害符号 / 风险代码 | ✅ | ✅ |
 *   | 是否需要后端代理 | 否（有 CORS） | **是**（无 CORS + 反爬） |
 *
 * 🔴 默认 **PubChem**：它覆盖面最广（中文名也能查），且不依赖后端活着。
 *    用户要知道的差异写在界面的 tooltip 里，不用记。
 *
 * 🔴 这个值**本地持久化**（localStorage）：选一次就一直生效，不必每次开面板重选。
 */
const STORAGE_KEY = 'rw-substance-source';
const source = ref<SubstanceSource>((localStorage.getItem(STORAGE_KEY) as SubstanceSource) || 'pubchem');

watch(source, (s) => {
  localStorage.setItem(STORAGE_KEY, s);
  // 换源后把上一次的查询结果作废，否则会拿 PubChem 的信息配 ChemIndex 的名字
  substanceHit.value = undefined;
});

/** 数据源下拉的选项（文案写清「什么时候选它」，别只说名字） */
const SOURCE_OPTIONS: Array<{ value: SubstanceSource; label: string }> = [
  { value: 'pubchem', label: 'PubChem' },
  { value: 'chemindex', label: 'ChemIndex（含物性）' }
];

/** 当前源的名字（提示语里用，避免满屏 `source.value` 这种代码词） */
const sourceLabel = computed(() =>
  source.value === 'chemindex' ? 'ChemIndex' : 'PubChem'
);

/**
 * 当前数据源的描述（界面上那行小字，随选择变）。
 * 写「这个源擅长什么」，让用户知道为什么可能要切。
 */
const sourceHint = computed(() =>
  source.value === 'chemindex'
    ? 'ChemIndex：物性与危害信息更全（熔点/沸点/风险代码），但查名称只认英文'
    : 'PubChem：覆盖最广，支持中文名查询，物性信息较少'
);

/**
 * 输入框内容是 CAS 号但**校验位不对** —— 只提示、不阻断。
 *
 * 🔴 为什么只提示不拦下：校验位算错可能只是用户抄错了一位，
 *    而这个号在上游到底存不存在才是权威结论。拦下的话，用户明明填的是
 *    一个真实存在的 CAS（只是末位笔误）却连查都不能查。
 */
const casChecksumBad = computed(() => {
  const cas = normalizeCas(text.value);
  if (!cas) return false;
  return !isValidCas(cas);
});

/**
 * 查询结果（两个源共用一份结构）：
 *   · `undefined` → 还没查 / 正在查
 *   · `null`      → 查过了，这个源没有收录
 *   · `SubstanceInfo` → 查到了
 */
const substanceHit = ref<SubstanceInfo | null | undefined>(undefined);
const substanceSearching = ref(false);

/**
 * 把一个 CAS 号解析成结构。
 *
 * 🔴 为什么要自己轮询而不用 `requestLookup` 就完事：
 *    `requestLookup` 是**即发即忘**（组件各调一次、去重与限流在 utils 里），
 *    适合「显示一个 CAS 标签」那种不关心结果的场景。
 *    但这里**必须等到结果**才能继续解析（拿到 SMILES 才能往下走），
 *    所以自己订阅状态变化 + 轮询等待。
 *
 * @param cas 标准写法的 CAS 号
 * @returns 查到的 SMILES（Kekulé 形式，**待 RDKit 规范化**）；
 *          查无此号 / 网络失败时返回空串
 */
/**
 * 查一次物质（CAS 号或名称），把结果写进 `substanceHit`。
 *
 * 🔴 为什么走**后端**（`/api/substance`）而不是前端直连：
 *    · ChemIndex 没有 CORS 头，浏览器直连必被拒；
 *    · 它有 JS 反爬挑战（要把响应里的 `_0x2` 写进 `HW_CHECK` cookie 再重发），
 *      纯 HTTP 客户端第一发就吃「安全检查」页。
 *    ⇒ 只能服务端代理。PubChem 本来能直连，但为了两个源**统一入口**也一起走这里。
 *
 * @returns 查到的 SMILES；查无此物 / 失败返回空串
 */
async function fetchSubstance(): Promise<string> {
  const raw = text.value.trim();
  if (!raw) return '';
  substanceSearching.value = true;
  try {
    const res = await retroApi.substance(raw, source.value);
    if (res.ok && res.smiles) {
      substanceHit.value = res;
      return res.smiles;
    }
    // `found:false` = 这个源查无此物（不是错误）；其它 = 出错了
    substanceHit.value = res.found === false ? null : undefined;
    return '';
  } catch (e) {
    substanceHit.value = undefined;
    ElMessage.error(`${(e as Error).message || '物质查询失败'}`);
    return '';
  } finally {
    substanceSearching.value = false;
  }
}

async function runParse(input?: string): Promise<void> {
  const raw = (input ?? text.value).trim();
  if (!raw) {
    ElMessage.warning('请先粘贴结构、输入 SMILES 或 CAS 号');
    return;
  }
  parsing.value = true;
  failure.value = null;
  try {
    // ---- ① CAS 号优先识别 ----
    // 必须在判 CDXML 之前：CAS 号长得像 SMILES（`50-78-2` 甚至能通过
    // SMILES 的字符集检查），若先走 parseStructure 会被当成「一个奇怪的结构」
    // 报一堆 valence 错误，用户完全看不懂。
    const cas = normalizeCas(raw);
    let payload = raw;
    let viaCas = false;
    // 名称也可以走物质查询（两个源都支持），但只有 CAS 号才**优先于**结构解析
    // —— 记名称时用户意图也可能是要粘结构（「aspirin」绝无歧义，但「water」
    //    之类的词也可能是别的）。所以只在形态明确时抢跑。
    if (cas) viaCas = true;

    if (viaCas) {
      const smiles = await fetchSubstance();
      if (!smiles) {
        // 查无此号 / 网络失败 —— 说清楚是哪一种，别只说"解析失败"
        if (substanceHit.value === null) {
          ElMessage.error(`${source.value === 'chemindex' ? 'ChemIndex' : 'PubChem'} 没有收录 CAS 号 ${cas}，试试换个数据源`);
        } else {
          ElMessage.error(`查 CAS 号 ${cas}失败（网络或超时），请稍后重试`);
        }
        parsing.value = false;
        return;
      }
      // 🔴 PubChem 给的是 Kekulé 形式，必须交给 RDKit 规范化。
      //    规范化在 parseStructure 里做（它内部会 canonicalize）⇒ 下面直接用原始
      //    SMILES 喂进去即可，不需要在这里再转一次。
      payload = smiles;
    }

    // ---- ② 常规结构解析（CDXML 走后端，其余走前端 RDKit）----
    // CDXML 是唯一必须走后端的输入（浏览器版 RDKit 读不了它）
    const useBackend = !viaCas && needsBackendParse(payload);
    if (!useBackend && !isRdkitReady()) {
      // 首次解析要拉 7.4MB 的 WASM 引擎 —— 说清楚，别让人以为卡死了
      ElMessage.info('首次解析需加载前端解析引擎（约 7MB），请稍候…');
    }
    const res = useBackend ? await retroApi.parse(payload) : await parseStructure(payload);
    if (res.ok) {
      parsed.value = res;
      // 🔴 解析成功 ⇒ 输入区收起（用户要求：输入完成就可以隐藏，点胶囊可替换）
      collapsed.value = true;
      store.setTarget(res);
      ElMessage.success(
        viaCas
          ? `已按 CAS 号 ${cas} 查到结构并设为目标分子`
          : '已解析并设为目标分子'
      );
    } else {
      parsed.value = null;
      failure.value = res;
      // 失败必须停在输入态：用户要对着诊断改输入
      collapsed.value = false;
    }
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    parsing.value = false;
  }
}

function applySuggestion(smiles: string): void {
  text.value = smiles;
  void runParse(smiles);
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const content = await readFileAsText(file);
    text.value = content;
    await runParse(content);
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    input.value = '';
  }
}

/** 复制解析出来的 SMILES（走全站唯一入口，见 utils/clipboard.ts） */
async function copySmiles(): Promise<void> {
  if (!parsed.value) return;
  await copyText(parsed.value.smiles, {
    okMsg: '已复制 SMILES',
    failMsg: '浏览器拒绝了剪贴板访问'
  });
}

/* ---------- 画板 ---------- */
const editorOpen = ref(false);
const editorRef = ref<InstanceType<typeof StructureEditor> | null>(null);
const editorBusy = ref(false);
const editorError = ref<ParseFailure | null>(null);
/** 画完就搜的设置已退役：是否立刻开跑由标定面板的「开始分析」按钮决定 */

/** 上一次灌进画板的 smiles —— 用来判断「用户手上的结构变了没」 */
const editorSeeded = ref('');

/**
 * 把「当前手上的结构」解析成规范 SMILES —— 画板预载就靠它。
 *
 * 优先级：**已解析结果**（最可信，本来就是 canonical） > **输入框原文**。
 * 🔴 输入框原文可能是 CDXML / MOL —— 浏览器版 RDKit 读不了 CDXML，那种必须走一次后端；
 *    少了这一步，用户「粘贴 ChemDraw 结构 → 点编辑」就会得到一张空画板。
 */
async function resolveSeed(): Promise<string> {
  if (parsed.value?.smiles) return parsed.value.smiles;
  const raw = text.value.trim();
  if (!raw) return '';
  // 🔴 输入框里是 CAS 号时也得能开画板 —— 否则用户「输入 CAS → 点编辑结构式」
  //    得到一张空画板，得先把 CAS 查一遍再重新输入。
  if (normalizeCas(raw)) {
    const smiles = await fetchSubstance();
    if (!smiles) return '';
    try {
      const res = await parseStructure(smiles);
      return res.ok ? res.smiles : '';
    } catch {
      return '';
    }
  }
  try {
    const res = needsBackendParse(raw) ? await retroApi.parse(raw) : await parseStructure(raw);
    return res.ok ? res.smiles : '';
  } catch {
    return '';
  }
}

/** 打开画板时会带上什么结构（没有就说没有 —— 不放没用的字） */
const seedHint = computed(() => {
  if (parsed.value?.smiles) return '打开画板会带上上面这个结构，可以直接改';
  if (looksLikeCas.value) return '打开画板会先查出这个 CAS 号的结构再带进去';
  if (text.value.trim()) return '打开画板会先解析输入框里的内容，能认出来就带进去';
  return '';
});

async function openEditor(): Promise<void> {
  editorOpen.value = true;
  editorError.value = null;
  await nextTick();
  const ed = editorRef.value;
  if (!ed) return;
  // 🔴 打开画板必须把用户手上的结构带进去：粘贴的、点示例的、已解析的都算（见 resolveSeed）。
  //    原先只认「SMILES 模式下的输入框」，于是「粘贴 CDXML / MOL 再点编辑」开出来的是空画板。
  const seed = await resolveSeed();
  if (!seed) return;
  try {
    // dialog 关掉再打开是同一个 Ketcher 实例（el-dialog 默认不销毁内容）⇒ 不能无条件覆盖，
    //    否则把画到一半的图冲掉。
    //    判据：**结构没变** 且 **画板里已经有东西** ⇒ 让你接着改；否则重新灌一遍。
    // 🔴 Ketcher 的读取接口全是异步的（要在 WASM worker 里跑）：`isEmpty()` 返回 Promise，
    //    漏 await 会永远为真 —— 那就等于每次都无条件覆盖。
    if (seed === editorSeeded.value && !(await ed.isEmpty())) return;
    // 2D 坐标由前端 RDKit.js 算（原先走后端 /api/depict）
    const molfile = await depictMolfile(seed);
    if (molfile) {
      await ed.loadFromMolfile(molfile);
      editorSeeded.value = seed;
    }
  } catch {
    /* 载入失败也不用打断：用户可以直接自己画 */
  }
}

async function confirmEditor(): Promise<void> {
  const ed = editorRef.value;
  if (!ed) return;
  editorBusy.value = true;
  editorError.value = null;
  try {
    if (await ed.isEmpty()) {
      ElMessage.warning('画板还是空的，先画一个结构');
      return;
    }
    const molfile = await ed.getMolfile();
    // 画出来的图交给前端 RDKit.js 判真伪：valence / Markush 都在这里兜住。
    // molfile 是它读得了的输入格式，所以这条路不必走后端。
    const res = await parseStructure(molfile);
    if (!res.ok) {
      editorError.value = res;
      return;
    }
    parsed.value = res;
    text.value = res.smiles;
    // 画板里此刻就是 res.smiles ⇒ 记下来，下次打开才不会无谓地重灌一遍
    editorSeeded.value = res.smiles;
    // 与粘贴路径同口径：结构确定即收起输入区
    collapsed.value = true;
    store.setTarget(res);
    ElMessage.success('已用绘制的结构设为目标分子');
    editorOpen.value = false;
    // ⚠️ 这里**不再**自动展开 —— 「开始分析」由标定面板底部的确认按钮统一负责，
    //    否则画完就悄悄关掉面板开跑，用户来不及改模型参数。
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    editorBusy.value = false;
  }
}

/**
 * 把「起跑」这个动作**交给父组件**去摆版式。
 *
 * 🔴 为什么 `startAnalysis` 从模板里的按钮搬到这里用 defineExpose 暴露：
 *   标定卡片有**两条平级起跑线**（手动逐步 / 自动往下拆 N 层），它们必须并排出现在
 *   卡片底部同一条动作栏里 —— 视觉上才读得出"二选一"。而手动那条的实现（守卫
 *   rootId → 关面板 → 切页签 → 展开第一步）在本组件里最自然（它最清楚解析状态）。
 *   于是：**逻辑留在这儿，位置交给 TargetSetupPanel**。
 *   父组件用模板 ref 调 `startAnalysis()`，按钮的 class 仍是 `.target__start-btn`
 *   （守门脚本按这个类名定位，见 .tmp-probe/verify-workbench.cjs）。
 */
function startAnalysis(): void {
  if (!store.rootId) {
    ElMessage.warning('先解析一个目标分子');
    return;
  }
  store.closeTargetSetup();
  // 关掉面板 = 任务开始，顺手替用户走第一步（否则还要回路线树找「展开」按钮）
  // 显式开跑 ⇒ 页签切到「逆合成树」：这一步的候选面板就长在那里，
  // 留在默认的「目标分析」总览会看不到刚拉回来的候选。
  store.mainTab = 'tree';
  void store.predictNode(store.rootId);
}

defineExpose({ startAnalysis });

function clearAll(): void {
  text.value = '';
  parsed.value = null;
  failure.value = null;
}

/**
 * 挂载时若已有目标分子（从历史/会话恢复回来），把 SMILES 回填进输入框，
 * 方便用户在当前结构上微调。注意：这**不会**打开标定面板 ——
 * 是否展示标定面板由 store.targetSetupOpen 决定，不在这里抢权。
 */
function seedFromCurrent(): void {
  if (!text.value && currentSmiles.value) text.value = currentSmiles.value;
}

void nextTick(seedFromCurrent);
</script>

<template>
  <section class="rw-card target">
    <div class="rw-card__body target__body">
      <!-- 收起态：解析成功后输入区整块让位给一条紧凑胶囊。
           🔴 这是「输入完成就可以隐藏」的落地：标定页此后真正挡视线的只有
              起跑线，结构信息压成一行。点胶囊任意处 / 点「替换」回到输入态重填；
              「编辑结构式」带着当前结构开画板（resolveSeed 优先取已解析结果）。
              面板每次打开都是重新挂载（外层 v-if）⇒ collapsed 天然回输入态。 -->
      <div
        v-if="collapsed && parsed"
        class="target__pill"
        role="button"
        tabindex="0"
        title="点一下重新展开输入区，可替换结构"
        @click="collapsed = false"
        @keyup.enter="collapsed = false"
      >
        <div class="target__pill-mol">
          <MolView :smiles="parsed.smiles" fit />
        </div>
        <div class="target__pill-info">
          <div class="target__pill-tag">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z" />
              <path d="m5.5 8 2 2 3.2-3.8" />
            </svg>
            已解析目标
          </div>
          <code class="rw-mono">{{ parsed.smiles }}</code>
          <div class="target__pill-props">
            <span v-if="parsed.formula">分子式 <b>{{ parsed.formula }}</b></span>
            <span v-if="parsed.mw != null">MW <b>{{ parsed.mw }}</b></span>
            <span>重原子 <b>{{ parsed.atoms }}</b></span>
            <span>类型 <b>{{ parsed.kind }}</b></span>
          </div>
        </div>
        <div class="target__pill-ops" @click.stop>
          <el-button link size="small" @click="copySmiles">复制</el-button>
          <el-button link size="small" type="primary" @click="openEditor">编辑结构式</el-button>
          <el-button link size="small" @click="collapsed = false">替换</el-button>
        </div>
      </div>

      <template v-else>
      <!-- ① 输入行：label + 输入框拼块（参考稿的 "目标分子结构 (Search / Paste Structure)"）。
             照 Reaxys 的 `[ 输入框 ][ Find > ]` —— 动作按钮贴着输入框右边缘。
             🔴 结构式粘贴与 SMILES 已合并成一个框：格式自动识别，不用先声明类型。 -->
      <div class="target__entry">
        <div class="target__entry-label">目标分子结构</div>
        <div class="target__field">
          <el-input
            v-model="text"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 7 }"
            resize="none"
            :placeholder="PLACEHOLDER"
            class="target__input"
            @keyup.enter.exact="runParse()"
          />
          <div class="target__field-act">
            <el-button type="primary" :loading="parsing" @click="runParse()">解析结构</el-button>
          </div>
        </div>

        <!-- ② 输入行右侧/下方：**物质数据源选择**（CAS / 名称查询用哪个库）
             🔴 只在输入像 CAS 号 / 名称时才值得关注，但常驻显示也没坏处：
                用户能事先知道「可以切源」。做成两行：上面下拉，下面一句话说清
                这个源擅长什么 —— 别让用户选完还不知道区别。 -->
        <div class="target__source">
          <el-select
            v-model="source"
            size="small"
            class="target__source-select"
            :disabled="parsing"
          >
            <el-option
              v-for="opt in SOURCE_OPTIONS"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <span class="target__source-hint">{{ sourceHint }}</span>
        </div>

        <!-- ③ 格式提示行（参考稿的 "支持 CDXML / MOL / SDF…" 一行小字）
             🔴 识别到 CAS 号时**换成 CAS 专用提示**：用户输入 `50-78-2` 之后，
             底下必须告诉他「这是 CAS 号，会去查」——
             否则他看到「已设为目标分子」前会以为程序没认出来。 -->
        <div class="target__hint">
          <span v-if="!looksLikeCas" class="target__hint-text">{{ hintText }}</span>
          <span
            v-else
            class="target__hint-cas"
            :class="{ 'is-warn': substanceHit === null || casChecksumBad }"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M8 7.2v4M8 4.8v.6" />
            </svg>
            <template v-if="substanceSearching">
              正在查 {{ sourceLabel }}…
            </template>
            <template v-else-if="substanceHit === null">
              {{ sourceLabel }}没有收录这个 CAS 号，换个数据源或核对后重试
            </template>
            <template v-else-if="substanceHit">
              识别为 CAS 号 {{ substanceHit.cas || normalizeCas(text) }}，点「解析结构」按它查
              {{ sourceLabel }}
              <template v-if="substanceHit.name">｜{{ substanceHit.name }}</template>
              <!-- 物性与危害信息是 ChemIndex 的独有价值，查到了就露一小条 -->
              <template v-if="substanceHit.melting_point">
                ｜熔点 {{ substanceHit.melting_point }}
              </template>
            </template>
            <template v-else>
              识别为 CAS 号 {{ normalizeCas(text) }}，点「解析结构」按它查 {{ sourceLabel }}
            </template>
            <!-- 校验位不对：只提醒，不拦下（上游认不认才是权威） -->
            <span v-if="casChecksumBad" class="target__hint-cas-warn">
              （校验位可能抄错了）
            </span>
          </span>
        </div>
      </div>

      <!-- ③ 「或者」分隔 + 居中的绘制入口 —— Reaxys 的 `AND` + `Draw`：
             「粘贴 / 手绘」是两条**等价**路径，居中并排才读得出平级。 -->
      <div class="target__or"><span>或者</span></div>
      <div class="target__draw">
        <el-tooltip :content="seedHint || '打开 Ketcher 画板，手绘一个结构'" placement="top" :show-after="200">
          <button type="button" class="target__draw-btn" @click="openEditor">
            <svg class="target__draw-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <!-- 六元环（左上）：尖顶六边形 -->
              <path
                d="M13.62 5.7V11.5L8.6 14.4L3.58 11.5V5.7L8.6 2.8Z"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linejoin="round"
              />
              <!-- 铅笔（右下）：笔尖朝左下，与环错开，小尺寸下不会糊成一块 -->
              <path d="M13 21 14.06 22.06 21.06 15.06 18.94 12.94 11.94 19.94 Z" fill="currentColor" />
            </svg>
            {{ seedHint ? '编辑结构式' : '绘制结构式' }}
          </button>
        </el-tooltip>
      </div>

      <!-- ④ 次级操作：选择文件 / 清空 —— 居中独立一行（参考稿位置），
             不与格式提示混排（提示是"说明"，这是"动作"，性质不同）。 -->
      <div class="target__aux">
        <el-button link size="small" @click="fileInput?.click()">选择文件</el-button>
        <i aria-hidden="true">·</i>
        <el-button link size="small" :disabled="!text" @click="clearAll">清空</el-button>
        <input
          ref="fileInput"
          type="file"
          accept=".mol,.sdf,.sd,.cdxml,.txt,.smi,.smiles"
          hidden
          @change="onFile"
        />
      </div>

      <!-- ⑤ 示例：居中一行灰 chip（参考稿的"示例分子"行） -->
      <div class="target__examples">
        <span class="target__examples-label">示例</span>
        <button
          v-for="ex in EXAMPLES"
          :key="ex.smiles"
          type="button"
          class="target__chip"
          @click="applySuggestion(ex.smiles)"
        >
          {{ ex.label }}
        </button>
      </div>

      <!-- 解析失败：人话诊断 + 一键修复 -->
      <el-alert v-if="failure" type="error" :closable="false" class="target__diag">
        <template #title>结构解析失败</template>
        <ul class="target__reasons">
          <li v-for="(r, i) in failure.reasons || [failure.error || '无法解析']" :key="i">{{ r }}</li>
        </ul>
        <div v-if="failure.suggestions?.length" class="target__fixes">
          <span class="target__fixes-label">试试这些修复：</span>
          <el-button
            v-for="s in failure.suggestions"
            :key="s.smiles"
            size="small"
            :type="s.valid ? 'primary' : 'default'"
            @click="applySuggestion(s.smiles)"
          >
            {{ s.label }}
          </el-button>
        </div>
      </el-alert>
      </template>
    </div>

    <!-- 结构式画板（Ketcher 内核）：画完点下面的「用此结构搜索」 -->
    <!--
      🔴 `align-center` 必须给。Element Plus 的实现是：给 overlay 加 inline `display:flex`，
      再给 dialog 加 `.is-align-center{margin:auto}` ⇒ 真正上下左右居中。
      原来只用 `top="3vh"` 是**顶部对齐**：视口 1000px 时 dialog 高约 780px，
      底下一大片空白，看起来就是"没居中"。
      用 margin:auto 而不是 align-items:center 的 flex 居中 —— 后者在内容比容器高时
      会把**顶部**裁掉且滚不到，auto margin 溢出时自动退化成 0，是安全的那种。
    -->
    <el-dialog
      v-model="editorOpen"
      title="绘制结构式"
      width="min(1180px, 94vw)"
      align-center
      :close-on-click-modal="false"
      class="target__dialog"
    >
      <StructureEditor ref="editorRef" />

      <el-alert v-if="editorError" type="error" :closable="false" class="target__diag">
        <template #title>这个结构 RDKit 判不合法</template>
        <ul class="target__reasons">
          <li v-for="(r, i) in editorError.reasons || [editorError.error || '无法解析']" :key="i">
            {{ r }}
          </li>
        </ul>
      </el-alert>

      <template #footer>
        <el-button @click="editorOpen = false">取消</el-button>
        <el-button type="primary" :loading="editorBusy" @click="confirmEditor">
          用此结构搜索
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.target__body {
  display: flex;
  flex-direction: column;
  /* 🔴 `flex: 1` 是「提示行吸到底」的前提：本组件在标定卡片里被放进一个
     `align-self: stretch` 的栏容器（见 TargetSetupPanel 的 `.setup__target`），
     若 body 不撑满那根栏的高度，它内部的 `margin-top: auto`（.target__tip）
     就找不到可分配的多余空间 —— 表现为卡片下方挂一条空白带。
     flex-basis 保持 0：内容自然高度仍由子元素决定，flex:1 只负责"填满剩余"。 */
  flex: 1 1 0;
  /* 10px：输入框 / 工具行 / 示例行 / 结果卡 四段之间统一的呼吸。
     原来 12px 偏松，而这个面板要在同一屏里塞下左右两栏 + 底部动作栏。 */
  gap: 10px;
}

.target__head-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ---------- 收起态：目标胶囊 ----------
   解析成功后输入区整块让位给这一条。**品牌色高亮**（蓝描边 + 已解析徽标）
   与灰暗的输入态形成对比，明确这是"已确认的成果"。可点（回输入态替换），
   但「复制/编辑/替换」三个链接要点穿 —— @click.stop 已隔离。 */
.target__pill {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1.5px solid color-mix(in srgb, var(--rw-brand) 45%, transparent);
  border-radius: var(--rw-radius);
  background: var(--rw-brand-l);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.target__pill:hover {
  border-color: var(--rw-brand);
  background: color-mix(in srgb, var(--rw-brand-l) 70%, var(--rw-surface));
}

.target__pill-mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 60px;
  flex: 0 0 72px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  overflow: hidden;
}

.target__pill-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 「已解析目标」徽标：品牌色小胶囊，带对勾图标 */
.target__pill-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--rw-brand) 12%, transparent);
  color: var(--rw-brand-d);
  font-size: 11px;
  font-weight: 600;
}

.target__pill-tag svg {
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.target__pill-props {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  font-size: 12px;
  color: var(--rw-text-3);
}

.target__pill-props b {
  color: var(--rw-text-2);
  font-weight: 600;
}

.target__pill-ops {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
}

.target__input :deep(textarea) {
  font-family: var(--rw-font-mono);
  font-size: 13px;
}

/* ---------- ① 输入行（搜索框体量） ----------
   参考设计：label + 大输入框 + 右侧色块按钮，输入框是绝对主角。 */
.target__entry {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 「目标分子结构」小 label（参考稿的 Search / Paste Structure 行） */
.target__entry-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--rw-text-2);
}

.target__field {
  display: flex;
  align-items: stretch;
  /* 让输入框+按钮连成一块圆角搜索框 */
}

.target__field .target__input {
  flex: 1;
  min-width: 0;
}

/* 输入框：左圆角，去掉右圆角让按钮贴合；加深边框聚焦态 */
.target__field .target__input :deep(.el-textarea__inner) {
  border-radius: var(--rw-radius-sm) 0 0 var(--rw-radius-sm);
  border: 1.5px solid var(--rw-border-strong);
  box-shadow: none;
  transition: border-color 0.15s;
}

.target__field .target__input :deep(.el-textarea__inner:focus) {
  border-color: var(--rw-brand);
}

/* 解析按钮：右侧色块，贴住输入框右缘 */
.target__field-act {
  flex: 0 0 auto;
  display: flex;
}

.target__field-act :deep(.el-button) {
  height: 100%;
  min-height: 48px;
  border-radius: 0 var(--rw-radius-sm) var(--rw-radius-sm) 0;
  border: 1.5px solid var(--rw-brand);
  font-weight: 600;
}

/* ---------- ② 物质数据源选择（CAS / 名称查询用哪个库）----------
   放在输入框正下方：它是「输入什么」的一部分，不是全局设置。
   下拉本身不大，重点在旁边那句话（这个源擅长什么）。 */
.target__source {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 收窄下拉：这里的选项很短（"PubChem" / "ChemIndex（含物性）"），
   默认 100% 会把整行占满，把后面的说明文字挤到下一行去。 */
.target__source-select {
  flex: 0 0 auto;
  width: 178px;
}

.target__source-hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  color: var(--rw-text-3);
}

/* ---------- ③ 格式提示行 ---------- */
.target__hint {
  display: flex;
  align-items: center;
  font-size: 12px;
  color: var(--rw-text-3);
}

.target__hint-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* CAS 提示：识别到 CAS 号时取代通用提示行。
   用品牌色点出「这是个 CAS 号」，让用户知道程序认出来了、正在按 CAS 处理。
   查无此号时转警示色 —— 那是需要用户改输入的信号。 */
.target__hint-cas {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  color: var(--rw-brand-d);
}

.target__hint-cas svg {
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

/* 查无此号 / 校验位可疑：转警示色 —— 这是需要用户改输入的信号 */
.target__hint-cas.is-warn {
  color: var(--el-color-warning-dark-2, #b88230);
}

.target__hint-cas-warn {
  opacity: 0.85;
}

/* ---------- ③ 「或者」分隔 + 居中绘制入口（Reaxys 的 AND + Draw） ---------- */
.target__or {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--rw-text-3);
}

.target__or::before,
.target__or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--rw-border);
}

.target__draw {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.target__draw-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 22px;
  border: 1px solid var(--rw-border-strong);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s;
}

.target__draw-btn:hover {
  color: var(--rw-brand-d);
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
  box-shadow: var(--rw-shadow-1);
}

.target__draw-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  color: var(--rw-brand);
}

.target__draw-btn:hover .target__draw-icon {
  color: var(--rw-brand-d);
}

/* ---------- ④ 次级操作行：选择文件 / 清空（居中独立一行，参考稿位置） ---------- */
.target__aux {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.target__aux i {
  font-style: normal;
  opacity: 0.45;
}

/* ---------- ⑤ 示例：居中一行灰 chip（参考稿的"示例分子"行） ---------- */
.target__examples {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-wrap: wrap;
}

.target__examples-label {
  font-size: 12px;
  color: var(--rw-text-3);
  flex-shrink: 0;
  margin-right: 2px;
}

.target__chip {
  flex: 0 0 auto;
  padding: 3px 11px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  background: var(--rw-surface-2);
  color: var(--rw-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}

.target__chip:hover {
  color: var(--rw-brand-d);
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
}

.target__fixes-label {
  font-size: 12px;
  color: var(--rw-text-3);
  flex-shrink: 0;
}

.target__diag :deep(.el-alert__content) {
  width: 100%;
}

.target__reasons {
  margin: 4px 0 8px;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--rw-text-2);
}

.target__fixes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

/* 画板 dialog：内容再高也不能把底部按钮顶出视口 */
.target__dialog :deep(.el-dialog) {
  max-width: 96vw;
}

.target__dialog :deep(.el-dialog__body) {
  max-height: calc(100vh - 210px);
  overflow: auto;
}

.target__dialog :deep(.el-dialog__footer) {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 窄屏：工具行（提示 + 绘制/文件/清空）折成两行，别把提示文字挤成省略号 */
@media (max-width: 560px) {
  .target__hint {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .target__hint-text {
    flex: 0 0 auto;
    width: 100%;
  }
}
</style>
