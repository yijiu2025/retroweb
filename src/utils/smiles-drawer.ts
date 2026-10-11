/**
 * smiles-drawer 封装（纯前端 SMILES → SVG，无后端依赖）。
 *
 * 三段必须照搬的经验（来自 retrochimera 的实测注释，别再踩）：
 *  1. 构造函数只接收配置对象，**不要传 DOM 容器**；
 *     `draw(smiles, target, theme, okCb, errCb, weights)` 的 target 要传真实的
 *     `<svg>` 元素对象（传 div 元素或 div 的 id 选择器都会静默不画）。
 *  2. 库会**忽略**传入的 width/height，只把 viewBox 设成紧贴分子的正方形；
 *     SVG 没有 width/height 属性时会被 flex 压成 20 多像素 ⇒ 画完必须按
 *     「恒定键长」写回明确像素尺寸（fitSvg）。
 *  3. 个别版本 successCallback 不触发 ⇒ 统一加兜底。
 */
import type { SmiDrawerLike } from '@/types/external';

const SCRIPT_SRC = '/smiles-drawer.min.js';

const DRAWER_OPTS: Record<string, unknown> = {
  bondThickness: 1.15,
  bondLength: 24,
  shortBondLength: 0.86,
  bondSpacing: 24 * 0.18,
  atomVisualization: 'default',
  terminalCarbons: false,
  explicitHydrogens: false,
  /**
   * 🔴 必须 false（原为 true，是「乙酸画不出来」的病根）。
   *
   * compactDrawing 走的是「紧凑布局」分支，对 `CC(=O)O` 这类分子会算出**退化坐标**
   * —— 所有原子落在同一个点上：实测 `CC(=O)O` 生成的 SVG 里 `<defs>` 是空的、一根键都没有，
   * 4 个原子标签被塞进同一个 `<text>`（渲染出来就是一团「COOHCH₃」）。
   * 关掉之后：乙酸 0→4 根键、阿司匹林 12→15、水杨酸 8→11 —— 是全面变好，不是取舍。
   *
   * 定位过程：用页面里已加载的 SmilesDrawer 逐项隔离选项（.tmp-probe/probe-opts.cjs），
   * 只有这一项能改变结果；bondLength / padding / shortBondLength / explicitHydrogens
   * 全都无关。
   */
  compactDrawing: false,
  padding: 8,
  fontSizeLarge: 11,
  fontSizeSmall: 8,
  overlapSensitivity: 0.42,
  isomeric: true
};

/** viewBox 里一个单键 = 多少用户单位（与 bondLength 保持一致） */
const BOND_UNIT = 24;

let loader: Promise<void> | null = null;

/** 按需加载 smiles-drawer 脚本（幂等） */
function loadSmilesDrawer(): Promise<void> {
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('非浏览器环境'));
      return;
    }
    if (window.SmilesDrawer) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loader = null;
      reject(new Error('smiles-drawer 脚本加载失败'));
    };
    document.head.appendChild(script);
  });
  return loader;
}

interface DrawOptions {
  /** 单键屏幕像素长度（分子统一才协调） */
  bondPx?: number;
  minPx?: number;
  maxPx?: number;
  theme?: 'light' | 'dark';
  /**
   * 让 SVG **填满容器**（宽高 100%，靠 viewBox 等比缩放）。
   *
   * ⚠️ 只在容器有确定尺寸时开（如 `.step-row__mol` 96×62）。
   *    容器是 auto 高度时开这个会让 SVG 塌成 0 —— 那种场景用 maxPx 限尺寸即可。
   *
   * 为什么需要它：fitSvg 只按「恒定键长」算像素尺寸，不知道容器多大，
   *    容器又是 overflow:hidden ⇒ 分子一大就被裁掉（显示不全）。
   */
  fit?: boolean;
}

/** 读出库设置的 viewBox（紧贴分子的包围盒） */
function getViewBox(svg: SVGSVGElement): DOMRect | null {
  try {
    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) {
      return { width: vb.width, height: vb.height } as DOMRect;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 把 viewBox 收紧到**真实内容**上（只在 fit 模式用）。
 *
 * 🔴 为什么必须做：smiles-drawer 给的 viewBox 是「紧贴分子的**正方形**」。
 *    容器是 152×76 这类**扁**的定尺寸盒子时，`preserveAspectRatio="xMidYMid meet"`
 *    按较短边对齐 ⇒ 一个 3:1 的分子只画出 76px 宽，看着像缩在卡片角落里
 *    （路线图第一版就是这个症状：目标卡的结构只占中间一小块）。
 *    收紧成内容包围盒后宽高比对上了，分子才真正铺满卡片。
 *
 * ⚠️ **只改 fit 分支**：非 fit 分支要按「恒定键长」算像素尺寸，
 *    那个换算就是基于库给的正方形 viewBox（`maxPx / longer`），改了会连带
 *    改变路线树 / 流程图里所有缩略图的大小。
 */
function tightenViewBox(svg: SVGSVGElement): void {
  try {
    const box = svg.getBBox();
    if (box.width > 0 && box.height > 0) {
      svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
    }
  } catch {
    /* 量不到就保持库给的 viewBox，别让整张图挂掉 */
  }
}

/** 按恒定键长给 SVG 写入明确像素尺寸 */
function fitSvg(svg: SVGSVGElement, opts: Required<DrawOptions>): void {
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // 容器是定尺寸盒子 ⇒ 交回给 CSS：宽高 100% + viewBox 等比缩放，永远不会被裁。
  // 先于 viewBox 判断：拿不到 viewBox 时更要靠 CSS 兜住，不然 SVG 会塌成 0。
  if (opts.fit) {
    tightenViewBox(svg);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.maxWidth = '100%';
    svg.style.maxHeight = '100%';
    svg.style.flex = '1 1 auto';
    return;
  }

  const vb = getViewBox(svg);
  if (!vb) return;

  let scale = opts.bondPx / BOND_UNIT;
  const longer = Math.max(vb.width, vb.height);
  if (longer * scale > opts.maxPx) scale = opts.maxPx / longer;
  if (longer * scale < opts.minPx) scale = opts.minPx / longer;

  const w = Math.round(vb.width * scale);
  const h = Math.round(vb.height * scale);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
  svg.style.maxWidth = 'none';
  svg.style.flex = 'none';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}
/**
 * 🔴 修 smiles-drawer 的 mask 裁剪缺陷（「甲醇/碘甲烷画出来没有键」的病根）。
 *
 * 库把所有键放进 `<g mask="url(#…-text-mask)">`，用来把键的两端压在原子标签下面。
 * 但 `<mask>` 没写 x/y/width/height ⇒ 走默认 `maskUnits="objectBoundingBox"`，
 * 裁剪区域 = **被引用元素的 bbox 外扩 10%**。
 *
 * 于是：**只有一根键、而且这根键是水平的时候，bbox 高度恰好是 0**
 *      ⇒ 裁剪区域高度 0 ⇒ 整组被裁掉 ⇒ 键看不见。
 * 实测 `CO`（甲醇）、`CI`（碘甲烷）就是这样：DOM 里明明有 `<line>`，
 * 屏幕上只剩「HO    CH₃」两个孤立标签（链状分子如 `CCO` 因为 bbox 有高度而正常）。
 *
 * 修法：把 mask 改成 `userSpaceOnUse`，并显式给它「mask 自身内容 ∪ 键组 bbox」的范围，
 * 宽高各留 1 单位兜底 —— 裁剪语义不变（圆圈照样盖住标签附近的键端），退化情况不再塌成 0。
 */
function fixMaskRegions(svg: SVGSVGElement): void {
  const doc = svg.ownerDocument;
  svg.querySelectorAll<SVGGElement>('g[mask]').forEach((group) => {
    const ref = group.getAttribute('mask') || '';
    const id = /#([^)'"\s]+)/.exec(ref)?.[1];
    const mask = id ? (doc.getElementById(id) as SVGMaskElement | null) : null;
    if (!mask) return;

    const xs: number[] = [];
    const ys: number[] = [];
    const xe: number[] = [];
    const ye: number[] = [];

    try {
      const gb = group.getBBox();
      // bbox 完全退化成一点时也收进来：靠下面的最小宽高兜底
      xs.push(gb.x);
      ys.push(gb.y);
      xe.push(gb.x + gb.width);
      ye.push(gb.y + gb.height);
    } catch {
      /* 空组：忽略 */
    }

    const rect = mask.querySelector('rect');
    if (rect) {
      const rx = Number(rect.getAttribute('x')) || 0;
      const ry = Number(rect.getAttribute('y')) || 0;
      const rw = Number(rect.getAttribute('width')) || 0;
      const rh = Number(rect.getAttribute('height')) || 0;
      xs.push(rx);
      ys.push(ry);
      xe.push(rx + rw);
      ye.push(ry + rh);
    }
    if (!xs.length) return;

    const pad = 1;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('x', x.toFixed(2));
    mask.setAttribute('y', y.toFixed(2));
    mask.setAttribute('width', Math.max(Math.max(...xe) + pad - x, 1).toFixed(2));
    mask.setAttribute('height', Math.max(Math.max(...ye) + pad - y, 1).toFixed(2));
  });
}

/**
 * 把一个 SMILES 画进容器（自动创建并插入 <svg>）。
 * @returns 是否真的画出了图元
 */
async function drawSmiles(
  container: HTMLElement,
  smiles: string,
  options: DrawOptions = {}
): Promise<boolean> {
  await loadSmilesDrawer();
  const factory = window.SmilesDrawer?.SmiDrawer;
  if (!factory) return false;

  const opts: Required<DrawOptions> = {
    bondPx: options.bondPx ?? 34,
    minPx: options.minPx ?? 96,
    maxPx: options.maxPx ?? 430,
    theme: options.theme ?? 'light',
    fit: options.fit ?? false
  };

  container.replaceChildren();
  if (!smiles) return false;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.appendChild(svg);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      // 先修 mask 裁剪区域，再算尺寸（顺序无关，但修完再量尺寸更符合「所见」）
      try {
        fixMaskRegions(svg);
      } catch {
        /* 修不动也不该让整张图挂掉 */
      }
      fitSvg(svg, opts);
      resolve(ok);
    };

    let drawer: SmiDrawerLike;
    try {
      drawer = new factory({ ...DRAWER_OPTS });
    } catch {
      finish(false);
      return;
    }

    try {
      drawer.draw(
        smiles,
        svg,
        opts.theme,
        () => finish(true),
        () => finish(false),
        null
      );
    } catch {
      finish(false);
      return;
    }

    // 兜底：个别版本回调不触发
    window.setTimeout(() => {
      if (settled) return;
      const drawn = svg.querySelectorAll('path,line,text,ellipse').length > 0;
      finish(drawn);
    }, 4000);
  });
}

export { loadSmilesDrawer, drawSmiles };

export type { DrawOptions };
