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
 *
 * 🔴 挂在 `App.vue` 而不是某个页面里：它持有**唯一的 `router-view`**，
 *    5 个页面共用这一套壳；挂进页面会在路由切换时被卸载（侧栏/顶栏跟着闪）。
 *
 * 🔴 根元素是 `overflow:hidden` 的 flex 容器 ⇒ 任何需要不被裁剪的浮层
 *    （登录弹窗等 Teleport 到 body 的组件）必须挂在**它外面**，别往里塞。
 *
 * @author yijiu2025
 * @since 2026-10-05
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

/**
 * 手机端档（<768）：侧栏**整个不渲染**，改用底部固定页签。
 *
 * 🔴 为什么不用「收成图标条」：64px 图标条在 390 宽的屏上要占掉 1/6 宽度，
 *    而且 4~5 个入口只剩图标、没有文字，得靠记忆 —— 手机上尤其难认。
 *    底部页签在拇指热区，且天然带文字。
 */
const isMobile = ref(false);
/** 窄屏（<1180）时辅助面板堆到下方，此时收起态没有意义 → 强制展开显示 */
const narrow = ref(false);

const collapsed = computed({
  // 🔴 isMobile 下侧栏压根不渲染，收起态对它没有意义 ⇒ 不参与计算，
  //    否则「切回桌面宽度时会莫名是收起态」（sidebarCollapsed 已被 isMobile 污染过）。
  get: () => (isMobile.value ? false : settings.sidebarCollapsed),
  set: (v: boolean) => {
    settings.sidebarCollapsed = v;
  }
});

/** 底部页签的第四格：「设置」不走路由，是弹运行设置 */
const settingsOpen = computed({
  get: () => store.runSettingsOpen,
  set: (v: boolean) => {
    store.runSettingsOpen = v;
  }
});

/**
 * dev 自检用：CSS 的 `max-width` **包含**阈值本身，而 JS 用 `<=`。
 * 若日后有人把 CSS 改成 `max-width: 767px` 之类，两者就会错开 ⇒ 两套导航都没了。
 * 这里直接问 CSS「此刻侧栏是不是被隐藏了」，与 JS 的判断对照。
 */
const asideHiddenByCss = ref(false);

function checkNavConsistency(): void {
  if (!import.meta.env.DEV) return;
  const el = asideRef.value;
  if (!el) return;
  asideHiddenByCss.value = getComputedStyle(el).display === 'none';
}

/**
 * 🔴 只在 dev 生效。`import.meta.env.DEV` **不能写在模板表达式里**
 *    （Vue 编译模板时 sourceType 不是 module，构建期直接报
 *    "import.meta may appear only with 'sourceType: module'"）⇒ 必须经脚本侧的 computed。
 */
const showNavSelfCheck = computed(
  () => import.meta.env.DEV && !isMobile.value && asideHiddenByCss.value
);

/** 当前激活的是哪个一级入口（404 不属于任何一个 → 全部不高亮） */
const activeNavPath = computed(() => {
  const hit = navItems.find((i) => i.path === route.path);
  return hit ? hit.path : '';
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
/**
 * 导航图标 —— 内联 SVG path（lucide 风格）。
 *
 * 🔴 为什么不用 emoji / Unicode 字符（⌗ ☰ ⟲ ☺）：跨平台字形不一致
 *    （Windows 会落到 Segoe UI Emoji 渲染成彩色表情），且项目规范明确
 *    「UI 禁止 emoji 图标，一律图标库或内联 SVG」。
 *    圆形全部用两段弧拼（`A` 命令），保证整个映射只有 path 一种元素、模板一个 v-for。
 */
const NAV_ICON_PATHS: Record<string, string[]> = {
  workbench: [
    'M3 3h7v9H3z',
    'M14 3h7v5h-7z',
    'M14 12h7v9h-7z',
    'M3 16h7v5H3z'
  ],
  tasks: [
    'M8 6h13',
    'M8 12h13',
    'M8 18h13',
    'M3 6h.01',
    'M3 12h.01',
    'M3 18h.01'
  ],
  history: [
    'M12 3a9 9 0 1 0 .01 0',
    'M12 7v5l3 2'
  ],
  profile: [
    'M12 4a4 4 0 1 0 .01 0',
    'M4 21c0-4 4-6 8-6s8 2 8 6'
  ]
};

const navItems = [
  { path: '/', label: '工作台', icon: 'workbench' },
  { path: '/tasks', label: '任务列表', icon: 'tasks' },
  { path: '/history', label: '历史记录', icon: 'history' },
  { path: '/profile', label: '个人中心', icon: 'profile' }
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

/** 手机端档的宽度阈值。CSS 侧是 `@media (max-width: 768px)`（**含** 768）。 */
const MOBILE_MAX_W = 768;

function onResize(): void {
  // 🔴 阈值必须与 CSS 断点**逐字一致**（见 style 里的 `@media (max-width: 768px)`）。
  //    ⚠️ 这里必须是 `<=` 而不是 `<`：CSS 的 `max-width: 768px` **包含** 768 整，
  //    若 JS 用 `<`，则在 768 整这一档会同时出现
  //    「CSS 判手机 ⇒ 侧栏 display:none」+「JS 判非手机 ⇒ 不渲染底部页签」
  //    ⇒ **侧栏与页签同时消失、导航整个不见了**（实测在 768×1024 复现）。
  //    两处不同步就是这个 bug 的根，改任何一边都要同时改另一边。
  isMobile.value = window.innerWidth <= MOBILE_MAX_W;
  narrow.value = window.innerWidth < 1180;
}

const asideRef = ref<HTMLElement | null>(null);

/**
 * 🔴 必须是**具名**函数：内联箭头传给 addEventListener 的话，
 *    `removeEventListener(…, onResize)` 移除的是**另一个引用** ⇒ 监听器泄漏，
 *    组件卸载后再改窗口尺寸仍会跑 onResize（对已卸载的 ref 赋值、访问已销毁的 store）。
 */
function handleResize(): void {
  onResize();
  checkNavConsistency();
}

onMounted(() => {
  handleResize();
  window.addEventListener('resize', handleResize);
  // 🔴 后端就绪检测放在**应用外壳**而非某个视图：标定态（首次进入）也要知道
  //    后端连没连上、模型就绪没就绪 —— 否则首页看不到任何异常提示。
  //    loadModels 失败会 setGlobalError ⇒ 首页顶部的提示条据此显示"后端未就绪"。
  void store.loadModels();
});

onUnmounted(() => window.removeEventListener('resize', handleResize));
</script>

<template>
  <div class="app" :class="{ 'is-collapsed': collapsed, 'is-narrow': narrow }">
    <aside ref="asideRef" class="app__aside">
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
          <span class="app__nav-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path v-for="d in NAV_ICON_PATHS[item.icon]" :key="d" :d="d" />
            </svg>
          </span>
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
        <!-- 🔴 「运行设置」入口住在侧栏底部（用户要求），**任何页面都在** ——
             运行参数是全局的（模型也好、拆分约束也好，不跟着路由走），
             在「任务列表 / 历史记录 / 个人中心」也一样要能改。
             点开的是挂在**本组件**里的共享弹窗（store.runSettingsOpen），
             所以它不依赖任何视图存在：即使当前页面压根没有标定面板也能开。
             （历史上的 `v-if="route.name === 'workspace'"` 是怕「别的页没地方挂弹窗」——
              弹窗上移到 AppShell 全局层之后这个约束就没了，那条 v-if 只剩副作用：
              在别的页里设置按钮整个消失，用户以为入口丢了。） -->
        <button
          type="button"
          class="app__settings"
          title="模型、拆分约束、大模型、条件方案、分析模块、采购询价"
          @click="store.runSettingsOpen = true"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"
              stroke="currentColor"
              stroke-width="1.7"
            />
            <path
              d="M19.3 12c0-.5 0-1-.1-1.4l2-1.6-1.9-3.3-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.1 2h-3.8l-.4 2.6c-.9.3-1.7.8-2.4 1.4l-2.4-1L3.2 8.3l2 1.6a8 8 0 0 0 0 2.8l-2 1.6 1.9 3.3 2.4-1c.7.6 1.5 1 2.4 1.4l.4 2.6h3.8l.4-2.6c.9-.3 1.7-.8 2.4-1.4l2.4 1 1.9-3.3-2-1.6c.1-.4.1-.9.1-1.4Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linejoin="round"
            />
          </svg>
          <span v-show="!collapsed">设置</span>
        </button>
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

    <!-- 🔴 全局「运行设置」弹窗：挂在这里而不是 TargetSetupPanel ——
         标定态与路线态**共用同一份**。侧栏底部的设置按钮点开它
         （store.runSettingsOpen）；若挂进 TargetSetupPanel，路线态下那个组件
         v-if 卸载，弹窗跟着消失，侧栏按钮就点开没反应（实测踩过）。
         el-dialog 默认首次打开前不渲染内容 ⇒ 守门脚本先点按钮再断言。 -->
    <el-dialog
      v-model="store.runSettingsOpen"
      title="运行设置"
      width="min(880px, 94vw)"
      align-center
      class="app__run-settings-dialog"
    >
      <RunParams />
      <template #footer>
        <el-button @click="store.runSettingsOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <!--
      🔴 自检：侧栏与页签是**互斥**的两套导航。若某处把 JS 阈值与 CSS 断点改得不一致，
        会出现「两套都不显示 ⇒ 整个导航消失」且**没有任何报错**。
        这里在 dev 下把这种情况显式暴露出来，别让它变成"用户说找不到菜单"这种难查的问题。
    -->
    <p v-if="showNavSelfCheck" class="app__nav-selfcheck">
      导航自检失败：CSS 已按手机档隐藏侧栏，但 JS 判为非手机 ⇒ 两套导航都没了。
      请核对 MOBILE_MAX_W 与 @media (max-width: …) 是否一致。
    </p>

    <!--
      🔴 手机端底部页签（<768 才渲染，见 style 的 @media）。

      为什么用 `v-if="isMobile"` 而不是纯 CSS 隐藏：
        · 侧栏那条路上还有「最近的任务」「目标分析」「运行设置」等大量节点，
          CSS 隐藏只是看不见，**DOM 仍在、组件仍 mount**，手机端的内存与初始化开销白付；
        · 底部页签是**新增**的导航入口，纯 CSS 做不出来（它是条件渲染出来的）。

      第五格「设置」不走路由：它打开的是本组件里那个共享的「运行设置」弹窗
      （`store.runSettingsOpen`），所以在侧栏不渲染时依然可用 ——
      🔴 这正是它必须放在这里的原因：侧栏的设置齿轮在手机端整个没了，
      少了这一格就等于手机端**完全没有**运行参数的入口。
    -->
    <nav v-if="isMobile" class="app__tabbar" aria-label="主导航">
      <button
        v-for="item in navItems"
        :key="item.path"
        type="button"
        class="app__tab"
        :class="{ 'is-active': activeNavPath === item.path }"
        :aria-current="activeNavPath === item.path ? 'page' : undefined"
        @click="router.push(item.path)"
      >
        <span class="app__tab-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path v-for="d in NAV_ICON_PATHS[item.icon]" :key="d" :d="d" />
          </svg>
        </span>
        <span class="app__tab-label">{{ item.label }}</span>
      </button>

      <button
        type="button"
        class="app__tab"
        :class="{ 'is-active': settingsOpen }"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = true"
      >
        <span class="app__tab-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
          </svg>
        </span>
        <span class="app__tab-label">设置</span>
      </button>
    </nav>
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
  /* 🔴 左右 padding = 8px（不是 0）：给导航留出贴边呼吸，同时**与下方任务区、
     目标分析卡保持一致的内缩量** —— 三块都加同一份 8px 左右 padding，
     内部各自的 12px 不变 ⇒ 整体统一往里缩、左右都留白，且不破坏上一轮的对齐。 */
  padding: 14px 8px 10px;
  /* 导航只占自身高度，"最近的任务"才是可伸缩的那一段 */
  flex: 0 0 auto;
}

.app__nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border: 0;
  border-radius: var(--rw-radius-sm);
  background: transparent;
  color: var(--rw-text-2);
  font-size: 13.5px;
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
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* SVG 图标与文字行高对齐（与「收起侧栏」按钮同一套 1.5em 规则） */
.app__nav-icon svg {
  width: 16px;
  height: 16px;
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

/* 「最近的任务」：导航之下的第一段（自己不再滚动，交给上面的容器）。
   左右 8px 与 `.app__nav` 同一份 —— 整体内缩、左右留白，内部 12px 不变。 */
.app__recent {
  /* 顶部 16px：与导航分隔线之间留出呼吸（原 10px 偏贴，用户报"密集"） */
  padding: 16px 8px 10px;
}

/* 「目标分析」：紧接其后，同一条滚动流里。只留一条分隔线做视觉分段 ——
   不再有自己的滚动与高度上限（`max-height` 一去掉，"两段各占一半"的机制就没了）。 */
.app__target {
  padding: 10px 8px 8px;
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

/* 「设置」入口：与「收起侧栏」同族（住在侧栏底部），只是语义是打开共享弹窗 */
.app__settings {
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
  line-height: 1.5;
  cursor: pointer;
  white-space: nowrap;
}

.app__settings svg {
  width: 1.5em;
  height: 1.5em;
  flex: 0 0 1.5em;
}

.app__settings:hover {
  background: var(--rw-surface-2);
  color: var(--rw-text);
}

/* 收起态（64px 图标条）时设置图标也居中，与品牌 logo 同一条竖线 */
.app.is-collapsed .app__settings {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
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
  /* 🔴 手机端：侧栏**整个不渲染**（结构层 `v-if` 已保证不 mount，这里是兜底）。
     底部页签接管导航。 */
  .app__aside {
    display: none;
  }
  .app__content {
    padding: var(--rw-content-pad-y) 12px;
  }
  /* 🔴 底部页签占位：给**滚动区**留出高度，否则最后一块内容被 fixed 页签盖住。
     🔴 必须挂在 .app__content（`flex:1` 的那个滚动容器）——不是 .app__body：
        .app__body 是 flex 列，padding 加在它上面不会让内部滚动区变短。
     🔴🔴 **必须放在上面那条 `padding` 简写之后**：简写会把 padding-bottom 重置回
        上下值（实测 767/768 两档留白只有 12px，内容被页签盖住；480 档因为顺序
        恰好在后面才"碰巧"正常 —— 这种靠顺序侥幸是对的，最该修）。
        高度与 .app__tabbar 的 min-height 一致（56px）+ 安全区。 */
  .app__content {
    padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px));
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

/* dev 自检条：只在开发模式出现，且刻意用刺眼的配色（别让它被当成正常 UI 忽略掉） */
.app__nav-selfcheck {
  margin: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fde8e8;
  color: #a32d2d;
  font-size: 12px;
  line-height: 1.5;
}

/* ---------- 底部页签（手机端） ----------
   🔴 与 .app__aside 是**互斥**的两套导航，靠 768 断点切换；
      模板侧还有 `v-if="isMobile"` 保证 isMobile 时侧栏不 mount。
   🔴 高度固定 56px：.app__content 的 padding-bottom 必须与它一致，否则内容被盖。 */
.app__tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 60;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  align-items: stretch;
  background: var(--rw-surface);
  border-top: 1px solid var(--rw-border);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* 🔴 单格 ≥44px 高（触摸目标下限）；图标 22 + 文字 11 上下排开 */
.app__tab {
  appearance: none;
  border: none;
  background: none;
  min-height: 56px;
  padding: 6px 2px 7px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: var(--rw-text-3);
  cursor: pointer;
  font-family: inherit;
}
.app__tab.is-active {
  color: var(--rw-brand);
}
.app__tab-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
}
.app__tab-icon svg {
  width: 22px;
  height: 22px;
}
.app__tab-label {
  font-size: 11px;
  line-height: 1.1;
  /* 标签最长 4 个字（「任务列表」），窄屏下别让它换行把格子撑高 */
  white-space: nowrap;
}

/* ---------- 480：小屏（iPhone SE 等）收紧间距与字号 ----------
   🔴 此前**没有**这一档：390 宽的手机会直接命中 768 那条最粗的规则，
      结果是元素按 768 的尺寸铺在 390 的屏上 —— 留白过大、一行放不下几项。 */
@media (max-width: 480px) {
  .app__content {
    padding: var(--rw-content-pad-y) 10px;
  }
  .app__header {
    padding: 0 10px;
    gap: 6px;
  }
  .app__actions {
    gap: 4px;
  }
  .app__heading h1 {
    font-size: 14px;
  }
  .app__tab {
    min-height: 52px;
  }
  .app__tab-icon,
  .app__tab-icon svg {
    width: 20px;
    height: 20px;
  }
  .app__tab-label {
    font-size: 10px;
  }
  /* 与上面 .app__tabbar 在 480 档的 52px 保持一致 */
  .app__content {
    padding-bottom: calc(52px + env(safe-area-inset-bottom, 0px));
  }
  :global(html:root) {
    --rw-content-pad-y: 10px;
  }
}

/* ---------- 全局「运行设置」弹窗里的 RunParams ---------- */
/* 弹窗标题已叫「运行设置」，RunParams 自带卡片头「运行参数」隐藏防重复 */
.app__run-settings-dialog :deep(.rw-card__head) {
  display: none;
}

.app__run-settings-dialog :deep(.rw-card__body) {
  padding: 0;
}

/* 弹窗 880 宽：6 组折叠参数按宽度自动分栏。
   🔴 网格必须落在 `.params__body`（RunParams 卡片体）—— 落外层只有 1 个壳格。 */
.app__run-settings-dialog :deep(.params__body) {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px 24px;
  align-items: start;
  padding: 2px 2px 0;
}

/* 弹窗内容超高时内部滚动，footer 关闭按钮不被顶出视口 */
.app__run-settings-dialog :deep(.el-dialog__body) {
  max-height: calc(100vh - 220px);
  overflow: auto;
}
</style>
