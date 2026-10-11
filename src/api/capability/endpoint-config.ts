/**
 * 端点配置的能力层（**档位切换的唯一入口**）。
 *
 * 🔴 为什么要这一层：`RunParams` 的端点面板原本只认 Python 直连档的
 *    `GET/POST /llm/settings`（整包提交）。走 Node 中转时若不切换，用户的
 *    地址/模型/密钥会**写进 Python 的 `web/llm_settings.json`** —— 那份文件是
 *    全局共享、不绑用户的：A 用户花掉 B 用户的 token，换设备配置即丢。
 *    Node 侧早有 `/llm/profiles`（per-user + 加密落库），但前端一个调用都没有。
 *
 * 🔴 两套路径规则**不能混用**（这是最容易踩的地方）：
 *
 *   | 档位 | baseURL | 端点配置接口 | 落点 |
 *   |---|---|---|---|
 *   | 直连 Python | `/retro`（vite 代理 rewrite 掉前缀） | `/llm/settings`（整包提交） | `web/llm_settings.json`（全局） |
 *   | 走 Node 中转 | `{API}/retroweb/v1`（guard.js 拼 `system.json.prefix` + 组前缀） | `/llm/profiles`（逐条 upsert） | `retroweb_llm_profile` 表（per-user、密钥加密） |
 *
 *    Node 的前缀由 `src/api/retroweb/system.json` 的 `prefix` + `registerGroupMetadata`
 *    的组前缀 `joinUrl` 而成（见 `framework/api/guard.js`），**不是** Python 的 `/api`。
 *
 * 本层对上层只暴露**一套 `LlmSettings` 形状**，把差异全部收在这里：
 *   · 直连档 → 透传给 `llmApi`（Python 的整包语义）
 *   · 中转档 → 拆成逐条 `/llm/profiles` 调用，并做两处形状翻译：
 *       `id`      number ↔ string（面板内部按 string 用）
 *       多字段     `temperature`/`timeout`/`json_mode` ↔ `extra_json`
 *       多把 key   `keys: LlmKeyState[]` ↔ 单个 `key_masked`
 *
 * 🔴 掩码往返不在前端解决：前端只有掩码、没有明文，把它回传等于把 `****ab3f`
 *    当成真 key。后端 `llm-profile.dao.js` 的 `mergeKeys` 负责用旧明文把掩码换回去
 *    （只有那一层能读到明文）。前端只负责「原样回传掩码」。
 *
 * ── 对上只暴露一套形状 ──
 *   四个方法（`settings` / `saveSettings` / `activateProfile` / `resetKeys`）签名
 *   与 Python 档**完全一致**，面板因此不需要知道当前是哪一档。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */import { llmApi } from '@/api/retro';
import { nodeLlmApi } from '@/api/capability/node-llm';
import { AUTH_BYPASS, RETRO_VIA_NODE } from '@/config/services';
import type {
  LlmProfile,
  LlmProfilePayload,
  LlmSettings,
  LlmKeyState,
  NodeLlmProfile
} from '@/types/retro';

/** 该档位是否走 Node 落库（决定配置存数据库还是 Python 的 json 文件） */
const PERSISTED_SERVER_SIDE: boolean = RETRO_VIA_NODE;

/** 需经 `extra_json` 中转的字段（Node 表没有这几列） */
const EXTRA_FIELDS = ['temperature', 'timeout', 'json_mode'] as const;

/** `extra_json` 里本层认识的透传字段（表无对应列，只能塞 JSON 里） */
interface ExtraBag {
  temperature?: number;
  timeout?: number;
  json_mode?: boolean;
}

/**
 * 从 `extra_json` 里取出透传字段。
 *
 * @param raw 库里存的 JSON 文本/对象（可能是 `null`、坏 JSON、非对象）
 * @returns 只含**类型正确**的三个字段；坏输入一律当空对象（不抛 ——
 *          一个用户的历史脏数据不该让整个面板打不开）
 */
function readExtra(raw: unknown): ExtraBag {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: ExtraBag = {};
  if (typeof o.temperature === 'number') out.temperature = o.temperature;
  if (typeof o.timeout === 'number') out.timeout = o.timeout;
  if (typeof o.json_mode === 'boolean') out.json_mode = o.json_mode;
  return out;
}

/**
 * 只带本层认识的透传字段，不把对方的私有字段写进去。
 *
 * @param input 面板侧的字段（可缺省）
 * @returns 干净的 `extra_json` 对象；`undefined`/`null` 的键不写入
 */
function writeExtra(input: {
  temperature?: number;
  timeout?: number;
  json_mode?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EXTRA_FIELDS) {
    const v = input[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/**
 * `NodeLlmProfile` → 面板的 `LlmProfile`。
 *
 * 🔴 `keys` 只有**一个**掩码：Node 侧刻意不返回 key 数量（泄露「配了几把」），
 *    所以这里最多造一条状态，面板也只会显示一把 —— 这是后端的安全取舍，
 *    不要为了"显示全"而把数量拼出来。
 *
 * @param p Node 侧的一条记录
 * @returns 面板形状。⚠️ `id` 从 number 转成 string（面板内部统一按 string 比较）；
 *          `null` 的数字字段一律给 0（与"不限/未设"语义一致）
 */
function nodeToPanel(p: NodeLlmProfile): LlmProfile {
  const extra = readExtra(p.extra_json);
  const keys: LlmKeyState[] = p.key_masked
    ? [{ masked: p.key_masked, state: p.active ? 'active' : 'idle', source: 'profile' }]
    : [];
  return {
    id: String(p.id),
    name: p.name,
    base_url: p.base_url,
    model: p.model,
    // Node 侧 null = 未设；面板要数字，给 0（与「不限」语义一致）
    max_tokens: p.max_tokens ?? 0,
    temperature: extra.temperature ?? 0,
    timeout: extra.timeout ?? 0,
    json_mode: extra.json_mode ?? false,
    keys,
    active: !!p.active
  };
}

/**
 * 面板的 `LlmProfilePayload` → Node 的 upsert body。
 *
 * @param p      面板侧的一条配置
 * @param active 是否设为生效那套（Node 的 DAO 会把该用户其它 active 清掉）
 * @returns upsert 请求体；⚠️ **不含 id**（id 走 URL/query，由调用方决定新建还是更新）
 */
function panelToNode(
  p: LlmProfilePayload,
  active: boolean
): {
  name: string;
  base_url: string;
  model: string;
  keys?: string[];
  active: boolean;
  max_tokens?: number;
  extra_json: Record<string, unknown>;
} {
  return {
    name: p.name || '默认',
    base_url: p.base_url ?? '',
    model: p.model ?? '',
    // 🔴 原样回传掩码：含 `*` 的由后端 mergeKeys 换回真 key。不含 `*` 的是新增明文。
    keys: p.api_keys,
    active,
    max_tokens: p.max_tokens ?? 0,
    extra_json: writeExtra(p)
  };
}

/**
 * 组一份面板形状的 `LlmSettings`（中转档专用）。
 *
 * @param list Node 侧的记录清单
 * @returns 面板形状的完整设置：顶层扁平字段 = **当前 active 那套**的展开；
 *          `active_index` 为 -1 表示一套都没标 active（面板据此提示"还没生效配置"）
 */
function toPanelSettings(list: NodeLlmProfile[]): LlmSettings {
  const profiles = list.map(nodeToPanel);
  const active = profiles.find((p) => p.active);
  return {
    ok: true,
    active_profile: active?.id ?? profiles[0]?.id ?? '',
    profiles,
    // 扁平字段 = 当前激活那套的展开（兼容「只关心当前配置」的用法）
    base_url: active?.base_url ?? '',
    model: active?.model ?? '',
    max_tokens: active?.max_tokens ?? 0,
    temperature: active?.temperature ?? 0,
    timeout: active?.timeout ?? 0,
    json_mode: active?.json_mode ?? false,
    keys: active?.keys ?? [],
    active_index: profiles.findIndex((p) => p.active)
  };
}

const endpointConfigApi = {
  /**
   * 该档位配置是否落在 Node 数据库（false = 还落 Python 的全局 json）。
   * 面板据此提示"换设备后配置还在不在"，以及要不要显示"全局共享"警示。
   */
  persistedServerSide: PERSISTED_SERVER_SIDE,

  /**
   * 读全部端点配置 + 当前激活那套。
   *
   * 🔴 免登录档直接返回空形状、不发请求：bypass 时后端没有真实会话，
   *    探过去只会 401，而 401 会走 http 的登录流 —— dev 档本就是要绕过登录的。
   *
   * @returns 面板形状的完整设置；免登录档 = 空列表的正常返回（**不是错误**）
   * @throws 中转档下 `nodeLlmApi.profiles()` 本身不抛，但网络异常仍可能冒到调用方
   */
  async settings(): Promise<LlmSettings> {
    if (!RETRO_VIA_NODE) return llmApi.settings();
    if (AUTH_BYPASS) return toPanelSettings([]);
    return toPanelSettings(await nodeLlmApi.profiles());
  },

  /**
   * 保存：直连档是**整包提交**（新建/改/删一次过），中转档是**逐条 upsert + 删多余**。
   *
   * @param payload `profiles` = 保存后的完整列表（面板按这个口径组装，
   *                **不在列表里的会被删掉**）；`active_profile` = 要设为生效的那套 id
   * @returns 保存后的完整设置（重新读一遍后端，不复用本地推断 —— id 与掩码都由后端定）
   * @throws 直连档：`llmApi.saveSettings` 不吞异常 ⇒ 抛 `RetroApiError`
   *         中转档：逐条 upsert 中任一条失败即抛出，⚠️ **已写入的不回滚**
   *         （Node 侧无事务；以再次 `settings()` 读到的为准，调用方应重新读一次）
   */
  async saveSettings(payload: {
    profiles?: LlmProfilePayload[];
    active_profile?: string;
  }): Promise<LlmSettings> {
    if (!RETRO_VIA_NODE) return llmApi.saveSettings(payload);

    const want = payload.profiles ?? [];
    const activeId = payload.active_profile ?? '';
    if (AUTH_BYPASS) return toPanelSettings([]);

    // 先取现有清单：既要拿到 id（新建的还没有），也要知道哪些该删
    const before = await nodeLlmApi.profiles();
    const beforeIds = new Set(before.map((p) => String(p.id)));
    const keepIds = new Set<string>();

    for (const p of want) {
      const isNew = !beforeIds.has(String(p.id)) || !/^\d+$/.test(String(p.id));
      // 🔴 active 的判定：面板传下来的 `active_profile` 是权威；它为空时兜底取第一套
      //    （Node 表每用户最多一套 active，没有它 LLM 调用就没有可用凭据）。
      const isActive = activeId ? String(p.id) === activeId : want.indexOf(p) === 0;
      const saved = await nodeLlmApi.saveProfile(
        panelToNode(
          {
            ...p,
            // 逐条 upsert 时，不能给「不在本列表里的旧 id」当更新目标
            id: isNew ? '' : String(p.id)
          },
          isActive
        ),
        isNew ? undefined : Number(p.id)
      );
      if (saved?.id !== undefined) keepIds.add(String(saved.id));
    }

    // 🔴 删掉面板里已移除的那些（整包提交语义：不在列表里 = 删掉）
    for (const p of before) {
      const id = String(p.id);
      if (!keepIds.has(id)) await nodeLlmApi.deleteProfile(p.id);
    }

    return toPanelSettings(await nodeLlmApi.profiles());
  },

  /**
   * 切换当前生效的端点配置。
   *
   * 中转档是「逐条 upsert」而不是「改一个 active 字段」—— Node 的 DAO 在
   * upsert 时会把该用户其它 active 清掉，所以传 `active: true` 即完成切换。
   *
   * @param id 目标配置 id
   * @returns 切换后的完整设置。⚠️ **id 不存在不是异常** —— 原样回传当前列表
   *          （调用方按"没这配置"处理，不要崩）；已经是 active 也直接短路返回
   * @throws 直连档走 `llmApi.activateProfile`，失败抛 `RetroApiError`；
   *         中转档的 upsert 失败同样向上抛
   */
  async activateProfile(id: string): Promise<LlmSettings> {
    if (!RETRO_VIA_NODE) return llmApi.activateProfile(id);
    if (AUTH_BYPASS) return toPanelSettings([]);

    const before = await nodeLlmApi.profiles();
    const target = before.find((p) => String(p.id) === String(id));
    if (!target) {
      // 找不到就把当前列表原样回传，让调用方按"没这配置"处理而不是崩
      return toPanelSettings(before);
    }
    if (target.active) return toPanelSettings(before);

    await nodeLlmApi.saveProfile(
      {
        name: target.name,
        base_url: target.base_url,
        model: target.model,
        // 🔴 `keys` 必须**不给**（undefined），绝不能给 `[]`：
        //    后端 `mergeKeys` 的语义是「undefined = 不动旧 key，空数组 = 显式清空」
        //    （与 Python 侧整包提交一致）。给 `[]` 会把切生效变成"清空密钥"。
        active: true,
        max_tokens: target.max_tokens ?? 0
      },
      target.id
    );
    return toPanelSettings(await nodeLlmApi.profiles());
  },

  /**
   * 重置这套配置的 key 轮换状态。
   *
   * 🔴 中转档**不支持**：轮换状态是 Python 进程内的运行时状态
   *    （`llm_settings.json` 旁边那份标记），Node 表里没有对应列，
   *    密钥又只存服务端不给前端 —— 没有可重置的东西。
   *    这里**显式抛错**而不是静默成功：静默成功会让用户以为重置了，
   *    下次 key 被打死时继续失败且查不出原因。
   *
   * @param id 要重置的配置 id（直连档）或空串（全部）
   * @returns 直连档：重置后的完整设置
   * @throws 中转档**必定抛** `Error('中转模式下密钥轮换状态由服务端管理，不支持手动重置')`
   *         —— 这是有意的失败，调用方应把它当"该功能在当前档位不存在"来提示
   */
  async resetKeys(id: string): Promise<LlmSettings> {
    if (!RETRO_VIA_NODE) return llmApi.resetKeys(id);
    throw new Error('中转模式下密钥轮换状态由服务端管理，不支持手动重置');
  }
};

export { endpointConfigApi };
