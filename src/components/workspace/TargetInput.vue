<script setup lang="ts">
/**
 * 目标分子输入。
 *
 * 三种输入都能吃：ChemDraw 复制的 CDXML、MOL/SDF 文件、纯 SMILES（含反应式 SMILES）。
 * 解析走后端 RDKit（/api/parse），失败时展示「人话诊断 + 一键修复候选」——
 * 这套体验是 retrochimera 里最值得保留的部分（R 基团 / [*] 通配 / kekulize 失败都能兜住）。
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
import { readFileAsText } from '@/utils/smiles';
import MolView from '@/components/mol/MolView.vue';
import StructureEditor from '@/components/mol/StructureEditor.vue';

const store = useWorkspaceStore();

const mode = ref<'structure' | 'smiles'>('structure');
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

const placeholder = computed(() =>
  mode.value === 'smiles'
    ? '输入 SMILES，例如：CC(=O)Oc1ccccc1C(=O)O'
    : '在 ChemDraw 里框选结构后 Ctrl+C，直接粘贴到这里（CDXML）；也可粘贴 MOL / SDF 文本'
);

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
    const res = await retroApi.parse(payload);
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

async function copySmiles(): Promise<void> {
  if (!parsed.value) return;
  try {
    await navigator.clipboard.writeText(parsed.value.smiles);
    ElMessage.success('已复制 SMILES');
  } catch {
    ElMessage.warning('浏览器拒绝了剪贴板访问');
  }
}

/* ---------- 画板 ---------- */
const editorOpen = ref(false);
const editorRef = ref<InstanceType<typeof StructureEditor> | null>(null);
const editorBusy = ref(false);
const editorError = ref<ParseFailure | null>(null);
/** 画完就搜的设置已退役：是否立刻开跑由标定面板的「开始分析」按钮决定 */

async function openEditor(): Promise<void> {
  editorOpen.value = true;
  editorError.value = null;
  await nextTick();
  // 已有目标就先填进画板，方便在现成结构上改。
  // ⚠️ 只在画板为空时填 —— dialog 关掉再打开是同一个实例，无条件覆盖会把用户画到一半的图冲掉
  const seed = parsed.value?.smiles || (mode.value === 'smiles' ? text.value.trim() : '');
  if (!seed || !editorRef.value?.isEmpty()) return;
  try {
    const res = await retroApi.depict(seed);
    if (res.ok && res.molfile) editorRef.value?.loadFromMolfile(res.molfile);
  } catch {
    /* 载入失败也不用打断：用户可以直接自己画 */
  }
}

async function confirmEditor(): Promise<void> {
  const molfile = editorRef.value?.getMolfile() ?? '';
  if (editorRef.value?.isEmpty()) {
    ElMessage.warning('画板还是空的，先画一个结构');
    return;
  }
  editorBusy.value = true;
  editorError.value = null;
  try {
    // 画出来的图交给 RDKit 判真伪：valence、kekulize、Markush 都在这里兜住
    const res = await retroApi.parse(molfile);
    if (!res.ok) {
      editorError.value = res;
      return;
    }
    parsed.value = res;
    text.value = res.smiles;
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
        <el-radio-group v-model="mode" size="small">
          <el-radio-button value="structure">结构式粘贴</el-radio-button>
          <el-radio-button value="smiles">SMILES</el-radio-button>
        </el-radio-group>

        <el-input
          v-model="text"
          type="textarea"
          :rows="4"
          resize="vertical"
          :placeholder="placeholder"
          class="target__input"
        />

        <div class="target__ops">
          <el-button type="primary" plain @click="openEditor">画结构式</el-button>
          <el-button type="primary" :loading="parsing" @click="runParse()">解析结构</el-button>
          <el-button @click="fileInput?.click()">选择文件</el-button>
          <el-button link @click="clearAll">清空</el-button>
          <input
            ref="fileInput"
            type="file"
            accept=".mol,.sdf,.sd,.cdxml,.txt,.smi,.smiles"
            hidden
            @change="onFile"
          />
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
          <div class="target__mol">
            <MolView :smiles="parsed.smiles" fit clickable />
          </div>
          <div class="target__meta">
            <div class="target__smiles">
              <code class="rw-mono">{{ parsed.smiles }}</code>
              <el-button link size="small" @click="copySmiles">复制</el-button>
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
            先<strong>粘贴</strong> ChemDraw 结构 / SMILES，或点<strong>「画结构式」</strong>手绘一个
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

    <!-- 结构式画板：画完即搜索 -->
    <el-dialog
      v-model="editorOpen"
      title="绘制结构式"
      width="980px"
      top="4vh"
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

.target__ops {
  display: flex;
  align-items: center;
  gap: 8px;
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
