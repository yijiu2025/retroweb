<script setup lang="ts">
/** 路线树容器：工具条 + 根节点递归渲染 */
import { computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useWorkspaceStore } from '@/stores/workspace';
import StepRow from './StepRow.vue';
import SearchProgress from './SearchProgress.vue';

const emit = defineEmits<{ preview: [smiles: string] }>();
const store = useWorkspaceStore();

const stats = computed(() => store.stats);
/** 已确认的路线网络条数（同一目标可以确认多条，例如小试 / 放大各一条） */
const confirmedCount = computed(() => store.confirmedNetworkCount);

/**
 * 「确认路线网络」—— 把当前树上采纳的路线记成一条**已确认的网络**。
 *
 * 为什么入口放在这里：确认是「这棵树拆到这一步，路线成立」的判断，
 * 判断发生在**树**上（展开候选 → 采纳 → 满意）。放在别处就得先切页签再回来。
 *
 * 两条分支由 store 决定：当前方案没被改动 ⇒ 就地确认（不新建重复记录）；
 * 已经把某一步换成别的候选 ⇒ 自动分叉一条新记录（老方案原样保留）。
 */
function onConfirm(): void {
  if (!store.route.length) {
    ElMessage.warning('还没有可确认的路线：先展开候选并采纳其中一步');
    return;
  }
  const id = store.confirmRouteNetwork();
  if (!id) return;
  ElMessage.success(
    `已确认这条路线网络（${store.route.length} 步），可在左栏「目标分析 → 路线网络」查看与切换`
  );
}

async function onSave(): Promise<void> {
  if (!store.rootId) {
    ElMessage.warning('还没有路线可保存');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt('给这个任务起个名字', '保存到历史', {
      inputPlaceholder: '例如：布洛芬路线 v1',
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    });
    store.saveHistory(value?.trim() || '');
    ElMessage.success('已保存到历史记录');
  } catch {
    /* 用户取消 */
  }
}

async function onReset(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空当前整棵路线树（参数保留），确定吗？', '清空工作台', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  store.reset({ keepParams: true });
}
</script>

<template>
  <section class="rw-card tree">
    <!-- 头部 = 左统计 chips + 右工具按钮。
         不再放「路线树」大标题：外层页签已经说明语境，重复标题只会浪费一行 -->
    <div class="rw-card__head">
      <div class="tree__stats">
        <span class="tree__stat">节点 <b>{{ stats.total }}</b></span>
        <span class="tree__stat">已终止 <b>{{ stats.terminal }}</b></span>
        <span class="tree__stat">已采纳步骤 <b>{{ stats.reactions }}</b></span>
        <span class="tree__stat">最深 <b>第 {{ stats.maxDepth + 1 }} 层</b></span>
        <span class="tree__stat">路线网络 <b>{{ confirmedCount }}</b></span>
      </div>
      <div class="tree__ops">
        <el-button link size="small" @click="store.collapseAll()">折叠全部</el-button>
        <el-button link size="small" @click="store.expandAll()">展开全部</el-button>
        <!-- 拆到满意就在这里确认：确认后的多步路线 = 一条「路线网络」，
             可以有多个（再拆出别的一条、再确认即可，两条都留着可切换） -->
        <el-button size="small" type="primary" plain @click="onConfirm">确认路线网络</el-button>
        <el-button link size="small" type="primary" @click="onSave">保存</el-button>
        <el-button link size="small" type="danger" @click="onReset">清空</el-button>
      </div>
    </div>

    <div class="rw-card__body tree__body rw-scroll">
      <StepRow v-if="store.rootId" :node-id="store.rootId" @preview="(s) => emit('preview', s)" />
      <el-empty v-else description="先设定目标分子并拆解，路线会在这里逐层长出来" :image-size="80" />
      <!-- 多步搜索的动画面板：跑的时候树体本来只有根节点、其余全是留白，
           用户从主区完全看不出"在跑"（进度只在右栏底部那行小字里）。
           放在根节点**之后** ⇒ 它正好落在留白的中央偏上，不遮挡根卡片。
           显示与否由组件内部判 `store.autoRunning`，这里不做条件渲染。 -->
      <SearchProgress />
    </div>
  </section>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 按钮变多了（折叠 / 展开 / 确认路线网络 / 保存 / 清空）⇒ 允许换行，
   窄屏下不会把左边的统计 chips 挤扁 */
.tree__ops {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

/* 统计 chips：并入头部后由「一条灰行」变成「一组轻量徽标」，信息不变、层级更清爽 */
.tree__stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tree__stat {
  padding: 2px 9px;
  border: 1px solid var(--rw-border);
  border-radius: 999px;
  background: var(--rw-surface-2);
  font-size: 11.5px;
  color: var(--rw-text-3);
  white-space: nowrap;
}

.tree__stat b {
  color: var(--rw-text);
  font-weight: 600;
  margin-left: 2px;
}

.tree__body {
  flex: 1;
  min-height: 240px;
  max-height: calc(100vh - 260px);
  padding: 10px 12px;
}
</style>
