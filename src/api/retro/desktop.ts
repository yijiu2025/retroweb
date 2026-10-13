/**
 * 桌面版专用 API —— 「模型设置」页的传输层。
 *
 * 与 `./compute` / `./llm` 的分工：那两个面向**业务**（预测 / 搜索 / 工艺分析），
 * 本文件面向**环境自身**（模型下载 / GPU 包 / 计算后端 / 打开文件夹），
 * 只在打包版存在；API-only 部署时这些端点本来就不存在。
 *
 * 🔴 所有请求走同源相对路径（桌面版 Flask 同端口托管前端），
 *    因此复用 `retroClient`（baseURL 即 `/api`），不新建实例。
 *
 * @author yijiu2025
 * @since 2026-10-13
 */
import { retroClient } from './client';

/** 一个模型的下载状态行（GET /api/models/download/status） */
interface ModelDownloadRow {
  key: string;
  label: string;
  /** backward = 逆向搜索主模型；forward = 可行性过滤附件 */
  kind: 'backward' | 'forward';
  path: string;
  /** 压缩包大小（0 = 未知） */
  zip_bytes: number;
  installed: boolean;
  /** idle | queued | downloading | extracting | done | error | canceled | interrupted */
  phase: string;
  done: number;
  total: number;
  error: string;
  bytes_per_sec?: number;
  eta_sec?: number;
  updated_at: number;
}

/** GPU 加速包状态（GET /api/gpu/status） */
interface GpuStatus {
  phase: string;
  error: string;
  installed: boolean;
  installed_bytes: number;
  estimated_bytes: number;
  compute: 'auto' | 'cpu' | 'gpu';
  gpu_pkgs_dir: string;
  done: number;
  total: number;
  bytes_per_sec?: number;
  eta_sec?: number;
  wheels: Array<{ name: string; file: string; done: number; total: number; state: string }>;
  backend: { gpu_active: boolean; reason: string; compute?: string };
}

/** 桌面信息（GET /api/desktop/info） */
interface DesktopInfo {
  app: string;
  version: string;
  pkg_root: string;
  models_dir: string;
  frontend_dir: string;
  frontend_ok: boolean;
  python: string;
  compute: string;
  rule_workers: number;
}

/** GPU 探测结果（GET /api/gpu/probe） */
interface GpuProbe {
  gpu_installed: boolean;
  cuda_available: boolean;
  torch_version?: string;
  device?: string;
  reason: string;
}

/**
 * 订阅一个 SSE 端点（进度推送）。
 *
 * 为什么用 fetch 而不是 EventSource：EventSource 不能带自定义头、
 * 也不能传 AbortSignal，而本项目所有请求都要 withCredentials
 * （跨源不带 cookie 会 401，见 client.ts 的口径）。
 */
async function streamSse(
  url: string,
  onData: (payload: never) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await fetch(url, { credentials: 'include', signal });
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            onData(JSON.parse(line.slice(6)) as never);
          } catch {
            /* 心跳注释行或半包 JSON：忽略即可，下一包会带上全量状态 */
          }
        }
      }
      idx = buf.indexOf('\n\n');
    }
  }
}

const desktopApi = {
  info(): Promise<DesktopInfo> {
    return retroClient.get<DesktopInfo>('/desktop/info').then((r) => r.data);
  },

  saveConfig(patch: { compute?: string; rule_workers?: number }): Promise<unknown> {
    return retroClient.post('/desktop/config', patch).then((r) => r.data);
  },

  restartModelService(): Promise<unknown> {
    return retroClient.post('/desktop/restart-model-service', {}).then((r) => r.data);
  },

  downloadStatus(): Promise<{ models: ModelDownloadRow[]; models_dir: string }> {
    return retroClient.get<{ models: ModelDownloadRow[]; models_dir: string }>(
      '/models/download/status'
    ).then((r) => r.data);
  },

  startDownload(key: string): Promise<unknown> {
    return retroClient.post('/models/download', { key }).then((r) => r.data);
  },

  cancelDownload(key: string): Promise<unknown> {
    return retroClient.post('/models/download/cancel', { key }).then((r) => r.data);
  },

  removeModel(key: string): Promise<unknown> {
    return retroClient.post('/models/remove', { key }).then((r) => r.data);
  },

  /** 加载 / 切换模型（复用主流程的 /api/load，加载 40~90s，之后轮询 /api/models） */
  loadModel(key: string): Promise<unknown> {
    return retroClient.post('/load', { model: key }).then((r) => r.data);
  },

  gpuStatus(): Promise<GpuStatus> {
    return retroClient.get<GpuStatus>('/gpu/status').then((r) => r.data);
  },

  gpuProbe(): Promise<GpuProbe> {
    return retroClient.get<GpuProbe>('/gpu/probe').then((r) => r.data);
  },

  gpuInstall(): Promise<unknown> {
    return retroClient.post('/gpu/install', {}).then((r) => r.data);
  },

  gpuCancel(): Promise<unknown> {
    return retroClient.post('/gpu/cancel', {}).then((r) => r.data);
  },

  gpuUninstall(): Promise<unknown> {
    return retroClient.post('/gpu/uninstall', {}).then((r) => r.data);
  },

  openFolder(path: string): Promise<unknown> {
    return retroClient.post('/system/open-folder', { path }).then((r) => r.data);
  },

  streamDownloads(
    onData: (payload: { models: ModelDownloadRow[] }) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamSse('/api/models/download/stream', onData as (p: never) => void, signal);
  },

  streamGpu(
    onData: (payload: GpuStatus) => void,
    signal?: AbortSignal
  ): Promise<void> {
    return streamSse('/api/gpu/stream', onData as (p: never) => void, signal);
  }
};

export type { DesktopInfo, GpuProbe, GpuStatus, ModelDownloadRow };
export { desktopApi };
