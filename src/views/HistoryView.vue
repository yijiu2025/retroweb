<script setup lang="ts">
/** 历史任务（localStorage）：可载入 / 删除 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete } from '@element-plus/icons-vue';
import { useWorkspaceStore } from '@/stores/workspace';
import { absoluteTime } from '@/utils/time';
import MolView from '@/components/mol/MolView.vue';

const store = useWorkspaceStore();
const router = useRouter();

const tasks = computed(() => store.history);

async function onLoad(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('载入该任务会覆盖当前工作台内容，确定吗？', '载入任务', {
      type: 'warning',
      confirmButtonText: '载入',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  store.loadHistory(id);
  ElMessage.success('已载入');
  void router.push('/');
}

async function onRemove(id: string): Promise<void> {
  try {
    await ElMessageBox.confirm('确定删除这条历史记录？', '删除', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  store.removeHistory(id);
}
</script>

<template>
  <section class="rw-card history">
    <div class="rw-card__head">
      <div class="rw-card__title">历史任务</div>
      <span class="history__count">共 {{ tasks.length }} 条</span>
    </div>

    <div class="rw-card__body">
      <el-empty v-if="!tasks.length" description="还没有保存过任务；在工作台点「保存」即可沉淀" />

      <div v-else class="history__grid">
        <div v-for="task in tasks" :key="task.id" class="history-item">
          <div class="history-item__mol">
            <MolView :smiles="task.target" fit />
          </div>
          <div class="history-item__body">
            <div class="history-item__name">{{ task.name }}</div>
            <code class="rw-mono history-item__smiles">{{ task.target }}</code>
            <div class="history-item__meta">
              <span>{{ absoluteTime(task.createdAt) }}</span>
              <span>模型 {{ task.params.model }}</span>
              <span>节点 {{ Object.keys(task.nodes).length }}</span>
            </div>
          </div>
          <div class="history-item__ops">
            <el-button size="small" type="primary" @click="onLoad(task.id)">载入</el-button>
            <el-button size="small" :icon="Delete" @click="onRemove(task.id)" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.history__count {
  font-size: 12px;
  color: var(--rw-text-3);
}

.history__grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

.history-item:hover {
  border-color: var(--rw-brand);
}

.history-item__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 88px;
  flex: 0 0 120px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface-2);
  overflow: hidden;
}

.history-item__body {
  flex: 1;
  min-width: 0;
}

.history-item__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--rw-text);
}

.history-item__smiles {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--rw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-item__meta {
  display: flex;
  gap: 14px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.history-item__ops {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
</style>
