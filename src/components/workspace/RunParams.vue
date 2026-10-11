<script setup lang="ts">
/**
 * 运行参数（预测设置 / 拆分约束 / 大模型设置 / 条件方案 / 分析模块）+ 模型预热。
 *
 * 🔴 「自动往下拆 K 层」**不在这里**：它是「开始一个任务」时的动作，已挪到
 *    新建逆合成分析面板（TargetSetupPanel）底部；「拆分约束」这组参数因此要显式
 *    注明「仅多步拆分生效」—— 否则用户会以为它管的是手动单步展开。
 *    内部实现仍是**串行多次调用同一个单步接口**（`/api/predict`，不是 `/api/search`），
 *    每步取 Top-1，随时可停止，受「最大深度」与「调用预算」双重约束。
 *
 * 🔴 本组件有两个宿主，两种形态：
 *    ① **标定卡片内**（TargetSetupPanel）—— 自带 `.rw-card` 边框与标题；
 *    ② **右辅助面板内**（AsidePanel）—— 面板已经给了标题「运行参数」和外框，
 *       这里必须用 `embedded` 关掉自己那层卡壳，否则会出现
 *       「运行参数 / 运行参数」两行标题叠在一起（实测踩过）。
 *    判据是显式 prop，**不要靠 CSS 去猜父容器** —— 猜错就是重复标题或彻底没标题。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { retroApi, llmApi } from '@/api/retro';
import { nodeLlmApi } from '@/api/capability/node-llm';
import { endpointConfigApi } from '@/api/capability/endpoint-config';
import { useWorkspaceStore, ALL_ANALYSIS_MODULES, ANALYSIS_MODULE_LABELS } from '@/stores/workspace';
import { useSettingsStore } from '@/stores/settings';
import { RETRO_VIA_NODE, MODEL_CONTROL_ENABLED } from '@/config/services';
import { SUPPLIERS, supplierById, type Supplier } from '@/utils/suppliers';
import { countHeavyAtoms } from '@/utils/smiles';
import { depictMolfile, isRdkitReady, needsBackendParse, parseStructure } from '@/utils/rdkit';
import MolView from '@/components/mol/MolView.vue';
import StructureEditor from '@/components/mol/StructureEditor.vue';
import type {
  LlmKeyState,
  LlmProfile,
  LlmSettings,
  LlmSource,
  ModelState,
  OfficialLlm,
  SearchAlgorithm
} from '@/types/retro';

/** true = 已被外层容器（右辅助面板）接管标题与外框，本组件只出内容 */
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const store = useWorkspaceStore();
const settings = useSettingsStore();
const materialInput = ref('');
const addingMaterial = ref(false);
const probing = ref(false);

// ---------- 预测模型：状态矩阵 / 后启动 / 就绪检测 ----------
// 🔴 「API 起来了」≠「模型能用了」。API 秒起，模型 40~90 秒；这一组状态就是那道区分。
//    后端契约见 web/model_client.py 的 catalog()：每行一个 state，外加一份 service 概览。
//
// 状态文案只有这一份：下拉项、状态标签、矩阵 chip **共用同一个表**。
// 分头写两套字面量是这类界面最常见的坏味道 —— 改一处漏一处，两处口径当场不一致。
const MODEL_STATE_TEXT: Record<ModelState, string> = {
  ready: '已就绪',
  loading: '加载中',
  failed: '加载失败',
  idle: '未加载',
  unavailable: '文件缺失'
};

/** 模型名字去掉括号里的说明（矩阵 chip 上放不下「（主推，性能最强）」） */
function shortLabel(label: string): string {
  return label.split('（')[0] || label;
}

/**
 * 搜索算法下拉的选项表。
 *
 * 🔴 key 必须与后端 `model_runtime.SEARCH_ALGORITHMS` 逐字对齐 —— 后端才是唯一的
 *    合法性判据地（非法值会被静默退回 retro_star）。这里若多出后端没有的 key，
 *    用户会选中一个实际跑 Retro* 的「BFS」而毫无察觉。
 */
const SEARCH_ALGORITHMS: Record<SearchAlgorithm, { label: string; note: string }> = {
  retro_star: { label: 'Retro*', note: '最佳优先 · 挑最有希望的路先拆' },
  bfs: { label: '广度优先 BFS', note: '逐层铺开 · 覆盖全但吃预算' }
};

const modelTagType = computed<'success' | 'warning' | 'danger' | 'info'>(() => {
  const st = store.currentModel?.state;
  if (st === 'ready') return 'success';
  if (st === 'loading') return 'warning';
  if (st === 'failed') return 'danger';
  return 'info';
});

const modelStatusText = computed(() => {
  // 🔴 正在「加载/切换中」要**立即**说「加载中」，不能等轮询回来：
  //    切换模型后 `modelLoadingKey` 立刻置位，但 `currentModel.state` 要等
  //    下一次 /api/models 轮询（1.5s+）才变 —— 这期间 tag 会停在旧状态
  //    （实测「未加载」卡 5 秒才变「加载中」，用户以为没反应）。
  if (store.modelLoadingKey !== null || store.modelStopping) return '加载中';
  const st = store.currentModel?.state;
  if (!st) return '未知';
  // 「服务在加载**别的**模型」要单独说：否则用户看着自己选的那行写「未加载」，
  // 旁边又有进度在动，只会以为界面坏了。
  if (st !== 'loading' && store.modelBusy) return '别的模型加载中';
  return MODEL_STATE_TEXT[st];
});

const modelDetail = computed(() => {
  const svc = store.modelService;
  const cur = store.currentModel;
  switch (cur?.state) {
    case 'failed':
      return svc?.error || '模型服务加载失败，详见模型服务窗口的日志';
    case 'loading': {
      // 秒数在**加载早期**也要有数：那段窗口 HTTP 还没起，后端从 state 文件补出 elapsed
      const secs = Math.max(0, Math.round(svc?.elapsed ?? 0));
      return `${store.modelPhase || '正在加载'}（已 ${secs} 秒）· 期间解析 / 分析照常可用`;
    }
    case 'unavailable':
      return '模型文件不在 models/ 目录里 —— 先放好文件再启动';
    case 'ready':
      return `已加载${svc?.load_seconds ? ` · 用时 ${Math.round(svc.load_seconds)} 秒` : ''} · 常驻，重启 API 不会重载`;
    default:
      // 正在加载的是**另一个**模型（用户刚切换、或上一次的进程还在收尾）
      if (store.modelBusy) {
        const busy = store.models.find((m) => m.state === 'loading');
        return `「${busy ? shortLabel(busy.label) : '其他模型'}」正在加载，切换要等它结束`;
      }
      // 无权启停（走 Node 中转）时不能叫用户去点按钮 —— 按钮根本不显示
      if (!MODEL_CONTROL_ENABLED) {
        return svc?.running ? '等待后端把模型加载到可用' : '由后端负责启动（期间解析 / 分析照常可用）';
      }
      return svc?.running
        ? '点「加载」后启动（首次约 40~90 秒）'
        : '点「加载」拉起模型服务（首次约 40~90 秒；期间解析 / 分析照常可用）';
  }
});

/**
 * 加载进度（0~100），**直接用后端给的 progress**。
 *
 * 🔴 后端 `_progress_now()` 已经做了实时插值（锚点 + elapsed 线性推进），
 *    `/status` 每次被读都会重算，前端每 1.5s 轮询拿到的就是**平滑爬升的值** ——
 *    前端再插一遍纯属画蛇添足（实测引入抖动 0↔1、30↔31 与 99% 提前封顶）。
 *
 * 唯一的边界是「加载早期 HTTP 还没起」：那段走 state 文件回退，progress 停在阶段
 *    锚点（0/30/88）。但后端 `_write_state` 写的是 `host._progress_now()`，阶段切换时
 *    会刷新一次；且 import/model 阶段本就无内部进度可报，锚点跳跃是诚实表现，
 *    等 HTTP 起来（rules 段）就变实时平滑。所以这里只做「取整 + 夹紧」，不画蛇添足。
 */
const modelProgress = computed<number | null>(() => {
  if (!store.modelBusy) return null;
  const p = store.modelService?.progress;
  return typeof p === 'number' && Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : null;
});

/** 「加载」按钮的可用性：模型文件都不在就别让它点了（点了必然失败） */
const canLoadModel = computed(() => {
  const cur = store.currentModel;
  return !!cur && cur.state !== 'unavailable';
});

/** 主按钮点下去干什么 */
function onModelAction(): void {
  if (store.modelReady || store.modelBusy) void store.stopModelService();
  else void store.warmModel();
}

/**
 * 主按钮文案。🔴 加载/切换中必须说「加载中…」而不是停在「加载」——
 *    切换模型后 `modelLoadingKey` 立刻置位（按钮转圈），但 `modelBusy` 要等
 *    轮询回来才变 true，若文案只认 ready/busy 就会「转着圈还写『加载』」，
 *    用户分不清是正在加载还是没反应。这里把「正在进行中」也算进去。
 */
const modelActionText = computed(() => {
  if (store.modelLoadingKey !== null || store.modelStopping) return '加载中…';
  if (store.currentModel?.state === 'loading') return '加载中…';
  if (store.modelReady || store.modelBusy) return '停止';
  return '加载';
});

/**
 * 切换预测模型（下拉 @change）。
 *
 * 🔴 原实现只有 `v-model` 没有 `@change` ⇒ 切下拉只改了 store 值、**不加载**，
 *    界面纹丝不动（实测「未加载/加载」切完还是「未加载/加载」），用户以为切了其实没切。
 *    这里改成：切模型 = 自动加载（与后端 /api/load 的「换模型 = 停旧起新」对齐）。
 *
 * 🔴 但切模型是**重操作**（停掉旧模型进程、重启、重新加载 40~90 秒），
 *    误点一下就白等几十秒还中断正在跑的搜索 —— 所以弹一次确认。
 */
/** 下拉展开那一刻选中的模型 key —— 取消切换时用它回退（`@change` 里拿不到旧值） */
let _modelBeforeOpen = '';

/** 下拉展开时记下当前值：`@change` 触发时 v-model 已改成新值，旧值只能在这时抓 */
function onModelSelectVisible(visible: boolean): void {
  if (visible) _modelBeforeOpen = store.params.model;
}

async function onModelChange(key: string): Promise<void> {
  // 🔴 无权启停模型（走 Node 中转）时，下拉**只是选择**、不触发生效 ——
  //    否则会弹"要停掉当前模型重新加载吗"的确认框，而前端其实根本没这个权限。
  if (!MODEL_CONTROL_ENABLED) return;
  // 选回「已经就绪 / 正在加载」的那个模型 ⇒ 无需动作（后端 /api/load 也会 no-op 直接返回）
  const curState = store.models.find((m) => m.key === key)?.state;
  if (curState === 'ready' || curState === 'loading') {
    return;
  }
  // 🔴 `@change` 触发时 v-model 已把 store.params.model 改成新值，旧值在 _modelBeforeOpen。
  //    先回退显示，等确认通过才真正切过去，否则确认框还开着、下拉已变，割裂感很怪。
  const prev = _modelBeforeOpen || key;
  store.params.model = prev;
  try {
    await ElMessageBox.confirm(
      `切换到「${shortLabel(store.models.find((m) => m.key === key)?.label ?? key)}」会停止当前模型并重新加载（约 40~90 秒）。确定切换？`,
      '切换预测模型',
      { confirmButtonText: '切换', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return; // 取消：params.model 保持 prev，无需再动
  }
  store.params.model = key;
  await store.warmModel(key);
}

// ---------- 可行性过滤（正向模型） ----------
// 🔴 「可行性过滤」= 拿正向模型把逆向模型给的每条候选反应复核一遍（前体 → 产物 是否
//    命中正向 top-k）。它不是"另一个预测模型"，而是**判别器** ⇒ 只出现在这一行，
//    不进「预测模型」下拉（那个下拉里每一行都必须能当搜索主模型，混进判别器就会出现
//    「选中它去跑逆合成」这种必然失败的组合）。也不影响手动单步「展开」—— 那一步不
//    经过搜索，没有"过滤搜索分支"这回事。
const fwdStateText = computed(() => {
  const st = store.forwardModel?.state;
  return st ? MODEL_STATE_TEXT[st] : '不可用';
});

const fwdTagType = computed<'success' | 'warning' | 'danger' | 'info'>(() => {
  const st = store.forwardModel?.state;
  if (st === 'ready') return 'success';
  if (st === 'loading') return 'warning';
  if (st === 'failed') return 'danger';
  return 'info';
});

const fwdDetail = computed(() => {
  const f = store.forwardModel;
  // 老后端不返回 forward ⇒ 说清是版本问题，别让人以为"这个功能不存在"
  if (!f) return '后端未提供正向模型信息（可能还在跑旧版本，重启后端服务后即可）';
  switch (f.state) {
    case 'unavailable':
      return '模型文件不在 models/ 目录里 —— 跑 scripts/download_model.py forward_pistachio 下载（约 835 MB）';
    case 'loading':
      return '正在加载正向模型（约 1 GB 内存，几十秒）· 期间多步拆分照常可用，只是不带过滤';
    case 'failed':
      return f.error || '正向模型加载失败，详见模型服务窗口的日志';
    case 'ready':
      return `已就绪${f.load_seconds ? ` · 用时 ${Math.round(f.load_seconds)} 秒` : ''} · 开启后每条候选反应都要过一遍正向校验`;
    default:
      if (!MODEL_CONTROL_ENABLED) {
        return store.modelReady
          ? '等待后端把正向模型加载到可用'
          : '预测模型就绪后由后端一并处理';
      }
      return store.modelReady
        ? '点「加载正向模型」后即可启用（约 1 GB 内存，几十秒）'
        : '先加载预测模型，再点「加载正向模型」';
  }
});

/** 只有当"文件在、但还没就绪"时才给加载按钮：文件缺了点了必然失败，不如直接给下载指引 */
const showForwardLoad = computed(() => {
  // 🔴 无权启停模型时不给入口（走 Node 中转时模型加载归 Node 管）
  if (!MODEL_CONTROL_ENABLED) return false;
  const st = store.forwardModel?.state;
  return !!st && st !== 'ready' && st !== 'unavailable';
});

/** 「拆分约束」组的折叠摘要：算法/深度/预算/起始物料数（可行性过滤已挪进「预测设置」组） */
const constraintMeta = computed(
  () =>
    `${SEARCH_ALGORITHMS[store.params.searchAlgorithm]?.label ?? store.params.searchAlgorithm} · ` +
    `深度 ${store.params.maxDepth} · 预算 ${store.params.budgetCalls}` +
    (store.params.startingMaterials.length ? ` · 起始物料 ${store.params.startingMaterials.length}` : '')
);

// ---------- 大模型状态（区分「填了」和「真的能用」） ----------
const llmProbe = computed(() => store.llmStatus?.probe);

const llmTagType = computed<'success' | 'warning' | 'danger' | 'info'>(() => {
  const st = store.llmStatus;
  if (!st?.configured) return 'info';
  const p = llmProbe.value;
  if (!p) return 'warning'; // 已填但未验证
  return p.verified ? 'success' : 'danger';
});

const llmTagText = computed(() => {
  const st = store.llmStatus;
  if (!st?.configured) return '未配置';
  const p = llmProbe.value;
  if (!p) return `${st.model || '已配置'}（未验证）`;
  if (p.verified) return p.model || st.model || '可用';
  return '验证失败';
});

const llmTooltip = computed(() => {
  const st = store.llmStatus;
  if (!st?.configured) return st?.hint || '未配置大模型（在下方「端点配置」里新建一套：接口地址 / 模型 / API Key）';
  const p = llmProbe.value;
  // 多套端点并存时，光看模型名认不出「正在生效的是哪一套」⇒ 带上配置名
  const who = st.profile_name ? `配置「${st.profile_name}」 · ` : '';
  if (!p) return `已读取：${who}${st.model}\n点「验证」真发一次最小请求，确认 key 与模型可用`;
  if (p.verified) return `已验证可用：${who}${p.model}（${p.key || '当前 key'}）\n${p.base_url || ''}`;
  return `验证失败（${who.replace(' · ', '') || '当前配置'}）：${p.error || '未知错误'}`;
});

/** 「验证」按钮：只在用户主动点击时才真打网络（网关有限流，别自动打） */
async function verifyLlm(): Promise<void> {
  probing.value = true;
  try {
    await store.loadLlmStatus(true);
    const p = store.llmStatus?.probe;
    if (p?.verified) ElMessage.success(`大模型可用：${p.profile_name ? p.profile_name + ' · ' : ''}${p.model}（${p.key || 'key'}）`);
    else if (store.llmStatus?.configured) ElMessage.error(p?.error || '大模型验证失败');
    else ElMessage.warning(store.llmStatus?.hint || '大模型未配置');
  } finally {
    probing.value = false;
  }
}

// ---------- 大模型来源选择（官方 / 自建，走 Node 中转时才有） ----------
// 🔴 官方 LLM 的 token 数量与值都不出后端（见 Node 的 official-llm.service），前端只能
//    看到「有哪些官方模型 + 剩余配额」。选择「官方」= 让后端用自己的 key 出算力，
//    前端没有任何官方凭据可看、可改、可泄露。
// 🔴 该选择存服务端 UserSettings.llm_source（跨设备生效），不是前端 localStorage 记忆。
// 🔴 只在走 Node 中转（RETRO_VIA_NODE）时出现：直连 Python 路径没有「官方」这个概念。

/** 当前选的来源（'user' = 自建，'official' = 官方） */
const llmSource = ref<LlmSource>('user');
/** 官方模型清单（后端只回 name/model/quota/enabled） */
const officialModels = ref<OfficialLlm[]>([]);
const loadingSource = ref(false);
const sourceSwitching = ref(false);

/** 是否展示来源选择（仅走 Node 中转） */
const showSourcePicker = computed(() => RETRO_VIA_NODE);

/** 是否有已启用的官方模型可切过去 */
const officialAvailable = computed(() =>
  officialModels.value.some((m) => m.enabled && m.model)
);

/** 读来源偏好 + 官方清单（进页面时一次） */
async function loadLlmSource(): Promise<void> {
  if (!showSourcePicker.value) return;
  loadingSource.value = true;
  try {
    const [s, models] = await Promise.all([nodeLlmApi.getSettings(), nodeLlmApi.official()]);
    llmSource.value = s.llm_source === 'official' ? 'official' : 'user';
    officialModels.value = models;
  } catch {
    /* 后端没起 / 老版本：保持默认，不打断面板 */
  } finally {
    loadingSource.value = false;
  }
}

/** 切换来源：落服务端，成功才改本地态 */
async function switchSource(next: LlmSource): Promise<void> {
  if (next === llmSource.value) return;
  sourceSwitching.value = true;
  try {
    await nodeLlmApi.setLlmSource(next);
    llmSource.value = next;
    ElMessage.success(next === 'official' ? '已切换到大模型来源「官方模型」' : '已切换到大模型来源「自建配置」');
  } catch (e) {
    ElMessage.error((e as Error).message || '切换来源失败');
  } finally {
    sourceSwitching.value = false;
  }
}

// ---------- 端点配置（接口地址 / 模型 / API Key 绑定成一套，可存多套切换） ----------
// 🔴 为什么绑成一套：三者互相依赖 —— MiMo 的 key 配 DeepSeek 的地址、或 DeepSeek 的地址
//    配 MiMo 的模型名，都是无效组合。分开填的时候换供应商要挨个改三处，改漏一处就得到
//    一个「看着配好了、一调就 401/404」的状态。现在切换只动一个 id，后端把整套换掉。
//
// 编辑态草稿：加载后改这里，点「保存设置」才 POST。keys 保存脱敏串（含 * = 保留原 key），
// 新增的 key 是明文 —— 后端按「含 * 与否」区分保留/新增，往返无损。
interface ProfileDraft {
  id: string;
  name: string;
  base_url: string;
  model: string;
  max_tokens: number;
  temperature: number;
  timeout: number;
  json_mode: boolean;
  /** 脱敏串（已保存的）或明文（这次新加的） */
  keys: string[];
  /** 服务端给的 key 状态；每套配置各一张表，切换配置不会串 */
  keyStates: LlmKeyState[];
}

const profiles = ref<ProfileDraft[]>([]);
const editingId = ref('');
const savingSettings = ref(false);
const switching = ref(false);
/** 「刷新」进行中：重读后端设置 + 状态，**不**真打大模型请求（那是「验证」的事） */
const refreshing = ref(false);
const newKey = ref('');
const modelOptions = ref<string[]>([]);
/**
 * `modelOptions` 的**来源指纹**（拉取时用的 base_url + key）。
 *
 * 🔴 列表是**带配置的**结果，不是全局常量：换一套配置（或改了接口地址/Key）之后
 * 它就不再代表当前这套 —— 直接复用会让 B 配置的下拉里躺着 A 的模型名，
 * 而且因为「列表非空」，`onModelDropdown` 再也不会重拉（一次错、永久错）。
 */
const modelSource = ref('');
const loadingModels = ref(false);
/** 上次与服务端对齐的内容指纹 —— 「有未保存改动」的判据 */
const savedSig = ref('');

/**
 * 某套配置在 UI 上要显示的 key 状态。
 *
 * 🔴 `profiles[].keys` 为空时，**激活那套**用服务端的扁平回显兜一层 —— 有实测来源：
 * 后端 `_norm_profiles` 的 `.env` 懒迁移曾经漏读单数名 `RETRO_LLM_API_KEY`，
 * 于是 `profiles[0].keys` 是空数组、而顶层扁平 `keys` 有值（运行时的 key_pool 另有回落）。
 * 结果就是面板显示「API Keys（0）」+ 保存被「至少一个 API Key 必填」拦住，
 * 但模型其实跑得动 —— 三种说法互相矛盾，最难排查。
 * 只补**激活**那套、且仅在它自己为空时补：扁平回显按定义就是激活配置的运行时 key 池。
 */
function profileKeyStates(s: LlmSettings, p: LlmProfile): LlmKeyState[] {
  const own = Array.isArray(p.keys) ? p.keys : [];
  if (own.length || !p.active) return own;
  // 后端没把这把 key 算进配置、却给了扁平回显 ⇒ 它只可能来自 `.env` 的回落。标出来，
  // UI 才知道这把「删不掉」（老后端不返回 `source`，这里替它补上）。
  return (Array.isArray(s.keys) ? s.keys : []).map((k) => ({ ...k, source: k.source ?? 'env' }));
}

/** 这把 key 的来源（缺省按 `profile` 处理：老后端不返回该字段） */
function keySourceOf(masked: string): 'profile' | 'env' {
  return keyStateOf(masked)?.source === 'env' ? 'env' : 'profile';
}

function toDraft(p: LlmProfile, keyStates?: LlmKeyState[]): ProfileDraft {
  // keys 兜底：后端若比前端旧（字段缺失 / 名字没对上），宁可显示空列表也不能整块崩掉
  const keys = Array.isArray(keyStates) ? keyStates : Array.isArray(p.keys) ? p.keys : [];
  return {
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    model: p.model,
    max_tokens: p.max_tokens,
    temperature: p.temperature,
    timeout: p.timeout,
    json_mode: p.json_mode,
    keys: keys.map((k) => k.masked),
    keyStates: keys
  };
}

/**
 * 内容指纹（**不含 keyStates**）：服务端的 key 状态随请求在变，把它算进去会导致
 * 「什么都没改也显示有未保存改动」。
 */
function signature(list: ProfileDraft[]): string {
  return JSON.stringify(
    list.map((p) => ({
      id: p.id,
      name: p.name,
      base_url: p.base_url,
      model: p.model,
      max_tokens: p.max_tokens,
      temperature: p.temperature,
      timeout: p.timeout,
      json_mode: p.json_mode,
      keys: p.keys
    }))
  );
}
const dirty = computed(() => signature(profiles.value) !== savedSig.value);

/** 当前编辑的那套（下拉选中的 = 正在生效的那套） */
const cur = computed<ProfileDraft | undefined>(
  () => profiles.value.find((p) => p.id === editingId.value) ?? profiles.value[0]
);

function keyStateOf(masked: string): LlmKeyState | undefined {
  // 🔴 按脱敏串匹配，不按下标：keys 里可能有「还没保存」的明文 key，
  //     而服务端状态只覆盖已保存的池 —— 按下标对齐会错位。
  return cur.value?.keyStates.find((s) => s.masked === masked);
}
type TagKind = 'success' | 'warning' | 'danger' | 'info';
function keyTagType(s?: LlmKeyState): TagKind {
  if (!s) return 'info';
  return s.state === 'active' ? 'success' : s.state === 'bad' ? 'danger' : s.state === 'cooldown' ? 'warning' : 'info';
}
function keyTagText(s?: LlmKeyState): string {
  if (!s) return '—';
  return s.state === 'active' ? '使用中' : s.state === 'bad' ? '失效' : s.state === 'cooldown' ? '冷却中' : '备用';
}
const hasDisabledKey = computed(() => (cur.value?.keyStates ?? []).some((k) => k.state === 'bad' || k.state === 'cooldown'));

/** 把服务端返回整套贴回草稿（含当前激活项） */
function applySettings(s: LlmSettings): void {
  // 🔴 **必须容忍「后端还是旧版本」**：升级前端的接口后再刷新页面，后端可能还在跑
  //    返回扁平字段的老代码（`ok:true` 但没有 profiles）。直接 `.map` 会让异常冒到
  //    渲染层，整块面板连带页面一起白屏 —— 这是实测踩到的。
  const list = Array.isArray(s.profiles) ? s.profiles : [];
  profiles.value = list.map((p) => toDraft(p, profileKeyStates(s, p)));
  editingId.value = s.active_profile || profiles.value[0]?.id || '';
  savedSig.value = signature(profiles.value);
}

/** 只把 key 状态贴回去（「重试失效 Key」用）—— 不碰用户正在编辑的内容 */
function applyKeyStates(s: LlmSettings): void {
  const map = new Map((Array.isArray(s.profiles) ? s.profiles : []).map((p) => [p.id, p]));
  for (const p of profiles.value) {
    const prof = map.get(p.id);
    // 🔴 走同一个 `profileKeyStates`：不然这里会用「空的 profiles[].keys」把
    //    上面兜下来的那一条状态又擦掉（面板变成有 key 行、没状态标签）
    if (prof) p.keyStates = profileKeyStates(s, prof);
  }
}

/** 读后端的端点配置；返回是否**真的读到了**（`false` = 请求失败或后端版本不对） */
async function loadSettings(): Promise<boolean> {
  const s = await endpointConfigApi.settings();
  if (!s.ok) return false;
  if (!Array.isArray(s.profiles)) {
    // 后端没重启仍在跑旧版本：空面板会让人以为「配置丢了」，必须说清楚
    ElMessage.warning('后端还在跑旧版本（不支持端点配置），请重启后端服务后再试');
    return false;
  }
  applySettings(s);
  return true;
}

/**
 * 「刷新」：重新读一遍后端（端点配置 + key 状态 + 顶部的模型状态标签）。
 *
 * 🔴 与「验证」的分工：刷新**只读配置**，不真打大模型请求（网关有限流）；
 *    要确认 key / 模型真能用，仍然走「验证」。
 * 🔴 有未保存改动时必须先问：刷新会整块覆盖编辑区，默默丢掉用户刚粘的 key 是最坏的结果。
 */
async function reloadSettings(): Promise<void> {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('当前有未保存的改动，刷新会用后端的内容覆盖它们。', '刷新端点配置', {
        type: 'warning',
        confirmButtonText: '丢弃改动并刷新',
        cancelButtonText: '取消'
      });
    } catch {
      return; // 用户取消
    }
  }
  refreshing.value = true;
  try {
    const ok = await loadSettings();
    await store.loadLlmStatus(false); // 顶部标签也一起对一遍
    if (ok) ElMessage.success('已从后端重新读取端点配置');
  } catch (e) {
    ElMessage.error((e as Error).message || '刷新失败');
  } finally {
    refreshing.value = false;
  }
}

/**
 * 保存全部端点配置（整包提交）。
 * `silent` = 切换配置前的自动落盘：成功不弹提示（避免每次切都弹一条），失败照常报。
 */
async function saveSettings(silent = false): Promise<boolean> {
  const bad = profiles.value.find((p) => !p.base_url.trim() || !p.model.trim() || !p.keys.length);
  if (bad) {
    // 🔴 这里**不能**因为 silent 就闭嘴：否则切换配置时会「看着切过去了、其实没保存」
    ElMessage.warning(`「${bad.name || bad.id}」的接口地址、模型、至少一个 API Key 都必填`);
    return false;
  }
  savingSettings.value = true;
  try {
    const out = await endpointConfigApi.saveSettings({
      profiles: profiles.value.map((p) => ({
        id: p.id,
        name: p.name,
        base_url: p.base_url.trim(),
        model: p.model.trim(),
        max_tokens: p.max_tokens,
        temperature: p.temperature,
        timeout: p.timeout,
        json_mode: p.json_mode,
        api_keys: p.keys
      })),
      active_profile: editingId.value
    });
    applySettings(out);
    await store.loadLlmStatus(false); // 顶部「AI 工艺分析」状态标签立即刷新
    if (!silent) ElMessage.success('端点配置已保存（立即生效，无需重启）');
    return true;
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
    return false;
  } finally {
    savingSettings.value = false;
  }
}

/**
 * 切换当前使用的端点配置 —— 后端只改 `active_profile`，立即生效。
 * 有未保存改动时**先落盘再切**，否则改动会静默丢掉。
 */
async function switchProfile(id: string): Promise<void> {
  if (!id || id === editingId.value) return;
  switching.value = true;
  try {
    if (dirty.value && !(await saveSettings(true))) return; // 保存失败就别切，避免状态错乱
    const out = await endpointConfigApi.activateProfile(id);
    if (!out.ok) {
      ElMessage.error(out.error || '切换端点配置失败');
      return;
    }
    applySettings(out);
    const nm = out.profiles.find((p) => p.id === out.active_profile)?.name || id;
    ElMessage.success(`已切换到「${nm}」，后续分析走这套接口`);
  } finally {
    switching.value = false;
  }
}

function uniqueId(base: string): string {
  const used = new Set(profiles.value.map((p) => p.id));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

/** 新建一套空白配置（本地追加，先不切过去 —— 还没填内容，切过去只会报错） */
function addProfile(): void {
  const id = uniqueId('profile');
  profiles.value.push({
    id,
    name: '新配置',
    base_url: '',
    model: '',
    // 0 = 无限制（不传 max_tokens，交给模型/网关默认）。默认给「无限制」：
    // 额度太小会让推理模型的思考 token 吃光额度、正文 0 字符（finish_reason=length）。
    max_tokens: 0,
    temperature: 0.3,
    timeout: 300,
    json_mode: true,
    keys: [],
    keyStates: []
  });
  editingId.value = id;
  resetModelOptions();
}

/** 「无限制」勾选：勾上写 0（后端 `_max_tokens_in` 认 0 = 不设上限），取消则给个够用的默认额度 */
const DEFAULT_TOKENS = 32768;
function onUnlimitedTokens(val: unknown): void {
  if (!cur.value) return;
  cur.value.max_tokens = val ? 0 : DEFAULT_TOKENS;
}

/** 复制当前配置（keys 跟着走；脱敏串由后端在**原配置的池**里还原成真实 key） */
function dupProfile(): void {
  const src = cur.value;
  if (!src) return;
  const id = uniqueId(`${src.id}-copy`);
  profiles.value.push({ ...src, id, name: `${src.name} 副本`, keys: [...src.keys], keyStates: [] });
  editingId.value = id;
  resetModelOptions();
}

/** 删除当前配置（里面存着密钥，删前确认） */
async function delProfile(): Promise<void> {
  const src = cur.value;
  if (!src) return;
  try {
    await ElMessageBox.confirm(
      `确定删除端点配置「${src.name}」？该配置里保存的 ${src.keys.length} 个 API Key 会一起从后端删除。`,
      '删除端点配置',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    );
  } catch {
    return; // 用户取消
  }
  const rest = profiles.value.filter((p) => p.id !== src.id);
  profiles.value = rest;
  editingId.value = rest[0]?.id ?? '';
  const ok = await saveSettings(true);
  if (ok) ElMessage.success(rest.length ? `已删除「${src.name}」` : '已删除全部端点配置（回落到 .env 里的配置）');
}

/** 这套配置的来源指纹：换了端点或换了 key，上一次的模型列表就作废 */
function sourceSig(c: ProfileDraft): string {
  return JSON.stringify([c.id, c.base_url.trim(), c.keys[0] ?? '', c.keys.length]);
}

/** 列表与它的来源指纹必须**一起**清（只清一边 ⇒ 指纹仍命中或列表残留，两种都会串配置） */
function resetModelOptions(): void {
  modelOptions.value = [];
  modelSource.value = '';
}

/**
 * 拉取**当前编辑这套**可见的模型（草稿也能拉，不必先保存）。
 *
 * 三条守卫：
 * ① 缺 base_url / 没 key 时**先拦**：这种请求必然失败，与其等一个网络往返再弹
 *    「拉取失败」，不如当场说清缺哪一项 —— 后端也会校验，这里只是省一次白跑。
 * ② 拉取期间配置被改过/切走了 ⇒ 结果不属于当前这套，**直接丢弃**。判据用**指纹**
 *    而不是只比 id：同一个配置把接口地址改掉之后，上一次那份列表同样已经作废。
 * ③ 成功/失败都留痕：列表为空也要说，否则「点了没反应」和「真没有模型」分不清。
 */
async function refreshModels(): Promise<void> {
  const c = cur.value;
  if (!c) return;
  const baseUrl = c.base_url.trim();
  if (!baseUrl) {
    ElMessage.warning('先填接口地址（base_url）再拉取模型');
    return;
  }
  if (!c.keys.length) {
    ElMessage.warning('这套配置还没有 API Key，拉不到模型列表');
    return;
  }
  const sig = sourceSig(c);
  loadingModels.value = true;
  try {
    const r = await llmApi.models({ id: c.id, base_url: baseUrl, model: c.model.trim(), api_keys: c.keys });
    if (!cur.value || sourceSig(cur.value) !== sig) return; // ② 期间变过，这份列表作废
    if (!r.ok) {
      ElMessage.warning(r.error || '拉取模型列表失败');
      return;
    }
    modelOptions.value = r.models;
    modelSource.value = sig;
    if (!r.models.length) {
      ElMessage.warning('该端点没返回任何模型，检查接口地址是不是指到了 OpenAI 兼容的 /v1');
    } else {
      ElMessage.success(`已拉取 ${r.models.length} 个模型${r.key ? `（用 ${r.key}）` : ''}`);
    }
  } finally {
    loadingModels.value = false;
  }
}
function onModelDropdown(visible: boolean): void {
  const c = cur.value;
  if (!visible || !c) return;
  // 列表为空、或它来自**另一套**配置/另一个地址 ⇒ 重拉（见 `modelSource` 的说明）
  if (!modelOptions.value.length || modelSource.value !== sourceSig(c)) void refreshModels();
}

function addKey(): void {
  const c = cur.value;
  const k = newKey.value.trim();
  if (!c || !k) return;
  if (c.keys.includes(k)) {
    ElMessage.info('该 Key 已在列表中');
    newKey.value = '';
    return;
  }
  c.keys.push(k);
  newKey.value = '';
}

function removeKey(i: number): void {
  cur.value?.keys.splice(i, 1);
}

async function resetKeys(): Promise<void> {
  const c = cur.value;
  if (!c) return;
  try {
    // 🔴 中转档下会抛错（密钥轮换状态在服务端），面板据此提示用户，不静默吞
    const out = await endpointConfigApi.resetKeys(c.id); // 只清这套配置的标记，不牵动别的端点
    // 🔴 只更新状态标签，**不覆盖 keys** —— 草稿里可能还有没保存的新增 key，
    //     用服务端列表覆盖会把它弄丢（实测踩过）。
    applyKeyStates(out);
    ElMessage.success(`已清除「${c.name}」的失效/冷却标记，Key 全部重新可用`);
  } catch (e) {
    ElMessage.error((e as Error).message || '重置失败');
  }
}

// ---------- 分析模块勾选 ----------
const modules = computed(() => store.analysisModules);
const moduleOptions = ALL_ANALYSIS_MODULES.map((k) => ({ key: k, label: ANALYSIS_MODULE_LABELS[k] }));

/** 全选：恢复成默认全部模块 */
function selectAllModules(): void {
  store.analysisModules = [...ALL_ANALYSIS_MODULES];
}
/** 清空：只留「总述+反应类型」这一项兜底（后端永远带上） */
function clearModules(): void {
  store.analysisModules = [];
}
const allSelected = computed(() => store.analysisModules.length === ALL_ANALYSIS_MODULES.length);

/** 勾选/取消某个模块 */
function toggleModule(key: string, checked: boolean): void {
  const set = new Set(store.analysisModules);
  if (checked) set.add(key as (typeof ALL_ANALYSIS_MODULES)[number]);
  else set.delete(key as (typeof ALL_ANALYSIS_MODULES)[number]);
  // 按固定顺序回写，保证展示/请求顺序稳定
  store.analysisModules = ALL_ANALYSIS_MODULES.filter((k) => set.has(k));
}

/**
 * 指定起始物料：先把输入规范化成 canonical SMILES，再按 canonical 比对去重。
 * 规范化走**前端 RDKit**（同 TargetInput 的分工）：纯 SMILES/MOL 不必打网络；
 * 只有 CDXML 这种浏览器版 RDKit 读不了的才回落后端 `/api/parse`。
 */
async function addMaterial(): Promise<void> {
  const raw = materialInput.value.trim();
  if (!raw) return;
  addingMaterial.value = true;
  try {
    const useBackend = needsBackendParse(raw);
    if (!useBackend && !isRdkitReady()) {
      // 与 TargetInput 一致：首次要拉 7.4MB 引擎，先说一声，别让人以为卡死
      ElMessage.info('首次解析需加载前端解析引擎（约 7MB），请稍候…');
    }
    const res = useBackend ? await retroApi.parse(raw) : await parseStructure(raw);
    if (!res.ok) {
      // 🔴 失败要写进**行内**提示（红字挂在输入框下），ElMessage 会被下一次操作顶走，
      //    而行内提示跟输入框同寿命 —— 用户改一字就重验，改对了提示自己消失。
      materialIssue.value = res.reasons?.[0] || res.error || '无法解析该起始物料';
      ElMessage.error(materialIssue.value);
      return;
    }
    if (store.params.startingMaterials.includes(res.smiles)) {
      ElMessage.info('该起始物料已在列表中');
    } else {
      store.params.startingMaterials = [...store.params.startingMaterials, res.smiles];
    }
    materialInput.value = '';
    materialIssue.value = '';
  } catch (e) {
    materialIssue.value = (e as Error).message;
    ElMessage.error(materialIssue.value);
  } finally {
    addingMaterial.value = false;
  }
}

function removeMaterial(smiles: string): void {
  store.params.startingMaterials = store.params.startingMaterials.filter((s) => s !== smiles);
}

/* ---------- 手动画原料 ---------- */

const matDrawOpen = ref(false);
const matDrawRef = ref<InstanceType<typeof StructureEditor> | null>(null);
const matDrawBusy = ref(false);
const matDrawError = ref('');
/** 上一次灌进画板的结构 —— 结构没变且画板非空时不重灌，别冲掉画到一半的图 */
const matDrawSeeded = ref('');

/** 打开画板：把手上的输入（若已解析）带进去，否则开空板让用户画 */
async function openMatDraw(): Promise<void> {
  matDrawOpen.value = true;
  matDrawError.value = '';
  await nextTick();
  const ed = matDrawRef.value;
  if (!ed) return;
  // 输入框里若已是合法 SMILES，带进去改；否则开空板（用户本来就点「画」）
  const seed = materialInput.value.trim();
  if (!seed) return;
  try {
    if (seed === matDrawSeeded.value && !(await ed.isEmpty())) return;
    const molfile = await depictMolfile(seed);
    if (molfile) {
      await ed.loadFromMolfile(molfile);
      matDrawSeeded.value = seed;
    }
  } catch {
    /* 载不进去就让用户直接画 */
  }
}

async function confirmMatDraw(): Promise<void> {
  const ed = matDrawRef.value;
  if (!ed) return;
  matDrawBusy.value = true;
  matDrawError.value = '';
  try {
    if (await ed.isEmpty()) {
      ElMessage.warning('画板还是空的，先画一个结构');
      return;
    }
    const res = await parseStructure(await ed.getMolfile());
    if (!res.ok) {
      matDrawError.value = res.error || res.reasons?.[0] || '这个结构 RDKit 判不合法';
      return;
    }
    if (store.params.startingMaterials.includes(res.smiles)) {
      ElMessage.info('该起始物料已在列表中');
    } else {
      store.params.startingMaterials = [...store.params.startingMaterials, res.smiles];
    }
    matDrawSeeded.value = res.smiles;
    matDrawOpen.value = false;
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    matDrawBusy.value = false;
  }
}

/**
 * 输入的**行内**校验提示（空串 = 没问题）。
 *
 * 防抖 600ms 后用前端 RDKit 解析一次：坏结构在回车**之前**就标红 ——
 * 原来只有点了「添加」才弹 ElMessage，敲半天才知道从头就是错的。
 * CDXML 之类要走后端的格式**不在这里校验**（不在浏览器引擎能力内，留着让
 * addMaterial 走完整链路），所以只对本地可判的输入给提示。
 */
const materialIssue = ref('');
let materialCheckTimer: ReturnType<typeof setTimeout> | null = null;
watch(materialInput, (raw) => {
  if (materialCheckTimer) clearTimeout(materialCheckTimer);
  const text = raw.trim();
  if (!text || needsBackendParse(text) || !isRdkitReady()) {
    materialIssue.value = '';
    return;
  }
  materialCheckTimer = setTimeout(async () => {
    const res = await parseStructure(text);
    // await 期间输入可能已变：只对"还是这一份输入"的结果负责
    if (materialInput.value.trim() !== text) return;
    materialIssue.value = res.ok ? '' : res.reasons?.[0] || res.error || '这个结构认不出来';
  }, 600);
});

// ---------- 采购询价（查价用哪家 + 用什么标识） ----------
// 这里存的是**默认值**：路线图卡片、逆合成树标签行、候选面板三处询价入口都读它，
// 但每一处都能当场改选别家（那种改选是"这次换一家看看"，不回写默认 —— 见 settings store）。

const supplierName = (list: Supplier[]): string => list.map((s) => s.name).join(' / ');
/** 按 CAS / 货号建索引的平台：URL 带 CAS 能直接搜到 */
const casSuppliers = computed(() => supplierName(SUPPLIERS.filter((s) => s.prefers === 'cas')));
/** 结构式 / 列表检索的平台：认 SMILES，CAS 只是普通关键词 */
const smilesSuppliers = computed(() => supplierName(SUPPLIERS.filter((s) => s.prefers === 'smiles')));
const defaultSupplierName = computed(() => supplierById(settings.supplierId)?.name ?? '—');

onMounted(() => {
  if (!store.models.length) void store.loadModels();
  void loadSettings(); // API 设置草稿（后端 llm_settings.json 的脱敏回显）
  void loadLlmSource(); // 大模型来源偏好 + 官方清单（走 Node 中转时）
});
</script>

<template>
  <section class="rw-card params" :class="{ 'params--embedded': embedded }">
    <div v-if="!embedded" class="rw-card__head">
      <div class="rw-card__title">运行参数</div>
      <el-tag v-if="store.autoRunning" type="warning" size="small" effect="dark">运行中</el-tag>
    </div>

    <div class="rw-card__body params__body">
      <!-- 嵌入模式：面板标题行已经在跑，这里补一个运行中角标就够 -->
      <div v-if="embedded && store.autoRunning" class="params__flag">
        <el-tag type="warning" size="small" effect="dark">自动拆分运行中</el-tag>
      </div>

      <!-- 分组一：预测设置（最常改的两个） -->
      <details class="params__group" open>
        <!-- 🔴 这组的标题**必须**叫「预测设置」而不能跟卡片头的「运行参数」同名：
             标定卡片里卡片头已有一行「运行参数」，同名就是两行一样的字叠着
             （组件头部注释记着这个坑）。 -->
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 4.5 6 8l-3 3.5M8 4.5 11 8l-3 3.5" />
            </svg>
            预测设置
          </span>
          <span class="params__group-meta">{{ store.params.model }}</span>
        </summary>
        <div class="params__group-body">
          <div class="params__row">
            <label>预测模型</label>
            <div class="params__model">
              <el-select
                v-model="store.params.model"
                size="small"
                :loading="store.modelsLoading"
                @visible-change="onModelSelectVisible"
                @change="(v: unknown) => void onModelChange(String(v))"
              >
                <el-option
                  v-for="m in store.models"
                  :key="m.key"
                  :label="`${m.label}（${MODEL_STATE_TEXT[m.state]}）`"
                  :value="m.key"
                  :disabled="m.state === 'unavailable'"
                />
              </el-select>
              <el-button
                v-if="MODEL_CONTROL_ENABLED"
                size="small"
                :type="store.modelReady || store.modelBusy ? 'default' : 'primary'"
                :loading="
                  store.modelLoadingKey !== null ||
                  store.modelStopping ||
                  store.currentModel?.state === 'loading'
                "
                :disabled="!store.modelReady && !store.modelBusy && !canLoadModel"
                @click="onModelAction"
              >
                {{ modelActionText }}
              </el-button>
            </div>
          </div>

          <!-- 状态行：这是「模型什么时候能用」的唯一答案 —— 必须脱离灰色小字 -->
          <div class="params__model-state">
            <el-tag :type="modelTagType" size="small" :effect="store.modelBusy ? 'dark' : 'light'">
              {{ modelStatusText }}
            </el-tag>
            <span class="params__model-detail">{{ modelDetail }}</span>
          </div>

          <!-- 加载进度条：后端给了 progress 才画（老后端回落成上面的阶段文案+秒数）。
               只在「当前选中的模型正在加载」时出现 —— 加载别的模型不该在这里画条。 -->
          <el-progress
            v-if="modelProgress !== null"
            :percentage="modelProgress"
            :stroke-width="6"
            :show-text="true"
            class="params__model-progress"
          />

          <!-- 状态矩阵：每个模型各一格状态（只有一个模型时没有"矩阵"可言，不渲染） -->
          <div v-if="store.models.length > 1" class="params__model-matrix">
            <span
              v-for="m in store.models"
              :key="m.key"
              class="params__model-chip"
              :class="[`is-${m.state}`, { 'is-current': m.key === store.params.model }]"
              :title="`${m.label}（${MODEL_STATE_TEXT[m.state]}）`"
            >
              <i class="params__model-dot" />
              {{ shortLabel(m.label) }}
              <em>{{ MODEL_STATE_TEXT[m.state] }}</em>
            </span>
          </div>

          <!-- 可行性过滤（正向模型）：开关 + 判别器的加载/状态**同框**。
               🔴 开关已开着时**不做 disabled**：否则正向模型一旦不可用，
                  用户连关都关不掉。`:disabled` 只拦「从关到开」。 -->
          <div class="params__row params__row--col params__fwd">
            <div class="params__fwd-head">
              <label>
                可行性过滤
                <el-tooltip
                  content="逆向模型爱给幻觉前体（化学上根本走不通的前体组合），它们会白白吃掉调用预算。开启后每条候选反应都要用正向模型『前体 → 产物』复核一次，只有产物命中正向 top-k 的才保留。只在多步拆分时生效"
                  placement="top"
                >
                  <span class="params__hint">?</span>
                </el-tooltip>
              </label>
              <el-switch
                v-model="store.params.forwardFilter"
                size="small"
                :disabled="!store.canUseForwardFilter && !store.params.forwardFilter"
              />
            </div>

            <!-- 判别器（正向模型）的加载/状态：紧跟开关，开不了的人不用跳组找原因 -->
            <div class="params__fwd-line">
              <el-tag size="small" :type="fwdTagType" effect="light">{{ fwdStateText }}</el-tag>
              <span class="params__fwd-name">正向模型</span>
              <el-button
                v-if="showForwardLoad"
                size="small"
                text
                type="primary"
                :loading="store.forwardLoadingKey !== null || store.forwardBusy"
                @click="void store.loadForward()"
              >
                {{ store.forwardBusy ? '加载中' : '加载' }}
              </el-button>
            </div>
            <span class="params__model-detail">{{ fwdDetail }}</span>

            <div v-if="store.params.forwardFilter" class="params__row">
              <label>
                候选保留 Top-K
                <el-tooltip
                  content="正向模型只保留排名前 K 的产物。K 越小过滤越狠（误杀真反应的几率也越大）：5 是官方评测常用值，1 会砍掉大量可行路线"
                  placement="top"
                >
                  <span class="params__hint">?</span>
                </el-tooltip>
              </label>
              <el-input-number v-model="store.params.forwardTopK" :min="1" :max="50" size="small" />
            </div>
          </div>

          <div class="params__row">
            <label>每步候选数</label>
            <el-input-number v-model="store.params.numResults" :min="1" :max="20" size="small" />
          </div>
        </div>
      </details>

      <!-- 分组二：拆分约束（**只在多步拆分时用得上**，默认收起） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 3h12M2 8h12M2 13h8" />
            </svg>
            拆分约束
            <span class="params__scope-tag">多步拆分</span>
          </span>
          <span class="params__group-meta">{{ constraintMeta }}</span>
        </summary>
        <div class="params__group-body">
          <!-- 🔴 这一句原来铺了三行小字，读完才明白"手动展开不受约束"。
             改成两行、并且把「不受限制」提前（用户真正要确认的是这件事）。 -->
          <p class="params__note">
            <strong>仅自动往下拆时生效</strong>；手动单步「展开 / 采纳候选」不受这些限制。
          </p>

          <!-- 搜索算法放**第一位**：它决定后面「深度/预算」花得值不值 ——
               同样的预算，Retro* 用价值函数挑着拆能往深里走，BFS 逐层铺开则摊得更开。 -->
          <div class="params__row">
            <label>
              搜索算法
              <el-tooltip placement="top">
                <template #content>
                  Retro*：按「剩余步数估计 + 反应代价」挑最有希望的节点先拆 —— 同等预算下走得更深。<br />
                  广度优先 BFS：不做取舍、逐层铺开 —— 覆盖最全，但预算吃得凶，跑同样深度要给足调用次数。
                </template>
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <el-select v-model="store.params.searchAlgorithm" size="small">
              <el-option
                v-for="(meta, key) in SEARCH_ALGORITHMS"
                :key="key"
                :label="meta.label"
                :value="key"
              >
                <span>{{ meta.label }}</span>
                <span class="params__alg-note">{{ meta.note }}</span>
              </el-option>
            </el-select>
          </div>

          <div class="params__row">
            <label>自动拆分最大深度</label>
            <el-input-number v-model="store.params.maxDepth" :min="1" :max="8" size="small" />
          </div>

          <div class="params__row">
            <label>
              可购买重原子阈值
              <el-tooltip content="重原子数 ≤ 该值即视为起始物料并停止往下拆" placement="top">
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <el-input-number v-model="store.params.heavyAtomThreshold" :min="1" :max="40" size="small" />
          </div>

          <div class="params__row">
            <label>调用预算（次）</label>
            <el-input-number v-model="store.params.budgetCalls" :min="1" :max="200" size="small" />
          </div>

          <!-- 额外可购买原料：填了的分子视为「买得到」，搜索拆到它就停。
               🔴 与上面的重原子阈值是「**或**」关系 —— 空态要说清默认行为，
                  否则用户不知道不填时靠什么判定。 -->
          <div class="params__row params__row--col params__mat">
            <label>
              额外可购买原料
              <el-tooltip
                content="列表里的分子视为买得到：搜索拆到它就停止继续往下。与左侧「可购买重原子阈值」是『或』关系 —— 命中任意一条即停。适合填你手头有的原料、或想让路线优先经过的中间体"
                placement="top"
              >
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>

            <div class="params__materials">
              <el-input
                v-model="materialInput"
                size="small"
                placeholder="粘贴 SMILES / MOL / 结构文本，回车添加"
                spellcheck="false"
                @keyup.enter="addMaterial"
              />
              <el-button size="small" :loading="addingMaterial" @click="addMaterial">添加</el-button>
              <el-button size="small" plain @click="openMatDraw">绘制</el-button>
            </div>
            <p v-if="materialIssue" class="params__mat-issue">{{ materialIssue }}</p>

            <!-- 有内容才渲染列表；每一项带结构缩略图 —— 裸 SMILES 截断没法认分子 -->
            <div v-if="store.params.startingMaterials.length" class="params__mat-list">
              <div v-for="s in store.params.startingMaterials" :key="s" class="params__mat-item">
                <span class="params__mat-mol">
                  <MolView :smiles="s" fit :bond-px="14" :min-px="26" :max-px="120" />
                </span>
                <span class="params__mat-meta">
                  <span class="params__mat-formula">{{ countHeavyAtoms(s) }} 重原子</span>
                  <code class="rw-mono" :title="s">{{ s.length > 18 ? s.slice(0, 18) + '…' : s }}</code>
                </span>
                <button type="button" class="params__mat-del" title="移除" @click="removeMaterial(s)">
                  ×
                </button>
              </div>
            </div>
            <p v-else class="params__mat-empty">
              不填时：重原子数 ≤ {{ store.params.heavyAtomThreshold }} 的分子视为可购买。
            </p>
          </div>
        </div>
      </details>

      <!-- 分组三：大模型设置（状态 + 接口地址 / 模型 / token / 多 Key 轮换，合并成一组） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5a3 3 0 0 0-3 3c0 1.2.7 2.3 1.7 2.8L5 13.5h6L9.3 7.3A3 3 0 0 0 11 4.5a3 3 0 0 0-3-3Z" />
            </svg>
            大模型设置
          </span>
          <el-tag size="small" :type="llmTagType" effect="light" class="params__group-tag">
            {{ llmTagText }}
          </el-tag>
        </summary>
        <div class="params__group-body">
          <!-- 大模型状态：当前 key 与模型是否可用 + 真发一次最小请求验证 -->
          <div class="params__row">
            <label>
              大模型状态
              <el-tooltip
                content="在「每步流程」里让大模型给出投料顺序、当量、条件、副产物、LCMS/NMR。接口地址 / 模型 / API Key 在下面的「端点配置」里成组管理"
                placement="top"
              >
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <div class="params__llm">
              <el-tooltip :content="llmTooltip" placement="top" :show-after="200">
                <el-tag size="small" :type="llmTagType" effect="light">{{ llmTagText }}</el-tag>
              </el-tooltip>
              <el-button size="small" text :loading="probing" @click="verifyLlm">
                {{ probing ? '验证中' : '验证' }}
              </el-button>
            </div>
          </div>

          <!-- 大模型来源：官方 / 自建（走 Node 中转时才出现） -->
          <div v-if="showSourcePicker" class="params__row params__row--col">
            <div class="params__modules-head">
              <label>
                大模型来源
                <el-tooltip
                  content="「官方模型」由系统提供算力，你只需选模型、看配额，看不到任何密钥；「自建配置」用你自己的接口地址 + API Key。选择存在服务端，跨设备生效"
                  placement="top"
                >
                  <span class="params__hint">?</span>
                </el-tooltip>
              </label>
            </div>
            <div class="params__source" v-loading="loadingSource">
              <el-radio-group
                :model-value="llmSource"
                size="small"
                :disabled="sourceSwitching"
                @change="(v: unknown) => void switchSource(String(v) as LlmSource)"
              >
                <el-radio-button value="user">自建配置</el-radio-button>
                <el-radio-button value="official" :disabled="!officialAvailable">
                  官方模型
                </el-radio-button>
              </el-radio-group>

              <!-- 官方模型清单：只展示 name/model/quota（token 数量与值永不出后端） -->
              <div v-if="llmSource === 'official'" class="params__official">
                <div
                  v-for="m in officialModels"
                  :key="m.id"
                  class="params__official-item"
                  :class="{ 'is-disabled': !m.enabled }"
                >
                  <span class="params__official-name">{{ m.name }}</span>
                  <span class="params__official-model">{{ m.model }}</span>
                  <el-tag v-if="m.enabled" size="small" type="success" effect="plain">
                    配额 {{ m.quota }}
                  </el-tag>
                  <el-tag v-else size="small" type="info" effect="plain">暂未启用</el-tag>
                </div>
                <p v-if="!officialModels.length" class="params__modules-note">
                  暂无可用官方模型（后端未配置或未启用）。
                </p>
                <p class="params__modules-note">
                  官方模型由系统提供，密钥托管在服务端，此处只显示模型与剩余配额。
                </p>
              </div>
            </div>
          </div>

          <!-- 端点配置：接口地址 / 模型 / API Key 绑定成一套，可存多套（DeepSeek / MiMo…）切换 -->
          <div class="params__row params__row--col">
            <div class="params__modules-head">
              <label>
                端点配置
                <el-tooltip
                  content="接口地址、模型、API Key 是一套绑定的：换供应商就切整套，不用挨个字段改（漏改一处就是「看着配好了、一调就 401/404」）。保存在后端 web/llm_settings.json，改完立即生效。同一套里可放多个 API Key，请求失败时自动切换下一个"
                  placement="top"
                >
                  <span class="params__hint">?</span>
                </el-tooltip>
              </label>
              <!-- 「刷新」= 只重读配置与 key 状态（不真打大模型，那要留给「验证」）：
                   在别处改过 .env / 后端重启过 / 另一个标签页存过配置，点这里就能对上 -->
              <el-button size="small" text :loading="refreshing" @click="reloadSettings">刷新</el-button>
            </div>
            <div class="params__api">
              <!-- 🔴 用 :model-value 而不是 v-model：选中要等后端真的切完才算数。
                   切换失败时下拉必须能显示回原来那套，否则界面会停在一个并没有生效的选项上。 -->
              <div class="params__prof-bar">
                <el-select
                  :model-value="editingId"
                  class="params__prof-select"
                  size="small"
                  :loading="switching"
                  placeholder="选择端点配置"
                  @change="(v: unknown) => void switchProfile(String(v))"
                >
                  <el-option v-for="p in profiles" :key="p.id" :label="p.name" :value="p.id">
                    <span class="params__prof-opt">
                      <span class="params__prof-opt-name">{{ p.name }}</span>
                      <span class="params__prof-opt-meta">{{ p.model || '未填模型' }} · {{ p.keys.length }} key</span>
                    </span>
                  </el-option>
                </el-select>
              </div>
              <!-- 🔴 三个操作按钮**另起一行**：跟下拉挤同一行时，240px 侧栏里下拉只剩几十像素，
                   配置名被截成「T…」（实测）。下拉独占一行才有宽度把名字显示全。 -->
              <div class="params__prof-ops">
                <el-button size="small" @click="addProfile">新建</el-button>
                <el-button size="small" :disabled="!cur" @click="dupProfile">复制</el-button>
                <el-button size="small" type="danger" plain :disabled="!cur" @click="delProfile">删除</el-button>
              </div>

              <template v-if="cur">
                <div class="params__api-field">
                  <span class="params__api-label">名称</span>
                  <el-input
                    v-model="cur.name"
                    size="small"
                    placeholder="给你自己看的标签：DeepSeek 官方 / MiMo 备用…"
                    clearable
                  />
                </div>
                <div class="params__api-field">
                  <span class="params__api-label">接口地址（OpenAI 兼容）</span>
                  <el-input
                    v-model="cur.base_url"
                    size="small"
                    placeholder="https://api.example.com/v1"
                    clearable
                  />
                </div>
                <div class="params__api-field">
                  <span class="params__api-label">
                    模型
                    <el-tooltip
                      content="「拉取」列出这套配置的 Key 可见的模型（列表 ≠ 套餐内都可用）；也可直接输入自定义模型名"
                      placement="top"
                    >
                      <span class="params__hint">?</span>
                    </el-tooltip>
                  </span>
                  <div class="params__api-model">
                    <el-select
                      v-model="cur.model"
                      size="small"
                      filterable
                      allow-create
                      default-first-option
                      placeholder="选择或输入模型名"
                      @visible-change="onModelDropdown"
                    >
                      <el-option v-for="mname in modelOptions" :key="mname" :label="mname" :value="mname" />
                    </el-select>
                    <el-button size="small" :loading="loadingModels" @click="refreshModels">拉取</el-button>
                  </div>
                </div>
                <div class="params__api-grid">
                  <div class="params__api-field">
                    <span class="params__api-label">
                      输出上限
                      <el-tooltip content="max_tokens（发给模型的输出额度）。推理模型的思考 token 也计入这个额度，太小会被截断（正文 0 字符）。勾「无限制」= 不传该字段，交给模型/网关默认值" placement="top">
                        <span class="params__hint">?</span>
                      </el-tooltip>
                    </span>
                    <div class="params__tokens">
                      <el-checkbox
                        :model-value="!cur.max_tokens"
                        size="small"
                        @change="onUnlimitedTokens"
                      >
                        无限制
                      </el-checkbox>
                      <el-input-number
                        v-model="cur.max_tokens"
                        size="small"
                        :min="0"
                        :max="1000000"
                        :step="1024"
                        :controls="false"
                        :disabled="!cur.max_tokens"
                        placeholder="无限制"
                      />
                    </div>
                  </div>
                  <div class="params__api-field">
                    <span class="params__api-label">温度</span>
                    <el-input-number
                      v-model="cur.temperature"
                      size="small"
                      :min="0"
                      :max="2"
                      :step="0.1"
                      :controls="false"
                    />
                  </div>
                  <div class="params__api-field">
                    <span class="params__api-label">超时(秒)</span>
                    <el-input-number
                      v-model="cur.timeout"
                      size="small"
                      :min="10"
                      :max="3600"
                      :step="10"
                      :controls="false"
                    />
                  </div>
                </div>
                <div class="params__api-field">
                  <span class="params__api-label">API Keys（{{ cur.keys.length }}）</span>
                  <div v-if="cur.keys.length" class="params__keys">
                    <div
                      v-for="(k, i) in cur.keys"
                      :key="k + i"
                      class="params__key"
                      :class="{ 'is-env': keySourceOf(k) === 'env' }"
                    >
                      <span class="params__key-no">{{ i + 1 }}</span>
                      <code class="params__key-mask" :title="k">{{ k }}</code>
                      <el-tag v-if="!k.includes('*')" size="small" effect="plain" type="info">未保存</el-tag>
                      <el-tooltip
                        v-else-if="keyStateOf(k)?.reason && keyStateOf(k)?.state !== 'active'"
                        :content="keyStateOf(k)?.reason"
                        placement="top"
                        :show-after="150"
                      >
                        <el-tag size="small" effect="light" :type="keyTagType(keyStateOf(k))">
                          {{ keyTagText(keyStateOf(k)) }}
                        </el-tag>
                      </el-tooltip>
                      <el-tag v-else size="small" effect="light" :type="keyTagType(keyStateOf(k))">
                        {{ keyTagText(keyStateOf(k)) }}
                      </el-tag>
                      <!-- 🔴 `.env` 那把**不给删除按钮**：它是后端的回落默认值，删了下次刷新还在
                           —— 留着按钮就是「看着能删、其实删不掉」。改为标出来源 + 说明怎么处理。
                           🔴 标记只写 `.env` 两个字符：写成「来自 .env」会把这行的脱敏串挤成
                           `sk-L7w15****WD…`，而**尾部 4 位正是区分两把 key 的唯一信息** ——
                           标签的详细说明放 tooltip，别跟 key 抢宽度。 -->
                      <el-tooltip
                        v-if="keySourceOf(k) === 'env'"
                        content="这把 Key 来自后端 web/.env 的回落配置：运行时会用它，但不能在这里删除（改 .env 才生效）。想把它固定进本配置，点「保存设置」即可；想换成别的，在下面添加新 Key 并保存。"
                        placement="top"
                        :show-after="150"
                      >
                        <el-tag size="small" effect="plain" type="warning">.env</el-tag>
                      </el-tooltip>
                      <el-button v-else size="small" text type="danger" @click="removeKey(i)">删除</el-button>
                    </div>
                  </div>
                  <div class="params__key-add">
                    <el-input
                      v-model="newKey"
                      size="small"
                      placeholder="粘贴新的 API Key（sk-…），可添加多个"
                      clearable
                      @keyup.enter="addKey"
                    />
                    <el-button size="small" :disabled="!newKey.trim()" @click="addKey">添加</el-button>
                  </div>
                  <p class="params__modules-note">
                    多 Key 自动轮换：同一套里请求失败（Key 失效 / 限流 / 额度不足）自动切换下一个；限流的 Key 冷却 60s 后自动恢复。
                    <b>每套配置各有一份独立轮换状态</b>，切换端点不会互相影响。
                  </p>
                </div>
              </template>
              <el-alert
                v-else
                type="info"
                :closable="false"
                class="params__prof-empty"
                title="还没有端点配置 —— 点上面的「新建」加一套（接口地址 / 模型 / API Key）"
                description="不配置也能用：后端会回落到 web/.env 里的 RETRO_LLM_* 默认值。"
              />

              <div class="params__api-actions">
                <el-button
                  type="primary"
                  size="small"
                  :loading="savingSettings"
                  :disabled="!profiles.length"
                  @click="saveSettings(false)"
                >
                  保存设置
                </el-button>
                <el-button size="small" :disabled="!hasDisabledKey" @click="resetKeys">重试失效 Key</el-button>
                <span v-if="dirty" class="params__dirty">有未保存的改动</span>
              </div>
            </div>
          </div>
        </div>
      </details>

      <!-- 分组四：条件方案（工艺分析的前置步骤：先列候选条件，选定后再深入分析） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 4h11M2.5 8h6M2.5 12h9" />
              <circle cx="12.5" cy="8" r="1.7" />
            </svg>
            条件方案
            <el-tooltip
              content="反应条件（溶剂 / 温度 / 碱与缩合剂 / 浓度 / 投料方式）本就是组合空间：先把可行的几套列出来，挑一套再深入分析，比一次只给一套更接近实际筛选流程。"
              placement="top"
            >
              <span class="params__hint">?</span>
            </el-tooltip>
          </span>
          <span class="params__group-meta">
            {{ store.condPlanFirst ? `先列候选 · ${store.condOptionCount} 套` : '直接分析' }}
          </span>
        </summary>
        <div class="params__group-body">
          <div class="params__row">
            <label>先列候选条件</label>
            <el-switch v-model="store.condPlanFirst" size="small" />
          </div>
          <div class="params__row">
            <label>候选方案数</label>
            <el-input-number
              v-model="store.condOptionCount"
              :min="2"
              :max="6"
              size="small"
              :disabled="!store.condPlanFirst"
            />
          </div>
          <p class="params__modules-note">
            开启后先列出这一步的多套条件方案（溶剂 / 温度 / 碱各成一派），
            选一套再深入分析，分析会<b>锁定</b>这套条件。
            关闭 = 直接给一套条件；面板里仍可随时手动「列出候选条件」。
          </p>
        </div>
      </details>

      <!-- 分组五：分析模块（芯片式多选：选中=品牌色卡片）
           🔴 标题行只留「图标 + 分析模块 + ? + chevron」，计数与「全选/清空」一起下移到
           **芯片正上方的工具条**（左=计数，右=操作）。
           根因：320px 侧栏下标题行的可用宽只有 ~294px，而标题自身要 97.8px、
           右侧「已选 N / M + 全选 + 清空」要 169.7px，合计 293.5px —— **只剩 0.5px 余量**。
           于是计数从 9/9 变成 10/10（+12px）就溢出；而「分析模块」是**可收缩的 flex 项**，
           中文的 min-content 只有 1 个字 ⇒ 被压成一列竖排，表头从 40px 撑到 60px。
           下移后标题行只需 ~124px，彻底离开刀刃；工具条整行 294px 给两个按钮绰绰有余。 -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
              <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
              <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
            </svg>
            分析模块
            <el-tooltip
              content="只让大模型生成勾选维度的内容，省 token 也更聚焦。LCMS 的 m/z 数值始终由 RDKit 计算，不受此影响。"
              placement="top"
            >
              <span class="params__hint">?</span>
            </el-tooltip>
          </span>
        </summary>
        <div class="params__group-body">
          <!-- 工具条：左「已选 N / M」右「全选 / 清空」—— 两者都作用于下面的芯片，
               放同一行左右对称、不再有一大片空白，也不跟标题抢宽度 -->
          <div class="params__modules-bar">
            <span class="params__group-meta">已选 {{ modules.length }} / {{ ALL_ANALYSIS_MODULES.length }}</span>
            <span class="params__modules-summary">
              <el-button size="small" text type="primary" :disabled="allSelected" @click="selectAllModules">全选</el-button>
              <el-button size="small" text :disabled="!modules.length" @click="clearModules">清空</el-button>
            </span>
          </div>
          <div class="params__modules">
            <button
              v-for="opt in moduleOptions"
              :key="opt.key"
              type="button"
              class="params__chip"
              :class="{ 'is-on': modules.includes(opt.key) }"
              :aria-pressed="modules.includes(opt.key)"
              @click="toggleModule(opt.key, !modules.includes(opt.key))"
            >
              <span class="params__chip-check" aria-hidden="true">
                <svg viewBox="0 0 10 8"><path d="M1 4l2.6 2.6L9 1.2" /></svg>
              </span>
              {{ opt.label }}
            </button>
          </div>
          <p class="params__modules-note">「总述 + 反应类型」始终保留，不受勾选影响。</p>
        </div>
      </details>

      <!-- 分组六：采购询价（查价默认用哪家 + 拿什么标识去查） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M1.5 2.5h2l1.6 7.3a1.4 1.4 0 0 0 1.4 1.1h5.2a1.4 1.4 0 0 0 1.4-1.1L14.5 4.5H4" />
              <circle cx="6.6" cy="13.3" r="1" />
              <circle cx="11.9" cy="13.3" r="1" />
            </svg>
            采购询价
          </span>
          <span class="params__group-meta">{{ defaultSupplierName }}</span>
        </summary>
        <div class="params__group-body">
          <div class="params__row">
            <label>
              默认供应商
              <el-tooltip
                content="查价时默认跳到哪一家。路线图卡片 / 逆合成树 / 候选面板的询价入口都按它预选，但每处都能当场改选别家（那不会改掉这个默认）"
                placement="top"
              >
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <el-select v-model="settings.supplierId" size="small" class="params__sup-select">
              <el-option v-for="s in SUPPLIERS" :key="s.id" :label="s.name" :value="s.id">
                <span class="params__sup-opt">
                  <span class="params__sup-opt-name">{{ s.name }}</span>
                  <span class="params__sup-opt-tag">{{ s.tag }}</span>
                </span>
              </el-option>
            </el-select>
          </div>

          <div class="params__row">
            <label>
              优先用 CAS 号查询
              <el-tooltip
                content="试剂商的目录按 CAS 号 / 货号建索引，用 CAS 能直接搜到；SMILES 在它们那儿只是一串没人认识的字符。关掉后改用 SMILES（结构式检索平台本来就不受这个开关影响）"
                placement="top"
              >
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <el-switch v-model="settings.supplierPreferCas" size="small" />
          </div>

          <p class="params__modules-note">
            标识取决于平台<b>怎么建索引</b>：<b>{{ casSuppliers }}</b>按 CAS / 货号检索，
            <b>{{ smilesSuppliers }}</b>走结构式检索（它们只认 SMILES，CAS 在那儿只是关键词）。
            标识会一并复制到剪贴板，到站粘进搜索框即可。<br />
            CAS 来自 PubChem、本地缓存：首次展开询价菜单时查一次，查不到就回落 SMILES，不堵住查价。
          </p>
        </div>
      </details>
    </div>

    <!-- 手动画原料：Ketcher 画板。画完 RDKit 校验 → 加入「额外可购买原料」列表。
         🔴 `append-to-body` 必须给：本组件渲染在「运行设置」el-dialog 内容里，
            不传送出去的话，画板的 overlay 会留在设置弹窗的 DOM 链内 ——
            设置弹窗关掉后守门脚本按 `.app__run-settings-dialog .el-overlay` 数 overlay
            仍会命中它（实测 count=1 ⇒ 误报"弹窗没关"）。teleport 到 body 即脱离；
            scoped 样式不受影响（el-dialog 根元素自带本组件的 scope id）。 -->
    <el-dialog
      v-model="matDrawOpen"
      title="绘制原料结构"
      width="min(1180px, 94vw)"
      align-center
      :close-on-click-modal="false"
      append-to-body
      class="params__mat-dialog"
    >
      <StructureEditor ref="matDrawRef" />
      <el-alert v-if="matDrawError" type="error" :closable="false" class="params__mat-draw-err">
        {{ matDrawError }}
      </el-alert>
      <template #footer>
        <el-button @click="matDrawOpen = false">取消</el-button>
        <el-button type="primary" :loading="matDrawBusy" @click="confirmMatDraw">
          用这个结构
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.params__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 嵌入右辅助面板：去掉自己那层卡壳（外框与标题都归 AsidePanel） */
.params--embedded.rw-card {
  border: 0;
  box-shadow: none;
  background: transparent;
}

.params--embedded .params__body {
  padding: 0;
}

.params__flag {
  display: flex;
}

/* ---------- 可折叠分组 ----------
   用原生 <details>：无 JS、无额外依赖、自带键盘可达性（Tab + Enter 开合）。
   只在视觉上重做 summary（去掉默认三角，换成右侧会旋转的 chevron）。 */
.params__group {
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface-2);
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.params__group[open] {
  border-color: var(--rw-border-strong);
  box-shadow: var(--rw-shadow-1);
}

.params__group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background 0.15s;
  position: relative;
}

.params__group-head::-webkit-details-marker {
  display: none;
}

.params__group-head:hover {
  background: var(--rw-surface-3);
}

.params__group-title {
  display: flex;
  align-items: center;
  gap: 7px;
  /* 🔴 不参与收缩 + 不换行。
     作为 flex 项它的 min-width 默认是 auto，而中文的 min-content 只有**一个字**
     ⇒ 右侧一宽就被压成一列竖排（实测 320px 侧栏下「分析模块」被压成 2 行、
     表头从 40px 撑到 60px）。这里让标题永远占满它需要的宽度，
     把「让位」的责任交给右侧的 .params__group-meta（它可收缩、可打省略号）。 */
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
  letter-spacing: 0.2px;
}

.params__group-ico {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: none;
  stroke: var(--rw-brand);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.9;
}

/* 右侧 chevron（替代 title 前的字符三角，位置固定不随文字移动） */
.params__group-head::after {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  margin-left: auto;
  border-right: 1.5px solid var(--rw-text-3);
  border-bottom: 1.5px solid var(--rw-text-3);
  transform: rotate(45deg);
  transform-origin: center;
  transition: transform 0.18s ease, border-color 0.18s ease;
}

.params__group[open] > .params__group-head::after {
  transform: rotate(-135deg);
  border-color: var(--rw-brand);
}

.params__group-meta {
  font-size: 11.5px;
  color: var(--rw-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
  /* 🔴 光有 overflow:hidden 缩不动：flex 项的 min-width:auto 会被解析成内容宽度，
     而这里 white-space:nowrap ⇒ min-content = 整行文字宽度，于是被挤压的只会是标题。
     补 min-width:0 才真的「先缩、再打省略号」。 */
  min-width: 0;
}

.params__group-tag {
  flex-shrink: 0;
}

.params__group-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid var(--rw-border);
  background: var(--rw-surface);
}

.params__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.params__row--col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.params__row > label {
  font-size: 12.5px;
  color: var(--rw-text-2);
  font-weight: 500;
  white-space: nowrap;
  letter-spacing: 0.2px;
}

.params__model {
  display: flex;
  gap: 6px;
}

/* 下拉吃掉剩余宽度，按钮**禁止收缩** —— 收缩时「停止」两个字会被裁掉
   （实测：弹窗窄栏里按钮只剩一半）。 */
.params__model :deep(.el-select) {
  flex: 1 1 auto;
  min-width: 0;
}

.params__model > .el-button {
  flex: 0 0 auto;
}

/* ---------- 预测模型：状态行 + 状态矩阵 ---------- */
/* 状态行是「模型什么时候能用」的主指标 ⇒ 独立成行、不能塞进灰色小字里 */
.params__model-state {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: -2px;
}

.params__model-state :deep(.el-tag) {
  flex: 0 0 auto;
}

.params__model-detail {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--rw-text-3);
  word-break: break-word;
  padding-top: 1px;
}

/* 加载进度条：紧贴状态行下方，占满这一行，别和下面的状态矩阵/参数挤在一起 */
.params__model-progress {
  margin-top: 8px;
}

.params__model-progress :deep(.el-progress__text) {
  font-size: 11px;
  min-width: 32px;
  color: var(--rw-text-2);
}

/* 矩阵：一个模型一格。横排 + 允许换行（禁竖排 —— 竖排两行格子会跟右栏其他行对不齐） */
.params__model-matrix {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.params__model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  background: var(--rw-surface-2);
  font-size: 11px;
  line-height: 1.5;
  color: var(--rw-text-2);
  white-space: nowrap;
}

/* 当前选中的那格：描边用品牌色（不靠"更亮"来区分，深色皮肤下亮不起来） */
.params__model-chip.is-current {
  border-color: var(--rw-brand);
  color: var(--rw-text);
}

.params__model-chip em {
  font-style: normal;
  font-size: 10px;
  color: var(--rw-text-3);
}

.params__model-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rw-text-3);
}

/* 状态色：只改小圆点，不改底色 —— chip 底色一变，整块重量就压过了模型名 */
.params__model-chip.is-ready .params__model-dot {
  background: var(--rw-ok);
}

.params__model-chip.is-loading .params__model-dot {
  background: var(--rw-warn);
}

.params__model-chip.is-failed .params__model-dot {
  background: var(--rw-bad);
}

.params__model-chip.is-unavailable {
  opacity: 0.65;
}

/* ---------- 可行性过滤（正向模型） ---------- */
/* 开关跟标题同行（右对齐），状态标签与加载按钮在下一行、说明文字再下一行。
   竖排而不是横排：320px 侧栏里「标签 + 按钮 + 一段说明」横着放会把说明压成
   一个字一行的竖条（本项目在标题行上踩过同一个坑，见「分析模块」注释）。 */
.params__fwd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.params__fwd-head > label {
  font-size: 12.5px;
  color: var(--rw-text-2);
  font-weight: 500;
  white-space: nowrap;
  letter-spacing: 0.2px;
}

/* 可行性过滤卡（预测设置组里）：开关 + 判别器加载/状态 + Top-K 同框 */
.params__fwd {
  padding: 10px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.params__fwd .params__model-detail {
  padding-left: 2px;
}

/* 状态 tag + 「正向模型」名 + 加载按钮同行 */
.params__fwd-line {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.params__fwd-line > * {
  flex: 0 0 auto;
}

.params__fwd-name {
  font-size: 12px;
  color: var(--rw-text-2);
  font-weight: 500;
}

.params__llm {
  display: flex;
  align-items: center;
  gap: 4px;
}

.params__hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 3px;
  border-radius: 50%;
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 10px;
  line-height: 1;
  cursor: help;
  transition: background 0.15s, color 0.15s;
}

.params__hint:hover {
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
}

/* 下拉项右侧的一句算法说明 —— 拉开左边的名字，别让用户把描述读成选项名的一部分 */
.params__alg-note {
  float: right;
  margin-left: 16px;
  color: var(--rw-text-3);
  font-size: 11px;
}

/* 统一输入控件聚焦态：品牌色描边 + 柔和外发光（穿透 scoped 到 EP 内部） */
.params__row :deep(.el-input__wrapper),
.params__row :deep(.el-select__wrapper),
.params__row :deep(.el-input-number) {
  transition: box-shadow 0.15s;
}

.params__row :deep(.el-input__wrapper.is-focus),
.params__row :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--rw-brand) inset;
}

/* ---------- 大模型来源选择 ---------- */
.params__source {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.params__source :deep(.el-radio-group) {
  align-self: flex-start;
}

.params__official {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.params__official-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

.params__official-item.is-disabled {
  opacity: 0.6;
}

.params__official-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--rw-text);
  flex: 0 0 auto;
}

.params__official-model {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--rw-text-3);
}

/* ---------- API 设置（接口地址 / 模型 / token / 多 Key） ---------- */
.params__api {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface-2);
}

.params__api-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.params__api-label {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: var(--rw-text-3);
  letter-spacing: 0.2px;
}

.params__api-model {
  display: flex;
  gap: 6px;
}

.params__api-model :deep(.el-select) {
  flex: 1;
  min-width: 0;
}

.params__api-grid {
  display: grid;
  grid-template-columns: 1.3fr 0.85fr 0.85fr;
  gap: 8px;
}

.params__api-grid :deep(.el-input-number) {
  width: 100%;
}

/* 输出上限：勾选「无限制」在上、数字框在下，两行不挤同一条横向空间 */
.params__tokens {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.params__tokens :deep(.el-input-number) {
  width: 100%;
}

.params__keys {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.params__key {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  transition: border-color 0.15s;
}

.params__key:hover {
  border-color: var(--rw-border-strong);
}

/* 「来自 .env」那把：虚线边 + 淡底，跟本配置里存的 key 一眼分得开 */
.params__key.is-env {
  border-style: dashed;
  background: var(--rw-surface-2);
}

.params__key-no {
  flex-shrink: 0;
  width: 14px;
  font-size: 10px;
  color: var(--rw-text-3);
  text-align: right;
}

.params__key-mask {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--rw-text-2);
}

.params__key .el-button {
  flex-shrink: 0;
}

.params__key-add {
  display: flex;
  gap: 6px;
}

.params__api-actions {
  display: flex;
  gap: 8px;
}

/* ---------- 端点配置（切换器 + 当前配置的字段） ---------- */
/* 下拉独占一行：侧栏只有 ~240px，跟三个按钮挤同一行时宽度被抢光，
   配置名会被截成「T…」（实测）—— 名字都看不全，多套配置就没法选。 */
.params__prof-bar {
  display: flex;
  align-items: center;
}

.params__prof-select {
  flex: 1 1 auto;
  min-width: 0;
}

/* 新建 / 复制 / 删除：另起一行，左边缘与下拉对齐 */
.params__prof-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

.params__prof-ops :deep(.el-button) {
  flex: 0 0 auto;
}

/* 下拉项：左配置名、右「模型 · N key」，两列对齐（宽度不一也不跳） */
.params__prof-opt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
}

.params__prof-opt-name {
  color: var(--rw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.params__prof-opt-meta {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--rw-text-3);
}

.params__prof-empty {
  margin: 0;
}

/* 「有未保存的改动」：靠右，与两个按钮同行 */
.params__dirty {
  margin-left: auto;
  align-self: center;
  font-size: 11.5px;
  color: var(--rw-brand-d);
}

/* ---------- 分析模块勾选 ---------- */
.params__modules-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.params__modules-head > label {
  font-size: 13px;
  color: var(--rw-text-2);
  font-weight: 500;
}

/* ---------- 分析模块：芯片式多选 ---------- */
.params__modules-summary {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

/* 芯片正上方的工具条：左「已选 N / M」右「全选 / 清空」，两端对齐不留大片空白 */
.params__modules-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  /* 与芯片贴近一点，读作「这组芯片的操作条」而不是另起一段 */
  margin-bottom: -4px;
}

.params__modules-bar .params__group-meta {
  /* 这一行左边整片都是空的，不需要 140px 的截断上限 */
  max-width: none;
}

.params__modules {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 8px;
}

.params__chip {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  font-size: 12.5px;
  line-height: 1.25;
  cursor: pointer;
  text-align: left;
  user-select: none;
  transition: border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
}

.params__chip:hover {
  border-color: var(--rw-brand);
  color: var(--rw-text);
}

.params__chip:focus-visible {
  outline: 2px solid var(--rw-brand);
  outline-offset: 1px;
}

.params__chip.is-on {
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-weight: 500;
  box-shadow: inset 0 0 0 1px var(--rw-brand-soft);
}

/* 自绘勾选框：选中时品牌色实底 + 白色对勾 */
.params__chip-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  border: 1px solid var(--rw-border);
  border-radius: 4px;
  background: var(--rw-surface-2);
  color: transparent;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.params__chip.is-on .params__chip-check {
  border-color: var(--rw-brand);
  background: var(--rw-brand);
  color: #fff;
}

.params__chip-check svg {
  width: 8px;
  height: 7px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.params__modules-note {
  margin: 0;
  font-size: 11px;
  color: var(--rw-text-3);
}

.params__materials {
  display: flex;
  gap: 6px;
}

.params__materials .el-input {
  flex: 1 1 auto;
  min-width: 0;
}

/* ---------- 额外可购买原料：行内校验 + 带结构图的列表 ---------- */
.params__mat-issue {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--rw-danger, #d33);
}

/* 列表项：结构图 + 元信息 + 删除，横向排（一行一个，图是主角） */
.params__mat-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.params__mat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px 4px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

.params__mat-mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 32px;
  flex: 0 0 44px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--rw-surface-2);
}

.params__mat-meta {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.params__mat-meta code {
  font-size: 11px;
  color: var(--rw-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 删除钮：低调的 ×，hover 才亮 */
.params__mat-del {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.params__mat-del:hover {
  color: var(--rw-danger, #d33);
  background: var(--rw-surface-3);
}

.params__mat-empty {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--rw-text-3);
}

/* 手动画原料的画板 dialog：内容再高也不把底部按钮顶出视口 */
.params__mat-dialog :deep(.el-dialog__body) {
  max-height: calc(100vh - 210px);
  overflow: auto;
}

.params__mat-draw-err {
  margin-top: 10px;
}

/* 「多步拆分」范围标签：挂在分组标题上，一眼看出这组参数的适用面 */
.params__scope-tag {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--rw-border-strong);
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
}

/* 约束说明段：范围提示要显眼一点（用户最容易误解「深度」管的是手动展开） */
.params__note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  border-left: 2px solid var(--rw-brand);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.params__note strong {
  color: var(--rw-text-2);
  font-weight: 600;
}

/* ---------- 采购询价 ---------- */
/* 下拉宽度固定 150px：供应商名字最长「Sigma-Aldrich」，再窄会被截成「Sigma-Al…」 */
.params__sup-select {
  width: 150px;
  flex: 0 0 auto;
}

/* 下拉项：左名字、右定位标签（「全球比价」「国产试剂」…）—— 名字长短不一也不跳 */
.params__sup-opt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
}

.params__sup-opt-name {
  color: var(--rw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.params__sup-opt-tag {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--rw-text-3);
}
</style>
