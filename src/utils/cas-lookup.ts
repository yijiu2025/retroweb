/**
 * CAS 号 → 结构（PubChem PUG REST）—— **前端直连版**。
 *
 * ⚠️ **当前没有调用方**（2026-10-20 起）。原因：CAS / 名称查询统一改走
 *    后端 `/api/substance` 了（见 components/workspace/TargetInput.vue），
 *    因为要同时支持 ChemIndex —— 而它**没有 CORS 头、还有 JS 反爬挑战**
 *    （要把响应里的 `_0x2` 写进 `HW_CHECK` cookie 再重发），
 *    浏览器侧根本打不通。PubChem 本来能直连，但为了两个源**统一入口**也一起走了后端。
 *
 * **为什么还留着**：它是「纯前端、不依赖后端」的可行实现。以下场景可能用得上：
 *   · 后端 API 没起来，只想先试试查结构
 *   · 将来做纯静态部署（没有服务端）
 * 要启用它，把 `requestLookup` / `lookupState` 重新接回 TargetInput 即可，
 * 函数签名与语义都没变（三态：`CasLookup` / `null` / `undefined`）。
 *
 * ========================== 以下为原始说明 ==========================
 *
 * 这是 `utils/pubchem.ts` 的**反向**：
 *   · pubchem.ts   结构 → CAS（给 CasTag 显示用）
 *   · cas-lookup.ts CAS → 结构（给输入框用：用户只记得 CAS 号）
 *
 * 🔴 为什么也走 PubChem：免费、不需要 key、**开放 CORS**
 *   （实测响应头 `Access-Control-Allow-Origin: *`），且按 CAS 号查是
 *   **精确检索**（不是模糊匹配）⇒ 同一个 CAS 号永远落到同一个 CID。
 *
 * ## 与「结构 → CAS」不同的三条实测事实（2026-10-20）
 *
 *  1. **CAS 号可以安全地放进 URL 路径。**
 *     「结构 → CAS」必须用 POST 表单（因为 SMILES 里的 `/` 会被路径吃掉），
 *     但 CAS 号本身只有数字和连字符 ⇒ 直接 `GET /compound/name/50-78-2/...` 即可，
 *     走 GET 还有个附带好处：**不触发 CORS 预检**。
 *
 *  2. **返回的是 Kekulé 形式**，不是芳香小写形式：
 *     `50-78-2` 返回 `CC(=O)OC1=CC=CC=C1C(=O)O`（大写 C + 显式双键），
 *     而 canonical 形式是 `CC(=O)Oc1ccccc1C(=O)O`。
 *     ⇒ **必须交给 RDKit 规范化**再往下走，否则链路上会出现两种写法，
 *     缓存键、比对、结构图全都对不上。
 *
 *  3. **404 = PubChem 没收录这个 CAS 号**（响应体 `PUGREST.NotFound`
 *     / `Fault.Message: "No CID found"`），不是错误。
 *     与「结构 → CAS」同理：要记成「查过、确实没有」，否则每次输入都重查一遍。
 *
 * ## 语义：尽力而为
 * 查不到 / 超时 / 断网只让这一步失败，**绝不影响结构式与整张表**。
 * 与 pubchem.ts 一样严格区分两种「没有」：
 *   · `null`      = 查过了，PubChem 确实没收录（不重查）
 *   · `undefined` = 还没查到（查询中 / 网络失败，以后可以再查）
 *
 * @author yijiu2025
 * @since 2026-10-20
 */
import { ref } from 'vue';
import { CAS_RE } from '@/utils/cas-regex';
import type { PubChemPropertyResponse } from '@/types/external';

/** PUG REST：GET /compound/name/<CAS>/property/... */
const ENDPOINT = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name';

/** 持久化缓存键（CAS → 结构 是稳定数据：查一次能一直用） */
const CACHE_KEY = 'rw-cas-lookup-v1';
/** 单次请求超时 */
const TIMEOUT_MS = 12000;
/** 两次请求的最小间隔（PubChem 限流 5 req/s，这里留一倍余量） */
const MIN_GAP_MS = 260;
/** 落盘最多保留多少条（防 localStorage 无限膨胀） */
const MAX_PERSIST = 200;

/** 查到的结构信息 */
interface CasLookup {
  /** 标准 CAS 号 */
  cas: string;
  /** PubChem 返回的 SMILES（**Kekulé 形式**，需 RDKit 规范化） */
  smiles: string;
  /** PubChem CID（用于跳转详情页核对） */
  cid: number;
  /** IUPAC 名（PubChem 给的英文名），可能没有 */
  name?: string;
  /** 分子式，如 `C9H8O4` */
  formula?: string;
}

/** `undefined` = 还没查到；`null` = 查过、PubChem 确实没有 */
type LookupState = CasLookup | null | undefined;

/** 查到的结果（响应式 + 落盘） */
const known = ref<Record<string, CasLookup>>(loadPersisted());
/** 查过但没收录的（只在内存：PubChem 日后补录了还能再查） */
const absent = ref<Record<string, true>>({});

const queue: string[] = [];
/** 「已入队 **或** 正在查」的 CAS 号 */
const pending = new Set<string>();
let draining = false;

/**
 * 读查询结果（模板里直接用）。
 *
 * @param cas 目标 CAS 号（标准写法）
 * @returns 三态：已查到返回 `CasLookup`；查过但 PubChem 未收录返回 `null`；
 *          **没查过/查不到返回 `undefined`**。🔴 三态必须区分 ——
 *          「未收录」要提示用户，「还没查」不能提示（否则界面一打开就说查不到）
 */
function lookupState(cas: string): LookupState {
  if (!cas) return undefined;
  const hit = known.value[cas];
  if (hit) return hit;
  if (absent.value[cas]) return null;
  return undefined;
}

/**
 * PubChem 化合物详情页（点 CAS 号就去这里核对）
 * @param cid PubChem 化合物 ID（CID）
 * @returns 该化合物的 PubChem 详情页 URL
 */
function cidUrl(cid: number): string {
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
}

/**
 * 排队查一个 CAS 号（幂等：已查过 / 已在队列里的直接返回）。
 *
 * @param cas 要查的 CAS 号（标准写法）
 * @returns 无（void）；**幂等且立即返回** —— 实际请求由内部队列串行执行
 */
function requestLookup(cas: string): void {
  if (!cas || lookupState(cas) !== undefined || pending.has(cas)) return;
  pending.add(cas);
  queue.push(cas);
  if (!draining) void drain();
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.length) {
      const cas = queue.shift() as string;
      const info = await fetchByCas(cas);
      // 网络失败（undefined）不写缓存 —— 下次还有机会
      if (info !== undefined) write(cas, info);
      // 🔴 移出 `pending` 必须在**等完之后**：出队时就删的话，
      //    `await` 期间同一 CAS 号再次 requestLookup 会重复入队。
      pending.delete(cas);
      if (queue.length) await sleep(MIN_GAP_MS);
    }
  } finally {
    draining = false;
  }
}

function write(cas: string, info: CasLookup | null): void {
  if (info) {
    known.value = { ...known.value, [cas]: info };
    persist();
  } else {
    absent.value = { ...absent.value, [cas]: true };
  }
}

/**
 * 查一个 CAS 号。三种结果：
 *   CasLookup  → 命中
 *   null       → PubChem 没收录（404）
 *   undefined  → 网络 / 超时 / 其它服务端错误（**不缓存**）
 */
async function fetchByCas(cas: string): Promise<CasLookup | null | undefined> {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const url = `${ENDPOINT}/${encodeURIComponent(cas)}/property/CanonicalSMILES,IsomericSMILES,MolecularFormula,IUPACName/JSON`;
    const res = await fetch(url, { signal: ac.signal });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const data = (await res.json()) as PubChemPropertyResponse;
    const p = data?.PropertyTable?.Properties?.[0];
    if (!p) return null;
    // 🔴 PubChem 2023 起用 `ConnectivitySMILES`（无立体）+
    //    `SMILES`（含立体）两个字段；老版本只有 SMILES。
    const smiles = String(p.SMILES || p.ConnectivitySMILES || '').trim();
    if (!smiles) return null;
    return {
      cas,
      smiles,
      cid: Number(p.CID) || 0,
      ...(p.IUPACName ? { name: String(p.IUPACName).trim() } : {}),
      ...(p.MolecularFormula ? { formula: String(p.MolecularFormula).trim() } : {})
    };
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadPersisted(): Record<string, CasLookup> {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, CasLookup> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const info = value as Partial<CasLookup> | null;
      if (info && typeof info.smiles === 'string' && info.smiles && CAS_RE.test(key)) {
        out[key] = {
          cas: key,
          smiles: info.smiles,
          cid: Number(info.cid) || 0,
          ...(typeof info.name === 'string' ? { name: info.name } : {}),
          ...(typeof info.formula === 'string' ? { formula: info.formula } : {})
        };
      }
    }
    return out;
  } catch {
    // 隐私模式 / 坏数据：当作没有缓存，不影响查询本身
    return {};
  }
}

let saveTimer = 0;

/** 防抖落盘（写失败无所谓：缓存丢了只是下次重查一遍） */
function persist(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      const entries = Object.entries(known.value).slice(-MAX_PERSIST);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      /* 隐私模式 / 配额满：忽略 */
    }
  }, 400);
}

export { lookupState, cidUrl, requestLookup };

export type { CasLookup, LookupState };
