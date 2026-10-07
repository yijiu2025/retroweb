<script setup lang="ts">
/**
 * 「目标分析」卡（左侧栏）—— 当前任务在拆什么 + 已经确认到哪一步。
 *
 * 位置：侧栏中「最近的任务」**上方**，与任务列表并列（原来是主区顶部的一条 Slim Header）。
 * 为什么搬走：主区顶部每多一行，逆合成树 / 路线网络就少一行；而目标信息属于
 * 「随时瞄一眼」的那类内容 —— 放在常驻侧栏比占主区一行更划算。
 *
 * 两段内容：
 *   ① **目标分子**：结构缩略图（点开放大）+ 分子式 / MW / 重原子 + SMILES
 *   ② **已确认路线**：沿当前采纳分支回溯出的步骤数、各步概率、总概率、起始物料数、最深层数
 *
 * 🔴 挂载判据在 AppShell：`!store.targetSetupOpen && !!store.rootId` ——
 *    标定态下目标还没定，显示一屏占位只会碍事。
 * 🔴 侧栏收起（64px）时整块隐藏（见 :global(.app.is-collapsed)）—— 挤不下，显示也没意义。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { promptSaveScheme } from '@/utils/scheme-save';
import MolView from '@/components/mol/MolView.vue';

const store = useWorkspaceStore();
const emit = defineEmits<{ preview: [smiles: string] }>();

const root = computed(() => (store.rootId ? store.nodes[store.rootId] : undefined));

/** 已确认路线的回溯结果（沿当前采纳的每一分支） */
const steps = computed(() => store.route);
const stepCount = computed(() => steps.value.length);
const totalPct = computed(() => `${(store.routeProbability * 100).toFixed(2)}%`);
const maxLayer = computed(() => store.stats.maxDepth + 1);

/** 结构太长时截断 —— 侧栏只有 ~216px 可用 */
function short(s: string, n = 16): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function copySmiles(): Promise<void> {
  const t = root.value;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t.smiles);
    ElMessage.success('已复制 SMILES');
  } catch {
    // 非 https / 无剪贴板权限时降级提示，别让按钮点了没反应
    ElMessage.warning('浏览器不允许自动复制，请手动选中 SMILES 复制');
  }
}
</script>

<template>
  <section v-if="root" class="tan">
    <header class="tan__head">
      <span class="tan__title">目标分析</span>
      <el-tooltip content="复制 SMILES" placement="bottom" :show-after="150">
        <button type="button" class="tan__icon" aria-label="复制 SMILES" @click="copySmiles">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.6" />
            <path d="M10.5 5.6V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.6" />
          </svg>
        </button>
      </el-tooltip>
    </header>

    <!-- 结构缩略图：点开放大 -->
    <button type="button" class="tan__mol" title="点击放大查看" @click="emit('preview', root.smiles)">
      <MolView :smiles="root.smiles" fit />
    </button>

    <div class="tan__props">
      <span v-if="root.formula"><i>分子式</i>{{ root.formula }}</span>
      <span v-if="root.mw"><i>MW</i>{{ root.mw }}</span>
      <span v-if="root.atoms"><i>重原子</i>{{ root.atoms }}</span>
    </div>

    <code class="rw-mono tan__smiles" :title="root.smiles">{{ root.smiles }}</code>

    <!-- 已确认路线：这是「任务主页」的核心 —— 打开任务先看它，而不是一屏未成形的树 -->
    <div class="tan__route">
      <div class="tan__route-head">
        <span class="tan__route-label">已确认路线</span>
        <span class="tan__route-pct" :title="`各步概率连乘：${totalPct}`">{{ totalPct }}</span>
      </div>

      <div class="tan__route-stats">
        <span><b>{{ stepCount }}</b> 步</span>
        <span><b>{{ store.startingMaterials.length }}</b> 起始物料</span>
        <span><b>第 {{ maxLayer }} 层</b></span>
      </div>

      <ol v-if="stepCount" class="tan__steps">
        <li v-for="s in steps" :key="s.nodeId" :title="`${s.product} ← ${s.precursors.join(' + ')}`">
          <span class="tan__step-no">{{ s.step }}</span>
          <code class="rw-mono tan__step-mol">{{ short(s.product) }}</code>
          <span class="tan__step-p">{{ (s.probability * 100).toFixed(0) }}%</span>
        </li>
      </ol>
      <p v-else class="tan__hint">
        还没有确认任何一步 —— 到「逆合成树」页签展开候选并采纳，路线会在这里逐层长出来。
      </p>
    </div>

    <div class="tan__ops">
      <el-button v-if="!store.schemeStats.length" size="small" plain @click="promptSaveScheme(store)">
        存为新方案
      </el-button>
      <el-tooltip content="回到标定面板，换一个目标分子（会开始一个新任务）" placement="bottom" :show-after="150">
        <el-button size="small" type="primary" plain @click="store.openTargetSetup()">切换目标</el-button>
      </el-tooltip>
    </div>
  </section>
</template>

<style scoped>
.tan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface-2);
}

.tan__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.tan__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-text);
  letter-spacing: 0.02em;
}

.tan__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
  padding: 0;
  border: 1px solid var(--rw-border);
  border-radius: 5px;
  background: var(--rw-surface);
  color: var(--rw-text-3);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tan__icon:hover {
  color: var(--rw-brand);
  border-color: var(--rw-brand);
}

.tan__icon svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 结构缩略图：与卡片同圆角，hover 变品牌色边提示可点 */
.tan__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 86px;
  padding: 4px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color 0.15s;
}

.tan__mol:hover {
  border-color: var(--rw-brand);
}

.tan__props {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--rw-text-2);
}

.tan__props i {
  font-style: normal;
  margin-right: 4px;
  color: var(--rw-text-3);
}

.tan__smiles {
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--rw-text-3);
  /* 最多两行，超出省略 —— 侧栏放不下完整 SMILES */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
}

/* ---------- 已确认路线 ---------- */
.tan__route {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--rw-border);
}

.tan__route-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.tan__route-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--rw-text-3);
  letter-spacing: 0.03em;
}

.tan__route-pct {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.tan__route-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.tan__route-stats b {
  color: var(--rw-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.tan__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 116px;
  overflow-y: auto;
}

.tan__steps li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 5px;
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
}

.tan__step-no {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--rw-brand-d);
}

.tan__step-mol {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--rw-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tan__step-p {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--rw-text-3);
  font-variant-numeric: tabular-nums;
}

.tan__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--rw-text-3);
}

.tan__ops {
  display: flex;
  gap: 6px;
}

.tan__ops :deep(.el-button) {
  flex: 1;
  min-width: 0;
}

/* 侧栏收起（64px）时整块隐藏 */
:global(.app.is-collapsed) .tan {
  display: none;
}
</style>
