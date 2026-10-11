/**
 * 「存为路线方案」交互。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import type { useWorkspaceStore } from '@/stores/workspace';

type WsStore = ReturnType<typeof useWorkspaceStore>;

/**
 * 存为一条新的路线方案 —— 弹输入框起名。
 *
 * 抽成独立函数是因为它有**两个入口**：
 *   ① `SchemeBar` 的「存为新方案」按钮；
 *   ② `TargetBar`（Slim Header）上的快捷入口 —— 无方案时 SchemeBar 整条不渲染，
 *      入口就得落在顶部栏里。
 * 两处若各写一份，起名文案 / 默认名 / 校验迟早分叉。
 *
 * @param store 工作台 store（要从中读当前路线与方案数）
 * @returns 无（void）；用户取消或还没有路线时静默返回（只给一次提示）。
 *          保存成功后方案列表由 store 自己刷新，调用方不需要额外处理
 */
async function promptSaveScheme(store: WsStore): Promise<void> {
  if (!store.rootId) {
    ElMessage.warning('还没有路线可保存，请先设定目标分子并拆几步');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt(
      '给这条路线起个名字（例如「路线 A：走酰氯」「路线 B：走酸酐」）',
      '存为一条路线方案',
      {
        inputValue: `路线 ${store.schemeStats.length + 1}`,
        confirmButtonText: '保存',
        cancelButtonText: '取消'
      }
    );
    store.saveScheme(value);
    ElMessage.success('已存为一条路线方案，可继续改选择再存下一条');
  } catch {
    /* 用户取消 */
  }
}

export { promptSaveScheme };
