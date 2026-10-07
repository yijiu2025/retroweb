<script setup lang="ts">
/**
 * 右侧辅助面板 —— 应用外壳的第四个分区。
 *
 * 定位：这是「随时可查、改完立刻生效」的那一类内容的家。
 *   WorkBuddy 用它放文件编辑器；本工作台放的是三类**参考型**内容：
 *     ① 运行参数（改一下就跑一次）—— 工作台路线态
 *     ② 路线方案对比表（横向选优）—— 合成路线页签
 *     ③ 结构放大预览（看细节）—— 任何页签
 *
 * 为什么不塞在内容区里：
 *   参数栏以前是工作台路线态栅格的第 2 列（300px）。那样有三个问题 ——
 *   ① 只有工作台用得到，别的页面想放"常驻参考"没有位置；
 *   ② 伸缩只能在工作台内部实现，滚动位置与主区耦合；
 *   ③ 窄屏堆到主区下面后，"参考"变成了"要走到底才能看到"。
 *   抬成外壳的一个分区后，伸缩、滚动、断点都只在这一处管。
 *
 * 分工：本组件只管「槽位 + 标题 + 收起」，内容全部由 `default` 插槽注入，
 *       所以它不知道里面是参数还是方案表 —— 后续换内容不用动这里。
 */
import { computed } from 'vue';
import { useSettingsStore } from '@/stores/settings';

const settings = useSettingsStore();

const collapsed = computed({
  get: () => settings.asideCollapsed,
  set: (v: boolean) => {
    settings.asideCollapsed = v;
  }
});
</script>

<template>
  <aside class="aside" :class="{ 'is-collapsed': collapsed }">
    <!-- 收起态：只剩一条窄边条，点它展开 -->
    <button
      v-if="collapsed"
      type="button"
      class="aside__rail"
      title="展开辅助面板"
      @click="collapsed = false"
    >
      <span class="aside__rail-chevron">‹</span>
      <span class="aside__rail-text">辅助面板</span>
    </button>

    <template v-else>
      <header class="aside__head">
        <span class="aside__title">
          <slot name="title">辅助面板</slot>
        </span>
        <button
          type="button"
          class="aside__collapse"
          title="收起辅助面板"
          @click="collapsed = true"
        >
          <span class="aside__chevron">›</span>
        </button>
      </header>

      <div class="aside__body rw-scroll">
        <slot />
      </div>

      <!-- 底部固定区：任务状态条之类的「随时瞄一眼」内容（不随主体滚动） -->
      <footer v-if="$slots.footer" class="aside__foot">
        <slot name="footer" />
      </footer>
    </template>
  </aside>
</template>

<style scoped>
.aside {
  display: flex;
  flex-direction: column;
  width: 320px;
  flex: 0 0 320px;
  min-width: 0;
  background: var(--rw-surface);
  border-left: 1px solid var(--rw-border);
  transition: width 0.18s ease, flex-basis 0.18s ease;
}

/* 收起：整条收成 40px 的竖条。宽度用 flex-basis 一起改，
   否则 flex 布局仍会按 320px 分配空间，主区看不出变化。 */
.aside.is-collapsed {
  width: 40px;
  flex-basis: 40px;
}

/* ---------- 收起态的竖条 ---------- */
.aside__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 100%;
  padding: 14px 0;
  border: 0;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.aside__rail:hover {
  background: var(--rw-surface-2);
  color: var(--rw-brand);
}

.aside__rail-chevron {
  font-size: 15px;
  line-height: 1;
}

/* 竖排文字：比把 "辅助面板" 横过来塞进 40px 更易读 */
.aside__rail-text {
  writing-mode: vertical-rl;
  letter-spacing: 0.12em;
}

/* ---------- 展开态 ---------- */
.aside__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: var(--rw-header-h);
  flex: 0 0 var(--rw-header-h);
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--rw-border);
}

.aside__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--rw-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aside__collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  border: 0;
  border-radius: var(--rw-radius-sm);
  background: transparent;
  color: var(--rw-text-3);
  cursor: pointer;
}

.aside__collapse:hover {
  background: var(--rw-surface-3);
  color: var(--rw-brand);
}

.aside__chevron {
  font-size: 16px;
  line-height: 1;
}

.aside__body {
  flex: 1;
  min-height: 0;
  padding: 14px 14px 18px;
}

/* 底部固定区：内容自己也带一边框时会出现双线，所以这里只做分隔（不给 padding-top） */
.aside__foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--rw-border);
  background: var(--rw-surface);
}

/* 窄屏：右面板不再贴右，改为堆到主区下方并取消固定宽度 */
@media (max-width: 1180px) {
  .aside {
    width: auto;
    flex-basis: auto;
    border-left: 0;
    border-top: 1px solid var(--rw-border);
  }

  .aside.is-collapsed {
    width: auto;
    flex-basis: auto;
  }

  /* 窄屏的收起态横过来：竖排文字在这里反而占掉一整行 */
  .aside__rail {
    flex-direction: row;
    justify-content: center;
    height: auto;
    padding: 10px 12px;
  }

  .aside__rail-text {
    writing-mode: horizontal-tb;
  }
}
</style>
