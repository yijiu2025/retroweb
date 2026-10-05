/**
 * 常用环 / 稠环模板 + 元素面板数据。
 *
 * 顶点按正多边形算：半径 r = BOND_LEN / (2·sin(π/n))，起始角 -90°（顶点朝上）。
 * 稠环（萘）用两个六边形共享一条边：第二环中心沿 x 平移 √3·r，
 * 它的第 3、4 号顶点正好落回第一环的第 2、1 号顶点上 —— 共享边自动去重。
 */
import { BOND_LEN } from './molfile';
import type { EditorBond, EditorGraph } from '@/types/editor';

export interface RingPreset {
  key: string;
  label: string;
  build(): { nodes: Array<{ x: number; y: number; el: string }>; bonds: Array<[number, number]>; aromatic: boolean };
}

function polygon(n: number, cx: number, cy: number): Array<{ x: number; y: number }> {
  const r = BOND_LEN / (2 * Math.sin(Math.PI / n));
  return Array.from({ length: n }, (_, i) => {
    const t = ((-90 + (i * 360) / n) * Math.PI) / 180;
    return { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
  });
}

function ringOf(n: number, el = 'C', aromatic = false): RingPreset['build'] {
  return () => {
    const points = polygon(n, 0, 0);
    const bonds: Array<[number, number]> = points.map((_, i) => [i, (i + 1) % n]);
    return { nodes: points.map((p) => ({ ...p, el })), bonds, aromatic };
  };
}

/** 环里某一个原子换成别的元素（吡啶 / 呋喃） */
function hetero(n: number, index: number, el: string, aromatic = true): RingPreset['build'] {
  return () => {
    const base = ringOf(n, 'C', aromatic)();
    base.nodes[index] = { ...base.nodes[index]!, el };
    return base;
  };
}

function naphthalene(): ReturnType<RingPreset['build']> {
  const r = BOND_LEN / (2 * Math.sin(Math.PI / 6));
  const c1 = polygon(6, 0, 0);
  const c2 = polygon(6, Math.sqrt(3) * r, 0);
  // c2 的第 3、4 号顶点 = c1 的第 2、1 号顶点
  const map2 = [6, 7, 8, 2, 1, 9];
  const nodes = [
    ...c1.map((p) => ({ ...p, el: 'C' })),
    { ...c2[0]!, el: 'C' },
    { ...c2[1]!, el: 'C' },
    { ...c2[2]!, el: 'C' },
    { ...c2[5]!, el: 'C' }
  ];
  const seen = new Set<string>();
  const bonds: Array<[number, number]> = [];
  const push = (a: number, b: number): void => {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (seen.has(key)) return;
    seen.add(key);
    bonds.push([a, b]);
  };
  for (let k = 0; k < 6; k += 1) push(k, (k + 1) % 6);
  for (let k = 0; k < 6; k += 1) push(map2[k]!, map2[(k + 1) % 6]!);
  return { nodes, bonds, aromatic: true };
}

export const RING_PRESETS: Array<{ key: string; label: string; build: RingPreset['build'] }> = [
  { key: 'benzene', label: '苯环', build: ringOf(6, 'C', true) },
  { key: 'cyclohexane', label: '环己烷', build: ringOf(6) },
  { key: 'cyclopentane', label: '环戊烷', build: ringOf(5) },
  { key: 'cyclobutane', label: '环丁烷', build: ringOf(4) },
  { key: 'cyclopropane', label: '环丙烷', build: ringOf(3) },
  { key: 'pyridine', label: '吡啶', build: hetero(6, 0, 'N') },
  { key: 'furan', label: '呋喃', build: hetero(5, 0, 'O') },
  { key: 'naphthalene', label: '萘', build: naphthalene }
];

/** 把模板插到画板（带自增 id，中心平移到指定位置） */
export function buildRingGraph(
  key: string,
  center: { x: number; y: number },
  nextId: () => number
): EditorGraph | null {
  const preset = RING_PRESETS.find((p) => p.key === key);
  if (!preset) return null;
  const built = preset.build();
  const atoms = built.nodes.map((n) => ({
    id: nextId(),
    el: n.el,
    x: n.x + center.x,
    y: n.y + center.y,
    charge: 0
  }));
  const bonds: EditorBond[] = built.bonds.map(([a, b]) => ({
    id: nextId(),
    a: atoms[a]!.id,
    b: atoms[b]!.id,
    type: built.aromatic ? 'aromatic' : 'single',
    stereo: 'none'
  }));
  return { atoms, bonds };
}

/** 元素面板：常用元素（ChemDraw 快捷键那几个排最前） */
export const ELEMENT_GROUPS: Array<{ label: string; items: string[] }> = [
  { label: '常用', items: ['C', 'H', 'O', 'N', 'S', 'P'] },
  { label: '卤素', items: ['F', 'Cl', 'Br', 'I'] },
  { label: '金属', items: ['Na', 'K', 'Li', 'Mg', 'Ca', 'Zn', 'Fe', 'Cu', 'Al'] },
  { label: '其他', items: ['B', 'Si', 'Se', 'As', 'Sn', 'Ti', 'Pt', 'Pd', 'Ni', 'Mn', 'Ag', 'Hg'] }
];

/**
 * 通配原子（`*`）：RDKit 会当 dummy atom，用来表示「任意取代基」。
 * ⚠️ 只放 `*` 不放 `R` —— R 在 molfile 里不是合法元素符号，解析必失败。
 */
export const WILDCARD_ELEMENTS = ['*'];
