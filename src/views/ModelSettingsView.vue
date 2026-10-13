<script setup lang="ts">
/**
 * 模型设置 —— 桌面版的核心页面。
 *
 * 三件事，对应「模型后下载」的全部入口：
 *   ① 模型管理：下载 / 取消 / 删除 / 加载，进度条实时走 SSE
 *   ② 计算后端：CPU 与 GPU 切换；GPU 加速包（cu121）按需后装
 *   ③ 模型目录：展示路径、打开文件夹、说明手动放置的规则
 *
 * 🔴 本页只在**打包版**有意义：API-only 部署时这些端点不存在，
 *    页面会显示「非桌面模式」。判据是 /api/desktop/info 是否可达。
 *
 * @author yijiu2025
 * @since 2026-10-13
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  desktopApi,
  type DesktopInfo,
  type GpuProbe,
  type GpuStatus,
  type ModelDownloadRow
} from '@/api/retro/desktop';

const info = ref<DesktopInfo | null>(null);
const models = ref<ModelDownloadRow[]>([]);
const modelsDir = ref('');
const gpu = ref<GpuStatus | null>(null);
const probe = ref<GpuProbe | null>(null);
const probing = ref(false);
const compute = ref('auto');
const busy = ref(false);
let abort: AbortController | null = null;

const gpuPhaseText = computed(() => {
  const p = gpu.value?.phase || 'idle';
  const map: Record<string, string> = {
    idle: '未安装',
    resolving: '解析索引',
    downloading: '下载中',
    installing: '安装中',
    done: '已安装',
    error: '安装失败',
    canceled: '已取消',
    interrupted: '已中断'
  };
  return map[p] || p;
});

const gpuBusy = computed(() =>
  ['resolving', 'downloading', 'installing'].includes(gpu.value?.phase || '')
);

function fmtBytes(n: number): string {
  if (!n || n < 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function fmtSpeed(n: number): string {
  if (!n) return '';
  return `${fmtBytes(n)}/s`;
}

function fmtEta(sec: number): string {
  if (!sec || sec < 0) return '';
  if (sec >= 3600) return `剩余约 ${(sec / 3600).toFixed(1)} 小时`;
  if (sec >= 60) return `剩余约 ${Math.round(sec / 60)} 分钟`;
  return `剩余约 ${sec} 秒`;
}

function rowStatusText(row: ModelDownloadRow): string {
  if (row.installed) return '已安装';
  const map: Record<string, string> = {
    idle: '未下载',
    queued: '排队中',
    downloading: '下载中',
    extracting: '解压中',
    done: '完成',
    error: '失败',
    canceled: '已取消',
    interrupted: '已中断'
  };
  return map[row.phase] || row.phase;
}

function rowStatusType(row: ModelDownloadRow): 'success' | 'primary' | 'warning' | 'info' | 'danger' {
  if (row.installed) return 'success';
  if (row.phase === 'downloading') return 'primary';
  if (row.phase === 'extracting' || row.phase === 'queued') return 'warning';
  if (row.phase === 'error') return 'danger';
  return 'info';
}

function rowPercent(row: ModelDownloadRow): number {
  const total = row.total || row.zip_bytes;
  if (!total || !row.done) return 0;
  return Math.min(100, Math.round((row.done / total) * 100));
}

function errOf(e: unknown): string {
  const resp = (e as { response?: { data?: { error?: string } } })?.response?.data;
  return resp?.error || (e as Error)?.message || '操作失败';
}

async function refresh(): Promise<void> {
  try {
    const [dl, g] = await Promise.all([desktopApi.downloadStatus(), desktopApi.gpuStatus()]);
    models.value = dl.models;
    modelsDir.value = dl.models_dir;
    gpu.value = g;
  } catch (e) {
    ElMessage.error(errOf(e));
  }
}

function subscribeStreams(): void {
  abort = new AbortController();
  // SSE 断了就静默：下次手动刷新或动作后仍会拿到全量状态
  void desktopApi
    .streamDownloads((payload) => {
      models.value = payload.models;
    }, abort.signal)
    .catch(() => undefined);
  void desktopApi
    .streamGpu((payload) => {
      gpu.value = payload;
    }, abort.signal)
    .catch(() => undefined);
}

onMounted(async () => {
  try {
    info.value = await desktopApi.info();
    compute.value = info.value.compute;
  } catch {
    info.value = null;
  }
  await refresh();
  subscribeStreams();
});

onUnmounted(() => {
  abort?.abort();
});

async function onDownload(key: string): Promise<void> {
  busy.value = true;
  try {
    await desktopApi.startDownload(key);
    ElMessage.success('已开始下载，可离开本页，进度会保留');
  } catch (e) {
    ElMessage.error(errOf(e));
  } finally {
    busy.value = false;
  }
}

async function onCancelDownload(key: string): Promise<void> {
  await desktopApi.cancelDownload(key);
}

async function onRemove(key: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '删除后需要重新下载（约数 GB），确定删除该模型？',
      '确认删除',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  try {
    await desktopApi.removeModel(key);
    ElMessage.success('已删除');
    await refresh();
  } catch (e) {
    ElMessage.error(errOf(e));
  }
}

async function onLoad(key: string): Promise<void> {
  try {
    await desktopApi.loadModel(key);
    ElMessage.success('模型服务启动中，加载完约需 40~90 秒');
  } catch (e) {
    ElMessage.error(errOf(e));
  }
}

async function onSaveCompute(): Promise<void> {
  busy.value = true;
  try {
    await desktopApi.saveConfig({ compute: compute.value });
    const res = (await desktopApi.restartModelService()) as { restarted?: boolean };
    ElMessage.success(
      res.restarted ? '已保存并重启模型服务' : '已保存（模型服务未运行，下次加载时生效）'
    );
    await refresh();
  } catch (e) {
    ElMessage.error(errOf(e));
  } finally {
    busy.value = false;
  }
}

async function onGpuInstall(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将下载约 2.2GB 的 CUDA 12.1 版 PyTorch 及其组件（断点续传，可取消）。仅在使用 NVIDIA 显卡时需要。',
      '安装 GPU 加速包',
      { type: 'info' }
    );
  } catch {
    return;
  }
  try {
    await desktopApi.gpuInstall();
    ElMessage.success('开始安装，可离开本页，进度会保留');
  } catch (e) {
    ElMessage.error(errOf(e));
  }
}

async function onGpuCancel(): Promise<void> {
  await desktopApi.gpuCancel();
}

async function onGpuUninstall(): Promise<void> {
  try {
    await ElMessageBox.confirm('卸载后 GPU 加速不可用，需要时重新下载。确定卸载？', '确认卸载', {
      type: 'warning'
    });
  } catch {
    return;
  }
  try {
    await desktopApi.gpuUninstall();
    ElMessage.success('已卸载');
    await refresh();
  } catch (e) {
    ElMessage.error(errOf(e));
  }
}

async function onProbe(): Promise<void> {
  probing.value = true;
  try {
    probe.value = await desktopApi.gpuProbe();
  } catch (e) {
    ElMessage.error(errOf(e));
  } finally {
    probing.value = false;
  }
}

async function onOpenFolder(): Promise<void> {
  try {
    await desktopApi.openFolder(modelsDir.value || info.value?.models_dir || '');
    ElMessage.success('已在资源管理器中打开');
  } catch (e) {
    ElMessage.error(errOf(e));
  }
}

const NETDISK_URL = 'https://pan.baidu.com/s/5D5zka_-76R4bFa3YZqtMxQ';

function onOpenNetdisk(): void {
  // pywebview 里直接点 href 可能被拦，这里用 window.open 兜底；
  // 即使被拦，链接文本本身是可复制的明文。
  try {
    window.open(NETDISK_URL, '_blank');
  } catch {
    /* 忽略：用户可手动复制下方明文链接 */
  }
}

async function onCopyNetdisk(): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(NETDISK_URL);
      ElMessage.success('网盘链接已复制到剪贴板');
      return;
    }
  } catch {
    /* 忽略 */
  }
  // 退化方案：选中文本（桌面 WebView 通常支持）
  try {
    const el = document.querySelector('.ms-netdisk__link') as HTMLElement | null;
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  } catch {
    /* 忽略 */
  }
  ElMessage.info('请手动复制上方网盘链接');
}
</script>

<template>
  <section v-if="info" class="rw-card model-settings">
    <div class="rw-card__head">
      <div class="rw-card__title">模型设置</div>
    </div>
    <div class="rw-card__body">

      <el-alert
        v-if="gpu && gpu.backend && !gpu.backend.gpu_active && gpu.compute !== 'cpu'"
        type="info"
        :closable="false"
        show-icon
        title="当前使用 CPU 推理（单步预测约数十秒）。装有 NVIDIA 显卡的话，装完 GPU 加速包可快数量级。"
      />

      <!-- ① 模型管理 -->
      <div class="ms-block">
        <div class="ms-block__title">模型权重</div>
        <div class="ms-block__desc">
          首次使用先下载一个模型；也可以从官方渠道拿压缩包，按下面「模型目录」的规则手动放置。
        </div>
        <div v-for="row in models" :key="row.key" class="ms-model">
          <div class="ms-model__main">
            <div class="ms-model__name">
              {{ row.label }}
              <el-tag size="small" effect="plain" type="info">{{ row.kind === 'forward' ? '正向附件' : '逆向主模型' }}</el-tag>
            </div>
            <div class="ms-model__meta">
              压缩包约 {{ fmtBytes(row.zip_bytes) }}<template v-if="row.installed"> · 位于 {{ row.path }}</template>
            </div>
            <div v-if="row.phase === 'downloading'" class="ms-model__speed">
              {{ fmtSpeed(row.bytes_per_sec || 0) }} {{ fmtEta(row.eta_sec || 0) }}
            </div>
            <div v-if="row.error && row.phase !== 'downloading'" class="ms-model__error">{{ row.error }}</div>
          </div>
          <div class="ms-model__side">
            <el-tag :type="rowStatusType(row)" size="small">{{ rowStatusText(row) }}</el-tag>
            <div class="ms-model__ops">
              <el-button
                v-if="!row.installed && ['idle', 'error', 'canceled', 'interrupted'].includes(row.phase)"
                type="primary" size="small" :loading="busy" @click="onDownload(row.key)"
              >下载</el-button>
              <el-button
                v-if="['downloading', 'queued'].includes(row.phase)"
                size="small" @click="onCancelDownload(row.key)"
              >取消</el-button>
              <template v-if="row.installed">
                <el-button
                  v-if="row.kind === 'backward'"
                  type="primary" size="small" @click="onLoad(row.key)"
                >加载</el-button>
                <el-button size="small" type="danger" plain @click="onRemove(row.key)">删除</el-button>
              </template>
            </div>
          </div>
          <el-progress
            v-if="['downloading', 'extracting'].includes(row.phase)"
            :percentage="row.phase === 'extracting' ? 100 : rowPercent(row)"
            :status="row.phase === 'extracting' ? 'warning' : undefined"
            :stroke-width="10"
            :show-text="row.phase !== 'extracting'"
            class="ms-model__progress"
          />
        </div>
      </div>

      <!-- ② 计算后端 -->
      <div class="ms-block">
        <div class="ms-block__title">计算后端</div>
        <div class="ms-block__desc">
          切换后需要重启模型服务才生效（已加载的模型会重新加载）。GPU 加速包可稍后按需安装。
        </div>
        <el-radio-group v-model="compute">
          <el-radio-button value="auto">自动（有 GPU 包就用 GPU）</el-radio-button>
          <el-radio-button value="cpu">强制 CPU</el-radio-button>
          <el-radio-button value="gpu">强制 GPU</el-radio-button>
        </el-radio-group>
        <el-button class="ms-inline-btn" type="primary" size="small" :loading="busy" @click="onSaveCompute">
          保存并重启模型服务
        </el-button>

        <el-divider />

        <div class="ms-gpu">
          <div class="ms-gpu__row">
            <span class="ms-gpu__label">GPU 加速包（CUDA 12.1 · 约 {{ fmtBytes(gpu?.estimated_bytes || 0) }}）</span>
            <el-tag :type="gpu?.installed ? 'success' : 'info'" size="small">{{ gpuPhaseText }}</el-tag>
          </div>
          <div v-if="gpu?.installed" class="ms-gpu__row">
            <span class="ms-gpu__label">当前生效后端</span>
            <el-tag :type="gpu?.backend?.gpu_active ? 'success' : 'info'" size="small">
              {{ gpu?.backend?.gpu_active ? 'GPU 加速' : 'CPU' }}
            </el-tag>
          </div>
          <div v-if="gpu?.error" class="ms-model__error">{{ gpu.error }}</div>
          <el-progress
            v-if="gpuBusy"
            :percentage="gpu && gpu.total ? Math.min(100, Math.round((gpu.done / gpu.total) * 100)) : 0"
            :stroke-width="10"
            class="ms-model__progress"
          />
          <div v-if="gpuBusy" class="ms-model__speed">
            {{ fmtSpeed(gpu?.bytes_per_sec || 0) }} {{ fmtEta(gpu?.eta_sec || 0) }}
          </div>
          <div class="ms-gpu__ops">
            <el-button v-if="!gpu?.installed && !gpuBusy" type="primary" size="small" @click="onGpuInstall">
              下载并安装
            </el-button>
            <el-button v-if="gpuBusy" size="small" @click="onGpuCancel">取消安装</el-button>
            <el-button v-if="gpu?.installed && !gpuBusy" size="small" :loading="probing" @click="onProbe">
              检测本机 GPU
            </el-button>
            <el-button v-if="gpu?.installed && !gpuBusy" size="small" type="danger" plain @click="onGpuUninstall">
              卸载
            </el-button>
          </div>
          <el-alert
            v-if="probe"
            :type="probe.cuda_available ? 'success' : 'warning'"
            :closable="false"
            show-icon
            :title="probe.cuda_available
              ? `可用：${probe.device || 'NVIDIA GPU'}（torch ${probe.torch_version || '?'}）`
              : `不可用：${probe.reason || '未检测到 NVIDIA 显卡或驱动'}`"
          />
        </div>
      </div>

      <!-- ③ 模型目录 -->
      <div class="ms-block">
        <div class="ms-block__title">模型目录</div>
        <div class="ms-block__desc">
          所有模型权重放在这里。手动放置时目录名必须与软件内显示的名称一致。
        </div>
        <div class="ms-netdisk">
          <span class="ms-netdisk__label">官方模型网盘（百度）</span>
          <a
            class="ms-netdisk__link"
            href="https://pan.baidu.com/s/5D5zka_-76R4bFa3YZqtMxQ"
            target="_blank"
            rel="noopener"
            @click="onOpenNetdisk"
          >https://pan.baidu.com/s/5D5zka_-76R4bFa3YZqtMxQ</a>
          <el-button size="small" @click="onCopyNetdisk">复制链接</el-button>
        </div>
        <div class="ms-dir">
          <code>{{ modelsDir || info.models_dir }}</code>
          <el-button size="small" @click="onOpenFolder">打开文件夹</el-button>
        </div>
        <el-collapse>
          <el-collapse-item title="手动放置模型的规则">
            <ol class="ms-manual">
              <li>从官方模型网盘下载压缩包：上方「官方模型网盘（百度）」链接（或手动放置时见
                <code>data/models/把模型放这里.txt</code>）。也可以点本页「下载」按钮（figshare 直链）。</li>
              <li>解压到上面的目录，zip 内是平铺文件，目标形如
                <code>&lt;模型目录&gt;/retrochimera_pistachio/</code>（注意别套两层同名目录）。</li>
              <li>回本页点「加载」。目录名：<code>retrochimera_pistachio</code>、
                <code>retrochimera_uspto50k</code>、<code>retrochimera_uspto_full</code>、
                <code>forwardchimera_denovo_pistachio</code>。</li>
              <li>想把模型放到别的盘：退出软件，设环境变量
                <code>RETRO_MODELS_DIR</code> 指向目标目录，再启动。</li>
            </ol>
          </el-collapse-item>
        </el-collapse>
      </div>

    </div>
  </section>

  <section v-else class="rw-card">
    <div class="rw-card__head"><div class="rw-card__title">模型设置</div></div>
    <div class="rw-card__body">
      <el-empty description="当前不是桌面打包模式（/api/desktop/info 不可达），模型管理请在部署环境中进行" />
    </div>
  </section>
</template>

<style scoped>
.model-settings {
  max-width: 920px;
}

.ms-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 0 4px;
}

.ms-block + .ms-block {
  border-top: 1px solid var(--rw-border, rgba(0, 0, 0, 0.08));
}

.ms-block__title {
  font-size: 15px;
  font-weight: 500;
}

.ms-block__desc {
  font-size: 12px;
  color: var(--rw-text-3);
  line-height: 1.6;
}

.ms-inline-btn {
  align-self: flex-start;
  margin-top: 4px;
}

.ms-model {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px 16px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid var(--rw-border, rgba(0, 0, 0, 0.08));
  border-radius: 8px;
}

.ms-model__name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}

.ms-model__meta,
.ms-model__speed {
  font-size: 12px;
  color: var(--rw-text-3);
  margin-top: 2px;
}

.ms-model__error {
  font-size: 12px;
  color: var(--el-color-danger);
  margin-top: 4px;
  word-break: break-all;
}

.ms-model__side {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ms-model__ops {
  display: flex;
  gap: 6px;
}

.ms-model__progress {
  grid-column: 1 / -1;
}

.ms-gpu {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ms-gpu__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.ms-gpu__ops {
  display: flex;
  gap: 8px;
}

.ms-dir {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.ms-netdisk {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--el-color-primary, #409eff);
  border-radius: 8px;
  background: var(--rw-bg-2, rgba(64, 158, 255, 0.06));
  font-size: 12px;
}

.ms-netdisk__label {
  font-weight: 500;
}

.ms-netdisk__link {
  flex: 1;
  min-width: 220px;
  color: var(--el-color-primary, #409eff);
  text-decoration: underline;
  word-break: break-all;
  cursor: pointer;
}

.ms-dir code {
  flex: 1;
  padding: 6px 10px;
  background: var(--rw-bg-2, rgba(0, 0, 0, 0.04));
  border-radius: 6px;
  word-break: break-all;
}

.ms-manual {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--rw-text-2);
  line-height: 1.9;
}

.ms-manual code {
  padding: 1px 5px;
  background: var(--rw-bg-2, rgba(0, 0, 0, 0.04));
  border-radius: 4px;
}
</style>
