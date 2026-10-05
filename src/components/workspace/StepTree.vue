<script setup lang="ts">
/** 路线树容器：工具条 + 根节点递归渲染 */
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import StepRow from './StepRow.vue';

const emit = defineEmits<{ preview: [smiles: string] }>();
const store = useWorkspaceStore();

const stats = computed(() => store.stats);

async function onSave(): Promise<void> {
  if (!store.rootId) {
    ElMessage.warning('还没有路线可保存');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt('给这个任务起个名字', '保存到历史', {
      inputPlaceholder: '例如：布洛芬路线 v1',
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    });
    store.saveHistory(value?.trim() || '');
    ElMessage.success('已保存到历史记录');
  } catch {
    /* 用户取消 */
  }
}

async function onReset(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空当前整棵路线树（参数保留），确定吗？', '清空工作台', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  store.reset({ keepParams: true });
}
</script>

<template>
  <section class="rw-card tree">
    <div class="rw-card__head">
      <div class="rw-card__title">③ 路线树</div>
      <div class="tree__ops">
        <el-button link size="small" @click="store.collapseAll()">折叠全部</el-button>
        <el-button link size="small" @click="store.expandAll()">展开全部</el-button>
        <el-button link size="small" type="primary" @click="onSave">保存</el-button>
        <el-button link size="small" type="danger" @click="onReset">清空</el-button>
      </div>
    </div>

    <div class="tree__stats">
      <span>节点 <b>{{ stats.total }}</b></span>
      <span>已终止 <b>{{ stats.terminal }}</b></span>
      <span>已采纳步骤 <b>{{ stats.reactions }}</b></span>
      <span>最深 <b>第 {{ stats.maxDepth + 1 }} 层</b></span>
    </div>

    <div class="rw-card__body tree__body rw-scroll">
      <StepRow v-if="store.rootId" :node-id="store.rootId" @preview="(s) => emit('preview', s)" />
      <el-empty v-else description="先在左侧解析一个目标分子，然后点「展开」一步步往下拆" :image-size="80" />
    </div>
  </section>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.tree__ops {
  display: flex;
  align-items: center;
  gap: 2px;
}

.tree__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--rw-border);
  background: var(--rw-surface-2);
  font-size: 12px;
  color: var(--rw-text-3);
}

.tree__stats b {
  color: var(--rw-text);
  font-weight: 600;
}

.tree__body {
  flex: 1;
  min-height: 240px;
  max-height: calc(100vh - 260px);
  padding: 10px 12px;
}
</style>
