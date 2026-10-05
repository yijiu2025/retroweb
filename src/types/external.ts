/**
 * 外部边界类型：只在这里收口（第三方全局 / 后端响应），业务代码禁止 `any`。
 *
 * 规则：
 *  - 第三方注入到 window 上的全局（smiles-drawer）→ `declare global` 窄接口
 *  - 后端响应 → 见 `types/retro.ts`（本仓库后端）与 `types/sso.ts`（oauth21 postMessage）
 */

/** smiles-drawer 的绘制器实例（我们只需要 draw 这一个方法） */
export interface SmiDrawerLike {
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
