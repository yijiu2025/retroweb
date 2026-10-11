/**
 * 化合物采购源（供应商 / 比价平台）+ 「这次拿什么标识去查」的唯一来源。
 *
 * 三件事都收在这里：
 *   ① 供应商清单 —— 谁能查、它**认哪种标识**；
 *   ② `resolveSupplierQuery()` —— 给定分子 + 用户偏好，算出这次用的标识与最终 URL；
 *   ③ `querySupplier()` —— 真正执行（复制标识 + 新标签页打开）。
 *
 * 🔴 为什么要有 ② 这层解析，而不是各组件自己拼 URL：
 *    「用 CAS 还是 SMILES」不是随便挑的，而是**平台的索引方式**决定的 ——
 *    · 试剂商（Sigma / TCI / 麦克林 / 毕得）目录按 **CAS 号 / 货号 / 名称** 建索引：
 *      把 CAS 拼进搜索 URL 能直接出结果；换成 SMILES 则**必然搜不到**
 *      （它们不做结构式检索，SMILES 在里面只是一串没人认识的字符）。
 *    · 结构式/列表检索平台（Molport / eMolecules / LabNetwork / 阿拉丁）正好相反：
 *      入口是绘图板或 SMILES 列表，CAS 只能当普通关键词。
 *    ⇒「一律用 CAS 更准」这种话**不能全局写死**，必须逐家声明 `prefers`。
 *    同一个原因也让「用哪个标识」有了第二种来源：用户关掉「优先用 CAS」时，
 *    只有 `prefers:'cas'` 的那几家会跟着换 —— 结构式平台本来就不吃 CAS，没得换。
 *
 * 🔴 一律「跳查询页 + 自动复制标识到剪贴板」：
 *    没有哪家支持「结构式拼 URL 直接出结果」的稳定参数（2026-10-06 实测：
 *    Molport / eMolecules / LabNetwork 硬拼 SMILES 一律 404）。
 *    所以即使 URL 已经带上了标识，仍然同步复制进剪贴板 —— 用户到站能直接粘，
 *    也不怕对方哪天把参数名改掉。`acceptsQuery:false` 的那几家（纯前端 SPA /
 *    绘图板入口）URL 带不了词，跳固定查询页，标识只走剪贴板。
 *
 * 🔴 一律新标签页打开（noopener,noreferrer），不打断当前路线分析。
 */
import { copyText } from '@/utils/clipboard';
import { casState } from '@/utils/pubchem';

/** 平台搜索框最认的标识 */
type SupplierIdent = 'cas' | 'smiles';

interface Supplier {
  /** 唯一 id */
  id: string;
  /** 显示名 */
  name: string;
  /** 国别/定位短标签 */
  tag: string;
  /** 该平台搜索**最认**哪种标识（见文件头注释） */
  prefers: SupplierIdent;
  /** URL 能不能真的带上查询词（实测；false = 纯前端路由 / 绘图板，带不了） */
  acceptsQuery: boolean;
  /** 生成查询 URL。`q` = 按 `prefers` 选出的标识；`acceptsQuery:false` 时忽略它 */
  url: (q: string) => string;
}

/**
 * 一次查询的完整解析结果。
 * 把它作为**返回值**（而不是只返回一个 URL）是为了让 UI 能如实告诉用户
 * 「这次用的是 CAS 50-78-2 还是 SMILES」「为什么」，也让验收能断言回落路径。
 */
interface SupplierQuery {
  supplier: Supplier;
  /** 本次实际采用的标识 */
  ident: SupplierIdent;
  /** 真正写进 URL / 剪贴板的原文 */
  value: string;
  /** 给用户看的短标签，如 `CAS 50-78-2` / `SMILES` */
  label: string;
  url: string;
  /**
   * 为什么落到这个标识上：
   *   `cas`            —— 用户开启优先 CAS，且 PubChem 已查到 CAS
   *   `cas-missing`    —— 开启优先 CAS，但这个结构还没查到 CAS（回落 SMILES）
   *   `cas-off`        —— 用户关掉了「优先用 CAS」
   *   `smiles-native`  —— 平台本来就认 SMILES（结构式/列表检索），CAS 帮不上忙
   */
  reason: 'cas' | 'cas-missing' | 'cas-off' | 'smiles-native';
}

/** 标识的 URL 编码 */
const enc = encodeURIComponent;

const SUPPLIERS: Supplier[] = [
  // ---------- 结构式 / 列表检索平台：认 SMILES，CAS 只是关键词 ----------
  {
    id: 'molport',
    name: 'Molport',
    tag: '全球比价',
    prefers: 'smiles',
    // Molport 官网搜索是 JS 表单驱动，没有稳定的「结构 → URL 出结果」参数
    // （曾误用 chemical-search-results?structure=… 返回 404）。改跳它的
    // List Search 工具页 —— 那个页面**就是**一个粘 SMILES 列表的输入框，
    // 所以复制 SMILES 过去是它唯一正确的用法（换成 CAS 反而没人认）。
    acceptsQuery: false,
    url: () => 'https://www.molport.com/shop/swl-step-1'
  },
  {
    id: 'emolecules',
    name: 'eMolecules',
    tag: '全球比价',
    prefers: 'smiles',
    // 官网搜索是绘图板/表单驱动，无稳定结构 GET 参数（?q=&r= 均 404），
    // 且完整结构搜索需登录。跳首页 + 自动复制 SMILES，用户粘进结构搜索框。
    acceptsQuery: false,
    url: () => 'https://www.emolecules.com/'
  },
  {
    id: 'labnetwork',
    name: 'LabNetwork',
    tag: '比价聚合',
    prefers: 'smiles',
    // 药明康德旗下，域名已迁到 labnetwork.com.cn（SPA `#/` 路由），结构搜索 JS 渲染、
    // 无稳定 GET 参数。跳首页 + 自动复制 SMILES。
    acceptsQuery: false,
    url: () => 'https://www.labnetwork.com.cn/'
  },
  {
    id: 'aladdin',
    name: '阿拉丁',
    tag: '国产试剂',
    prefers: 'smiles',
    // 🔴 这里**故意**用结构式搜索页而不是关键词搜索 URL：阿拉丁的关键词搜索结果页
    //    路径未经实测（整站是纯前端 SPA，`/zh_cn/customsearch/index/search/?keyword=`
    //    与随便一个不存在的路径返回的是**同一份 23682 字节的壳**，
    //    curl 出的 200 证明不了任何事）。宁可按已确认可用的结构式入口 + 复制 SMILES，
    //    也不猜一个「看着像搜索页、进去是空白」的 URL。
    acceptsQuery: false,
    url: () => 'https://www.aladdin-e.com/zh_cn/customsearch/index/structure/'
  },
  // ---------- 试剂商：目录按 CAS / 货号建索引，URL 带 CAS 能直接出结果 ----------
  {
    id: 'sigma',
    name: 'Sigma-Aldrich',
    tag: '试剂巨头',
    prefers: 'cas',
    acceptsQuery: true,
    url: (q) => `https://www.sigmaaldrich.cn/CN/zh/search/${enc(q)}`
  },
  {
    id: 'tci',
    name: 'TCI 梯希爱',
    tag: '试剂',
    prefers: 'cas',
    acceptsQuery: true,
    url: (q) => `https://www.tcichemicals.com/CN/zh/search/?text=${enc(q)}`
  },
  {
    id: 'macklin',
    name: '麦克林',
    tag: '国产试剂',
    prefers: 'cas',
    acceptsQuery: true,
    url: (q) => `https://www.macklin.cn/search/${enc(q)}`
  },
  {
    id: 'bide',
    name: '毕得医药',
    tag: '定制合成',
    prefers: 'cas',
    acceptsQuery: true,
    url: (q) => `https://www.bidepharm.com/search?keyword=${enc(q)}`
  }
];

/** 找不到 id 时的兜底供应商（清单被改/老 localStorage 里存着已删除的 id） */
const DEFAULT_SUPPLIER_ID = SUPPLIERS[0].id;

/** 这个 id 是否在清单里 */
function isSupplierId(id: string): boolean {
  return SUPPLIERS.some((x) => x.id === id);
}

/** 取一家供应商（无效 id 返回 undefined，调用方决定怎么兜底） */
function supplierById(id: string): Supplier | undefined {
  return SUPPLIERS.find((x) => x.id === id);
}

/**
 * 解析「这次拿什么去查」—— **纯函数**（CAS 从 PubChem 的缓存里读，不打网络）。
 *
 * 决策顺序（三个条件各自独立，任何一种都要能单独验到）：
 *   ① 平台认 SMILES（`prefers:'smiles'`）      ⇒ SMILES（CAS 对它没有意义）
 *   ② 认 CAS 但用户关了「优先用 CAS」         ⇒ SMILES（`cas-off`）
 *   ③ 认 CAS 且已查到 CAS                      ⇒ CAS
 *   ④ 认 CAS 但还没查到 CAS（未查 / 未收录）   ⇒ SMILES（`cas-missing`，不阻塞查询）
 *
 * 🔴 第 ④ 条刻意**不等待** PubChem：查不到 CAS 是外部的正常状态（内网、限流、
 *    结构没收录），拿它去堵「查价」这个动作是本末倒置。回落 SMILES 并如实标注即可。
 */
function resolveSupplierQuery(
  id: string,
  smiles: string,
  preferCas: boolean
): SupplierQuery | null {
  const supplier = supplierById(id);
  if (!supplier || !smiles) return null;
  const cas = casState(smiles)?.cas ?? '';
  let ident: SupplierIdent = 'smiles';
  let reason: SupplierQuery['reason'] = 'smiles-native';
  if (supplier.prefers === 'cas') {
    if (!preferCas) reason = 'cas-off';
    else if (!cas) reason = 'cas-missing';
    else {
      ident = 'cas';
      reason = 'cas';
    }
  }
  const value = ident === 'cas' ? cas : smiles;
  return {
    supplier,
    ident,
    value,
    label: ident === 'cas' ? `CAS ${value}` : 'SMILES',
    // acceptsQuery:false 的那几家 URL 带不了词，统一跳它们的固定查询页
    url: supplier.acceptsQuery ? supplier.url(value) : supplier.url(''),
    reason
  };
}

/**
 * 查价（复制标识 + 新标签页）。
 *
 * 🔴 顺序是「先开页、再复制」，而且复制**不 await**：
 *    `window.open` 必须在用户手势的同一次任务里调用，中间夹一个 `await`
 *    （剪贴板写入是异步的）会让部分浏览器判定成「非用户触发」而拦掉弹窗 ——
 *    那用户看到的就是「点了没反应」，正是最难排查的那种。
 *    复制失败只影响「到站能不能直接粘」，由 `copyText` 自己弹降级提示。
 */
function querySupplier(id: string, smiles: string, preferCas: boolean): SupplierQuery | null {
  const q = resolveSupplierQuery(id, smiles, preferCas);
  if (!q) return null;
  window.open(q.url, '_blank', 'noopener,noreferrer');
  void copyText(q.value, {
    okMsg: `已复制 ${q.label}，粘贴到「${q.supplier.name}」搜索框即可`
  });
  return q;
}

export {
  SUPPLIERS,
  DEFAULT_SUPPLIER_ID,
  isSupplierId,
  supplierById,
  resolveSupplierQuery,
  querySupplier
};

export type { SupplierIdent, Supplier, SupplierQuery };
