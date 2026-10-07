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
    <!-- 头部 = 左统计 chips + 右工具按钮。
         不再放「路线树」大标题：外层页签已经说明语境，重复标题只会浪费一行 -->
    <div class="rw-card__head">
      <div class="tree__stats">
        <span class="tree__stat">节点 <b>{{ stats.total }}</b></span>
        <span class="tree__stat">已终止 <b>{{ stats.terminal }}</b></span>
        <span class="tree__stat">已采纳步骤 <b>{{ stats.reactions }}</b></span>
        <span class="tree__stat">最深 <b>第 {{ stats.maxDepth + 1 }} 层</b></span>
      </div>
      <div class="tree__ops">
        <el-button link size="small" @click="store.collapseAll()">折叠全部</el-button>
        <el-button link size="small" @click="store.expandAll()">展开全部</el-button>
        <el-button link size="small" type="primary" @click="onSave">保存</el-button>
        <el-button link size="small" type="danger" @click="onReset">清空</el-button>
      </div>
    </div>

    <div class="rw-card__body tree__body rw-scroll">
      <StepRow v-if="store.rootId" :node-id="store.rootId" @preview="(s) => emit('preview', s)" />
      <el-empty v-else description="先设定目标分子并拆解，路线会在这里逐层长出来" :image-size="80" />
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

/* 统计 chips：并入头部后由「一条灰行」变成「一组轻量徽标」，信息不变、层级更清爽 */
.tree__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tree__stat {
  padding: 2px 9px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  background: var(--rw-surface-2);
  font-size: 11.5px;
  color: var(--rw-text-3);
  white-space: nowrap;
}

.tree__stat b {
  color: var(--rw-text);
  font-weight: 600;
  margin-left: 2px;
}

.tree__body {
  flex: 1;
  min-height: 240px;
  max-height: calc(100vh - 260px);
  padding: 10px 12px;
}
</style>
