<script setup lang="ts">
/**
 * 单步候选反应面板（点行内「展开」后出现）。
 *
 * 一次面板 = 一次 `/api/predict` 的结果：N 个候选，按概率排序，
 * 展示前体结构图与概率分级；采纳后前体各新增一行。
 *
 * 🔴 每次分析都**追加保留**（node.runs）：跑第二次不会把第一次的候选冲掉，
 *    顶部下拉可来回切看/切采纳；已采纳的选择也会随「那次分析」记住。
 * 🔴 若这个分子的分析结果是复用树上另一个相同分子来的，会明确标出来，
 *    并给一个「自己跑一遍」的入口。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import type { AnalysisRun } from '@/types/retro';
import MolView from '@/components/mol/MolView.vue';

const props = defineProps<{ nodeId: string }>();
const store = useWorkspaceStore();

const node = computed(() => store.nodes[props.nodeId]);
const adoptedId = computed(() => node.value?.chosenReactionId ?? null);

const runs = computed<AnalysisRun[]>(() => node.value?.runs ?? []);
const activeRunId = computed(() => node.value?.activeRunId ?? '');
const reusedFrom = computed(() => node.value?.reusedFrom ?? null);
const reusedSource = computed(() =>
  reusedFrom.value ? store.nodes[reusedFrom.value] : undefined
);

const levelText: Record<string, string> = { high: '高置信', mid: '中等', low: '偏低' };
const levelTag: Record<string, 'success' | 'warning' | 'info'> = {
  high: 'success',
  mid: 'warning',
  low: 'info'
};

function onAdopt(reactionId: string): void {
  store.adopt(reactionId);
  ElMessage.success('已采纳该步，前体已加入路线树');
}

function onUnadopt(): void {
  store.unadopt(props.nodeId);
}

/** 切换查看/采纳「之前某一次」的分析结果 */
function onSwitchRun(value: unknown): void {
  const runId = String(value ?? '');
  if (!runId) return;
  store.switchRun(props.nodeId, runId);
  ElMessage.info('已切到该次分析结果（当时采纳的那一步会一并恢复）');
}

/** 再跑一次模型：结果会追加保留，历史不丢 */
function onReanalyze(): void {
  void store.predictNode(props.nodeId, { force: true });
}

function runLabel(run: AnalysisRun, idx: number): string {
  const d = new Date(run.at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const infer = run.inferSeconds ? ` · ${run.inferSeconds}s` : '';
  return `#${idx + 1} ${stamp} · ${run.candidates.length} 候选${infer}`;
}
</script>

<template>
  <div class="cand">
    <div class="cand__head">
      <span class="cand__title">
        第 {{ (node?.depth ?? 0) + 1 }} 步候选反应 · 共 {{ node?.candidates.length ?? 0 }} 个
      </span>
      <div class="cand__head-ops">
        <el-select
          v-if="runs.length > 1"
          :model-value="activeRunId"
          size="small"
          class="cand__runs"
          @change="onSwitchRun"
        >
          <el-option
            v-for="(r, i) in runs"
            :key="r.id"
            :label="runLabel(r, i)"
            :value="r.id"
          />
        </el-select>
        <el-button size="small" :disabled="node?.status === 'loading'" @click="onReanalyze">
          重新分析
        </el-button>
      </div>
    </div>

    <div v-if="reusedFrom" class="cand__reuse">
      <el-tag size="small" type="warning" effect="light">复用了相同分子的分析结果</el-tag>
      <span class="cand__reuse-text">
        树上已有同一分子
        <code class="rw-mono">{{
          reusedSource?.smiles && reusedSource.smiles.length > 26
            ? reusedSource.smiles.slice(0, 26) + '…'
            : reusedSource?.smiles || '（已隐藏）'
        }}</code>
        的分析，这里直接拿来用、没有重新跑模型。想要独立结果点「重新分析」。
      </span>
    </div>

    <div class="cand__hint-line">
      模型 {{ store.params.model }}；采纳后前体会各新增一行 · 每次「重新分析」的结果都会保留，可用上方下拉切换
    </div>

    <el-skeleton v-if="node?.status === 'loading'" :rows="2" animated />

    <el-empty
      v-else-if="!node?.candidates.length"
      :image-size="48"
      :description="node?.error || '该分子没有给出候选反应（可能已是起始物料）'"
    />

    <div v-else class="cand__grid">
      <div
        v-for="rxn in node.candidates"
        :key="rxn.id"
        class="cand-card"
        :class="{ 'is-adopted': adoptedId === rxn.id }"
      >
        <div class="cand-card__top">
          <span class="cand-card__rank">#{{ rxn.rank }}</span>
          <el-tag :type="levelTag[rxn.level]" size="small" effect="light">{{ levelText[rxn.level] }}</el-tag>
          <span class="cand-card__prob">{{ (rxn.probability * 100).toFixed(1) }}%</span>
          <div class="rw-prob" :class="`is-${rxn.level}`">
            <i :style="{ width: Math.max(4, rxn.probability * 100) + '%' }"></i>
          </div>
        </div>

        <div class="cand-card__mols">
          <template v-for="(smi, i) in rxn.precursorList" :key="smi + i">
            <span v-if="i > 0" class="cand-card__op">+</span>
            <div class="cand-card__mol">
              <MolView :smiles="smi" :bond-px="22" :min-px="64" :max-px="130" />
              <code class="rw-mono">{{ smi.length > 16 ? smi.slice(0, 16) + '…' : smi }}</code>
            </div>
          </template>
        </div>

        <div class="cand-card__foot">
          <span class="cand-card__count">{{ rxn.numMolecules }} 个前体</span>
          <el-button
            v-if="adoptedId !== rxn.id"
            type="primary"
            size="small"
            @click="onAdopt(rxn.id)"
          >
            采纳
          </el-button>
          <el-tag v-else type="success" size="small" effect="dark">已采纳</el-tag>
        </div>
      </div>
    </div>

    <div v-if="adoptedId" class="cand__undo">
      <el-button link type="danger" size="small" @click="onUnadopt">撤销这一步（丢弃其下所有分支）</el-button>
    </div>
  </div>
</template>

<style scoped>
.cand {
  margin: 8px 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.cand__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.cand__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
}

.cand__head-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cand__runs {
  width: 250px;
}

.cand__runs :deep(.el-select__wrapper) {
  font-size: 12px;
}

.cand__reuse {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--rw-warn-l);
}

.cand__reuse-text {
  font-size: 11.5px;
  color: var(--rw-text-2);
  line-height: 1.5;
}

.cand__reuse code {
  font-size: 11px;
}

.cand__hint-line {
  margin-bottom: 10px;
  font-size: 11px;
  color: var(--rw-text-3);
  line-height: 1.5;
}

.cand__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}

.cand-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.cand-card:hover {
  border-color: var(--rw-brand);
  box-shadow: var(--rw-shadow-1);
}

.cand-card.is-adopted {
  border-color: var(--rw-ok);
  background: var(--rw-ok-l);
}

.cand-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cand-card__rank {
  font-size: 12px;
  font-weight: 700;
  color: var(--rw-text-3);
}

.cand-card__prob {
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-text);
}

.cand-card__prob + .rw-prob {
  flex: 1;
  min-width: 30px;
}

.cand-card__mols {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.cand-card__op {
  color: var(--rw-text-3);
  font-size: 14px;
}

.cand-card__mol {
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

.cand-card__mol code {
  font-size: 10px;
  color: var(--rw-text-3);
}

.cand-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cand-card__count {
  font-size: 11px;
  color: var(--rw-text-3);
}

.cand__undo {
  margin-top: 10px;
  text-align: right;
}
</style>
