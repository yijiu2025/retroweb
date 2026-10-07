<script setup lang="ts">
/**
 * 一行 = 一个化合物（递归渲染子树）。
 *
 * 「展开」只发**一次** /api/predict；采纳候选后前体各新增一行（depth+1，缩进）。
 * 折叠时子树用 v-if 彻底卸载，避免大 SVG 撑爆 DOM。
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { MolNode } from '@/types/retro';
import { SUPPLIERS, openSupplier } from '@/utils/suppliers';
import MolView from '@/components/mol/MolView.vue';
import CandidatePanel from './CandidatePanel.vue';
import JobProgress from './JobProgress.vue';

const props = defineProps<{ nodeId: string }>();
const emit = defineEmits<{ preview: [smiles: string] }>();

const store = useWorkspaceStore();

const node = computed<MolNode | undefined>(() => store.nodes[props.nodeId]);
// 缩进要封顶：树深了以后无上限的 padding-left 会把整行挤出容器（横向滚动/裁切）
const indent = computed(() => Math.min(node.value?.depth ?? 0, 8) * 18);
const isActive = computed(() => store.activeNodeId === props.nodeId);
const hasChildren = computed(() => (node.value?.children.length ?? 0) > 0);
const terminal = computed(() => node.value?.role === 'starting' || node.value?.status === 'terminated');
const isRoot = computed(() => store.rootId === props.nodeId);
/** 已满足终止条件 ⇒ 再点「展开」不会有反应，直接禁用并说清原因 */
const expandBlocked = computed(
  () => !!node.value?.duplicateOf || (terminal.value && !node.value?.fetched)
);
const expandHint = computed(() => {
  if (node.value?.duplicateOf) return '该分子已在本分支上游出现过（防环）';
  if (terminal.value) {
    return `已满足终止条件（重原子 ≤ ${store.params.heavyAtomThreshold}，或已标记可购买）。想继续往下拆：调低阈值或取消「可购买」标记`;
  }
  return '再走一步单步预测';
});

const roleText: Record<string, string> = { target: '目标产物', intermediate: '中间体', starting: '起始物料' };
const roleClass: Record<string, string> = { target: 'is-target', intermediate: 'is-mid', starting: 'is-start' };

const chainPercent = computed(() => {
  const p = node.value?.probabilityChain ?? 1;
  return p >= 1 ? '—' : `${(p * 100).toFixed(1)}%`;
});

/** 该节点当前采纳那一步的 AI 分析状态 */
const analysisStatus = computed(() => store.analysisOf(props.nodeId)?.status ?? 'idle');
/** 这个分子一共被分析过几次（每次结果都保留） */
const runCount = computed(() => node.value?.runs?.length ?? 0);

function onExpand(): void {
  void store.predictNode(props.nodeId);
}

/** 跳到「流程」页签并定位到这一步的工艺分析 */
function openAnalysis(): void {
  store.analysisFocus = props.nodeId;
  store.mainTab = 'flow';
}

function onQuery(supplierId: string): void {
  const smi = node.value?.smiles;
  if (smi) openSupplier(supplierId, smi);
}
</script>

<template>
  <div v-if="node" class="step-node">
    <div class="step-row" :class="{ 'is-active': isActive, 'is-root': isRoot }">
      <div class="step-row__inner" :style="{ paddingLeft: indent + 'px' }">
        <!-- 折叠箭头 -->
        <button
          v-if="hasChildren"
          type="button"
          class="step-row__chevron"
          :title="node.collapsed ? '展开子树' : '折叠子树'"
          @click="store.toggleCollapse(nodeId)"
        >
          {{ node.collapsed ? '▸' : '▾' }}
        </button>
        <span v-else class="step-row__chevron is-empty">·</span>

        <!-- 结构图：容器是定尺寸盒子 ⇒ 用 fit 让 SVG 等比填满，不裁切 -->
        <div class="step-row__mol" @click="emit('preview', node.smiles)">
          <MolView :smiles="node.smiles" fit :dark="false" />
        </div>

        <!-- 文本信息 -->
        <div class="step-row__main">
          <code class="rw-mono step-row__smiles" :title="node.smiles">{{ node.smiles }}</code>
          <div class="step-row__meta">
            <span v-if="node.formula">{{ node.formula }}</span>
            <span v-if="node.mw">MW {{ node.mw }}</span>
            <span>{{ store.heavyAtoms(node) }} 重原子</span>
            <span>第 {{ node.depth + 1 }} 层</span>
            <span>累计 {{ chainPercent }}</span>
            <span v-if="runCount > 1">{{ runCount }} 次分析</span>
          </div>
        </div>

        <!-- 标签 -->
        <div class="step-row__tags">
          <span class="step-tag" :class="roleClass[node.role]">{{ roleText[node.role] }}</span>
          <span v-if="node.purchased" class="step-tag is-buy">可购买</span>
          <el-dropdown
            v-if="node.purchased"
            trigger="click"
            size="small"
            @command="onQuery"
          >
            <span class="step-row__query" title="点击查价">¥</span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="s in SUPPLIERS" :key="s.id" :command="s.id">
                  <span class="step-row__supplier-name">{{ s.name }}</span>
                  <span class="step-row__supplier-tag">{{ s.tag }}</span>
                </el-dropdown-item>
                <div class="step-row__supplier-footnote">跳转后粘贴 SMILES 即可（已自动复制）</div>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <span v-if="node.reusedFrom" class="step-tag is-reuse">复用分析</span>
          <span v-if="node.duplicateOf" class="step-tag is-dup">同分支重复</span>
          <span v-if="analysisStatus === 'done'" class="step-tag is-analyzed">已分析</span>
          <span v-else-if="analysisStatus === 'streaming'" class="step-tag is-analyzing">分析中</span>
          <span v-if="node.status === 'failed'" class="step-tag is-err">失败</span>
        </div>

        <!-- 操作 -->
        <div class="step-row__ops">
          <el-button
            v-if="node.status === 'loading'"
            size="small"
            type="danger"
            plain
            @click="store.cancelNode(nodeId)"
          >
            取消
          </el-button>
          <template v-else>
            <el-tooltip :content="expandHint" placement="top" :show-after="200">
              <el-button
                size="small"
                :type="isActive ? 'default' : 'primary'"
                :disabled="expandBlocked"
                @click="onExpand"
              >
                {{ node.fetched ? (isActive ? '收起候选' : '查看候选') : '展开' }}
              </el-button>
            </el-tooltip>
            <el-button
              v-if="node.chosenReactionId"
              size="small"
              link
              type="primary"
              @click="openAnalysis"
            >
              工艺分析
            </el-button>
            <el-button
              size="small"
              :type="node.purchased ? 'success' : 'default'"
              @click="store.markPurchased(nodeId, !node.purchased)"
            >
              {{ node.purchased ? '取消可购买' : '标记可购买' }}
            </el-button>
            <el-button v-if="!isRoot" size="small" link type="danger" @click="store.removeBranch(nodeId)">
              删除
            </el-button>
          </template>
        </div>
      </div>

      <!-- 候选面板（行内展开） -->
      <div v-if="isActive" :style="{ paddingLeft: indent + 'px' }">
        <CandidatePanel :node-id="nodeId" />
      </div>

      <!-- 分析进度（行内展开）：正在跑后台 job 时实时显示阶段时间线 + 日志 -->
      <div v-if="node.status === 'loading'" :style="{ paddingLeft: indent + 28 + 'px' }">
        <JobProgress :node-id="nodeId" />
      </div>

      <div v-if="node.error" class="step-row__error" :style="{ paddingLeft: indent + 28 + 'px' }">
        <b>失败：</b>{{ node.error }}
        <ul v-if="node.errorReasons?.length" class="step-row__reasons">
          <li v-for="(r, i) in node.errorReasons" :key="i">{{ r }}</li>
        </ul>
      </div>
    </div>

    <!-- 子树 -->
    <div v-if="hasChildren && !node.collapsed" class="step-children">
      <StepRow v-for="childId in node.children" :key="childId" :node-id="childId" @preview="(s) => emit('preview', s)" />
    </div>
  </div>
</template>

<style scoped>
.step-row {
  border-radius: var(--rw-radius-sm);
  transition: background 0.15s;
}

.step-row:hover {
  background: var(--rw-surface-2);
}

.step-row.is-active {
  background: var(--rw-brand-l);
}

.step-row__inner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  min-height: 62px;
}

.step-row__chevron {
  width: 18px;
  flex: 0 0 18px;
  border: 0;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 12px;
  cursor: pointer;
  text-align: center;
}

.step-row__chevron.is-empty {
  cursor: default;
}

.step-row__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 104px;
  flex: 0 0 104px;
  height: 64px;
  padding: 3px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface);
  overflow: hidden;
  cursor: zoom-in;
}

.step-row__main {
  flex: 1;
  min-width: 0;
}

/* 长 SMILES 不再单行硬截：最多两行，完整值靠 title 悬浮看 */
.step-row__smiles {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--rw-text);
  word-break: break-all;
}

.step-row__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 3px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.step-row__tags {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 0 0 auto;
}

.step-tag {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid transparent;
}

.step-tag.is-target {
  color: var(--rw-brand-d);
  background: var(--rw-brand-l);
  border-color: var(--rw-brand-soft);
}

.step-tag.is-mid {
  color: var(--rw-text-2);
  background: var(--rw-surface-3);
}

.step-tag.is-start {
  color: var(--rw-ok);
  background: var(--rw-ok-l);
}

.step-tag.is-buy {
  color: #0369a1;
  background: #e0f2fe;
}

/* 询价入口：¥ 小圆钮（紧贴「可购买」标签下方） */
.step-row__query {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 3px;
  border-radius: 50%;
  background: var(--rw-brand);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  user-select: none;
}

.step-row__query:hover {
  background: var(--rw-brand-d);
}

.step-row__supplier-name {
  font-weight: 600;
}

.step-row__supplier-tag {
  margin-left: 8px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.step-row__supplier-footnote {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--rw-text-3);
  white-space: normal;
  line-height: 1.5;
}

.step-tag.is-dup {
  color: var(--rw-warn);
  background: var(--rw-warn-l);
}

.step-tag.is-reuse {
  color: #7c3aed;
  background: #f3e8ff;
}

.step-tag.is-analyzed {
  color: #0f766e;
  background: #ccfbf1;
}

.step-tag.is-analyzing {
  color: #b45309;
  background: #fef3c7;
}

.step-tag.is-err {
  color: var(--rw-bad);
  background: var(--rw-bad-l);
}

.step-row__ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.step-row__error {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--rw-bad);
}

.step-row__reasons {
  margin: 4px 0 0;
  padding-left: 18px;
  color: var(--rw-text-2);
}

.step-children {
  position: relative;
}

.step-children::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--rw-border);
}
</style>
