/**
 * 复制到剪贴板 —— **全站唯一的复制入口**。
 *
 * 🔴 为什么必须 try/catch：`navigator.clipboard` 只在**安全上下文**可用。
 *    `http://` 访问（内网 IP、非 localhost）或用户拒绝了剪贴板权限时，
 *    `writeText` 直接 reject ⇒ 不兜底的话「点了没反应」，用户只能猜。
 *    这里统一降级成「请手动选中复制」的提示。
 *
 * 🔴 为什么提示语由调用方给：同一次复制在不同地方含义不同
 *    （「已复制 SMILES」/「已复制 CAS」/「已复制整条路线」），
 *    写死在这里就得让调用方再叠一层 toast，反而更乱。
 *
 * 🔴 所有复制点都必须走这里（DRY，见 `.claude/skills/fullstack-rules/` SKILL.md 第 1 条）。
 *    原先有 5 处各写一遍 `navigator.clipboard.writeText` + 各自的 catch 文案，
 *    结果**降级话术三种、成功话术五种**，连"是不是安全上下文"这件事都要在 5 个地方各想一次。
 *
 * 返回是否复制成功：调用方需要"失败就不改 UI 状态"（例如按钮切到"已复制"）时用它。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { ElMessage } from 'element-plus';

/** 提示语（都可不传，有默认值）。把三个可变文案集中在这里，调用方只声明差异 */
interface CopyOpts {
  /** 成功提示 */
  okMsg?: string;
  /** 写剪贴板失败（非安全上下文 / 被拒权限）时的降级提示 */
  failMsg?: string;
  /** 传进来的内容是空的时候的提示 */
  emptyMsg?: string;
}

/**
 * @param text 待复制内容；`null`/`undefined` 视为空 → 走 `emptyMsg` 提示并返回 false
 * @param opts 三条可定制文案（成功/失败/空内容），都不传则用内置默认
 * @returns 是否复制成功。⚠️ 返回 false 的两种常见原因：非安全上下文（http）、
 *          或用户拒绝剪贴板权限 —— 调用方应据此不切换按钮状态
 */
async function copyText(
  text: string | number | null | undefined,
  opts: CopyOpts = {}
): Promise<boolean> {
  const value = text === null || text === undefined ? '' : String(text);
  if (!value) {
    ElMessage.warning(opts.emptyMsg ?? '这里没有可复制的内容');
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(opts.okMsg ?? '已复制');
    return true;
  } catch {
    ElMessage.warning(opts.failMsg ?? '浏览器不允许自动复制，请手动选中后复制');
    return false;
  }
}

export { copyText };

export type { CopyOpts };
