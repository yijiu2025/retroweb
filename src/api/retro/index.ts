/**
 * 算法服务 API 的**统一出口**。
 *
 * 业务代码只从这里 import，不要深入子文件 —— 这样将来内部拆分（换实例、抽公共
 * 错误处理、增删端点）不会波及调用方。
 *
 * 分层：`./client` 是传输层（实例 + 错误归一），`./compute` 与 `./llm` 是业务层。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
export { retroApi } from './compute';
export {
  RetroApiError,
  retroClient,
  retroJobClient,
  retroLlmClient,
  retroBaseURL
} from './client';
export { llmApi, streamAnalyze, streamConditions, streamFollowup } from './llm';
export type {
  AnalyzeStreamHandlers,
  ConditionsStreamHandlers,
  FollowupStreamEvent,
  FollowupStreamHandlers
} from './llm';
