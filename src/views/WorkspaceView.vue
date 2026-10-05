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
 * │  主区：路线树 / 合成路线 / 每步流程 三页签                        │
 * │  右栏：运行参数，**可伸缩** —— 收起后主区独占整宽                │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 「一个目标分析 = 一个任务」：标定卡片消失 = 任务正式开始；
 * 换目标 = 回到标定态 = 开始下一个任务的准备。
 *
 * 断点：≥1180px 双栏；<1180px 单栏纵向堆叠；<768px 由各组件自身适配。
 */
import { computed, onMounted, ref } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import TargetSetupPanel from '@/components/workspace/TargetSetupPanel.vue';
import TargetBar from '@/components/workspace/TargetBar.vue';
import RunParams from '@/components/workspace/RunParams.vue';
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

  <!-- ============ 路线态 ============ -->
  <div v-else class="workspace" :class="{ 'workspace--narrow': store.paramsCollapsed }">
    <div class="workspace__main">
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
    </div>

    <!-- 右栏：运行参数，可伸缩 -->
    <aside class="workspace__side" :class="{ 'is-collapsed': store.paramsCollapsed }">
      <button
        type="button"
        class="workspace__side-toggle"
        :title="store.paramsCollapsed ? '展开运行参数' : '收起运行参数'"
        @click="store.paramsCollapsed = !store.paramsCollapsed"
      >
        <span class="workspace__side-chevron">{{ store.paramsCollapsed ? '‹' : '›' }}</span>
        <span v-show="!store.paramsCollapsed">运行参数</span>
      </button>

      <div v-show="!store.paramsCollapsed" class="workspace__side-body rw-scroll">
        <RunParams />
      </div>
    </aside>

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
.workspace__layer {
  position: relative;
  min-height: calc(100vh - 60px - 36px);
}

.workspace {
  display: grid;
  /* 主区优先；右栏固定 300px（参数是被查参考，不是主战场） */
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 16px;
  align-items: start;
}

/* 参数收起后主区独占整宽 */
.workspace--narrow {
  grid-template-columns: minmax(0, 1fr) 40px;
}

.workspace__main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

/* ---------- 右栏（运行参数） ---------- */
.workspace__side {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: sticky;
  /* 顶栏 60px + 内容区上边距 18px */
  top: 0;
  max-height: calc(100vh - 60px - 36px);
  min-width: 0;
}

.workspace__side-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s, border-color 0.15s;
}

.workspace__side-toggle:hover {
  color: var(--rw-brand);
  border-color: var(--rw-brand);
}

/* 收起后按钮变窄条：竖排字会让它变得很高，改用单个 chevron */
.workspace__side.is-collapsed .workspace__side-toggle {
  padding: 8px 0;
}

.workspace__side-chevron {
  font-size: 15px;
  line-height: 1;
}

.workspace__side-body {
  overflow-y: auto;
  min-height: 0;
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

/* 窄屏：参数栏不再贴右，改为堆到主区下面 */
@media (max-width: 1180px) {
  .workspace,
  .workspace--narrow {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace__side {
    position: static;
    max-height: none;
  }

  /* 窄屏下收起态就别留一条竖栏了，直接藏掉内容、按钮横过来 */
  .workspace__side.is-collapsed .workspace__side-toggle {
    padding: 10px 12px;
  }
}
</style>
