<script setup lang="ts">
/**
 * 目标分子输入。
 *
 * 三种输入都能吃：ChemDraw 复制的 CDXML、MOL/SDF 文件、纯 SMILES（含反应式 SMILES）。
 * 解析走后端 RDKit（/api/parse），失败时展示「人话诊断 + 一键修复候选」——
 * 这套体验是 retrochimera 里最值得保留的部分（R 基团 / [*] 通配 / kekulize 失败都能兜住）。
 *
 * 版式：**双态卡片**。
 *   未设定 / 用户手动展开 → 完整输入区（模式切换 + 文本域 + 操作 + 示例 + 解析结果）
 *   已设定且未手动展开   → 紧凑胶囊（结构图缩略 + 分子式 + 分子量 + 换目标）
 * 目的是把左栏垂直空间让给运行参数 —— 目标只在开头设一次，却一直占着整屏高度。
 */
import { computed, nextTick, ref, watch } from 'vue';
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

/** 卡片是否展开（store 持有：设定成功后自动收起） */
const expanded = computed({
  get: () => store.targetExpanded,
  set: (v: boolean) => store.setTargetExpanded(v)
});


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

/** 胶囊态展示的当前目标信息（会话恢复时 parsed 为空，直接取根节点） */
const currentTarget = computed(() => {
  const root = store.rootId ? store.nodes[store.rootId] : undefined;
  if (!root) return null;
  return {
    smiles: root.smiles,
    formula: root.formula || parsed.value?.formula || '',
    mw: root.mw ?? parsed.value?.mw,
    atoms: root.atoms
  };
});

/** 有目标 + 用户没手动展开过 → 收成胶囊 */
const collapsed = computed(() => !!currentTarget.value && !expanded.value);


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
/** 画完就搜：解析成功自动对根节点展开一步 */
const autoExpand = ref(true);

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
    if (autoExpand.value && store.rootId) void store.predictNode(store.rootId);
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

/** 点胶囊展开输入区（已有目标就先回填 SMILES 便于微调） */
function expand(): void {
  expanded.value = true;
  if (!text.value && currentTarget.value) text.value = currentTarget.value.smiles;
}

/**
 * 展开后自动聚焦文本域 —— 用户点「换目标」的意图就是要输入，
 * 不聚焦的话还得再点一次输入框（多一步无谓操作）。
 */
watch(collapsed, async (isCollapsed) => {
  if (isCollapsed) return;
  await nextTick();
  const el = document.querySelector<HTMLTextAreaElement>('.target__input textarea');
  el?.focus();
});
</script>

<template>
  <section class="rw-card target" :class="{ 'target--collapsed': collapsed }">
    <!-- ============ 胶囊态：已设定目标，收起成一条 ============ -->
    <div v-if="collapsed" class="target__pill">
      <div class="target__pill-mol">
        <MolView :smiles="currentTarget!.smiles" fit />
      </div>
      <div class="target__pill-info">
        <div class="target__pill-label">
          目标分子
          <el-tag size="small" type="success" effect="light">已设定</el-tag>
        </div>
        <div class="target__pill-props">
          <span v-if="currentTarget!.formula">{{ currentTarget!.formula }}</span>
          <span v-if="currentTarget!.mw"><i>MW</i> {{ currentTarget!.mw }}</span>
          <span v-if="currentTarget!.atoms"><i>重原子</i> {{ currentTarget!.atoms }}</span>
        </div>
        <code class="rw-mono target__pill-smiles">{{ currentTarget!.smiles }}</code>
      </div>
      <div class="target__pill-ops">
        <el-tooltip content="重新展开输入区，换个目标分子" placement="left">
          <el-button size="small" plain @click="expand">换目标</el-button>
        </el-tooltip>
      </div>
    </div>

    <!-- ============ 展开态：完整输入区 ============ -->
    <template v-else>
      <div class="rw-card__head">
        <div class="rw-card__title">① 目标分子</div>
        <div class="target__head-ops">
          <el-tag v-if="currentSmiles" type="success" size="small" effect="light">已设定</el-tag>
          <el-button
            v-if="currentSmiles"
            link
            size="small"
            @click="expanded = false"
          >
            收起
          </el-button>
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

        <el-empty v-else-if="!failure" description="尚未设定目标分子" :image-size="60" />
      </div>
    </template>

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
        <el-checkbox v-model="autoExpand" class="target__auto">解析后自动展开一步</el-checkbox>
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

/* ---------- 胶囊态 ---------- */
/* 目标已设定且用户未展开时的高度：约 88px（完整输入区常态 500px+） */
.target--collapsed {
  overflow: hidden;
}

.target__pill {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
}

.target__pill-mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  flex: 0 0 64px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  overflow: hidden;
}

.target__pill-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.target__pill-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-text-2);
}

.target__pill-props {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--rw-text-2);
}

.target__pill-props span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.target__pill-props i {
  font-style: normal;
  color: var(--rw-text-3);
}

.target__pill-smiles {
  font-size: 11px;
  color: var(--rw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target__pill-ops {
  flex-shrink: 0;
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
</style>
