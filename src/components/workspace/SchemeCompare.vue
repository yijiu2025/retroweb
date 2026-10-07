<script setup lang="ts">
/**
 * 路线方案对比 —— 右辅助面板在「合成路线」页签下的内容。
 *
 * 为什么单独抽出来放右面板：
 *   方案对比是**横向选优**用的 —— 你要一边看左边那条路线的步骤明细，
 *   一边和右边表格里别的方案比步数 / 总概率。塞在 SchemeBar 里就变成了
 *   "看完主区滚下去看表、再滚上来"，对比的参照物看不见了。
 *
 * 数据与动作全部复用 store 里已有的那套（schemeStats / applyScheme / renameScheme /
 * removeScheme / saveScheme），本组件**不含任何新逻辑**，只是换了个位置呈现 ——
 * 这也是为什么它能安全地做成一个纯展示组件。
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

function onApply(id: string): void {
  if (id === store.currentSchemeId) return;
  store.applyScheme(id);
  ElMessage.success('已切到这条路线（原有工作保留，可随时切回）');
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

async function onRemove(id: string, name: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除路线方案「${name}」？只删方案本身，路线树不受影响。`, '删除方案', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
    store.removeScheme(id);
  } catch {
    /* 用户取消 */
  }
}

/** 确认为采用中的路线网络（用户点的是这一条 ⇒ 用按 id 的接口，不动当前树） */
function onConfirm(id: string): void {
  store.confirmScheme(id);
  ElMessage.success('已确认这条路线网络（可继续确认别的，多条并存）');
}

function onUnconfirm(id: string): void {
  store.unconfirmRouteNetwork(id);
  ElMessage.success('已取消确认：记录保留，退回备选');
}
</script>

<template>
  <div class="schemes">
    <div class="schemes__save">
      <el-button type="primary" plain size="small" class="schemes__save-btn" @click="onSave">
        存为新方案
      </el-button>
    </div>

    <p v-if="!stats.length" class="schemes__empty">
      还没有路线网络。在「逆合成树」里拆出一条满意的多步路线后点「确认路线网络」，
      换掉某一步再确认一条，就能在这里横向比步数、分支与总概率。
    </p>

    <ul v-else class="schemes__list">
      <li v-for="s in stats" :key="s.schemeId" class="sch" :class="{ 'is-confirmed': s.confirmed }">
        <div class="sch__head">
          <button
            type="button"
            class="sch__name"
            :class="{ 'is-current': s.schemeId === store.currentSchemeId }"
            :title="`切到「${s.name}」`"
            @click="onApply(s.schemeId)"
          >
            {{ s.name }}
          </button>
          <el-tag v-if="s.confirmed" size="small" type="success" effect="dark">已确认</el-tag>
          <el-tag v-if="s.complete" size="small" type="success" effect="light">完整</el-tag>
          <el-tag v-else size="small" type="info" effect="light">未完成</el-tag>
        </div>

        <dl class="sch__metrics">
          <div><dt>步数</dt><dd>{{ s.steps }}</dd></div>
          <div><dt>分支</dt><dd>{{ s.branches }}</dd></div>
          <div><dt>总概率</dt><dd>{{ pct(s.probability) }}</dd></div>
          <div><dt>起始物料</dt><dd>{{ s.terminals }}/{{ s.leaves }}</dd></div>
          <div><dt>最深</dt><dd>第 {{ s.depth }} 层</dd></div>
        </dl>

        <div class="sch__ops">
          <button v-if="!s.confirmed" type="button" class="sch__op sch__op--ok" @click="onConfirm(s.schemeId)">
            确认为路线网络
          </button>
          <button v-else type="button" class="sch__op" @click="onUnconfirm(s.schemeId)">取消确认</button>
          <button type="button" class="sch__op" @click="onRename(s.schemeId, s.name)">改名</button>
          <button
            type="button"
            class="sch__op sch__op--danger"
            @click="onRemove(s.schemeId, s.name)"
          >
            删除
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.schemes {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.schemes__save-btn {
  width: 100%;
}

.schemes__empty {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.schemes__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sch {
  padding: 11px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.sch__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.sch__name {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--rw-text);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sch__name:hover {
  color: var(--rw-brand);
}

.sch__name.is-current {
  color: var(--rw-brand-d);
}

/* 指标用 2×2 网格：320px 宽的面板里，四列会挤成一行小字 */
.sch__metrics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 10px;
  margin: 0 0 8px;
}

.sch__metrics > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}

.sch__metrics dt {
  font-size: 11.5px;
  color: var(--rw-text-3);
}

.sch__metrics dd {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--rw-text-2);
  font-variant-numeric: tabular-nums;
}

.sch__ops {
  display: flex;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--rw-border);
}

.sch__op {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 12px;
  cursor: pointer;
}

.sch__op:hover {
  color: var(--rw-brand);
}

.sch__op--danger:hover {
  color: var(--rw-bad);
}

/* 「确认为路线网络」是本面板的主推操作，用语义色而非默认灰 */
.sch__op--ok {
  color: var(--rw-ok);
}

.sch__op--ok:hover {
  color: var(--rw-ok);
  text-decoration: underline;
}

/* 已确认 = 采用中的路线网络：左侧一条绿色实线（与侧栏 / 方案栏同一套语言） */
.sch.is-confirmed {
  border-left: 2px solid var(--rw-ok);
}
</style>
