<script setup lang="ts">
/**
 * 「目标分析」总览 —— 路线态的首页（页签里的第一个，默认展示）。
 *
 * 为什么把它做成默认页签：一个任务真正要先看清的是**「在拆什么 + 已经确认到哪一步」**，
 * 而不是一屏还没长开的逆合成树。树 / 路线网络 / 步骤详情都在页签里，随时可进。
 *
 * 三块内容：
 *   ① 目标分子：结构式 + 分子式 / 分子量 / 重原子 + SMILES（可复制、可跳转换目标）
 *   ② 已确认路线：沿当前采纳分支回溯出的每一步（产物 ← 前体 + 概率）与整体指标
 *   ③ 起始物料：已经走到「可购买 / 低于阈值 / 已终止」的叶子
 *
 * 数据全部来自 store 的派生量（route / routeProbability / startingMaterials / stats），
 * 不在这里重算 —— 统计口径只允许有一个来源。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { useSettingsStore } from '@/stores/settings';
import MolView from '@/components/mol/MolView.vue';

const store = useWorkspaceStore();
const settings = useSettingsStore();
const emit = defineEmits<{ preview: [smiles: string] }>();

const root = computed(() => (store.rootId ? store.nodes[store.rootId] : undefined));
const steps = computed(() => store.route);
const totalPct = computed(() => `${(store.routeProbability * 100).toFixed(2)}%`);
const startList = computed(() => store.startingMaterials);

function pctText(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(1)}%`;
}

async function copySmiles(): Promise<void> {
  const t = root.value;
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t.smiles);
    ElMessage.success('已复制 SMILES');
  } catch {
    ElMessage.warning('浏览器不允许自动复制，请手动选中 SMILES 复制');
  }
}
</script>

<template>
  <div v-if="root" class="ov">
    <!-- ① 目标分子 -->
    <section class="rw-card ov__target">
      <div class="rw-card__head">
        <div class="rw-card__title">目标分子</div>
        <el-button size="small" type="primary" plain @click="store.openTargetSetup()">切换目标</el-button>
      </div>
      <div class="rw-card__body ov__target-body">
        <button
          type="button"
          class="ov__mol"
          title="点击放大查看"
          @click="emit('preview', root.smiles)"
        >
          <MolView :smiles="root.smiles" fit :bond-px="34" :min-px="150" :max-px="300" />
        </button>
        <div class="ov__props">
          <span><i>分子式</i>{{ root.formula || '—' }}</span>
          <span><i>分子量</i>{{ root.mw ?? '—' }}</span>
          <span><i>重原子</i>{{ root.atoms ?? '—' }}</span>
        </div>
        <div class="ov__smiles">
          <code class="rw-mono">{{ root.smiles }}</code>
          <el-button link size="small" @click="copySmiles">复制</el-button>
        </div>
      </div>
    </section>

    <div class="ov__right">
      <!-- ② 已确认路线 -->
      <section class="rw-card ov__route">
        <div class="rw-card__head">
          <div class="rw-card__title">已确认路线</div>
          <div class="ov__chips">
            <span class="ov__chip"><b>{{ steps.length }}</b> 步</span>
            <span class="ov__chip ov__chip--brand"><b>{{ totalPct }}</b> 总概率</span>
            <span class="ov__chip"><b>{{ startList.length }}</b> 起始物料</span>
            <span class="ov__chip"><b>第 {{ store.stats.maxDepth + 1 }} 层</b> 最深</span>
          </div>
        </div>
        <div class="rw-card__body ov__route-body">
          <table v-if="steps.length" class="ov__table">
            <thead>
              <tr>
                <th>步骤</th>
                <th>产物</th>
                <th>前体（反应物）</th>
                <th>概率</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in steps" :key="s.nodeId">
                <td class="ov__step">
                  <span class="ov__step-no">{{ s.step }}</span>
                  <span v-if="s.branchNo > 1" class="ov__branch">支 {{ s.branchNo }}</span>
                </td>
                <td>
                  <button type="button" class="ov__mol-link" :title="s.product" @click="emit('preview', s.product)">
                    <code class="rw-mono">{{ s.product }}</code>
                  </button>
                </td>
                <td class="ov__precursors">
                  <code v-for="p in s.precursors" :key="p" class="rw-mono" :title="p">{{ p }}</code>
                </td>
                <td class="ov__p">{{ pctText(s.probability) }}</td>
              </tr>
            </tbody>
          </table>

          <div v-else class="ov__empty">
            <p>
              还没有确认任何一步。到「<b>逆合成树</b>」页签展开目标分子的候选反应，
              采纳其中一条后，这条路线就会在这里逐层记录下来。
            </p>
            <div class="ov__empty-ops">
              <el-button size="small" type="primary" @click="store.mainTab = 'tree'">去逆合成树</el-button>
              <el-button size="small" @click="store.mainTab = 'route'">看路线网络</el-button>
            </div>
          </div>
        </div>
      </section>

      <!-- ③ 起始物料 -->
      <section class="rw-card ov__start">
        <div class="rw-card__head">
          <div class="rw-card__title">起始物料</div>
          <span class="ov__note">走到「可购买 / 低于重原子阈值 / 已终止」的叶子</span>
        </div>
        <div class="rw-card__body">
          <div v-if="startList.length" class="ov__start-list">
            <button
              v-for="n in startList"
              :key="n.id"
              type="button"
              class="ov__start-item"
              :title="n.smiles"
              @click="emit('preview', n.smiles)"
            >
              <span class="ov__start-mol">
                <MolView :smiles="n.smiles" fit :bond-px="18" :min-px="40" :max-px="80" />
              </span>
              <span class="ov__start-info">
                <code class="rw-mono">{{ n.smiles }}</code>
                <i>{{ n.formula || '—' }}</i>
              </span>
            </button>
          </div>
          <p v-else class="ov__note">
            还没有走到起始物料。继续在逆合成树里往下拆，或把某个中间体标成「已购买」。
          </p>

          <!-- 合规提示的开关：关掉了也得能找回来 -->
          <label class="ov__toggle">
            <el-switch v-model="settings.hideDisclaimer" size="small" />
            <span>隐藏「模型预测可能存在幻觉」提示</span>
          </label>
        </div>
      </section>
    </div>
  </div>

  <el-empty v-else description="还没有目标分子" :image-size="80" />
</template>

<style scoped>
.ov {
  display: grid;
  /* 左：目标分子（窄，固定观感）；右：路线与起始物料（吃掉剩余宽度） */
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.ov__right {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.ov__target-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ov__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 168px;
  padding: 6px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color 0.15s;
}

.ov__mol:hover {
  border-color: var(--rw-brand);
}

.ov__props {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  font-size: 12px;
  color: var(--rw-text-2);
}

.ov__props i {
  font-style: normal;
  margin-right: 6px;
  color: var(--rw-text-3);
}

.ov__smiles {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.ov__smiles code {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--rw-text-2);
  word-break: break-all;
}

/* ---------- 已确认路线 ---------- */
.ov__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ov__chip {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 11px;
  white-space: nowrap;
}

.ov__chip b {
  color: var(--rw-text);
  font-variant-numeric: tabular-nums;
}

.ov__chip--brand {
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
}

.ov__chip--brand b {
  color: var(--rw-brand-d);
}

.ov__route-body {
  padding-top: 10px;
}

.ov__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.ov__table th,
.ov__table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--rw-border);
  text-align: left;
  vertical-align: top;
}

.ov__table th {
  color: var(--rw-text-3);
  font-weight: 500;
  background: var(--rw-surface-2);
}

.ov__table tr:last-child td {
  border-bottom: 0;
}

.ov__step {
  white-space: nowrap;
}

.ov__step-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.ov__branch {
  margin-left: 4px;
  font-size: 10px;
  color: var(--rw-text-3);
}

/* 产物 / 前体的 SMILES 都可点开看结构 */
.ov__mol-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--rw-text);
  text-align: left;
  cursor: zoom-in;
}

.ov__mol-link code {
  font-size: 11.5px;
  word-break: break-all;
}

.ov__mol-link:hover code {
  color: var(--rw-brand);
}

.ov__precursors {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ov__precursors code {
  font-size: 11px;
  color: var(--rw-text-2);
  word-break: break-all;
}

.ov__p {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: var(--rw-text-2);
}

.ov__empty p {
  margin: 0 0 10px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--rw-text-2);
}

.ov__empty-ops {
  display: flex;
  gap: 8px;
}

/* ---------- 起始物料 ---------- */
.ov__note {
  margin: 0;
  font-size: 11.5px;
  color: var(--rw-text-3);
}

.ov__start-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
}

.ov__start-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  cursor: zoom-in;
  text-align: left;
  transition: border-color 0.15s;
}

.ov__start-item:hover {
  border-color: var(--rw-brand);
}

.ov__start-mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 46px;
  flex: 0 0 58px;
  border-radius: 6px;
  background: var(--rw-surface);
  overflow: hidden;
}

.ov__start-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ov__start-info code {
  font-size: 11px;
  color: var(--rw-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov__start-info i {
  font-style: normal;
  font-size: 10.5px;
  color: var(--rw-text-3);
}

.ov__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--rw-border);
  font-size: 11.5px;
  color: var(--rw-text-3);
  cursor: pointer;
}

/* 窄屏：两栏堆叠（目标分子在上） */
@media (max-width: 1080px) {
  .ov {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
