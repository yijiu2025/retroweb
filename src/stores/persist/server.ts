/**
 * 持久化适配层 · 服务端实现（Node 中转，绑定用户）
 *
 * 与本地实现共用同一个 `PersistAdapter` 接口，但数据权威在服务端，本地只做缓存。
 *
 * 🔴 接口是**同步**的（index.ts 写死），所以这里必须：
 *    ① `readSessions()` 返回**本地缓存**（可能为空 → 由 `preload()` 异步拉满）；
 *    ② `writeSessions()` 同步更新本地缓存，把「提交到服务端」丢进后台队列
 *       （debounce + 失败重试 + 静默降级）；
 *    ③ 任何网络失败都**不抛给调用方** —— 写不上去时任务仍在本地缓存里，
 *       下次写/刷新会再试，绝不让"断网"打断用户改树。
 *
 * 🔴 映射关系（本地 Session ↔ 服务端 retroweb_task）：
 *    · Session.id          → task.client_id（幂等键，import 去重靠它）
 *    · Session.snapshot    → task.snapshot（后端派生统计列）
 *    · Session.sig         → task.sig（乐观锁）
 *    · Session.updatedAt   → 服务端 updated_at（列表排序）
 *
 * @since 2026-10-09
 */
import { apiClient } from '@/api/http';
import type { HistoryTask, Session } from '@/types/retro';
import { readCondPref as localReadCondPref, writeCondPref as localWriteCondPref } from './local';
import type { CondPref } from './local';

const SERVER_CACHE_KEY = 'retroweb_server_cache_v1';

/** 本地缓存结构：会话 + 历史（cond_pref 仍走本地，见下方说明） */
interface ServerCache {
  sessions: Session[];
  history: HistoryTask[];
}

/** 空缓存 */
const EMPTY: ServerCache = { sessions: [], history: [] };

/** 读本地缓存（损坏 / 缺失 → 空） */
function readCache(): ServerCache {
  try {
    const raw = localStorage.getItem(SERVER_CACHE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<ServerCache>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeCache(cache: ServerCache): void {
  try {
    localStorage.setItem(SERVER_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 隐私模式 / 配额满：缓存写不进，内存态仍可用 */
  }
}

/** 内存态缓存（同步读写的真身），启动时从 localStorage 恢复 */
let cache: ServerCache = readCache();

/** client_id（前端 Session.id）→ 服务端 task.id 的映射（preload 时记下，详情按需拉取用） */
let clientIdMap: Record<string, number> = {};

/** 是否已登录（由 index.ts 注入：登录后才走服务端，否则切回本地实现） */
let authed = false;

/** 供 index.ts 设置登录态；切换账号/登出时传 false 并清内存 */
export function setServerAuthed(next: boolean): void {
  authed = next;
  if (!next) {
    cache = { ...EMPTY };
    clientIdMap = {};
  }
}

/**
 * 异步预热：登录后把服务端任务**元数据**拉到本地缓存（清掉旧的、换上权威数据）。
 *
 * 🔴 列表接口只回元数据（不含 snapshot，见后端设计），所以这里拉到的每个 session 的
 *    snapshot 是空占位。真正打开任务时由 `ensureLoaded(id)` 按需拉全量详情。
 * 🔴 只在登录那一刻调一次；失败静默（本地缓存保持原样，下次读仍是旧的）。
 */
export async function preload(): Promise<void> {
  if (!authed) return;
  try {
    const data = await apiClient.get<{ tasks: unknown[] }>('/retroweb/v1/tasks');
    const tasks = (data?.tasks ?? []) as Array<{
      id: number;
      client_id: string | null;
      name: string;
      target: string;
      model: string | null;
      status: Session['status'];
      sig: string | null;
      updated_at: string;
    }>;

    const sessions: Session[] = [];
    clientIdMap = {};
    for (const t of tasks) {
      const clientId = t.client_id ?? `srv-${t.id}`;
      clientIdMap[clientId] = t.id;
      sessions.push({
        id: clientId,
        name: t.name,
        target: t.target,
        model: t.model ?? '',
        status: t.status,
        updatedAt: new Date(t.updated_at).getTime(),
        // 列表不含 snapshot：占位，打开时 ensureLoaded 拉全量
        snapshot: { rootId: null, nodes: {}, params: {} as never, activeNodeId: null, jobIds: {} },
        sig: t.sig ?? undefined
      });
    }

    cache = { sessions, history: cache.history };
    writeCache(cache);
  } catch {
    /* 预热失败（离线 / 服务端没起）：保持本地缓存，不打断启动 */
  }
}

/**
 * 按需拉取单个任务的全量快照并填进缓存（S2 读路径核心）。
 *
 * 🔴 打开任务前调用：列表只有元数据，详情接口 `/tasks/:id` 才含完整 snapshot。
 *    拉取成功后用解压后的快照**原地替换**缓存里那条 session 的 snapshot。
 * 🔴 失败静默：缓存里已有的（可能来自上次写回）继续用，不让"详情拉不到"挡住打开。
 *
 * @param id 前端 Session.id（= client_id）
 */
export async function ensureLoaded(id: string): Promise<void> {
  if (!authed) return;
  const taskId = clientIdMap[id];
  if (!taskId) return; // 本地新建、尚未同步到服务端的任务：没有服务端 id，跳过
  try {
    const data = await apiClient.get<{ task: { snapshot: Session['snapshot'] | null } }>(
      `/retroweb/v1/tasks/${taskId}`
    );
    const snapshot = data?.task?.snapshot;
    if (!snapshot) return;
    const idx = cache.sessions.findIndex(s => s.id === id);
    if (idx >= 0) {
      cache.sessions[idx] = { ...cache.sessions[idx], snapshot };
      writeCache(cache);
    }
  } catch {
    /* 详情拉不到：保持现状，打开时用缓存里的（可能为空占位，由 restoreSnapshot 兜底） */
  }
}

// ---- 同步读（返回本地缓存） ----

export function readSessions(): Session[] {
  return cache.sessions;
}

export function readHistory(): HistoryTask[] {
  return cache.history;
}

/** 条件枚举偏好：纯 UI 习惯，仍走本地实现（不迁服务端，避免为小偏好加往返） */
export function readCondPref(): CondPref {
  return localReadCondPref();
}

// ---- 同步写（更新本地缓存 + 后台提交） ----

/** 待提交的会话（去重后的最新列表） */
let pending: Session[] | null = null;
let commitTimer: ReturnType<typeof setTimeout> | undefined;

/** 后台提交队列：把整个会话列表推给服务端（import 幂等 upsert） */
function flushSoon(): void {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    void commit().catch(() => {
      /* 静默降级：下次写会再试 */
    });
  }, 800);
}

async function commit(): Promise<void> {
  if (!authed || !pending) return;
  const list = pending;
  pending = null;
  try {
    await apiClient.post('/retroweb/v1/tasks/import', {
      items: list.map(s => ({
        client_id: s.id,
        name: s.name,
        target: s.target,
        model: s.model,
        status: s.status,
        snapshot: s.snapshot,
        sig: s.sig ?? null
      }))
    });
  } catch {
    // 提交失败：把列表塞回 pending，下次写时重试（不丢数据）
    pending = pending ? pending : list;
  }
}

export function writeSessions(list: Session[]): void {
  cache = { ...cache, sessions: list };
  writeCache(cache);
  if (authed) {
    pending = list;
    flushSoon();
  }
}

export function writeHistory(list: HistoryTask[]): void {
  // 历史记录（手动保存快照）暂不迁服务端 —— S1 先只迁任务；仍落本地缓存
  cache = { ...cache, history: list };
  writeCache(cache);
}

export function writeCondPref(v: CondPref): void {
  // 偏好类不迁服务端，仍走本地实现
  localWriteCondPref(v);
}

export function clear(): void {
  cache = { ...EMPTY };
  try {
    localStorage.removeItem(SERVER_CACHE_KEY);
  } catch {
    /* ignore */
  }
}
