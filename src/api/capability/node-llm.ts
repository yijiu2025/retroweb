/**
 * LLM 双来源 API（Node 后端 `/retroweb/v1`，绑定用户）。
 *
 * 与 `api/retro/llm.ts` 里的 `llmApi` 是**两套**：
 *   · `llmApi`（retro/llm.ts）—— 直连 Python 的 `/llm/*`，配置存 web/llm_settings.json；
 *   · 这里的 `nodeLlmApi` —— 走 Node 后端 `/llm/profiles` + `/llm/official`，
 *     密钥加密落库（per-user）、官方 token 永不回传。
 *
 * 走 Node 中转（RETRO_VIA_NODE）时，前端 LLM 配置面板改读这里；否则仍用 llmApi。
 *
 * 🔴 **本文件是能力层的一部分，不该被 UI 直接调用**：跨档位分派由
 *    `./endpoint-config.ts` 负责（它内部才调这里的 `nodeLlmApi`）。
 *
 * 🔴 官方模型只有 name/model/quota/enabled —— token 的数量与值、base_url 都不出后端，
 *    前端「官方」选项只是一个「选它、后端自己出 key」的占位，看不到任何凭据。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
import { apiClient } from '@/api/http';
import type { LlmSource, NodeLlmProfile, OfficialLlm, RetrowebSettings } from '@/types/retro';

const nodeLlmApi = {
  /**
   * 用户自建配置列表（key 只回掩码）。
   *
   * @returns 配置清单；**失败 resolve 空数组**（不抛）—— 面板在无权限/后端未起时
   *          应显示"还没有配置"，而不是一条错误条盖住整个面板
   */
  async profiles(): Promise<NodeLlmProfile[]> {
    try {
      const data = await apiClient.get<{ profiles: NodeLlmProfile[] }>('/retroweb/v1/llm/profiles');
      return Array.isArray(data?.profiles) ? data.profiles : [];
    } catch {
      return [];
    }
  },

  /**
   * 保存/更新一条用户自建配置。
   *
   * 🔴 `keys` **可以不传**（undefined）：后端 `mergeKeys` 的约定是
   *    「undefined = 不动旧 key；空数组 = 显式清空」。
   *    只改地址/模型名/切换生效时**必须省略**，传 `[]` 会把密钥清掉。
   * @param input  { name, base_url, model, keys?, active, max_tokens }
   *   ⚠️ `active: true` 会把该用户其它 active 清掉（DAO 语义），等于"切换生效"
   * @param id 有则更新这条；省略 = 新建
   * @returns 保存后的那条记录（`key_masked` 为掩码，**永远拿不到明文**）
   * @throws 网络/后端错误时抛 Error；🔴 与 `profiles()` 不同，本方法**不吞异常**
   *         —— 保存失败必须让用户看见
   */
  async saveProfile(
    input: {
      name: string;
      base_url: string;
      model: string;
      keys?: string[];
      active?: boolean;
      max_tokens?: number;
    },
    id?: number
  ): Promise<NodeLlmProfile> {
    const body: Record<string, unknown> = { id, ...input };
    // undefined 的键不参与序列化 —— 与「不传」等价
    if (input.keys === undefined) delete body.keys;
    const data = await apiClient.post<{ profile: NodeLlmProfile }>('/retroweb/v1/llm/profiles', body);
    return data.profile;
  },

  /**
   * 删除一条用户自建配置。
   *
   * @param id 配置 id（数字，Node 表主键）
   * @returns 无（void）；后端受理后配置即不可见
   * @throws 网络/后端错误时抛 Error
   */
  async deleteProfile(id: number): Promise<void> {
    await apiClient.delete(`/retroweb/v1/llm/profiles/${id}`);
  },

  /**
   * 官方模型清单（只回 name/model/quota/enabled）。
   *
   * 🔴 token 的**数量与值、base_url 都不出后端** —— 前端选"官方"只是选一个占位，
   *    凭据由后端在调用时注入。所以这里拿不到任何可用于调试的 key 信息。
   *
   * @returns 官方模型清单；失败 resolve 空数组
   */
  async official(): Promise<OfficialLlm[]> {
    try {
      const data = await apiClient.get<{ models: OfficialLlm[] }>('/retroweb/v1/llm/official');
      return Array.isArray(data?.models) ? data.models : [];
    } catch {
      return [];
    }
  },

  /**
   * 读用户设置（含 llm_source：走官方还是自建）。
   *
   * @returns 设置对象；失败 resolve `{}`（缺字段按默认值处理，不抛）
   */
  async getSettings(): Promise<RetrowebSettings> {
    try {
      const data = await apiClient.get<{ settings: RetrowebSettings }>('/retroweb/v1/settings');
      return data?.settings ?? {};
    } catch {
      return {};
    }
  },

  /**
   * 切 LLM 来源（官方 / 自建）。
   *
   * @param source 目标来源
   * @returns **后端确认后的**来源（以后端为准，不回显入参）
   * @throws 网络/后端错误时抛 Error；⚠️ 本方法不吞异常（来源切换失败用户必须知道）
   */
  async setLlmSource(source: LlmSource): Promise<LlmSource> {
    const data = await apiClient.post<{ llm_source: LlmSource }>(
      '/retroweb/v1/settings/llm-source',
      { source }
    );
    return data.llm_source;
  }
};

export { nodeLlmApi };
