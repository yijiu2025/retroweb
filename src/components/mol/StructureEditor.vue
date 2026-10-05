<script setup lang="ts">
/**
 * 结构式画板（ChemDraw 风格，自绘 SVG）。
 *
 * 分工：**画板只管拓扑与坐标，化学正确性交给 RDKit**。
 *   - 出图：`getMolfile()` → 父组件丢给 /api/parse → canonical SMILES + 分子式 + 人话诊断
 *   - 入图：`loadFromMolfile()` ← /api/depict（RDKit 生成 2D 坐标）
 * 所以这里不需要 kekulize / 芳香性判定 / 化合价校验 —— 画错了由后端诊断告诉用户。
 *
 * 三个不做会翻车的细节：
 *  1. 线宽用 `vector-effect: non-scaling-stroke`，但**字号/命中半径要除以 scale**，
 *     否则一缩放文字就跟着变形、点击判定也偏。
 *  2. 连续拖动（移动原子 / 平移）只在 pointerdown 压一次快照，走 mutate 会污染撤销栈。
 *  3. 屏幕→世界坐标必须自己按 `xMidYMid meet` 的居中偏移换算，拿 rect 直接比例算会偏。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useStructureEditor } from '@/composables/useStructureEditor';
import { BOND_LEN, graphToMolfile, molfileToGraph } from '@/utils/molfile';
import { ELEMENT_GROUPS, RING_PRESETS, WILDCARD_ELEMENTS } from '@/utils/rings';
import type { BondStereo, BondType, EditorBond, ToolId } from '@/types/editor';

const ed = useStructureEditor();

const hostRef = ref<HTMLDivElement | null>(null);
const svgRef = ref<SVGSVGElement | null>(null);
const hoverAtomId = ref<number | null>(null);

const viewBox = computed(() => `${ed.view.x} ${ed.view.y} ${ed.view.w} ${ed.view.h}`);
const fs = computed(() => 15 / ed.view.scale);
const hitR = computed(() => 16 / ed.view.scale);

const TOOLS: Array<{ id: ToolId; label: string; hint: string }> = [
  { id: 'draw', label: '画笔', hint: '拖拽成键 · 点击空白放原子' },
  { id: 'select', label: '选择', hint: '拖动原子 · 拖空白平移' },
  { id: 'erase', label: '橡皮', hint: '点原子/键即删除' }
];

const BOND_TOOLS: Array<{ type: BondType; stereo: BondStereo; label: string }> = [
  { type: 'single', stereo: 'none', label: '单键' },
  { type: 'double', stereo: 'none', label: '双键' },
  { type: 'triple', stereo: 'none', label: '三键' },
  { type: 'aromatic', stereo: 'none', label: '芳香键' },
  { type: 'single', stereo: 'up', label: '楔形' },
  { type: 'single', stereo: 'down', label: '虚线' }
];

const ELEMENT_COLOR: Record<string, string> = {
  O: '#dc2626',
  N: '#2563eb',
  S: '#b45309',
  P: '#ea580c',
  F: '#16a34a',
  Cl: '#16a34a',
  Br: '#9a3412',
  I: '#7c3aed',
  H: '#64748b',
  B: '#db2777',
  Si: '#0891b2',
  Se: '#65a30d'
};

function elementColor(el: string): string {
  return ELEMENT_COLOR[el] ?? 'var(--rw-text)';
}

/** 碳不写字母（ChemDraw 骨架式惯例），但带电荷 / 孤立 / 非碳要写 */
function atomLabel(atom: { id: number; el: string; charge: number }): string {
  if (atom.el === 'C' && atom.charge === 0 && ed.degree(atom.id) > 0) return '';
  return atom.el;
}

function chargeText(charge: number): string {
  if (!charge) return '';
  const sign = charge > 0 ? '+' : '−';
  const n = Math.abs(charge);
  return n > 1 ? `${n}${sign}` : sign;
}

// ---------- 键的几何 ----------

interface BondPaint {
  id: number;
  strokes: Array<{ x1: number; y1: number; x2: number; y2: number; dash?: string }>;
  wedge?: string;
  hash?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
}

const GAP = 3.6;
const WEDGE_W = 4.6;

function paintBond(bond: EditorBond): BondPaint | null {
  const a = ed.atomById(bond.a);
  const b = ed.atomById(bond.b);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const { x1, y1, x2, y2 } = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const paint: BondPaint = { id: bond.id, strokes: [] };

  if (bond.type === 'single') {
    if (bond.stereo === 'up') {
      paint.wedge = `${x1},${y1} ${x2 + nx * WEDGE_W},${y2 + ny * WEDGE_W} ${x2 - nx * WEDGE_W},${y2 - ny * WEDGE_W}`;
      return paint;
    }
    if (bond.stereo === 'down') {
      const segs: BondPaint['hash'] = [];
      for (let i = 1; i <= 7; i += 1) {
        const t = i / 7;
        const px = x1 + dx * t;
        const py = y1 + dy * t;
        const w = WEDGE_W * t;
        segs.push({ x1: px + nx * w, y1: py + ny * w, x2: px - nx * w, y2: py - ny * w });
      }
      paint.hash = segs;
      return paint;
    }
    paint.strokes.push({ x1, y1, x2, y2 });
    return paint;
  }

  if (bond.type === 'double' || bond.type === 'triple') {
    const offsets = bond.type === 'double' ? [-GAP, GAP] : [-GAP, 0, GAP];
    for (const o of offsets) {
      paint.strokes.push({ x1: x1 + nx * o, y1: y1 + ny * o, x2: x2 + nx * o, y2: y2 + ny * o });
    }
    return paint;
  }

  // 芳香键：实线 + 内侧虚线。内侧方向 = 键中点指向「共同邻居」（环里的另一个原子）
  paint.strokes.push({ x1, y1, x2, y2 });
  const nbA = ed.bondsOf(bond.a).map((x) => (x.a === bond.a ? x.b : x.a));
  const nbB = ed.bondsOf(bond.b).map((x) => (x.a === bond.b ? x.b : x.a));
  const common = nbA.find((id) => nbB.includes(id));
  let ox = nx;
  let oy = ny;
  if (common !== undefined) {
    const c = ed.atomById(common);
    if (c) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const d = Math.hypot(c.x - mx, c.y - my) || 1;
      ox = (c.x - mx) / d;
      oy = (c.y - my) / d;
    }
  }
  const g = GAP * 1.05;
  paint.strokes.push({
    x1: x1 + ox * g,
    y1: y1 + oy * g,
    x2: x2 + ox * g,
    y2: y2 + oy * g,
    dash: `${(4 / ed.view.scale).toFixed(2)} ${(3 / ed.view.scale).toFixed(2)}`
  });
  return paint;
}

const painted = computed(() =>
  ed.graph.value.bonds.map((bond) => paintBond(bond)).filter((x): x is BondPaint => x !== null)
);

const paintedAtoms = computed(() =>
  ed.graph.value.atoms.map((atom) => ({
    id: atom.id,
    x: atom.x,
    y: atom.y,
    charge: atom.charge,
    label: atomLabel(atom),
    color: elementColor(atom.el),
    chargeText: chargeText(atom.charge)
  }))
);

// ---------- 坐标换算 ----------

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const svg = svgRef.value;
  if (!svg) return { x: 0, y: 0 };
  const rect = svg.getBoundingClientRect();
  const s = Math.min(rect.width / ed.view.w, rect.height / ed.view.h) || 1;
  const offX = (rect.width - ed.view.w * s) / 2;
  const offY = (rect.height - ed.view.h * s) / 2;
  return {
    x: ed.view.x + (clientX - rect.left - offX) / s,
    y: ed.view.y + (clientY - rect.top - offY) / s
  };
}

function atomAt(x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = hitR.value;
  for (const atom of ed.graph.value.atoms) {
    const d = Math.hypot(atom.x - x, atom.y - y);
    if (d < bestD) {
      bestD = d;
      best = atom.id;
    }
  }
  return best;
}

function bondAt(x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = 9 / ed.view.scale;
  for (const bond of ed.graph.value.bonds) {
    const a = ed.atomById(bond.a);
    const b = ed.atomById(bond.b);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
    if (d < bestD) {
      bestD = d;
      best = bond.id;
    }
  }
  return best;
}

// ---------- 指针交互 ----------

type Drag =
  | null
  | { kind: 'bond'; from: number; created: boolean; startX: number; startY: number }
  | { kind: 'move'; id: number; dx: number; dy: number }
  | { kind: 'pan'; startX: number; startY: number; vx: number; vy: number };

const drag = ref<Drag>(null);
const preview = ref<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

function onPointerDown(event: PointerEvent): void {
  const w = toWorld(event.clientX, event.clientY);
  const hitAtom = atomAt(w.x, w.y);
  const hitBond = hitAtom === null ? bondAt(w.x, w.y) : null;
  (event.target as Element).setPointerCapture?.(event.pointerId);

  if (ed.tool.value === 'erase') {
    if (hitAtom !== null) ed.deleteAtom(hitAtom);
    else if (hitBond !== null) ed.deleteBond(hitBond);
    return;
  }

  if (ed.tool.value === 'select') {
    if (hitAtom !== null) {
      ed.selectedAtomId.value = hitAtom;
      const atom = ed.atomById(hitAtom);
      ed.snapshot();
      drag.value = { kind: 'move', id: hitAtom, dx: atom ? w.x - atom.x : 0, dy: atom ? w.y - atom.y : 0 };
      return;
    }
    ed.selectedAtomId.value = null;
    drag.value = { kind: 'pan', startX: w.x, startY: w.y, vx: ed.view.x, vy: ed.view.y };
    return;
  }

  // draw：点在键上 = 循环升级键级，不能当成「点空白放原子」
  if (hitAtom !== null) {
    drag.value = { kind: 'bond', from: hitAtom, created: false, startX: w.x, startY: w.y };
    preview.value = { x1: ed.atomById(hitAtom)?.x ?? w.x, y1: ed.atomById(hitAtom)?.y ?? w.y, x2: w.x, y2: w.y };
    return;
  }
  if (hitBond !== null) {
    ed.cycleBondType(hitBond);
    return;
  }
  const id = ed.createAtom(ed.currentElement.value, w.x, w.y);
  drag.value = { kind: 'bond', from: id, created: true, startX: w.x, startY: w.y };
  preview.value = { x1: w.x, y1: w.y, x2: w.x, y2: w.y };
}

function onPointerMove(event: PointerEvent): void {
  const w = toWorld(event.clientX, event.clientY);
  hoverAtomId.value = atomAt(w.x, w.y);
  const d = drag.value;
  if (!d) return;

  if (d.kind === 'move') {
    ed.moveAtom(d.id, w.x - d.dx, w.y - d.dy);
    return;
  }
  if (d.kind === 'pan') {
    ed.view.x = d.vx - (w.x - d.startX);
    ed.view.y = d.vy - (w.y - d.startY);
    return;
  }
  preview.value = {
    x1: ed.atomById(d.from)?.x ?? w.x,
    y1: ed.atomById(d.from)?.y ?? w.y,
    x2: w.x,
    y2: w.y
  };
}

function onPointerUp(event: PointerEvent): void {
  const d = drag.value;
  drag.value = null;
  preview.value = null;
  if (!d) return;

  if (d.kind !== 'bond') return;
  const w = toWorld(event.clientX, event.clientY);
  const from = ed.atomById(d.from);
  if (!from) return;

  // 原地点击：只放一个原子（甲烷式起点），不成键
  if (d.created && Math.hypot(w.x - d.startX, w.y - d.startY) < BOND_LEN * 0.35) {
    ed.selectedAtomId.value = d.from;
    return;
  }

  const target = atomAt(w.x, w.y);
  if (target !== null && target !== d.from) {
    ed.connect(d.from, target);
    ed.selectedAtomId.value = target;
    return;
  }
  // 拖到空白：按当前键长方向补一个原子并连线
  const dx = w.x - from.x;
  const dy = w.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = from.x + (dx / len) * BOND_LEN;
  const ny = from.y + (dy / len) * BOND_LEN;
  const id = ed.createAtom(ed.currentElement.value, nx, ny);
  ed.connect(d.from, id);
  ed.selectedAtomId.value = id;
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const w = toWorld(event.clientX, event.clientY);
  ed.zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, w);
}

// ---------- 操作 ----------

function pickElement(el: string): void {
  ed.currentElement.value = el;
  const sel = ed.selectedAtomId.value;
  if (sel !== null) ed.setElement(sel, el);
}

function pickBondTool(type: BondType, stereo: BondStereo): void {
  ed.bondType.value = type;
  ed.bondStereo.value = stereo;
  if (ed.tool.value !== 'draw') ed.tool.value = 'draw';
}

function insertRing(key: string): void {
  const atoms = ed.graph.value.atoms;
  let center: { x: number; y: number };
  if (atoms.length === 0) {
    const svg = svgRef.value;
    const rect = svg?.getBoundingClientRect();
    center = rect
      ? toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : { x: 0, y: 0 };
  } else {
    // 有内容就摆在现有结构右侧，别叠在一起
    const maxX = Math.max(...atoms.map((a) => a.x));
    const minY = Math.min(...atoms.map((a) => a.y));
    const maxY = Math.max(...atoms.map((a) => a.y));
    center = { x: maxX + BOND_LEN * 1.6, y: (minY + maxY) / 2 };
  }
  ed.insertRing(key, center);
  ed.fit(hostRef.value?.clientWidth ?? 520, hostRef.value?.clientHeight ?? 360);
}

function fitView(): void {
  ed.fit(hostRef.value?.clientWidth ?? 520, hostRef.value?.clientHeight ?? 360);
}

function onKey(event: KeyboardEvent): void {
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) ed.redo();
    else ed.undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    ed.redo();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const sel = ed.selectedAtomId.value;
    if (sel !== null) {
      event.preventDefault();
      ed.deleteAtom(sel);
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.setTimeout(fitView, 30);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
});

defineExpose({
  /** 出图：交给后端 RDKit 判真伪 */
  getMolfile(): string {
    return graphToMolfile(ed.graph.value);
  },
  /** 入图：后端 RDKit 给的带 2D 坐标的 molfile */
  loadFromMolfile(mol: string): void {
    ed.replace(molfileToGraph(mol));
    fitView();
  },
  isEmpty(): boolean {
    return ed.graph.value.atoms.length === 0;
  },
  clear(): void {
    ed.clear();
  },
  fit: fitView
});
</script>

<template>
  <div class="sed">
    <!-- 顶部：工具 + 键型 -->
    <div class="sed__bar">
      <div class="sed__group">
        <el-button
          v-for="t in TOOLS"
          :key="t.id"
          size="small"
          :type="ed.tool.value === t.id ? 'primary' : 'default'"
          @click="ed.tool.value = t.id"
        >
          {{ t.label }}
        </el-button>
      </div>
      <el-divider direction="vertical" />
      <div class="sed__group">
        <el-button
          v-for="b in BOND_TOOLS"
          :key="b.label"
          size="small"
          :type="ed.bondType.value === b.type && ed.bondStereo.value === b.stereo ? 'primary' : 'default'"
          plain
          @click="pickBondTool(b.type, b.stereo)"
        >
          {{ b.label }}
        </el-button>
      </div>
      <div class="sed__spacer" />
      <div class="sed__group">
        <el-button size="small" :disabled="!ed.canUndo.value" @click="ed.undo()">撤销</el-button>
        <el-button size="small" :disabled="!ed.canRedo.value" @click="ed.redo()">重做</el-button>
        <el-button size="small" plain @click="fitView">适应</el-button>
        <el-button size="small" plain @click="ed.clear()">清空</el-button>
      </div>
    </div>

    <div class="sed__body">
      <!-- 左：元素面板 -->
      <aside class="sed__panel">
        <div v-for="g in ELEMENT_GROUPS" :key="g.label" class="sed__pgroup">
          <div class="sed__pgroup-title">{{ g.label }}</div>
          <div class="sed__grid">
            <button
              v-for="el in g.items"
              :key="el"
              type="button"
              class="sed__el"
              :class="{ 'is-active': ed.currentElement.value === el }"
              :style="{ color: elementColor(el) }"
              @click="pickElement(el)"
            >
              {{ el }}
            </button>
          </div>
        </div>
        <div class="sed__pgroup">
          <div class="sed__pgroup-title">通配</div>
          <div class="sed__grid">
            <button
              v-for="el in WILDCARD_ELEMENTS"
              :key="el"
              type="button"
              class="sed__el"
              :class="{ 'is-active': ed.currentElement.value === el }"
              @click="pickElement(el)"
            >
              {{ el }}
            </button>
          </div>
        </div>
        <div class="sed__pgroup">
          <div class="sed__pgroup-title">电荷</div>
          <div class="sed__grid">
            <button
              type="button"
              class="sed__el sed__el--wide"
              :disabled="ed.selectedAtomId.value === null"
              @click="ed.selectedAtomId.value !== null && ed.addCharge(ed.selectedAtomId.value, 1)"
            >
              +1
            </button>
            <button
              type="button"
              class="sed__el sed__el--wide"
              :disabled="ed.selectedAtomId.value === null"
              @click="ed.selectedAtomId.value !== null && ed.addCharge(ed.selectedAtomId.value, -1)"
            >
              −1
            </button>
          </div>
        </div>
      </aside>

      <!-- 中：画布 -->
      <div ref="hostRef" class="sed__canvas">
        <svg
          ref="svgRef"
          class="sed__svg"
          :viewBox="viewBox"
          preserveAspectRatio="xMidYMid meet"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @wheel="onWheel"
        >
          <g class="sed__bonds">
            <template v-for="p in painted" :key="p.id">
              <line
                v-for="(s, i) in p.strokes"
                :key="`${p.id}-${i}`"
                :x1="s.x1"
                :y1="s.y1"
                :x2="s.x2"
                :y2="s.y2"
                :stroke-dasharray="s.dash"
                class="sed__bond"
                vector-effect="non-scaling-stroke"
              />
              <polygon v-if="p.wedge" :points="p.wedge" class="sed__wedge" />
              <line
                v-for="(s, i) in p.hash || []"
                :key="`h-${p.id}-${i}`"
                :x1="s.x1"
                :y1="s.y1"
                :x2="s.x2"
                :y2="s.y2"
                class="sed__bond"
                vector-effect="non-scaling-stroke"
              />
            </template>
          </g>

          <line
            v-if="preview"
            :x1="preview.x1"
            :y1="preview.y1"
            :x2="preview.x2"
            :y2="preview.y2"
            class="sed__preview"
            vector-effect="non-scaling-stroke"
          />

          <g class="sed__atoms">
            <template v-for="a in paintedAtoms" :key="a.id">
              <circle
                v-if="a.id === ed.selectedAtomId.value || a.id === hoverAtomId"
                :cx="a.x"
                :cy="a.y"
                :r="hitR"
                class="sed__halo"
                :class="{ 'is-sel': a.id === ed.selectedAtomId.value }"
              />
              <text
                :x="a.x"
                :y="a.y"
                :font-size="fs"
                :fill="a.color"
                class="sed__label"
                text-anchor="middle"
                dominant-baseline="central"
              >
                {{ a.label }}<tspan v-if="a.charge" :font-size="fs * 0.72" dy="-0.28em">{{ a.chargeText }}</tspan>
              </text>
            </template>
          </g>
        </svg>

        <div v-if="ed.isEmpty.value" class="sed__empty">
          <div class="sed__empty-title">在此绘制目标分子</div>
          <div class="sed__empty-tip">
            点击空白处放一个碳原子 · 从原子往外拖即成键 · 再点成键可升级为双键／三键<br />
            右侧模板可直接插入苯环等常见骨架
          </div>
        </div>
        <div class="sed__hint">{{ TOOLS.find((t) => t.id === ed.tool.value)?.hint }}</div>
      </div>
    </div>

    <!-- 底部：环模板 -->
    <div class="sed__foot">
      <span class="sed__foot-label">模板</span>
      <el-button
        v-for="r in RING_PRESETS"
        :key="r.key"
        size="small"
        plain
        @click="insertRing(r.key)"
      >
        {{ r.label }}
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.sed {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sed__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.sed__group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sed__spacer {
  flex: 1;
}

.sed__body {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 10px;
}

.sed__panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  overflow-y: auto;
}

.sed__pgroup-title {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--rw-text-3);
}

.sed__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.sed__el {
  padding: 5px 0;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface);
  color: var(--rw-text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.sed__el:hover {
  border-color: var(--rw-brand);
  transform: translateY(-1px);
}

.sed__el.is-active {
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
}

.sed__el:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sed__el--wide {
  grid-column: span 1;
}

/* 高度随视口伸缩：固定 420 在矮屏上会把 dialog 顶出视口，底部按钮看不见 */
.sed__canvas {
  position: relative;
  height: clamp(280px, 46vh, 460px);
  min-height: 240px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background-color: var(--rw-surface);
  background-image: radial-gradient(var(--rw-border) 1px, transparent 1px);
  background-size: 22px 22px;
  overflow: hidden;
}

.sed__svg {
  width: 100%;
  height: 100%;
  touch-action: none;
  user-select: none;
  cursor: crosshair;
}

.sed__bond {
  stroke: var(--rw-text);
  stroke-width: 1.7;
  stroke-linecap: round;
  fill: none;
}

.sed__wedge {
  fill: var(--rw-text);
  stroke: none;
}

.sed__preview {
  stroke: var(--rw-brand);
  stroke-width: 1.6;
  stroke-dasharray: 5 4;
}

.sed__halo {
  fill: var(--rw-text-3);
  opacity: 0.14;
}

.sed__halo.is-sel {
  fill: var(--rw-brand);
  opacity: 0.22;
}

.sed__label {
  font-family: var(--rw-font-mono);
  font-weight: 600;
  paint-order: stroke;
  stroke: var(--rw-surface);
  stroke-width: 3.2;
  stroke-linejoin: round;
  pointer-events: none;
}

.sed__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-align: center;
  pointer-events: none;
}

.sed__empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--rw-text-2);
}

.sed__empty-tip {
  font-size: 12px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.sed__hint {
  position: absolute;
  left: 10px;
  bottom: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--rw-surface-2);
  border: 1px solid var(--rw-border);
  font-size: 11px;
  color: var(--rw-text-3);
  pointer-events: none;
}

.sed__foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.sed__foot-label {
  margin-right: 2px;
  font-size: 12px;
  color: var(--rw-text-3);
}
</style>
