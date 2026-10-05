<script setup lang="ts">
/**
 * 合成路线汇总：由「选定分支」回溯生成 —— 步骤列表 + 起始物料 + 导出。
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import MolView from '@/components/mol/MolView.vue';

const store = useWorkspaceStore();

const route = computed(() => store.route);
const materials = computed(() => store.startingMaterials);
const totalProb = computed(() => store.routeProbability);

/** 当前展示的是哪一条路线方案（多条路线时用来标识） */
const schemeName = computed(
  () => store.schemes.find((s) => s.id === store.currentSchemeId)?.name ?? null
);

/** 跳到「每步流程」页签并定位到该步的工艺分析 */
function openFlow(nodeId: string): void {
  store.analysisFocus = nodeId;
  store.mainTab = 'flow';
}

/** 该步的 AI 分析状态（用于在步骤卡上标一下） */
function analysisStatus(nodeId: string): string {
  return store.analysisOf(nodeId)?.status ?? 'idle';
}

/**
 * 同一层有几个分支。
 *
 * ⚠️ 列表 key 必须用 nodeId —— step 是层级号，多分支合成时第 2 层会有好几条，
 *    拿 step 当 key 会撞重复 key（Vue 告警 + 同层第二个分支渲染不出来）。
 */
const branchCount = computed(() => {
  const m: Record<number, number> = {};
  for (const s of route.value) m[s.step] = (m[s.step] ?? 0) + 1;
  return m;
});

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function exportJson(): void {
  download(`retroweb-route-${stamp()}.json`, store.exportJson(), 'application/json');
}

function exportCsv(): void {
  download(`retroweb-route-${stamp()}.csv`, store.exportCsv(), 'text/csv;charset=utf-8');
}

/** 打印（浏览器「另存为 PDF」） */
function onPrint(): void {
  window.print();
}
</script>

<template>
  <section class="rw-card summary">
    <div class="rw-card__head">
      <div class="rw-card__title">
        合成路线
        <span v-if="schemeName" class="summary__scheme">方案：{{ schemeName }}</span>
      </div>
      <div class="summary__ops">
        <el-button size="small" @click="exportJson">导出 JSON</el-button>
        <el-button size="small" @click="exportCsv">导出 CSV</el-button>
        <el-button size="small" plain @click="onPrint">打印 / PDF</el-button>
      </div>
    </div>

    <div class="rw-card__body summary__body">
      <div class="summary__score">
        <div>
          <span class="summary__score-label">总步数</span>
          <b>{{ route.length }}</b>
        </div>
        <div>
          <span class="summary__score-label">总概率（连乘）</span>
          <b>{{ route.length ? (totalProb * 100).toFixed(2) + '%' : '—' }}</b>
        </div>
        <div>
          <span class="summary__score-label">起始物料</span>
          <b>{{ materials.length }}</b>
        </div>
      </div>

      <el-empty v-if="!route.length" description="还没有采纳任何一步，先在「路线树」里展开并采纳候选" :image-size="60" />

      <ol v-else class="summary__steps">
        <li v-for="step in route" :key="step.nodeId" class="summary__step">
          <div class="summary__step-no">
            第 {{ step.step }} 步
            <span v-if="branchCount[step.step] > 1" class="summary__step-branch">
              · 分支 {{ step.branchNo }}
            </span>
          </div>
          <div class="rxnline">
            <template v-for="(smi, i) in step.precursors" :key="smi + i">
              <span v-if="i > 0" class="rxnline__op">+</span>
              <div class="rxnline__mol">
                <MolView :smiles="smi" :bond-px="24" :min-px="70" :max-px="150" />
                <code class="rw-mono">{{ smi.length > 18 ? smi.slice(0, 18) + '…' : smi }}</code>
              </div>
            </template>
            <span class="rxnline__op rxnline__op--arrow">→</span>
            <div class="rxnline__mol">
              <MolView :smiles="step.product" :bond-px="24" :min-px="70" :max-px="150" />
              <code class="rw-mono">{{ step.product.length > 18 ? step.product.slice(0, 18) + '…' : step.product }}</code>
            </div>
          </div>
          <div class="summary__step-meta">
            <span>概率 {{ (step.probability * 100).toFixed(1) }}%</span>
            <span>模型 {{ step.model }}</span>
            <span v-if="step.productFormula">{{ step.productFormula }}</span>
            <el-tag v-if="analysisStatus(step.nodeId) === 'done'" size="small" type="success" effect="light">
              已分析
            </el-tag>
            <el-button link type="primary" size="small" @click="openFlow(step.nodeId)">
              查看工艺分析
            </el-button>
          </div>
        </li>
      </ol>

      <div v-if="materials.length" class="summary__materials">
        <div class="summary__subtitle">起始物料汇总</div>
        <div class="summary__materials-grid">
          <div v-for="m in materials" :key="m.id" class="summary__material">
            <MolView :smiles="m.smiles" :bond-px="22" :min-px="64" :max-px="120" />
            <code class="rw-mono">{{ m.smiles.length > 20 ? m.smiles.slice(0, 20) + '…' : m.smiles }}</code>
            <span class="summary__material-meta">{{ m.formula || '' }} · {{ store.heavyAtoms(m) }} 重原子</span>
          </div>
        </div>
      </div>

      <p class="summary__disclaimer">
        以上结果由模型预测生成，可能包含错误；排名靠后的候选更可能不合理，实验前须经专业人员验证。
      </p>
    </div>
  </section>
</template>

<style scoped>
.summary__ops {
  display: flex;
  gap: 6px;
}

.summary__scheme {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--rw-brand-d);
}

.summary__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.summary__score {
  display: flex;
  gap: 28px;
  padding: 10px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.summary__score-label {
  display: block;
  font-size: 11px;
  color: var(--rw-text-3);
}

.summary__score b {
  font-size: 18px;
  color: var(--rw-text);
}

.summary__steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.summary__step {
  padding: 10px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
}

.summary__step-no {
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-brand-d);
  margin-bottom: 6px;
}

.summary__step-branch {
  font-weight: 400;
  color: var(--rw-text-3);
}

.rxnline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.rxnline__op {
  color: var(--rw-text-3);
  font-size: 15px;
}

.rxnline__op--arrow {
  color: var(--rw-brand);
  font-weight: 700;
}

.rxnline__mol {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface-2);
}

.rxnline__mol code {
  font-size: 10px;
  color: var(--rw-text-3);
}

.summary__step-meta {
  display: flex;
  gap: 14px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.summary__subtitle {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.summary__materials-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
}

.summary__material {
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

.summary__material code {
  font-size: 10px;
}

.summary__material-meta {
  font-size: 10px;
  color: var(--rw-text-3);
}

.summary__disclaimer {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--rw-radius-sm);
  background: var(--rw-warn-l);
  color: var(--rw-warn);
  font-size: 12px;
}
</style>
