<script setup lang="ts">
/**
 * 任务会话面板：列出「未完成 / 进行中」的逆合成任务。
 *
 * 这些会话随工作台自动落盘到 localStorage（见 stores/workspace.persistSession），
 * 所以**刷新网页后这里仍然显示**，点「继续」即可把路线树恢复回来，
 * 还在跑的节点会自动接上后端的 job 轮询（见 resumeSessions / predictNode.resumeJobId）。
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { Session, SessionStatus } from '@/types/retro';

const store = useWorkspaceStore();

const emit = defineEmits<{
  (e: 'open', id: string): void;
  (e: 'remove', id: string): void;
}>();

/** 只展示未完成 / 进行中的会话（已完成的不占地方） */
const visible = computed(() =>
  store.sessions
    .filter((s) => s.status !== 'done' && s.snapshot.rootId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
);

const STATUS_META: Record<SessionStatus, { label: string; type: 'primary' | 'warning' | 'success' }> = {
  running: { label: '进行中', type: 'primary' },
  incomplete: { label: '未完成', type: 'warning' },
  done: { label: '已完成', type: 'success' }
};

function nodeCount(s: Session): number {
  return Object.keys(s.snapshot.nodes).length;
}

function updatedAtText(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function shortSmiles(s: string): string {
  return s.length > 30 ? s.slice(0, 30) + '…' : s;
}
</script>

<template>
  <section class="rw-card sessions">
    <div class="rw-card__head">
      <div class="rw-card__title">③ 任务会话（刷新后保留）</div>
      <el-tag size="small" effect="plain" type="info">{{ visible.length }}</el-tag>
    </div>

    <div class="rw-card__body sessions__body">
      <p class="sessions__hint">
        工作台会自动保存进度，刷新网页即可恢复「未完成 / 进行中」的任务。
      </p>

      <ul class="sessions__list">
        <li v-for="s in visible" :key="s.id" class="sessions__item">
          <div class="sessions__main">
            <div class="sessions__line">
              <el-tag :type="STATUS_META[s.status].type" size="small" effect="dark">
                {{ STATUS_META[s.status].label }}
              </el-tag>
              <span v-if="s.id === store.currentSessionId" class="sessions__current">当前</span>
              <span class="sessions__name">{{ s.name }}</span>
            </div>
            <div class="sessions__meta">
              <code class="rw-mono">{{ shortSmiles(s.target) }}</code>
              <span class="sessions__sep">·</span>
              <span>{{ nodeCount(s) }} 个分子</span>
              <span class="sessions__sep">·</span>
              <span>{{ updatedAtText(s.updatedAt) }}</span>
            </div>
          </div>
          <div class="sessions__actions">
            <el-button size="small" type="primary" plain @click="emit('open', s.id)">继续</el-button>
            <el-button size="small" type="danger" plain @click="emit('remove', s.id)">删除</el-button>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.sessions__body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sessions__hint {
  margin: 0;
  font-size: 12px;
  color: var(--rw-text-3);
  line-height: 1.5;
}

.sessions__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sessions__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--rw-border);
  border-radius: 8px;
  background: var(--rw-surface-2);
}

.sessions__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sessions__line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sessions__current {
  font-size: 11px;
  color: var(--el-color-primary);
  border: 1px solid var(--el-color-primary);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 16px;
}

.sessions__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sessions__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rw-text-3);
}

.sessions__meta .rw-mono {
  font-size: 11.5px;
}

.sessions__sep {
  opacity: 0.5;
}

.sessions__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
