/**
 * 持久化适配层 · 出口
 *
 * 业务代码一律 `import { persist } from '@/stores/persist'`，永不直接碰 localStorage。
 *
 * 为什么要这一层（S0 的全部意义）：
 *   数据现在在浏览器里，接 Node 中转后要在服务端（绑定用户）。如果 store 里散落着
 *   `localStorage.setItem(...)`，切换那天就得把所有调用点翻一遍 —— 而它们分布在
 *   会话、历史、偏好三处且各有兜底逻辑，漏一处就是"数据悄悄没了"。
 *   先把读写收拢成一个**同步接口**，切换时只换这一个实现。
 *
 * 🔴 接口是**同步**的，但服务端实现必然是异步的 ⇒ 服务端实现必须：
 *    ① `readXxx()` 返回**本地缓存**的值（可能为 null → 由异步预热补齐）；
 *    ② `writeXxx()` 同步更新本地缓存，再把提交丢进后台队列（debounce + 失败重试）；
 *    ③ 任何网络失败都**静默降级**为本地，绝不抛给调用方 —— 写入失败不该打断用户改树。
 *
 * 当前阶段（S0）：只用本地实现，**行为与改造前完全一致**。
 */
import type { HistoryTask, Session } from '@/types/retro';
import * as local from './local';
import * as server from './server';
import type { CondPref } from './local';

/** 本地缓存容量上限：store 限制内存里的会话条数时也用它，两处必须是同一个数。
 *  🔴 与服务端配额（能建几个任务：普通 2 / 会员 50）不是一回事，别混。 */
const LOCAL_SESSIONS_LIMIT = local.SESSIONS_LIMIT;

interface PersistAdapter {
  readSessions(): Session[];
  writeSessions(list: Session[]): void;
  readHistory(): HistoryTask[];
  writeHistory(list: HistoryTask[]): void;
  readCondPref(): CondPref;
  writeCondPref(v: CondPref): void;
  /** 清空本用户的数据（切换账号 / 登出时用） */
  clear(): void;
  /**
   * 打开任务前按需拉取全量快照（S2 读路径）：列表只回元数据，详情才含 snapshot。
   * local 实现为 no-op（数据本就在本地）；server 实现从 /tasks/:id 拉取。
   */
  ensureLoaded(id: string): Promise<void>;
  /**
   * 异步重读：把**权威数据**（服务端）重新灌进本地缓存。
   *
   * 🔴 为什么必须有这一环：`readSessions()` 是**同步**的（接口写死），它读的永远是缓存。
   *    而 store 里的 `sessions` ref 只在创建时读过一次缓存 —— 登录成功后
   *    `preload()` 把服务端数据拉进了缓存，ref 却仍是登录前的那份（通常是空数组），
   *    于是"刷新回来我的任务没了"。补一次 refresh + 重读，ref 才跟得上权威。
   */
  refresh(): Promise<void>;
}

const localAdapter: PersistAdapter = {
  readSessions: local.readSessions,
  writeSessions: local.writeSessions,
  readHistory: local.readHistory,
  writeHistory: local.writeHistory,
  readCondPref: local.readCondPref,
  writeCondPref: local.writeCondPref,
  clear: local.clearAll,
  ensureLoaded: async () => {}, // 本地实现：数据本就在 localStorage，无需拉取
  refresh: async () => {} // 本地实现：localStorage 即权威，无需重读
};

const serverAdapter: PersistAdapter = {
  readSessions: server.readSessions,
  writeSessions: server.writeSessions,
  readHistory: server.readHistory,
  writeHistory: server.writeHistory,
  readCondPref: server.readCondPref,
  writeCondPref: server.writeCondPref,
  clear: server.clear,
  ensureLoaded: server.ensureLoaded,
  refresh: server.preload
};

/**
 * 是否启用服务端持久化。
 *
 * S1 阶段：默认关（`false`），行为与改造前完全一致。打开开关 = 登录后走服务端、
 * 未登录 / 离线仍走本地。开关来源：编译期 `VITE_PERSIST_SERVER`，将来接上登录态后
 * 再改成运行时判据（见下方 `useServerPersist`）。
 */
const SERVER_PERSIST = import.meta.env.VITE_PERSIST_SERVER === 'true';

/** 运行时决定走哪套实现（业务代码不感知，只认 `persist` 这一个出口） */
let useServer = SERVER_PERSIST;

/**
 * 当前是否走服务端实现（供 store 判断「打开任务要不要先异步拉详情」）。
 * 🔴 local 模式必须保持**完全同步**（测试与历史代码都假设 loadSession 同步生效），
 *    只有 server 模式才需要异步 ensureLoaded。
 */
function isServerPersist(): boolean {
  return useServer;
}

/**
 * 登录 / 登出时调用：切到服务端实现并预热，或切回本地并清缓存。
 * 🔴 由 auth store 挂钩子调用（applyLogin / markExpired / logout / switchAccount），
 *    业务代码不要直接碰这个函数。
 */
async function activateServerPersist(authed: boolean): Promise<void> {
  useServer = authed && SERVER_PERSIST;
  server.setServerAuthed(useServer);
  if (useServer) {
    await server.preload();
  } else {
    // 登出 / 切账号：本地实现的 clear 已由调用方清，这里不重复清
  }
}

/**
 * 当前生效的实现。
 *
 * S1 恒为本地实现（开关默认关）；开关打开且登录后走服务端（本地降级为缓存）。
 * 切换判据集中在这里，业务代码不用知道。
 */
/**
 * 把权威数据重新灌进缓存（换用户 / 登录后调用）。
 *
 * 调用方在它返回后**必须重新读** `persist.readSessions()` —— 同步接口只认缓存，
 * 缓存换了不代表已经看过它的 ref 也跟着换了。
 */
async function refreshPersist(): Promise<void> {
  await (useServer ? serverAdapter.refresh() : localAdapter.refresh());
}

const persist: PersistAdapter = {
  readSessions: () => (useServer ? serverAdapter.readSessions() : localAdapter.readSessions()),
  writeSessions: list => (useServer ? serverAdapter.writeSessions(list) : localAdapter.writeSessions(list)),
  readHistory: () => (useServer ? serverAdapter.readHistory() : localAdapter.readHistory()),
  writeHistory: list => (useServer ? serverAdapter.writeHistory(list) : localAdapter.writeHistory(list)),
  readCondPref: () => (useServer ? serverAdapter.readCondPref() : localAdapter.readCondPref()),
  writeCondPref: v => (useServer ? serverAdapter.writeCondPref(v) : localAdapter.writeCondPref(v)),
  clear: () => (useServer ? serverAdapter.clear() : localAdapter.clear()),
  ensureLoaded: id => (useServer ? serverAdapter.ensureLoaded(id) : localAdapter.ensureLoaded(id)),
  refresh: () => (useServer ? serverAdapter.refresh() : localAdapter.refresh())
};

export { LOCAL_SESSIONS_LIMIT, isServerPersist, activateServerPersist, refreshPersist, persist };

export type { CondPref, PersistAdapter };
