/**
 * RDKit.js（官方 WASM 版）—— 前端结构解析与化学校验。
 *
 * 定位：把「结构解析」从后端 `/api/parse`、`/api/depict` 搬到浏览器。
 * 纯 SMILES / MOL / SDF 输入不再需要一次网络往返，粘贴即可出结构、出诊断。
 *
 * 🔴 三条硬边界（都经实测确认，别再试着重写）：
 *  1. **不支持 CDXML**。MinimalLib 的 `get_mol()` 只吃 SMILES / SMARTS / Molfile /
 *     CXSMILES / JSON / pickle；ChemDraw 直接 Ctrl+C 复制出来的 CDXML 必须回落后端
 *     （Python 版 `Chem.MolsFromCDXML()` 才行）。判断入口是 `needsBackendParse()`。
 *  2. **不提供分子式字符串**。`get_descriptors()` 只有 amw / exactmw / 各种原子计数。
 *     分子式改从 `get_inchi()` 里取 —— InChI 的 formula 层就是 Hill 记法（`C9H8O4`）。
 *  3. **molfile 的计数行必须落在第 4 行**（RDKit 按行号找它），而前三行允许为空。
 *     Ketcher/Indigo 导出的正是**空标题** molfile ⇒ 入口那次 `trim()` 会把它搞坏。
 *     所以 MOL 路径一律先过 `normalizeMolText()` 把行位摆正。见该函数注释。
 *
 * 加载策略：WASM 7.4MB，**首次用到才拉**（单例 Promise）。别在首屏 import 里 await 它，
 * 否则每个只看历史记录的用户都要白下 7MB。
 */
import initRDKitModule from '@rdkit/rdkit';
import type { MainModule, Mol } from '@rdkit/rdkit';
import wasmUrl from '@rdkit/rdkit/RDKit_minimal.wasm?url';
import type { ParseFailure, ParseResult, ParseSuggestion, ParseSuccess } from '@/types/retro';

/** CDXML 特征：ChemDraw 导出的 XML，或只给出了原子/键节点对 */
const CDXML_RE = /<CDXML|<cdxml|(?:<n\s[\s\S]{0,4000}?<b\s)/;
/** MOL/SDF 特征：V2000 / V3000 版本行 */
const MOL_RE = /V2000|V3000/;
/** 一行看起来像 SMILES 的字符集（**必须允许逗号**：`[F,Cl,Br,I]` 要能走到诊断分支） */
const SMILES_LINE_RE = /^[A-Za-z0-9@+\-[\]()=#$:/\\%.*,;]+$/;

const CANDIDATE_LIMIT = 2000;
const SUGGESTION_LIMIT = 4;

let loader: Promise<MainModule> | null = null;
let ready = false;

/** 懒加载 WASM 引擎（幂等；失败后允许重试） */
export function loadRdkit(): Promise<MainModule> {
  if (!loader) {
    loader = initRDKitModule({ locateFile: () => wasmUrl })
      .then((mod) => {
        ready = true;
        return mod;
      })
      .catch((e: unknown) => {
        // 失败要把 loader 清掉，否则后续调用会一直拿到同一个 rejected promise
        loader = null;
        ready = false;
        throw e instanceof Error ? e : new Error(String(e));
      });
  }
  return loader;
}

/**
 * WASM 引擎是否**已加载完成**（只读，不会触发加载）。
 * 用途：告诉用户"首次解析正在下载引擎"，而不是让界面看起来卡住。
 */
export function isRdkitReady(): boolean {
  return ready;
}

/**
 * 这类输入浏览器版 RDKit 读不了，必须回落后端 `/api/parse`。
 * 目前只有 CDXML 一种。
 */
export function needsBackendParse(text: string): boolean {
  return CDXML_RE.test((text || '').trim());
}

/**
 * 解析一段结构文本（SMILES / 反应式 SMILES / MOL / SDF）为规范 SMILES + 分子信息。
 * 失败时返回人话诊断 + 一键修复候选，与后端 `/api/parse` 的响应形状一致。
 */
export async function parseStructure(text: string): Promise<ParseResult> {
  const input = (text || '').trim();
  if (!input) return failWith('没有收到内容');

  let rdkit: MainModule;
  try {
    rdkit = await loadRdkit();
  } catch (e) {
    return failWith(`前端解析引擎加载失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (MOL_RE.test(input)) return fromMolText(rdkit, input);

  const candidate = cleanSmilesText(input);
  if (!candidate) return failWith('无法识别的内容格式');

  // 反应式 SMILES：保留能解析的部分，用 `.` 拼起来（与后端一致）
  if (candidate.includes('>')) {
    const good: string[] = [];
    for (const part of candidate.split('>')) {
      if (!part) continue;
      for (const one of part.split('.')) {
        const m = rdkit.get_mol(one);
        if (m) {
          good.push(one);
          m.delete();
        }
      }
    }
    if (good.length) {
      return okWith({ smiles: good.join('.'), kind: 'SMILES(反应式)', atoms: 0 });
    }
  }

  const mol = rdkit.get_mol(candidate);
  if (!mol) return diagnose(rdkit, candidate);
  try {
    if (mol.get_num_atoms() === 0) return diagnose(rdkit, candidate);

    if (hasWildcard(mol)) {
      return {
        ok: false,
        kind: 'SMILES',
        error: '结构里含通配原子 *（R 基团/连接点），逆合成预测需要完整的确定分子。',
        ...diagnostics(candidate)
      };
    }
    return okWith({
      smiles: mol.get_smiles(),
      kind: 'SMILES',
      atoms: mol.get_num_atoms(true),
      formula: formulaOf(mol),
      mw: mwOf(mol)
    });
  } finally {
    mol.delete();
  }
}

/**
 * SMILES → 带 2D 坐标的 molfile（画板载入已有结构用）。
 * 坐标由 RDKit 的 `set_new_coords()` 生成，前端不自己算布局。
 */
export async function depictMolfile(smiles: string): Promise<string | null> {
  const input = (smiles || '').trim();
  if (!input) return null;
  const rdkit = await loadRdkit();
  const mol = rdkit.get_mol(input);
  if (!mol) return null;
  try {
    if (!mol.set_new_coords()) return null;
    return mol.get_molblock();
  } finally {
    mol.delete();
  }
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 从纯文本里取第一行非空、看起来像 SMILES 的内容（移植自后端 `_clean_smiles_text`） */
function cleanSmilesText(txt: string): string {
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.length > CANDIDATE_LIMIT) return '';
    return SMILES_LINE_RE.test(line) ? line : '';
  }
  return '';
}

/** MOL / SDF：单分子直接读；多分子（`$$$$` 分段）逐块试，全部拼成 `.` 连接 */
function fromMolText(rdkit: MainModule, text: string): ParseResult {
  const first = rdkit.get_mol(normalizeMolText(text));
  if (first) {
    try {
      if (first.get_num_atoms() > 0) {
        return okWith({
          smiles: first.get_smiles(),
          kind: 'MOL/SDF',
          atoms: first.get_num_atoms(true),
          formula: formulaOf(first),
          mw: mwOf(first)
        });
      }
    } finally {
      first.delete();
    }
  }

  const parts: string[] = [];
  for (const block of text.split('$$$$')) {
    if (!block.trim()) continue;
    const m = rdkit.get_mol(normalizeMolText(block));
    if (!m) continue;
    try {
      if (m.get_num_atoms() > 0) parts.push(m.get_smiles());
    } finally {
      m.delete();
    }
  }
  if (parts.length) return okWith({ smiles: parts.join('.'), kind: 'MOL/SDF', atoms: 0 });
  return failWith('MOL/SDF 解析失败（RDKit 返回空）', 'MOL/SDF');
}

/**
 * 把 V2000 的**计数行**摆回第 4 行（index 3）。
 *
 * 🔴 这一步不能省。RDKit 是**按行号**找计数行的（第 4 行 `%3d%3d…V2000`），
 * 而 molfile 的前三行是 标题 / 程序 / 注释，**都允许为空**。
 * Ketcher（Indigo）导出的就是**空标题**：
 *   `"\n  -INDIGO-2601061200 2D\n\n 13 13  0  0 …V2000\n…"`
 * 只要对整段做一次 `trim()`（parseStructure 入口就会做），开头的空标题行被吃掉，
 * 计数行上移到 index 2 ⇒ `get_mol()` 直接返回 null，用户看到的是
 * 「MOL/SDF 解析失败（RDKit 返回空）」，完全不知道是空行的问题。
 *
 * V3000 不受影响（靠 `M  V30 COUNTS` 关键字定位），原样返回。
 */
function normalizeMolText(text: string): string {
  if (/V3000/.test(text)) return text;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /V2000/.test(l));
  if (at < 0 || at === 3) return text;
  // 计数行太靠前（头部空行被 trim 掉了）→ 补足 3 行头部
  if (at < 3) return [...new Array<string>(3 - at).fill(''), ...lines].join('\n');
  // 计数行太靠后（前面被人塞了说明文字）→ 只保留紧邻的 3 行作为头部
  return lines.slice(at - 3).join('\n');
}

/** 含原子序数 0 的原子 = 通配原子 `*`（R 基团），逆合成用不了 */
function hasWildcard(mol: Mol): boolean {
  try {
    const parsed = JSON.parse(mol.get_json()) as {
      molecules?: Array<{ atoms?: Array<{ z?: number }> }>;
    };
    const atoms = parsed.molecules?.[0]?.atoms ?? [];
    return atoms.some((a) => (a.z ?? 6) === 0);
  } catch {
    return mol.get_smiles().includes('*');
  }
}

/** InChI 的 formula 层就是 Hill 记法的分子式：`InChI=1S/C9H8O4/c1-...` */
function formulaOf(mol: Mol): string {
  try {
    return /^InChI=\d+S?\/([^/]+)/.exec(mol.get_inchi())?.[1] ?? '';
  } catch {
    return '';
  }
}

/** 平均分子量（MinimalLib 的 descriptors 里叫 amw） */
function mwOf(mol: Mol): number | null {
  try {
    const d = JSON.parse(mol.get_descriptors()) as { amw?: number };
    return typeof d.amw === 'number' ? Math.round(d.amw * 100) / 100 : null;
  } catch {
    return null;
  }
}

/** 用 RDKit 验一遍候选是否成立（决定前端候选按钮是否可点） */
function checkCandidate(rdkit: MainModule, label: string, smiles: string): ParseSuggestion {
  const mol = rdkit.get_mol(smiles);
  if (!mol) return { label, smiles, valid: false, canonical: '' };
  try {
    const valid = mol.get_num_atoms() > 0 && !hasWildcard(mol);
    return { label, smiles, valid, canonical: valid ? mol.get_smiles() : '' };
  } finally {
    mol.delete();
  }
}

/**
 * 解析失败时的人话诊断（移植自后端 `diagnose_smiles_failure`）。
 *
 * 重点是 ChemDraw 的通用取代基 `[F,Cl,Br,I]` —— 用户看到的是 RDKit 一句
 * "Explicit valence ... greater than permitted"，完全不知道错在哪。
 */
function diagnostics(smiles: string): Pick<ParseFailure, 'reasons' | 'suggestions' | 'is_markush'> {
  const reasons: string[] = [];
  let isMarkush = false;

  const combos = [...smiles.matchAll(/\[([A-Za-z]{1,2}(?:,[A-Za-z]{1,2})+)\]/g)].map((m) => m[1] ?? '');
  if (combos.length) {
    isMarkush = true;
    for (const combo of [...new Set(combos)].sort()) {
      reasons.push(
        `结构里有通用取代基「${combo}」（ChemDraw 里写成 R 基团／多选一原子标签）。` +
          'SMILES 不允许方括号里出现逗号，RDKit 会把整串当成一个原子名而报错。'
      );
    }
  }
  if (smiles.includes('*')) {
    isMarkush = true;
    reasons.push('结构里含 * 或 [*] 通配原子（通常是 R 基团或连接点）。');
  }
  if (/\[R\d*\]|R\d(?![a-z])/.test(smiles)) {
    isMarkush = true;
    reasons.push('结构里含 R1/R2 之类的可变基团标签。');
  }
  if (!reasons.length) {
    reasons.push('RDKit 无法解析这串 SMILES，语法或化学价态有问题。');
  }

  return { reasons, suggestions: [], is_markush: isMarkush };
}

/** 诊断 + 用 RDKit 逐个验证修复候选 */
function diagnose(rdkit: MainModule, smiles: string): ParseFailure {
  const base = diagnostics(smiles);
  const suggestions: ParseSuggestion[] = [];

  const first = [...smiles.matchAll(/\[([A-Za-z]{1,2}(?:,[A-Za-z]{1,2})+)\]/g)]
    .map((m) => m[1] ?? '')
    .find(Boolean);
  if (first) {
    const options = first
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, SUGGESTION_LIMIT);
    for (const opt of options) {
      suggestions.push(
        checkCandidate(rdkit, `把所有「${first}」替换为 ${opt}`, smiles.split(`[${first}]`).join(opt))
      );
    }
  }

  if (base.is_markush) {
    const stripped = smiles
      .replace(/\[[A-Za-z]{1,2}(?:,[A-Za-z]{1,2})+\]/g, '')
      .replace(/\[\*[^\]]*\]/g, '')
      .replace(/\[R\d*\]/g, '');
    suggestions.push(checkCandidate(rdkit, '删掉所有通用取代基（保留骨架）', stripped));
  }

  return {
    ok: false,
    kind: 'SMILES',
    error: 'RDKit 无法解析这串 SMILES',
    reasons: base.reasons,
    suggestions,
    is_markush: base.is_markush
  };
}

function okWith(patch: Partial<ParseSuccess> & { smiles: string; kind: string }): ParseSuccess {
  return {
    ok: true,
    smiles: patch.smiles,
    kind: patch.kind,
    atoms: patch.atoms ?? 0,
    formula: patch.formula ?? '',
    mw: patch.mw ?? null,
    error: ''
  };
}

function failWith(error: string, kind = ''): ParseFailure {
  return { ok: false, kind, error, reasons: [error] };
}
