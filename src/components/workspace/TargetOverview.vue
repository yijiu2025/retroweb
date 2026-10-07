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
/**
 * 路线网络的体检数据。
 * 🔴 走 `store.networkStats`（与侧栏「目标分析」同一口径），不在这里自己数步数 ——
 *    否则同一张网在两处会出现两个数字。
 */
const cur = computed(() => store.networkStats);
/** 一步都还没有时别显示 100.00%（各步连乘的空积就是 1，看起来像"整条路线成立"） */
const totalPct = computed(() =>
  cur.value.steps ? `${(cur.value.probability * 100).toFixed(2)}%` : '—'
);
/** 同一目标下的多条路线网络（已确认的在前） */
const networks = computed(() => store.routeNetworks);
const startList = computed(() => store.startingMaterials);

/**
 * 「路线网络」列表为空时，补一句说明。
 *
 * 🔴 不能不吭声：`.ov__nets` 的 `v-if` 一旦为假，卡片里就只剩 chips 与步骤表，
 *    看上去像"目标分析页签不显示路线网络"（用户报的就是这个）。
 *    侧栏同款场景是有 `.tan__hint` 的，页签这边原本什么都没有 —— 同一份状态
 *    两处口径不一，用户只能猜。
 *    ⚠️ 只在树上有步骤时才提这条：一步都没有时，下面 `.ov__empty` 那段
 *    （"还没有确定的路线…"）已经把话说完了，两条一起出现是重复。
 */
const showNetHint = computed(() => !networks.value.length && steps.value.length > 0);

/** 切换当前查看的网络（不删节点，旧子树只是藏起来） */
function switchNet(id: string): void {
  if (id === store.currentSchemeId) return;
  store.applyScheme(id);
  ElMessage.success('已切到这条路线网络');
}

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
      <!-- ② 路线网络：当前这条网络的多步路线（含分支）+ 同一目标下的多条网络。
           「已确认路线」这个叫法已经不准确了 —— 一条路线可以有分支（多组分反应
           一步拆出多个前体），那就是一张网；而且同一目标可以确认**多条**。 -->
      <section class="rw-card ov__route">
        <div class="rw-card__head">
          <div class="rw-card__title">路线网络</div>
          <div class="ov__chips">
            <span class="ov__chip"><b>{{ cur.steps }}</b> 步</span>
            <span class="ov__chip"><b>{{ cur.branches }}</b> 分支</span>
            <span class="ov__chip ov__chip--brand"><b>{{ totalPct }}</b> 总概率</span>
            <span class="ov__chip"><b>{{ cur.terminals }}/{{ cur.leaves }}</b> 起始物料</span>
            <span class="ov__chip"><b>第 {{ cur.depth }}</b> 层 最深</span>
          </div>
        </div>
        <div class="rw-card__body ov__route-body">
          <!-- 多条网络：点一条即切过去（不删任何节点，旧子树只是藏起来） -->
          <div v-if="networks.length" class="ov__nets">
            <button
              v-for="n in networks"
              :key="n.schemeId"
              type="button"
              class="ov__net"
              :class="{ 'is-current': n.schemeId === store.currentSchemeId, 'is-confirmed': n.confirmed }"
              :title="`切到「${n.name}」：${n.steps} 步 · ${n.branches} 分支 · 总概率 ${pctText(n.probability)}`"
              @click="switchNet(n.schemeId)"
            >
              <span class="ov__net-name">{{ n.name }}</span>
              <span v-if="n.confirmed" class="ov__net-tag">已确认</span>
              <span v-else class="ov__net-tag ov__net-tag--draft">备选</span>
              <span class="ov__net-meta">{{ n.steps }} 步 · {{ n.branches }} 分支</span>
            </button>
          </div>

          <!-- 一条网络都还没存过：说清"这里为什么空、怎么才有"（见 showNetHint 注释） -->
          <p v-if="showNetHint" class="ov__net-hint">
            当前这条路线还没存成「路线网络」—— 到「<b>逆合成树</b>」页签点「<b>确认路线网络</b>」，
            它就会记在这里；同一个目标可以确认多条（比如小试 / 放大各一条），随时切换对比。
          </p>

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
              还没有确定的路线。到「<b>逆合成树</b>」页签展开目标分子的候选反应，采纳其中一条并继续往下拆，
              拆到满意后点「<b>确认路线网络</b>」—— 这条多步路线（含分支）就会记在这里；
              换掉某一步再确认一条，两条网络都留着，随时切换对比。
            </p>
            <div class="ov__empty-ops">
              <el-button size="small" type="primary" @click="store.mainTab = 'tree'">去逆合成树</el-button>
              <el-button size="small" @click="store.mainTab = 'route'">查看网络图</el-button>
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

/* ---------- 路线网络 ---------- */
/* 多条网络的切换条：一行 chip，已确认的带绿色徽标与绿色描边 */
.ov__nets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

/* 网络列表为空时的说明（见 showNetHint 注释）。
   虚线 + 浅底 = "这里本该有东西，但还没有"；与侧栏 `.tan__hint` 同款语气，
   两处对同一状态的解释才一致。 */
.ov__net-hint {
  margin: 0 0 10px;
  padding: 6px 10px;
  border: 1px dashed var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  font-size: 12px;
  line-height: 1.65;
  color: var(--rw-text-3);
}

.ov__net-hint b {
  color: var(--rw-text-2);
}

.ov__net {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  background: var(--rw-surface-2);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.ov__net:hover {
  border-color: var(--rw-brand);
}

.ov__net.is-current {
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
}

/* 圆角 chip 上没法用「左侧实线」（会被圆角裁掉）⇒ 改用绿色描边 + 徽标 */
.ov__net.is-confirmed {
  border-color: color-mix(in srgb, var(--rw-ok) 45%, var(--rw-border));
}

.ov__net-name {
  max-width: 200px;
  font-size: 12px;
  color: var(--rw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov__net-tag {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--rw-ok-l);
  color: var(--rw-ok);
  font-size: 10.5px;
  font-weight: 600;
}

.ov__net-tag--draft {
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-weight: 500;
}

.ov__net-meta {
  font-size: 11px;
  color: var(--rw-text-3);
  font-variant-numeric: tabular-nums;
}

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
