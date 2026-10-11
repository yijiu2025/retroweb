<script setup lang="ts">
/**
 * 「目标分析」总览 —— 路线态的首页（页签里的第一个，默认展示）。
 *
 * 为什么把它做成默认页签：一个任务真正要先看清的是**「在拆什么 + 已经确认到哪一步」**，
 * 而不是一屏还没长开的逆合成树。树 / 路线网络 / 步骤详情都在页签里，随时可进。
 *
 * 三块内容：
 *   ① 目标分子：结构式 + 分子式 / 分子量 / 重原子 / CAS + SMILES（可复制、可跳转换目标）
 *   ② 已确认路线：沿当前采纳分支回溯出的每一步（产物 ← 前体 + 概率）与整体指标
 *   ③ 起始物料：已经走到「可购买 / 低于阈值 / 已终止」的叶子
 *
 * 分子一律「**结构式 + SMILES + CAS**」三件套（`MolChip` / `CasTag`）：
 * 只看 SMILES 认不出分子，只看结构式又没法复制、没法核对 CAS。
 * CAS 来自 PubChem 公开库（按**结构**精确检索，见 `utils/pubchem.ts`），
 * **查得到才显示** —— 不占位、不猜；没收录的分子在这里就是没有那一行。
 *
 * 数据全部来自 store 的派生量（route / routeProbability / startingMaterials / stats），
 * 不在这里重算 —— 统计口径只允许有一个来源。
 */
import { computed, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { useSettingsStore } from '@/stores/settings';
import MolView from '@/components/mol/MolView.vue';
import MolChip from '@/components/mol/MolChip.vue';
import CasTag from '@/components/mol/CasTag.vue';
import { casState, requestCasMany } from '@/utils/pubchem';
import { copyText } from '@/utils/clipboard';
import { routePct } from '@/utils/probability';
import { dateTime, absoluteTime } from '@/utils/time';

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
  cur.value.steps ? routePct(cur.value.probability, cur.value.manualSteps) : '—'
);
/** 同一目标下的多条路线网络（已确认的在前） */
const networks = computed(() => store.routeNetworks);
const startList = computed(() => store.startingMaterials);

/**
 * CAS 查询排队（PubChem 公开库，见 `utils/pubchem.ts`）。
 *
 * 只负责「目标分子 + 起始物料」这两处 —— 表格里的分子由 `MolChip` 自己触发。
 * 入队是幂等的、且全局按 SMILES 去重 ⇒ 重复触发不会产生第二次请求。
 *
 * ⚠️ 目标分子那一格用 `v-if="hasCas(...)"` 控制显隐 ⇒ 它的 `CasTag` 有可能整个
 *    不挂载，所以**必须**在这里主动排队，别指望子组件替它发起查询。
 */
watch(
  () => [root.value?.smiles ?? '', ...startList.value.map((n) => n.smiles)],
  (list) => requestCasMany(list.filter((s) => s !== '')),
  { immediate: true }
);

/** 目标分子有没有查到 CAS（决定「CAS」那一格出不出） */
function hasCas(smiles: string | undefined): boolean {
  return !!smiles && !!casState(smiles);
}

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

/**
 * 一条路线的总概率。
 * 🔴 含手动步时必须带上「含 N 步手动」：连乘对手动步按 1 计，
 *    这个数字与纯模型路线的总概率**不可比**。口径统一在 utils/probability。
 */
function pctText(p: number, manualSteps = 0): string {
  return routePct(p, manualSteps, 1);
}

/** 复制目标分子的 SMILES（走全站唯一入口，见 utils/clipboard.ts） */
async function copySmiles(): Promise<void> {
  const t = root.value;
  if (!t) return;
  await copyText(t.smiles, {
    okMsg: '已复制 SMILES',
    failMsg: '浏览器不允许自动复制，请手动选中 SMILES 复制'
  });
}

/* ---------- 任务元信息 + 改名 ---------- */

/** 当前会话（展示「开启时间 / 模型」等元信息） */
const currentSession = computed(() =>
  store.sessions.find((s) => s.id === store.currentSessionId)
);

/** 开启时间：优先 createdAt（创建时刻），老数据 fallback updatedAt。
 *  显示用「YYYY-MM-DD HH:mm」（短格式不折行），精确到秒的完整值进 title。 */
const openedText = computed(() => {
  const s = currentSession.value;
  if (!s) return '';
  return dateTime(s.createdAt ?? s.updatedAt);
});
const openedFull = computed(() => {
  const s = currentSession.value;
  if (!s) return '';
  return absoluteTime(s.createdAt ?? s.updatedAt);
});

/** 改名：ElMessageBox.prompt 弹输入框，确认后走 store.renameSession */
async function renameTask(): Promise<void> {
  const s = currentSession.value;
  if (!s) return;
  try {
    const { value } = await ElMessageBox.prompt('给这个任务起个名字', '重命名任务', {
      inputValue: s.name,
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValidator: (v) => (v && v.trim() ? true : '名字不能为空')
    });
    store.renameSession(s.id, value);
    ElMessage.success('已重命名');
  } catch {
    /* 用户取消 */
  }
}
</script>

<template>
  <div v-if="root" class="ov">
    <!-- ① 目标分子 -->
    <section class="rw-card ov__target">
      <div class="rw-card__head">
        <div class="rw-card__title">
          <span class="ov__task-name" :title="currentSession?.name">{{ currentSession?.name || '目标分子' }}</span>
          <button type="button" class="ov__rename" title="重命名任务" @click="renameTask">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M11.3 3.1 13 4.8 6 11.8 4 12l.2-2 5.1-6.9Z" />
            </svg>
          </button>
        </div>
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
          <!-- 🔴 任务元信息（用户要求：时间等放目标分析主页，不放任务列表）；
                开启时间占满两列（短格式），完整到秒的值进 title -->
          <span v-if="openedText" class="ov__prop-wide" :title="`开启时间 ${openedFull}`"><i>开启</i>{{ openedText }}</span>
          <span v-if="currentSession?.model"><i>模型</i>{{ currentSession.model }}</span>
          <!-- CAS 来自 PubChem（按结构检索）：**查到才有这一格**，查不到就不占位。
               点它去 PubChem 详情页核对 —— 这就是「到哪儿查 CAS」的入口。 -->
          <span v-if="hasCas(root.smiles)"><i>CAS</i><CasTag :smiles="root.smiles" :prefix="false" /></span>
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
              :title="`切到「${n.name}」：${n.steps} 步 · ${n.branches} 分支 · 总概率 ${pctText(n.probability, n.manualSteps)}`"
              @click="switchNet(n.schemeId)"
            >
              <span class="ov__net-name">{{ n.name }}</span>
              <span v-if="n.confirmed" class="ov__net-tag">已确认</span>
              <span v-else class="ov__net-tag ov__net-tag--draft">备选</span>
              <!-- 🔴 总概率（横向选优的**主指标**）必须落在这条 chip 上：
                   顶部 `SchemeBar` 在「目标分析」页签已整条收起（见 WorkspaceView），
                   这一页只剩这排 chip 可比 —— 少了概率就只剩名字，等于没法选优。
                   口径与侧栏 `.tan__net-meta`（同一步数 / 分支 / 概率）保持一致。 -->
              <span class="ov__net-meta">{{ n.steps }} 步 · {{ n.branches }} 分支 · {{ pctText(n.probability, n.manualSteps) }}</span>
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
                <!-- 产物 / 前体：**结构式 + SMILES + CAS** 三件套。
                     用户报「显示结构式」指的就是这里 —— 原来只有一串 SMILES 文本，
                     人眼认不出分子；加上缩略结构式后点它还能放大核对。
                     CAS 由 MolChip 里的 CasTag 按结构去 PubChem 查，查到才显示。 -->
                <td>
                  <MolChip
                    :smiles="s.product"
                    :formula="s.productFormula"
                    :mol-w="74"
                    :mol-h="52"
                    :bond-px="17"
                    @preview="emit('preview', $event)"
                  />
                </td>
                <!-- 🔴 flex 必须挂在这个**内层 div** 上，不能挂在 `<td>` 上。
                     一旦给 `<td>` 设 `display:flex`，它就不再是真正的表格单元格
                     ⇒ 不再拉伸到行高，自己那条 `border-bottom` 画在自己的内容高度上
                     ⇒ 同一行的分隔线裂成两段、错开 6px（用户报的"中间线没在同一条直线上"）。 -->
                <td>
                  <div class="ov__precursors">
                    <MolChip
                      v-for="p in s.precursors"
                      :key="p"
                      :smiles="p"
                      :mol-w="64"
                      :mol-h="46"
                      :bond-px="15"
                      @preview="emit('preview', $event)"
                    />
                  </div>
                </td>
                <!-- 这一行是**一步**（RouteStep）：手动步没有模型概率 ⇒ 写「手动」，
                     别拿连乘里的 1 显示成 100% -->
                <td class="ov__p">{{ s.manual ? '手动' : pctText(s.probability) }}</td>
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
            <!-- 🔴 卡片外壳是 `div` 而不是 `button`：里面要放 CAS 链接（`<a>`），
                 而 `<a>` 嵌在 `<button>` 里是**无效 HTML**（浏览器会重排 DOM，
                 点链接还会连带触发外层的「放大预览」）。
                 改成「div 外壳 + 内部结构式按钮」后，可点热区就是缩略图本身 ——
                 与表格里的 `MolChip` 手势一致（都是点结构式放大）。 -->
            <div v-for="n in startList" :key="n.id" class="ov__start-item">
              <button
                type="button"
                class="ov__start-mol"
                :title="`${n.smiles}\n点击放大查看结构式`"
                @click="emit('preview', n.smiles)"
              >
                <MolView :smiles="n.smiles" fit :bond-px="18" :min-px="40" :max-px="80" />
              </button>
              <span class="ov__start-info">
                <code class="rw-mono" :title="n.smiles">{{ n.smiles }}</code>
                <i>{{ n.formula || '—' }}</i>
                <CasTag :smiles="n.smiles" />
              </span>
            </div>
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

/* 开启时间占满两列（值较长，塞半列必折行） */
.ov__prop-wide {
  grid-column: 1 / -1;
}

/* 任务名（卡片头左侧）+ 重命名小图标 */
.ov__task-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ov__rename {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--rw-text-3);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.ov__rename:hover {
  color: var(--rw-brand);
  background: var(--rw-surface-3);
}

.ov__rename svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
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

/* 前体可能有多个（多组分反应一步拆出好几支）⇒ 横向排开、放不下就换行。
   🔴 用 `wrap` 而不是原来的 `column`：每个前体现在是一整张
      「结构式 + SMILES + CAS」小卡，竖排会把行高撑到没法看。
   🔴 这一条**必须挂在 `<td>` 里面的 div 上**，不能挂在 `<td>` 本身：
      `display:flex` 会把 td 变成非表格单元格 ⇒ 不再拉伸到行高 ⇒
      它的 `border-bottom` 与同排其它格错开 6px，行分隔线当场断成两截
      （`diag-tbl-line.cjs` 量的就是这 6px；守门 `verify-tbl-lines.cjs`）。 */
.ov__precursors {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
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

/* 卡片外壳**不可点**了：可点的只有里面那张缩略图（见模板注释） */
.ov__start-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  text-align: left;
}

/* 缩略图本身是按钮（点击放大）⇒ hover 反馈落在它身上，
   别让整张卡看起来可点（卡片里还挂着 CAS 外链） */
.ov__start-mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 46px;
  flex: 0 0 58px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--rw-surface);
  overflow: hidden;
  cursor: zoom-in;
  transition: border-color 0.15s;
}

.ov__start-mol:hover {
  border-color: var(--rw-brand);
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
