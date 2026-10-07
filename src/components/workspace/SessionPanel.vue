<script setup lang="ts">
/**
 * 侧栏「最近的任务」列表 —— 常驻在导航栏下方。
 *
 * 一个目标分析 = 一个任务。这个列表就是任务的入口：
 * 点一条即把该任务的路线树恢复回来（还在跑的节点会自动接上后端 job 轮询）；
 * 点右上角「＋ 新任务」则开一个空白标定面板（旧任务**留在列表里**，不会被顶掉或删掉）。
 *
 * 版式取舍：这是**侧栏里的紧凑列表**（宽度约 240px，收起时 64px），
 * 所以不展示大标签，改用「状态圆点 + 名称 + 时间」三行内搞定；
 * 删除按钮只在 hover 时出现，避免一堆红色按钮糊满侧栏。
 *
 * 🔴 分两组的判据是 `updatedAt` 的新旧，与状态**无关**：
 *    第一组「最近」= 前 6 条（还在手上的活），第二组「更早」= 其余（归档区）。
 *    之所以不按状态分组（进行中 / 已完成）：同一个任务的状态会来回变，
 *    按状态分组会让一条任务在两个组之间跳来跳去，用户反而找不着了。
 *    按时间分组是稳定的 —— 位置只随"你多久没碰它"单调变化。
 *
 * 🔴 而 `updatedAt` 的语义被 store 收紧了：**打开一个任务不会刷新它**
 *    （只有真的动了内容才会，见 stores/workspace.ts 的 sessionSignature）。
 *    否则「点一条旧任务看一眼」就会把它顶到第一位 —— 这正是之前的问题。
 */
import { computed, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import type { Session, SessionStatus } from '@/types/retro';

const store = useWorkspaceStore();

const emit = defineEmits<{
  (e: 'open', id: string): void;
  (e: 'new'): void;
}>();

/** 第一组最多显示几条，其余进「更早的任务」 */
const RECENT_SIZE = 6;

/** 全量按最近使用排序 */
const all = computed(() => [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt));

const recent = computed(() => all.value.slice(0, RECENT_SIZE));
const earlier = computed(() => all.value.slice(RECENT_SIZE));

const STATUS_META: Record<SessionStatus, { label: string; cls: string }> = {
  running: { label: '进行中', cls: 'is-running' },
  incomplete: { label: '未完成', cls: 'is-incomplete' },
  done: { label: '已完成', cls: 'is-done' }
};

function shortTarget(s: Session): string {
  return s.target.length > 22 ? s.target.slice(0, 22) + '…' : s.target;
}

function timeText(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const confirming = ref<string | null>(null);

async function onRemove(id: string, name: string): Promise<void> {
  confirming.value = id;
  try {
    await ElMessageBox.confirm(`删除任务「${name}」？这条路线树会一并移除，无法恢复。`, '删除任务', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    });
    store.removeSession(id);
  } catch {
    /* 用户取消 */
  } finally {
    confirming.value = null;
  }
}
</script>

<template>
  <div class="recent">
    <!-- 顶部常驻：标题 + 总数 + 新建入口。
         「新任务」放在这里（而不是只有工作台里能建）—— 左侧这一列才是任务的总入口。 -->
    <div class="recent__head">
      <span class="recent__title">最近的任务</span>
      <span class="recent__count">{{ all.length }}</span>
      <button type="button" class="recent__new" title="新建任务（当前任务会保留在列表里）" @click="emit('new')">
        <span aria-hidden="true">＋</span>新任务
      </button>
    </div>

    <p v-if="!all.length" class="recent__empty">
      还没有任务。点上方「＋ 新任务」设定目标分子即可开始。
    </p>

    <template v-else>
      <!-- 分组一：最近碰过的（还在手上的活） -->
      <section class="recent__group">
        <ul class="recent__list">
          <li v-for="s in recent" :key="s.id">
            <div
              class="recent__item"
              :class="{ 'is-current': s.id === store.currentSessionId }"
              role="button"
              tabindex="0"
              :title="s.target"
              @click="emit('open', s.id)"
              @keyup.enter="emit('open', s.id)"
            >
              <span class="recent__dot" :class="STATUS_META[s.status].cls" />
              <div class="recent__body">
                <span class="recent__name">{{ s.name }}</span>
                <span class="recent__sub">
                  <code class="rw-mono">{{ shortTarget(s) }}</code>
                  <i>·</i>
                  <span>{{ timeText(s.updatedAt) }}</span>
                </span>
              </div>
              <button
                type="button"
                class="recent__del"
                title="删除任务"
                :disabled="confirming === s.id"
                @click.stop="onRemove(s.id, s.name)"
              >
                ×
              </button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 分组二：更早的（归档区，默认折叠，别把侧栏撑爆） -->
      <details v-if="earlier.length" class="recent__group recent__group--arch">
        <summary class="recent__head recent__head--btn">
          <span class="recent__title">更早的任务</span>
          <span class="recent__count">{{ earlier.length }}</span>
        </summary>
        <ul class="recent__list">
          <li v-for="s in earlier" :key="s.id">
            <div
              class="recent__item"
              :class="{ 'is-current': s.id === store.currentSessionId }"
              role="button"
              tabindex="0"
              :title="s.target"
              @click="emit('open', s.id)"
              @keyup.enter="emit('open', s.id)"
            >
              <span class="recent__dot" :class="STATUS_META[s.status].cls" />
              <div class="recent__body">
                <span class="recent__name">{{ s.name }}</span>
                <span class="recent__sub">
                  <code class="rw-mono">{{ shortTarget(s) }}</code>
                  <i>·</i>
                  <span>{{ timeText(s.updatedAt) }}</span>
                </span>
              </div>
              <button
                type="button"
                class="recent__del"
                title="删除任务"
                :disabled="confirming === s.id"
                @click.stop="onRemove(s.id, s.name)"
              >
                ×
              </button>
            </div>
          </li>
        </ul>
      </details>
    </template>
  </div>
</template>

<style scoped>
.recent {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.recent__group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.recent__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--rw-text-3);
  letter-spacing: 0.03em;
}

/* 「＋ 新任务」：常驻在标题右侧 —— 左侧这一列是任务的总入口，
   新建不该只有工作台里那一条路。做成低调的文字按钮，别跟导航抢视觉。 */
.recent__new {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  background: var(--rw-surface);
  color: var(--rw-text-2);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
  white-space: nowrap;
}

.recent__new:hover {
  color: var(--rw-brand-d);
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
}

/* 「更早的任务」是可折叠分组：summary 复用 head 的排版，去掉默认三角 */
.recent__head--btn {
  cursor: pointer;
  list-style: none;
  user-select: none;
  padding: 4px 12px;
  border-radius: var(--rw-radius-sm);
}

.recent__head--btn::-webkit-details-marker {
  display: none;
}

.recent__head--btn:hover {
  background: var(--rw-surface-2);
  color: var(--rw-text-2);
}

/* 自带 chevron：展开时旋转 90° */
.recent__head--btn .recent__title::before {
  content: '›';
  display: inline-block;
  margin-right: 5px;
  font-size: 13px;
  line-height: 1;
  transition: transform 0.16s ease;
}

.recent__group--arch[open] > .recent__head--btn .recent__title::before {
  transform: rotate(90deg);
}

.recent__count {
  font-variant-numeric: tabular-nums;
}

/* 折叠分组的 head 只是 summary（没有「＋新任务」），计数靠右对齐 */
.recent__head--btn .recent__count {
  margin-left: auto;
}

/* 列表本身不滚动 —— 侧栏整体只有一个滚动容器（AppShell 的 `.app__side-scroll`）。
   原来这里带 `overflow-y: auto; min-height: 0`，是"本段自己滚"时代的残留：
   没有高度约束时它根本不生效，留着只会让人以为这里还有第二根滚动条。 */
.recent__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 6px 12px;
  border-radius: var(--rw-radius-sm);
  cursor: pointer;
  transition: background 0.15s;
}

.recent__item:hover {
  background: var(--rw-surface-2);
}

.recent__item.is-current {
  background: var(--rw-brand-l);
}

.recent__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--rw-text-3);
}

.recent__dot.is-running {
  background: var(--el-color-primary);
  box-shadow: 0 0 0 3px rgb(64 158 255 / 18%);
}

.recent__dot.is-incomplete {
  background: var(--el-color-warning);
}

.recent__dot.is-done {
  background: var(--el-color-success);
}

.recent__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.recent__name {
  font-size: 13px;
  color: var(--rw-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent__item.is-current .recent__name {
  font-weight: 600;
  color: var(--rw-brand-d);
}

.recent__sub {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--rw-text-3);
  white-space: nowrap;
  overflow: hidden;
}

.recent__sub code {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent__sub i {
  font-style: normal;
  opacity: 0.5;
}

.recent__del {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

/* 删除按钮只在 hover / 聚焦时露出，避免侧栏被红叉糊满 */
.recent__item:hover .recent__del,
.recent__del:focus-visible {
  opacity: 1;
}

.recent__del:hover {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.recent__empty {
  margin: 0;
  padding: 0 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--rw-text-3);
}

/* 侧栏收起（64px）时整块隐藏 —— 挤不下，显示也没意义 */
:global(.app.is-collapsed) .recent {
  display: none;
}
</style>
