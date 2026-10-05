<script setup lang="ts">
/**
 * 工作台：左栏（目标分子 + 运行参数），右栏（路线方案 + 路线树 / 合成路线 / 每步流程）。
 *
 * 版式要点：
 *   - 左栏 336px **自适应**（`clamp`）：宽屏不多占，窄屏不挤压主区。
 *   - 目标分子设定成功后自动收成胶囊 ⇒ 左栏常态只剩运行参数，垂直空间全归主区。
 *   - 任务会话已移入左侧导航栏底部（不再占左栏）。
 *
 * 断点：≥1180px 双栏；<1180px 单栏纵向堆叠；<768px 行卡片化（由各组件自身适配）。
 */
import { computed, onMounted, ref } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import TargetInput from '@/components/workspace/TargetInput.vue';
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
  <div class="workspace">
    <div class="workspace__left">
      <TargetInput />
      <RunParams />
    </div>

    <div class="workspace__right">
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

    <el-dialog v-model="previewVisible" :title="'结构预览'" width="560" align-center>
      <div class="workspace__preview">
        <MolView :smiles="previewSmiles" :bond-px="52" :min-px="200" :max-px="520" />
        <code class="rw-mono">{{ previewSmiles }}</code>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.workspace {
  display: grid;
  /* 自适应左栏：384px 是给「完整输入区」留的，但输入区只在开头用一次，
     日常是胶囊态（几乎不占宽）⇒ 用 clamp 让宽屏收到 336px、窄屏到 300px */
  grid-template-columns: clamp(300px, 22vw, 340px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.workspace__left {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.workspace__right {
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

@media (max-width: 1180px) {
  .workspace {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
