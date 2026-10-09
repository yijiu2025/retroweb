<script setup lang="ts">
/**
 * 工作台。两种版式，由 `store.targetSetupOpen` 决定（见该字段注释）：
 *
 * ┌─ 标定态（首次进入 / 点「换目标」）───────────────────────────────┐
 * │  整屏居中的一张大卡片：结构式画布 + 粘贴框 + 运行参数。            │
 * │  设定目标并分析后，这张卡**整体消失**。                          │
 * └──────────────────────────────────────────────────────────────────┘
 * ┌─ 路线态（已有目标）──────────────────────────────────────────────┐
 * │  顶部：通知条（合规提示可关闭）                                   │
 * │  主区：目标分析 / 逆合成树 / 路线网络 / 步骤详情 四页签            │
 * │        **默认「目标分析」**（目标分子 + 已确认路线），不直接甩树  │
 * │        🔴 页签在最上面，路线方案栏（有方案才出现）夹在**页签与内容  │
 * │           之间**——见 el-tabs 里那段的注释；「目标分析」页签下整条  │
 * │           不渲染（与正文卡重复）                                  │
 * │  左栏：目标分析卡（结构 + 已确认路线摘要），与「最近的任务」并列   │
 * │  右栏：运行参数 / 方案对比，底部挂状态条（见 RouteStats）          │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 🔴 路线态为什么不再自带参数栏：
 *    参数栏以前是本视图栅格的第 2 列（300px）。抬到 AppShell 的右辅助面板后，
 *    本视图变成**单列**，栅格、伸缩、sticky 高度统统不用自己管了，
 *    「参数」也终于能被别的页面复用同一个槽位。
 *    ⇒ 本文件不再 import RunParams / 不再持有 paramsCollapsed。
 *
 * 「一个目标分析 = 一个任务」：标定卡片消失 = 任务正式开始；
 * 换目标 = 回到标定态 = 开始下一个任务的准备。
 *
 * 断点：内容区宽 <1180px 时右辅助面板堆到下方（由 AppShell 统一处理）。
 */
import { computed, onMounted, ref } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import { useSettingsStore } from '@/stores/settings';
import TargetSetupPanel from '@/components/workspace/TargetSetupPanel.vue';
import TargetOverview from '@/components/workspace/TargetOverview.vue';
import StepTree from '@/components/workspace/StepTree.vue';
import RouteCanvas from '@/components/workspace/RouteCanvas.vue';
import RouteFlow from '@/components/workspace/RouteFlow.vue';
import SchemeBar from '@/components/workspace/SchemeBar.vue';
import MolPreviewDialog from '@/components/mol/MolPreviewDialog.vue';
import StepEditDialog from '@/components/workspace/StepEditDialog.vue';

const store = useWorkspaceStore();
const settings = useSettingsStore();

/**
 * 页签放在 store 里：路线树里点「工艺分析」能直接跳到「步骤详情」并聚焦该步。
 * 默认值也是 store 给的（`overview` = 目标分析总览，见 store.mainTab 注释）。
 */
const tab = computed<'overview' | 'tree' | 'route' | 'flow'>({
  get: () => store.mainTab,
  set: (v) => {
    store.mainTab = v;
  }
});

const previewVisible = ref(false);
const previewSmiles = ref('');

function openPreview(smiles: string): void {
  previewSmiles.value = smiles;
  previewVisible.value = true;
}

/**
 * 错误文案人性化：store.globalError 里常落着 axios 的原始 message
 * （「Request failed with status code 502」），对用户是噪音。
 * 这里把可识别的模式翻成人话；翻不出的原样透出。
 */
function humanizeError(msg: string): string {
  const m = msg.match(/status code (\d{3})/i);
  if (m) {
    const code = m[1];
    if (code.startsWith('5')) return `后端服务暂不可用（HTTP ${code}）：请确认后端 API 已启动，或稍后重试`;
    if (code === '401') return '登录已过期（HTTP 401），请重新登录';
    if (code === '404') return '接口不存在（HTTP 404）：前后端版本可能不一致';
    return `请求失败（HTTP ${code}）`;
  }
  if (/network error/i.test(msg)) return '网络错误：无法连接后端服务';
  if (/timeout of|timeout/i.test(msg)) return '请求超时：后端响应时间过长，可稍后重试';
  return msg;
}

onMounted(() => {
  void store.loadModels();
  // 大模型是否配置（决定「AI 分析」可用 / 还是提示去填 .env）
  void store.loadLlmStatus();
  // 刷新网页后：自动恢复最近一个未完成 / 进行中的会话，并续上还在跑的节点轮询
  void store.resumeSessions();
});
</script>

<template>
  <!-- ============ 标定态：整屏居中的大卡片 ============
       🔴 注意这里包了一层 `.workspace__layer`（position: relative）。
       标定卡片用 position:absolute + inset:0 脱离文档流，
       它需要一个"相对整个内容区"的定位祖先 —— 直接挂在 .app__content 下面
       会去找更外层的定位祖先（可能是 body），居中基准就错了。
  -->
  <div v-if="store.targetSetupOpen" class="workspace__layer">
    <TargetSetupPanel />
  </div>

  <!-- ============ 路线态 ============
       🔴 单列：参数栏已交给 AppShell 的右辅助面板，这里不再有第二列栅格。 -->
  <div v-else class="workspace" :class="{ 'is-canvas': tab === 'route' }">
    <!-- 目标分子已移到左侧栏的「目标分析」卡（与「最近的任务」并列），
         主区顶部不再占这一行 —— 见 AppShell 的 .app__target。 -->

    <!-- 路线方案栏（`SchemeBar`）**已挪进下面的 `<el-tabs>`**：
         用户要的顺序是「页签在顶部 → 路线网络栏 → 内容」，
         而 Element Plus 会把 `el-tabs` 的默认插槽渲染进 `.el-tabs__content`
         ⇒ 把它放在页签之后，就正好夹在**页签与内容之间**。 -->

    <!-- 通知区：合规提示 + 全局错误。统一的轻量细条（替代 el-alert 的大色块，
         两条摞在一起时不再把工作台顶成「告警大杂烩」） -->
    <div class="workspace__notices">
      <!-- 合规提示可以关掉（状态落盘），在「目标分析」总览页可重新打开 -->
      <div v-if="!settings.hideDisclaimer" class="workspace__notice workspace__notice--warn">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2 15 14H1L8 2Z" />
          <path d="M8 6.6v3.2M8 12.1v.1" />
        </svg>
        <span class="workspace__notice-text">
          模型预测可能存在幻觉：排名越靠后越可能不合理，实验前必须由专业人员验证。
        </span>
        <button
          type="button"
          class="workspace__notice-close"
          title="关闭该提示（可在「目标分析」页重新打开）"
          aria-label="关闭"
          @click="settings.hideDisclaimer = true"
        >
          ×
        </button>
      </div>

      <div v-if="store.globalError" class="workspace__notice workspace__notice--error">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 5v3.6M8 11.1v.1" />
        </svg>
        <span class="workspace__notice-text">{{ humanizeError(store.globalError) }}</span>
        <!-- 「重试」重做**刚才失败的那件事**（store.errorRetry），比刷新页面安全：
             刷新会丢掉还没保存的路线树 -->
        <button
          v-if="store.errorRetry"
          type="button"
          class="workspace__notice-btn"
          @click="store.retryError()"
        >
          重试
        </button>
        <button
          type="button"
          class="workspace__notice-close"
          aria-label="关闭"
          @click="store.clearGlobalError()"
        >
          ×
        </button>
      </div>
    </div>

    <el-tabs v-model="tab" class="workspace__tabs">
      <!-- 🔴 路线方案栏夹在**页签与内容之间**：
           用户要的顺序是「页签在顶部 → 路线网络栏 → 内容」。
           Element Plus 把 `el-tabs` 的默认插槽整块渲染进 `.el-tabs__content`
           （`tabs.mjs`：`panels = h('div', { class: 'el-tabs__content' }, [renderSlot(slots, 'default')])`），
           所以把 `SchemeBar` 放在**页签之后、第一个 `el-tab-pane` 之前**，
           它就会落在页签下方、内容上方；不必自己拆 el-tabs 的 header / content。

           非页签子节点不会污染页签导航 —— `useOrderedChildren` 只按
           `type.name === 'ElTabPane'` 收集（`getOrderedChildren` 里那行 filter）。

           可见性沿用既定口径：有方案才渲染；**「目标分析」页签下整条不渲染**
           （该页签正文的「路线网络」卡已经把同一份 `routeNetworks` 画过一遍且带总概率，
           顶栏再挂一条 ⇒ 同一份数据一屏出现两次，用户不知道该看哪一个）。 -->
      <div
        v-if="store.schemeStats.length && store.mainTab !== 'overview'"
        class="workspace__schemes"
      >
        <SchemeBar />
      </div>
      <!-- 默认页签：打开任务先看「在拆什么 + 已确认到哪一步」，而不是一屏未成形的树 -->
      <el-tab-pane label="目标分析" name="overview">
        <TargetOverview @preview="openPreview" />
      </el-tab-pane>
      <el-tab-pane label="逆合成树" name="tree">
        <StepTree @preview="openPreview" />
      </el-tab-pane>
      <el-tab-pane label="路线网络" name="route">
        <RouteCanvas @preview="openPreview" />
      </el-tab-pane>
      <el-tab-pane label="步骤详情" name="flow">
        <RouteFlow />
      </el-tab-pane>
    </el-tabs>

    <MolPreviewDialog v-model="previewVisible" :smiles="previewSmiles" />

    <!-- 「编辑这一步」（手改前体）：入口有两条 —— 路线网络里双击卡片、候选面板的按钮，
         而弹窗里装着 Ketcher 画板（首次要拉约 16MB 内核）。全应用只挂这一份，
         挂两份就是两个 React root + 两份 WASM 常驻内存。开关状态在 store 里。
         @preview：弹窗里每一行的结构式缩略图点开放大 —— 复用上面这个预览弹窗实例。 -->
    <StepEditDialog @preview="openPreview" />
  </div>
</template>

<style scoped>
/* 标定态的定位层：铺满内容区，给内部 absolute 的卡片当坐标系。
   `min-height` 与路线态的可用高度一致（内容区高度 = 100vh - 顶栏 60 - 上下 padding 36），
   这样卡片居中才落在视觉中心，而不是被内容区高度差带偏。 */
/* 标定态的定位层：铺满内容区，给内部 absolute 的卡片当坐标系。
   `min-height` 与路线态的可用高度一致（内容区高度 = 100vh − 顶栏 − 上下 padding 36），
   这样卡片居中才落在视觉中心，而不是被内容区高度差带偏。
   🔴 顶栏高度走变量 `--rw-header-h`，**不要就地写 60px** ——
      顶栏高度是 AppShell / AsidePanel / 这里三处共用的一个数，
      一旦各自写死，改顶栏就会只改到一处（这正是这次重构前的老问题）。 */
.workspace__layer {
  position: relative;
  min-height: calc(100vh - var(--rw-header-h) - var(--rw-content-pad-y) * 2);
}

/* 路线态：单列纵向流。
   参数栏已抬到 AppShell 的右辅助面板 ⇒ 这里不必再有第二列栅格、
   不必自己算 sticky 高度，也不必再维护「收起 / 展开」两套栅格列宽。 */
.workspace {
  display: flex;
  flex-direction: column;
  /* 顶部到主区整条竖栈都吃这个间距，10px 比 12px 更紧但仍分得开各块 */
  gap: 10px;
  min-width: 0;
}

/* ---------- 「路线网络」页签：把一屏的高度让给画布 ----------
   这个页签的主角是一整块画布，它的高度应当由**剩余空间**决定，而不是由内容决定：
   窗口越高画布越大，用户要的"画布面积足够大"就是这个意思。
   🔴 只在这个页签启用 —— 其它页签是长文，让它们撑满一屏只会把内容裁掉。

   高度链（缺一环画布就退回内容高度）：
     .workspace(min-height 保底)
       → .el-tabs            (flex:1)
         → .el-tabs__content (flex:1)
           → .el-tab-pane    (flex:1)
             → .rcanvas      (height:100%)
               → … → .rcanvas__wrap (flex:1)
   Element Plus 自带 `el-tabs{display:flex}`（`--top` 时 flex-direction: column）
   与 `el-tabs__content{flex-grow:1}`，所以只补上面缺的几环。 */
.workspace.is-canvas {
  /* 🔴 必须是**确定高度**（`height`，不是 `min-height`）：
     flex 链下一环的 `flex: 1` 只有在容器高度确定时才会真正分配到空间。
     容器高度 auto 的话，`.rcanvas__wrap` 会退回"由内容决定"，
     而它的内容（sizer）高度又依赖 wrap 自身高度
     （`max(画布, 容器) + 余量`）⇒ 正反馈，画布一路涨到几万像素（实测 95480px）。
     钉死高度后这条环就断开了。 */
  height: calc(100vh - var(--rw-header-h) - var(--rw-content-pad-y) * 2);
  /* 兜底：窗口很矮时保住画布下限（≥ 其自身 320px 的 min-height + 上方各块），
     宁可整页滚动也不把画布压扁。 */
  min-height: 480px;
}

.workspace.is-canvas :deep(.el-tabs) {
  flex: 1;
  min-height: 0;
}

/* 🔴 content 必须变成纵向 flex：它里面除了页签还夹着「路线方案栏」，
     两者要竖着排 —— 方案栏占自身高度、页签吃掉剩下的。
     不这么做的话，pane 的 height:100% 会按 content 的**整个**高度算，
     跟方案栏叠在一起把画布顶出容器。 */
.workspace.is-canvas :deep(.el-tabs__content) {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.workspace.is-canvas :deep(.el-tab-pane) {
  flex: 1;
  min-height: 0;
}

.workspace__alert :deep(.el-alert__title) {
  font-size: 12.5px;
}

/* ---------- 通知区（警告 / 错误统一形态） ----------
   细边 + 极浅底 + 小图标，比 el-alert 少一半视觉重量；
   语义色只落在图标与描边上，正文保持可读的中性色。
   容器只负责堆叠间距 —— 两条同时出现时各自成行，不再互相挤。 */
.workspace__notices {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.workspace__notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: var(--rw-radius-sm);
  font-size: 12px;
  line-height: 1.5;
  color: var(--rw-text-2);
}

.workspace__notice > svg {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 正文吃掉剩余宽度，把「重试 / 关闭」稳定推到最右 */
.workspace__notice-text {
  flex: 1;
  min-width: 0;
}

.workspace__notice--warn {
  border: 1px solid color-mix(in srgb, var(--rw-warn) 38%, transparent);
  background: var(--rw-warn-l);
}

.workspace__notice--warn > svg {
  color: var(--rw-warn);
}

.workspace__notice--error {
  border: 1px solid color-mix(in srgb, var(--rw-bad) 38%, transparent);
  background: var(--rw-bad-l);
}

.workspace__notice--error > svg {
  color: var(--rw-bad);
}

/* 「重试」：语义色描边小按钮 —— 有重试动作时才渲染 */
.workspace__notice-btn {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--rw-bad) 42%, transparent);
  border-radius: 5px;
  background: var(--rw-surface);
  color: var(--rw-bad);
  font-size: 11.5px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.15s;
}

.workspace__notice-btn:hover {
  background: var(--rw-bad-l);
}

.workspace__notice-close {
  flex-shrink: 0;
  padding: 0 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 15px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.workspace__notice-close:hover {
  color: var(--rw-text);
  background: var(--rw-surface-3);
}

/* 路线方案栏的外壳：它现在在 `.el-tabs__content` 里（页签与内容之间），
   拿不到 `.workspace` 的 gap ⇒ 下边距要自己带，否则会贴住下方内容。
   （与页签 header 的 `margin-bottom: 12px` 一起构成「页签 / 方案栏 / 内容」三段呼吸） */
.workspace__schemes {
  margin-bottom: 10px;
}

/* ---------- 页签 ----------
   压缩：Element Plus 默认 header 40px，这里收到 34px；
   选中态换成「品牌色 + 加粗 + 2px 圆角下划线」，比默认的细灰线更明确。 */
.workspace__tabs :deep(.el-tabs__header) {
  margin-bottom: 12px;
}

.workspace__tabs :deep(.el-tabs__item) {
  height: 34px;
  line-height: 34px;
  padding: 0 16px;
  font-size: 13px;
  color: var(--rw-text-2);
  transition: color 0.15s;
}

.workspace__tabs :deep(.el-tabs__item:hover) {
  color: var(--rw-text);
}

.workspace__tabs :deep(.el-tabs__item.is-active) {
  color: var(--rw-brand);
  font-weight: 600;
}

.workspace__tabs :deep(.el-tabs__active-bar) {
  height: 2px;
  border-radius: 2px;
  background: var(--rw-brand);
}

.workspace__tabs :deep(.el-tabs__nav-wrap::after) {
  height: 1px;
  background: var(--rw-border);
}

.workspace__tabs :deep(.el-tabs__content) {
  overflow: visible;
}
</style>
