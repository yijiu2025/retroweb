<script setup lang="ts">
/**
 * 分子结构图（smiles-drawer 封装）。
 *
 * 组件只负责「给个容器 + 调 drawSmiles」，尺寸/主题/兜底都在 utils/smiles-drawer.ts：
 *  - 画完后按恒定键长写回像素尺寸（否则 SVG 被 flex 压成 20 多像素）
 *  - 渲染失败降级为 SMILES 文本，不把整行搞崩
 */
import { onMounted, ref, watch } from 'vue';
import { drawSmiles } from '@/utils/smiles-drawer';

const props = withDefaults(
  defineProps<{
    smiles: string;
    /** 单键屏幕像素长度 */
    bondPx?: number;
    minPx?: number;
    maxPx?: number;
    dark?: boolean;
    clickable?: boolean;
    title?: string;
    /** 填满父容器（父容器必须有确定尺寸），避免大分子被 overflow:hidden 裁掉 */
    fit?: boolean;
  }>(),
  {
    bondPx: 30,
    minPx: 88,
    maxPx: 380,
    dark: false,
    clickable: false,
    title: '',
    fit: false
  }
);

const emit = defineEmits<{ click: [smiles: string] }>();

const host = ref<HTMLDivElement | null>(null);
const failed = ref(false);

async function render(): Promise<void> {
  failed.value = false;
  if (!host.value) return;
  if (!props.smiles) {
    host.value.replaceChildren();
    return;
  }
  try {
    const ok = await drawSmiles(host.value, props.smiles, {
      bondPx: props.bondPx,
      minPx: props.minPx,
      maxPx: props.maxPx,
      theme: props.dark ? 'dark' : 'light',
      fit: props.fit
    });
    failed.value = !ok;
  } catch {
    failed.value = true;
  }
}

onMounted(render);
watch(() => [props.smiles, props.dark, props.bondPx, props.fit], render);

function onClick(): void {
  if (props.clickable) emit('click', props.smiles);
}
</script>

<template>
  <div
    class="mol-view rw-mol"
    :class="{ 'is-clickable': clickable, 'is-fit': fit }"
    :title="title || smiles"
    @click="onClick"
  >
    <div v-show="!failed" ref="host" class="mol-view__host"></div>
    <span v-if="failed" class="mol-view__fallback rw-mono">{{ smiles || '（无）' }}</span>
  </div>
</template>

<style scoped>
.mol-view {
  min-width: 40px;
  color: var(--rw-text);
}

.mol-view.is-clickable {
  cursor: zoom-in;
}

.mol-view__host {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 填满定尺寸容器：SVG 靠 viewBox 等比缩放，不会被 overflow:hidden 裁掉 */
.mol-view.is-fit,
.mol-view.is-fit .mol-view__host {
  width: 100%;
  height: 100%;
  min-width: 0;
}

.mol-view__fallback {
  max-width: 100%;
  font-size: 11px;
  color: var(--rw-text-3);
}
</style>
