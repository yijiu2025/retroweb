<script setup lang="ts">
/**
 * 工作台。两种版式，由 `store.targetSetupOpen` 决定（见该字段注释）：
 *
 * ┌─ 标定态（首次进入 / 点「换目标」）───────────────────────────────┐
 * │  整屏居中的一张大卡片：结构式画布 + 粘贴框 + 运行参数。            │
 * │  设定目标并分析后，这张卡**整体消失**。                          │
 * └──────────────────────────────────────────────────────────────────┘
 * ┌─ 路线态（已有目标）──────────────────────────────────────────────┐
 * │  顶部：目标分子条（结构缩略 + 性质 + 换目标）                     │
 * │  主区：路线树 / 合成路线 / 每步流程 三页签（**单列，独占整宽**）  │
 * │  底部：状态底栏（见 RouteStats，由 AppShell 挂在内容区末尾）      │
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
import TargetSetupPanel from '@/components/workspace/TargetSetupPanel.vue';
import TargetBar from '@/components/workspace/TargetBar.vue';
import StepTree from '@/components/workspace/StepTree.vue';
import RouteSummary from '@/components/workspace/RouteSummary.vue';
import RouteFlow from '@/components/workspace/RouteFlow.vue';
import SchemeBar from '@/components/workspace/SchemeBar.vue';
import MolView from '@/components/mol/MolView.vue';

const store = useWorkspaceStore();

/** 页签放在 store 里：路线树里点「工艺分析」能直接跳到「每步流程」并聚焦该步 */
const tab = computed<'tree' | 'route' | 'flow'>({
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

onMounted(() => {
  void store.loadModels();
  // 大模型是否配置（决定「AI 分析」可用 / 还是提示去填 .env）
  void store.loadLlmStatus();
  // 刷新网页后：自动恢复最近一个未完成 / 进行中的会话，并续上还在跑的节点轮询
  store.resumeSessions();
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
  <div v-else class="workspace">
    <TargetBar @preview="openPreview" />
    <SchemeBar />

    <el-alert type="warning" :closable="false" class="workspace__alert">
      <template #title>
        模型预测可能存在幻觉：排名越靠后越可能不合理，实验前必须由专业人员验证。
      </template>
    </el-alert>

    <el-alert
      v-if="store.globalError"
      type="error"
      :closable="true"
      :title="store.globalError"
      class="workspace__alert"
      @close="store.globalError = null"
    />

    <el-tabs v-model="tab" class="workspace__tabs">
      <el-tab-pane label="路线树" name="tree">
        <StepTree @preview="openPreview" />
      </el-tab-pane>
      <el-tab-pane label="合成路线" name="route">
        <RouteSummary />
      </el-tab-pane>
      <el-tab-pane label="每步流程" name="flow">
        <RouteFlow />
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="previewVisible" :title="'结构预览'" width="560" align-center>
      <div class="workspace__preview">
        <MolView :smiles="previewSmiles" :bond-px="52" :min-px="200" :max-px="520" />
        <code class="rw-mono">{{ previewSmiles }}</code>
      </div>
    </el-dialog>
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
  min-height: calc(100vh - var(--rw-header-h) - 36px);
}

/* 路线态：单列纵向流。
   参数栏已抬到 AppShell 的右辅助面板 ⇒ 这里不必再有第二列栅格、
   不必自己算 sticky 高度，也不必再维护「收起 / 展开」两套栅格列宽。 */
.workspace {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.workspace__alert :deep(.el-alert__title) {
  font-size: 12.5px;
}

.workspace__tabs :deep(.el-tabs__content) {
  overflow: visible;
}

.workspace__preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.workspace__preview code {
  font-size: 12px;
  color: var(--rw-text-2);
  word-break: break-all;
  text-align: center;
}
</style>
