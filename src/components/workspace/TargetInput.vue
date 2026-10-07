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
 */
import { computed, nextTick, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { retroApi } from '@/api/retro';
import { useWorkspaceStore } from '@/stores/workspace';
import type { ParseFailure, ParseSuccess } from '@/types/retro';
import { depictMolfile, isRdkitReady, needsBackendParse, parseStructure } from '@/utils/rdkit';
import { readFileAsText } from '@/utils/smiles';
import { copyText } from '@/utils/clipboard';
import MolView from '@/components/mol/MolView.vue';
import StructureEditor from '@/components/mol/StructureEditor.vue';

const store = useWorkspaceStore();

const text = ref('');
const parsing = ref(false);
const parsed = ref<ParseSuccess | null>(null);
const failure = ref<ParseFailure | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);


const EXAMPLES: Array<{ label: string; smiles: string }> = [
  { label: '阿司匹林', smiles: 'CC(=O)Oc1ccccc1C(=O)O' },
  { label: '布洛芬', smiles: 'CC(C)Cc1ccc(C(C)C(=O)O)cc1' },
  { label: '对乙酰氨基酚', smiles: 'CC(=O)Nc1ccc(O)cc1' },
  { label: '咖啡因', smiles: 'Cn1cnc2c1c(=O)n(C)c(=O)n2C' },
  { label: '利多卡因', smiles: 'CCN(CC)CC(=O)Nc1c(C)cccc1C' }
];

const PLACEHOLDER =
  '粘贴 ChemDraw 结构（Ctrl+C 复制的 CDXML）、MOL / SDF 文本，或直接输入 SMILES，例如 CC(=O)Oc1ccccc1C(=O)O';

/**
 * 输入框正下方的「支持什么」提示 —— 学 Reaxys 搜索框下面那行
 * 「Substance Molecular Formula, e.g. Pt(PPh3)3」：
 * 把「这里该填什么、长什么样」直接印在输入框底下，别让用户去猜。
 * 合并模式后只有一句：能认的格式全列出来，不再随模式变。
 */
const hintText = '支持 CDXML / MOL / SDF / SMILES / 反应式 SMILES（用 > 分隔），粘贴即自动识别格式';

const currentSmiles = computed(() => store.rootId ? store.nodes[store.rootId]?.smiles : '');

async function runParse(input?: string): Promise<void> {
  const payload = (input ?? text.value).trim();
  if (!payload) {
    ElMessage.warning('请先粘贴结构或输入 SMILES');
    return;
  }
  parsing.value = true;
  failure.value = null;
  try {
    // CDXML 是唯一必须走后端的输入（浏览器版 RDKit 读不了它）
    const useBackend = needsBackendParse(payload);
    if (!useBackend && !isRdkitReady()) {
      // 首次解析要拉 7.4MB 的 WASM 引擎 —— 说清楚，别让人以为卡死了
      ElMessage.info('首次解析需加载前端解析引擎（约 7MB），请稍候…');
    }
    const res = useBackend ? await retroApi.parse(payload) : await parseStructure(payload);
    if (res.ok) {
      parsed.value = res;
      store.setTarget(res);
      ElMessage.success('已解析并设为目标分子');
    } else {
      parsed.value = null;
      failure.value = res;
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

function clearAll(): void {
  text.value = '';
  parsed.value = null;
  failure.value = null;
}

/**
 * 「确定目标，开始分析」—— 标定阶段唯一的出口。
 *
 * 🔴 语义：**一个目标分析 = 一个任务**。点下这个按钮 = 任务正式开始：
 *   ① 保证根节点已经在树上（画板路径已经 setTarget 过了，这里兜住直接粘贴的路径）；
 *   ② 关掉整张标定面板（store.closeTargetSetup）→ 工作台切到路线态，
 *      参数跑到右栏、目标降级成顶部窄条；
 *   ③ 顺手对根节点**展开一步**，不让用户再去找那个「展开」按钮。
 *
 * 之所以把「关面板」放在这里而不是 setTarget 里：解析成功 ≠ 要开始分析 ——
 * 用户可能想换个模型参数再开跑。只有**显式点这个按钮**才代表"任务开始"。
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

/** 这个目标是不是已经可以开跑了（根节点在树上） */
const canStart = computed(() => !!store.rootId);

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
    <div class="rw-card__head">
      <div class="rw-card__title">目标分子</div>
      <div class="target__head-ops">
        <el-tag v-if="currentSmiles" type="success" size="small" effect="light">已设定</el-tag>
      </div>
    </div>

    <div class="rw-card__body target__body">
      <!-- ① 输入行：**一个**输入框 + 右侧内联主操作。
             照 Reaxys 的 `[ 输入框 ][ Find > ]` —— 动作按钮贴着输入框右边缘，
             而不是另起一行排在下面（那样视线要往下跳一次才能找到怎么提交）。
             🔴 结构式粘贴与 SMILES 已合并成一个框：格式交给 `needsBackendParse` /
                `parseStructure` 自动识别，不再让用户先声明"我要粘的是哪种"——
             那一行单选框是多余的负担，两套占位文案也白占了两行高度。
             输入框走 autosize：SMILES 两行足够，粘 CDXML 会自动长高。
             ② 的格式提示紧贴其下，所以两者包在同一个 entry 里用更小的间距。 -->
      <div class="target__entry">
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

        <!-- ② 格式提示 + 次级操作：Reaxys 的 "Substance Molecular Formula, e.g. …" 那一行 -->
        <div class="target__hint">
          <span class="target__hint-text">{{ hintText }}</span>
          <span class="target__hint-ops">
            <el-button link size="small" @click="fileInput?.click()">选择文件</el-button>
            <i aria-hidden="true">·</i>
            <el-button link size="small" @click="clearAll">清空</el-button>
          </span>
          <input
            ref="fileInput"
            type="file"
            accept=".mol,.sdf,.sd,.cdxml,.txt,.smi,.smiles"
            hidden
            @change="onFile"
          />
        </div>
      </div>

      <div class="target__examples">
        <span class="target__examples-label">示例：</span>
        <el-tag
          v-for="ex in EXAMPLES"
          :key="ex.smiles"
          size="small"
          effect="plain"
          class="target__chip"
          @click="applySuggestion(ex.smiles)"
        >
          {{ ex.label }}
        </el-tag>
      </div>

      <!-- ③ 「或者」分隔 + 居中的绘制入口 —— 学 Reaxys 的 `AND` + 居中 `Draw` 按钮：
             它把「输入 / 画图」两条等价路径摆成平级选项，而不是把画板塞进按钮堆里。 -->
      <div class="target__or"><span>或者</span></div>
      <div class="target__draw">
        <button type="button" class="target__draw-btn" @click="openEditor">
          <svg class="target__draw-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <!-- 六元环（左上）：尖顶六边形，边长 5.8 -->
            <path
              d="M13.62 5.7 V11.5 L8.6 14.4 L3.58 11.5 V5.7 L8.6 2.8 Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
            <!-- 铅笔（右下）：笔尖朝左下，与环错开，小尺寸下也不会糊成一块 -->
            <path d="M13 21 14.06 22.06 21.06 15.06 18.94 12.94 11.94 19.94 Z" fill="currentColor" />
          </svg>
          {{ seedHint ? '编辑结构式' : '绘制结构式' }}
        </button>
        <!-- 已经粘了 / 点过示例 / 解析过 ⇒ 说清「点进去会带着这个结构」，别让人以为要重画 -->
        <span v-if="seedHint" class="target__draw-hint">{{ seedHint }}</span>
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

      <!-- 解析成功：目标信息卡 -->
      <div v-if="parsed" class="target__result">
        <!-- 点结构图 = 带着这个结构打开画板（resolveSeed 优先取已解析结果） -->
        <div class="target__mol" role="button" tabindex="0" title="点一下带着这个结构打开画板" @click="openEditor" @keyup.enter="openEditor">
          <MolView :smiles="parsed.smiles" fit clickable />
        </div>
        <div class="target__meta">
          <div class="target__smiles">
            <code class="rw-mono">{{ parsed.smiles }}</code>
            <el-button link size="small" @click="copySmiles">复制</el-button>
            <!-- 粘完/选完示例不用重画：直接进画板改这个结构 -->
            <el-button link size="small" type="primary" @click="openEditor">编辑结构</el-button>
          </div>
          <div class="target__props">
            <span><i>分子式</i>{{ parsed.formula || '—' }}</span>
            <span><i>分子量</i>{{ parsed.mw ?? '—' }}</span>
            <span><i>重原子</i>{{ parsed.atoms }}</span>
            <span><i>类型</i>{{ parsed.kind }}</span>
          </div>
        </div>
      </div>

      <div v-else-if="!failure" class="target__blank">
        <div class="target__blank-mol">
          <MolView :smiles="'CCO'" fit />
        </div>
        <p class="target__blank-text">
          这里会显示解析后的结构：<br />
          先<strong>粘贴</strong> ChemDraw 结构 / SMILES，或点<strong>「绘制结构式」</strong>手绘一个
        </p>
      </div>

      <!-- 标定阶段的唯一出口：确认目标 ⇒ 收起整张面板、开跑第一个任务 -->
      <div class="target__start">
        <el-button
          type="primary"
          size="large"
          :disabled="!canStart"
          class="target__start-btn"
          @click="startAnalysis"
        >
          确定目标，开始分析
        </el-button>
        <span class="target__start-hint">
          {{
            canStart
              ? '参数已按右侧设置生效；开始后本面板收起，参数移到右栏可随时调'
              : '先粘贴/画一个结构并点「解析结构」，或直接点上面的示例'
          }}
        </span>
      </div>
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
  gap: 12px;
}

.target__head-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

.target__input :deep(textarea) {
  font-family: var(--rw-font-mono);
  font-size: 12px;
}

/* ---------- ① 输入行（学 Reaxys：输入框 + 右侧内联动作） ---------- */
.target__entry {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.target__field {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.target__field .target__input {
  flex: 1;
  min-width: 0;
}

.target__field-act {
  flex: 0 0 auto;
}

/* ---------- ② 格式提示行（学 Reaxys 的 "Substance Molecular Formula, e.g. …"） ---------- */
.target__hint {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--rw-text-3);
}

.target__hint-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target__hint-ops {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.target__hint-ops i {
  font-style: normal;
  opacity: 0.45;
}

/* ---------- ③ 「或者」分隔 + 居中的绘制入口（学 Reaxys 的 AND + Draw） ---------- */
.target__or {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  letter-spacing: 0.08em;
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

/* 「打开画板会带上这个结构」的说明 —— 只在真带得进去时才出现 */
.target__draw-hint {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--rw-text-3);
  text-align: center;
}

.target__draw-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 22px;
  border: 1px solid var(--rw-border-strong);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  font-size: 13.5px;
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
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  color: var(--rw-brand);
}

.target__draw-btn:hover .target__draw-icon {
  color: var(--rw-brand-d);
}

.target__examples {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 左栏收窄到 340px 后 5 个示例会折成两行 ⇒ 改单行横向滚动，
     既不撑高卡片，也不丢任何一个示例 */
  flex-wrap: nowrap;
  overflow-x: auto;
  scrollbar-width: none;
  padding-bottom: 2px;
  /* 右侧渐隐：提示"还能往右滚"（否则用户不知道咖啡因/利多卡因藏在后面） */
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 26px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 26px), transparent 100%);
}

.target__examples::-webkit-scrollbar {
  display: none;
}

/* 内容没超出时不要渐隐（避免末尾 chip 无谓变淡） */
@media (min-width: 1400px) {
  .target__examples {
    -webkit-mask-image: none;
    mask-image: none;
  }
}

.target__examples-label,
.target__fixes-label {
  font-size: 12px;
  color: var(--rw-text-3);
  flex-shrink: 0;
}

.target__chip {
  cursor: pointer;
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

.target__result {
  display: flex;
  gap: 14px;
  padding: 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.target__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 150px;
  height: 120px;
  flex: 0 0 150px;
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  overflow: hidden;
}

.target__meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.target__smiles {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.target__smiles code {
  flex: 1;
  color: var(--rw-text);
}

.target__props {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 12px;
  font-size: 12px;
  color: var(--rw-text-2);
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

.target__auto {
  margin-right: auto;
}

.target__props i {
  font-style: normal;
  color: var(--rw-text-3);
  margin-right: 6px;
}

/* ---------- 未设定目标时的占位（不用 el-empty：那个默认 180+px 高，
   标定卡里会撑出一大片死白，把整个卡片拉得又高又空） ---------- */
.target__blank {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px dashed var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.target__blank-mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 56px;
  flex: 0 0 64px;
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  overflow: hidden;
  /* 占位图压暗，明确告诉用户"这不是你的分子，只是示意" */
  opacity: 0.55;
}

.target__blank-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.target__blank-text strong {
  color: var(--rw-text-2);
  font-weight: 600;
}

/* ---------- 标定面板底部的「开始分析」 ---------- */
.target__start {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  padding-top: 14px;
  border-top: 1px dashed var(--rw-border);
}

.target__start-btn {
  flex: 0 0 auto;
  font-weight: 600;
}

.target__start-hint {
  font-size: 12px;
  color: var(--rw-text-3);
  line-height: 1.5;
}

@media (max-width: 768px) {
  .target__start {
    flex-direction: column;
    align-items: stretch;
  }

  .target__start-btn {
    width: 100%;
  }
}
</style>
