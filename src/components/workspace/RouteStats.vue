<script setup lang="ts">
/**
 * 状态条 —— 一行任务实况。
 *
 * 定位参照：WorkBuddy 主区底部那条「生成回应中 · 已消耗 1.25 · 1 个后台任务运行中」。
 * 它在解决一个具体问题：**当前任务的整体状态不该需要滚回去看**。
 *
 * 本工作台对应的是四件事：
 *   ① 正在进行什么（有几个节点在跑 / 自动拆分到第几层）
 *   ② 已累计多少（节点数 · 已采纳步骤 · 最深第几层）
 *   ③ 总进度（自动拆分 done/budget）
 *   ④ 出错时的出口（有全局错误就跳过去看）
 *
 * 🔴 位置：**右侧辅助面板的底部**（`embedded`，由 AppShell 挂进 AsidePanel 的 footer 插槽）。
 *    它和「运行参数」是同一类东西 —— 随时瞄一眼的参考信息；放右栏比钉在内容区末尾
 *    少占一屏高度（内容长的时候要滚到底才看得到）。
 *    早先挂在内容区末尾的版本已退役，`embedded=false` 只是保留给别的宿主用。
 */
import { computed } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';

/** true = 由外层容器（辅助面板 footer）接管边框与定位，本组件只出内容 */
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const store = useWorkspaceStore();

const running = computed(() => store.nodeList.filter((n) => n.status === 'loading').length);

const pct = computed(() => {
  const { done, budget } = store.autoProgress;
  if (!budget) return 0;
  return Math.min(100, Math.round((done / budget) * 100));
});

/** 整体状态文案：优先报"正在跑"，其次报"有没有做错事" */
const stateText = computed(() => {
  // 🔴 自动拆分已改成「一次 Retro* 搜到底」：进度文案由 store.autoProgress.label 给出
  //    （「正在创建搜索任务…」/「搜索中…」/「完成 · N 条路线」），不再是旧的
  //    「自动拆分层 x/y」单步口径（那条口径已被 autoRun 重写取代）。
  if (store.autoRunning) return store.autoProgress.label || `搜索中 ${store.autoProgress.done}/${store.autoProgress.budget}`;
  if (running.value > 0) return `${running.value} 个节点分析中`;
  if (store.globalError) return '有错误待处理';
  if (store.stats.total === 0) return '还没有展开任何一步';
  return '空闲';
});

const stateClass = computed(() => {
  if (store.globalError) return 'is-bad';
  if (store.autoRunning || running.value > 0) return 'is-active';
  return '';
});
</script>

<template>
  <footer class="rstat" :class="[stateClass, { 'rstat--embedded': embedded }]">
    <span class="rstat__dot" />
    <span class="rstat__state">{{ stateText }}</span>

    <span class="rstat__sep" />
    <span class="rstat__item">节点 <b>{{ store.stats.total }}</b></span>
    <span class="rstat__item">已采纳 <b>{{ store.stats.reactions }}</b></span>
    <span class="rstat__item">最深 <b>第 {{ store.stats.maxDepth }} 层</b></span>
    <span class="rstat__item">总概率 <b>{{ (store.routeProbability * 100).toFixed(2) }}%</b></span>

    <!-- 自动拆分进行中：右侧补一条细进度，不抢视觉 -->
    <span v-if="store.autoRunning" class="rstat__bar">
      <i :style="{ width: `${pct}%` }" />
    </span>

    <!-- 自动拆分是长任务（一次 Retro* 搜索可达几分钟）⇒ 必须留一个停止出口。
         它原来在右栏「运行参数」里，随「自动往下拆」按钮一起搬到了新建分析界面；
         而运行中界面已经在路线态，所以停在状态条上最顺手。 -->
    <button v-if="store.autoRunning" type="button" class="rstat__stop" @click="store.stopAuto()">
      停止
    </button>
  </footer>
</template>

<style scoped>
.rstat {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding: 9px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface);
  font-size: 12px;
  color: var(--rw-text-3);
  /* 不吸底：内容很长时它是"读到底才看到"，而不是盖在内容上。
     需要钉住时改成 position:sticky + bottom:0，但目前内容区本身就是滚动容器，
     sticky 会跟 .rw-scroll 打架，先用常规流。 */
  flex-wrap: wrap;
}

.rstat__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 7px;
  border-radius: 50%;
  background: var(--rw-text-3);
}

.rstat.is-active .rstat__dot {
  background: var(--el-color-primary);
  box-shadow: 0 0 0 3px rgb(64 158 255 / 18%);
}

.rstat.is-bad .rstat__dot {
  background: var(--rw-bad);
}

.rstat.is-bad {
  color: var(--rw-bad);
  border-color: var(--rw-bad);
}

.rstat__state {
  font-weight: 600;
  color: var(--rw-text-2);
}

.rstat.is-active .rstat__state {
  color: var(--el-color-primary);
}

.rstat.is-bad .rstat__state {
  color: var(--rw-bad);
}

.rstat__sep {
  width: 1px;
  height: 12px;
  background: var(--rw-border);
}

.rstat__item b {
  margin-left: 2px;
  color: var(--rw-text-2);
  font-variant-numeric: tabular-nums;
}

.rstat__bar {
  position: relative;
  flex: 1;
  min-width: 60px;
  max-width: 180px;
  height: 4px;
  border-radius: 999px;
  background: var(--rw-surface-3);
  overflow: hidden;
}

.rstat__bar > i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: var(--el-color-primary);
  transition: width 0.3s ease;
}

/* ---------- 嵌在辅助面板底部（AsidePanel 的 footer 插槽） ----------
   面板只有 320px，所以：去掉外边距与四边框（分隔线由面板自己的 footer 提供）、
   字号再降一档、允许换行（一行放不下「节点 / 已采纳 / 最深 / 总概率」）。 */
.rstat--embedded {
  margin: 0;
  padding: 8px 14px 10px;
  border: 0;
  border-radius: 0;
  background: var(--rw-surface-2);
  gap: 4px 10px;
  font-size: 11.5px;
}

.rstat--embedded .rstat__bar {
  max-width: none;
}

/* 「停止自动拆分」：语义色描边小按钮，只在跑的时候出现 */
.rstat__stop {
  flex: 0 0 auto;
  padding: 1px 9px;
  border: 1px solid color-mix(in srgb, var(--rw-bad) 42%, transparent);
  border-radius: 5px;
  background: var(--rw-surface);
  color: var(--rw-bad);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  transition: background 0.15s;
}

.rstat__stop:hover {
  background: var(--rw-bad-l);
}
</style>
