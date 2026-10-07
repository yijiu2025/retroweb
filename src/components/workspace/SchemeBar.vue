<script setup lang="ts">
/**
 * 路线网络栏 —— 同一个目标分子下的**多条路线**的保存 / 切换 / 确认 / 对比。
 *
 * 用法（工作流）：
 *   ① 在路线树里拆出一条路线 → 点「存为新方案」；
 *   ② 换掉某一步的候选（或继续往下拆别的分支）→ 再「存为新方案」；
 *   ③ 点方案名随时切回去 —— 切换**不删任何节点**（旧子树只是藏起来），
 *      所以来回切不丢工作、也不用重跑模型。
 *
 * 🔴 一条网络**只画一遍**：卡片行里给全 步数 / 分支 / 总概率 / 起始物料 / 最深，
 *    横向选优靠行与行逐项对照。曾经在这排卡片下面又挂了一张同数据的对比表，
 *    同一份 `schemeStats` 被渲染两遍 —— 白占高度，而且看上去像两批不同的数据。
 *
 * 🔴 总概率是选优的**主指标**，必须独立出来加重显示：
 *    混在灰色小字里时，五个 `·` 串成一行，概率等于看不见（原表格反倒是靠"排成一列"
 *    才让它显眼）。所以把原表格唯一多出来的价值 —— 一眼能比的总概率 —— 并进卡片。
 */
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { promptSaveScheme } from '@/utils/scheme-save';

const store = useWorkspaceStore();

const stats = computed(() => store.schemeStats ?? []);
/** 已确认的条数（标题里直接写出来，省得用户自己数） */
const confirmedCount = computed(() => store.confirmedNetworkCount);

function pct(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(2)}%`;
}

/**
 * 「存为新方案」—— Slim Header（TargetBar）上也有同一个入口，
 * 两处共用 `promptSaveScheme`，免得起名文案 / 默认名 / 前置校验分叉。
 */
function onSave(): Promise<void> {
  return promptSaveScheme(store);
}

async function onRename(id: string, old: string): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('重命名这条路线', '重命名', {
      inputValue: old,
      confirmButtonText: '确定',
      cancelButtonText: '取消'
    });
    store.renameScheme(id, value || old);
  } catch {
    /* 用户取消 */
  }
}

function onApply(id: string): void {
  store.applyScheme(id);
  ElMessage.success('已切换到该路线网络');
}

/**
 * 确认为「采用中的路线网络」。
 *
 * 🔴 用 `store.confirmScheme(id)` 而不是 `confirmRouteNetwork()`：
 *    用户点的是**这一行**，语义就是"把这一条标为已确认"；
 *    树工具条那个按钮才是"把当前这棵树记成一条网络"（该分叉时自动分叉）。
 */
function onConfirm(id: string): void {
  store.confirmScheme(id);
  ElMessage.success('已确认这条路线网络（可继续确认别的分支，多条并存）');
}

function onUnconfirm(id: string): void {
  store.unconfirmRouteNetwork(id);
  ElMessage.success('已取消确认：记录保留，退回备选');
}

async function onRemove(id: string, name: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除路线方案「${name}」？（只删这个方案，已分析的分子都还在）`, '删除方案', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  store.removeScheme(id);
}
</script>

<template>
  <!-- 空态：收成一行，不占地方（"还没有方案"不值得一张卡的高度）；
       一旦存了第一条方案，才展开成完整卡片 -->
  <section v-if="!stats.length" class="rw-card schemes schemes--empty">
    <div class="schemes__empty">
      <span class="schemes__empty-title">
        <svg class="schemes__ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
        </svg>
        路线网络
      </span>
      <span class="schemes__empty-hint">
        拆出一条多步路线后点「确认路线网络」，同一目标可以确认多条（含分支的更长路线）
      </span>
      <el-button size="small" type="primary" plain :disabled="!store.rootId" @click="onSave">
        存为新方案
      </el-button>
    </div>
  </section>

  <section v-else class="rw-card schemes">
    <div class="rw-card__head">
      <div class="rw-card__title">
        <svg class="schemes__ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
        </svg>
        路线网络
        <span class="schemes__sub">已确认 {{ confirmedCount }} / 共 {{ stats.length }} 条，可切换对比</span>
      </div>
      <div class="schemes__ops">
        <el-button size="small" type="primary" plain :disabled="!store.rootId" @click="onSave">
          存为新方案
        </el-button>
      </div>
    </div>

    <div class="rw-card__body schemes__body">
      <ul class="schemes__list">
        <li
          v-for="s in stats"
          :key="s.schemeId"
          class="schemes__item"
          :class="{ 'is-current': s.schemeId === store.currentSchemeId, 'is-confirmed': s.confirmed }"
        >
          <div class="schemes__main">
            <div class="schemes__line">
              <span class="schemes__name">{{ s.name }}</span>
              <el-tag v-if="s.schemeId === store.currentSchemeId" size="small" effect="dark">当前</el-tag>
              <!-- 已确认 = 真正采用的路线网络；未确认只是存下来比一比的备选 -->
              <el-tag v-if="s.confirmed" size="small" type="success" effect="dark">已确认</el-tag>
              <el-tag v-else size="small" type="info" effect="plain">备选</el-tag>
              <el-tag v-if="s.complete" size="small" type="success" effect="light">完整</el-tag>
              <el-tag v-else size="small" type="info" effect="plain">未拆完</el-tag>
            </div>
            <div class="schemes__meta">
              <span>{{ s.steps }} 步</span>
              <span class="schemes__sep">·</span>
              <span>{{ s.branches }} 分支</span>
              <span class="schemes__sep">·</span>
              <span>起始物料 {{ s.terminals }}/{{ s.leaves }}</span>
              <span class="schemes__sep">·</span>
              <span>最深第 {{ s.depth }} 层</span>
            </div>
          </div>

          <!-- 主指标：原对比表那一列，独立出来加重 —— 横向选优一眼就能比 -->
          <div class="schemes__prob">
            <span class="schemes__prob-k">总概率</span>
            <span class="schemes__prob-v">{{ pct(s.probability) }}</span>
          </div>

          <div class="schemes__actions">
            <el-button
              v-if="s.schemeId !== store.currentSchemeId"
              size="small"
              type="primary"
              @click="onApply(s.schemeId)"
            >
              切换
            </el-button>
            <el-button v-if="!s.confirmed" size="small" text type="success" @click="onConfirm(s.schemeId)">
              确认
            </el-button>
            <el-button v-else size="small" text @click="onUnconfirm(s.schemeId)">取消确认</el-button>
            <el-button size="small" text @click="onRename(s.schemeId, s.name)">改名</el-button>
            <el-button size="small" text type="danger" @click="onRemove(s.schemeId, s.name)">删除</el-button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* ---------- 空态：一行搞定 ---------- */
.schemes--empty {
  /* 比完整卡片更轻：无标题栏、无分隔线，只占一行高度 */
  border-style: dashed;
}

.schemes__empty {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
}

.schemes__empty-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text-2);
  white-space: nowrap;
}

/* 标题图标：与运行参数分组图标同一套风格（品牌色细线 SVG） */
.schemes__ico {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: none;
  stroke: var(--rw-brand);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.9;
}

.schemes__sub {
  font-size: 11.5px;
  font-weight: 400;
  color: var(--rw-text-3);
}

.schemes__empty-hint {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--rw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.schemes__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.schemes__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.schemes__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--rw-border);
  border-radius: 8px;
  background: var(--rw-surface-2);
}

.schemes__item.is-current {
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
}

/* 已确认 = 采用中的路线网络：左侧一条绿色实线（与侧栏网络列表同一套视觉语言） */
.schemes__item.is-confirmed {
  border-left: 2px solid var(--rw-ok);
}

/* 撑满剩余宽度 ⇒ 概率与操作区被顶到右侧，且各行纵向对齐（代替原来的对比表） */
.schemes__main {
  flex: 1 1 auto;
  min-width: 0;
}

.schemes__line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.schemes__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.schemes__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--rw-text-3);
}

.schemes__sep {
  opacity: 0.5;
}

/* 主指标：允许在窄容器里被压缩，但数字本身不换行（`15.00%` 拆行会读不成数） */
.schemes__prob {
  flex: 0 1 auto;
  display: flex;
  align-items: baseline;
  gap: 5px;
  white-space: nowrap;
}

.schemes__prob-k {
  font-size: 11px;
  color: var(--rw-text-3);
}

.schemes__prob-v {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--rw-text);
  /* 等宽数字 ⇒ 各行小数点对齐，这才是原表格真正给到的东西；
     再定宽右对齐 ⇒ "72.00%" 与 "100.00%" 占同样宽度，右侧操作按钮起点也跟着对齐 */
  font-variant-numeric: tabular-nums;
  min-width: 56px;
  text-align: right;
}

.schemes__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  flex: 0 0 auto;
  /* 🔴 定宽（实测自然宽：有「切换」的行 228px，没有的 190px）。
     不定宽 → 操作区宽度随"这行有没有切换按钮"变化 → 各行的总概率数值落不到同一条
     竖线上，"横向比概率"就得上下找。宁可右边让出一点空，也要把这条竖线立起来。
     守门：verify-scheme-merge.cjs 量各行 `.schemes__actions` 左边界必须完全一致。 */
  min-width: 232px;
}
</style>
