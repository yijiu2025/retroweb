<script setup lang="ts">
/**
 * 路线方案栏 —— 同一个目标分子下的**多条路线**的保存 / 切换 / 对比。
 *
 * 用法（工作流）：
 *   ① 在路线树里拆出一条路线 → 点「存为新方案」；
 *   ② 换掉某一步的候选（或继续往下拆别的分支）→ 再「存为新方案」；
 *   ③ 点方案名随时切回去 —— 切换**不删任何节点**（旧子树只是藏起来），
 *      所以来回切不丢工作、也不用重跑模型。
 *
 * 表格给出每条方案的总步数 / 总概率 / 起始物料数 / 是否完整，便于横向选优。
 */
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';

const store = useWorkspaceStore();

const stats = computed(() => store.schemeStats ?? []);

function pct(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(2)}%`;
}

async function onSave(): Promise<void> {
  if (!store.rootId) {
    ElMessage.warning('还没有路线可保存，请先设定目标分子并拆几步');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt(
      '给这条路线起个名字（例如「路线 A：走酰氯」「路线 B：走酸酐」）',
      '存为一条路线方案',
      {
        inputValue: `路线 ${stats.value.length + 1}`,
        confirmButtonText: '保存',
        cancelButtonText: '取消'
      }
    );
    store.saveScheme(value);
    ElMessage.success('已存为一条路线方案，可继续改选择再存下一条');
  } catch {
    /* 用户取消 */
  }
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
  ElMessage.success('已切换到该路线方案');
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
      <span class="schemes__empty-title">④ 路线方案</span>
      <span class="schemes__empty-hint">
        拆出一条路线后点「存为新方案」，就能切换对比同一目标的多条路线
      </span>
      <el-button size="small" type="primary" plain :disabled="!store.rootId" @click="onSave">
        存为新方案
      </el-button>
    </div>
  </section>

  <section v-else class="rw-card schemes">
    <div class="rw-card__head">
      <div class="rw-card__title">④ 路线方案（多路线对比）</div>
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
          :class="{ 'is-current': s.schemeId === store.currentSchemeId }"
        >
          <div class="schemes__main">
            <div class="schemes__line">
              <span class="schemes__name">{{ s.name }}</span>
              <el-tag v-if="s.schemeId === store.currentSchemeId" size="small" effect="dark">当前</el-tag>
              <el-tag v-if="s.complete" size="small" type="success" effect="light">完整</el-tag>
              <el-tag v-else size="small" type="info" effect="plain">未拆完</el-tag>
            </div>
            <div class="schemes__meta">
              <span>{{ s.steps }} 步</span>
              <span class="schemes__sep">·</span>
              <span>总概率 {{ pct(s.probability) }}</span>
              <span class="schemes__sep">·</span>
              <span>起始物料 {{ s.terminals }}/{{ s.leaves }}</span>
              <span class="schemes__sep">·</span>
              <span>最深第 {{ s.depth }} 层</span>
            </div>
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
            <el-button size="small" text @click="onRename(s.schemeId, s.name)">改名</el-button>
            <el-button size="small" text type="danger" @click="onRemove(s.schemeId, s.name)">删除</el-button>
          </div>
        </li>
      </ul>

      <table v-if="stats.length > 1" class="schemes__table">
        <thead>
          <tr>
            <th>路线</th>
            <th>步数</th>
            <th>总概率</th>
            <th>起始物料</th>
            <th>完整</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in stats"
            :key="s.schemeId"
            :class="{ 'is-current': s.schemeId === store.currentSchemeId }"
            @click="onApply(s.schemeId)"
          >
            <td class="schemes__td-name">{{ s.name }}</td>
            <td>{{ s.steps }}</td>
            <td>{{ pct(s.probability) }}</td>
            <td>{{ s.terminals }}/{{ s.leaves }}</td>
            <td>{{ s.complete ? '✔' : '—' }}</td>
          </tr>
        </tbody>
      </table>
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
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text-2);
  white-space: nowrap;
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
  justify-content: space-between;
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

.schemes__main {
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

.schemes__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.schemes__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.schemes__table th,
.schemes__table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--rw-border);
  text-align: left;
}

.schemes__table th {
  color: var(--rw-text-3);
  font-weight: 500;
}

.schemes__table tbody tr {
  cursor: pointer;
}

.schemes__table tbody tr.is-current {
  background: var(--rw-brand-l);
  font-weight: 600;
}

.schemes__td-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
