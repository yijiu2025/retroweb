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
 *
 * 交互（2026-10-09）：**点 CAS 号 = 复制**（用户要求"方便复制"），
 * 旁边一枚小外链去 PubChem 核对 —— 复制是高频动作，外链是低频核对，
 * 主次倒过来才顺手。
 */
import { computed, watch } from 'vue';
import { casState, cidUrl, requestCas } from '@/utils/pubchem';
import { copyText } from '@/utils/clipboard';

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

/** 点 CAS 号复制（走全站唯一入口） */
async function copyCas(): Promise<void> {
  const c = cas.value;
  if (!c) return;
  await copyText(c.cas, {
    okMsg: `已复制 CAS ${c.cas}`,
    failMsg: '浏览器不允许自动复制，请手动选中 CAS 号复制'
  });
}
</script>

<template>
  <span v-if="cas" class="cas-tag">
    <i v-if="prefix">CAS</i>
    <!-- 点 CAS 号本身 = 复制；旁边的复制图标是**明确入口**（光凭"点数字"没人发现） -->
    <button
      type="button"
      class="cas-tag__num"
      :title="`点击复制 CAS ${cas.cas}；在 PubChem 查看（CID ${cas.cid}）${cas.name ? `｜${cas.name}` : ''}`"
      @click="copyCas"
    >
      {{ cas.cas }}
    </button>
    <button
      type="button"
      class="cas-tag__copy"
      :title="`复制 CAS ${cas.cas}`"
      @click="copyCas"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" />
        <path d="M10.5 3.5h-5a2 2 0 0 0-2 2v5" />
      </svg>
    </button>
    <a
      class="cas-tag__link"
      :href="cidUrl(cas.cid)"
      target="_blank"
      rel="noopener noreferrer"
      :title="`在 PubChem 查看（CID ${cas.cid}）${cas.name ? `｜${cas.name}` : ''}`"
      @click.stop
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M7 3h4a2 2 0 0 1 2 2v6M9 13H5a2 2 0 0 1-2-2V5" />
        <path d="M6 10 14 2" />
      </svg>
    </a>
  </span>
</template>

<style scoped>
.cas-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--rw-brand);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cas-tag i {
  font-style: normal;
  color: var(--rw-text-3);
}

/* CAS 号：复制热区，hover 下划线提示可复制 */
.cas-tag__num {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--rw-brand);
  font-size: inherit;
  font-variant-numeric: tabular-nums;
  cursor: copy;
}

.cas-tag__num:hover {
  text-decoration: underline;
}

/* 复制图标：明确的复制入口（hover 才点亮，不常驻抢视线） */
.cas-tag__copy {
  display: inline-flex;
  align-items: center;
  padding: 1px 2px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--rw-text-3);
  cursor: pointer;
  opacity: 0.55;
  transition: color 0.15s, opacity 0.15s, background 0.15s;
}

.cas-tag__copy:hover {
  color: var(--rw-brand);
  opacity: 1;
  background: var(--rw-brand-l);
}

.cas-tag__copy svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* PubChem 外链：小图标，低调的核对入口 */
.cas-tag__link {
  display: inline-flex;
  align-items: center;
  color: var(--rw-text-3);
  text-decoration: none;
  transition: color 0.15s;
}

.cas-tag__link:hover {
  color: var(--rw-brand);
}

.cas-tag__link svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
