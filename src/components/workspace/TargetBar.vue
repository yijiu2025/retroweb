<script setup lang="ts">
/**
 * 目标分子条 —— 已设定目标后，路线区顶部的一条窄栏。
 *
 * 设定目标后，中间那张标定大卡片整体消失（工作台切到路线态），
 * 目标信息就降级成这里的一条：结构缩略 + 分子式/分子量/重原子 + 「换目标」。
 * 「换目标」把标定卡片**重新打开**（store.targetSetupOpen = true），
 * 而不是就地展开 —— 换目标是一个「新任务的开头」，应该回到那个语境里。
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import MolView from '@/components/mol/MolView.vue';

const store = useWorkspaceStore();

const target = computed(() => {
  const root = store.rootId ? store.nodes[store.rootId] : undefined;
  if (!root) return null;
  return {
    smiles: root.smiles,
    formula: root.formula || '',
    mw: root.mw,
    atoms: root.atoms
  };
});

const emit = defineEmits<{ preview: [smiles: string] }>();
</script>

<template>
  <div v-if="target" class="tbar rw-card">
    <button
      type="button"
      class="tbar__mol"
      title="点击放大查看"
      @click="emit('preview', target.smiles)"
    >
      <MolView :smiles="target.smiles" fit />
    </button>

    <div class="tbar__info">
      <div class="tbar__label">
        目标分子
        <el-tag size="small" type="success" effect="light">已设定</el-tag>
      </div>
      <div class="tbar__props">
        <span v-if="target.formula">{{ target.formula }}</span>
        <span v-if="target.mw"><i>MW</i> {{ target.mw }}</span>
        <span v-if="target.atoms"><i>重原子</i> {{ target.atoms }}</span>
      </div>
    </div>

    <code class="rw-mono tbar__smiles">{{ target.smiles }}</code>

    <div class="tbar__ops">
      <el-tooltip content="回到标定面板，换一个目标分子（会开始一个新任务）" placement="left">
        <el-button size="small" plain @click="store.openTargetSetup()">换目标</el-button>
      </el-tooltip>
    </div>
  </div>
</template>

<style scoped>
.tbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}

.tbar__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  flex: 0 0 56px;
  padding: 0;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  overflow: hidden;
  cursor: zoom-in;
}

.tbar__info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex-shrink: 0;
}

.tbar__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-text-2);
}

.tbar__props {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--rw-text-2);
}

.tbar__props span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}

.tbar__props i {
  font-style: normal;
  color: var(--rw-text-3);
}

.tbar__smiles {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--rw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tbar__ops {
  flex-shrink: 0;
}
</style>
