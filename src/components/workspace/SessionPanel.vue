<script setup lang="ts">
/**
 * 侧栏「最近的任务」列表 —— 常驻在导航栏下方。
 *
 * 一个目标分析 = 一个任务。这个列表就是任务的入口：
 * 点一条即把该任务的路线树恢复回来（还在跑的节点会自动接上后端 job 轮询）。
 *
 * 版式取舍：这是**侧栏里的紧凑列表**（宽度约 236px，收起时 64px），
 * 所以不展示大标签，改用「状态圆点 + 名称 + 时间」三行内搞定；
 * 删除按钮只在 hover 时出现，避免一堆红色按钮糊满侧栏。
 */
import { computed, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import type { Session, SessionStatus } from '@/types/retro';

const store = useWorkspaceStore();

const emit = defineEmits<{
  (e: 'open', id: string): void;
}>();

/** 按最近使用排序；已完成的不算「最近的任务」的噪声，但保留（用户可能想回看） */
const items = computed(() =>
  [...store.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12)
);

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
    <div class="recent__head">
      <span class="recent__title">最近的任务</span>
      <span class="recent__count">{{ items.length }}</span>
    </div>

    <ul v-if="items.length" class="recent__list">
      <li v-for="s in items" :key="s.id">
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

    <p v-else class="recent__empty">还没有任务。在工作台设定目标分子即可开始。</p>
  </div>
</template>

<style scoped>
.recent {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.recent__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--rw-text-3);
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.recent__count {
  font-variant-numeric: tabular-nums;
}

.recent__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  min-height: 0;
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
