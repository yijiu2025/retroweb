<script setup lang="ts">
/**
 * CAS 号标签（结构 → CAS 由 PubChem 公开库查，见 `utils/pubchem.ts`）。
 *
 * 🔴 **查不到就整块不渲染**：不显示「—」、不显示「无」。
 *    「这个分子没有 CAS 登记」与「我们没查到」对用户是两件事，
 *    这里只显示确定的；想知道为什么没有，看它所在分子的 tooltip。
 *
 * 组件自己触发查询（一挂载就排队）⇒ 调用方不必管时机，去重 / 限流 / 缓存
 * 全在 utils 里。
 */
import { computed, watch } from 'vue';
import { casState, cidUrl, requestCas } from '@/utils/pubchem';

const props = withDefaults(
  defineProps<{
    smiles: string;
    /** 是否带「CAS」前缀（并排多个时只留数值外观更干净） */
    prefix?: boolean;
  }>(),
  { prefix: true }
);

const cas = computed(() => casState(props.smiles));

watch(() => props.smiles, (s) => requestCas(s), { immediate: true });
</script>

<template>
  <a
    v-if="cas"
    class="cas-tag"
    :href="cidUrl(cas.cid)"
    target="_blank"
    rel="noopener noreferrer"
    :title="`在 PubChem 查看（CID ${cas.cid}）${cas.name ? `｜${cas.name}` : ''}`"
    :data-cas="cas.cas"
    @click.stop
  >
    <i v-if="prefix">CAS</i>{{ cas.cas }}
  </a>
</template>

<style scoped>
.cas-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--rw-brand);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cas-tag:hover {
  text-decoration: underline;
}

.cas-tag i {
  font-style: normal;
  color: var(--rw-text-3);
}
</style>
