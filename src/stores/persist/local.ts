/**
 * 持久化适配层 · 本地实现（localStorage）
 *
 * 🔴 这一层存在的唯一理由：让「数据存哪儿」成为一个**可替换的决定**。
 *    接入 Node 中转后（数据绑定用户）要换成服务端实现，届时不该有任何一处
 *    业务代码知道数据是存在 localStorage 还是 MySQL。
 *
 * 🔴 接口刻意保持**同步**：store 里写快照是同步调用（改一个节点就落一次盘），
 *    若改成 async，调用点全得改，且"写入顺序"会变得不可控。
 *    服务端实现因此必须是「同步记账 + 后台异步提交」（见 index.ts 的说明）。
 *
 * 关于这里的兜底逻辑，是从 stores/workspace.ts 原样搬来的，不要"顺手优化"：
 *   · 写不进去（配额超）时**先瘦身后重试**，而不是直接放弃 —— 静默丢整棵树的代
 *     价远大于丢 AI 分析原文；
 *   · 每个读写都 try：SSR / 隐私模式下没有 localStorage，抛错会让 store 建不起来。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import type { HistoryTask, MolNode, Session } from '@/types/retro';

const HISTORY_KEY = 'retroweb_history';
const SESSIONS_KEY = 'retroweb_sessions';
const COND_PREF_KEY = 'retroweb_cond_pref';

/** 与服务端配额无关：这是**本地缓存**的容量上限（浏览器 localStorage 很金贵） */
const SESSIONS_LIMIT = 10;

interface CondPref {
  planFirst: boolean;
  count: number;
}

/**
 * 读历史任务列表。
 *
 * @returns 历史任务；读不到/数据损坏一律返回**空数组**（不抛）——
 *          隐私模式下没有 localStorage 时 store 也要能建起来
 */
function readHistory(): HistoryTask[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryTask[]) : [];
  } catch {
    return [];
  }
}

/**
 * 写历史任务列表。
 *
 * @param list 完整的历史任务列表（整体覆盖，不是追加）
 * @returns 无（void）；写失败（配额超）时静默忽略 —— 见文件头「先瘦身后重试」的说明
 */
function writeHistory(list: HistoryTask[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式 / 配额满：存不上不影响本次使用 */
  }
}

/**
 * 读最近任务快照。
 *
 * @returns 最近任务数组（按写入顺序，最多 `SESSIONS_LIMIT` 条）；读不到返回空数组
 */
function readSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Session[]) : [];
  } catch {
    return [];
  }
}

/**
 * 写最近任务快照，**超量时自动瘦身**。
 *
 * 🔴 瘦身不是可选优化：localStorage 配额很金贵，写满会让**所有** localStorage
 *    操作（包括别的域）一起失败。这里先裁到 `SESSIONS_LIMIT` 条并剥掉可重建的字段
 *    （快照节点、概率等）再写。
 *
 * @param list 完整的最近任务列表
 * @returns 无（void）
 */
function writeSessions(list: Session[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, SESSIONS_LIMIT)));
    return;
  } catch {
    /* 可能是 quota 超了 —— 下面用「瘦身版」再试一次 */
  }
  try {
    // 🔴 兜底：把每步 AI 分析的**原始输出**丢掉（结构化 data 与 RDKit 质量表都留着）。
    //    raw 是唯一可能几 KB 级膨胀的字段；丢了它只是不能再看「模型原文」，
    //    界面该显示的内容一个不少。不这么兜底的话，quota 一超就会**静默**丢失
    //    整个会话 → 「刷新后任务不见了」。
    const slim = list.slice(0, SESSIONS_LIMIT).map((s) => ({
      ...s,
      snapshot: {
        ...s.snapshot,
        nodes: Object.fromEntries(
          Object.entries(s.snapshot.nodes).map(([id, n]) => {
            if (!n.analyses) return [id, n];
            const analyses: NonNullable<MolNode['analyses']> = {};
            for (const [k, rec] of Object.entries(n.analyses)) {
              // 候选条件枚举的模型原文（condOptions.raw）与 rec.raw 同量级，一起丢掉
              analyses[k] = {
                ...rec,
                raw: '',
                ...(rec.condOptions ? { condOptions: { ...rec.condOptions, raw: '' } } : {})
              };
            }
            return [id, { ...n, analyses }];
          })
        )
      }
    }));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(slim));
  } catch {
    /* 仍然失败（隐私模式 / 配额硬上限）：放弃落盘，不影响当前会话使用 */
  }
}

/**
 * 读「候选条件偏好」（先列条件 or 直接分析）。
 *
 * @returns 偏好设置；读不到时返回默认值（`planFirst:false`、`count:5`）
 */
function readCondPref(): CondPref {
  const def = { planFirst: true, count: 4 };
  try {
    const raw = localStorage.getItem(COND_PREF_KEY);
    if (!raw) return def;
    const obj = JSON.parse(raw) as { planFirst?: unknown; count?: unknown };
    const count = Number(obj?.count);
    return {
      // 只有显式存成 false 才算关（老数据/坏数据都当默认开启）
      planFirst: obj?.planFirst !== false,
      count: Number.isFinite(count) ? Math.max(2, Math.min(6, Math.round(count))) : def.count
    };
  } catch {
    return def;
  }
}

/**
 * 写「候选条件偏好」。
 *
 * @param v 偏好设置
 * @returns 无（void）
 */
function writeCondPref(v: CondPref): void {
  try {
    localStorage.setItem(COND_PREF_KEY, JSON.stringify(v));
  } catch {
    /* 隐私模式 / 配额满：偏好存不上不影响本次使用 */
  }
}

/** 清空本地缓存（🔴 切换账号 / 登出 / 401 时必须调，否则上一个用户的任务会串台） */
/**
 * 清掉本地全部持久化数据（历史 + 最近任务）。
 *
 * 🔴 **只清历史与会话**，不动条件偏好（那是用户的使用习惯，不是任务数据）。
 * @returns 无（void）；清不掉也不抛（隐私模式），内存态由调用方负责清
 */
function clearAll(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
    localStorage.removeItem(SESSIONS_KEY);
  } catch {
    /* 清不掉也要继续：内存态由调用方负责清 */
  }
}

export {
  SESSIONS_LIMIT,
  readHistory,
  writeHistory,
  readSessions,
  writeSessions,
  readCondPref,
  writeCondPref,
  clearAll
};

export type { CondPref };
