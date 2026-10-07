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

        <!-- 文本信息 + 标签 -->
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

          <!-- 标签：**排在分子信息下面的一行**（见 .step-row__tags 注释）。
               🔴 「¥」必须挂在「可购买」这个 pill **内部**：
                  它原来是标签列的一个兄弟节点 ⇒ 各占一格，中间会空出一个 chip 的间距，
                  看着像两个不相干的标签（用户截图里那个"孤立的 ¥ 圆点"）。
                  放进 pill 里则永远是「可购买 [¥]」一体，窄屏换行时也不会被拆开。
               🔴 `el-dropdown` 必须在 pill **外面**：pill 整块都要是查价的选择热区。
                  放里面（只有 ¥ 是 trigger）时，点「可购买」三个字没反应 ——
                  用户以为整块能点，实测只有那 16px 的圆点管用。 -->
          <div class="step-row__tags">
            <span class="step-tag" :class="roleClass[node.role]">{{ roleText[node.role] }}</span>
            <el-dropdown v-if="node.purchased" trigger="click" size="small" @command="onQuery">
              <span class="step-tag is-buy" title="点击选择供应商查价">可购买<i class="step-row__query" aria-hidden="true">¥</i></span>
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
            <!-- 🔴 两态**同权重**（都是描边按钮）：原来「取消可购买」是纯绿实心
                 （`type="success"` 不带 plain），在一行里比主操作「查看候选」还抢眼，
                 而同一个「可购买」状态右边的标签已经用绿色表示过一次了。
                 加 `plain` ⇒ 语义色保留（绿=可购买），权重回到二级操作。 -->
            <el-button
              size="small"
              plain
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

/* 标签：跟在分子信息下面的一行 chip。
   🔴 原来它在 `.step-row__inner` 里占**独立的一列**，而且是 `flex-direction: column`
      ⇒ 每个标签各占一行，还被 `align-items: stretch` 拉伸到同宽（最宽的「起始物料」60px，
      「已分析」3 个字也被拉满）。后果：
        ① 标签一多就把整行撑高（实测 5 个标签 → 标签列 112px > 结构盒 64px ⇒
           那一行 128px，其它行只有 80px，一屏里行高参差）；
        ② 「可购买」下面的 ¥ 掉成第三行、单独一个圆点（用户截图上"孤立的 ¥"）。
      搬到主列下方后：标签拿到**整列宽度**（5~6 个也排得下），高度恒等于一行文字（21px）；
      右列只剩操作按钮 ⇒ 按钮右缘天然对齐，行高重新由结构盒（64px）决定。
   🔴 不设 `max-width`：主列本身就是 `flex: 1; min-width: 0`，可用宽度由它决定，
      再套一层上限只会让宽屏上也提前换行。
   🔴 `.step-row__main` 自己不是 flex 容器（SMILES 的 `-webkit-line-clamp` 需要它是块级），
      所以这里必须显式 `margin-top` 来和上面那行属性拉开距离。 */
.step-row__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 5px;
}

.step-tag {
  /* 横排后不再被拉伸 ⇒ 宽度回到内容宽度；也不许被压缩，否则文字会被压扁 */
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  /* 🔴 行高必须写死，不能靠继承。标签高度 = 行高 + 上下内距(1×2) + 边框(1×2) = 21px。
     为什么：`.step-tag.is-buy` 是 `inline-flex`（里面要放 ¥ 图标），它的文字被包成
     **匿名 flex item**，行盒高度和普通块级标签算出来会差 1px ⇒ 同一排里「可购买」pill
     比兄弟标签矮一截（实测 21px vs 20px，肉眼看得出来）。两边都写死 17px 后都是 21px。 */
  line-height: 17px;
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

/* 「可购买」pill：整块都是查价的**选择热区**（用户要求"整体可以点击选择"）。
   🔴 `el-dropdown` 是它的**父层**（见模板注释）⇒ 这里只负责长得像一个可点的 pill：
      inline-flex 让 ¥ 与文字同一行（否则 pill 变两行、又把整行撑高），
      cursor/hover 让"整块可点"这件事在视觉上成立。 */
.step-tag.is-buy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 3px;
  color: #0369a1;
  background: #e0f2fe;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
}

.step-tag.is-buy:hover {
  background: #bae6fd;
}

/* el-dropdown 自己带一层块级外壳 ⇒ 显式收成 inline-flex，
   否则它会撑满一行、把后面的标签挤到下一行；宽度也必须等于 pill 本身。 */
.step-row__tags :deep(.el-dropdown) {
  display: inline-flex;
  align-items: center;
}

/* 询价图标：¥ 小圆钮（**在「可购买」pill 内**，紧跟文字右侧）。
   现在它只是装饰 —— 热区是整块 pill，所以这里不要单独的 cursor/hover，
   否则鼠标移到圆点上变色、移到文字上不变色，"整块可点"的信号又乱了。 */
.step-row__query {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--rw-brand);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  font-style: normal;
  line-height: 1;
  user-select: none;
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
