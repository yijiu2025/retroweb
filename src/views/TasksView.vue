<script setup lang="ts">
/**
 * 任务列表页（/tasks）—— 与「工作台」并列的一级入口。
 *
 * 为什么还要一整页：侧栏「最近的任务」只有 240px 宽、**且只列前 6 条**
 * （其余塞进折叠的「更早的任务」）。它是"顺手切回上一个活"的快捷通道，
 * 不是"管理我所有任务"的地方 —— 任务一多，或者要按状态 / 关键词翻一条旧的，
 * 就必须有整页视图：全量列出 + 关键词搜（名称 / SMILES / 模型）+ 按状态筛 +
 * 每条给出「做到哪了」的几个数字。
 *
 * 🔴 与「历史记录」是**两份不同的数据**，别混：
 *    · 任务（`store.sessions`）= 还在手上的活，带着整棵路线树和没跑完的 job，
 *      点开是**接着做**；
 *    · 历史（`store.history`）= 手动「保存」沉淀下来的快照，点开是**回看 / 载入**。
 *    本页只列前者，需要历史快照的去「历史记录」。
 *
 * 🔴 打开任务走 `store.loadSession(id)`，**不能**自己去改 store 里的字段：
 *    它除了恢复节点树，还会接上未完成的后端 job 轮询、复位页签、登记当前会话；
 *    少一步就会变成「看得到树但结果永远不回来」。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, Right } from '@element-plus/icons-vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { Session, SessionStatus } from '@/types/retro';
import MolView from '@/components/mol/MolView.vue';
import { absoluteTime, relativeTime } from '@/utils/time';

const store = useWorkspaceStore();
const router = useRouter();

/** 关键词：名称 / SMILES / 模型，任一命中即可 */
const keyword = ref('');
const status = ref<'all' | SessionStatus>('all');
const sortBy = ref<'updated' | 'name'>('updated');

/** 状态 → 标签文案与配色。与侧栏 SessionPanel 的圆点配色同源（同一套语义）。 */
const STATUS_META: Record<SessionStatus, { label: string; type: 'primary' | 'warning' | 'success' }> =
  {
    running: { label: '进行中', type: 'primary' },
    incomplete: { label: '未完成', type: 'warning' },
    done: { label: '已完成', type: 'success' }
  };

const STATUS_OPTIONS: { value: 'all' | SessionStatus; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '进行中' },
  { value: 'incomplete', label: '未完成' },
  { value: 'done', label: '已完成' }
];

/** 各状态的条数（筛选项上直接显示，省得用户点了才发现是空的） */
const counts = computed<Record<'all' | SessionStatus, number>>(() => {
  const c = { all: store.sessions.length, running: 0, incomplete: 0, done: 0 };
  for (const s of store.sessions) c[s.status] += 1;
  return c;
});

const filtered = computed<Session[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const list = store.sessions.filter((s) => {
    if (status.value !== 'all' && s.status !== status.value) return false;
    if (!kw) return true;
    return (
      s.name.toLowerCase().includes(kw) ||
      s.target.toLowerCase().includes(kw) ||
      s.model.toLowerCase().includes(kw)
    );
  });
  return list.sort((a, b) =>
    sortBy.value === 'name'
      ? a.name.localeCompare(b.name, 'zh-CN') || b.updatedAt - a.updatedAt
      : b.updatedAt - a.updatedAt
  );
});

/** 是否在筛选（决定空态文案是"还没有任务"还是"没有匹配的"） */
const filtering = computed(() => !!keyword.value.trim() || status.value !== 'all');

// —— 每条任务的几个"做到哪了"的数字（都从快照算，不额外存字段） ——
function nodeCount(s: Session): number {
  return Object.keys(s.snapshot?.nodes ?? {}).length;
}

/** 已定下反应的步数（`chosenReactionId` 有值 = 这一步已经选定怎么拆） */
function stepCount(s: Session): number {
  return Object.values(s.snapshot?.nodes ?? {}).filter((n) => !!n.chosenReactionId).length;
}

/** 树的层数（根是 0 层） */
function depthOf(s: Session): number {
  const nodes = Object.values(s.snapshot?.nodes ?? {});
  return nodes.length ? nodes.reduce((m, n) => Math.max(m, n.depth), 0) : 0;
}

function schemeCount(s: Session): number {
  return s.snapshot?.schemes?.length ?? 0;
}

function open(id: string): void {
  void store.loadSession(id);
  void router.push('/');
}

function newTask(): void {
  // 只把工作台切回标定态，已有任务原样留在列表里
  store.openTargetSetup();
  void router.push('/');
}

async function remove(s: Session): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除任务「${s.name}」？这条路线树会一并移除，无法恢复。`, '删除任务', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  store.removeSession(s.id);
  ElMessage.success('已删除');
}

function clearFilters(): void {
  keyword.value = '';
  status.value = 'all';
}
</script>

<template>
  <section class="rw-card tasks">
    <div class="rw-card__head">
      <div class="rw-card__title">任务列表</div>
      <span class="tasks__count">
        共 {{ counts.all }} 个任务<template v-if="filtered.length !== counts.all">
          · 当前筛出 {{ filtered.length }} 个
        </template>
      </span>
    </div>

    <div class="rw-card__body">
      <!-- 工具栏：搜 / 筛 / 排 / 新建。
           新建放最右（视觉终点），与侧栏「＋ 新任务」是同一个动作的两个入口。 -->
      <div class="tasks__bar">
        <el-input
          v-model="keyword"
          class="tasks__search"
          size="small"
          clearable
          placeholder="搜索名称 / SMILES / 模型"
        />
        <el-select v-model="status" size="small" class="tasks__select">
          <el-option
            v-for="opt in STATUS_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="`${opt.label}（${counts[opt.value]}）`"
          />
        </el-select>
        <el-select v-model="sortBy" size="small" class="tasks__select">
          <el-option value="updated" label="按最近更新" />
          <el-option value="name" label="按名称" />
        </el-select>
        <el-button size="small" type="primary" class="tasks__new" @click="newTask">
          ＋ 新任务
        </el-button>
      </div>

      <el-empty v-if="!filtered.length" :description="filtering ? '没有匹配的任务' : '还没有任务'">
        <template v-if="filtering">
          <el-button size="small" @click="clearFilters">清除筛选</el-button>
        </template>
        <template v-else>
          <el-button size="small" type="primary" @click="newTask">＋ 新建第一个任务</el-button>
        </template>
      </el-empty>

      <div v-else class="tasks__grid">
        <article
          v-for="s in filtered"
          :key="s.id"
          class="task"
          :class="{ 'is-current': s.id === store.currentSessionId }"
        >
          <div class="task__mol">
            <MolView :smiles="s.target" fit />
          </div>

          <div class="task__body">
            <div class="task__line">
              <span class="task__name">{{ s.name }}</span>
              <el-tag :type="STATUS_META[s.status].type" size="small" disable-transitions>
                {{ STATUS_META[s.status].label }}
              </el-tag>
              <span v-if="s.id === store.currentSessionId" class="task__badge">当前</span>
            </div>

            <code class="rw-mono task__smiles" :title="s.target">{{ s.target }}</code>

            <div class="task__meta">
              <span>{{ nodeCount(s) }} 节点</span>
              <span>{{ stepCount(s) }} 步已定</span>
              <span>{{ depthOf(s) + 1 }} 层</span>
              <template v-if="schemeCount(s)">
                <span>{{ schemeCount(s) }} 方案</span>
              </template>
              <span>模型 {{ s.model }}</span>
              <span :title="absoluteTime(s.updatedAt)">更新于 {{ relativeTime(s.updatedAt) }}</span>
            </div>
          </div>

          <div class="task__ops">
            <el-button size="small" type="primary" :icon="Right" @click="open(s.id)">打开</el-button>
            <el-button size="small" :icon="Delete" title="删除任务" @click="remove(s)" />
          </div>
        </article>
      </div>

      <!-- 数据分工说明：任务 vs 历史，两处都能进，别让用户猜 -->
      <p class="tasks__hint">
        这里列的是<b>还在手上的活</b>（可点开接着做）。手动「保存」沉淀下来的快照在
        <router-link to="/history">历史记录</router-link>。
      </p>
    </div>
  </section>
</template>

<style scoped>
.tasks__count {
  font-size: 12px;
  color: var(--rw-text-3);
}

/* 工具栏：一行摆开，窄屏让搜索框吃掉剩余宽度（其余保持原宽） */
.tasks__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.tasks__search {
  flex: 1 1 220px;
  min-width: 160px;
  max-width: 320px;
}

.tasks__select {
  width: 128px;
  flex: 0 0 auto;
}

.tasks__new {
  margin-left: auto;
}

.tasks__grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.task {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  transition: border-color 0.15s, background 0.15s;
}

.task:hover {
  border-color: var(--rw-brand);
}

.task.is-current {
  background: var(--rw-brand-l);
  border-color: var(--rw-brand);
}

/* 🔴 结构图容器必须有确定尺寸 —— MolView 的 fit 是按父容器算的，
   父容器高度不定的话大分子会被裁掉（见 MolView 头部注释）。 */
.task__mol {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 88px;
  flex: 0 0 120px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface-2);
  overflow: hidden;
}

.task__body {
  flex: 1;
  min-width: 0;
}

.task__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.task__name {
  font-size: 14px;
  font-weight: 600;
  color: var(--rw-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task__badge {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--rw-brand);
  color: #fff;
  font-size: 11px;
  flex: 0 0 auto;
}

.task__smiles {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--rw-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.task__ops {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}

.tasks__hint {
  margin: 14px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--rw-text-3);
}

.tasks__hint b {
  color: var(--rw-text-2);
  font-weight: 600;
}

.tasks__hint a {
  color: var(--rw-brand-d);
  text-decoration: none;
}

.tasks__hint a:hover {
  text-decoration: underline;
}

/* 窄屏：结构图缩到 96×72、操作区换行到卡片右下，避免横向挤压 */
@media (max-width: 900px) {
  .task {
    flex-wrap: wrap;
  }

  .task__mol {
    width: 96px;
    height: 72px;
    flex-basis: 96px;
  }

  .task__ops {
    margin-left: auto;
  }
}
</style>
