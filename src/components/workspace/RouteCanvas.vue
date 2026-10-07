<script setup lang="ts">
/**
 * 路线图 —— **Reaxys 式**的合成路线可视化（2026-10-06 新增，取代原来的「合成路线」列表）。
 *
 * ── 学的是 Reaxys 的哪几件事 ────────────────────────────────────────────
 * ① **化合物 = 卡片**：白底、圆角、细边框，卡片里只有结构式 + **底部一行动作图标**
 *    （悬停/常驻皆可）。信息密度靠图标行承载，而不是把按钮和标签堆成一列。
 * ② **反应 = 边上的 Step chip**：一条边上挂一个小圆角方块「第 N 步」+ 概率，
 *    而不是单独一行文字。多分支时 chip 落在父节点分叉的汇合点（每个父节点一枚）。
 * ③ **状态用虚线标注**（这是 Reaxys 最有辨识度的一笔）：
 *      · 「可购买原料」→ 橙色**虚线圆角框**把连续的同列起始物料**成组圈住**；
 *      · 「未知化合物」→ 橙色**虚线圆**圈住那张卡片。
 *    注解是"贴在图上"的，不是列表里的一个 tag。
 * ④ **目标产物**用实线粗框高亮（Reaxys 用橙色，这里用本站品牌蓝，语义等价）。
 * ⑤ **顶部工具条**：适应视图 / 缩放 / 旋转方向 / 图例 / 复制路线 / 导出。
 * ⑥ **图例**可开关 —— 虚线框和圆分别是什么，点开就有。
 *
 * 🔴 方向：默认照 Reaxys —— **左 = 起始物料，右 = 目标产物**（`col = maxDepth - depth`）。
 *    工具条的「旋转方向」翻成逆合成方向（目标在左），因为这两套读法在化学界都常见，
 *    与其猜用户习惯，不如给个按钮。`store.route` 里 `step` 是 `depth + 1`，
 *    所以 Reaxys 顺序下 Step 1 恰好在最右（紧邻目标）—— 与 Reaxys 截图一致。
 *
 * 🔴 布局是**自己算坐标 + 绝对定位**（不是 flex 流）：
 *    连线要跨卡片（父节点竖直居中于子节点之间），只有拿到坐标才能画得出那种
 *    「总线 + 支线」的肘形连线。缩放靠 `transform: scale`，外面套一层撑开滚动区的 sizer。
 *
 * 🔴 交互只有**一套坐标**：`sizer`（宽高 = 画布 × zoom）+ 容器的 `scrollLeft/Top`。
 *    拖动平移、滚轮缩放、原生滚动条三者都落在这一套上 —— 谁也不用维护自己的偏移量，
 *    因此不会出现"拖过之后再缩放，图就跳走"（各存一份 translate 的写法必踩）。
 */
import { computed, onBeforeUnmount, onMounted, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import type { MolNode } from '@/types/retro';
import { openSupplier } from '@/utils/suppliers';
import { copyText } from '@/utils/clipboard';
import MolView from '@/components/mol/MolView.vue';

const emit = defineEmits<{ preview: [smiles: string] }>();

const store = useWorkspaceStore();

/* ---------- 布局常量（一处定义，卡片尺寸/连线/分组框全都从这里推） ---------- */
const CARD_W = 168;
const CARD_H = 112;
/** 列间距：要放得下 Step chip（约 64px 宽） */
const H_GAP = 116;
/**
 * 行间距。
 * 🔴 不能压得太小：「可购买原料」框与「未知化合物」圈的**标签是挂在框外的**
 *    （框内 top: -17px），太挤就会盖到上一张卡片上。34px ≈ 框内边距 11~14 + 标签 15 的余量。
 */
const V_GAP = 34;
const COL_PITCH = CARD_W + H_GAP;
const ROW_PITCH = CARD_H + V_GAP;
const PAD_L = 24;
/** 上边距要留出「可购买原料」那种贴在图上的标签 */
const PAD_T = 40;
const PAD_R = 24;
const PAD_B = 24;

type CardKind = 'target' | 'intermediate' | 'starting' | 'unknown' | 'dup';

interface RCard {
  id: string;
  smiles: string;
  depth: number;
  col: number;
  row: number;
  x: number;
  y: number;
  kind: CardKind;
  /** 该节点的结构在存 store 里的引用（取 formula / mw / 展开状态） */
  node: MolNode;
}

interface REdge {
  key: string;
  /** 折线：父边 → 总线 → 子边 */
  points: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * 边上的「第 N 步」小方块。
 *
 * 🔴 它是**每个父节点一枚**，不是每条边一枚：一个父节点分叉成多个子节点时，
 *    所有子边共用同一条总线，chip 落在那个汇合点上 —— 画多枚只会重叠成一坨。
 */
interface RChip {
  key: string;
  x: number;
  y: number;
  stepNo: number;
  probability: number;
}

/** 贴合在图上的一组标注（虚线框 / 虚线圈） */
interface RBadge {
  key: string;
  kind: 'starting' | 'unknown';
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 标签挂在框的哪一侧 */
  place: 'top' | 'left';
}

const cards = ref<RCard[]>([]);
const edges = ref<REdge[]>([]);
const chips = ref<RChip[]>([]);
const badges = ref<RBadge[]>([]);
const canvasW = ref(0);
const canvasH = ref(0);
const depthMax = ref(0);

/** false = Reaxys 顺序（原料在左）；true = 逆合成顺序（目标在左） */
const flipped = ref(false);
const showLegend = ref(false);
const zoom = ref(1);
const wrap = ref<HTMLElement | null>(null);
/** sizer 的 DOM 引用 —— 缩放时要**同步**改它的宽高，见 `zoomAt` 的注释 */
const sizerEl = ref<HTMLElement | null>(null);

const hasRoute = computed(() => cards.value.length > 0);
const route = computed(() => store.route);
const materials = computed(() => store.startingMaterials);
const totalProb = computed(() => store.routeProbability);

const schemeName = computed(
  () => store.schemes.find((s) => s.id === store.currentSchemeId)?.name ?? null
);

/** nodeId → 该步的编号/概率（`store.route` 已经算好啦，直接用，别自己重推） */
const stepInfo = computed(() => {
  const m = new Map<string, { step: number; probability: number }>();
  for (const s of route.value) m.set(s.nodeId, { step: s.step, probability: s.probability });
  return m;
});

/* ---------- 布局 ---------- */
function build(): void {
  const root = store.rootId ? store.nodes[store.rootId] : undefined;
  if (!root) {
    cards.value = [];
    edges.value = [];
    chips.value = [];
    badges.value = [];
    canvasW.value = 0;
    canvasH.value = 0;
    return;
  }

  const list: RCard[] = [];
  const links: REdge[] = [];
  const chipList: RChip[] = [];
  let rowCursor = 0;
  let deepest = 0;

  /** 返回自己在**行**方向上的占位（父节点要靠子节点的行号来居中） */
  const walk = (node: MolNode, depth: number): number => {
    deepest = Math.max(deepest, depth);
    const kids = node.children
      .map((id) => store.nodes[id])
      .filter((n): n is MolNode => !!n && !n.detached);

    const self: RCard = {
      id: node.id,
      smiles: node.smiles,
      depth,
      col: 0,
      row: 0,
      x: 0,
      y: 0,
      kind: 'intermediate',
      node
    };
    list.push(self);

    if (kids.length) {
      const rows = kids.map((k) => walk(k, depth + 1));
      // 父节点竖直居中于它的第一个与最后一个子节点之间（标准树图摆法）
      self.row = (rows[0] + rows[rows.length - 1]) / 2;
    } else {
      self.row = rowCursor;
      rowCursor += 1;
    }
    return self.row;
  };

  walk(root, 0);
  depthMax.value = deepest;

  /** 列号：Reaxys 顺序要把深度倒过来（原料在左、目标在右） */
  const colOf = (depth: number): number => (flipped.value ? depth : deepest - depth);

  for (const c of list) {
    const node = c.node;
    const kids = node.children.filter((id) => {
      const n = store.nodes[id];
      return !!n && !n.detached;
    });
    c.kind =
      c.id === store.rootId
        ? 'target'
        : kids.length === 0
          ? node.duplicateOf
            ? 'dup'
            : store.isTerminal(node)
              ? 'starting'
              : 'unknown'
          : 'intermediate';
    c.col = colOf(c.depth);
    c.x = PAD_L + c.col * COL_PITCH;
    c.y = PAD_T + c.row * ROW_PITCH;
  }

  // 连线：父 → 每个子，走「父边 → 总线 → 子边」的肘形折线
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const parent of list) {
    const info = stepInfo.value.get(parent.id);
    if (!info) continue;
    const kids = parent.node.children
      .map((id) => byId.get(id))
      .filter((c): c is RCard => !!c);
    if (!kids.length) continue;

    const parentRight = parent.x + CARD_W;
    const parentCy = parent.y + CARD_H / 2;
    // 父在右（Reaxys 顺序）= 从子卡片的右缘连到父卡片的左缘
    const parentOnRight = parent.x > kids[0].x;
    const px1 = parentOnRight ? parent.x : parentRight;
    const busX = parentOnRight ? px1 - H_GAP / 2 : px1 + H_GAP / 2;

    // 一枚 chip 代表这个父节点上的那一步反应（多子节点共用，见 RChip 注释）
    chipList.push({
      key: `chip-${parent.id}`,
      x: busX,
      y: parentCy,
      stepNo: info.step,
      probability: info.probability
    });

    for (const kid of kids) {
      const childEdgeX = parentOnRight ? kid.x + CARD_W : kid.x;
      const childCy = kid.y + CARD_H / 2;
      links.push({
        key: `${parent.id}->${kid.id}`,
        points: `${px1},${parentCy} ${busX},${parentCy} ${busX},${childCy} ${childEdgeX},${childCy}`,
        x1: px1,
        y1: parentCy,
        x2: childEdgeX,
        y2: childCy
      });
    }
  }

  // 标注：起始物料按列分「连续段」成组圈住；未知化合物逐个圈
  const badgeList: RBadge[] = [];
  const startsByCol = new Map<number, RCard[]>();
  for (const c of list) {
    if (c.kind !== 'starting') continue;
    const arr = startsByCol.get(c.col) ?? [];
    arr.push(c);
    startsByCol.set(c.col, arr);
  }
  for (const [col, group] of startsByCol) {
    group.sort((a, b) => a.y - b.y);
    let run: RCard[] = [];
    const flush = (): void => {
      if (!run.length) return;
      const first = run[0];
      const last = run[run.length - 1];
      badgeList.push({
        key: `start-${col}-${first.id}`,
        kind: 'starting',
        label: run.length > 1 ? `可购买原料 ×${run.length}` : '可购买原料',
        x: first.x - 11,
        y: first.y - 11,
        w: CARD_W + 22,
        h: last.y + CARD_H - first.y + 22,
        place: 'top'
      });
      run = [];
    };
    for (const c of group) {
      const prev = run[run.length - 1];
      if (prev && c.y - prev.y > ROW_PITCH * 1.6) flush();
      run.push(c);
    }
    flush();
  }
  for (const c of list) {
    if (c.kind !== 'unknown') continue;
    badgeList.push({
      key: `unknown-${c.id}`,
      kind: 'unknown',
      label: '未知化合物',
      x: c.x - 14,
      y: c.y - 14,
      w: CARD_W + 28,
      h: CARD_H + 28,
      place: 'top'
    });
  }

  cards.value = list;
  edges.value = links;
  chips.value = chipList;
  badges.value = badgeList;
  canvasW.value = PAD_L + (deepest + 1) * COL_PITCH - H_GAP + PAD_R;
  canvasH.value = PAD_T + Math.max(1, rowCursor) * ROW_PITCH - V_GAP + PAD_B;
}

watch([() => store.rootId, () => store.nodes, flipped], build, { deep: true, immediate: true });

/* ---------- 缩放 / 平移 ---------- */
/**
 * 缩放范围。比原来（0.35~2）宽 —— 深树要缩得下去看全貌，细节也要放得大。
 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

/**
 * 画布四周垫出的**可平移余量**（px）。这是「缩小时鼠标左键拖不动」的正解，别删。
 *
 * 🔴 为什么需要它：平移是改 `scrollLeft/Top` 实现的，而滚动位置只在
 *    **内容比容器大**时才存在。图一缩小（或路线本来就窄），`sizer` 比容器还小
 *    ⇒ `scrollWidth === clientWidth` ⇒ `scrollLeft` 恒为 0 ⇒ 按住左键拖动**毫无反应**。
 *    给 sizer 四周垫一圈余量后，可拖空间**恒存在**（≥ 2 × PAN_PAD），
 *    缩到 20% 也能把图拖到视野里任意位置。
 *
 * 取值：要够把图从贴边挪到视野另一端；太小会变成"能拖但挪不了多远"，体感还是卡。
 */
const PAN_PAD = 320;
/** 「适应视图」留的边距 —— 别让图贴着画布内缘 */
const FIT_GAP = 28;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * sizer 尺寸 = `max(画布 × 缩放, 容器尺寸) + 四周各 PAN_PAD`。
 *
 * 🔴 `max(…, 容器)` 这一项不能省：图很小时 `画布 × 缩放` 可能比容器还小，
 *    此时 sizer 若取它，滚动空间与可拖余量**一起归零**（就是用户报的那个毛病）。
 *    用容器尺寸打底后，任何缩放下都至少留出 2 × PAN_PAD 的可拖空间。
 * 🔴 只在尺寸真变了才写 style：ResizeObserver 盯着容器，无脑写会来回触发。
 */
function syncSizer(): void {
  const s = sizerEl.value;
  if (!s) return;
  const el = wrap.value;
  const w = `${Math.max(canvasW.value * zoom.value, el?.clientWidth ?? 0) + PAN_PAD * 2}px`;
  const h = `${Math.max(canvasH.value * zoom.value, el?.clientHeight ?? 0) + PAN_PAD * 2}px`;
  if (s.style.width !== w) s.style.width = w;
  if (s.style.height !== h) s.style.height = h;
}

/**
 * 以**容器内某点**为锚点缩放：锚点底下的那个"图上的点"缩放前后停在原地。
 *
 * 🔴 必须**先同步把 sizer 撑到新尺寸**，再写 scrollLeft。两个坑：
 *    ① 只改 `zoom` 就写 scrollLeft ⇒ 被**旧的** scrollWidth 夹住，放大时必然偏移；
 *    ② 改成 `await nextTick()` 再写 ⇒ 连续滚轮之间会读到"还没应用"的 scrollLeft，
 *       锚点一路漂。手动写一次 style 把两个问题一起解决（Vue 随后写入的是同一个值）。
 *    现在多一个理由：sizer 尺寸还依赖容器尺寸（`max(…, 容器) + 余量`），
 *    不先写就写 scrollLeft，读到的是**上一倍率**的滚动范围。
 */
function zoomAt(next: number, anchorX: number, anchorY: number): void {
  const el = wrap.value;
  if (!el) return;
  const z = clampZoom(next);
  if (z === zoom.value) return;
  // 锚点当前对应的**内容坐标**（缩放前）。
  // 🔴 要减掉左上那圈余量：plane 不在 sizer 的原点，而在 (PAN_PAD, PAN_PAD) 处。
  const cx = (el.scrollLeft + anchorX - PAN_PAD) / zoom.value;
  const cy = (el.scrollTop + anchorY - PAN_PAD) / zoom.value;
  zoom.value = z;
  syncSizer();
  el.scrollLeft = cx * z + PAN_PAD - anchorX;
  el.scrollTop = cy * z + PAN_PAD - anchorY;
}

/** 按钮缩放没有指针位置，取视口中心最不突兀 */
function centerAnchor(): [number, number] {
  const el = wrap.value;
  return el ? [el.clientWidth / 2, el.clientHeight / 2] : [0, 0];
}

function fitView(): void {
  const el = wrap.value;
  const w = el?.clientWidth ?? 0;
  const h = el?.clientHeight ?? 0;
  if (!el || !w || !h || !canvasW.value || !canvasH.value) {
    zoom.value = 1;
    syncSizer();
    return;
  }
  // 🔴 宽、高**两个方向都判**：只看宽度的话，矮窗口里"适应视图"仍会把高度撑出去，
  //    用户点了还是看不全 —— 取两个方向里能装下的那个更小的倍数。
  zoom.value = clampZoom(
    Math.min(1, (w - FIT_GAP) / canvasW.value, (h - FIT_GAP) / canvasH.value)
  );
  syncSizer();
  centerView();
}

/**
 * 把图摆到画布正中。
 * 现在是「图四周有一圈可拖余量」的坐标系，滚动到 0 会看到的一大片留白 ——
 * 所以"看到全部"的落点不是左上角，而是**让 sizer 里图那一块的中央对准容器中央**。
 */
function centerView(): void {
  const el = wrap.value;
  if (!el) return;
  el.scrollLeft = PAN_PAD + (canvasW.value * zoom.value - el.clientWidth) / 2;
  el.scrollTop = PAN_PAD + (canvasH.value * zoom.value - el.clientHeight) / 2;
}

/** ① 工具条 ± ：乘法步进（连续量，而不是固定 ±0.1 —— 缩到 20% 时 ±0.1 就没手感了） */
function zoomBy(dir: 1 | -1): void {
  const [ax, ay] = centerAnchor();
  zoomAt(zoom.value * (dir > 0 ? 1.25 : 1 / 1.25), ax, ay);
}

function resetZoom(): void {
  const [ax, ay] = centerAnchor();
  zoomAt(1, ax, ay);
}

/**
 * ② 滚轮缩放 —— 画布类工具的通用手势（Reaxys / ChemDraw / Ketcher 都是滚轮缩放）。
 *
 * 🔴 delta 要归一化：Firefox 行模式（`deltaMode === 1`）一个刻度是 ±3，像素模式是 ±100，
 *    差 30 多倍 —— 不归一化会出现"同一份代码在 Chrome 好用、Firefox 里滚不动"。
 * 🔴 用 `Math.exp` 而不是 `zoom + k*delta`：这样每个刻度是**固定倍率**，
 *    缩到 20% 和放到 300% 的手感一致（线性加法在大倍率下会一顿一顿）。
 */
function onWheel(e: WheelEvent): void {
  const el = wrap.value;
  if (!el) return;
  // 🔴 必须拦掉默认行为：不拦的话浏览器会**同时**按 deltaY 滚这个容器 ——
  //    缩放刚把 scroll 换算好，紧接着又被滚走一截（用户看到的就是"缩放时图乱跳"）。
  //    这条能在探针里被抓住（断言 `defaultPrevented === true`），别删。
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
  const rect = el.getBoundingClientRect();
  zoomAt(zoom.value * Math.exp(-dy * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
}

/* ③ 按住拖动平移（pan）—— 改的是 scrollLeft/Top，与 sizer / 滚动条完全兼容：
      原生滚动条、滚轮（未命中缩放时）走的是同一套坐标，不会出现两套偏移互相打架。 */
const panning = ref(false);
let panFrom: { x: number; y: number; left: number; top: number } | null = null;

function onPointerDown(e: PointerEvent): void {
  const el = wrap.value;
  if (!el || e.button !== 0) return;
  // 只接管鼠标：触屏交给原生滚动 / 双指缩放，别把人家的手势吃掉
  if (e.pointerType !== 'mouse') return;
  // 卡片底部图标这类交互元素有自己的点击，不能被拖动抢走
  if ((e.target as HTMLElement | null)?.closest('button, a, input, textarea, select')) return;
  e.preventDefault(); // 免得拖动时把卡片里的文字选中
  panFrom = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
  panning.value = true;
  el.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  const el = wrap.value;
  if (!panFrom || !el) return;
  el.scrollLeft = panFrom.left - (e.clientX - panFrom.x);
  el.scrollTop = panFrom.top - (e.clientY - panFrom.y);
}

function onPointerUp(e: PointerEvent): void {
  const el = wrap.value;
  if (!panFrom) return;
  panFrom = null;
  panning.value = false;
  if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
}

/**
 * 滚轮监听必须**手动注册**（`passive: false`）。
 * 模板上的 `@wheel` 无法保证非被动监听 —— 一旦被浏览器按被动处理，
 * `preventDefault()` 就是空转：画布缩放了，整个页面**同时**跟着滚。
 */
let wheelBound: HTMLElement | null = null;
/** 盯着容器尺寸：窗口缩放 / 侧栏收起后，`max(画布, 容器)` 里那一项要跟着更新 */
let ro: ResizeObserver | null = null;
/** 画布此刻是否真的可见（有尺寸）—— 用来识别"从隐藏变成可见"这个瞬间 */
let wrapVisible = false;

function bindWrap(): void {
  const el = wrap.value;
  if (el !== wheelBound) {
    wheelBound?.removeEventListener('wheel', onWheel);
    wheelBound = el;
    wheelBound?.addEventListener('wheel', onWheel, { passive: false });
  }
  ro?.disconnect();
  ro = null;
  wrapVisible = false;
  if (el && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const on = !!wrap.value && wrap.value.clientWidth > 0 && wrap.value.clientHeight > 0;
      // 🔴 画布所在的页签是**懒显示**的：组件挂载时它是 `display: none`，
      //    `wrap` 的尺寸全是 0 ⇒ 那一刻的 fitView 只会走"尺寸不合法"的早退分支。
      //    所以要在**第一次真正可见**时补一次适应视图：否则用户切到本页签，
      //    看到的是左上角一大片留白（四周那圈可拖余量让这更刺眼）。
      if (on && !wrapVisible) fitView();
      wrapVisible = on;
      syncSizer();
    });
    ro.observe(el);
  }
  if (el) syncSizer();
}

watch(wrap, bindWrap, { immediate: true, flush: 'post' });
onBeforeUnmount(() => {
  wheelBound?.removeEventListener('wheel', onWheel);
  wheelBound = null;
  ro?.disconnect();
  ro = null;
});

onMounted(async () => {
  build();
  await nextTick();
  fitView();
});

// 换目标 / 换方案以后画布尺寸会变，重新适应一次视图
watch([canvasW, canvasH], async () => {
  await nextTick();
  fitView();
});

/* ---------- 顶部工具条动作 ---------- */
function rotate(): void {
  flipped.value = !flipped.value;
  ElMessage.info(flipped.value ? '已切到逆合成方向（目标在左）' : '已切到合成方向（原料在左）');
}

/** Reaxys 的「Copy route」：把这条路线导成「反应式 SMILES」文本 */
async function copyRoute(): Promise<void> {
  const lines = [...route.value]
    .sort((a, b) => b.step - a.step)
    .map(
      (s) =>
        `${s.precursors.join('.')}>>${s.product}    # 第 ${s.step} 步 · ${(s.probability * 100).toFixed(1)}%`
    );
  if (!lines.length) {
    ElMessage.warning('还没有采纳任何一步，没有路线可复制');
    return;
  }
  // 走全站唯一入口（见 utils/clipboard.ts）
  await copyText(lines.join('\n'), {
    okMsg: `已复制 ${lines.length} 步反应式 SMILES`,
    failMsg: '浏览器拒绝了剪贴板访问'
  });
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function exportJson(): void {
  download(`retroweb-route-${stamp()}.json`, store.exportJson(), 'application/json');
}

function exportCsv(): void {
  download(`retroweb-route-${stamp()}.csv`, store.exportCsv(), 'text/csv;charset=utf-8');
}

function onPrint(): void {
  window.print();
}

/* ---------- 卡片上的动作图标 ---------- */
type ActionKey = 'expand' | 'analysis' | 'buy' | 'unbuy' | 'copy' | 'preview' | 'remove' | 'query';

/** 单色线性图标（24 格 viewBox，一条或多条 path）—— 图标行要装得下 4 个，所以不写文字 */
const ICONS: Record<ActionKey, string[]> = {
  expand: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 8.5v7', 'M8.5 12h7'],
  analysis: [
    'M6 3h12',
    'M9 3v6.6L4.7 18A2 2 0 0 0 6.5 21h11a2 2 0 0 0 1.8-3L15 9.6V3',
    'M7.6 15.2h8.8'
  ],
  buy: [
    'M3 4h2l2.5 10.8A2 2 0 0 0 9.4 16h7.9a2 2 0 0 0 2-1.5L21 7.5H6',
    'M10 20.5a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Z',
    'M17.5 20.5a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Z'
  ],
  unbuy: ['M4 12.5l4.6 4.6L20 6.4'],
  copy: [
    'M9 3h6.5A2.5 2.5 0 0 1 18 5.5V15a2.5 2.5 0 0 1-2.5 2.5H9A2.5 2.5 0 0 1 6.5 15V5.5A2.5 2.5 0 0 1 9 3Z',
    'M17 8.5h1.5A2.5 2.5 0 0 1 21 11v8.5A2.5 2.5 0 0 1 18.5 22H11a2.5 2.5 0 0 1-2.5-2.5V18'
  ],
  preview: [
    'M2.2 12S6 5.6 12 5.6 21.8 12 21.8 12 18 18.4 12 18.4 2.2 12 2.2 12Z',
    'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z'
  ],
  remove: [
    'M5 7h14',
    'M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7',
    'M7.2 7l.9 12a2 2 0 0 0 2 1.9h3.8a2 2 0 0 0 2-1.9l.9-12'
  ],
  query: [
    'M5 4.5h14',
    'M12 3v4.2',
    'M9.5 8.5h5',
    'M6.8 13.5l1.9 5.8a1.5 1.5 0 0 0 1.4 1h3.8a1.5 1.5 0 0 0 1.4-1l1.9-5.8'
  ]
};

const ICON_TITLE: Record<ActionKey, string> = {
  expand: '展开：再走一步单步预测',
  analysis: '查看这一步的工艺分析',
  buy: '标记为可购买原料',
  unbuy: '取消「可购买」标记',
  copy: '复制 SMILES',
  preview: '放大预览结构',
  remove: '删除这一支',
  query: '查询价格（Molport，自动复制 SMILES）'
};

function actionsFor(card: RCard): ActionKey[] {
  const node = card.node;
  const out: ActionKey[] = [];
  if (card.kind === 'unknown' && !node.fetched && !node.duplicateOf) out.push('expand');
  if (card.kind === 'target' && node.chosenReactionId === null && !node.fetched) out.push('expand');
  if (node.chosenReactionId) out.push('analysis');
  out.push(node.purchased ? 'unbuy' : 'buy');
  // 可购买（或起始物料）才给「询价」入口 —— 中间体/目标还没走到采购这一步
  if (node.purchased || card.kind === 'starting') out.push('query');
  out.push('copy');
  out.push('preview');
  if (card.kind !== 'target') out.push('remove');
  return out;
}

function onAction(key: ActionKey, card: RCard): void {
  switch (key) {
    case 'expand':
      void store.predictNode(card.id);
      break;
    case 'analysis':
      store.analysisFocus = card.id;
      store.mainTab = 'flow';
      break;
    case 'buy':
      store.markPurchased(card.id, true);
      break;
    case 'unbuy':
      store.markPurchased(card.id, false);
      break;
    case 'copy':
      void navigator.clipboard
        .writeText(card.smiles)
        .then(() => ElMessage.success('已复制 SMILES'))
        .catch(() => ElMessage.warning('浏览器拒绝了剪贴板访问'));
      break;
    case 'preview':
      emit('preview', card.smiles);
      break;
    case 'remove':
      store.removeBranch(card.id);
      break;
    case 'query':
      openSupplier('molport', card.smiles);
      break;
  }
}

/** 卡片上那行小字：分子式 + 重原子（Reaxys 把详情放侧栏，我们放一行） */
function cardMeta(card: RCard): string {
  const bits: string[] = [];
  if (card.node.formula) bits.push(card.node.formula);
  bits.push(`${store.heavyAtoms(card.node)} 重原子`);
  return bits.join(' · ');
}

const LEGEND: Array<{ key: string; text: string }> = [
  { key: 'target', text: '目标产物：实线粗框高亮' },
  { key: 'starting', text: '可购买原料：橙色虚线框成组圈住' },
  { key: 'unknown', text: '未知化合物：橙色虚线卡 + 圈注（还没拆下去的分子）' },
  { key: 'step', text: '边上的小方块 = 第几步 + 该步概率' }
];

/**
 * plane 的几何：尺寸 = **未缩放的**画布，靠 `transform: scale` 放大到 zoom 倍；
 * 位置固定在内缩 PAN_PAD 处 —— 那圈余量就是"缩小时也能拖"的空间（见 PAN_PAD 注释）。
 * 🔴 缩放原点在左上角（样式里的 `transform-origin: 0 0`），
 *    `zoomAt` 的锚点换算正是按这个原点推的，两处必须一致。
 */
const planeStyle = computed(() => ({
  width: `${canvasW.value}px`,
  height: `${canvasH.value}px`,
  transform: `scale(${zoom.value})`,
  left: `${PAN_PAD}px`,
  top: `${PAN_PAD}px`
}));

/** 方向说明跟着「旋转方向」一起变，别写死一句话 */
const dirHint = computed(() =>
  flipped.value
    ? '左边是目标、右边是原料（逆合成方向）'
    : '左边是原料、右边是目标（合成方向）'
);
</script>

<template>
  <section class="rw-card rcanvas">
    <div class="rw-card__body rcanvas__body">
      <!-- 浮层工具条：绝对定位贴画布顶部，**不占画布高度**。
           原来「卡片头 + 计分条 + 免责声明」三块都占流（合计约 165px），
           那正是画布看起来"不够大"的主因；收成一条浮层后，画布吃满整张卡片。
           🔴 容器 `pointer-events: none` + 子元素 `auto`：工具条里的空白缝隙要**穿透**
              到画布，否则画布顶部一整条带拖不动（正是这轮要修的毛病之一）。 -->
      <div class="rcanvas__bar">
        <div class="rcanvas__score">
          <div>
            <span class="rcanvas__score-label">总步数</span>
            <b>{{ route.length }}</b>
          </div>
          <div title="各步概率连乘">
            <span class="rcanvas__score-label">总概率</span>
            <b>{{ route.length ? (totalProb * 100).toFixed(2) + '%' : '—' }}</b>
          </div>
          <div>
            <span class="rcanvas__score-label">起始物料</span>
            <b>{{ materials.length }}</b>
          </div>
        </div>

        <!-- 工具条 —— 学 Reaxys 那一排：Rotate / Fit view / Copy route / 缩放 / Legend -->
        <div class="rcanvas__tools">
          <span v-if="schemeName" class="rcanvas__scheme">方案：{{ schemeName }}</span>
          <el-button size="small" @click="rotate">
            {{ flipped ? '逆合成方向' : '合成方向' }} ⇄
          </el-button>
          <el-button size="small" @click="fitView">适应视图</el-button>
          <div class="rcanvas__zoom">
            <el-button size="small" text title="缩小" @click="zoomBy(-1)">−</el-button>
            <button type="button" class="rcanvas__zoom-val" title="点击还原 100%" @click="resetZoom">
              {{ Math.round(zoom * 100) }}%
            </button>
            <el-button size="small" text title="放大" @click="zoomBy(1)">＋</el-button>
          </div>
          <el-button size="small" :type="showLegend ? 'primary' : 'default'" plain @click="showLegend = !showLegend">
            图例
          </el-button>
          <el-button size="small" @click="copyRoute">复制路线</el-button>
          <el-dropdown trigger="click">
            <el-button size="small">导出<span class="rcanvas__caret">▾</span></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="exportJson">导出 JSON</el-dropdown-item>
                <el-dropdown-item @click="exportCsv">导出 CSV</el-dropdown-item>
                <el-dropdown-item divided @click="onPrint">打印 / 另存 PDF</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- 图例（可开关）—— 不再占一条横向空间，改成工具条下方的浮层卡片 -->
        <ul v-if="showLegend" class="rcanvas__legend">
          <li v-for="l in LEGEND" :key="l.key" class="rcanvas__legend-item">
            <span class="rcanvas__legend-swatch" :class="`is-${l.key}`" aria-hidden="true"></span>
            {{ l.text }}
          </li>
        </ul>
      </div>

      <div v-if="!hasRoute" class="rcanvas__empty">
        <p>还没有采纳任何一步，画不出路线图。</p>
        <p class="rcanvas__empty-hint">
          回到「路线树」展开一个节点并采纳候选，这里就会长出卡片与 Step 编号
        </p>
      </div>

      <!-- 画布：按住拖动平移（pan）、滚轮缩放（以指针为锚点）。
           🔴 只改 scrollLeft/Top，不引入第二套坐标 —— 滚动条、拖动、缩放共用同一个
              `sizer`（宽高 = 画布 × zoom），三者不会互相打架。 -->
      <div
        v-else
        ref="wrap"
        class="rcanvas__wrap rw-scroll"
        :class="{ 'is-panning': panning }"
        title="拖动平移 · 滚轮缩放"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <!-- 🔴 sizer 的尺寸由 syncSizer() 直接写 style（宽高 = max(画布×缩放, 容器) + 四周余量）。
             不在这里用 :style 绑 —— 两处来源会打架，而且缩放时必须**同步**写，
             紧随其后的那句 scrollLeft 才不会被旧尺寸夹住（见 syncSizer / zoomAt）。 -->
        <div ref="sizerEl" class="rcanvas__sizer">
          <div class="rcanvas__plane" :style="planeStyle">
            <!-- 连线（在卡片下层，不接鼠标事件） -->
            <svg class="rcanvas__wires" :width="canvasW" :height="canvasH" aria-hidden="true">
              <polyline
                v-for="e in edges"
                :key="e.key"
                :points="e.points"
                fill="none"
                stroke="var(--rw-border-strong)"
                stroke-width="1.6"
              />
            </svg>

            <!-- 反应 = 边上的 Step chip（每个父节点一枚） -->
            <div
              v-for="ch in chips"
              :key="ch.key"
              class="rcanvas__chip"
              :style="{ left: ch.x + 'px', top: ch.y + 'px' }"
            >
              <span class="rcanvas__chip-step">第 {{ ch.stepNo }} 步</span>
              <span class="rcanvas__chip-prob">{{ (ch.probability * 100).toFixed(1) }}%</span>
            </div>

            <!-- 状态标注（虚线框 / 虚线圈）—— 学 Reaxys 贴在图上。
                 「未知化合物」的说明文字改挂在卡片角标上（见下方 card-flag），
                 椭圆外的浮动标签只留给「可购买原料」组框 —— 那是一组卡共用一个标题，
                 而未知化合物每张卡自己带牌子，浮动标签只会挤进行间距里压到邻卡。 -->
            <div
              v-for="b in badges"
              :key="b.key"
              class="rcanvas__badge"
              :class="[`is-${b.kind}`, `is-${b.place}`]"
              :style="{ left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' }"
            >
              <span v-if="b.kind === 'starting'" class="rcanvas__badge-label">{{ b.label }}</span>
            </div>

            <!-- 化合物卡片 -->
            <article
              v-for="c in cards"
              :key="c.id"
              class="rcanvas__card"
              :class="[`is-${c.kind}`, { 'is-active': store.activeNodeId === c.id }]"
              :style="{ left: c.x + 'px', top: c.y + 'px', width: CARD_W + 'px', height: CARD_H + 'px' }"
            >
              <!-- 目标产物自己带个牌子：蓝色高亮框说明"这是重点"，牌子说明"这是目标"。
                   未知化合物 / 同分支重复同理 —— 🔴 说明文字必须长在卡片上，
                   挂在椭圆外面的浮动标签会被行间距挤没（上两轮的教训）。 -->
              <span v-if="c.kind === 'target'" class="rcanvas__card-flag">目标产物</span>
              <span v-else-if="c.kind === 'unknown'" class="rcanvas__card-flag is-anno">未知化合物</span>
              <span v-else-if="c.kind === 'dup'" class="rcanvas__card-flag is-dup">同分支重复</span>
              <div class="rcanvas__struct">
                <MolView :smiles="c.smiles" fit :title="c.smiles" />
              </div>
              <div class="rcanvas__meta" :title="cardMeta(c)">{{ cardMeta(c) }}</div>

              <!-- 卡片底部动作图标行 -->
              <div class="rcanvas__acts">
                <button
                  v-for="a in actionsFor(c)"
                  :key="a"
                  type="button"
                  class="rcanvas__act"
                  :class="{ 'is-danger': a === 'remove' }"
                  :title="ICON_TITLE[a]"
                  :aria-label="ICON_TITLE[a]"
                  @click.stop="onAction(a, c)"
                >
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      v-for="(d, i) in ICONS[a]"
                      :key="i"
                      :d="d"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </button>
              </div>
            </article>
          </div>
        </div>
      </div>

      <!-- 提示条：贴画布左下角（绝对定位 ⇒ 不占画布高度、不吃指针）。
           🔴 合规话术**没有删**，只是从"占一整行"挪到浮层 —— 顶部通知条那条同义，
              但它是可关闭的，两处都留着才不会一关就一处不剩。 -->
      <p v-if="hasRoute" class="rcanvas__hint">
        <span class="rcanvas__hint-warn">模型预测结果，实验前须经专业人员验证。</span>
        {{ dirHint }} · 拖动平移 · 滚轮缩放
      </p>
    </div>
  </section>
</template>

<style scoped>
.rcanvas {
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 🔴 高度吃满父容器（`el-tab-pane`）——「路线网络」页签下整屏只放这一块画布。
     父级那条 flex 链见 WorkspaceView 的 `.workspace.is-canvas`；
     不在该页签时这里解析成 auto，无副作用。 */
  height: 100%;
  /* 浮层工具条 / 提示条的定位祖先 */
  position: relative;
  /* 画布要顶到卡片圆角边上 ⇒ 由卡片自己裁切 */
  overflow: hidden;
}

/* 方案名 —— 挪进工具条里当第一项（原来挂在卡片标题后面） */
.rcanvas__scheme {
  font-size: 12px;
  font-weight: 600;
  color: var(--rw-brand-d);
  white-space: nowrap;
}

/* ---------- 浮层工具条 ----------
   卡片头 / 计分条 / 图例原来各占一行（合计约 165px），现在全收进这一条**贴顶浮层**，
   画布因此吃满整张卡片。
   🔴 `pointer-events: none` + 子元素 `auto`：浮层自己的空白缝隙要能**穿透**到画布，
      否则画布顶部一整条带按下去拖动没反应（这轮修的毛病之一）。 */
.rcanvas__bar {
  position: absolute;
  inset: 0 0 auto 0;
  z-index: 5;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--rw-border);
  background: color-mix(in srgb, var(--rw-surface) 88%, transparent);
  backdrop-filter: blur(6px);
  pointer-events: none;
}

.rcanvas__bar > * {
  pointer-events: auto;
}

/* ---------- 工具条 ---------- */
.rcanvas__tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.rcanvas__zoom {
  display: inline-flex;
  align-items: center;
  gap: 0;
  padding: 0 2px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.rcanvas__zoom-val {
  min-width: 44px;
  border: 0;
  background: transparent;
  color: var(--rw-text-2);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.rcanvas__caret {
  margin-left: 4px;
  font-size: 10px;
  opacity: 0.6;
}

/* ---------- 图例（挂在工具条下方的浮层卡片，不再占一条横向空间） ---------- */
.rcanvas__legend {
  position: absolute;
  top: calc(100% + 6px);
  right: 10px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 10px 12px;
  list-style: none;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  box-shadow: var(--rw-shadow-2);
  font-size: 12px;
  color: var(--rw-text-2);
}

.rcanvas__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.rcanvas__legend-swatch {
  width: 20px;
  height: 14px;
  flex: 0 0 20px;
  border-radius: 4px;
}

.rcanvas__legend-swatch.is-target {
  border: 2px solid var(--rw-brand);
  background: var(--rw-brand-l);
}

.rcanvas__legend-swatch.is-starting {
  border: 1.5px dashed var(--rw-anno);
  background: var(--rw-anno-l);
}

.rcanvas__legend-swatch.is-unknown {
  border: 1.5px dashed var(--rw-anno);
  border-radius: 50%;
}

.rcanvas__legend-swatch.is-step {
  width: 26px;
  border: 1px solid var(--rw-border-strong);
  background: var(--rw-surface-3);
}

/* ---------- 画布容器 ----------
   卡片头 / 计分条已浮层化 ⇒ 这里不再有内边距与纵向间距，画布直接吃满整张卡片。 */
.rcanvas__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
  /* 🔴 必须清掉 `.rw-card__body` 那一圈 padding（16px 上下）——
     画布要顶到卡片内缘，留一圈内边距就等于白送 32px（实测画布比卡片矮 34px）。 */
  padding: 0;
}

/* 计分（浮层里的一组，不再是独立色块 —— 它现在浮在画布上，
   再带一层边框底色会在图上看出一道"横条"） */
.rcanvas__score {
  display: flex;
  align-items: center;
  gap: 22px;
}

.rcanvas__score-label {
  display: block;
  font-size: 10.5px;
  line-height: 1.3;
  color: var(--rw-text-3);
}

.rcanvas__score b {
  font-size: 17px;
  line-height: 1.1;
  color: var(--rw-text);
  font-variant-numeric: tabular-nums;
}

/* ---------- 画布 ---------- */
.rcanvas__wrap {
  position: relative;
  /* 🔴 高度交给 flex 分配（吃掉卡片剩余空间），**不再写** `max-height: calc(100vh - 330px)`：
      那个魔法数把画布上限钉死在一个跟"上方有几块"无关的值上，
      上面每多一行（通知条 / 方案栏 / 页签）它就失准一次，窗口越小越吃亏。
      `min-height` 则是**小窗口的兜底**：空间真不够时宁可整页滚动，
      也不把画布压成一条细缝。 */
  flex: 1;
  min-height: 320px;
  overflow: auto;
  /* 淡淡的点阵底 —— 让空白区域看起来是"画布"而不是"没渲染出来" */
  background-color: var(--rw-surface);
  background-image: radial-gradient(var(--rw-border) 1px, transparent 1px);
  background-size: 22px 22px;
  /* 抓手光标 = "这块画布能拖"的可发现性（不写的话只能靠工具条那句提示） */
  cursor: grab;
}

/* 拖动中：光标变抓手、禁掉文字选中、卡片暂不接指针 ——
   否则拖过卡片时 :hover 一路闪，动作图标行跟着一亮一暗。 */
.rcanvas__wrap.is-panning {
  cursor: grabbing;
  user-select: none;
}

.rcanvas__wrap.is-panning .rcanvas__plane {
  pointer-events: none;
}

.rcanvas__sizer {
  position: relative;
}

.rcanvas__plane {
  position: absolute;
  /* 左上角由内联 `planeStyle` 给（= PAN_PAD）——
     那圈余量就是"图比容器小也拖得动"的空间，别写死回 0。 */
  transform-origin: 0 0;
}

.rcanvas__wires {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* ---------- Step chip ---------- */
.rcanvas__chip {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 3px 8px;
  transform: translate(-50%, -50%);
  border: 1px solid var(--rw-border-strong);
  border-radius: 6px;
  background: var(--rw-surface);
  box-shadow: var(--rw-shadow-1);
  white-space: nowrap;
  pointer-events: none;
}

.rcanvas__chip-step {
  font-size: 11px;
  font-weight: 600;
  color: var(--rw-text-2);
}

.rcanvas__chip-prob {
  font-size: 10px;
  color: var(--rw-text-3);
  font-variant-numeric: tabular-nums;
}

/* ---------- 状态标注 ---------- */
.rcanvas__badge {
  position: absolute;
  z-index: 1;
  border: 1.5px dashed var(--rw-anno);
  border-radius: 10px;
  background: var(--rw-anno-l);
  pointer-events: none;
}

.rcanvas__badge.is-unknown {
  border-radius: 50%;
  background: transparent;
}

.rcanvas__badge-label {
  position: absolute;
  left: 0;
  top: -17px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--rw-anno);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}

/* ---------- 化合物卡片 ---------- */
.rcanvas__card {
  position: absolute;
  z-index: 3;
  display: flex;
  flex-direction: column;
  padding: 6px;
  border: 1px solid var(--rw-border-strong);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  box-shadow: var(--rw-shadow-1);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.rcanvas__card:hover {
  border-color: var(--rw-brand-soft);
  box-shadow: var(--rw-shadow-2);
}

/* 目标产物：实线粗框 + 浅底（Reaxys 用橙色框，这里用本站品牌色，语义一致） */
.rcanvas__card.is-target {
  border: 2px solid var(--rw-brand);
  background: var(--rw-brand-l);
}

/* 未知化合物：橙色虚线框 + 浅橙底 —— Reaxys 的虚线圈语义落在卡片本体上，
   缩放 / 裁切都不会丢（外面还套一圈大虚线椭圆做远观提示） */
.rcanvas__card.is-unknown {
  border: 1.5px dashed var(--rw-anno);
  background: var(--rw-anno-l);
}

/* 同分支重复：灰色虚线 —— 它不是"未知"，是上游已有的分子（防环终止） */
.rcanvas__card.is-dup {
  border: 1.5px dashed var(--rw-border-strong);
  background: var(--rw-surface-2);
}

/* 目标产物的牌子 —— 挂在卡片上方（目标独占一列，上方不会有别的卡） */
.rcanvas__card-flag {
  position: absolute;
  left: 0;
  top: -17px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--rw-brand);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
}

/* 未知化合物的牌子：橙色（与虚线框同色系），位置同目标牌 */
.rcanvas__card-flag.is-anno {
  background: var(--rw-anno);
}

/* 同分支重复的牌子：中性灰 */
.rcanvas__card-flag.is-dup {
  background: var(--rw-text-3);
}

.rcanvas__card.is-active {
  border-color: var(--rw-brand);
  box-shadow: 0 0 0 3px var(--rw-brand-soft);
}

.rcanvas__struct {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 5px;
  cursor: zoom-in;
}

.rcanvas__meta {
  flex: 0 0 auto;
  padding: 0 1px 1px;
  font-size: 10px;
  color: var(--rw-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 卡片底部一行动作图标（Reaxys 的标志性细节） */
.rcanvas__acts {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding-top: 2px;
  border-top: 1px solid var(--rw-border);
  opacity: 0.45;
  transition: opacity 0.15s;
}

.rcanvas__card:hover .rcanvas__acts {
  opacity: 1;
}

.rcanvas__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--rw-text-2);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.rcanvas__act svg {
  width: 14px;
  height: 14px;
}

.rcanvas__act:hover {
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
}

.rcanvas__act.is-danger:hover {
  background: var(--rw-bad-l);
  color: var(--rw-bad);
}

/* ---------- 空态 / 免责 ---------- */
.rcanvas__empty {
  /* body 已无内边距 ⇒ 空态自己带一圈外边距，别贴着卡片边 */
  margin: 14px;
  padding: 30px 16px;
  border: 1px dashed var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  text-align: center;
  font-size: 13px;
  color: var(--rw-text-2);
}

.rcanvas__empty p {
  margin: 0;
}

.rcanvas__empty-hint {
  margin-top: 6px !important;
  font-size: 12px;
  color: var(--rw-text-3);
}

/* 提示条：贴画布左下角。绝对定位 ⇒ 不占画布高度；
   `pointer-events: none` ⇒ 不挡拖动（它是浮在画布上的，不能吃掉鼠标）。 */
.rcanvas__hint {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 4;
  max-width: min(72%, 620px);
  margin: 0;
  padding: 5px 10px;
  border-radius: var(--rw-radius-sm);
  background: color-mix(in srgb, var(--rw-warn-l) 94%, transparent);
  color: var(--rw-warn);
  font-size: 11.5px;
  line-height: 1.45;
  box-shadow: var(--rw-shadow-1);
  pointer-events: none;
}

.rcanvas__hint-warn {
  font-weight: 600;
}

@media (max-width: 900px) {
  /* 窄屏：计分只留数字，标签收掉，腾出宽度给工具条（浮层越高越遮画布） */
  .rcanvas__score-label {
    display: none;
  }

  .rcanvas__hint {
    max-width: 100%;
  }
}
</style>
