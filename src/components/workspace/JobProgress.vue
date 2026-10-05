<script setup lang="ts">
/**
 * 分析进度面板：把一个正在跑的后台 job 的「当前到哪一步了」实时画出来。
 *
 * 数据来源：store.jobProgress[nodeId] —— 由 workspace.predictNode 每 ~0.8s 拉一次快照写入。
 * 展示：① 总进度条 ② 阶段时间线（校验/加载模型/推理/后处理）③ 滚动日志 ④ 取消按钮。
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { JobStage } from '@/types/retro';

const props = defineProps<{ nodeId: string }>();
const store = useWorkspaceStore();
const jp = computed(() => store.jobProgress[props.nodeId]);

const pct = computed(() => Math.round((jp.value?.progress ?? 0) * 100));

const stageIcon: Record<string, string> = {
  running: '◐',
  done: '✓',
  skipped: '·',
  failed: '✕'
};
const stageClass: Record<string, string> = {
  running: 'is-run',
  done: 'is-done',
  skipped: 'is-skip',
  failed: 'is-fail'
};

function stageSeconds(s: JobStage): string {
  if (!s.seconds) return '';
  return s.seconds >= 1 ? `${s.seconds.toFixed(1)}s` : `${Math.round(s.seconds * 1000)}ms`;
}

const logClass: Record<string, string> = {
  stage: 'is-stage',
  warn: 'is-warn',
  error: 'is-err',
  info: 'is-info'
};

function onCancel(): void {
  store.cancelNode(props.nodeId);
}
</script>

<template>
  <div v-if="jp" class="job-progress">
    <div class="jp-head">
      <el-progress
        :percentage="pct"
        :status="jp.state === 'failed' || jp.state === 'cancelled' ? 'exception' : undefined"
        :stroke-width="10"
        :text-inside="true"
        class="jp-bar"
      />
      <el-button
        v-if="jp.cancelable"
        size="small"
        type="danger"
        plain
        class="jp-cancel"
        @click="onCancel"
      >
        取消
      </el-button>
    </div>

    <div class="jp-current">
      <span class="jp-current__label">{{ jp.current || '准备中…' }}</span>
      <span v-if="jp.currentDetail" class="jp-current__detail">{{ jp.currentDetail }}</span>
    </div>

    <!-- 阶段时间线 -->
    <ul class="jp-stages">
      <li
        v-for="s in jp.stages"
        :key="s.key"
        class="jp-stage"
        :class="stageClass[s.state]"
      >
        <span class="jp-stage__icon">{{ stageIcon[s.state] }}</span>
        <span class="jp-stage__body">
          <span class="jp-stage__label">{{ s.label }}</span>
          <span v-if="s.detail" class="jp-stage__detail">{{ s.detail }}</span>
        </span>
        <span class="jp-stage__time">{{ stageSeconds(s) }}</span>
      </li>
    </ul>

    <!-- 实时日志 -->
    <div class="jp-logs">
      <div
        v-for="lg in jp.logs"
        :key="lg.seq"
        class="jp-log"
        :class="logClass[lg.level] || 'is-info'"
      >
        <span class="jp-log__t">+{{ lg.t.toFixed(1) }}s</span>
        <span class="jp-log__text">{{ lg.text }}</span>
      </div>
      <div v-if="!jp.logs.length" class="jp-log jp-log--empty">等待日志输出…</div>
    </div>
    <p v-if="jp.state === 'failed'" class="jp-note jp-note--bad">
      分析失败。下方会列出具体原因。
    </p>
    <p v-else-if="jp.state === 'cancelled'" class="jp-note jp-note--warn">
      已取消（取消在阶段边界生效；模型加载/推理本身不可中断）。
    </p>
    <p v-else-if="jp.state === 'queued'" class="jp-note">
      任务已排队，等待执行（模型首次加载会占用这一时段）。
    </p>
  </div>
</template>

<style scoped>
.job-progress {
  margin: 6px 0 10px;
  padding: 10px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.jp-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.jp-bar {
  flex: 1;
  min-width: 0;
}

.jp-cancel {
  flex: 0 0 auto;
}

.jp-current {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
  font-size: 12.5px;
  min-height: 18px;
}

.jp-current__label {
  font-weight: 600;
  color: var(--rw-text);
}

.jp-current__detail {
  color: var(--rw-text-3);
  font-size: 11.5px;
}

.jp-stages {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.jp-stage {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;
}

.jp-stage__icon {
  width: 16px;
  text-align: center;
  font-weight: 700;
  flex: 0 0 16px;
}

.jp-stage__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.jp-stage__label {
  color: var(--rw-text);
}

.jp-stage__detail {
  color: var(--rw-text-3);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jp-stage__time {
  color: var(--rw-text-3);
  font-size: 11px;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.jp-stage.is-run .jp-stage__icon {
  color: var(--rw-brand-d);
  animation: jp-spin 1.1s linear infinite;
}
.jp-stage.is-run .jp-stage__label {
  color: var(--rw-brand-d);
  font-weight: 600;
}
.jp-stage.is-done .jp-stage__icon {
  color: var(--rw-ok);
}
.jp-stage.is-skip .jp-stage__icon,
.jp-stage.is-skip .jp-stage__label {
  color: var(--rw-text-3);
}
.jp-stage.is-fail .jp-stage__icon {
  color: var(--rw-bad);
}

@keyframes jp-spin {
  to {
    transform: rotate(360deg);
  }
}

.jp-logs {
  margin-top: 8px;
  max-height: 140px;
  overflow-y: auto;
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  padding: 6px 8px;
  font-family: var(--rw-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.5;
}

.jp-log {
  display: flex;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.jp-log__t {
  color: var(--rw-text-3);
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

.jp-log.is-stage {
  color: var(--rw-brand-d);
  font-weight: 600;
}
.jp-log.is-warn {
  color: var(--rw-warn);
}
.jp-log.is-err {
  color: var(--rw-bad);
}
.jp-log.is-info {
  color: var(--rw-text-2);
}

.jp-log--empty {
  color: var(--rw-text-3);
}

.jp-note {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--rw-text-3);
}
.jp-note--bad {
  color: var(--rw-bad);
}
.jp-note--warn {
  color: var(--rw-warn);
}
</style>
