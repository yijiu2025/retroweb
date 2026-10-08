<script setup lang="ts">
/**
 * 结构放大预览弹窗 —— 「眼睛」点开的那一扇窗。
 *
 * 抽成独立组件的原因：**两个地方都要用** ——
 *   ① 左侧栏「目标分析」卡（点目标结构缩略图）；
 *   ② 主区逆合成树 / 路线网络（点某个中间体）。
 * 各写一份的话，`align-center` 那条 Element Plus 的坑（默认是顶部对齐，
 * 必须显式 `align-center` 才是真居中）迟早会在其中一处漏掉。
 *
 * ── 这里能显示什么 ──────────────────────────────────────────────────────
 * 原来只有一张结构图 + 一行 SMILES 文本。想复制 CAS / 看名称时，用户只能
 * 挪到左侧树里去找那个分子的「复制」下拉 —— 在画布里点开一个中间体、
 * 却要去树的另一处拿它的 CAS，路径太绕。
 * 现在这里直接把**这个分子的身份信息一次列全**，每行都能单独复制：
 *   SMILES / 分子式 / 分子量（本地就有，秒出）
 *   CAS / 名称 / PubChem CID（来自 PubChem，见 utils/pubchem.ts）
 *
 * 🔴 分子式 / 分子量**按 SMILES 反查 store**（`findNodeBySmiles`），
 *    不改调用方的 `preview` 事件签名 —— 那条链上有 5 个 emit 方
 *    （TargetBar / TargetOverview / StepTree / RouteCanvas / MolChip），
 *    为了多带两个字段把它们全改成传对象，收益不抵改动面。
 *    反查不到（目标还没进树、或结构式从别处来）就只显示 PubChem 那几项，
 *    少显示比显示一个编出来的值强。
 *
 * 🔴 CAS 依然**懒查**：弹窗打开才入队（`watch(open)`），不是一挂载就查。
 *    一棵树几十个节点，用户一次只看一个，查那么些干什么。
 */
import { computed, watch } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import { useMolIdents } from '@/composables/useMolIdents';
import { pubchemUrl } from '@/utils/pubchem';
import MolView from './MolView.vue';

const props = defineProps<{ modelValue: boolean; smiles: string; title?: string }>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const store = useWorkspaceStore();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
});

/** 按结构找树里的那个节点（拿它的分子式 / 分子量；找不到就没有那两行） */
function findNodeBySmiles(smi: string) {
  for (const n of Object.values(store.nodes)) {
    if (n.smiles === smi) return n;
  }
  return undefined;
}

const { idents, cas, askCas, copyIdent } = useMolIdents(() => {
  const n = findNodeBySmiles(props.smiles);
  return { smiles: props.smiles, formula: n?.formula, mw: n?.mw };
});

/** 打开时去查 CAS（`watch` 而非 `onMounted`：同一对角反复开关很常见） */
watch(open, (v) => {
  if (v) askCas();
});

/** 有 CID 就能一键去 PubChem 看详情 */
const cid = computed(() => (cas.value && cas.value.cid ? cas.value.cid : 0));
</script>

<template>
  <el-dialog v-model="open" :title="props.title || '结构预览'" width="620" align-center>
    <div class="pv">
      <MolView :smiles="props.smiles" :bond-px="52" :min-px="200" :max-px="520" />

      <!-- 身份信息：每行一个标签 + 值，值右侧一个复制按钮。
           🔴 不做成下拉：这里**就是要一眼看全**（用户点「眼睛」就是想看这些），
              下拉还得再点一次才知道有什么。 -->
      <div class="pv__ids">
        <div v-for="it in idents" :key="it.key" class="pv__id" :class="{ 'is-primary': it.primary }">
          <span class="pv__id-label">{{ it.label }}</span>
          <code class="pv__id-value rw-mono">{{ it.value }}</code>
          <el-button
            size="small"
            text
            class="pv__id-copy"
            :title="`复制 ${it.label}`"
            :aria-label="`复制 ${it.label}`"
            @click="copyIdent(it.key)"
          >
            复制
          </el-button>
        </div>

        <!-- 查不到 CAS 时说明原因，别让人以为"这个分子没有登记号" -->
        <div v-if="!idents.some((x) => x.key === 'cas')" class="pv__id-note">
          {{ cas === null ? 'CAS：PubChem 未收录该结构' : 'CAS 查询中…' }}
        </div>

        <a
          v-if="cid"
          class="pv__link"
          :href="pubchemUrl(props.smiles)"
          target="_blank"
          rel="noopener noreferrer"
        >
          在 PubChem 里按结构检索 →
        </a>
      </div>
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

.pv__ids {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  overflow: hidden;
}

.pv__id {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px 4px 10px;
  background: var(--rw-surface);
}

/* 斑马纹：行数多时横向对不上号（哪个是 CAS、哪个是分子式） */
.pv__id:nth-child(even) {
  background: var(--rw-surface-3);
}

.pv__id.is-primary {
  background: var(--rw-surface-2);
  box-shadow: inset 2px 0 0 var(--rw-brand);
}

.pv__id-label {
  flex: 0 0 84px;
  color: var(--rw-text-2);
  font-size: 12px;
}

.pv__id-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--rw-text-3);
  font-size: 12px;
  line-height: 1.5;
}

/* SMILES 那一行是"这个分子最常被要的标识" ⇒ 值加重（只加 `code` 不够，
   `code` 自带 font-weight 会盖掉行上的 font-weight） */
.pv__id.is-primary .pv__id-value {
  color: var(--rw-text);
  font-weight: 600;
}

.pv__id-copy {
  flex: 0 0 auto;
  color: var(--rw-text-3);
  opacity: 0.55;
  transition: opacity 0.15s, color 0.15s;
}

/* 悬停整行时按钮才完全显出（常驻一排按钮太吵，但也不能藏到发现不了） */
.pv__id:hover .pv__id-copy,
.pv__id-copy:focus-visible {
  opacity: 1;
  color: var(--rw-brand);
}

.pv__id-note {
  padding: 4px 10px 5px;
  background: var(--rw-surface);
  color: var(--rw-text-3);
  font-size: 11.5px;
}

.pv__link {
  padding: 5px 10px 6px;
  border-top: 1px solid var(--rw-border);
  background: var(--rw-surface);
  color: var(--rw-brand);
  font-size: 11.5px;
  text-decoration: none;
}

.pv__link:hover {
  text-decoration: underline;
}
</style>
