<script setup lang="ts">
/**
 * 「多步路线搜索进行中」的**动画面板**。
 *
 * 解决的问题（用户原话：「多步搜索的时候动画明显一点」）：
 *   「自动往下拆」是一次 Retro* **搜到底**的长任务（可达几分钟）。它跑的时候，
 *   主区其实是一片死寂 —— 树页签里只有孤零零的根节点卡片，其余全是留白；
 *   唯一的动静在**右栏底部**那条状态条上（一行小字 + 一条 4px 细进度）。
 *   用户点了按钮、盯着主区，看到的画面几秒钟内**完全没变化**，
 *   分不出「在跑」还是「点了没反应」。
 *
 * 所以这里在**主区的空白里**放一块看得见在动的面板：
 *   ① 一张会动的逆向合成立式示意图（虚线沿边流动 + 节点依次呼吸 + 一条扫光）；
 *   ② 文案当前阶段（复用 `store.autoProgress.label`，与状态条**同一份数据**）；
 *   ③ 进度条（预算已用 / 总数，跑马灯条纹 ⇒ 就算进度是 0 也看得出在动）；
 *   ④ 「已用 N 秒」—— 计时起点来自 `store.autoStartedAt`，不是组件自己记的
 *      （理由见 store 里该字段的注释：组件可能"挂载晚于开跑"）；
 *   ⑤ 停止出口 —— 与状态条上那颗是同一个 `store.stopAuto()`。
 *
 * 🔴 **什么时候显示只认 `store.autoRunning`**：内部自带 `v-if`，
 *    宿主只管把它摆进"搜索时是空的那块地方"即可，不需要自己判状态 ——
 *    这样两个宿主（逆合成树 / 路线网络）不可能各判一套、出现两处口径不一。
 *
 * 🔴 单步预测（`predictNode`）**不**走这里：那种等待是秒级、且面板里会自己长出
 *    JobProgress，再叠一层动画面板只会同时动两处。判据只看 `autoRunning`。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';

const store = useWorkspaceStore();

const pct = computed(() => {
  const { done, budget } = store.autoProgress;
  if (!budget) return 0;
  return Math.min(100, Math.max(0, Math.round((done / budget) * 100)));
});

/** 已用秒数 —— 由 store 落下的起点推算（见文件头注释） */
const elapsed = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  const t0 = store.autoStartedAt;
  elapsed.value = t0 ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : 0;
}

function stopTimer(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

/**
 * 只在**开跑的那一刻**起表、结束就停表。
 *
 * 🔴 不在 `onMounted` 里起表：本面板是挂在页签上的，用户完全可能在搜索
 *    进行到一半才切过来 —— 那时若从 0 开始计，显示的"已用"会比真实短一截。
 *    （所以起点取自 store，这里只负责每秒重算一次。）
 */
watch(
  () => store.autoRunning,
  (on) => {
    stopTimer();
    if (!on) return;
    tick();
    timer = setInterval(tick, 1000);
  },
  { immediate: true }
);

onBeforeUnmount(stopTimer);

const elapsedText = computed(() => {
  const s = elapsed.value;
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return mm ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss} 秒`;
});

/** 阶段文案：store 为空时兜一句，免得出现空行 */
const phaseText = computed(() => store.autoProgress.label || '搜索中…');
</script>

<template>
  <div v-if="store.autoRunning" class="sprog" role="status" aria-live="polite">
    <!-- 呼吸光晕：让"在跑"这件事从余光里就看得出来 -->
    <span class="sprog__glow" aria-hidden="true" />

    <!-- ① 会动的逆向合成示意图（目标在右、前体逐层向左长出来） -->
    <div class="sprog__art" aria-hidden="true">
      <svg viewBox="0 0 200 72" focusable="false">
        <!-- 边：虚线沿着路径流动（路径方向 = 从目标指向前体，虚点也随之向左） -->
        <g class="sprog__edges" fill="none" stroke="var(--rw-brand)" stroke-width="1.6">
          <path d="M169 36 H138" />
          <path d="M138 36 V12 H103" />
          <path d="M138 36 H103" />
          <path d="M138 36 V60 H103" />
          <path d="M89 12 H53" />
          <path d="M89 60 H53" />
        </g>

        <!-- 逐层扫过的高光（从左到右往返，制造"正在扫这一片"的观感） -->
        <rect class="sprog__sweep" x="-24" y="4" width="24" height="64" rx="12" />

        <!-- 节点：目标（右）→ 中间体 → 起始物料（左），依次呼吸 -->
        <circle class="sprog__node is-root" cx="178" cy="36" r="9" />
        <circle class="sprog__node" cx="96" cy="12" r="7" style="animation-delay: 0.18s" />
        <circle class="sprog__node" cx="96" cy="36" r="7" style="animation-delay: 0.36s" />
        <circle class="sprog__node" cx="96" cy="60" r="7" style="animation-delay: 0.54s" />
        <circle class="sprog__node is-leaf" cx="46" cy="12" r="5" style="animation-delay: 0.72s" />
        <circle class="sprog__node is-leaf" cx="46" cy="60" r="5" style="animation-delay: 0.9s" />
      </svg>
    </div>

    <div class="sprog__body">
      <p class="sprog__title">
        多步路线搜索进行中
        <!-- 三个点依次跳动：最省地方、也最不会看错的"还在动"信号 -->
        <span class="sprog__dots" aria-hidden="true"><i /><i /><i /></span>
      </p>

      <p class="sprog__phase">{{ phaseText }}</p>

      <div class="sprog__bar">
        <i :style="{ width: `${pct}%` }" />
      </div>

      <div class="sprog__meta">
        <span class="sprog__stat">已用 <b>{{ elapsedText }}</b></span>
        <span class="sprog__stat">
          预算 <b>{{ store.autoProgress.done }}/{{ store.autoProgress.budget }}</b> 次调用
        </span>
        <span class="sprog__pct">{{ pct }}%</span>
        <button type="button" class="sprog__stop" @click="store.stopAuto()">停止</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sprog {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  max-width: 560px;
  margin: 14px auto;
  padding: 14px 18px;
  border: 1px solid color-mix(in srgb, var(--rw-brand) 32%, var(--rw-border));
  border-radius: var(--rw-radius);
  background: var(--rw-surface);
  box-shadow: var(--rw-shadow-2);
}

/* 光晕：绝对定位、不吃指针，纯装饰 */
.sprog__glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  animation: sprog-glow 2.2s ease-out infinite;
}

/* ---------- ① 示意图 ---------- */
.sprog__art {
  flex: 0 0 150px;
  width: 150px;
  height: 58px;
}

.sprog__art svg {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

/* 虚线沿线流动 —— 这是"正在搜索"最主要的动感来源 */
.sprog__edges path {
  stroke-dasharray: 5 5;
  stroke-linecap: round;
  opacity: 0.55;
  animation: sprog-march 1.1s linear infinite;
}

/* 节点依次呼吸：错开 delay ⇒ 看着像"一层一层往下拆" */
.sprog__node {
  fill: var(--rw-brand);
  transform-box: fill-box;
  transform-origin: center;
  animation: sprog-pop 1.8s ease-in-out infinite;
}

.sprog__node.is-root {
  fill: var(--rw-brand-d);
}

.sprog__node.is-leaf {
  fill: var(--rw-anno);
}

/* 扫光：低透明度的品牌色竖条往复扫过整张图 */
.sprog__sweep {
  fill: color-mix(in srgb, var(--rw-brand) 14%, transparent);
  animation: sprog-sweep 2.6s ease-in-out infinite;
}

/* ---------- ② 文案 / ③ 进度 / ④ 计时 ---------- */
.sprog__body {
  flex: 1;
  min-width: 0;
}

.sprog__title {
  display: flex;
  align-items: baseline;
  gap: 2px;
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--rw-text);
}

.sprog__dots {
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
  margin-left: 2px;
}

.sprog__dots > i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--rw-brand);
  animation: sprog-blink 1.2s ease-in-out infinite;
}

.sprog__dots > i:nth-child(2) {
  animation-delay: 0.18s;
}

.sprog__dots > i:nth-child(3) {
  animation-delay: 0.36s;
}

.sprog__phase {
  margin: 3px 0 8px;
  font-size: 11.5px;
  color: var(--rw-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sprog__bar {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--rw-surface-3);
  overflow: hidden;
}

/* 🔴 `min-width` 不能省：刚开跑时 done=0 ⇒ 宽度 0 ⇒ 一条空槽，
      看着还是"没反应"；留一小截跑马灯，第一帧就能看出它在动。 */
.sprog__bar > i {
  position: absolute;
  inset: 0 auto 0 0;
  min-width: 10px;
  border-radius: 999px;
  background-color: var(--rw-brand);
  /* 斜纹跑马灯：进度条"自己在走"，与真实百分比是否变化无关 */
  background-image: linear-gradient(
    115deg,
    rgb(255 255 255 / 30%) 25%,
    transparent 25%,
    transparent 50%,
    rgb(255 255 255 / 30%) 50%,
    rgb(255 255 255 / 30%) 75%,
    transparent 75%
  );
  background-size: 18px 18px;
  animation: sprog-stripes 0.7s linear infinite;
  transition: width 0.4s ease;
}

.sprog__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--rw-text-3);
}

.sprog__stat b {
  color: var(--rw-text-2);
  font-variant-numeric: tabular-nums;
}

.sprog__pct {
  margin-left: auto;
  font-size: 15px;
  font-weight: 650;
  color: var(--rw-brand);
  font-variant-numeric: tabular-nums;
}

.sprog__stop {
  flex: 0 0 auto;
  padding: 2px 11px;
  border: 1px solid color-mix(in srgb, var(--rw-bad) 42%, transparent);
  border-radius: 5px;
  background: var(--rw-surface);
  color: var(--rw-bad);
  font-size: 11.5px;
  line-height: 1.6;
  cursor: pointer;
  transition: background 0.15s;
}

.sprog__stop:hover {
  background: var(--rw-bad-l);
}

/* ---------- 关键帧 ---------- */
@keyframes sprog-march {
  to {
    stroke-dashoffset: -20;
  }
}

@keyframes sprog-pop {
  0%,
  100% {
    transform: scale(0.72);
    opacity: 0.35;
  }

  50% {
    transform: scale(1.12);
    opacity: 1;
  }
}

@keyframes sprog-sweep {
  0% {
    transform: translateX(0);
  }

  100% {
    transform: translateX(224px);
  }
}

@keyframes sprog-stripes {
  to {
    background-position: 18px 0;
  }
}

@keyframes sprog-blink {
  0%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }

  50% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

@keyframes sprog-glow {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--rw-brand) 34%, transparent);
  }

  70% {
    box-shadow: 0 0 0 9px color-mix(in srgb, var(--rw-brand) 0%, transparent);
  }

  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--rw-brand) 0%, transparent);
  }
}

/* 窄屏：图收掉，文字吃满 —— 别让示意图把进度挤成竖排 */
@media (max-width: 720px) {
  .sprog__art {
    display: none;
  }
}

/* 🔴 尊重系统「减少动态效果」：动画全停，但**信息一条不少**
   （标题 / 阶段 / 进度 / 用时 / 停止按钮都还在，只是不再动）。 */
@media (prefers-reduced-motion: reduce) {
  .sprog__glow,
  .sprog__edges path,
  .sprog__node,
  .sprog__sweep,
  .sprog__bar > i,
  .sprog__dots > i {
    animation: none;
  }

  .sprog__node {
    opacity: 1;
    transform: none;
  }

  .sprog__edges path {
    opacity: 0.75;
  }
}
</style>
