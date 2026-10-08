<script setup lang="ts">
/**
 * 「编辑这一步」—— 手动指定某一步前体的界面（= 自己改一条路线）。
 *
 * 两个入口都只是把 store 的 `stepEditNodeId` 设上：
 *   · 路线网络里**双击卡片**；
 *   · 候选面板的「手动指定前体」。
 * 所以本组件不接 props / 不 emit，自己读 store —— 全应用**只挂一份**
 * （弹窗里挂着 Ketcher 画板，一份就是一份 WASM 常驻内存，见 store 里 `stepEditNodeId` 注释）。
 *
 * 语义：改的是**"这一步用什么原料"**，不是"改产物"。产物由它所在的节点定死；
 * 这里换前体组合，生成一条 `origin: 'manual'` 的候选反应并采纳。
 * 「插入一个中间体」就是它的一种用法 —— 把某个前体换成自己画的新分子，
 * 那个新分子会成为一个可继续展开 / 继续手改的普通节点。
 *
 * 🔴 校验口径在 store（`manualPrecursorIssue`），本组件只负责**提前把话说清楚**：
 *    在这里另写一份判断，两处判据一分叉就会出现「界面说行、点了没反应」。
 * 🔴 提交的是 RDKit 解析后的**规范 SMILES**，不是用户敲的原文 ——
 *    否则同一个分子会因为写法不同（`c1ccccc1` / `C1=CC=CC=C1`）被当成两个节点。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import { depictMolfile, parseStructure } from '@/utils/rdkit';
import MolView from '@/components/mol/MolView.vue';
import StructureEditor from '@/components/mol/StructureEditor.vue';

const store = useWorkspaceStore();

/** 弹窗开关直接绑 store（单向状态：接口只暴露 open/close，别在别处改这个 ref） */
const open = computed({
  get: () => !!store.stepEditNodeId,
  set: (v: boolean) => {
    if (!v) store.closeStepEditor();
  }
});

const node = computed(() =>
  store.stepEditNodeId ? store.nodes[store.stepEditNodeId] : undefined
);

/* ---------- 草稿行 ---------- */

interface DraftRow {
  key: number;
  /** 用户手上的原文（可能是 SMILES / MOL / 画板产物） */
  text: string;
  /** 解析后的规范 SMILES —— **应用时提交的是它** */
  canonical: string;
  /**
   * 🔴 **产生 `canonical` 的那一次输入**（trim 后）。
   * 判"这一行现在还好不好用"只比 `canonical` 是不够的：`canonical` 是上一次校验时
   * 留下的，输入框被清空 / 改写并不会作废它 —— 空框会一直挂着上一个分子的 canonical。
   */
  srcText: string;
  state: 'idle' | 'checking' | 'ok' | 'bad';
  msg: string;
  formula: string;
}

/**
 * 这一行是不是「按**当前**输入校验通过」的。
 * 清空或改写输入会立刻让它变 false（**不需要 blur**），界面上据此决定
 * 还说不能说「已识别」、以及这一行能不能进提交清单。
 */
function rowClean(r: DraftRow): boolean {
  return r.state === 'ok' && !!r.canonical && r.srcText === r.text.trim();
}

let rowSeq = 0;
function blankRow(text = ''): DraftRow {
  rowSeq += 1;
  return { key: rowSeq, text, canonical: '', srcText: '', state: 'idle', msg: '', formula: '' };
}

const rows = ref<DraftRow[]>([]);
const saving = ref(false);

/**
 * 打开时用「现在这一步」的前体填初值。
 * 绝大多数编辑都是在现有基础上换掉/加一个组分，给一张空表等于让人把整组原料重敲一遍。
 */
watch(
  () => store.stepEditNodeId,
  (id) => {
    if (!id) return;
    const n = store.nodes[id];
    if (!n) return;
    const seed = n.candidates.find((r) => r.id === n.chosenReactionId)?.precursorList ?? [];
    rows.value = (seed.length ? seed : ['']).map((s) => {
      const r = blankRow(s);
      // 带出来的本来就是我们自己存过的规范 SMILES ⇒ 直接标 ok，不白跑一次 RDKit
      if (s) {
        r.canonical = s;
        r.srcText = s;
        r.state = 'ok';
      }
      return r;
    });
  },
  { immediate: true }
);

/* ---------- 校验 ---------- */

async function verifyRow(row: DraftRow): Promise<boolean> {
  const text = row.text.trim();
  if (!text) {
    // 空行不是"错"，是"这一行没有东西" ⇒ 返回 true，
    // 否则 verifyAll 会被空行绊倒、报成"有结构没通过校验"（驴唇不对马嘴）
    row.state = 'idle';
    row.canonical = '';
    row.srcText = '';
    row.formula = '';
    row.msg = '';
    return true;
  }
  // 这一行已经按**当前输入**校验过了 ⇒ 不重复跑 RDKit
  if (rowClean(row)) return true;
  row.state = 'checking';
  row.msg = '';
  const res = await parseStructure(text);
  row.srcText = text;
  if (res.ok) {
    row.canonical = res.smiles;
    row.formula = res.formula ?? '';
    row.state = 'ok';
    return true;
  }
  row.canonical = '';
  row.formula = '';
  row.state = 'bad';
  row.msg = res.error || res.reasons?.[0] || '这个结构 RDKit 认不出来';
  return false;
}

/** 逐行**串行**校验：RDKit 的解析在同一线程排队，并发只会互相等，还容易看花顺序 */
async function verifyAll(): Promise<boolean> {
  let allOk = true;
  for (const r of rows.value) {
    const ok = await verifyRow(r);
    if (!ok) allOk = false;
  }
  return allOk;
}

function onRowBlur(row: DraftRow): void {
  void verifyRow(row);
}

/* ---------- 增删 / 载入 ---------- */

function addRow(): void {
  rows.value = [...rows.value, blankRow()];
}

function removeRow(key: number): void {
  const next = rows.value.filter((r) => r.key !== key);
  rows.value = next.length ? next : [blankRow()];
}

/** 换一组前体（从别的候选 / 起始物料清单载入），省得重敲 */
function loadFrom(list: string[]): void {
  if (!list.length) return;
  rows.value = list.map((s) => {
    const r = blankRow(s);
    r.canonical = s;
    r.srcText = s;
    r.state = 'ok';
    return r;
  });
}

/** 「载入」下拉的可选项：这个节点上其它候选给出的前体组合 */
const otherOptions = computed(() =>
  (node.value?.candidates ?? [])
    .filter((r) => r.id !== node.value?.chosenReactionId)
    .slice(0, 12)
    .map((r) => ({
      id: r.id,
      label: `${r.origin === 'manual' ? '手动' : `#${r.rank}`} · ${r.precursorList.join(' + ')}`,
      list: r.precursorList
    }))
);

/* ---------- 画板 ---------- */

const drawOpen = ref(false);
const drawIndex = ref<number | null>(null);
const drawRef = ref<InstanceType<typeof StructureEditor> | null>(null);
const drawBusy = ref(false);
const drawError = ref('');
/** 上一次灌进画板的 smiles —— 结构没变且画板非空时让你接着改，别冲掉画到一半的图 */
const drawSeeded = ref('');

async function openDraw(i: number): Promise<void> {
  const row = rows.value[i];
  if (!row) return;
  drawIndex.value = i;
  drawOpen.value = true;
  drawError.value = '';
  await nextTick();
  const ed = drawRef.value;
  if (!ed) return;
  // 把这一行已有的结构带进画板（SMILES 不是空才带）—— 开一张空画板等于让人重画
  const seed = row.canonical || row.text.trim();
  if (!seed) return;
  try {
    // 🔴 Ketcher 的读取接口全是异步的（要过 WASM worker），`isEmpty()` 漏 await 会恒为真
    if (seed === drawSeeded.value && !(await ed.isEmpty())) return;
    const mol = await depictMolfile(seed);
    if (mol) {
      await ed.loadFromMolfile(mol);
      drawSeeded.value = seed;
    }
  } catch {
    /* 载不进去就让用户直接画，不打断 */
  }
}

async function confirmDraw(): Promise<void> {
  const ed = drawRef.value;
  const i = drawIndex.value;
  if (!ed || i === null) return;
  drawBusy.value = true;
  drawError.value = '';
  try {
    if (await ed.isEmpty()) {
      ElMessage.warning('画板还是空的，先画一个结构');
      return;
    }
    const res = await parseStructure(await ed.getMolfile());
    if (!res.ok) {
      drawError.value = res.error || res.reasons?.[0] || '这个结构 RDKit 判不合法';
      return;
    }
    const row = rows.value[i];
    if (row) {
      row.text = res.smiles;
      row.canonical = res.smiles;
      row.srcText = res.smiles;
      row.formula = res.formula ?? '';
      row.state = 'ok';
      row.msg = '';
      drawSeeded.value = res.smiles;
    }
    drawOpen.value = false;
  } finally {
    drawBusy.value = false;
  }
}

/* ---------- 提交 ---------- */

/**
 * 当前**手上有内容**的前体清单（与 store 同口径：去空、去重；顺序由 store 再排序）。
 * 已按当前输入校验过的行给规范 SMILES，没校验过的暂时给原文 —— 这份只用于
 * 「还差什么」的提示与准入预检，**不是**提交内容（提交见 `canonicalList()`）。
 *
 * 🔴 判"这一行有没有内容"必须看 `text`，**不能**看 `canonical`：
 *    `canonical` 是上一次校验留下的，清空输入框不会作废它（`fill('')` 只 focus 不 blur）
 *    ⇒ 拿它当判据时，一个空框仍会被算成"有一个前体"，「应用」照旧可点、还不说原因。
 */
const draftList = computed(() => [
  ...new Set(
    rows.value
      .map((r) => {
        const t = r.text.trim();
        if (!t) return '';
        return rowClean(r) ? r.canonical : t;
      })
      .filter(Boolean)
  )
]);

/**
 * 提交清单：**只认校验通过的规范 SMILES**。
 * 提交原文不行 —— 同一个分子的不同写法（`c1ccccc1` / `C1=CC=CC=C1`）会被当成两个节点，
 * 而且 store 侧的去重 / 成环判据也是按规范形式比的。
 */
function canonicalList(): string[] {
  return [...new Set(rows.value.filter(rowClean).map((r) => r.canonical))];
}

/** 本地能看出来的问题（结构没过校验这类）—— 准入判据本身在 store */
const localIssue = computed(() => {
  if (rows.value.some((r) => r.state === 'checking')) return '正在校验结构…';
  if (rows.value.some((r) => r.state === 'bad')) return '有结构没通过校验，先修好再应用';
  if (!draftList.value.length) return '至少要填一个前体';
  return '';
});

/** store 的准入判据（自环 / 成环）—— 与 setPrecursors 同一份，绝不另写 */
const storeIssue = computed(() => {
  const id = store.stepEditNodeId;
  if (!id || !draftList.value.length) return '';
  return store.manualPrecursorIssue(id, draftList.value) ?? '';
});

const blockReason = computed(() => localIssue.value || storeIssue.value);
const canApply = computed(() => !blockReason.value && draftList.value.length > 0);

async function apply(): Promise<void> {
  const id = store.stepEditNodeId;
  if (!id) return;
  saving.value = true;
  try {
    if (!(await verifyAll())) {
      ElMessage.warning('有结构没通过校验，先修好再应用');
      return;
    }
    const list = canonicalList();
    if (!list.length) {
      ElMessage.warning('至少要填一个前体');
      return;
    }
    const issue = store.manualPrecursorIssue(id, list);
    if (issue) {
      ElMessage.warning(issue);
      return;
    }
    if (!store.setPrecursors(id, list)) {
      ElMessage.error('没能应用这次修改，请检查前体组合');
      return;
    }
    ElMessage.success(
      `已按手动指定的 ${list.length} 个前体重建这一步（原来的分支收起了，随时可以切回）`
    );
    store.closeStepEditor();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="编辑这一步"
    width="min(760px, 94vw)"
    align-center
    :close-on-click-modal="false"
    class="sed__dialog"
  >
    <div v-if="node" class="sed">
      <!-- 产物：只读。这里改的是"用什么原料"，产物由节点定死 -->
      <div class="sed__product">
        <div class="sed__product-struct"><MolView :smiles="node.smiles" fit /></div>
        <div class="sed__product-meta">
          <span class="sed__band">产物（不可改）</span>
          <code class="rw-mono" :title="node.smiles">{{ node.smiles }}</code>
        </div>
      </div>

      <p class="sed__tip">
        手动指定这一步的原料 —— 生成的是<strong>你自己定的反应</strong>，不是模型给的。
        所以它没有概率（沿途标「手动」），与别的路线<strong>概率不可比</strong>；
        这一步原来的分支会先收起（不删除），随时可以切回去。
      </p>

      <div class="sed__head">
        <span class="sed__label">前体（原料）</span>
        <div class="sed__head-ops">
          <el-dropdown
            v-if="otherOptions.length"
            trigger="click"
            size="small"
            @command="(id: string) => loadFrom(otherOptions.find((o) => o.id === id)?.list ?? [])"
          >
            <el-button size="small" plain>从已有候选载入</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="o in otherOptions" :key="o.id" :command="o.id">
                  <span class="sed__opt">{{ o.label }}</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button size="small" @click="addRow">添加前体</el-button>
        </div>
      </div>

      <div class="sed__rows">
        <div v-for="(row, i) in rows" :key="row.key" class="sed__row">
          <span class="sed__idx">{{ i + 1 }}</span>
          <el-input
            v-model="row.text"
            class="sed__input"
            size="small"
            placeholder="SMILES，或粘 MOL / SDF，或点右边画一个"
            spellcheck="false"
            @blur="onRowBlur(row)"
          />
          <el-button size="small" plain @click="openDraw(i)">画</el-button>
          <el-button size="small" text type="danger" @click="removeRow(row.key)">删除</el-button>
          <div class="sed__row-state">
            <span v-if="row.state === 'checking'" class="sed__state is-wait">校验中…</span>
            <span v-else-if="rowClean(row)" class="sed__state is-ok">
              已识别<template v-if="row.formula"> · {{ row.formula }}</template>
            </span>
            <span v-else-if="row.state === 'bad'" class="sed__state is-bad">{{ row.msg }}</span>
          </div>
        </div>
      </div>

      <el-alert v-if="blockReason" type="warning" :closable="false" class="sed__block">
        {{ blockReason }}
      </el-alert>
    </div>

    <template #footer>
      <span class="sed__foot-hint">
        {{ draftList.length ? `这一步将用 ${draftList.length} 个前体` : '还没有填前体' }}
      </span>
      <el-button @click="store.closeStepEditor()">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!canApply" @click="apply">
        应用
      </el-button>
    </template>

    <!-- 画板：内层弹窗。Ketcher 首次打开才拉内核（懒加载），这里不预加载 -->
    <el-dialog
      v-model="drawOpen"
      title="绘制前体结构"
      width="min(1180px, 94vw)"
      align-center
      :close-on-click-modal="false"
      append-to-body
    >
      <StructureEditor v-if="drawOpen" ref="drawRef" />
      <el-alert v-if="drawError" type="error" :closable="false" class="sed__draw-err">
        {{ drawError }}
      </el-alert>
      <template #footer>
        <el-button @click="drawOpen = false">取消</el-button>
        <el-button type="primary" :loading="drawBusy" @click="confirmDraw">用这个结构</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.sed__product {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface-2);
}

.sed__product-struct {
  flex: none;
  width: 128px;
  height: 74px;
  overflow: hidden;
}

.sed__product-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sed__band {
  align-self: flex-start;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--rw-text-3);
  background: var(--rw-surface);
  border: 1px solid var(--rw-border);
}

.sed__product-meta code {
  font-size: 12px;
  color: var(--rw-text-2);
  word-break: break-all;
}

.sed__tip {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--rw-text-3);
}

.sed__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 14px 0 8px;
}

.sed__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--rw-text);
}

.sed__head-ops {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sed__opt {
  font-size: 12px;
}

.sed__rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 🔴 行内用 grid 定列：输入框吃掉剩余宽度，右侧三个控件宽度固定 ——
   用 flex + 输入框 flex:1 在窄屏上会把「画」按钮挤到第二行去 */
.sed__row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
}

.sed__idx {
  font-size: 12px;
  color: var(--rw-text-3);
  text-align: center;
}

.sed__row-state {
  grid-column: 2 / -1;
}

.sed__state {
  font-size: 11px;
}

.sed__state.is-wait {
  color: var(--rw-text-3);
}

.sed__state.is-ok {
  color: var(--rw-brand);
}

.sed__state.is-bad {
  color: var(--rw-danger, #d33);
}

.sed__block {
  margin-top: 12px;
}

.sed__foot-hint {
  float: left;
  font-size: 12px;
  line-height: 32px;
  color: var(--rw-text-3);
}

.sed__draw-err {
  margin-top: 10px;
}
</style>
