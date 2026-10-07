<script setup lang="ts">
/**
 * 分子小卡：**结构式缩略图 + SMILES + CAS 号**。
 *
 * 为什么抽成组件：同一个「分子」（结构式 + SMILES + CAS + 点开放大）现在要出现在
 * 「路线网络」表的**产物**与**前体**两列 —— 各写一遍的话，缩略图尺寸、CAS 口径、
 * 点下去会怎样迟早各长一样。
 *
 * 组成：
 *   · 左侧结构式 —— `MolView`，盒子尺寸由 props 给（`fit` 铺满，大分子不被裁）
 *   · 右侧 SMILES —— 点击左侧缩略图放大（复用 `MolPreviewDialog`）
 *   · CAS —— `<CasTag>`，**恒挂载**（它内部自己决定显不显示）
 *
 * 🔴 `CasTag` 必须无条件渲染：它的 `watch(..., { immediate: true })` 才是查询的
 *    触发点。若外面用 `v-if="cas"` 包起来 ⇒ 没查到就没人去查，永远查不到。
 */
import { computed } from 'vue';
import MolView from './MolView.vue';
import CasTag from './CasTag.vue';
import { casState } from '@/utils/pubchem';

const props = withDefaults(
  defineProps<{
    smiles: string;
    /** 结构式缩略图盒子尺寸（px） */
    molW?: number;
    molH?: number;
    /** 缩略图里的单键长度（越小越省地方，但分子会挤） */
    bondPx?: number;
    /** 分子式（可选，只在**确定没有** CAS 时当副标题） */
    formula?: string;
  }>(),
  { molW: 68, molH: 48, bondPx: 17, formula: '' }
);

const emit = defineEmits<{ preview: [smiles: string] }>();

const cas = computed(() => casState(props.smiles));

/** tooltip：把「有 / 没有 / 还在查」三种状态说清，别让人猜为什么没 CAS */
const smiTitle = computed(() => {
  const c = cas.value;
  if (c) return `${props.smiles}\nCAS ${c.cas}（PubChem CID ${c.cid}）${c.name ? `\n${c.name}` : ''}`;
  if (c === null) return `${props.smiles}\nPubChem 未收录该结构，无 CAS 登记号`;
  return `${props.smiles}\nCAS 查询中…`;
});
</script>

<template>
  <div class="mol-chip">
    <button
      type="button"
      class="mol-chip__mol"
      :style="{ width: `${molW}px`, height: `${molH}px` }"
      title="点击放大查看结构式"
      @click="emit('preview', smiles)"
    >
      <MolView :smiles="smiles" fit :bond-px="bondPx" :min-px="30" :max-px="140" />
    </button>
    <div class="mol-chip__info">
      <code class="rw-mono mol-chip__smi" :title="smiTitle">{{ smiles }}</code>
      <CasTag :smiles="smiles" />
      <!-- 只在「确定没有 CAS」时退回分子式：查询中不闪一下又换掉 -->
      <span v-if="cas === null && formula" class="mol-chip__formula">{{ formula }}</span>
    </div>
  </div>
</template>

<style scoped>
.mol-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* 缩略图盒子尺寸由内联 style 给（各场景要的大小不同），
   SVG 靠 `fit` 铺满 ⇒ 大分子也不会被裁 */
.mol-chip__mol {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color 0.15s;
}

.mol-chip__mol:hover {
  border-color: var(--rw-brand);
}

.mol-chip__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.mol-chip__smi {
  font-size: 11px;
  line-height: 1.45;
  color: var(--rw-text-2);
  word-break: break-all;
}

.mol-chip__formula {
  font-size: 10.5px;
  color: var(--rw-text-3);
}
</style>
