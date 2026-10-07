<script setup lang="ts">
/**
 * 结构放大预览弹窗。
 *
 * 抽成独立组件的原因：**两个地方都要用** ——
 *   ① 左侧栏「目标分析」卡（点目标结构缩略图）；
 *   ② 主区逆合成树 / 路线网络（点某个中间体）。
 * 各写一份的话，`align-center` 那条 Element Plus 的坑（默认是顶部对齐，
 * 必须显式 `align-center` 才是真居中）迟早会在其中一处漏掉。
 */
import { computed } from 'vue';
import MolView from './MolView.vue';

const props = defineProps<{ modelValue: boolean; smiles: string; title?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
});
</script>

<template>
  <el-dialog v-model="open" :title="props.title || '结构预览'" width="560" align-center>
    <div class="pv">
      <MolView :smiles="props.smiles" :bond-px="52" :min-px="200" :max-px="520" />
      <code class="rw-mono">{{ props.smiles }}</code>
    </div>
  </el-dialog>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.pv code {
  font-size: 12px;
  color: var(--rw-text-2);
  word-break: break-all;
  text-align: center;
}
</style>
