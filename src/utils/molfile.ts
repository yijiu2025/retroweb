/**
 * 画板图模型 ⇄ MDL molfile（V2000）互转。
 *
 * 为什么绕这一层：画板只负责「谁跟谁连、连成什么样」，**化学正确性交给 RDKit**。
 * 画完导出 molfile → /api/parse → canonical SMILES + 分子式 + 分子量 + 人话诊断；
 * 载入已有结构反过来：/api/depict（RDKit 生成 2D 坐标的 molfile）→ 这里解析成图。
 *
 * 格式要点（写错了 RDKit 会静默读成空分子）：
 *  - counts 行前两个字段各占 3 列，后面必须是 `  0  0  0  0  0  0  0  0999 V2000`
 *  - 原子行坐标各占 10 列，元素符号从第 31 列起占 3 列
 *  - 键行 4 个 3 列字段：a b type stereo；立体 1=楔形(up) 6=虚线(down)
 *  - 电荷走 `M  CHG`，每对 4 列，一行最多 8 对
 */
import type { BondStereo, BondType, EditorAtom, EditorBond, EditorGraph } from '@/types/editor';

/** 世界坐标里一个单键的长度（画板内部单位，与屏幕像素解耦） */
export const BOND_LEN = 40;

const BOND_CODE: Record<BondType, number> = { single: 1, double: 2, triple: 3, aromatic: 4 };
const STEREO_CODE: Record<BondStereo, number> = { none: 0, up: 1, down: 6 };

const CODE_BOND: Record<number, BondType> = { 1: 'single', 2: 'double', 3: 'triple', 4: 'aromatic' };
const CODE_STEREO: Record<number, BondStereo> = { 0: 'none', 1: 'up', 6: 'down' };

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

/** 图 → molfile。空图返回空串（调用方要自己拦） */
export function graphToMolfile(graph: EditorGraph): string {
  const lines: string[] = ['retroweb-editor', '  RetroWeb StructureEditor', ''];

  lines.push(
    `${pad(graph.atoms.length, 3)}${pad(graph.bonds.length, 3)}  0  0  0  0  0  0  0  0999 V2000`
  );

  for (const atom of graph.atoms) {
    lines.push(
      `${atom.x.toFixed(4).padStart(10)}${atom.y.toFixed(4).padStart(10)}${(0).toFixed(4).padStart(10)} ${atom.el.slice(0, 3).padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`
    );
  }

  for (const bond of graph.bonds) {
    const a = graph.atoms.findIndex((n) => n.id === bond.a) + 1;
    const b = graph.atoms.findIndex((n) => n.id === bond.b) + 1;
    if (a === 0 || b === 0) continue;
    lines.push(
      `${pad(a, 3)}${pad(b, 3)}${pad(BOND_CODE[bond.type], 3)}${pad(STEREO_CODE[bond.stereo], 3)}  0  0  0`
    );
  }

  const charged = graph.atoms.filter((n) => n.charge !== 0);
  for (let i = 0; i < charged.length; i += 8) {
    const chunk = charged.slice(i, i + 8);
    const body = chunk
      .map((atom) => {
        const idx = graph.atoms.indexOf(atom) + 1;
        return `${pad(idx, 4)}${pad(atom.charge, 4)}`;
      })
      .join('');
    lines.push(`M  CHG${pad(chunk.length, 3)}${body}`);
  }

  lines.push('M  END');
  return `${lines.join('\n')}\n`;
}

/**
 * molfile → 图。
 * 坐标按实际平均键长归一化到 BOND_LEN —— RDKit 给的键长约 1.5 Å，
 * 不归一化的话不同分子在画板上的大小会差很多。
 */
export function molfileToGraph(mol: string): EditorGraph {
  const lines = mol.split(/\r?\n/);
  if (lines.length < 4) throw new Error('molfile 内容不完整');

  const counts = lines[3] ?? '';
  const atomCount = Number.parseInt(counts.slice(0, 3), 10);
  const bondCount = Number.parseInt(counts.slice(3, 6), 10);
  if (!Number.isFinite(atomCount) || atomCount <= 0) throw new Error('molfile 没有原子');

  const atoms: EditorAtom[] = [];
  for (let i = 0; i < atomCount; i += 1) {
    const line = lines[4 + i] ?? '';
    const x = Number.parseFloat(line.slice(0, 10));
    const y = Number.parseFloat(line.slice(10, 20));
    const el = line.slice(31, 34).trim() || 'C';
    atoms.push({
      id: i + 1,
      el: el.charAt(0).toUpperCase() + el.slice(1).toLowerCase(),
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      charge: 0
    });
  }

  const bonds: EditorBond[] = [];
  for (let i = 0; i < bondCount; i += 1) {
    const line = lines[4 + atomCount + i] ?? '';
    const a = Number.parseInt(line.slice(0, 3), 10);
    const b = Number.parseInt(line.slice(3, 6), 10);
    const type = CODE_BOND[Number.parseInt(line.slice(6, 9), 10)] ?? 'single';
    const stereo = CODE_STEREO[Number.parseInt(line.slice(9, 12), 10)] ?? 'none';
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < 1) continue;
    bonds.push({ id: i + 1, a, b, type, stereo });
  }

  // 电荷行（M  CHG 可能出现在任意后续行）
  for (let i = 4 + atomCount + bondCount; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.startsWith('M  CHG')) continue;
    const n = Number.parseInt(line.slice(6, 9), 10);
    if (!Number.isFinite(n)) continue;
    for (let k = 0; k < n; k += 1) {
      const idx = Number.parseInt(line.slice(9 + k * 8, 13 + k * 8), 10);
      const charge = Number.parseInt(line.slice(13 + k * 8, 17 + k * 8), 10);
      const atom = atoms[idx - 1];
      if (atom && Number.isFinite(charge)) atom.charge = charge;
    }
  }

  return normalizeScale({ atoms, bonds });
}

/** 把坐标缩放到「平均键长 = BOND_LEN」 */
export function normalizeScale(graph: EditorGraph): EditorGraph {
  if (graph.atoms.length === 0) return graph;
  const lengths: number[] = [];
  for (const bond of graph.bonds) {
    const a = graph.atoms.find((n) => n.id === bond.a);
    const b = graph.atoms.find((n) => n.id === bond.b);
    if (a && b) lengths.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  const avg = lengths.length ? lengths.reduce((s, v) => s + v, 0) / lengths.length : 0;
  if (avg > 0.0001 && Math.abs(avg - BOND_LEN) > 0.5) {
    const k = BOND_LEN / avg;
    for (const atom of graph.atoms) {
      atom.x *= k;
      atom.y *= k;
    }
  }
  return graph;
}

/** 图的包围盒（画板「适应画布」用） */
export function graphBounds(graph: EditorGraph): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (graph.atoms.length === 0) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const atom of graph.atoms) {
    minX = Math.min(minX, atom.x);
    minY = Math.min(minY, atom.y);
    maxX = Math.max(maxX, atom.x);
    maxY = Math.max(maxY, atom.y);
  }
  const pad = BOND_LEN * 0.75;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

/** 深拷贝（撤销栈要的是快照，不是引用） */
export function cloneGraph(graph: EditorGraph): EditorGraph {
  return {
    atoms: graph.atoms.map((n) => ({ ...n })),
    bonds: graph.bonds.map((b) => ({ ...b }))
  };
}
