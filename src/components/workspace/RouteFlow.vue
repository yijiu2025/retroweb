<script setup lang="ts">
/**
 * 每步流程视图 —— 把当前选定的合成路线画成一条**自上而下的工艺流水线**。
 *
 * 每一步展示：前体（结构式）→（条件/试剂）→ 产物，并带概率；
 * 若该步做过 AI 工艺分析，条件、当量、副产物、LCMS/NMR 会直接内联在这张流程卡里，
 * 展开即看 —— 这就是「每步生成展示流程」。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import MolView from '@/components/mol/MolView.vue';
import StepAnalysis from './StepAnalysis.vue';

const store = useWorkspaceStore();

/** 每步的流程卡是否展开出 AI 分析（默认按分析状态自动展开） */
const open = ref<Record<string, boolean>>({});

const steps = computed(() => store.route);
const materials = computed(() => store.startingMaterials);

/** 已分析 / 总步数 */
const analyzed = computed(
  () => steps.value.filter((s) => store.analysisOf(s.nodeId)?.status === 'done').length
);

const busy = ref(false);

function statusOf(nodeId: string): string {
  return store.analysisOf(nodeId)?.status ?? 'idle';
}

function toggle(nodeId: string): void {
  open.value[nodeId] = !open.value[nodeId];
}

/** 条件摘要（一行话）：溶剂 · 温度 · 催化剂 */
function condSummary(nodeId: string): string {
  const c = store.analysisOf(nodeId)?.data?.conditions;
  if (!c) return '未分析';
  return [c.solvent, c.temperature, c.catalyst].filter((v) => String(v || '').trim()).join(' · ') || '未给出';
}

/** 试剂 chips（来自投料顺序） */
function reagentsOf(nodeId: string): string[] {
  const order = store.analysisOf(nodeId)?.data?.order;
  if (!order?.length) return [];
  return order
    .map((d) => [d.reagent, d.equiv].filter(Boolean).join(' '))
    .filter(Boolean)
    .slice(0, 6) as string[];
}

async function analyzeAll(): Promise<void> {
  if (!steps.value.length) {
    ElMessage.warning('还没有采纳任何一步');
    return;
  }
  busy.value = true;
  try {
    await store.analyzeRoute();
    ElMessage.success('已完成整条路线的工艺分析');
  } finally {
    busy.value = false;
  }
}

watch(
  () => store.analysisFocus,
  async (id) => {
    if (!id) return;
    open.value[id] = true;
    await nextTick();
    const el = document.querySelector(`[data-flow-node="${id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
);

// 有分析结果的步骤默认展开
watch(
  steps,
  (list) => {
    for (const s of list) {
      if (open.value[s.nodeId] === undefined) {
        open.value[s.nodeId] = statusOf(s.nodeId) === 'done';
      }
    }
  },
  { immediate: true }
);
</script>

<template>
  <section class="rw-card flow">
    <div class="rw-card__head">
      <div class="rw-card__title">每步流程（工艺流水线）</div>
      <div class="flow__ops">
        <span class="flow__count">已分析 {{ analyzed }} / {{ steps.length }} 步</span>
        <el-button size="small" type="primary" :loading="busy" @click="analyzeAll">
          一键分析全路线
        </el-button>
      </div>
    </div>

    <div class="rw-card__body flow__body">
      <el-alert
        v-if="store.llmStatus && !store.llmStatus.configured"
        type="info"
        :closable="false"
        class="flow__alert"
        :title="store.llmStatus.hint"
      />
      <el-empty v-if="!steps.length" description="先在「路线树」里采纳候选，这里会自动生成每步流程" :image-size="60" />

      <ol v-else class="flow__list">
        <li v-for="step in steps" :key="step.nodeId" class="flow__item" :data-flow-node="step.nodeId">
          <div class="flow__badge">
            第 {{ step.step }} 步
            <span v-if="step.productFormula" class="flow__badge-formula">{{ step.productFormula }}</span>
          </div>

          <div class="flow__card">
            <div class="flow__rxn">
              <div class="flow__side">
                <template v-for="(smi, i) in step.precursors" :key="smi + i">
                  <span v-if="i > 0" class="flow__plus">+</span>
                  <div class="flow__mol">
                    <MolView :smiles="smi" :bond-px="22" :min-px="64" :max-px="130" />
                    <code class="rw-mono">{{ smi.length > 16 ? smi.slice(0, 16) + '…' : smi }}</code>
                  </div>
                </template>
              </div>

              <div class="flow__arrow">
                <svg viewBox="0 0 60 24" width="60" height="24" aria-hidden="true">
                  <line x1="2" y1="12" x2="48" y2="12" stroke="currentColor" stroke-width="1.6" />
                  <polyline points="42,6 50,12 42,18" fill="none" stroke="currentColor" stroke-width="1.6" />
                </svg>
                <div class="flow__cond">{{ condSummary(step.nodeId) }}</div>
              </div>

              <div class="flow__side">
                <div class="flow__mol flow__mol--product">
                  <MolView :smiles="step.product" :bond-px="22" :min-px="64" :max-px="130" />
                  <code class="rw-mono">{{ step.product.length > 16 ? step.product.slice(0, 16) + '…' : step.product }}</code>
                </div>
              </div>
            </div>

            <div v-if="reagentsOf(step.nodeId).length" class="flow__reagents">
              <span v-for="(r, i) in reagentsOf(step.nodeId)" :key="i" class="flow__reagent">{{ r }}</span>
            </div>

            <div class="flow__foot">
              <span class="flow__prob">概率 {{ (step.probability * 100).toFixed(1) }}%</span>
              <el-tag size="small" effect="plain" type="info">模型 {{ step.model }}</el-tag>
              <el-tag
                v-if="statusOf(step.nodeId) === 'done'"
                size="small"
                type="success"
                effect="light"
              >
                已分析
              </el-tag>
              <el-button size="small" text type="primary" @click="toggle(step.nodeId)">
                {{ open[step.nodeId] ? '收起工艺分析' : '展开工艺分析' }}
              </el-button>
            </div>

            <div v-if="open[step.nodeId]" class="flow__analysis">
              <StepAnalysis :node-id="step.nodeId" />
            </div>
          </div>
        </li>
      </ol>

      <div v-if="materials.length" class="flow__materials">
        <div class="flow__materials-title">起始物料（路线末端）</div>
        <div class="flow__materials-grid">
          <div v-for="m in materials" :key="m.id" class="flow__material">
            <MolView :smiles="m.smiles" :bond-px="20" :min-px="58" :max-px="110" />
            <code class="rw-mono">{{ m.smiles.length > 20 ? m.smiles.slice(0, 20) + '…' : m.smiles }}</code>
            <span class="flow__material-meta">
              {{ m.formula || '' }} · {{ store.heavyAtoms(m) }} 重原子
              <template v-if="m.reusedFrom"> · 复用分析结果</template>
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.flow {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.flow__ops {
  display: flex;
  align-items: center;
  gap: 10px;
}

.flow__count {
  font-size: 12px;
  color: var(--rw-text-3);
}

.flow__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px;
}

.flow__alert :deep(.el-alert__title) {
  font-size: 12px;
}

.flow__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: relative;
}

.flow__item {
  position: relative;
}

/* 流水线竖线：把每一步串起来 */
.flow__item::before {
  content: '';
  position: absolute;
  left: 22px;
  top: 26px;
  bottom: -14px;
  width: 2px;
  background: var(--rw-border);
}

.flow__item:last-child::before {
  display: none;
}

.flow__badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  margin-left: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-size: 12px;
  font-weight: 600;
}

.flow__badge-formula {
  font-weight: 400;
  opacity: 0.8;
}

.flow__card {
  margin-left: 12px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

.flow__rxn {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.flow__side {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.flow__plus {
  color: var(--rw-text-3);
  font-size: 15px;
}

.flow__mol {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface-2);
  max-width: 140px;
}

.flow__mol--product {
  border-color: var(--rw-brand-soft);
  background: var(--rw-brand-l);
}

.flow__mol code {
  font-size: 10px;
  color: var(--rw-text-3);
}

.flow__arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--rw-brand);
  min-width: 120px;
}

.flow__cond {
  max-width: 220px;
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.4;
  text-align: center;
  color: var(--rw-text-3);
}

.flow__reagents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.flow__reagent {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--rw-surface-3);
  color: var(--rw-text-2);
  font-size: 11px;
}

.flow__foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--rw-border);
}

.flow__prob {
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-text);
}

.flow__analysis {
  margin-top: 8px;
}

.flow__materials {
  padding-top: 12px;
  border-top: 1px solid var(--rw-border);
}

.flow__materials-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.flow__materials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
}

.flow__material {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  text-align: center;
}

.flow__material code {
  font-size: 10px;
}

.flow__material-meta {
  font-size: 10px;
  color: var(--rw-text-3);
}
</style>
