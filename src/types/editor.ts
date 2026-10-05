/** 结构式画板的数据模型与工具状态 */

/** 键级（对应 MDL molfile 的 bond type：1/2/3/4） */
export type BondType = 'single' | 'double' | 'triple' | 'aromatic';

/** 立体标注（molfile bond stereo：0/1/6） */
export type BondStereo = 'none' | 'up' | 'down';

export interface EditorAtom {
  /** 稳定自增 id（molfile 里的序号 = 数组下标 + 1） */
  id: number;
  /** 元素符号，首字母大写 */
  el: string;
  /** 世界坐标（键长 = BOND_LEN） */
  x: number;
  y: number;
  charge: number;
}

export interface EditorBond {
  id: number;
  /** 原子 id（不是下标） */
  a: number;
  b: number;
  type: BondType;
  stereo: BondStereo;
}

export interface EditorGraph {
  atoms: EditorAtom[];
  bonds: EditorBond[];
}

/** 鼠标工具 */
export type ToolId = 'select' | 'draw' | 'erase';

/** 一个环 / 稠环模板（坐标按半径 1 的正多边形给，插入时再缩放） */
export interface RingTemplate {
  key: string;
  label: string;
  /** 每个顶点的角度（度）与元素；缺省按正多边形取 */
  nodes: Array<{ el: string; aromatic?: boolean }>;
  /** 额外指定的边（缺省 = 相邻顶点依次相连） */
  bonds?: Array<[number, number]>;
  /** 稠环用：第二个环的顶点（共享前两个节点） */
  fused?: Array<{ el: string }>;
}

/** 常用元素（ChemDraw 快捷面板） */
export interface ElementEntry {
  el: string;
  label: string;
}
