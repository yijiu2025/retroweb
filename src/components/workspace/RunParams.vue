<script setup lang="ts">
/**
 * 运行参数（预测设置 / 拆分约束 / 大模型设置 / 条件方案 / 分析模块）+ 模型预热。
 *
 * 🔴 「自动往下拆 K 层」**不在这里**：它是「开始一个任务」时的动作，已挪到
 *    新建逆合成分析面板（TargetSetupPanel）底部；「拆分约束」这组参数因此要显式
 *    注明「仅多步拆分生效」—— 否则用户会以为它管的是手动单步展开。
 *    内部实现仍是**串行多次调用同一个单步接口**（`/api/predict`，不是 `/api/search`），
 *    每步取 Top-1，随时可停止，受「最大深度」与「调用预算」双重约束。
 *
 * 🔴 本组件有两个宿主，两种形态：
 *    ① **标定卡片内**（TargetSetupPanel）—— 自带 `.rw-card` 边框与标题；
 *    ② **右辅助面板内**（AsidePanel）—— 面板已经给了标题「运行参数」和外框，
 *       这里必须用 `embedded` 关掉自己那层卡壳，否则会出现
 *       「运行参数 / 运行参数」两行标题叠在一起（实测踩过）。
 *    判据是显式 prop，**不要靠 CSS 去猜父容器** —— 猜错就是重复标题或彻底没标题。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { retroApi, llmApi } from '@/api/retro';
import { useWorkspaceStore, ALL_ANALYSIS_MODULES, ANALYSIS_MODULE_LABELS } from '@/stores/workspace';
import { countHeavyAtoms } from '@/utils/smiles';
import { isRdkitReady, needsBackendParse, parseStructure } from '@/utils/rdkit';
import type { LlmKeyState } from '@/types/retro';

/** true = 已被外层容器（右辅助面板）接管标题与外框，本组件只出内容 */
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const store = useWorkspaceStore();
const materialInput = ref('');
const addingMaterial = ref(false);
const probing = ref(false);

// ---------- 大模型状态（区分「填了」和「真的能用」） ----------
const llmProbe = computed(() => store.llmStatus?.probe);

const llmTagType = computed<'success' | 'warning' | 'danger' | 'info'>(() => {
  const st = store.llmStatus;
  if (!st?.configured) return 'info';
  const p = llmProbe.value;
  if (!p) return 'warning'; // 已填但未验证
  return p.verified ? 'success' : 'danger';
});

const llmTagText = computed(() => {
  const st = store.llmStatus;
  if (!st?.configured) return '未配置';
  const p = llmProbe.value;
  if (!p) return `${st.model || '已配置'}（未验证）`;
  if (p.verified) return p.model || st.model || '可用';
  return '验证失败';
});

const llmTooltip = computed(() => {
  const st = store.llmStatus;
  if (!st?.configured) return st?.hint || '未配置大模型（在下方「API 设置」里填写并保存）';
  const p = llmProbe.value;
  if (!p) return `已读取配置：${st.model}\n点「验证」真发一次最小请求，确认 key 与模型可用`;
  if (p.verified) return `已验证可用：${p.model}（${p.key || '当前 key'}）\n${p.base_url || ''}`;
  return `验证失败：${p.error || '未知错误'}`;
});

/** 「验证」按钮：只在用户主动点击时才真打网络（网关有限流，别自动打） */
async function verifyLlm(): Promise<void> {
  probing.value = true;
  try {
    await store.loadLlmStatus(true);
    const p = store.llmStatus?.probe;
    if (p?.verified) ElMessage.success(`大模型可用：${p.model}（${p.key || 'key'}）`);
    else if (store.llmStatus?.configured) ElMessage.error(p?.error || '大模型验证失败');
    else ElMessage.warning(store.llmStatus?.hint || '大模型未配置');
  } finally {
    probing.value = false;
  }
}

// ---------- API 设置（接口地址 / 模型 / token / 多 Key 轮换） ----------
// 编辑态草稿：加载后改这里，点「保存设置」才 POST。keys 保存脱敏串（含 * = 保留原 key），
// 新增的 key 是明文 —— 后端按「含 * 与否」区分保留/新增，往返无损。
const draft = ref({
  base_url: '',
  model: '',
  max_tokens: 32768,
  temperature: 0.3,
  timeout: 300,
  keys: [] as string[]
});
const keyStates = ref<LlmKeyState[]>([]);
const savingSettings = ref(false);
const newKey = ref('');
const modelOptions = ref<string[]>([]);
const loadingModels = ref(false);

function keyStateOf(masked: string): LlmKeyState | undefined {
  // 🔴 按脱敏串匹配，不按下标：draft.keys 里可能有「还没保存」的明文 key，
  //     而服务端 keyStates 只覆盖已保存的池 —— 按下标对齐会错位。
  return keyStates.value.find((s) => s.masked === masked);
}
type TagKind = 'success' | 'warning' | 'danger' | 'info';
function keyTagType(s?: LlmKeyState): TagKind {
  if (!s) return 'info';
  return s.state === 'active' ? 'success' : s.state === 'bad' ? 'danger' : s.state === 'cooldown' ? 'warning' : 'info';
}
function keyTagText(s?: LlmKeyState): string {
  if (!s) return '—';
  return s.state === 'active' ? '使用中' : s.state === 'bad' ? '失效' : s.state === 'cooldown' ? '冷却中' : '备用';
}
const hasDisabledKey = computed(() => keyStates.value.some((k) => k.state === 'bad' || k.state === 'cooldown'));

async function loadSettings(): Promise<void> {
  const s = await llmApi.settings();
  if (!s.ok) return;
  draft.value = {
    base_url: s.base_url,
    model: s.model,
    max_tokens: s.max_tokens,
    temperature: s.temperature,
    timeout: s.timeout,
    keys: s.keys.map((k) => k.masked)
  };
  keyStates.value = s.keys;
}

/** 拉取该 key 可见的模型列表（供「模型」下拉切换；列表 ≠ 套餐内可用，见 tooltip） */
async function refreshModels(): Promise<void> {
  loadingModels.value = true;
  try {
    const r = await llmApi.models();
    if (r.ok) modelOptions.value = r.models;
    else ElMessage.warning(r.error || '拉取模型列表失败');
  } finally {
    loadingModels.value = false;
  }
}
function onModelDropdown(visible: boolean): void {
  if (visible && !modelOptions.value.length) void refreshModels();
}

function addKey(): void {
  const k = newKey.value.trim();
  if (!k) return;
  if (draft.value.keys.includes(k)) {
    ElMessage.info('该 Key 已在列表中');
    newKey.value = '';
    return;
  }
  draft.value.keys.push(k);
  newKey.value = '';
}

async function saveSettings(): Promise<void> {
  if (!draft.value.base_url.trim() || !draft.value.model.trim() || !draft.value.keys.length) {
    ElMessage.warning('接口地址、模型、至少一个 API Key 都必填');
    return;
  }
  savingSettings.value = true;
  try {
    const out = await llmApi.saveSettings({
      base_url: draft.value.base_url.trim(),
      model: draft.value.model.trim(),
      max_tokens: draft.value.max_tokens,
      temperature: draft.value.temperature,
      timeout: draft.value.timeout,
      api_keys: draft.value.keys
    });
    keyStates.value = out.keys;
    draft.value.keys = out.keys.map((k) => k.masked);
    await store.loadLlmStatus(false); // 顶部「AI 工艺分析」状态标签立即刷新
    ElMessage.success('大模型设置已保存（立即生效，无需重启）');
  } catch (e) {
    ElMessage.error((e as Error).message || '保存失败');
  } finally {
    savingSettings.value = false;
  }
}

async function resetKeys(): Promise<void> {
  try {
    const out = await llmApi.resetKeys();
    // 🔴 只更新状态标签，**不覆盖 draft.keys** —— 草稿里可能有还没保存的新增 key，
    //     用服务端列表覆盖会把它弄丢（实测踩过）。
    keyStates.value = out.keys;
    ElMessage.success('已清除失效/冷却标记，全部 Key 重新可用');
  } catch (e) {
    ElMessage.error((e as Error).message || '重置失败');
  }
}

// ---------- 分析模块勾选 ----------
const modules = computed(() => store.analysisModules);
const moduleOptions = ALL_ANALYSIS_MODULES.map((k) => ({ key: k, label: ANALYSIS_MODULE_LABELS[k] }));

/** 全选：恢复成默认全部模块 */
function selectAllModules(): void {
  store.analysisModules = [...ALL_ANALYSIS_MODULES];
}
/** 清空：只留「总述+反应类型」这一项兜底（后端永远带上） */
function clearModules(): void {
  store.analysisModules = [];
}
const allSelected = computed(() => store.analysisModules.length === ALL_ANALYSIS_MODULES.length);

/** 勾选/取消某个模块 */
function toggleModule(key: string, checked: boolean): void {
  const set = new Set(store.analysisModules);
  if (checked) set.add(key as (typeof ALL_ANALYSIS_MODULES)[number]);
  else set.delete(key as (typeof ALL_ANALYSIS_MODULES)[number]);
  // 按固定顺序回写，保证展示/请求顺序稳定
  store.analysisModules = ALL_ANALYSIS_MODULES.filter((k) => set.has(k));
}

/**
 * 指定起始物料：先把输入规范化成 canonical SMILES，再按 canonical 比对去重。
 * 规范化走**前端 RDKit**（同 TargetInput 的分工）：纯 SMILES/MOL 不必打网络；
 * 只有 CDXML 这种浏览器版 RDKit 读不了的才回落后端 `/api/parse`。
 */
async function addMaterial(): Promise<void> {
  const raw = materialInput.value.trim();
  if (!raw) return;
  addingMaterial.value = true;
  try {
    const useBackend = needsBackendParse(raw);
    if (!useBackend && !isRdkitReady()) {
      // 与 TargetInput 一致：首次要拉 7.4MB 引擎，先说一声，别让人以为卡死
      ElMessage.info('首次解析需加载前端解析引擎（约 7MB），请稍候…');
    }
    const res = useBackend ? await retroApi.parse(raw) : await parseStructure(raw);
    if (!res.ok) {
      ElMessage.error(res.reasons?.[0] || res.error || '无法解析该起始物料');
      return;
    }
    if (store.params.startingMaterials.includes(res.smiles)) {
      ElMessage.info('该起始物料已在列表中');
    } else {
      store.params.startingMaterials = [...store.params.startingMaterials, res.smiles];
    }
    materialInput.value = '';
  } catch (e) {
    ElMessage.error((e as Error).message);
  } finally {
    addingMaterial.value = false;
  }
}

function removeMaterial(smiles: string): void {
  store.params.startingMaterials = store.params.startingMaterials.filter((s) => s !== smiles);
}

onMounted(() => {
  if (!store.models.length) void store.loadModels();
  void loadSettings(); // API 设置草稿（后端 llm_settings.json 的脱敏回显）
});
</script>

<template>
  <section class="rw-card params" :class="{ 'params--embedded': embedded }">
    <div v-if="!embedded" class="rw-card__head">
      <div class="rw-card__title">运行参数</div>
      <el-tag v-if="store.autoRunning" type="warning" size="small" effect="dark">运行中</el-tag>
    </div>

    <div class="rw-card__body params__body">
      <!-- 嵌入模式：面板标题行已经在跑，这里补一个运行中角标就够 -->
      <div v-if="embedded && store.autoRunning" class="params__flag">
        <el-tag type="warning" size="small" effect="dark">自动拆分运行中</el-tag>
      </div>

      <!-- 分组一：预测设置（最常改的两个） -->
      <details class="params__group" open>
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 4.5 6 8l-3 3.5M8 4.5 11 8l-3 3.5" />
            </svg>
            预测设置
          </span>
          <span class="params__group-meta">{{ store.params.model }}</span>
        </summary>
        <div class="params__group-body">
          <div class="params__row">
            <label>预测模型</label>
            <div class="params__model">
              <el-select v-model="store.params.model" size="small" :loading="store.modelsLoading">
                <el-option
                  v-for="m in store.models"
                  :key="m.key"
                  :label="m.loaded ? `${m.label}（已加载）` : m.label"
                  :value="m.key"
                />
              </el-select>
              <el-button
                size="small"
                :loading="store.modelLoadingKey === store.params.model"
                @click="store.warmModel()"
              >
                预热
              </el-button>
            </div>
          </div>

          <div class="params__row">
            <label>每步候选数</label>
            <el-input-number v-model="store.params.numResults" :min="1" :max="20" size="small" />
          </div>
        </div>
      </details>

      <!-- 分组二：拆分约束（**只在多步拆分时用得上**，默认收起） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 3h12M2 8h12M2 13h8" />
            </svg>
            拆分约束
            <span class="params__scope-tag">多步拆分</span>
          </span>
          <span class="params__group-meta">
            深度 {{ store.params.maxDepth }} · 预算 {{ store.params.budgetCalls }}
          </span>
        </summary>
        <div class="params__group-body">
          <!-- 这一句是必须的：单步「展开」不受任何约束，用户很容易以为把深度调小
               就能限制手动展开 —— 那只会让人以为参数失灵 -->
          <p class="params__note">
            以下约束<strong>只在「多步拆分」时生效</strong>（新建分析界面里的「自动往下拆 N 层」）：
            深度与预算决定它拆到哪收手、何时改用起始物料。
            <br />手动单步「展开 / 采纳候选」不受这些限制。
          </p>

          <div class="params__row">
            <label>自动拆分最大深度</label>
            <el-input-number v-model="store.params.maxDepth" :min="1" :max="8" size="small" />
          </div>

          <div class="params__row">
            <label>
              可购买重原子阈值
              <el-tooltip content="重原子数 ≤ 该值即视为起始物料并停止往下拆" placement="top">
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <el-input-number v-model="store.params.heavyAtomThreshold" :min="1" :max="40" size="small" />
          </div>

          <div class="params__row">
            <label>调用预算（次）</label>
            <el-input-number v-model="store.params.budgetCalls" :min="1" :max="200" size="small" />
          </div>

          <div class="params__row params__row--col">
            <label>指定起始物料</label>
            <div class="params__materials">
              <el-input
                v-model="materialInput"
                size="small"
                placeholder="输入 SMILES 后回车，命中即停止拆分"
                @keyup.enter="addMaterial"
              />
              <el-button size="small" :loading="addingMaterial" @click="addMaterial">添加</el-button>
            </div>
            <div v-if="store.params.startingMaterials.length" class="params__tags">
              <el-tag
                v-for="s in store.params.startingMaterials"
                :key="s"
                size="small"
                closable
                type="success"
                effect="light"
                @close="removeMaterial(s)"
              >
                {{ s.length > 22 ? s.slice(0, 22) + '…' : s }}
                <i class="params__tag-atoms">{{ countHeavyAtoms(s) }} 原子</i>
              </el-tag>
            </div>
          </div>
        </div>
      </details>

      <!-- 分组三：大模型设置（状态 + 接口地址 / 模型 / token / 多 Key 轮换，合并成一组） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.5a3 3 0 0 0-3 3c0 1.2.7 2.3 1.7 2.8L5 13.5h6L9.3 7.3A3 3 0 0 0 11 4.5a3 3 0 0 0-3-3Z" />
            </svg>
            大模型设置
          </span>
          <el-tag size="small" :type="llmTagType" effect="light" class="params__group-tag">
            {{ llmTagText }}
          </el-tag>
        </summary>
        <div class="params__group-body">
          <!-- 大模型状态：当前 key 与模型是否可用 + 真发一次最小请求验证 -->
          <div class="params__row">
            <label>
              大模型状态
              <el-tooltip
                content="在「每步流程」里让大模型给出投料顺序、当量、条件、副产物、LCMS/NMR。接口地址 / 模型 / API Key 在下方配置"
                placement="top"
              >
                <span class="params__hint">?</span>
              </el-tooltip>
            </label>
            <div class="params__llm">
              <el-tooltip :content="llmTooltip" placement="top" :show-after="200">
                <el-tag size="small" :type="llmTagType" effect="light">{{ llmTagText }}</el-tag>
              </el-tooltip>
              <el-button size="small" text :loading="probing" @click="verifyLlm">
                {{ probing ? '验证中' : '验证' }}
              </el-button>
            </div>
          </div>

          <!-- API 设置：保存到后端 llm_settings.json（优先级高于 .env），改完立即生效 -->
          <div class="params__row params__row--col">
            <div class="params__modules-head">
              <label>
                API 设置
                <el-tooltip
                  content="保存在后端 web/llm_settings.json，优先级高于 .env，改完立即生效。可配置多个 API Key：请求失败（Key 失效 / 限流 / 额度不足）时自动切换下一个，无需手动干预"
                  placement="top"
                >
                  <span class="params__hint">?</span>
                </el-tooltip>
              </label>
            </div>
            <div class="params__api">
              <div class="params__api-field">
                <span class="params__api-label">接口地址（OpenAI 兼容）</span>
                <el-input
                  v-model="draft.base_url"
                  size="small"
                  placeholder="https://api.example.com/v1"
                  clearable
                />
              </div>
              <div class="params__api-field">
                <span class="params__api-label">
                  模型
                  <el-tooltip
                    content="「拉取」列出该 Key 可见的模型（列表 ≠ 套餐内都可用）；也可直接输入自定义模型名"
                    placement="top"
                  >
                    <span class="params__hint">?</span>
                  </el-tooltip>
                </span>
                <div class="params__api-model">
                  <el-select
                    v-model="draft.model"
                    size="small"
                    filterable
                    allow-create
                    default-first-option
                    placeholder="选择或输入模型名"
                    @visible-change="onModelDropdown"
                  >
                    <el-option v-for="mname in modelOptions" :key="mname" :label="mname" :value="mname" />
                  </el-select>
                  <el-button size="small" :loading="loadingModels" @click="refreshModels">拉取</el-button>
                </div>
              </div>
              <div class="params__api-grid">
                <div class="params__api-field">
                  <span class="params__api-label">
                    输出上限
                    <el-tooltip content="max_tokens。推理模型的思考 token 也计入输出额度，太小会被截断（正文 0 字符）" placement="top">
                      <span class="params__hint">?</span>
                    </el-tooltip>
                  </span>
                  <el-input-number
                    v-model="draft.max_tokens"
                    size="small"
                    :min="1024"
                    :max="131072"
                    :step="1024"
                    :controls="false"
                  />
                </div>
                <div class="params__api-field">
                  <span class="params__api-label">温度</span>
                  <el-input-number
                    v-model="draft.temperature"
                    size="small"
                    :min="0"
                    :max="2"
                    :step="0.1"
                    :controls="false"
                  />
                </div>
                <div class="params__api-field">
                  <span class="params__api-label">超时(秒)</span>
                  <el-input-number
                    v-model="draft.timeout"
                    size="small"
                    :min="10"
                    :max="3600"
                    :step="10"
                    :controls="false"
                  />
                </div>
              </div>
              <div class="params__api-field">
                <span class="params__api-label">API Keys（{{ draft.keys.length }}）</span>
                <div v-if="draft.keys.length" class="params__keys">
                  <div v-for="(k, i) in draft.keys" :key="k + i" class="params__key">
                    <span class="params__key-no">{{ i + 1 }}</span>
                    <code class="params__key-mask" :title="k">{{ k }}</code>
                    <el-tag v-if="!k.includes('*')" size="small" effect="plain" type="info">未保存</el-tag>
                    <el-tooltip
                      v-else-if="keyStateOf(k)?.reason && keyStateOf(k)?.state !== 'active'"
                      :content="keyStateOf(k)?.reason"
                      placement="top"
                      :show-after="150"
                    >
                      <el-tag size="small" effect="light" :type="keyTagType(keyStateOf(k))">
                        {{ keyTagText(keyStateOf(k)) }}
                      </el-tag>
                    </el-tooltip>
                    <el-tag v-else size="small" effect="light" :type="keyTagType(keyStateOf(k))">
                      {{ keyTagText(keyStateOf(k)) }}
                    </el-tag>
                    <el-button size="small" text type="danger" @click="draft.keys.splice(i, 1)">删除</el-button>
                  </div>
                </div>
                <div class="params__key-add">
                  <el-input
                    v-model="newKey"
                    size="small"
                    placeholder="粘贴新的 API Key（sk-…），可添加多个"
                    clearable
                    @keyup.enter="addKey"
                  />
                  <el-button size="small" :disabled="!newKey.trim()" @click="addKey">添加</el-button>
                </div>
                <p class="params__modules-note">
                  多 Key 自动轮换：请求失败（Key 失效 / 限流 / 额度不足）自动切换下一个；限流的 Key 冷却 60s 后自动恢复。
                </p>
              </div>
              <div class="params__api-actions">
                <el-button type="primary" size="small" :loading="savingSettings" @click="saveSettings">
                  保存设置
                </el-button>
                <el-button size="small" :disabled="!hasDisabledKey" @click="resetKeys">重试失效 Key</el-button>
              </div>
            </div>
          </div>
        </div>
      </details>

      <!-- 分组四：条件方案（工艺分析的前置步骤：先列候选条件，选定后再深入分析） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 4h11M2.5 8h6M2.5 12h9" />
              <circle cx="12.5" cy="8" r="1.7" />
            </svg>
            条件方案
            <el-tooltip
              content="反应条件（溶剂 / 温度 / 碱与缩合剂 / 浓度 / 投料方式）本就是组合空间：先把可行的几套列出来，挑一套再深入分析，比一次只给一套更接近实际筛选流程。"
              placement="top"
            >
              <span class="params__hint">?</span>
            </el-tooltip>
          </span>
          <span class="params__group-meta">
            {{ store.condPlanFirst ? `先列候选 · ${store.condOptionCount} 套` : '直接分析' }}
          </span>
        </summary>
        <div class="params__group-body">
          <div class="params__row">
            <label>先列候选条件</label>
            <el-switch v-model="store.condPlanFirst" size="small" />
          </div>
          <div class="params__row">
            <label>候选方案数</label>
            <el-input-number
              v-model="store.condOptionCount"
              :min="2"
              :max="6"
              size="small"
              :disabled="!store.condPlanFirst"
            />
          </div>
          <p class="params__modules-note">
            开启后，「AI 工艺分析」面板会先列出这一步反应的多套条件方案（溶剂 / 温度 / 碱与缩合剂 / 浓度
            各成一派，并给出优缺点与适用场景）。选一套再深入分析 —— 分析会<b>锁定</b>这套条件，不会另换。<br />
            关闭 = 直接按模型的第一直觉给一套条件做分析；面板里仍可随时手动「列出候选条件」。
          </p>
        </div>
      </details>

      <!-- 分组五：分析模块（芯片式多选：选中=品牌色卡片；全选/清空收进标题行） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">
            <svg class="params__group-ico" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
              <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
              <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
              <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
            </svg>
            分析模块
            <el-tooltip
              content="只让大模型生成勾选维度的内容，省 token 也更聚焦。LCMS 的 m/z 数值始终由 RDKit 计算，不受此影响。"
              placement="top"
            >
              <span class="params__hint">?</span>
            </el-tooltip>
          </span>
          <!-- @click.stop：标题行是 <summary>，不拦住点击会连带开合分组 -->
          <span class="params__modules-summary" @click.stop>
            <span class="params__group-meta">已选 {{ modules.length }} / {{ ALL_ANALYSIS_MODULES.length }}</span>
            <el-button size="small" text type="primary" :disabled="allSelected" @click="selectAllModules">全选</el-button>
            <el-button size="small" text :disabled="!modules.length" @click="clearModules">清空</el-button>
          </span>
        </summary>
        <div class="params__group-body">
          <div class="params__modules">
            <button
              v-for="opt in moduleOptions"
              :key="opt.key"
              type="button"
              class="params__chip"
              :class="{ 'is-on': modules.includes(opt.key) }"
              :aria-pressed="modules.includes(opt.key)"
              @click="toggleModule(opt.key, !modules.includes(opt.key))"
            >
              <span class="params__chip-check" aria-hidden="true">
                <svg viewBox="0 0 10 8"><path d="M1 4l2.6 2.6L9 1.2" /></svg>
              </span>
              {{ opt.label }}
            </button>
          </div>
          <p class="params__modules-note">「总述 + 反应类型」始终保留，不受勾选影响。</p>
        </div>
      </details>
    </div>
  </section>
</template>

<style scoped>
.params__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 嵌入右辅助面板：去掉自己那层卡壳（外框与标题都归 AsidePanel） */
.params--embedded.rw-card {
  border: 0;
  box-shadow: none;
  background: transparent;
}

.params--embedded .params__body {
  padding: 0;
}

.params__flag {
  display: flex;
}

/* ---------- 可折叠分组 ----------
   用原生 <details>：无 JS、无额外依赖、自带键盘可达性（Tab + Enter 开合）。
   只在视觉上重做 summary（去掉默认三角，换成右侧会旋转的 chevron）。 */
.params__group {
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface-2);
  overflow: hidden;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.params__group[open] {
  border-color: var(--rw-border-strong);
  box-shadow: var(--rw-shadow-1);
}

.params__group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background 0.15s;
  position: relative;
}

.params__group-head::-webkit-details-marker {
  display: none;
}

.params__group-head:hover {
  background: var(--rw-surface-3);
}

.params__group-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
  letter-spacing: 0.2px;
}

.params__group-ico {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: none;
  stroke: var(--rw-brand);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.9;
}

/* 右侧 chevron（替代 title 前的字符三角，位置固定不随文字移动） */
.params__group-head::after {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 6px;
  margin-left: auto;
  border-right: 1.5px solid var(--rw-text-3);
  border-bottom: 1.5px solid var(--rw-text-3);
  transform: rotate(45deg);
  transform-origin: center;
  transition: transform 0.18s ease, border-color 0.18s ease;
}

.params__group[open] > .params__group-head::after {
  transform: rotate(-135deg);
  border-color: var(--rw-brand);
}

.params__group-meta {
  font-size: 11.5px;
  color: var(--rw-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.params__group-tag {
  flex-shrink: 0;
}

.params__group-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-top: 1px solid var(--rw-border);
  background: var(--rw-surface);
}

.params__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.params__row--col {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}

.params__row > label {
  font-size: 12.5px;
  color: var(--rw-text-2);
  font-weight: 500;
  white-space: nowrap;
  letter-spacing: 0.2px;
}

.params__model {
  display: flex;
  gap: 6px;
}

.params__model :deep(.el-select) {
  width: 160px;
}

.params__llm {
  display: flex;
  align-items: center;
  gap: 4px;
}

.params__hint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-left: 3px;
  border-radius: 50%;
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 10px;
  line-height: 1;
  cursor: help;
  transition: background 0.15s, color 0.15s;
}

.params__hint:hover {
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
}

/* 统一输入控件聚焦态：品牌色描边 + 柔和外发光（穿透 scoped 到 EP 内部） */
.params__row :deep(.el-input__wrapper),
.params__row :deep(.el-select__wrapper),
.params__row :deep(.el-input-number) {
  transition: box-shadow 0.15s;
}

.params__row :deep(.el-input__wrapper.is-focus),
.params__row :deep(.el-select__wrapper.is-focused) {
  box-shadow: 0 0 0 1px var(--rw-brand) inset;
}

/* ---------- API 设置（接口地址 / 模型 / token / 多 Key） ---------- */
.params__api {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface-2);
}

.params__api-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.params__api-label {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: var(--rw-text-3);
  letter-spacing: 0.2px;
}

.params__api-model {
  display: flex;
  gap: 6px;
}

.params__api-model :deep(.el-select) {
  flex: 1;
  min-width: 0;
}

.params__api-grid {
  display: grid;
  grid-template-columns: 1.3fr 0.85fr 0.85fr;
  gap: 8px;
}

.params__api-grid :deep(.el-input-number) {
  width: 100%;
}

.params__keys {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.params__key {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  transition: border-color 0.15s;
}

.params__key:hover {
  border-color: var(--rw-border-strong);
}

.params__key-no {
  flex-shrink: 0;
  width: 14px;
  font-size: 10px;
  color: var(--rw-text-3);
  text-align: right;
}

.params__key-mask {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--rw-text-2);
}

.params__key .el-button {
  flex-shrink: 0;
}

.params__key-add {
  display: flex;
  gap: 6px;
}

.params__api-actions {
  display: flex;
  gap: 8px;
}

/* ---------- 分析模块勾选 ---------- */
.params__modules-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.params__modules-head > label {
  font-size: 13px;
  color: var(--rw-text-2);
  font-weight: 500;
}

/* ---------- 分析模块：芯片式多选 ---------- */
.params__modules-summary {
  display: flex;
  align-items: center;
  gap: 2px;
}

.params__modules {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 8px;
}

.params__chip {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
  color: var(--rw-text-2);
  font-size: 12.5px;
  line-height: 1.25;
  cursor: pointer;
  text-align: left;
  user-select: none;
  transition: border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
}

.params__chip:hover {
  border-color: var(--rw-brand);
  color: var(--rw-text);
}

.params__chip:focus-visible {
  outline: 2px solid var(--rw-brand);
  outline-offset: 1px;
}

.params__chip.is-on {
  border-color: var(--rw-brand);
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-weight: 500;
  box-shadow: inset 0 0 0 1px var(--rw-brand-soft);
}

/* 自绘勾选框：选中时品牌色实底 + 白色对勾 */
.params__chip-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  border: 1px solid var(--rw-border);
  border-radius: 4px;
  background: var(--rw-surface-2);
  color: transparent;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.params__chip.is-on .params__chip-check {
  border-color: var(--rw-brand);
  background: var(--rw-brand);
  color: #fff;
}

.params__chip-check svg {
  width: 8px;
  height: 7px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.params__modules-note {
  margin: 0;
  font-size: 11px;
  color: var(--rw-text-3);
}

.params__materials {
  display: flex;
  gap: 6px;
}

.params__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.params__tag-atoms {
  font-style: normal;
  margin-left: 4px;
  opacity: 0.7;
}

/* 「多步拆分」范围标签：挂在分组标题上，一眼看出这组参数的适用面 */
.params__scope-tag {
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--rw-border-strong);
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0;
}

/* 约束说明段：范围提示要显眼一点（用户最容易误解「深度」管的是手动展开） */
.params__note {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  border-left: 2px solid var(--rw-brand);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.params__note strong {
  color: var(--rw-text-2);
  font-weight: 600;
}
</style>
