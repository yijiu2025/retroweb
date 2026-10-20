/**
 * 外部边界类型：只在这里收口（第三方全局 / 后端响应），业务代码禁止 `any`。
 *
 * 规则：
 *  - 第三方注入到 window 上的全局（smiles-drawer）→ `declare global` 窄接口
 *  - 后端响应 → 见 `types/retro.ts`（本仓库后端）与 `types/sso.ts`（oauth21 postMessage）
 *
 * @author yijiu2025
 * @since 2026-10-11
 */

/**
 * PubChem PUG REST 的响应（CAS 查询用，见 `utils/pubchem.ts`）。
 *
 * 只声明真正读到的字段：`InformationList.Information[0]` 的 `CID` 与
 * `Synonym[]` —— **CAS 号就混在 synonyms 列表里**（不在单独字段上）。
 */
interface PubChemSynonymsResponse {
  InformationList?: {
    Information?: Array<{
      CID?: number;
      Synonym?: string[];
    }>;
  };
}

/**
 * PubChem PUG REST 的 property 响应（按 CAS 号反查结构时用，见 `utils/cas-lookup.ts`）。
 *
 * 🔴 `SMILES` 与 `ConnectivitySMILES` 的区别（实测 2026-10-20）：
 *    · `SMILES`            —— **含立体化学**（`C/C=C/C`）
 *    · `ConnectivitySMILES` —— 去掉立体后的连接结构
 *    2023 起的 PubChem 两个都给；老版本只有 `SMILES`。
 *    取值时优先 `SMILES`（保留立体信息对逆合成更有用）。
 *
 * 另外注意 PubChem 返回的是 **Kekulé 形式**（`C1=CC=CC=C1`），
 * 不是芳香小写形式（`c1ccccc1`）⇒ 拿到后要交给 RDKit 规范化。
 */
interface PubChemPropertyResponse {
  PropertyTable?: {
    Properties?: Array<{
      CID?: number;
      /** 含立体的 SMILES（Kekulé 形式） */
      SMILES?: string;
      /** 不含立体的 SMILES（Kekulé 形式） */
      ConnectivitySMILES?: string;
      /** 分子式，如 `C9H8O4` */
      MolecularFormula?: string;
      /** 分子量，如 `180.16` */
      MolecularWeight?: string;
      /** IUPAC 名 */
      IUPACName?: string;
    }>;
  };
  /** 出错时的结构（404 = 没收录这个 CAS 号） */
  Fault?: {
    Code?: string;
    Message?: string;
    Details?: string[];
  };
}

/** smiles-drawer 的绘制器实例（我们只需要 draw 这一个方法） */
interface SmiDrawerLike {
  draw(
    smiles: string,
    target: SVGElement | null,
    theme: string,
    successCallback?: () => void,
    errorCallback?: (err: unknown) => void,
    weights?: unknown
  ): void;
}

declare global {
  interface Window {
    /** `public/smiles-drawer.min.js` 注入的全局（脚本按需加载，故可选） */
    SmilesDrawer?: {
      SmiDrawer: new (opts?: Record<string, unknown>) => SmiDrawerLike;
    };
  }
}

export type { PubChemSynonymsResponse, PubChemPropertyResponse, SmiDrawerLike };
