<script setup lang="ts">
/**
 * 工作台「首次进入」的标定面板 —— 整屏居中的一张大卡片。
 *
 * 为什么是这个形态：
 *   一个目标分析 = 一个任务。任务的**开头**只有一件事要做 —— 说清楚「拆什么、怎么拆」。
 *   所以首次进入时不展示任何路线区（那时还什么都没有，展示空树只会让人分心），
 *   而是把三样东西合到一张卡里，视觉聚焦、一次填完：
 *       ① 结构式画布（可直接手画）
 *       ② 粘贴结构 / SMILES 的输入框
 *       ③ 运行参数（模型 / 候选数 / 拆分约束 / AI 分析）
 *
 *   一旦设定目标并分析，这张卡**整体消失**（不是收起、不是留在原位），
 *   工作台切换到「路线为主」的常态版式 —— 运行参数挪到主区右侧、可伸缩。
 *   目标本身降级成路线区顶部的一条胶囊（见 TargetBar.vue）。
 *
 * 分工：输入与解析逻辑仍归 `TargetInput.vue`（那里有 RDKit 诊断、画板、示例等），
 *       本组件只负责「居中卡片 + 参数并排」的版式与切换时机。
 */
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import TargetInput from './TargetInput.vue';
import RunParams from './RunParams.vue';

const store = useWorkspaceStore();

/**
 * 🔴 是否展示标定面板 —— 唯一判据是 `store.targetSetupOpen`，**不是** `!store.rootId`。
 *
 * 为什么不能用「有没有目标」来判：
 *   「换目标」是**开始一个新任务的准备阶段**，此刻旧目标还在树上（rootId 非空），
 *   若用 `!rootId` 判可见性，点了「换目标」面板根本不会出现 —— store 打开了也没用。
 *   反过来说，用户在标定面板里填完结构、还没点「解析结构」时 rootId 也是空的，
 *   但这正是最需要看到面板的时刻。
 *   一句话：**可见性只归 targetSetupOpen 管，rootId 只影响「能不能直接关掉面板」**
 *   （见 store.closeTargetSetup 的守卫）。
 */
const visible = computed(() => store.targetSetupOpen);

/** 多步拆分要先把目标解析出来（根节点在树上） */
const canAuto = computed(() => !!store.rootId && !store.autoRunning);
const autoDepth = computed(() => store.params.maxDepth);
const autoBudget = computed(() => store.params.budgetCalls);

/**
 * 多步自动拆分 —— 从**新建分析界面**发起。
 *
 * 🔴 为什么放在这里（而不是右栏运行参数里）：它是「决定这个任务怎么跑」的开场动作，
 *    与「确定目标，开始分析」是同一个阶段的两条路（一条自动、一条手动逐步），
 *    放在标定卡片里才有语境。运行中要停的话，状态条（右栏底部）上有「停止」。
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
  //    （用户报的正是这个：状态条虽在右栏底部报进度，但主区一片死寂。）
  //    切到树页签后能看着搜索结果灌成树；右栏底部同时报「搜索中…」并可停止。
  //
  //    位置说明：与 `TargetInput.startAnalysis` / `StepRow` / `RouteCanvas` 一致 ——
  //    「开跑/查看动作 ⇒ 切哪个页签」由**组件**决定，store 只在换任务时复位页签。
  store.mainTab = 'tree';
  await store.autoRun();
  ElMessage.success(store.autoProgress.label === '已停止' ? '已停止自动拆分' : '多步拆分完成');
}
</script>

<template>
  <div v-if="visible" class="setup">    <section class="setup__card">
      <header class="setup__head">
        <h2 class="setup__title">新建逆合成分析</h2>
        <p class="setup__sub">画一个结构、或粘贴 ChemDraw / MOL / SMILES，设好参数即可开始拆解</p>
      </header>

      <div class="setup__grid">
        <!-- 左：目标分子（画布 + 粘贴框 + 解析结果） -->
        <div class="setup__target">
          <TargetInput />
        </div>

        <!-- 右：这次分析的运行参数 -->
        <aside class="setup__params">
          <RunParams />
        </aside>
      </div>

      <!-- 多步拆分：与左栏「确定目标，开始分析」并列的第二条起跑线。
           自动那条一次搜到底（后端 Retro* 广度搜索，吃满调用预算），
           手动那条由用户在逆合成树里逐步挑候选。 -->
      <div class="setup__auto">
        <div class="setup__auto-info">
          <span class="setup__auto-title">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 2v12M4 8h8M8 4l4 4-4 4" />
            </svg>
            多步自动拆分
          </span>
          <span class="setup__auto-hint">
            按右侧「拆分约束」一次搜到底（最大深度 {{ autoDepth }} 层 · 预算 {{ autoBudget }} 次调用 · 命中起始物料即停），
            返回多条完整路线（最优重建为树、其余存为备选方案），运行中可在右栏底部随时停止。想逐步挑候选，就用上面的「确定目标，开始分析」。
          </span>
        </div>
        <div class="setup__auto-ops">
          <el-button
            type="primary"
            plain
            :disabled="!canAuto"
            :loading="store.autoRunning"
            @click="onAuto"
          >
            自动往下拆 {{ autoDepth }} 层
          </el-button>
          <el-button v-if="store.autoRunning" type="danger" plain @click="store.stopAuto()">停止</el-button>
        </div>
      </div>
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
      相对**最近定位祖先**（见 WorkspaceView 的 .workspace__layer）铺满，
      再用 flex 居中 —— 位置就只由"层"决定，与栅格无关。 */
.setup {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 22px 24px;
  overflow: auto;
}

.setup__card {
  width: 100%;
  /* 够宽才放得下「画布 | 参数」两栏；再宽就散了 */
  max-width: 1180px;
  padding: 26px 28px 24px;
  border: 1px solid var(--rw-border);
  border-radius: 16px;
  background: var(--rw-surface);
  box-shadow: 0 12px 40px rgb(15 23 42 / 7%);
  /* 卡片自身高度可能超过层高（窄屏堆叠时）⇒ 用 auto 让 flex 不去压缩它 */
  flex: 0 0 auto;
}

.setup__head {
  margin-bottom: 20px;
  text-align: center;
}

.setup__title {
  margin: 0 0 6px;
  font-size: 19px;
  font-weight: 650;
  color: var(--rw-text);
}

.setup__sub {
  margin: 0;
  font-size: 13px;
  color: var(--rw-text-3);
}

.setup__grid {
  display: grid;
  /* 左边给输入区，右边给参数；参数栏窄一些 */
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 22px;
  align-items: start;
}

.setup__target {
  min-width: 0;
}

.setup__params {
  min-width: 0;
}

/* 卡片内部的两个组件不再各带一层边框（避免卡中卡） */
.setup__target :deep(.rw-card),
.setup__params :deep(.rw-card) {
  border: 0;
  box-shadow: none;
  background: transparent;
}

.setup__params :deep(.rw-card__head) {
  padding-left: 0;
  padding-right: 0;
}

.setup__params :deep(.rw-card__body) {
  padding-left: 0;
  padding-right: 0;
}

/* ---------- 多步自动拆分（卡片底部的第二条起跑线） ---------- */
.setup__auto {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px dashed var(--rw-border);
}

.setup__auto-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.setup__auto-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
}

.setup__auto-title svg {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  fill: none;
  stroke: var(--rw-brand);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.setup__auto-hint {
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--rw-text-3);
}

.setup__auto-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

/* 窄屏/矮屏：两栏堆叠，且不再强制居中（否则内容超出后顶部被裁） */
@media (max-width: 1080px) {
  .setup {
    align-items: flex-start;
  }

  .setup__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 768px) {
  .setup {
    padding: 8px 12px 20px;
  }

  .setup__card {
    padding: 18px 14px 16px;
    border-radius: 12px;
  }

  .setup__auto {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
}
</style>
