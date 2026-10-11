<script setup lang="ts">
/**
 * 工作台「首次进入」的标定面板 —— 整屏居中的一张大卡片。
 *
 * 为什么是这个形态：
 *   一个目标分析 = 一个任务。任务的**开头**只有一件事要做 —— 说清楚「拆什么、怎么拆」。
 *   所以首次进入时不展示任何路线区（那时还什么都没有，展示空树只会让人分心），
 *   而是把三样东西合到一张卡里，视觉聚焦、一次填完：
 *       · 结构式画布（可直接手画）
 *       · 粘贴结构 / SMILES 的输入框
 *       · 起跑线（自动拆解 / 手动逐步）与它的直接参数（层数/预算）
 *
 *   一旦设定目标并分析，这张卡**整体消失**（不是收起、不是留在原位），
 *   工作台切换到「路线为主」的常态版式 —— 运行参数挪到主区右侧、可伸缩。
 *
 * 分工：输入与解析逻辑仍归 `TargetInput.vue`（那里有 RDKit 诊断、画板、示例、
 *       解析后收起成胶囊等），本组件只负责「居中卡片 + 设置弹窗 + 动作栏」。
 *
 * 🔴 版式（2026-10-09 第三轮，用户反馈）：
 *   · **步骤徽标 ①②③ 全删** —— 用户明确说"数字很奇怪"。
 *   · 设置入口学抖音侧栏左下角：**一枚齿轮按钮**点开**弹窗**（不是抽屉行），
 *     弹窗里放完整 RunParams（模型/拆分约束/大模型/条件方案/分析模块/询价）。
 *   · 「自动往下拆 N 层」按钮取消，改成 **「自动拆解」**；
 *     层数/预算做成按钮**左侧的两枚小 stepper**（用户要求"上边有几个设置"），
 *     与设置弹窗里的「拆分约束」组**同源**（都绑 store.params），两处改一处即两处同步。
 */
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import TargetInput from './TargetInput.vue';

const store = useWorkspaceStore();

/** 模型名字去掉括号里的说明（动作栏下拉放不下「（主推，性能最强）」这类后缀） */
function modelShortLabel(label: string): string {
  return label.split('（')[0] || label;
}

/**
 * 错误文案人性化：store.globalError 里常落着 axios 的原始 message
 * （「Request failed with status code 502」），对用户是噪音。
 * 与 WorkspaceView.humanizeError 同款（各自内联，不抽公共：两处文案策略可能分叉）。
 */
function humanizeError(msg: string): string {
  const m = msg.match(/status code (\d{3})/i);
  if (m) {
    const code = m[1];
    if (code.startsWith('5')) return `后端服务暂不可用（HTTP ${code}）：请确认后端 API 已启动，或稍后重试`;
    if (code === '401') return '登录已过期（HTTP 401），请重新登录';
    if (code === '404') return '接口不存在（HTTP 404）：前后端版本可能不一致';
    return `请求失败（HTTP ${code}）`;
  }
  if (/network error/i.test(msg)) return '无法连接后端服务：请确认后端 API 已启动';
  if (/timeout of|timeout/i.test(msg)) return '请求超时：后端响应时间过长，可稍后重试';
  // 代理层错误词（Flask 挂掉时 vite proxy 透出的 502/504 常长这样）⇒ 兜底成人话
  if (/bad gateway|gateway timeout|service unavailable|connection refused|econnrefused/i.test(msg)) {
    return '后端服务未就绪：请确认后端 API 已启动，或稍后重试';
  }
  return msg;
}

/**
 * 后端状态提示条要展示的内容。
 *
 * 🔴 两种「异常」分开看，别混成一条：
 *   · `globalError` —— 后端**连不上 / 接口报错**（loadModels 失败会落进来），
 *     这是最严重的，必须醒目。
 *   · 模型「未就绪」—— 后端起来了，但预测模型还没加载（40~90 秒）或没文件，
 *     这是"能用但要等/要操作"，不打断输入。
 */
const backendError = computed(() => (store.globalError ? humanizeError(store.globalError) : ''));

/** 后端起来了、但当前选的预测模型还没就绪（未加载 / 加载中 / 失败 / 缺文件） */
const modelNotReady = computed(() => {
  // 后端没起来（有错误）时，模型状态无从谈起，交给 backendError 那条，这里不重复。
  if (store.globalError) return false;
  const st = store.currentModel?.state;
  // 模型列表还没拉回来（首次加载中）也不算「未就绪」—— 那是"检测中"，不是"坏"。
  if (st === undefined) return false;
  return st !== 'ready';
});

/**
 * 🔴 是否展示标定面板 —— 唯一判据是 `store.targetSetupOpen`，**不是** `!store.rootId`。
 *
 * 为什么不能用「有没有目标」来判：
 *   「换目标」是**开始一个新任务的准备阶段**，此刻旧目标还在树上（rootId非空），
 *   若用 `!rootId` 判可见性，点了「换目标」面板根本不会出现 —— store 打开了也没用。
 *   反过来说，用户在标定面板里填完结构、还没点「解析结构」时 rootId 也是空的，
 *   但这正是最需要看到面板的时刻。
 *   一句话：**可见性只归 targetSetupOpen 管，rootId 只影响「能不能直接关掉面板」**
 *   （见 store.closeTargetSetup 的守卫）。
 */
const visible = computed(() => store.targetSetupOpen);

/** 多步拆分要先把目标解析出来（根节点在树上） */
const canAuto = computed(() => !!store.rootId && !store.autoRunning);

/** 手动那条起跑线的实现归 TargetInput（它最清楚解析状态），这里只转发一次点击 */
const targetRef = ref<InstanceType<typeof TargetInput> | null>(null);

/**
 * 「运行设置」弹窗 —— 开关提为 store 共享状态（`store.runSettingsOpen`）。
 *
 * 🔴 为什么在 store：设置按钮住在**侧栏底部**（AppShell），弹窗本体在本组件里。
 *    两者隔着路由，谁也不能靠 prop 触发谁 ⇒ 开关共享。本组件只负责渲染弹窗，
 *    用 `store.runSettingsOpen` 作 v-model；侧栏按钮直接 `store.runSettingsOpen = true`。
 * 🔴 el-dialog 默认**首次打开前不渲染内容** —— 守门脚本必须先点侧栏按钮再断言
 *    弹窗里有参数（见 .tmp-probe/verify-workbench.cjs）。
 */

/**
 * 多步自动拆分 —— 从**新建分析界面**发起。
 *
 * 🔴 为什么放在这里（而不是右栏运行参数里）：它是「决定这个任务怎么跑」的开场动作，
 *    与「确定目标，开始分析」是同一个阶段的两条路（一条自动、一条手动逐步），
 *    放在同一行才读得出"二选一"。
 *
 * 🔴 与「确定目标，开始分析」的关系：两个都是**任务起点**，点任意一个都会收起本面板。
 *    `closeTargetSetup()` 只在 rootId 非空时生效（守卫在 store 里），所以这里先判 rootId。
 */
async function onAuto(): Promise<void> {
  if (!store.rootId) {
    ElMessage.warning('先解析一个目标分子');
    return;
  }
  store.closeTargetSetup();
  // 🔴 与「确定目标，开始分析」**同口径**：显式开跑 ⇒ 页签切到「逆合成树」。
  //    自动拆分是**长任务**（一次 Retro* 搜索可达几分钟，期间多次轮询进度），
  //    而它拆出来的东西全长在树页签里 —— 留在默认的「目标分析」
  //    总览，那页此时连一条已确认路线都没有（`TargetOverview` 只会显示"还没有确定的
  //    路线"），用户点完按钮看到的是一屏不动的界面，**无法判断到底有没有在跑**。
  //    切到树页签后能看着搜索结果灌成树；右栏底部同时报「搜索中…」并可停止。
  //
  //    位置说明：与 `TargetInput.startAnalysis` / `StepRow` / `RouteCanvas` 一致 ——
  //    「开跑/查看动作 ⇒ 切哪个页签」由**组件**决定，store 只在换任务时复位页签。
  store.mainTab = 'tree';
  await store.autoRun();
  ElMessage.success(store.autoProgress.label === '已停止' ? '已停止自动拆分' : '多步拆分完成');
}

/** 手动那条：转发给 TargetInput 里的实现（守门脚本找的就是这个 class） */
function onStart(): void {
  targetRef.value?.startAnalysis();
}

/** 有没有目标 —— 动作栏说明行的判据 */
const hasTarget = computed(() => !!store.rootId);

/**
 * 自动拆分按钮的悬浮说明。
 *
 * 🔴 禁用态必须说清「为什么灰」：按钮可用性挂在 `rootId` 上，而 rootId 只有
 *    解析成功才有。层数/预算现在就摆在按钮旁边（stepper），tooltip 只讲
 *    「这条路的规则」—— 一次搜到底、怎么收手、产物去哪。
 */
const autoHint = computed(() =>
  hasTarget.value
    ? '一次搜到底：命中起始物料（或重原子阈值）即停；最优路线重建为树，其余存为备选方案。运行中可在逆合成树页签的面板或右栏状态条随时停止。'
    : '需要先解析出一个目标分子：粘贴结构 / SMILES、点示例，或用「绘制结构式」手绘一个。'
);
</script>

<template>
  <div v-if="visible" class="setup">
    <section class="setup__card">
      <!-- Reaxys 式头部：标题左对齐 + 一行小字。 -->
      <header class="setup__head">
        <h2 class="setup__title">新建逆合成分析</h2>
        <p class="setup__sub">粘贴 ChemDraw / MOL / SMILES，或直接手绘</p>
      </header>

      <!-- 后端状态提示：连不上 / 模型未就绪时在首页显眼处给出一句。
           🔴 位置选在标题之下、输入区之上 —— 这是用户第一眼扫到的区域，
             后端坏了要在这里就拦住，而不是等点「解析结构」才报错。 -->
      <div v-if="backendError" class="setup__banner setup__banner--error">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 5v3.6M8 11.1v.1" />
        </svg>
        <span class="setup__banner-text">{{ backendError }}</span>
        <button
          v-if="store.errorRetry"
          type="button"
          class="setup__banner-btn"
          @click="store.retryError()"
        >
          重试
        </button>
        <button
          type="button"
          class="setup__banner-close"
          aria-label="关闭"
          @click="store.clearGlobalError()"
        >
          ×
        </button>
      </div>

      <div v-else-if="modelNotReady" class="setup__banner setup__banner--warn">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 2 15 14H1L8 2Z" />
          <path d="M8 6.6v3.2M8 12.1v.1" />
        </svg>
        <span class="setup__banner-text">
          预测模型尚未就绪（{{ store.currentModel?.label || '当前模型' }} 正在
          {{ store.currentModel?.state === 'loading' ? '加载' : '准备' }}），
          可先在右侧「设置」里查看或加载模型。
        </span>
      </div>

      <!-- 目标分子：未设定 = 完整输入区；解析成功 = 收成一条胶囊（点开可替换） -->
      <div class="setup__target">
        <TargetInput ref="targetRef" />
      </div>

      <!-- 动作栏：左「预测模型 + 层数/预算」，右两条起跑线。
           🔴 设置按钮已挪到**侧栏底部**（AppShell），不再在这里。
           🔴 class 名 `setup__auto-ops` / `target__start-btn` 是守门脚本的定位锚点
              （.tmp-probe/verify-search-anim.cjs、verify-workbench.cjs），不要改。 -->
      <footer class="setup__actions">
        <!-- 预测模型 + 层数/预算：三者都是"这次怎么拆"的直接参数，并排一处 -->
        <div class="setup__tuning">
          <label class="setup__mini setup__mini--model">
            <span class="setup__mini-label">模型</span>
            <el-select
              v-model="store.params.model"
              size="small"
              :loading="store.modelsLoading"
              class="setup__mini-model"
            >
              <el-option
                v-for="m in store.models"
                :key="m.key"
                :label="modelShortLabel(m.label)"
                :value="m.key"
                :disabled="m.state === 'unavailable'"
              />
            </el-select>
          </label>

          <!-- 🔴 两枚数值框与设置弹窗里的「拆分约束」组**同源**
             （都绑 store.params）⇒ 弹窗里改这里同步变，反过来也一样。 -->
          <label class="setup__mini">
            <span class="setup__mini-label">层数 (1~8):</span>
            <el-input-number
              v-model="store.params.maxDepth"
              :min="1"
              :max="8"
              :controls="false"
              size="small"
              class="setup__mini-num"
            />
          </label>
          <label class="setup__mini">
            <el-tooltip
              content="自动拆解全程最多发起多少次模型调用，用完即收手"
              placement="top"
              :show-after="200"
            >
              <span class="setup__mini-label">预算 (1~200):</span>
            </el-tooltip>
            <el-input-number
              v-model="store.params.budgetCalls"
              :min="1"
              :max="200"
              :controls="false"
              size="small"
              class="setup__mini-num"
            />
          </label>
        </div>

        <div class="setup__run">
          <!-- 🔴 `.setup__auto-ops` 只包自动那一颗，且按钮保持 primary 家族
             （verify-search-anim 按 `.setup__auto-ops .el-button--primary` 点它）。
             文案**不要**带「N 层」—— 层数就在左边；也**不要**写「拆分中…」——
             点击瞬间卡片整体消失（onAuto 先 closeTargetSetup），任何中间态都看不到。 -->
          <span class="setup__auto-ops">
            <el-tooltip :content="autoHint" placement="top" :show-after="200" :disabled="hasTarget">
              <span class="setup__auto-wrap">
                <el-button type="primary" plain :disabled="!canAuto" @click="onAuto">
                  <svg class="setup__btn-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <!-- 闪电：一键搜到底（参考稿 Zap） -->
                    <path
                      d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linejoin="round"
                    />
                  </svg>
                  自动拆解
                </el-button>
              </span>
            </el-tooltip>
          </span>
          <el-button
            type="primary"
            class="target__start-btn"
            :disabled="!hasTarget"
            @click="onStart"
          >
            确定目标，开始分析
            <svg class="setup__btn-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <!-- 右箭头：继续前进（参考稿 ArrowRight） -->
              <path
                d="M5 12h14m-7-7 7 7-7 7"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </el-button>
        </div>
      </footer>

      <p class="setup__note">
        <template v-if="hasTarget">
          <svg class="setup__note-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <!-- 灯泡：提示行前缀（参考稿 💡，按规范用 SVG） -->
            <path
              d="M9 18h6m-5 3h4m-2-19a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          「自动拆解」一键自动搜到底；「确定目标，开始分析」先展开单步由人工精细挑选路线。
        </template>
        <template v-else>
          先粘贴一个结构（或点示例、手绘）—— 解析成功后两条起跑线都会亮起。
        </template>
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 标定态：这是一张**整屏居中**的卡片，不受路线态栅格影响。
   🔴 做法是绝对定位铺满内容区：路线态的内容区 `.app__content` 里，
      主区被 `minmax(0,1fr) 300px` 的双栏栅格挤成"左 1fr + 右 316px 空列"，
      卡片若参与那个流向，重心就永远偏 80px（实测各视口恒差 -80，与栏宽无关，
      是内容区自身 padding + 空列的合力）。
      这里改成 `position:absolute; inset:0` 直接脱离文档流、
      相对**最近定位祖先**（见 WorkspaceView 的 .workspace__layer）铺满。 */
.setup {
  position: absolute;
  inset: 0;
  display: flex;
  padding: 8px 22px 24px;
  overflow: auto;
}

.setup__card {
  width: 100%;
  /* 🔴 760 而不是 960：胶囊态下 960 宽 × ~300 高是一条"扁长条"（比例 3.2:1），
     用户报"太长、比例不美观"。768（Tailwind max-w-3xl）是参考稿的正文栏宽，
     760 收一点留出守门余量 —— 守门断言已同步改为 `> 700`。
     再窄会让动作栏（设置+层数+预算+两按钮）换行。 */
  max-width: 760px;
  padding: 24px 28px 18px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-lg);
  background: var(--rw-surface);
  box-shadow: 0 12px 40px rgb(15 23 42 / 7%);
  /* 卡片自身高度可能超过层高（窄屏堆叠时）⇒ 用 auto 让 flex 不去压缩它 */
  flex: 0 0 auto;
  /* 🔴 居中必须用 `margin:auto` 而不是容器上的 `align-items:center`：
     输入区展开/弹窗打开时卡片可能超过层高 —— flex 居中在内容比容器高时
     会把**顶部**裁掉且滚不到；auto margin 溢出时自动退化成 0，是安全的那种。 */
  margin: auto;
}

/* 头部：标题左对齐（参考稿的标题层级） */
.setup__head {
  margin-bottom: 18px;
}

.setup__title {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 650;
  color: var(--rw-text);
}

.setup__sub {
  margin: 0;
  font-size: 13px;
  color: var(--rw-text-3);
}

/* ---------- 后端状态提示条 ----------
   连不上后端 = 红条（醒目）；模型未就绪 = 黄条（温和，不打断输入）。
   与 WorkspaceView 的通知条同一套视觉语言，但内联在此（标定态没有那个视图）。 */
.setup__banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 16px;
  border-radius: var(--rw-radius-sm);
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--rw-text-2);
}

.setup__banner > svg {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.setup__banner-text {
  flex: 1;
  min-width: 0;
}

.setup__banner--error {
  border: 1px solid color-mix(in srgb, var(--rw-bad) 38%, transparent);
  background: var(--rw-bad-l);
}

.setup__banner--error > svg {
  color: var(--rw-bad);
}

.setup__banner--warn {
  border: 1px solid color-mix(in srgb, var(--rw-warn) 38%, transparent);
  background: var(--rw-warn-l);
}

.setup__banner--warn > svg {
  color: var(--rw-warn);
}

.setup__banner-btn {
  flex-shrink: 0;
  padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--rw-bad) 42%, transparent);
  border-radius: 5px;
  background: var(--rw-surface);
  color: var(--rw-bad);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.15s;
}

.setup__banner-btn:hover {
  background: var(--rw-bad-l);
}

.setup__banner-close {
  flex-shrink: 0;
  padding: 0 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--rw-text-3);
  font-size: 15px;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.setup__banner-close:hover {
  color: var(--rw-text);
  background: var(--rw-surface-3);
}

/* 「设置」按钮已挪到侧栏底部（AppShell），此处样式不再需要 */

.setup__target {
  min-width: 0;
}

/* 卡片内的 TargetInput 不带自己的卡片壳（避免卡中卡） */
.setup__target :deep(.rw-card) {
  border: 0;
  box-shadow: none;
  background: transparent;
}

.setup__target :deep(.rw-card__body) {
  padding: 0;
}

/* ---------- 动作栏：独立"收尾块"，两行 ----------
   行 1 = 参数行（模型 + 层数 + 预算），行 2 = 按钮行（右对齐）。
   🔴 一行放不下：加了模型下拉后 5 个元素 ≈ 830px > 724 可用宽，
   强塞一行会让「自动拆解」和预算框重叠（实测）。两行反而层次更清楚：
   上面是"参数"，下面是"动作"。 */
.setup__actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  margin-top: 24px;
  padding: 14px 16px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius);
  background: var(--rw-surface-2);
}

/* 预测模型 + 层数/预算：三组"这次怎么拆"的参数并排，整块浮出 */
.setup__tuning {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.setup__run {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.setup__mini {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 5px 8px 5px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

/* 模型下拉块：比数字框宽一点，容纳模型名 */
.setup__mini--model {
  padding-right: 6px;
}

.setup__mini-model {
  width: 150px;
}

.setup__mini-model :deep(.el-select__wrapper) {
  box-shadow: none;
}

.setup__mini-label {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  color: var(--rw-text-3);
  white-space: nowrap;
  cursor: default;
}

/* 数值：品牌色加粗（参考稿的蓝色数字），居中，定宽防跳位 */
.setup__mini-num {
  width: 52px;
  flex: 0 0 52px;
}

.setup__mini-num :deep(.el-input__inner) {
  text-align: center;
  font-weight: 600;
  color: var(--rw-brand-d);
}

/* 按钮内的小图标：闪电 / 右箭头 */
.setup__btn-ico {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}

.setup__mini-num :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--rw-border) inset;
}

/* 🔴 `.setup__auto-ops` 只包自动那一颗（守门锚点，见模板注释） */
.setup__auto-ops {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}

/* tooltip 的触发包裹层：**禁用态的 el-button 不派发鼠标事件**
   （disabled 的原生按钮直接吞掉 hover/click）⇒ 灰按钮就永远弹不出
   「为什么灰」的说明。这里套一层 span 承接事件。 */
.setup__auto-wrap {
  display: inline-flex;
}

/* 说明：灯泡图标 + 一行灰字，居中（参考稿的 💡 提示行） */
.setup__note {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--rw-text-3);
  text-align: center;
}

.setup__note-ico {
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  color: var(--rw-warn);
}

/* ---------- 设置弹窗已抬到 AppShell（全局唯一，标定态/路线态共用），
   此处不再有弹窗与相关 :deep 样式 ---------- */

/* 🔴 这里**不能**再放「运行中 / 停止」任何运行态 UI：`onAuto()` 第一件事就是
   `closeTargetSetup()`，卡片随即整体消失 ⇒ 卡片里的运行态全是死代码
   （曾写了一行 `v-if="autoRunning"` 的停止条，实测永不渲染）。
   运行中的进度与停止出口在：逆合成树/路线网络页签的 SearchProgress 面板、
   右辅助面板底部的 RouteStats 状态条。 */

/* 窄屏 */
@media (max-width: 768px) {
  .setup {
    padding: 8px 12px 20px;
  }

  .setup__card {
    padding: 18px 16px 16px;
    border-radius: var(--rw-radius);
  }

  /* 动作栏竖排：参数一行、两颗按钮各占整行 */
  .setup__actions {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .setup__tuning {
    justify-content: flex-start;
  }

  .setup__run {
    flex-direction: column-reverse;
    align-items: stretch;
  }

  .setup__run :deep(.el-button),
  .setup__auto-wrap {
    width: 100%;
  }

  .setup__auto-ops {
    flex: 1 1 auto;
  }

  .setup__auto-ops :deep(.el-button) {
    width: 100%;
    margin-left: 0;
  }
}
</style>
