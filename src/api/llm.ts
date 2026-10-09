/**
 * LLM 双来源 API（Node 后端 `/retroweb/v1`，绑定用户）。
 *
 * 与 `retro.ts` 里的 `llmApi` 是**两套**：
 *   · `llmApi`（retro.ts）—— 直连 Python 的 `/llm/*`，配置存 web/llm_settings.json；
 *   · 这里的 `nodeLlmApi` —— 走 Node 后端 `/llm/profiles` + `/llm/official`，
 *     密钥加密落库（per-user）、官方 token 永不回传。
 *
 * 走 Node 中转（RETRO_VIA_NODE）时，前端 LLM 配置面板改读这里；否则仍用 llmApi。
 *
 * 🔴 官方模型只有 name/model/quota/enabled —— token 的数量与值、base_url 都不出后端，
 *    前端「官方」选项只是一个「选它、后端自己出 key」的占位，看不到任何凭据。
 */
import { apiClient } from '@/api/http';
import type { LlmSource, NodeLlmProfile, OfficialLlm, RetrowebSettings } from '@/types/retro';

export const nodeLlmApi = {
  /** 用户自建配置列表（key 只回掩码） */
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
   * @param input { name, base_url, model, keys: string[], active, max_tokens }
   * @param id 有则更新
   */
  async saveProfile(
    input: {
      name: string;
      base_url: string;
      model: string;
      keys: string[];
      active?: boolean;
      max_tokens?: number;
    },
    id?: number
  ): Promise<NodeLlmProfile> {
    const data = await apiClient.post<{ profile: NodeLlmProfile }>('/retroweb/v1/llm/profiles', {
      id,
      ...input
    });
    return data.profile;
  },

  /** 删除一条用户自建配置 */
  async deleteProfile(id: number): Promise<void> {
    await apiClient.delete(`/retroweb/v1/llm/profiles/${id}`);
  },

  /** 官方模型清单（只回 name/model/quota/enabled） */
  async official(): Promise<OfficialLlm[]> {
    try {
      const data = await apiClient.get<{ models: OfficialLlm[] }>('/retroweb/v1/llm/official');
      return Array.isArray(data?.models) ? data.models : [];
    } catch {
      return [];
    }
  },

  /** 读用户设置（含 llm_source） */
  async getSettings(): Promise<RetrowebSettings> {
    try {
      const data = await apiClient.get<{ settings: RetrowebSettings }>('/retroweb/v1/settings');
      return data?.settings ?? {};
    } catch {
      return {};
    }
  },

  /** 切 LLM 来源（官方 / 自建） */
  async setLlmSource(source: LlmSource): Promise<LlmSource> {
    const data = await apiClient.post<{ llm_source: LlmSource }>(
      '/retroweb/v1/settings/llm-source',
      { source }
    );
    return data.llm_source;
  }
};
