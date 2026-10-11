/**
 * CAS 号查询（PubChem PUG REST）—— 「结构 → CAS」的唯一来源。
 *
 * 为什么是 PubChem：免费、不需要 key、**开放 CORS**（实测响应头
 * `Access-Control-Allow-Origin: *`），而且按**结构**精确检索 ⇒ 同一个分子的
 * 不同 SMILES 写法都能落到同一个 CID。
 *
 * 🔴 四条实测事实（2026-10-07，别再踩）：
 *  1. **必须用 POST 表单，不要把 SMILES 拼进 URL 路径。**
 *     含立体化学的 `C/C=C/C` 走路径会被 PubChem 直接拒：
 *     `400 PUGREST.BadRequest — Unable to standardize the given structure`
 *     （`/` 先被 URL 路径吃掉再解码，结构就烂了）。
 *     POST + `application/x-www-form-urlencoded` 正常（实测 CID 62695 / CAS 624-64-6）。
 *     附带好处：form-urlencoded 属 CORS **简单请求** ⇒ 不触发预检。
 *  2. **404 = 「PubChem 没收录这个结构」**（响应体 `PUGREST.NotFound`），不是错误。
 *     要记成「查过、确实没有」，否则每次渲染都白查一遍。
 *  3. CAS 号**混在 synonyms 里**（aspirin 的第 3 条才是 `50-78-2`）⇒
 *     必须按标准形态正则从同义词列表里挑，不能取第一条。
 *  4. 限流 5 req/s ⇒ 全局**串行队列 + 最小间隔**，并按 SMILES 去重
 *     （同一个分子常同时出现在「产物 / 前体 / 起始物料」三处）。
 *
 * 语义上这是**尽力而为**的外部增强：查不到、超时、断网只让 CAS 那一小块不显示，
 * 绝不影响结构式与整张表。注意区分两种「没有」：
 *   · `null`      = 查过了，PubChem 确实没有（不重查）
 *   · `undefined` = 还没查到（查询中 / 网络失败，以后可以再查）
 */
import { ref } from 'vue';
import type { PubChemSynonymsResponse } from '@/types/external';

/** PUG REST：POST SMILES 表单 → 同义词列表（CAS 混在里面） */
const ENDPOINT = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/synonyms/JSON';

/** 持久化缓存键（CAS 是稳定数据：查一次能一直用） */
const CACHE_KEY = 'rw-cas-v1';
/** 单次请求超时 */
const TIMEOUT_MS = 12000;
/** 两次请求的最小间隔（PubChem 限流 5 req/s，这里留一倍余量） */
const MIN_GAP_MS = 260;
/** 落盘最多保留多少条（防 localStorage 无限膨胀） */
const MAX_PERSIST = 400;

/** CAS 登记号的标准形态：2~7 位-2 位-1 位（校验位） */
const CAS_RE = /^\d{2,7}-\d{2}-\d$/;

interface CasInfo {
  /** CAS 登记号，如 `50-78-2` */
  cas: string;
  /** PubChem CID（点进详情页用） */
  cid: number;
  /** PubChem 首条非 CAS 同义词（通常是英文名），可能没有 */
  name?: string;
}

/** `undefined` = 还没查到；`null` = 查过、确实没有 */
type CasState = CasInfo | null | undefined;

/** 查到 CAS 的结果（响应式 + 落盘） */
const known = ref<Record<string, CasInfo>>(loadPersisted());
/** 查过但没有 CAS 的（只在内存：PubChem 日后补录了还能再查） */
const absent = ref<Record<string, true>>({});

const queue: string[] = [];
/**
 * 「已入队 **或** 正在查」的分子。
 * 🔴 只在**查完**（fetch 返回并写回缓存）时才移除 —— 见 `drain()` 里的注释：
 *    出队就删会让 `await` 期间的重复调用再入队一次（实测真踩到）。
 */
const pending = new Set<string>();
let draining = false;

/**
 * 读查询结果（模板里直接用）。
 * 读 `known` / `absent` 即建立响应式依赖 ⇒ 查完自动重渲染。
 */
function casState(smiles: string): CasState {
  if (!smiles) return undefined;
  const hit = known.value[smiles];
  if (hit) return hit;
  if (absent.value[smiles]) return null;
  return undefined;
}

/** PubChem 上按结构检索的页面 —— 「在哪里可以查 CAS」的直接答案 */
function pubchemUrl(smiles: string): string {
  return `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(smiles)}`;
}

/** PubChem 化合物详情页（点 CAS 号就去这里） */
function cidUrl(cid: number): string {
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
}

/**
 * 排队查一个 SMILES（幂等：已查过 / 已在队列里的直接返回）。
 * 组件对自己的 SMILES 各调一次即可，去重全交给这里。
 */
function requestCas(smiles: string): void {
  if (!smiles || casState(smiles) !== undefined || pending.has(smiles)) return;
  pending.add(smiles);
  queue.push(smiles);
  if (!draining) void drain();
}

/** 批量排队 */
function requestCasMany(list: readonly string[]): void {
  for (const s of list) requestCas(s);
}

async function drain(): Promise<void> {
  draining = true;
  try {
    while (queue.length) {
      const smiles = queue.shift() as string;
      const info = await fetchCas(smiles);
      // 网络失败（undefined）不写缓存 —— 下次还有机会
      if (info !== undefined) write(smiles, info);
      // 🔴 移出 `pending` 必须在**等完之后**：出队时就删的话，
      //    `await` 期间同一分子再次 requestCas 会因为「缓存里还没有 + 不在 pending」
      //    而**重复入队**。实测真踩到：目标分子被查了两遍 —— 一次来自 TargetOverview
      //    自己的 watch，一次来自它的 MolChip，两者不在同一个 tick。
      pending.delete(smiles);
      if (queue.length) await sleep(MIN_GAP_MS);
    }
  } finally {
    draining = false;
  }
}

function write(smiles: string, info: CasInfo | null): void {
  if (info) {
    known.value = { ...known.value, [smiles]: info };
    persist();
  } else {
    absent.value = { ...absent.value, [smiles]: true };
  }
}

/**
 * 查一个结构。三种结果：
 *   CasInfo   → 命中
 *   null      → PubChem 没收录（404）
 *   undefined → 网络 / 超时 / 其它服务端错误（**不缓存**，见文件头注释）
 */
async function fetchCas(smiles: string): Promise<CasInfo | null | undefined> {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ smiles }).toString(),
      signal: ac.signal
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    return pickCas((await res.json()) as PubChemSynonymsResponse);
  } catch {
    return undefined;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 从同义词列表里挑 CAS（见文件头第 3 条） */
function pickCas(data: PubChemSynonymsResponse): CasInfo | null {
  const first = data?.InformationList?.Information?.[0];
  if (!first) return null;
  const list = Array.isArray(first.Synonym) ? first.Synonym : [];
  const cas = list.find((s) => CAS_RE.test(String(s).trim()));
  if (!cas) return null;
  const name = list.find((s) => !CAS_RE.test(String(s).trim()));
  return {
    cas: String(cas).trim(),
    cid: Number(first.CID) || 0,
    ...(name ? { name: String(name).trim() } : {})
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadPersisted(): Record<string, CasInfo> {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, CasInfo> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const info = value as Partial<CasInfo> | null;
      if (info && typeof info.cas === 'string' && CAS_RE.test(info.cas)) {
        out[key] = {
          cas: info.cas,
          cid: Number(info.cid) || 0,
          ...(typeof info.name === 'string' ? { name: info.name } : {})
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

export { casState, pubchemUrl, cidUrl, requestCas, requestCasMany };

export type { CasInfo, CasState };
