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
  compactDrawing: true,
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
export function loadSmilesDrawer(): Promise<void> {
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

export interface DrawOptions {
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

/** 按恒定键长给 SVG 写入明确像素尺寸 */
function fitSvg(svg: SVGSVGElement, opts: Required<DrawOptions>): void {
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // 容器是定尺寸盒子 ⇒ 交回给 CSS：宽高 100% + viewBox 等比缩放，永远不会被裁。
  // 先于 viewBox 判断：拿不到 viewBox 时更要靠 CSS 兜住，不然 SVG 会塌成 0。
  if (opts.fit) {
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
 * 把一个 SMILES 画进容器（自动创建并插入 <svg>）。
 * @returns 是否真的画出了图元
 */
export async function drawSmiles(
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
