<script setup lang="ts">
/**
 * AI 工艺分析面板 —— 把「这一步反应」交给大模型，产出可执行的工艺细节：
 * 投料顺序 / 当量 / 条件 / 后处理 / 预期结果与收率 / 可能的副产物 / LCMS / NMR / 安全。
 *
 * 两条数据线刻意分开：
 *   · **LCMS 的数值**由后端 RDKit 算（`computed`）—— 确定性、可核对，不让模型瞎算；
 *   · **其余解释性内容**由大模型给（`data`），并在流式过程中实时显示原始输出。
 *
 * 结果按 reactionId 存在节点上（store.analyzeStep），所以换个分子/换种拆法各有各的一份，
 * 全都保留，不会互相覆盖。
 *
 * 追问：分析完成后可以在下方继续提问（store.askFollowup）。请求会带上
 * **产物 / 前体 / 路线上下文 + 这份结构化分析 + 历史问答**，回答是自由文本（不是 JSON），
 * 所以问「放大热风险」「换溶剂」这类分析结构里没覆盖的问题也能得到连贯回答。
 *
 * 候选条件：面板顶部可以先「列出候选条件」（store.analyzeConditions）—— 反应条件本就有
 * 多套可行组合（溶剂 / 温度 / 碱与缩合剂 / 浓度），一次只给一套等于把模型的第一直觉当唯一答案。
 * 选一套之后（store.chooseCondition）深入分析会把它作为 `chosen_condition` 传回后端并**锁定**，
 * 输出的 `conditions` 必须沿用它。关掉「先列候选条件」（运行参数里）就是老行为：直接给一套。
 */
import { computed, ref } from 'vue';
import { useWorkspaceStore } from '@/stores/workspace';
import type { ConditionOption, MassRow, StepAnalysis } from '@/types/retro';
import MolView from '@/components/mol/MolView.vue';

const props = defineProps<{ nodeId: string }>();
const store = useWorkspaceStore();

const showRaw = ref(false);

const node = computed(() => store.nodes[props.nodeId]);
const reaction = computed(() => {
  const n = node.value;
  if (!n?.chosenReactionId) return undefined;
  return n.candidates.find((r) => r.id === n.chosenReactionId);
});
const analysis = computed<StepAnalysis | undefined>(() => store.analysisOf(props.nodeId));
const status = computed(() => analysis.value?.status ?? 'idle');
const configured = computed(() => store.llmStatus?.configured !== false);
/** 推理模型：正文还没开始、只有思考内容 —— 此时应当展示思考而不是空白 */
const thinkingOnly = computed(
  () => !(analysis.value?.raw || '').length && !!(analysis.value?.reasoning || '').length
);
const thinkChars = computed(() => (analysis.value?.reasoning || '').length);

const COND_LABELS: Record<string, string> = {
  solvent: '溶剂体系',
  temperature: '温度程序',
  time: '反应时间',
  atmosphere: '气氛',
  catalyst: '催化剂 / 碱 / 缩合剂',
  workup: '后处理概览'
};

const condEntries = computed(() => {
  const c = analysis.value?.data?.conditions;
  if (!c) return [] as { key: string; label: string; value: string }[];
  return Object.entries(c)
    .filter(([, v]) => String(v || '').trim())
    .map(([k, v]) => ({ key: k, label: COND_LABELS[k] ?? k, value: String(v) }));
});

/** 后处理分析：从「反应结束」到「拿到纯品」的逐步操作（`notes` 单独渲染成要点） */
const WORKUP_LABELS: Record<string, string> = {
  quench: '淬灭',
  extraction: '萃取 / 分液',
  wash: '洗涤',
  dry: '干燥',
  concentration: '浓缩',
  purification: '纯化',
  recovery: '回收率与纯度'
};

const workupEntries = computed(() => {
  const w = analysis.value?.data?.workup;
  if (!w) return [] as { key: string; label: string; value: string }[];
  return Object.entries(w)
    .filter(([k, v]) => k !== 'notes' && String(v || '').trim())
    .map(([k, v]) => ({ key: k, label: WORKUP_LABELS[k] ?? k, value: String(v) }));
});

const workupNotes = computed(() => analysis.value?.data?.workup?.notes ?? []);

/** 产物 + 各前体的确定性质量（LCMS 数值来源） */
const massRows = computed<MassRow[]>(() => analysis.value?.computed?.rows ?? []);

const productRow = computed<MassRow | undefined>(() => {
  const smiles = node.value?.smiles;
  return massRows.value.find((r) => r.smiles === smiles);
});
const precursorRows = computed<MassRow[]>(() =>
  massRows.value.filter((r) => r.smiles !== node.value?.smiles)
);

function run(force = false): void {
  void store.analyzeStep(props.nodeId, { force });
}
function resume(): void {
  void store.analyzeStep(props.nodeId, { continue: true });
}

/* ---------- 追问（携带上下文，问这一步反应的其他问题） ---------- */
const followups = computed(() => analysis.value?.followups ?? []);
const question = ref('');
const asking = computed(() => followups.value.some((f) => f.status === 'streaming'));

function ask(): void {
  const q = question.value.trim();
  if (!q || asking.value) return;
  // 先清空输入框：提问内容已经交给 store，留着反而让人以为没发出去
  question.value = '';
  void store.askFollowup(props.nodeId, q);
}

/* ---------- 候选反应条件（先枚举多套 → 选一套 → 锁定它深入分析） ---------- */
const plan = computed(() => analysis.value?.condOptions ?? null);
const planStatus = computed(() => plan.value?.status ?? 'idle');
const planStreaming = computed(() => planStatus.value === 'streaming');
const planOptions = computed(() => plan.value?.data?.options ?? []);
/** 推理模型在枚举阶段只吐思考时，也要让人看到「在动」 */
const planThinkingOnly = computed(
  () => !(plan.value?.raw || '').length && !!(plan.value?.reasoning || '').length
);
const chosenId = computed(() => analysis.value?.chosenConditionId);
/** 已选方案对象：从 condOptions 现查（切条件/重新枚举后自动跟着变） */
const chosenOption = computed(() => store.chosenCondition(props.nodeId));
/** 「先列候选条件」这条默认流程还没走：开关开着、且这次还没列过 */
const planFirstPending = computed(
  () => store.condPlanFirst && !planOptions.value.length && planStatus.value !== 'streaming'
);

/** 卡片上的条件摘要（只列有值的字段，顺序固定） */
const PLAN_ROWS: { key: keyof ConditionOption; label: string }[] = [
  { key: 'solvent', label: '溶剂' },
  { key: 'temperature', label: '温度' },
  { key: 'time', label: '时间' },
  { key: 'atmosphere', label: '气氛' },
  { key: 'catalyst', label: '催化剂 / 碱' },
  { key: 'equiv', label: '当量' },
  { key: 'concentration', label: '浓度' },
  { key: 'workup', label: '后处理' }
];

function planRows(o: ConditionOption): { label: string; value: string }[] {
  return PLAN_ROWS.map(({ key, label }) => ({ label, value: String(o[key] ?? '').trim() })).filter(
    (r) => r.value
  );
}

function enumeratePlan(force = false): void {
  void store.analyzeConditions(props.nodeId, { force });
}

/** 选这套条件 → 立刻用它跑一次深入分析（分析会锁定这套条件，不再另换） */
function useOption(o: ConditionOption): void {
  store.chooseCondition(props.nodeId, o.id);
}

/** 取消选择：恢复「不限条件」，按模型自己的判断直接分析 */
function clearChosen(): void {
  store.chooseCondition(props.nodeId, null);
}
</script>

<template>
  <div class="ana">
    <div class="ana__head">
      <span class="ana__title">AI 工艺分析</span>
      <span v-if="analysis?.model" class="ana__model">{{ analysis.model }}</span>
      <span v-if="status === 'done' && analysis?.elapsed" class="ana__meta">
        用时 {{ analysis.elapsed }}s
      </span>
      <div class="ana__ops">
        <el-button
          v-if="status === 'streaming'"
          size="small"
          type="danger"
          plain
          @click="store.cancelAnalysis(nodeId)"
        >
          停止
        </el-button>
        <template v-else>
          <el-button v-if="status === 'done'" size="small" @click="run(true)">重新分析</el-button>
          <el-button
            v-else-if="status === 'failed' && analysis?.raw"
            size="small"
            type="primary"
            @click="resume"
          >
            接着分析
          </el-button>
          <!-- 🔴 「先列候选条件」开着且还没列过时，主按钮就先做这件事 ——
               这是默认流程：先把可能的条件摆出来，挑一套再深入分析。
               列过一次（或关掉这个设置）之后，按钮回到「开始分析」。 -->
          <el-button
            v-else-if="status === 'failed'"
            size="small"
            type="primary"
            @click="run(false)"
          >
            重试
          </el-button>
          <el-button
            v-else-if="planFirstPending"
            size="small"
            type="primary"
            @click="enumeratePlan(false)"
          >
            先看候选条件
          </el-button>
          <el-button v-else size="small" type="primary" @click="run(false)">
            {{ chosenOption ? '按已选条件分析' : '开始分析' }}
          </el-button>
        </template>
        <el-button
          v-if="analysis?.raw"
          size="small"
          text
          @click="showRaw = !showRaw"
        >
          {{ showRaw ? '收起原始输出' : '原始输出' }}
        </el-button>
      </div>
    </div>

    <el-alert
      v-if="!configured"
      type="info"
      :closable="false"
      class="ana__alert"
      :title="store.llmStatus?.hint || '后端未配置大模型'"
    />
    <el-alert
      v-else-if="!reaction"
      type="info"
      :closable="false"
      class="ana__alert"
      title="先在这一步采纳一个候选反应，然后就能分析它的工艺条件"
    />

    <!-- 候选反应条件：反应条件本就有多套可行组合，先枚举再由用户挑一套，
         选定后下面的分析会**锁定**这套条件（后端 prompt 里明确要求不许另换溶剂/温度）。 -->
    <div v-if="reaction" class="ana__plan">
      <div class="ana__h">
        候选反应条件
        <span class="ana__tag-flow">先选条件，再深入分析</span>
      </div>

      <p class="ana__plan-intro">
        溶剂 / 温度 / 碱与缩合剂 / 浓度 / 投料方式通常有多种可行组合。
        先列出候选方案、挑一套，下面的分析就会锁定这套条件展开（而不是只给模型的第一直觉）。
      </p>

      <div class="ana__plan-ops">
        <el-button
          size="small"
          type="primary"
          :loading="planStreaming"
          @click="enumeratePlan(planOptions.length > 0)"
        >
          {{ planOptions.length ? '重新列出候选条件' : '列出候选条件' }}
        </el-button>
        <el-button
          v-if="planStreaming"
          size="small"
          type="danger"
          plain
          @click="store.cancelConditions(nodeId)"
        >
          停止
        </el-button>
        <el-button v-if="chosenId" size="small" text @click="clearChosen">
          不限条件（直接分析）
        </el-button>
      </div>

      <!-- 枚举中：与主分析一样区分「思考」与「正文」 -->
      <div v-if="planStreaming" class="ana__streaming">
        <div class="ana__streaming-line">
          <span class="ana__dot" />
          <template v-if="planThinkingOnly">
            <span>模型正在思考…（已思考 {{ (plan?.reasoning || '').length }} 字）</span>
          </template>
          <template v-else>
            <span>正在列出候选条件…（{{ (plan?.raw || '').length }} 字符）</span>
          </template>
        </div>
        <pre v-if="planThinkingOnly" class="ana__raw ana__raw--think rw-scroll">{{ plan?.reasoning }}</pre>
        <pre v-else class="ana__raw ana__raw--live rw-scroll">{{ plan?.raw || '…' }}</pre>
      </div>

      <div v-else-if="planStatus === 'failed'" class="ana__error">
        <b>候选条件枚举失败：</b>{{ plan?.error || '未知错误' }}
        <el-button size="small" text type="primary" @click="enumeratePlan(true)">重试</el-button>
      </div>

      <template v-else-if="planOptions.length">
        <p v-if="plan?.data?.key_variable" class="ana__plan-key">
          <span>关键变量</span>{{ plan.data.key_variable }}
        </p>

        <div class="ana__plan-grid">
          <div
            v-for="o in planOptions"
            :key="o.id"
            class="ana__plan-card"
            :class="{ 'is-chosen': o.id === chosenId }"
          >
            <div class="ana__plan-card-head">
              <span class="ana__plan-id">{{ o.id }}</span>
              <span class="ana__plan-name">{{ o.name }}</span>
              <span v-if="o.id === chosenId" class="ana__plan-badge">已选</span>
            </div>
            <div v-if="o.strategy" class="ana__plan-strategy">{{ o.strategy }}</div>

            <dl class="ana__plan-cond">
              <template v-for="r in planRows(o)" :key="r.label">
                <dt>{{ r.label }}</dt>
                <dd>{{ r.value }}</dd>
              </template>
            </dl>

            <div v-if="o.pros?.length || o.cons?.length" class="ana__plan-pc">
              <ul v-if="o.pros?.length" class="ana__plan-pros">
                <li v-for="(p, i) in o.pros" :key="i">{{ p }}</li>
              </ul>
              <ul v-if="o.cons?.length" class="ana__plan-cons">
                <li v-for="(c, i) in o.cons" :key="i">{{ c }}</li>
              </ul>
            </div>

            <p v-if="o.risk" class="ana__plan-line"><span>风险</span>{{ o.risk }}</p>
            <p v-if="o.best_for" class="ana__plan-line"><span>适用</span>{{ o.best_for }}</p>

            <div class="ana__plan-card-foot">
              <el-button
                size="small"
                :type="o.id === chosenId ? 'success' : 'primary'"
                :plain="o.id === chosenId"
                @click="useOption(o)"
              >
                {{ o.id === chosenId ? '用它重新分析' : '选它，深入分析' }}
              </el-button>
              <span v-if="typeof o.confidence === 'number'" class="ana__plan-conf">
                把握度 {{ (o.confidence * 100).toFixed(0) }}%
              </span>
            </div>
          </div>
        </div>

        <p v-if="plan?.data?.recommendation" class="ana__plan-rec">
          <span>模型建议</span>{{ plan.data.recommendation }}
        </p>
        <p v-if="plan?.data?.note" class="ana__warn">{{ plan.data.note }}</p>
      </template>
    </div>

    <!-- 流式中：实时显示模型输出 -->
    <div v-if="status === 'streaming'" class="ana__streaming">
      <div class="ana__streaming-line">
        <span class="ana__dot" />
        <template v-if="thinkingOnly">
          <span>模型正在思考…（推理模型，正文稍后开始；已思考 {{ thinkChars }} 字，思考不计入最终结果）</span>
        </template>
        <template v-else>
          <span>模型正在输出…（{{ (analysis?.raw || '').length }} 字符）</span>
        </template>
      </div>
      <!-- 🔴 推理模型的思考必须显示：否则前几十秒界面一个字都不动，看起来像卡死 -->
      <pre v-if="thinkingOnly" class="ana__raw ana__raw--think rw-scroll">{{ analysis?.reasoning || '…' }}</pre>
      <pre v-else class="ana__raw ana__raw--live rw-scroll">{{ analysis?.raw || '…' }}</pre>
    </div>

    <!-- 失败 -->
    <div v-else-if="status === 'failed'" class="ana__error">
      <b>分析失败：</b>{{ analysis?.error || '未知错误' }}
    </div>

    <!-- 思考过程（推理模型，折叠；正文出来后仍可回看） -->
    <details v-if="analysis?.reasoning" class="ana__think">
      <summary>模型思考过程（{{ analysis.reasoning.length }} 字）</summary>
      <pre class="ana__raw ana__raw--think rw-scroll">{{ analysis.reasoning }}</pre>
    </details>

    <!-- 原始输出（折叠） -->
    <pre v-if="showRaw && analysis?.raw" class="ana__raw rw-scroll">{{ analysis.raw }}</pre>

    <!-- 结构化结果 -->
    <template v-if="status === 'done' && analysis?.data">
      <p v-if="analysis.data.summary" class="ana__summary">{{ analysis.data.summary }}</p>
      <div v-if="analysis.data.reaction_type" class="ana__type">
        反应类型：<b>{{ analysis.data.reaction_type }}</b>
      </div>

      <!-- 反应机理：逐步电子转移。放在投料顺序之前 —— 先讲清"为什么"，再谈"怎么投料" -->
      <div v-if="analysis.data.mechanism" class="ana__block">
        <div class="ana__h">
          反应机理
          <span v-if="analysis.data.mechanism.type" class="ana__mech-type">
            {{ analysis.data.mechanism.type }}
          </span>
        </div>

        <ol v-if="analysis.data.mechanism.steps?.length" class="ana__mech-steps">
          <li v-for="(s, i) in analysis.data.mechanism.steps" :key="i">
            <b>{{ s.step || `步骤 ${s.seq ?? i + 1}` }}</b>
            <span v-if="s.detail">{{ s.detail }}</span>
          </li>
        </ol>

        <div v-if="analysis.data.mechanism.intermediates?.length" class="ana__mech-inter">
          <span class="ana__mech-label">中间体</span>
          <ul>
            <li v-for="(it, i) in analysis.data.mechanism.intermediates" :key="i">
              <b>{{ it.name || '—' }}</b>
              <span v-if="it.note"> · {{ it.note }}</span>
            </li>
          </ul>
        </div>

        <dl
          v-if="analysis.data.mechanism.rate_determining || analysis.data.mechanism.selectivity"
          class="ana__cond"
        >
          <template v-if="analysis.data.mechanism.rate_determining">
            <dt>决速步</dt>
            <dd>{{ analysis.data.mechanism.rate_determining }}</dd>
          </template>
          <template v-if="analysis.data.mechanism.selectivity">
            <dt>选择性来源</dt>
            <dd>{{ analysis.data.mechanism.selectivity }}</dd>
          </template>
        </dl>

        <div v-if="analysis.data.mechanism.evidence?.length" class="ana__mech-ev">
          <span class="ana__mech-label">可验证判据</span>
          <ul>
            <li v-for="(ev, i) in analysis.data.mechanism.evidence" :key="i">{{ ev }}</li>
          </ul>
        </div>

        <p class="ana__warn">
          机理为模型基于反应类型的推断，未经实验验证；方框中如有与投料顺序矛盾之处，以实测为准。
        </p>
      </div>

      <div v-if="analysis.data.order?.length" class="ana__block">
        <div class="ana__h">投料顺序与当量</div>
        <table class="ana__table">
          <thead>
            <tr>
              <th>#</th>
              <th>方式</th>
              <th>试剂</th>
              <th>当量</th>
              <th>注意点</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(d, i) in analysis.data.order" :key="i">
              <td>{{ d.seq ?? i + 1 }}</td>
              <td>{{ d.mode || '—' }}</td>
              <td>{{ d.reagent || '—' }}</td>
              <td class="ana__equiv">{{ d.equiv || '—' }}</td>
              <td class="ana__note">{{ d.note || '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="condEntries.length" class="ana__block">
        <div class="ana__h">
          反应条件
          <!-- 条件来自哪套候选方案：让「这份分析是按哪套条件做的」一目了然 -->
          <span v-if="chosenOption" class="ana__cond-lock">
            按候选方案 {{ chosenOption.id }} · {{ chosenOption.name }}
          </span>
        </div>
        <dl class="ana__cond">
          <template v-for="c in condEntries" :key="c.key">
            <dt>{{ c.label }}</dt>
            <dd>{{ c.value }}</dd>
          </template>
        </dl>
      </div>

      <!-- 后处理分析：反应结束 → 拿到纯品的逐步操作（与「条件」里的后处理概览互补） -->
      <div v-if="workupEntries.length || workupNotes.length" class="ana__block">
        <div class="ana__h">
          后处理分析
          <span class="ana__tag-flow">淬灭 → 萃取 → 洗涤 → 干燥 → 浓缩 → 纯化</span>
        </div>
        <dl v-if="workupEntries.length" class="ana__cond">
          <template v-for="w in workupEntries" :key="w.key">
            <dt>{{ w.label }}</dt>
            <dd>{{ w.value }}</dd>
          </template>
        </dl>
        <div v-if="workupNotes.length" class="ana__mech-ev">
          <span class="ana__mech-label">放大注意</span>
          <ul>
            <li v-for="(n, i) in workupNotes" :key="i">{{ n }}</li>
          </ul>
        </div>
      </div>

      <div v-if="analysis.data.outcome" class="ana__block">
        <div class="ana__h">预期结果</div>
        <ul class="ana__outcome">
          <li v-if="analysis.data.outcome.expected">
            <span>转化</span>{{ analysis.data.outcome.expected }}
          </li>
          <li v-if="analysis.data.outcome.yield_range">
            <span>收率</span>{{ analysis.data.outcome.yield_range }}
          </li>
          <li v-if="analysis.data.outcome.purity">
            <span>纯度</span>{{ analysis.data.outcome.purity }}
          </li>
          <li v-if="analysis.data.outcome.risk">
            <span>风险</span>{{ analysis.data.outcome.risk }}
          </li>
        </ul>
      </div>

      <div v-if="analysis.data.byproducts?.length" class="ana__block">
        <div class="ana__h">可能出现的副产物</div>
        <table class="ana__table">
          <thead>
            <tr>
              <th>副产物</th>
              <th>来源机理</th>
              <th>m/z</th>
              <th>控制 / 识别</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(b, i) in analysis.data.byproducts" :key="i">
              <td>{{ b.name || '—' }}</td>
              <td class="ana__note">{{ b.source || '' }}</td>
              <td class="ana__equiv">{{ b.mz || '' }}</td>
              <td class="ana__note">{{ b.control || '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- LCMS：数值用 RDKit 的确定性结果，解释用模型 -->
      <div class="ana__block">
        <div class="ana__h">
          LCMS 预测
          <span class="ana__tag-done">m/z 由 RDKit 精确质量计算</span>
        </div>
        <table v-if="massRows.length" class="ana__table ana__table--lcms">
          <thead>
            <tr>
              <th>分子</th>
              <th>分子式</th>
              <th>精确质量</th>
              <th>[M+H]+</th>
              <th>[M-H]-</th>
              <th>[M+Na]+</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in massRows" :key="r.smiles">
              <td class="ana__smiles">
                <div class="ana__mol">
                  <span v-if="r.smiles === node?.smiles" class="ana__role">产物</span>
                  <span v-else class="ana__role ana__role--pre">前体</span>
                  <div class="ana__struct">
                    <MolView :smiles="r.smiles" :bond-px="22" :min-px="52" :max-px="120" fit />
                  </div>
                </div>
              </td>
              <td>{{ r.formula || '—' }}</td>
              <td>{{ r.exact_mass ?? '—' }}</td>
              <td class="ana__equiv">{{ r.mz_pos ?? '—' }}</td>
              <td>{{ r.mz_neg ?? '—' }}</td>
              <td>{{ r.mz_na ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="productRow" class="ana__lcms-note">
          主产物 [M+H]⁺ ≈ <b>{{ productRow.mz_pos }}</b>，[M-H]⁻ ≈ <b>{{ productRow.mz_neg }}</b>；
          前体残留可在 {{ precursorRows.map((r) => r.mz_pos).filter(Boolean).join(' / ') || '—' }} 处观察。
        </p>
        <p v-if="analysis.data.lcms?.note" class="ana__lcms-note">{{ analysis.data.lcms.note }}</p>
      </div>

      <div v-if="analysis.data.nmr" class="ana__block">
        <div class="ana__h">NMR 预测</div>
        <dl class="ana__cond">
          <dt>1H</dt>
          <dd>{{ analysis.data.nmr.h1 || '—' }}</dd>
          <dt>13C</dt>
          <dd>{{ analysis.data.nmr.c13 || '—' }}</dd>
          <dt v-if="analysis.data.nmr.note">判据</dt>
          <dd v-if="analysis.data.nmr.note">{{ analysis.data.nmr.note }}</dd>
        </dl>
        <p class="ana__warn">谱图预测为经验性估计，仅用于设计验证实验，不能替代实测谱图。</p>
      </div>

      <div v-if="analysis.data.safety?.length" class="ana__block">
        <div class="ana__h">安全与放大提示</div>
        <ul class="ana__safety">
          <li v-for="(s, i) in analysis.data.safety" :key="i">{{ s }}</li>
        </ul>
      </div>

      <div v-if="typeof analysis.data.confidence === 'number'" class="ana__conf">
        模型自评把握度 {{ (analysis.data.confidence * 100).toFixed(0) }}%
        <span class="ana__conf-hint">（低把握度时请务必人工复核）</span>
      </div>
    </template>

    <!-- 追问：分析出结果后，可以带着这一步的上下文继续问它别的问题。
         带过去的是「产物 / 前体 / 路线上下文 + 这份分析 + 上面的历史问答」——
         所以追问能接着前文答，不会答成对另一个反应的评论。 -->
    <div v-if="status === 'done' && analysis?.data" class="ana__fu">
      <div class="ana__h">
        追问
        <span class="ana__tag-flow">携带本步上下文与上文分析</span>
      </div>

      <div v-if="followups.length" class="ana__fu-list">
        <div v-for="f in followups" :key="f.id" class="ana__fu-item">
          <div class="ana__fu-q">
            <span class="ana__fu-qmark">问</span>
            <span>{{ f.q }}</span>
          </div>
          <pre v-if="f.a" class="ana__raw ana__fu-a rw-scroll">{{ f.a }}</pre>
          <div v-else-if="f.status === 'streaming'" class="ana__fu-wait">
            <span class="ana__dot" />
            <span>模型正在回答…（自由文本，不受上面的 JSON 结构约束）</span>
          </div>
          <div v-else class="ana__error">回答失败：{{ f.error || '未知错误' }}</div>
        </div>
      </div>

      <div class="ana__fu-ask">
        <el-input
          v-model="question"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 4 }"
          resize="none"
          :disabled="asking"
          placeholder="问这一步的其他问题，例：放大到 100 g 时放热怎么控？后处理有没有更省溶剂的替代？"
          @keyup.enter.exact="ask"
        />
        <div class="ana__fu-ops">
          <el-button
            type="primary"
            size="small"
            :disabled="!question.trim() || asking"
            :loading="asking"
            @click="ask"
          >
            追问
          </el-button>
          <el-button v-if="asking" size="small" text type="danger" @click="store.cancelFollowup(nodeId)">
            停止
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ana {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 8px 0 12px;
  padding: 12px 14px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.ana__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ana__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
}

.ana__model,
.ana__meta {
  font-size: 11px;
  color: var(--rw-text-3);
}

.ana__ops {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}

.ana__alert :deep(.el-alert__title) {
  font-size: 12px;
}

.ana__summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--rw-text);
}

.ana__type {
  font-size: 12.5px;
  color: var(--rw-text-2);
}

/* ---------- 反应机理 ---------- */
.ana__mech-type {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  color: var(--rw-brand-d);
  background: var(--rw-brand-l);
  border: 1px solid var(--rw-brand-soft);
}

/* 逐步机理：左侧一条竖线串起步骤序号，读起来像一条反应坐标 */
.ana__mech-steps {
  margin: 0;
  padding: 0 0 0 4px;
  list-style: none;
  display: flex;
  flex-direction: column;
  counter-reset: mech;
}

.ana__mech-steps li {
  position: relative;
  counter-increment: mech;
  padding: 0 0 10px 30px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--rw-text-2);
}

/* 连接线：最后一步不画，避免尾巴悬空 */
.ana__mech-steps li::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 18px;
  bottom: 0;
  width: 1px;
  background: var(--rw-border-strong);
}

.ana__mech-steps li:last-child {
  padding-bottom: 0;
}

.ana__mech-steps li:last-child::before {
  display: none;
}

/* 序号圆点 */
.ana__mech-steps li::after {
  content: counter(mech);
  position: absolute;
  left: 0;
  top: 1px;
  width: 23px;
  height: 23px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--rw-brand-l);
  border: 1px solid var(--rw-brand-soft);
  color: var(--rw-brand-d);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.ana__mech-steps li b {
  display: block;
  color: var(--rw-text);
  font-size: 12.5px;
}

.ana__mech-inter,
.ana__mech-ev {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--rw-text-2);
}

.ana__mech-label {
  flex: 0 0 auto;
  margin-top: 1px;
  padding: 0 7px;
  border-radius: 5px;
  background: var(--rw-surface-3);
  color: var(--rw-text-3);
  font-size: 11px;
  white-space: nowrap;
}

.ana__mech-inter ul,
.ana__mech-ev ul {
  margin: 0;
  padding-left: 16px;
  min-width: 0;
}

.ana__mech-inter b {
  color: var(--rw-text);
}

.ana__block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ana__h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--rw-brand-d);
}

.ana__tag-done {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--rw-ok);
  background: var(--rw-ok-l);
  border-radius: 999px;
  padding: 1px 7px;
}

/* 后处理流程提示：中性弱化的胶囊，只作阅读顺序引导 */
.ana__tag-flow {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--rw-text-3);
  background: var(--rw-surface-3);
  border-radius: 999px;
  padding: 1px 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ana__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  background: var(--rw-surface);
  border-radius: 6px;
  overflow: hidden;
}

.ana__table th,
.ana__table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--rw-border);
  text-align: left;
  vertical-align: top;
}

.ana__table th {
  color: var(--rw-text-3);
  font-weight: 500;
  background: var(--rw-surface-3);
}

.ana__table tr:last-child td {
  border-bottom: 0;
}

.ana__equiv {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  white-space: nowrap;
}

.ana__note {
  color: var(--rw-text-2);
  font-size: 11.5px;
}

.ana__smiles {
  min-width: 150px;
}

/* 角标在左、结构式在右，垂直居中 —— 行高由结构图撑起，不浪费纵向空间 */
.ana__mol {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ana__struct {
  width: 140px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rw-border);
  border-radius: 8px;
  background: var(--rw-surface-2);
  padding: 3px;
}

/* LCMS 表：行高被结构图撑起来后，数值列改垂直居中更整齐 */
.ana__table--lcms td,
.ana__table--lcms th {
  vertical-align: middle;
}

.ana__table--lcms tbody td {
  padding-top: 7px;
  padding-bottom: 7px;
}

.ana__role {
  display: inline-block;
  margin-right: 4px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--rw-brand-d);
  background: var(--rw-brand-l);
}

.ana__role--pre {
  color: var(--rw-text-2);
  background: var(--rw-surface-3);
}

.ana__cond {
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr);
  gap: 4px 10px;
  margin: 0;
  font-size: 12px;
}

.ana__cond dt {
  color: var(--rw-text-3);
}

.ana__cond dd {
  margin: 0;
  color: var(--rw-text);
}

.ana__outcome,
.ana__safety {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--rw-text);
}

.ana__outcome span {
  display: inline-block;
  min-width: 40px;
  color: var(--rw-text-3);
}

.ana__lcms-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--rw-text-2);
}

.ana__warn {
  margin: 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--rw-warn-l);
  color: var(--rw-warn);
  font-size: 11.5px;
}

.ana__conf {
  font-size: 11.5px;
  color: var(--rw-text-3);
}

.ana__conf-hint {
  opacity: 0.8;
}

.ana__error {
  font-size: 12px;
  color: var(--rw-bad);
}

.ana__streaming {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ana__streaming-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rw-brand-d);
}

.ana__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--rw-brand);
  animation: ana-pulse 1s ease-in-out infinite;
}

@keyframes ana-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}

.ana__raw {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--rw-border);
  border-radius: 6px;
  background: var(--rw-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--rw-text-2);
}

.ana__raw--live {
  max-height: 180px;
}

/* 推理模型的「思考」区：视觉上刻意弱化、偏灰斜体，与最终答案区分开 */
.ana__raw--think {
  max-height: 180px;
  font-style: italic;
  opacity: 0.72;
}

.ana__think {
  border: 1px dashed var(--rw-border);
  border-radius: 6px;
  padding: 6px 8px;
  background: transparent;
}

.ana__think > summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--rw-text-3, var(--rw-text-2));
  user-select: none;
}

.ana__think > summary:hover {
  color: var(--rw-brand);
}

.ana__think .ana__raw {
  margin-top: 6px;
}

/* ---------- 候选反应条件 ---------- */
.ana__plan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.ana__plan-intro {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.ana__plan-ops {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ana__plan-key,
.ana__plan-rec {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--rw-text-2);
}

.ana__plan-key > span,
.ana__plan-rec > span {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-size: 10.5px;
  font-weight: 600;
}

/* 卡片网格：列宽有下限，窄栏（右辅助面板）也不会把条件挤成一列字 */
.ana__plan-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(258px, 1fr));
  gap: 10px;
}

.ana__plan-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

.ana__plan-card.is-chosen {
  border-color: var(--rw-ok);
  box-shadow: 0 0 0 2px var(--rw-ok-l);
}

.ana__plan-card-head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.ana__plan-id {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--rw-brand);
  color: #fff;
  font-size: 11.5px;
  font-weight: 700;
}

.ana__plan-name {
  flex: 1 1 auto;
  font-size: 13px;
  font-weight: 600;
  color: var(--rw-text);
}

.ana__plan-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--rw-ok);
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
}

.ana__plan-strategy {
  align-self: flex-start;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--rw-brand-soft);
  color: var(--rw-brand-d);
  font-size: 11px;
}

.ana__plan-cond {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 8px;
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.ana__plan-cond dt {
  color: var(--rw-text-3);
  white-space: nowrap;
}

.ana__plan-cond dd {
  margin: 0;
  color: var(--rw-text-2);
  word-break: break-word;
}

.ana__plan-pc ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.65;
}

.ana__plan-pros {
  color: var(--rw-ok);
}

.ana__plan-cons {
  color: var(--rw-warn);
}

.ana__plan-line {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--rw-text-2);
}

.ana__plan-line > span {
  display: inline-block;
  margin-right: 6px;
  color: var(--rw-text-3);
}

.ana__plan-card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  /* margin-top:auto：卡片高度不一时，按钮沉到同一条基线上 */
  margin-top: auto;
  padding-top: 4px;
}

.ana__plan-conf {
  font-size: 11px;
  color: var(--rw-text-3);
}

/* 「这份分析是按哪套候选条件做的」—— 贴在「反应条件」标题右侧 */
.ana__cond-lock {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--rw-ok-l);
  color: var(--rw-ok);
  font-size: 10.5px;
  font-weight: 600;
}

/* ---------- 追问 ---------- */
.ana__fu {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--rw-border);
}

.ana__fu-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ana__fu-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ana__fu-q {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--rw-text);
}

.ana__fu-qmark {
  flex: 0 0 auto;
  margin-top: 1px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--rw-brand-l);
  color: var(--rw-brand-d);
  font-size: 10.5px;
  font-weight: 600;
}

/* 回答是自由文本（可能是 markdown 段落），用等宽块但允许换行阅读 */
.ana__fu-a {
  max-height: 320px;
  background: var(--rw-surface);
}

.ana__fu-wait {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rw-brand-d);
}

.ana__fu-ask {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.ana__fu-ask :deep(.el-textarea) {
  flex: 1;
  min-width: 0;
}

.ana__fu-ops {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 0 0 auto;
}
</style>
