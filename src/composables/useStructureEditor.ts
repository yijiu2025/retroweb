/**
 * 结构式画板的编辑状态机（与视图层解耦：只管图、工具、撤销栈）。
 *
 * 两条约定：
 *  1. **所有修改都走 `mutate()`** —— 它负责压撤销快照。直接改 graph 的操作不会进撤销栈，
 *     用户 Ctrl+Z 会莫名其妙跳好几步。
 *  2. **id 只增不复用** —— 删掉的原子 id 不再发放，避免撤销/重做后键指向错位。
 */
import { computed, reactive, ref } from 'vue';
import type { BondStereo, BondType, EditorAtom, EditorBond, EditorGraph, ToolId } from '@/types/editor';
import { cloneGraph, graphBounds } from '@/utils/molfile';
import { buildRingGraph } from '@/utils/rings';

const UNDO_LIMIT = 60;

export function useStructureEditor() {
  const graph = ref<EditorGraph>({ atoms: [], bonds: [] });

  const tool = ref<ToolId>('draw');
  const bondType = ref<BondType>('single');
  const bondStereo = ref<BondStereo>('none');
  const currentElement = ref('C');
  const selectedAtomId = ref<number | null>(null);

  const view = reactive({ x: -260, y: -180, w: 520, h: 360, scale: 1 });

  let idSeq = 0;
  const past: EditorGraph[] = [];
  const future: EditorGraph[] = [];

  function nextId(): number {
    idSeq += 1;
    return idSeq;
  }

  /** 压快照后执行修改 */
  function mutate(fn: () => void): void {
    past.push(cloneGraph(graph.value));
    if (past.length > UNDO_LIMIT) past.shift();
    future.length = 0;
    fn();
  }

  const canUndo = computed(() => past.length > 0);
  const canRedo = computed(() => future.length > 0);
  const isEmpty = computed(() => graph.value.atoms.length === 0);

  function atomById(id: number): EditorAtom | undefined {
    return graph.value.atoms.find((n) => n.id === id);
  }

  /** 原子连接的键 */
  function bondsOf(id: number): EditorBond[] {
    return graph.value.bonds.filter((b) => b.a === id || b.b === id);
  }

  function degree(id: number): number {
    return bondsOf(id).length;
  }

  function findBond(a: number, b: number): EditorBond | undefined {
    return graph.value.bonds.find(
      (bond) => (bond.a === a && bond.b === b) || (bond.a === b && bond.b === a)
    );
  }

  function addAtom(el: string, x: number, y: number): number {
    const id = nextId();
    graph.value.atoms.push({ id, el, x, y, charge: 0 });
    return id;
  }

  function addBond(a: number, b: number, type: BondType, stereo: BondStereo): EditorBond | null {
    if (a === b) return null;
    const existing = findBond(a, b);
    if (existing) return null;
    const bond: EditorBond = { id: nextId(), a, b, type, stereo };
    graph.value.bonds.push(bond);
    return bond;
  }

  const api = {
    graph,
    tool,
    bondType,
    bondStereo,
    currentElement,
    selectedAtomId,
    view,
    canUndo,
    canRedo,
    isEmpty,
    atomById,
    bondsOf,
    degree,
    findBond,
    nextId,

    /** 新建原子（记录撤销） */
    createAtom(el: string, x: number, y: number): number {
      let id = 0;
      mutate(() => {
        id = addAtom(el, x, y);
      });
      return id;
    },

    /** 连线；已存在则升级键级（单→双→三，芳香键单独一类） */
    connect(a: number, b: number): void {
      mutate(() => {
        const existing = findBond(a, b);
        if (existing) {
          const ladder: BondType[] = ['single', 'double', 'triple'];
          if (bondType.value === 'aromatic') {
            existing.type = 'aromatic';
          } else {
            const idx = ladder.indexOf(existing.type);
            existing.type = ladder[Math.min(idx + 1, ladder.length - 1)] ?? 'single';
          }
          existing.stereo = bondStereo.value;
          return;
        }
        addBond(a, b, bondType.value, bondStereo.value);
      });
    },

    /**
     * 点已有的键：循环升级 单→双→三→芳香（ChemDraw 手感）。
     * ⚠️ 不要用「设成当前键工具」的语义 —— 用户点一下键却在改工具栏，反直觉。
     */
    cycleBondType(bondId: number): void {
      mutate(() => {
        const bond = graph.value.bonds.find((b) => b.id === bondId);
        if (!bond) return;
        const ladder: BondType[] = ['single', 'double', 'triple', 'aromatic'];
        const idx = ladder.indexOf(bond.type);
        bond.type = ladder[(idx + 1) % ladder.length]!;
        // 立体标注只挂在单键上，升成多重键后必须清掉，否则 molfile 里是非法的
        if (bond.type !== 'single') bond.stereo = 'none';
      });
    },

    moveAtom(id: number, x: number, y: number): void {
      const atom = atomById(id);
      if (!atom) return;
      atom.x = x;
      atom.y = y;
    },

    setElement(id: number, el: string): void {
      mutate(() => {
        const atom = atomById(id);
        if (atom) atom.el = el;
      });
    },

    addCharge(id: number, delta: number): void {
      mutate(() => {
        const atom = atomById(id);
        if (!atom) return;
        const next = atom.charge + delta;
        atom.charge = Math.max(-3, Math.min(3, next));
      });
    },

    deleteAtom(id: number): void {
      mutate(() => {
        graph.value.atoms = graph.value.atoms.filter((n) => n.id !== id);
        graph.value.bonds = graph.value.bonds.filter((b) => b.a !== id && b.b !== id);
      });
      if (selectedAtomId.value === id) selectedAtomId.value = null;
    },

    deleteBond(id: number): void {
      mutate(() => {
        graph.value.bonds = graph.value.bonds.filter((b) => b.id !== id);
      });
    },

    insertRing(key: string, center: { x: number; y: number }): void {
      mutate(() => {
        const ring = buildRingGraph(key, center, nextId);
        if (!ring) return;
        graph.value.atoms.push(...ring.atoms);
        graph.value.bonds.push(...ring.bonds);
      });
    },

    /** 整体载入（解析 SMILES 结果 / 复位），不进撤销栈但会清栈 */
    replace(next: EditorGraph): void {
      graph.value = cloneGraph(next);
      const maxId = Math.max(
        0,
        ...next.atoms.map((n) => n.id),
        ...next.bonds.map((b) => b.id)
      );
      idSeq = maxId;
      past.length = 0;
      future.length = 0;
      selectedAtomId.value = null;
    },

    /** 手动压一次快照：连续拖动（移动原子/平移）只在开始处压一次，否则撤销要按几十下 */
    snapshot(): void {
      past.push(cloneGraph(graph.value));
      if (past.length > UNDO_LIMIT) past.shift();
      future.length = 0;
    },

    clear(): void {
      mutate(() => {
        graph.value = { atoms: [], bonds: [] };
      });
    },

    undo(): void {
      const prev = past.pop();
      if (!prev) return;
      future.push(cloneGraph(graph.value));
      graph.value = prev;
      selectedAtomId.value = null;
    },

    redo(): void {
      const next = future.pop();
      if (!next) return;
      past.push(cloneGraph(graph.value));
      graph.value = next;
      selectedAtomId.value = null;
    },

    /** 把图缩放平移到刚好铺满视口 */
    fit(width = 520, height = 360): void {
      const b = graphBounds(graph.value);
      const w = Math.max(b.maxX - b.minX, 80);
      const h = Math.max(b.maxY - b.minY, 80);
      const scale = Math.min(width / w, height / h, 2.4);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      view.w = width / scale;
      view.h = height / scale;
      view.x = cx - view.w / 2;
      view.y = cy - view.h / 2;
      view.scale = scale;
    },

    zoom(factor: number, anchor?: { x: number; y: number }): void {
      const nextScale = Math.max(0.35, Math.min(3.2, view.scale * factor));
      const k = nextScale / view.scale;
      const ax = anchor?.x ?? view.x + view.w / 2;
      const ay = anchor?.y ?? view.y + view.h / 2;
      view.x = ax - (ax - view.x) / k;
      view.y = ay - (ay - view.y) / k;
      view.w /= k;
      view.h /= k;
      view.scale = nextScale;
    },

    pan(dx: number, dy: number): void {
      view.x -= dx;
      view.y -= dy;
    }
  };

  return api;
}

export type StructureEditor = ReturnType<typeof useStructureEditor>;
