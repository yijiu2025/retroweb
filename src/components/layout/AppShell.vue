<script setup lang="ts">
/**
 * 应用外壳：四个分区。
 *
 * ┌────────┬───────────────────────────────┬──────────┐
 * │        │  顶栏（标题 / 主题 / 用户）    │          │
 * │ 侧栏   ├───────────────────────────────┤ 辅助面板 │
 * │        │  内容区（router-view）         │          │
 * └────────┴───────────────────────────────┴──────────┘
 *
 * 分工与理由：
 *   ① **侧栏**（品牌 + 主导航 + 分组任务）纵向贯穿整屏 —— 品牌留在顶部，
 *      让「我们是谁 / 我在哪 / 我有哪些任务」这一列连续，不被顶栏打断。
 *      导航之下是**一个**滚动区（`.app__side-scroll`），「最近的任务」与
 *      「目标分析」同处这条滚动流里，不再各占一根滚动条（见模板注释）。
 *   ② **顶栏**横跨「主区 + 辅助面板」两列 —— 它描述的是*当前页面*的身份
 *      （标题 + 副标题）与全局动作（主题、用户），与左侧导航是两回事。
 *   ③ **内容区**只放页面主体，不再自己管参数栏 ——
 *      参数已抬到 ④，于是各页面都能用同一个右槽位放"随时可查的参考"。
 *   ④ **辅助面板**是一个**槽位**，内容随路由切换（见 AppShell 的 aside 插槽逻辑），
 *      可收起成 40px 竖条；开合状态落盘，刷新后保持。
 *
 * 布局断点：
 *   ≥1280px  侧栏 + 主区 + 辅助面板 三列并存
 *   <1180px  辅助面板堆到主区下方（横向空间不够，收成竖条反而更挤）
 *   <1024px  侧栏自动收成图标条
 *   <768px   顶栏压到 52px、副标题隐藏
 */
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Fold, Expand, Moon, Sunny } from '@element-plus/icons-vue';
import { useSettingsStore } from '@/stores/settings';
import { useWorkspaceStore } from '@/stores/workspace';
import UserMenu from './UserMenu.vue';
import DevBypassBadge from './DevBypassBadge.vue';
import AsidePanel from './AsidePanel.vue';
import SessionPanel from '@/components/workspace/SessionPanel.vue';
import TargetBar from '@/components/workspace/TargetBar.vue';
import RunParams from '@/components/workspace/RunParams.vue';
import SchemeCompare from '@/components/workspace/SchemeCompare.vue';
import RouteStats from '@/components/workspace/RouteStats.vue';
import MolPreviewDialog from '@/components/mol/MolPreviewDialog.vue';

const settings = useSettingsStore();
const store = useWorkspaceStore();
const route = useRoute();
const router = useRouter();

const isMobile = ref(false);
/** 窄屏（<1180）时辅助面板堆到下方，此时收起态没有意义 → 强制展开显示 */
const narrow = ref(false);

const collapsed = computed({
  get: () => settings.sidebarCollapsed || isMobile.value,
  set: (v: boolean) => {
    settings.sidebarCollapsed = v;
  }
});

/** 打开某个历史任务：恢复它的路线树 + 收起标定面板，必要时跳回工作台 */
function openSession(id: string): void {
  void store.loadSession(id);
  if (route.path !== '/') void router.push('/');
}

/**
 * 从侧栏「＋ 新任务」开始一个新任务。
 *
 * 🔴 只做两件事：把工作台切回**标定态**（空白面板）+ 必要时跳回工作台路由。
 *    **不碰**已有会话 —— 旧任务原样留在侧栏里，随时能点回去（store.openTargetSetup
 *    只 reset 当前工作台，不会再像以前那样顺手把上一条会话删掉）。
 */
function newSession(): void {
  store.openTargetSetup();
  if (route.path !== '/') void router.push('/');
}

/** 侧栏「查看全部 N 个任务」→ 整页任务列表（能搜能筛，侧栏只列得下前 6 条） */
function allSessions(): void {
  void router.push('/tasks');
}

/**
 * 主导航。
 *
 * 🔴 「工作台」与「任务列表」是并列的两个一级入口，不是从属关系：
 *    工作台 = 手上的**这一个**任务（拆它的树、看它的分析）；
 *    任务列表 = **所有**任务（找一条、看它做到哪了、删掉不要的）。
 *    侧栏「最近的任务」只列前 6 条，是"切回上一个活"的捷径，替代不了整页列表。
 */
const navItems = [
  { path: '/', label: '工作台', icon: '⌗' },
  { path: '/tasks', label: '任务列表', icon: '☰' },
  { path: '/history', label: '历史记录', icon: '⟲' },
  { path: '/profile', label: '个人中心', icon: '☺' }
];

/**
 * 左侧栏是否显示「目标分析」卡。
 *
 * 判据：**有目标 且 不在标定态**。标定态下目标还没定（或刚清空），
 * 挂一张空卡只会把「最近的任务」往下挤。
 */
const showTarget = computed(() => !store.targetSetupOpen && !!store.rootId);

/** 目标结构放大预览（左栏目标分析卡里的缩略图点开） */
const previewOpen = ref(false);
const previewSmiles = ref('');

function openPreview(smiles: string): void {
  previewSmiles.value = smiles;
  previewOpen.value = true;
}

const pageTitle = computed(() => (route.meta.title as string) || '逆合成工作台');
const pageDesc = computed(() => (route.meta.desc as string) || '');

/**
 * 辅助面板放什么 —— 由「当前路由 + 工作台处于哪个阶段」两件事决定。
 *
 * 🔴 判据必须是 `route.name === 'workspace'` 而不是 `route.path === '/'`：
 *    路由表里工作台的 path 是 '/'，但用 name 匹配更抗未来的路径调整。
 *
 * 三态：
 *   工作台 · 标定态 → 不显示（参数已并排在标定卡片里，右面板再放一份只会让人困惑）
 *   工作台 · 路线态 → 参数
 *   工作台 · 合成路线页签 → 方案对比（横向选优时才需要看）
 *   其他页面 → 不显示（历史 / 个人中心不需要常驻参考）
 */
const asideKind = computed<'params' | 'schemes' | 'none'>(() => {
  if (route.name !== 'workspace') return 'none';
  // 标定态下参数已在卡片里并排展示，右面板重复显示只会让人困惑
  if (store.targetSetupOpen) return 'none';
  return store.mainTab === 'route' ? 'schemes' : 'params';
});

/**
 * 任务状态条（空闲 / 节点 / 已采纳 / 最深 / 总概率）挂在辅助面板底部 ——
 * 它是「随时瞄一眼」的参考信息，跟「运行参数」同一类，放右栏比钉在内容区末尾更省一屏。
 */
const showStats = computed(() => route.name === 'workspace' && !store.targetSetupOpen);

const asideTitle = computed(() => (asideKind.value === 'schemes' ? '路线网络对比' : '运行参数'));

/**
 * 辅助面板里的内容用 `component :is` 动态渲染。
 * RunParams 传 embedded：面板已给了标题和外框，组件要关掉自己那层，
 * 否则会出现「运行参数 / 运行参数」两行标题（见 RunParams 头部注释）。
 */
type AsideComp = { comp: Component; props: Record<string, unknown> };

const asideContent = computed<AsideComp | null>(() => {
  if (asideKind.value === 'params') return { comp: RunParams, props: { embedded: true } };
  if (asideKind.value === 'schemes') return { comp: SchemeCompare, props: {} };
  return null;
});

function onResize(): void {
  isMobile.value = window.innerWidth < 768;
  narrow.value = window.innerWidth < 1180;
}

onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
});

onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div class="app" :class="{ 'is-collapsed': collapsed, 'is-narrow': narrow }">
    <aside class="app__aside">
      <div class="app__brand">
        <span class="app__logo" aria-label="RetroWeb">
          <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
            <circle cx="9" cy="9" r="4" fill="#2563eb" />
            <circle cx="23" cy="13" r="4" fill="#059669" />
            <circle cx="13" cy="23" r="4" fill="#dc2626" />
          </svg>
        </span>
        <span v-show="!collapsed" class="app__brand-text">
          <b>RetroWeb</b>
          <i>逆合成工作台</i>
        </span>
      </div>

      <nav class="app__nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          type="button"
          class="app__nav-item"
          :class="{ 'is-active': route.path === item.path }"
          :title="item.label"
          @click="router.push(item.path)"
        >
          <span class="app__nav-icon">{{ item.icon }}</span>
          <span v-show="!collapsed">{{ item.label }}</span>
        </button>
      </nav>

      <!-- 侧栏主干：任务列表 + 当前任务详情 —— **共用一个滚动条**。

           「最近的任务」（点一条即恢复该任务的路线树，「＋新任务」也在这里）
           在上，「目标分析」（当前这条任务在拆什么 + 已确认的路线网络）在下：
           先选任务、再看细节，顺序与阅读顺序一致。

           🔴 两段包在**同一个**滚动容器里，而不是各自 `overflow-y: auto`：
              它们是一条连续的阅读线，滚到两段交界处换一根滚动条、还得给
              各自分高度（原来「目标分析」`max-height: 55%`），内容一长两段
              就都只剩半截。合成一条滚动流后高度由内容决定、滚动只有一处。 -->
      <div v-show="!collapsed" class="app__side-scroll rw-scroll">
        <div class="app__recent">
          <SessionPanel @open="openSession" @new="newSession" @all="allSessions" />
        </div>
        <div class="app__target">
          <TargetBar v-if="showTarget" @preview="openPreview" />
        </div>
      </div>

      <div class="app__aside-foot">
        <button type="button" class="app__collapse" @click="collapsed = !collapsed">
          <el-icon><component :is="collapsed ? Expand : Fold" /></el-icon>
          <span v-show="!collapsed">收起侧栏</span>
        </button>
      </div>
    </aside>

    <!-- 主区 + 辅助面板：顶栏横跨这两列 -->
    <div class="app__body">
      <header class="app__header">
        <div class="app__heading">
          <h1>{{ pageTitle }}</h1>
          <p v-if="pageDesc">{{ pageDesc }}</p>
        </div>
        <div class="app__actions">
          <DevBypassBadge />
          <el-tooltip :content="settings.isDark ? '切换为浅色' : '切换为深色'" placement="bottom">
            <button type="button" class="app__icon-btn" @click="settings.toggle()">
              <el-icon><component :is="settings.isDark ? Sunny : Moon" /></el-icon>
            </button>
          </el-tooltip>
          <UserMenu />
        </div>
      </header>

      <!-- 顶栏之下：主区 + 辅助面板 -->
      <div class="app__lower">
        <main class="app__content rw-scroll">
          <router-view v-slot="{ Component }">
            <component :is="Component" />
          </router-view>
        </main>

        <!-- 辅助面板槽位：内容由 asideKind 决定；底部常驻任务状态条 -->
        <AsidePanel v-if="asideContent" class="app__aside-panel">
          <template #title>{{ asideTitle }}</template>
          <component :is="asideContent.comp" v-bind="asideContent.props" />
          <template #footer>
            <RouteStats v-if="showStats" embedded />
          </template>
        </AsidePanel>
      </div>
    </div>

    <MolPreviewDialog v-model="previewOpen" :smiles="previewSmiles" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ---------- 侧栏 ---------- */
.app__aside {
  display: flex;
  flex-direction: column;
  width: 240px;
  flex: 0 0 240px;
  background: var(--rw-surface);
  border-right: 1px solid var(--rw-border);
  transition: width 0.18s ease, flex-basis 0.18s ease;
}

.app.is-collapsed .app__aside {
  width: 64px;
  flex-basis: 64px;
}

.app__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--rw-header-h);
  flex: 0 0 var(--rw-header-h);
  padding: 0 16px;
  border-bottom: 1px solid var(--rw-border);
}

.app__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
}

.app__brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  overflow: hidden;
}

.app__brand-text b {
  font-size: 15px;
  color: var(--rw-text);
}

.app__brand-text i {
  font-style: normal;
  font-size: 11px;
  color: var(--rw-text-3);
}

.app__nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 10px 10px;
  /* 导航只占自身高度，"最近的任务"才是可伸缩的那一段 */
  flex: 0 0 auto;
}

.app__nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 0;
  border-radius: var(--rw-radius-sm);
  background: transparent;
  color: var(--rw-text-2);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
  white-space: nowrap;
}

.app__nav-item:hover {
  background: var(--rw-surface-2);
  color: var(--rw-text);
}

.app__nav-item.is-active {
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-weight: 600;
}

.app__nav-icon {
  width: 18px;
  text-align: center;
  font-size: 15px;
}

.app__aside-foot {
  padding: 10px;
  border-top: 1px solid var(--rw-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
}

/* 🔴 收起态必须把页脚**钉回底部**。
   原因：侧栏里唯一 `flex: 1` 的是 `.app__side-scroll`，而收起时它被 `v-show` 置成
   `display: none` ⇒ 剩余高度没人认领 ⇒ 页脚（↑展开按钮）会从底部弹到导航下方
   （实测 Δy = -738px，用户收起后找不到展开按钮）。
   只在收起态加 `margin-top: auto`，而不是无条件加：展开态本来就由 `.app__side-scroll` 的
   flex:1 顶住，此处显式区分两种情形，免得依赖「flex-grow 与 auto margin 谁先分配空间」这种实现细节。 */
.app.is-collapsed .app__aside-foot {
  margin-top: auto;
}

/* 收起态（64px 图标条）：三个控件统一居中。
   否则 `.app__nav-item` / `.app__collapse` 保留的 padding-left 会让图标偏在左边，
   与垂直居中放置的品牌 logo 不在同一条竖线上。 */
.app.is-collapsed .app__brand,
.app.is-collapsed .app__nav-item,
.app.is-collapsed .app__collapse {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

/* 侧栏主干滚动区：`最近的任务` + `目标分析` 共用的**唯一**滚动容器。
   🔴 合并的理由见模板注释。这里的关键是**高度由内容决定**（两段都是自然高度），
      而不是各分一半 —— 所以 `.app__target` 的 `max-height: 55%` 必须去掉，
      否则「目标分析」在自己那半截里再次被截断。
   分隔线与导航之间的那条线挂在**容器**上（不随内容滚走）：
   容器是 `overflow-y: auto` 的滚动容器，border 在它的 border-box 上，滚动时恒定可见。 */
.app__side-scroll {
  flex: 1 1 auto;
  min-height: 0;
  border-top: 1px solid var(--rw-border);
  overflow-y: auto;
}

/* 「最近的任务」：导航之下的第一段（自己不再滚动，交给上面的容器） */
.app__recent {
  padding: 10px 0 8px;
}

/* 「目标分析」：紧接其后，同一条滚动流里。只留一条分隔线做视觉分段 ——
   不再有自己的滚动与高度上限（`max-height` 一去掉，"两段各占一半"的机制就没了）。 */
.app__target {
  padding: 10px 0 8px;
  border-top: 1px solid var(--rw-border);
}

.app__collapse {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--rw-radius-sm);
  background: transparent;
  color: var(--rw-text-3);
  font-size: 13px;
  /* 🔴 行高定死 1.5，并让图标取同一个 1.5em —— 两处都从 font-size 派生，不写死像素。
     原因：文字行盒（约 17px）比 el-icon（1em = 13px）高，收起时文字 `display:none`
     ⇒ 按钮从 33px 缩到 29px；页脚是贴底的，按钮中心因此漂 2px。
     把两种内容都撑到 1.5em 后，按钮高度不再随文字显隐变化。 */
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
}

.app__collapse .el-icon {
  height: 1.5em;
}

.app__collapse:hover {
  background: var(--rw-surface-2);
  color: var(--rw-text);
}

/* ---------- 主区（顶栏 + 下半部分） ---------- */
.app__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--rw-header-h);
  flex: 0 0 var(--rw-header-h);
  padding: 0 22px;
  background: var(--rw-surface);
  border-bottom: 1px solid var(--rw-border);
}

.app__heading {
  min-width: 0;
}

.app__heading h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--rw-text);
  /* 窄屏标题不许换行（换行会把顶栏撑高、挤压内容区） */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app__heading p {
  margin: 0;
  font-size: 12px;
  color: var(--rw-text-3);
}

.app__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app__icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  cursor: pointer;
}

.app__icon-btn:hover {
  color: var(--rw-brand);
  border-color: var(--rw-brand);
}

/* 顶栏下方：内容区 + 辅助面板 横向并排 */
.app__lower {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.app__content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 上下走变量（页面要算「可用高度」时引用同一处，见 index.scss） */
  padding: var(--rw-content-pad-y) 22px;
}

/* 辅助面板：只在没内容时整条不出现（v-if），宽度由组件自己管 */
.app__aside-panel {
  min-height: 0;
}

/* 窄屏：辅助面板堆到内容区下方，纵向不够时就整页滚动 */
@media (max-width: 1180px) {
  .app__lower {
    flex-direction: column;
    overflow-y: auto;
  }

  .app__content {
    flex: 0 0 auto;
    overflow: visible;
  }
}

@media (max-width: 768px) {
  .app__content {
    padding: var(--rw-content-pad-y) 12px;
  }
  .app__heading p {
    display: none;
  }
  /* 窄屏顶栏只留必要元素：标题 + 主题 + 用户，避免挤成两行 */
  .app__actions {
    gap: 6px;
  }
  .app__header {
    padding: 0 12px;
    height: 52px;
    flex-basis: 52px;
    gap: 8px;
  }
  .app__heading h1 {
    font-size: 15px;
  }
  :global(html:root) {
    --rw-header-h: 52px;
    --rw-content-pad-y: 12px;
  }
}
</style>
