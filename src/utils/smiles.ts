/** SMILES 轻量工具（无需 RDKit，纯前端可用） */

/** 有机子集原子（两字符优先匹配） */
const TWO_CHAR = ['Cl', 'Br'];
const ONE_CHAR = new Set(['B', 'C', 'N', 'O', 'P', 'S', 'F', 'I', 'b', 'c', 'n', 'o', 'p', 's']);
const BOND_CHARS = new Set(['-', '=', '#', '$', '/', '\\', ':', '.', '(', ')', '+', '%']);

function isHydrogenToken(token: string): boolean {
  // [H] / [H+] / [H2] 之类不算重原子；[nH] [NH+] 要算
  return /^H(?![a-z])/.test(token);
}

/**
 * 估算重原子数（不含显式氢）。
 *
 * 仅用于「是否可当作起始物料」的阈值判定与展示 —— 精确值以 /api/parse 返回的
 * `atoms` 为准（根节点用解析结果，子节点用本估算）。
 */
function countHeavyAtoms(smiles: string): number {
  const s = smiles.trim();
  let i = 0;
  let n = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end === -1) break;
      const token = s.slice(i + 1, end);
      if (token && !isHydrogenToken(token)) n += 1;
      i = end + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      n += 1;
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(ch)) {
      n += 1;
      i += 1;
      continue;
    }
    if (ch === '*' || ch === 'R') {
      n += 1;
      i += 1;
      continue;
    }
    if (BOND_CHARS.has(ch) || (ch >= '0' && ch <= '9')) {
      i += 1;
      continue;
    }
    // 未知字符（如 a/g/e 等元素符号小写开头）保守计数
    if (/[A-Za-z]/.test(ch)) n += 1;
    i += 1;
  }
  return n;
}

let seq = 0;
/** 本地唯一 id（节点 / 反应） */
function uid(prefix = 'n'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** 读文本文件（.mol/.sdf/.cdxml/.txt）内容 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

/** 概率分级配色 key */
function levelOf(p: number): 'high' | 'mid' | 'low' {
  if (p > 0.5) return 'high';
  if (p > 0.1) return 'mid';
  return 'low';
}

export { countHeavyAtoms, uid, readFileAsText, levelOf };
