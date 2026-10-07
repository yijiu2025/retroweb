/**
 * 化合物采购源（供应商 / 比价平台）—— 单一来源。
 *
 * 点「可购买」标签旁的商店图标，用当前分子的 SMILES 跳到各平台查价。
 * 供应商列表只在这里维护，任何组件要跳转都从这拿。
 *
 * 🔴 一律「跳搜索页 + 自动复制 SMILES 到剪贴板」：
 *    —— 几乎**没有**哪家化学品供应商支持「SMILES 直接拼 URL 出结果」：
 *      Molport / eMolecules / LabNetwork 的搜索都是 JS 表单/绘图板驱动，硬拼 SMILES
 *      参数全返回 404（2026-10-06 实测踩坑）。所以**所有**平台统一走 `direct:false`：
 *      跳到它们的搜索页/首页，同时把 SMILES 复制到剪贴板，用户粘贴即搜。
 *      `direct` 字段保留是为了将来某家真的支持直搜 URL 时能无缝切回。
 *
 * 🔴 一律新标签页打开（noopener,noreferrer），不打断当前路线分析。
 */

export interface Supplier {
  /** 唯一 id */
  id: string;
  /** 显示名 */
  name: string;
  /** 国别/定位短标签 */
  tag: string;
  /** 是否支持 SMILES 直接拼进 URL（false = 跳搜索页 + 自动复制 SMILES） */
  direct: boolean;
  /** 生成查询 URL */
  url: (smiles: string) => string;
}

/** SMILES 的 URL 编码 */
const enc = encodeURIComponent;

export const SUPPLIERS: Supplier[] = [
  {
    id: 'molport',
    name: 'Molport',
    tag: '全球比价',
    direct: false,
    // 🔴 Molport 官网搜索是 JS 表单驱动，没有稳定的「SMILES 拼 URL 直接出结果」参数
    //    （曾误用 chemical-search-results?structure=… 返回 404）。改跳它的 List Search
    //    工具页（可粘贴 SMILES 列表批量查价），并自动复制 SMILES 到剪贴板。
    url: () => `https://www.molport.com/shop/swl-step-1`
  },
  {
    id: 'emolecules',
    name: 'eMolecules',
    tag: '全球比价',
    direct: false,
    // 🔴 官网搜索是绘图板/表单驱动，无稳定 SMILES GET 参数（?q=&r= 均 404），
    //    且完整结构搜索需登录。跳首页 + 自动复制 SMILES，用户粘贴结构搜索。
    url: () => `https://www.emolecules.com/`
  },
  {
    id: 'labnetwork',
    name: 'LabNetwork',
    tag: '比价聚合',
    direct: false,
    // 🔴 药明康德旗下，域名已迁移到 labnetwork.com.cn（SPA `#/` 路由），
    //    结构搜索 JS 渲染，无稳定 GET 参数。跳首页 + 自动复制 SMILES。
    url: () => `https://www.labnetwork.com.cn/`
  },
  {
    id: 'aladdin',
    name: '阿拉丁',
    tag: '国产试剂',
    direct: false,
    url: () => `https://www.aladdin-e.com/zh_cn/customsearch/index/structure/`
  },
  {
    id: 'sigma',
    name: 'Sigma-Aldrich',
    tag: '试剂巨头',
    direct: false,
    url: (s) => `https://www.sigmaaldrich.cn/CN/zh/search/${enc(s)}`
  },
  {
    id: 'tci',
    name: 'TCI 梯希爱',
    tag: '试剂',
    direct: false,
    url: (s) => `https://www.tcichemicals.com/CN/zh/search/?text=${enc(s)}`
  },
  {
    id: 'macklin',
    name: '麦克林',
    tag: '国产试剂',
    direct: false,
    url: (s) => `https://www.macklin.cn/search/${enc(s)}`
  },
  {
    id: 'bide',
    name: '毕得医药',
    tag: '定制合成',
    direct: false,
    url: (s) => `https://www.bidepharm.com/search?keyword=${enc(s)}`
  }
];

/** 打开某个供应商的查询页（新标签页）。
 *  非 direct 平台会自动把 SMILES 复制到剪贴板，方便用户跳转后直接粘贴。 */
export function openSupplier(id: string, smiles: string): void {
  const sup = SUPPLIERS.find((x) => x.id === id);
  if (!sup) return;
  const href = sup.url(smiles);
  if (!sup.direct) {
    void navigator.clipboard
      ?.writeText(smiles)
      .catch(() => {
        /* 剪贴板被浏览器拒绝时静默降级：用户仍可手动复制 */
      });
  }
  window.open(href, '_blank', 'noopener,noreferrer');
}

/** 供应商查询 URL（供测试 / 工具提示用） */
export function supplierUrl(id: string, smiles: string): string | null {
  const sup = SUPPLIERS.find((x) => x.id === id);
  return sup?.url(smiles) ?? null;
}
