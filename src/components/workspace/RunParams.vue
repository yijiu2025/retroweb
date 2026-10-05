<script setup lang="ts">
/**
 * 运行参数 + 模型预热 + 自动往下拆 K 层。
 *
 * 「自动拆 K 层」内部是**串行多次调用同一个单步接口**（/api/predict），
 * 不是调 /api/search —— 每步取 Top-1，随时可停止，受「最大深度」与「调用预算」双重约束。
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
import { retroApi } from '@/api/retro';
import { useWorkspaceStore } from '@/stores/workspace';
import { countHeavyAtoms } from '@/utils/smiles';

/** true = 已被外层容器（右辅助面板）接管标题与外框，本组件只出内容 */
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const store = useWorkspaceStore();
const materialInput = ref('');
const addingMaterial = ref(false);
const probing = ref(false);

const canAuto = computed(() => !!store.rootId && !store.autoRunning);

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
  if (!st?.configured) return st?.hint || '未配置大模型（在 F:\\retrochimera\\web\\.env 里填 RETRO_LLM_*）';
  const p = llmProbe.value;
  if (!p) return `已读取配置：${st.model}\n点「验证」真发一次最小请求，确认 key 与模型可用`;
  if (p.verified) return `已验证可用：${p.model}\n${p.base_url || ''}`;
  return `验证失败：${p.error || '未知错误'}`;
});

/** 「验证」按钮：只在用户主动点击时才真打网络（网关有限流，别自动打） */
async function verifyLlm(): Promise<void> {
  probing.value = true;
  try {
    await store.loadLlmStatus(true);
    const p = store.llmStatus?.probe;
    if (p?.verified) ElMessage.success(`大模型可用：${p.model}`);
    else if (store.llmStatus?.configured) ElMessage.error(p?.error || '大模型验证失败');
    else ElMessage.warning(store.llmStatus?.hint || '大模型未配置');
  } finally {
    probing.value = false;
  }
}

/** 指定起始物料：先过 /api/parse 规范化，再按 canonical 比对 */
async function addMaterial(): Promise<void> {
  const raw = materialInput.value.trim();
  if (!raw) return;
  addingMaterial.value = true;
  try {
    const res = await retroApi.parse(raw);
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

async function onAuto(): Promise<void> {
  if (!store.rootId) {
    ElMessage.warning('请先设定目标分子');
    return;
  }
  await store.autoRun();
  ElMessage.success(store.autoProgress.label === '已停止' ? '已停止自动拆分' : '自动拆分完成');
}

onMounted(() => {
  if (!store.models.length) void store.loadModels();
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
          <span class="params__group-title">预测设置</span>
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

      <!-- 分组二：拆分约束（自动拆分时才用得上，默认收起） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">拆分约束</span>
          <span class="params__group-meta">
            深度 {{ store.params.maxDepth }} · 预算 {{ store.params.budgetCalls }}
          </span>
        </summary>
        <div class="params__group-body">
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

      <!-- 分组三：AI 工艺分析（状态常驻可见，配置细节收起） -->
      <details class="params__group">
        <summary class="params__group-head">
          <span class="params__group-title">AI 工艺分析</span>
          <el-tag size="small" :type="llmTagType" effect="light" class="params__group-tag">
            {{ llmTagText }}
          </el-tag>
        </summary>
        <div class="params__group-body">
          <div class="params__row">
            <label>
              大模型状态
              <el-tooltip
                content="在「每步流程」里让大模型给出投料顺序、当量、条件、副产物、LCMS/NMR。需在后端 .env 配置 RETRO_LLM_*"
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
        </div>
      </details>

      <!-- 拆分动作：常驻在分组外，随时可点 -->
      <div class="params__auto">
        <el-button type="primary" :disabled="!canAuto" @click="onAuto">
          自动往下拆 {{ store.params.maxDepth }} 层
        </el-button>
        <el-button v-if="store.autoRunning" type="danger" plain @click="store.stopAuto()">停止</el-button>
        <div v-if="store.autoProgress.label" class="params__progress">
          {{ store.autoProgress.done }} / {{ store.autoProgress.budget }} · {{ store.autoProgress.label }}
        </div>
      </div>
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
   只在视觉上重做 summary（去掉默认三角，换成一个会旋转的 chevron）。 */
.params__group {
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
  overflow: hidden;
}

.params__group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
  list-style: none;
  user-select: none;
  transition: background 0.15s;
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
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
}

/* 自带 chevron：展开时旋转 90° */
.params__group-title::before {
  content: '›';
  display: inline-block;
  font-size: 15px;
  line-height: 1;
  color: var(--rw-text-3);
  transition: transform 0.16s ease;
}

.params__group[open] > .params__group-head .params__group-title::before {
  transform: rotate(90deg);
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
  font-size: 13px;
  color: var(--rw-text-2);
  font-weight: 500;
  white-space: nowrap;
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
  margin-left: 4px;
  border-radius: 50%;
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 10px;
  cursor: help;
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

.params__auto {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed var(--rw-border);
}

.params__progress {
  font-size: 12px;
  color: var(--rw-text-3);
  flex: 1;
  min-width: 100%;
}
</style>
