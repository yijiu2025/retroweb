<script setup lang="ts">
/**
 * 单步候选反应面板（点行内「展开」后出现）—— **反应方程式**排布（2026-10-06 重做）。
 *
 * 旧版是「一格一候选」的卡片网格：概率条、结构、按钮竖着堆，看不出这条候选
 * 到底是「什么 → 什么」。新版一行 = 一条完整方程式，与路线图同一套视觉语言：
 *
 *   [前体₁] + [前体₂] ──(82.0%)──▶ [产物]
 *
 *   · 原料在左、产物在右 —— 和路线图「合成方向」同向，看懂一个就看懂两个；
 *   · 概率挂在箭头上方的小圆片里 —— 呼应路线图边上的 Step chip；
 *   · 前体满足终止条件（重原子 ≤ 阈值 / 自定义起始物料）直接标「可购买」，
 *     用户扫一眼就知道哪条候选的原料更省事（Reaxys 的商业化语义）；
 *   · 采纳按钮在行尾，已采纳整行绿色高亮。
 *
 * 🔴 每次分析都**追加保留**（node.runs）：跑第二次不会把第一次的候选冲掉，
 *    顶部下拉可来回切看/切采纳；已采纳的选择也会随「那次分析」记住。
 * 🔴 若这个分子的分析结果是复用树上另一个相同分子来的，会明确标出来，
 *    并给一个「自己跑一遍」的入口。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { useSettingsStore } from '@/stores/settings';
import type { AnalysisRun } from '@/types/retro';
import { countHeavyAtoms } from '@/utils/smiles';
import { SUPPLIERS, querySupplier, resolveSupplierQuery } from '@/utils/suppliers';
import { requestCas } from '@/utils/pubchem';
import MolView from '@/components/mol/MolView.vue';

const props = defineProps<{ nodeId: string }>();
const store = useWorkspaceStore();
const settings = useSettingsStore();

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

/**
 * 前体是否直接满足终止条件 —— 采纳后它就是叶子，不再往下拆。
 * 🔴 判据与 store.isTerminal 同口径（重原子 ≤ 阈值 / 用户自定义起始物料），
 *    但前体还不是树上的节点，只能拿 SMILES 现算。
 */
function precursorBuyable(smi: string): boolean {
  if (store.params.startingMaterials.includes(smi)) return true;
  return countHeavyAtoms(smi) <= store.params.heavyAtomThreshold;
}

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

function smilesLabel(smi: string): string {
  return smi.length > 16 ? `${smi.slice(0, 16)}…` : smi;
}

/** 打开某供应商查价（新标签页）；用哪家由用户当场点的这一下决定，不改默认值 */
function onQuery(smiles: string, supplierId: string): void {
  querySupplier(supplierId, smiles, settings.supplierPreferCas);
}

/**
 * 拉开询价菜单时才查这个前体的 CAS。
 * 🔴 与 StepRow 的理由相同（菜单要显示「这次用 CAS 还是 SMILES」），
 *    但这里更划算：候选面板一展开就是好几个前体，挂载即全查会把 PubChem 队列塞满，
 *    而绝大多数候选根本没人去点它的 ¥。
 */
function onQueryMenu(visible: boolean, smiles: string): void {
  if (visible && smiles) requestCas(smiles);
}

/** 菜单里这家这次会用哪个标识（与点下去走同一条解析） */
function supplierIdent(supplierId: string, smiles: string): string {
  return resolveSupplierQuery(supplierId, smiles, settings.supplierPreferCas)?.label ?? '';
}

/** 这家是不是当前默认供应商 */
function isDefaultSupplier(supplierId: string): boolean {
  return settings.supplierId === supplierId;
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
      一行一条候选：前体 → 产物，箭头上是该步概率；标「可购买」的前体采纳后即到路线尽头
    </div>

    <el-skeleton v-if="node?.status === 'loading'" :rows="2" animated />

    <el-empty
      v-else-if="!node?.candidates.length"
      :image-size="48"
      :description="node?.error || '该分子没有给出候选反应（可能已是起始物料）'"
    />

    <div v-else class="cand__list">
      <div
        v-for="rxn in node.candidates"
        :key="rxn.id"
        class="rxn"
        :class="{ 'is-adopted': adoptedId === rxn.id }"
      >
        <!-- 名次 + 置信分级 -->
        <div class="rxn__rank">
          <b>#{{ rxn.rank }}</b>
          <el-tag :type="levelTag[rxn.level]" size="small" effect="light">
            {{ levelText[rxn.level] }}
          </el-tag>
        </div>

        <!-- 方程式：前体（左）→ 箭头（带概率）→ 产物（右） -->
        <div class="rxn__eq">
          <template v-for="(smi, i) in rxn.precursorList" :key="smi + i">
            <span v-if="i > 0" class="rxn__plus">+</span>
            <div class="rxn__mol">
              <div class="rxn__mol-struct">
                <!-- 🔴 fit：容器 112×62 定尺寸 + overflow:hidden。非 fit 走「恒定键长」算尺寸，
                     maxPx=110 只压最长边、不保证横向不超宽 ⇒ 长链/多环分子右边被裁掉。
                     fit 让 SVG 宽高 100% + viewBox 等比缩放，分子永远完整铺满、不被裁。 -->
                <MolView :smiles="smi" fit />
              </div>
              <div class="rxn__mol-meta">
                <code class="rw-mono" :title="smi">{{ smilesLabel(smi) }}</code>
                <template v-if="precursorBuyable(smi)">
                  <!-- 🔴 `el-dropdown` 在 pill 外面 ⇒ 「可购买」整块都是查价热区。
                       原来只有那颗 16px 的 ¥ 能点，点「可购买」三个字没反应
                       （StepRow 的标签行踩过同一个坑）。¥ 收进 pill 内部，
                       两者永远是「可购买 [¥]」一体，窄屏换行也不会被拆开。 -->
                  <el-dropdown
                    trigger="click"
                    size="small"
                    @command="(sid: string) => onQuery(smi, sid)"
                    @visible-change="(v: boolean) => onQueryMenu(v, smi)"
                  >
                    <span class="rxn__buy" title="点击选择供应商查价">
                      可购买<i class="rxn__query" aria-hidden="true">¥</i>
                    </span>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item
                          v-for="s in SUPPLIERS"
                          :key="s.id"
                          :command="s.id"
                        >
                          <span class="rxn__supplier-name">{{ s.name }}</span>
                          <span v-if="isDefaultSupplier(s.id)" class="rxn__supplier-def">默认</span>
                          <span class="rxn__supplier-tag">{{ s.tag }}</span>
                          <span class="rxn__supplier-ident">{{ supplierIdent(s.id, smi) }}</span>
                        </el-dropdown-item>
                        <div class="rxn__supplier-footnote">
                          跳转后粘贴标识即可（已自动复制）；默认供应商在右侧「采购询价」里设
                        </div>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </template>
              </div>
            </div>
          </template>

          <div class="rxn__arrow" :title="`该步概率 ${(rxn.probability * 100).toFixed(1)}%`">
            <span class="rxn__arrow-prob">{{ (rxn.probability * 100).toFixed(1) }}%</span>
            <span class="rxn__arrow-line" aria-hidden="true"></span>
          </div>

          <div class="rxn__mol is-product">
            <div class="rxn__mol-struct">
              <MolView :smiles="node?.smiles ?? ''" fit />
            </div>
            <div class="rxn__mol-meta">
              <code class="rw-mono" :title="node?.smiles">{{ smilesLabel(node?.smiles ?? '') }}</code>
            </div>
          </div>
        </div>

        <!-- 行尾动作 -->
        <div class="rxn__ops">
          <el-button
            v-if="adoptedId !== rxn.id"
            type="primary"
            size="small"
            @click="onAdopt(rxn.id)"
          >
            采纳
          </el-button>
          <el-tag v-else type="success" size="small" effect="dark">已采纳</el-tag>
          <span class="rxn__count">{{ rxn.numMolecules }} 个前体</span>
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

/* ---------- 候选行：一条方程式一行 ---------- */
.cand__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rxn {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}

.rxn:hover {
  border-color: var(--rw-brand);
  box-shadow: var(--rw-shadow-1);
}

/* 已采纳：绿色高亮（与旧版一致的成功语义） */
.rxn.is-adopted {
  border-color: var(--rw-ok);
  background: var(--rw-ok-l);
}

/* 名次 + 置信分级（竖排小列） */
.rxn__rank {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  min-width: 52px;
}

.rxn__rank b {
  font-size: 13px;
  color: var(--rw-text-3);
}

/* 方程式主体：允许换行兜底（前体多时） */
.rxn__eq {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.rxn__plus {
  color: var(--rw-text-3);
  font-size: 15px;
}

/* 分子：结构图 + SMILES/可购买 */
.rxn__mol {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 92px;
}

.rxn__mol-struct {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 112px;
  height: 62px;
  padding: 3px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface-2);
  overflow: hidden;
}

/* 产物：品牌色边框 —— 呼应路线图的目标卡高亮 */
.rxn__mol.is-product .rxn__mol-struct {
  border: 1.5px solid var(--rw-brand);
  background: var(--rw-brand-l);
}

.rxn__mol-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 116px;
}

.rxn__mol-meta code {
  font-size: 10px;
  color: var(--rw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rxn__buy {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px 0 6px;
  border-radius: 999px;
  background: var(--rw-ok-l);
  color: var(--rw-ok);
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.rxn__buy:hover {
  background: var(--rw-ok);
  color: #fff;
}

/* 询价入口：pill 里的 ¥ 小圆钮 —— 整块 pill 都是热区，它只是"能点"的视觉提示 */
.rxn__query {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--rw-brand);
  color: #fff;
  font-size: 9px;
  font-style: normal;
  font-weight: 700;
  line-height: 1;
}

.rxn__buy:hover .rxn__query {
  background: #fff;
  color: var(--rw-ok);
}

.rxn__supplier-name {
  font-weight: 600;
}

/* 「默认」角标：小一号、淡底色 —— 是说明不是按钮 */
.rxn__supplier-def {
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--rw-border-strong);
  border-radius: 999px;
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 10px;
  line-height: 15px;
}

.rxn__supplier-tag {
  margin-left: 8px;
  font-size: 11px;
  color: var(--rw-text-3);
}

/* 这家这次用的标识：等宽字体（CAS 号的数字要对齐才扫得快） */
.rxn__supplier-ident {
  margin-left: 10px;
  font-family: var(--rw-font-mono);
  font-size: 11px;
  color: var(--rw-text-3);
}

.rxn__supplier-footnote {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--rw-text-3);
  white-space: normal;
  line-height: 1.5;
}

/* ---------- 反应箭头：概率挂在线上方 ---------- */
.rxn__arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 auto;
  min-width: 86px;
  padding: 0 4px;
}

.rxn__arrow-prob {
  margin-bottom: 3px;
  padding: 1px 8px;
  border: 1px solid var(--rw-border-strong);
  border-radius: 999px;
  background: var(--rw-surface);
  box-shadow: var(--rw-shadow-1);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--rw-text-2);
  white-space: nowrap;
}

.rxn__arrow-line {
  position: relative;
  width: 100%;
  height: 0;
  border-top: 1.6px solid var(--rw-border-strong);
}

/* 箭头头部：一个小的实心三角 */
.rxn__arrow-line::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -4.3px;
  border-left: 7px solid var(--rw-border-strong);
  border-top: 3.5px solid transparent;
  border-bottom: 3.5px solid transparent;
}

/* ---------- 行尾动作 ---------- */
.rxn__ops {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.rxn__count {
  font-size: 10.5px;
  color: var(--rw-text-3);
  white-space: nowrap;
}

.cand__undo {
  margin-top: 10px;
  text-align: right;
}

/* 窄屏：动作落到方程式下方 */
@media (max-width: 900px) {
  .rxn {
    flex-wrap: wrap;
  }

  .rxn__ops {
    flex-direction: row;
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
