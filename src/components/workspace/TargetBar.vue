<script setup lang="ts">
/**
 * 「目标分析」块（左侧栏）—— 当前任务在拆什么 + 已经确认了哪些**路线网络**。
 *
 * 位置：侧栏中「最近的任务」**下方**。
 * 为什么放下面：任务列表才是这一列的主干（可伸缩、超出滚动），
 * 「目标分析」描述的是**当前这一条任务**的细节 —— 先选任务、再看细节，
 * 顺序才和阅读顺序一致（以前压在列表上方，任务一多就被顶得看不见）。
 *
 * 三块内容：
 *   ① **目标分子**：结构缩略图（点开放大）+ 分子式 / MW / 重原子 + SMILES（点一下即复制）
 *   ② **路线网络**：当前这条网络的多步路线（步数 / 分支 / 起始物料 / 最深 / 总概率）
 *      + 这条任务下**已确认的多个网络**（可点切换）+ 各步明细（**逐步画结构式**）
 *   ③ 操作：存为新方案（**只在还没有网络时**）
 *
 * 为什么逐步画结构式而不是写 SMILES：侧栏可用宽只有 ~200px，SMILES 截到 16 个字符
 * （`CC(C)Cc1ccc(C(C)…`）既认不出分子也没法核对这一步在拆什么；结构式一眼能看出来。
 * 完整 SMILES 与「产物 ← 前体」都留在缩略图的 title 里，悬停可核对。
 *
 * 为什么**没有**「切换目标」：同页签正文的「目标分子」卡头部就有一个
 * （TargetOverview），侧栏这条是重复入口；而且它和「存为新方案」并排占掉一行高度，
 * 这行高度给结构式更值。删掉不丢功能 —— 全站仍能从主区切目标。
 *
 * 🔴 「已确认路线」→「路线网络」的语义变化（见 store 的 confirmRouteNetwork）：
 *    一条路线**可以有分支**（多组分反应一步拆出多个前体），那就是一张网而不是一条链；
 *    同一目标下可以确认**多条**网络（例如「小试路线」与「放大路线」），
 *    确认入口在「逆合成树」里（拆完一步觉得对了就确认）。
 * 🔴 所有数字都取 `store.networkStats`（它与网络列表共用 simulateScheme 同一口径），
 *    不在这里自己数 —— 否则同一张网会出现两个步数。
 * 🔴 挂载判据在 AppShell：`!store.targetSetupOpen && !!store.rootId` ——
 *    标定态下目标还没定，显示一屏占位只会碍事。
 * 🔴 侧栏收起（64px）时整块隐藏（见文末 `:global(.app.is-collapsed)`）—— 挤不下，显示也没意义。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { promptSaveScheme } from '@/utils/scheme-save';
import { copyText } from '@/utils/clipboard';
import MolView from '@/components/mol/MolView.vue';
import { routePct } from '@/utils/probability';

const store = useWorkspaceStore();
const emit = defineEmits<{ preview: [smiles: string] }>();

const root = computed(() => (store.rootId ? store.nodes[store.rootId] : undefined));

/** 当前这条路线网络的体检结果（步数 / 分支 / 起始物料 / 最深 / 总概率） */
const cur = computed(() => store.networkStats);
/** 已确认的排前面；未确认的是保存下来做备选对比的草稿 */
const networks = computed(() => store.routeNetworks);
const netCount = computed(() => networks.value.length);

/** 各步明细 —— 从根沿当前采纳的每一步往下（含分支） */
const steps = computed(() => store.route);

/** 一步都还没有时别显示 100.00%（各步连乘的空积就是 1，看起来像"整条路线成立"） */
const totalPct = computed(() =>
  cur.value.steps ? routePct(cur.value.probability, cur.value.manualSteps) : '—'
);

/**
 * 一条路线的总概率。
 * 🔴 含手动步时必须带上「含 N 步手动」：连乘对手动步按 1 计，
 *    这个数字与纯模型路线的总概率**不可比**。口径统一在 utils/probability。
 */
function pct(p: number, manualSteps = 0): string {
  return routePct(p, manualSteps, 1);
}

/** 切换当前查看的是哪一条网络（不删任何节点，见 store.applyScheme） */
function switchNet(id: string): void {
  if (id === store.currentSchemeId) return;
  store.applyScheme(id);
  ElMessage.success('已切到这条路线网络');
}

/** 复制目标分子的 SMILES（走全站唯一入口，见 utils/clipboard.ts） */
async function copySmiles(): Promise<void> {
  const t = root.value;
  if (!t) return;
  // 非 https / 无剪贴板权限时由 copyText 统一降级提示，别让点了没反应
  await copyText(t.smiles, {
    okMsg: '已复制 SMILES',
    failMsg: '浏览器不允许自动复制，请手动选中 SMILES 复制'
  });
}
</script>

<template>
  <section v-if="root" class="tan">
    <!-- 头部排版与「最近的任务」完全一致（11px / 600 / text-3 / 同一缩进），
         这样两段在侧栏里看起来是同一套组件 -->
    <header class="tan__head">
      <span class="tan__title">目标分析</span>
      <span v-if="netCount" class="tan__count">{{ netCount }}</span>
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

    <button type="button" class="tan__smiles" title="点击复制 SMILES" @click="copySmiles">
      <code class="rw-mono">{{ root.smiles }}</code>
      <span class="tan__copy" aria-hidden="true">复制</span>
    </button>

    <!-- ---------- 路线网络 ---------- -->
    <div class="tan__route">
      <div class="tan__route-head">
        <span class="tan__route-label">路线网络</span>
        <span class="tan__route-pct" :title="`各步概率连乘：${totalPct}`">{{ totalPct }}</span>
      </div>

      <!-- 当前这条网络的规模：多步 + 分支才是"网" -->
      <!-- 4 个指标之间加 `·`：200px 宽的一列里，纯空格分隔会糊成"2 步1 分支2/2 物料" -->
      <div class="tan__route-stats">
        <span><b>{{ cur.steps }}</b> 步</span>
        <i aria-hidden="true">·</i>
        <span><b>{{ cur.branches }}</b> 分支</span>
        <i aria-hidden="true">·</i>
        <span><b>{{ cur.terminals }}/{{ cur.leaves }}</b> 物料</span>
        <i aria-hidden="true">·</i>
        <span><b>第 {{ cur.depth }}</b> 层</span>
      </div>

      <!-- 已确认的多个网络：点一条即切过去 -->
      <ul v-if="netCount" class="tan__nets">
        <li
          v-for="n in networks"
          :key="n.schemeId"
          class="tan__net"
          :class="{ 'is-current': n.schemeId === store.currentSchemeId, 'is-confirmed': n.confirmed }"
        >
          <button type="button" class="tan__net-btn" :title="`切到「${n.name}」`" @click="switchNet(n.schemeId)">
            <span class="tan__net-top">
              <span class="tan__net-name">{{ n.name }}</span>
              <span v-if="n.confirmed" class="tan__net-tag">已确认</span>
              <span v-else class="tan__net-tag tan__net-tag--draft">备选</span>
            </span>
            <span class="tan__net-meta">
              {{ n.steps }} 步 · {{ n.branches }} 分支 · {{ pct(n.probability, n.manualSteps) }}
            </span>
          </button>
        </li>
      </ul>

      <p v-else class="tan__hint">
        还没有确认的路线网络 —— 到「<b>逆合成树</b>」里拆出自己满意的多步路线后，点「确认路线网络」。
        同一个目标可以确认多条网络，在这里切换查看。
      </p>

      <!-- 各步明细：这就是"长路线"本身。
           🔴 每一步画**结构式**，不是截断的 SMILES —— 侧栏 ~200px 宽，
              16 个字符的 SMILES 截断后认不出分子；结构式一眼看出这一步在拆什么。
              点缩略图放大（与主区分子小卡同一手势）。
              完整 SMILES 与「产物 ← 前体」留在 title 里，悬停即可核对。 -->
      <ol v-if="steps.length" class="tan__steps">
        <li v-for="s in steps" :key="s.nodeId">
          <span class="tan__step-no">{{ s.step }}</span>
          <button
            type="button"
            class="tan__step-mol"
            :title="`${s.product} ← ${s.precursors.join(' + ')}\n点击放大查看结构式`"
            @click="emit('preview', s.product)"
          >
            <MolView :smiles="s.product" fit :bond-px="20" :min-px="40" :max-px="120" />
          </button>
          <!-- 尾巴（分叉标记 + 概率）包成**定宽**一组 ⇒ 各行给结构式留的宽度一致。
               不给宽度的话「⑂ 90%」比「80%」宽，同一列里盒子的右边界会参差。 -->
          <span class="tan__step-tail">
            <span v-if="s.precursors.length > 1" class="tan__step-branch" title="该步分叉（多组分）">⑂</span>
            <span class="tan__step-p">{{ s.manual ? '手动' : (s.probability * 100).toFixed(0) + '%' }}</span>
          </span>
        </li>
      </ol>
    </div>

    <!-- 「切换目标」已删除（用户要求）：同页签正文的「目标分子」卡头部就有它
         （TargetOverview），侧栏这条属重复入口。合并到 v-if 里 ⇒
         还有网络时整块不渲染（不留一个空的 flex 容器占掉 .tan 的 8px 间距）。 -->
    <div v-if="!netCount" class="tan__ops">
      <el-button size="small" plain @click="promptSaveScheme(store)">存为新方案</el-button>
    </div>
  </section>
</template>

<style scoped>
/* 🔴 不再是「卡片」：与「最近的任务」同为**侧栏里的一段**（无外框 / 无底色），
   否则同一列里一半有框一半没框，视觉层级就乱了。
   左右 12px 与 .recent__head / .recent__item 的文字缩进对齐。 */
.tan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px;
}

.tan__head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--rw-text-3);
  letter-spacing: 0.03em;
}

.tan__count {
  font-variant-numeric: tabular-nums;
}

/* 结构缩略图：与卡片同圆角，hover 变品牌色边提示可点 */
.tan__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 78px;
  padding: 4px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
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

/* SMILES：整行可点即复制（把「复制」小按钮从标题栏挪进来，
   标题栏才能与「最近的任务」保持同一行高） */
.tan__smiles {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: var(--rw-surface-2);
  text-align: left;
  cursor: copy;
  transition: border-color 0.15s, background 0.15s;
}

.tan__smiles:hover {
  border-color: var(--rw-border);
  background: var(--rw-surface-3);
}

.tan__smiles code {
  flex: 1;
  min-width: 0;
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

.tan__copy {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--rw-brand-d);
  opacity: 0;
  transition: opacity 0.15s;
}

.tan__smiles:hover .tan__copy {
  opacity: 1;
}

/* ---------- 路线网络 ---------- */
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
  align-items: center;
  gap: 4px 5px;
  font-size: 11px;
  color: var(--rw-text-3);
}

/* 分隔点：比空格强、比竖线弱 */
.tan__route-stats i {
  font-style: normal;
  opacity: 0.45;
}

.tan__route-stats b {
  color: var(--rw-text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* ---------- 多个网络的列表 ---------- */
/* 🔴 不再自己封顶滚动（原来的 `max-height: 132px` + `overflow-y: auto`）。
   侧栏已改成**整条一个滚动流**（见 AppShell 的 `.app__side-scroll`），
   这里再套一根滚动条 ⇒ 滚轮停在列表上会被截住、要再滚外层才继续，
   正是「两段各自滚动」的同一个毛病。长度交给外层容器。 */
.tan__nets {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tan__net {
  border: 1px solid var(--rw-border);
  border-radius: 5px;
  background: var(--rw-surface);
  transition: border-color 0.15s;
}

.tan__net.is-current {
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
}

/* 已确认 + 当前：左沿加一条品牌色实线，一眼看出"这条正在用" */
.tan__net.is-confirmed {
  border-left: 2px solid var(--rw-ok);
}

.tan__net-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 4px 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.tan__net-top {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.tan__net-name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--rw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tan__net.is-current .tan__net-name {
  font-weight: 600;
  color: var(--rw-brand-d);
}

.tan__net-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--rw-ok-l);
  color: var(--rw-ok);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.tan__net-tag--draft {
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-weight: 500;
}

.tan__net-meta {
  font-size: 10.5px;
  color: var(--rw-text-3);
  font-variant-numeric: tabular-nums;
}

/* ---------- 各步明细 ---------- */
/* 同 `.tan__nets`：不封顶、不自己滚 —— 整条侧栏共用一个滚动条。 */
.tan__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
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

/* 结构式缩略图：占满中间剩余宽度。
   定尺寸盒子 + `fit` ⇒ smiles-drawer 的 SVG 按 viewBox 等比缩放，大分子不被裁
   （与主区分子小卡同一个做法）。hover 变品牌色边，提示「点开放大」。 */
.tan__step-mol {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 1px 4px;
  border: 1px solid var(--rw-border);
  border-radius: 4px;
  background: var(--rw-surface-2);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color 0.15s;
}

.tan__step-mol:hover {
  border-color: var(--rw-brand);
}

/* 尾巴：分叉标记 + 概率，**定宽**一组。
   定宽是为了让结构式盒子的左右边界逐行对齐 —— 概率 2~3 位数、「⑂」有行无行，
   不给宽度则每行剩余宽度不同，同一列里的盒子就会参差
   （`tabular-nums` 只保证数字等宽，管不了"有没有⑂"和位数）。 */
.tan__step-tail {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-width: 44px;
}

/* 分叉标记：这一步是多组分反应（父节点在此分成多条支线） */
.tan__step-branch {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 1;
  color: var(--rw-ok);
}

.tan__step-p {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--rw-text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.tan__hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--rw-text-3);
}

.tan__hint b {
  color: var(--rw-text-2);
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
