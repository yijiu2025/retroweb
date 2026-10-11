/**
 * 工作台 store 的「模型域」零件。
 *
 * 装的是**模型服务本身的生命周期**：模型矩阵、正向模型、加载 / 停止 / 预热、
 * 以及"模型还在加载时每 1.5 秒重读一次"的轮询。
 *
 * 为什么单独成文件：它只靠 `params`（拿当前选中的模型 key）和 `setGlobalError`
 * 两样东西跟外界打交道，是整棵 store 里唯一**完全自包含**的一块 —— 从 3000 行的
 * store 里切出来不会牵动路线树的任何逻辑。
 *
 * 形态是**工厂函数**而不是 composable：这些 ref 必须活在主 store 的 setup 作用域里，
 * 不能挂在某个组件上（模型状态是全局的、跨页签的）。
 */
import { computed, ref, type Ref } from 'vue';
import { isUnauthorizedError } from '@/api/http';
import { retroApi } from '@/api/retro';
import type {
  ForwardModelInfo,
  ModelServiceInfo,
  RetroModel,
  RunParams
} from '@/types/retro';

/** 模型加载期间的状态轮询间隔（毫秒） */
const MODELS_POLL_MS = 1500;
/** 轮询连续失败几次就收手（后端都没了还每秒打一次没有意义） */
const MODELS_POLL_MAX_FAILS = 3;

/** 零件需要的外部东西 —— 只这两样，多一点都不给（防它长回成第二个 store） */
interface ModelsPartCtx {
  params: Ref<RunParams>;
  setGlobalError: (msg: string, retry?: (() => void) | null) => void;
}

function createModelsPart(ctx: ModelsPartCtx) {
  const models = ref<RetroModel[]>([]);
  const modelsLoading = ref(false);
  /**
   * 正在「加载 / 切换」的那个模型 key（null = 没有进行中的操作）。
   * 它是**按钮的 loading 态**，不是模型状态 —— 模型状态看每行的 `state`。
   */
  const modelLoadingKey = ref<string | null>(null);
  /** 正在停止模型服务（回收规则子进程要几秒） */
  const modelStopping = ref(false);
  /**
   * 模型服务（独立常驻进程 :8001）的概览；老后端不给这个字段 ⇒ null。
   *
   * TODO(Node 中转): 这是个**单例** ref —— 本文件与"只跑一个模型"之间**唯一真正的耦合点**。
   *   走 Node 后模型加载归 Node 管、前端只问"能不能用"，且要允许多模型并行 ⇒ 改成按模型
   *   各存一份状态（见 docs/plan-node-backend.md §6.7）。
   */
  const modelService = ref<ModelServiceInfo | null>(null);
  /**
   * 正向模型（「可行性过滤」的判据）。
   *
   * 🔴 与 `models` 是两个不同的东西，不能混：`models` 里每一行都能当**搜索主模型**，
   *    而正向模型只是个附件 —— 混进去就会冒出一格"可选的预测模型"，选中它跑逆合成
   *    必然失败。所以它单独一个 ref，界面上也只出现在「可行性过滤」那一行。
   *    老后端不返回这个字段 ⇒ null，界面按「没有正向模型」渲染。
   */
  const forwardModel = ref<ForwardModelInfo | null>(null);
  /** 正向模型的「加载」按钮在转圈（null = 没有进行中的操作） */
  const forwardLoadingKey = ref<string | null>(null);
  /** 模型状态轮询定时器（null = 没在轮询） */
  let modelsPollTimer: ReturnType<typeof setInterval> | null = null;
  /** 轮询连续失败次数 */
  let modelsPollFails = 0;

  /**
   * 认不出来的失败才叫「错误」——**登录态缺失不算**。
   *
   * 两条路都会走到这里：
   *   · `apiClient`（http.ts）侧的 401 ⇒ `handle401` 已置过期 + 弹出 iframe 登录窗，
   *     并给 reject 出来的 Error 打了哨兵（见 `isUnauthorizedError`）；
   *   · `retroClient`（api/retro.ts）侧没有 401 拦截器，401 以
   *     「Request failed with status code 401」的 axios 原生 message 冒泡上来。
   *
   * 🔴 为什么必须拦掉：本零件在**页面挂载时就拉模型**（AppShell / WorkspaceView 都拉），
   *    而那一刻用户多半还没登录 ⇒ 首屏必然吃一个 401。若照常 `setGlobalError`，
   *    用户看到的是「登录已过期，请重新登录」——他根本没登录过，这句话既误导，
   *    又和同时弹出的登录窗吵成一团。401 的**唯一**呈现方式应该是登录窗本身。
   */
  function isAuthFailure(e: unknown): boolean {
    // ① 哨兵（唯一可靠判据）：两条 http 客户端都会给 401 打同一个标记
    if (isUnauthorizedError(e)) return true;
    // ② 兜底：万一还有第三方出口没打标记。🔴 只作为**最后一道**，主判据必须是哨兵 ——
    //    在文案上做判据意味着"后端措辞一变，判据就静默失效"（实测已红过一次）。
    return /status code 401/i.test((e as Error)?.message ?? '');
  }

  /** 报错出口：401 让位给登录流，其余照常进全局错误条 */
  function reportError(e: unknown, retry: (() => void) | null = null): void {
    if (isAuthFailure(e)) return;
    ctx.setGlobalError((e as Error).message, retry);
  }

  /**
   * 真拉一次模型状态矩阵（内部件，不负责 loading 态与错误提示）。
   *
   * 🔴 单独抽出来是为了让**轮询**和**用户点刷新**共用同一条取数路径：
   *    轮询每 1.5 秒跑一次，若它去动 `modelsLoading`，下拉框就会一直闪转圈；
   *    若它去 `setGlobalError`，网络抖一下就弹出错误条。所以取数与"怎么呈现"分开。
   */
  async function fetchModels(): Promise<void> {
    const res = await retroApi.models();
    models.value = res.models ?? [];
    modelService.value = res.service ?? null;
    // 老后端不返回 forward ⇒ 保持 null（界面按「没有正向模型」渲染，开关禁用）。
    forwardModel.value = res.forward ?? null;
    if (models.value.length && !models.value.some((m) => m.key === ctx.params.value.model)) {
      // 换过默认模型时优先落到「已经就绪」的那一个，其次才是文件存在的第一个
      const pick =
        models.value.find((m) => m.state === 'ready') ??
        models.value.find((m) => m.exists !== false) ??
        models.value[0];
      ctx.params.value.model = pick.key;
    }
    syncModelsPolling();
  }

  /** 拉模型列表（用户可见的入口：首次挂载 / 加载失败后的重试） */
  async function loadModels(): Promise<void> {
    modelsLoading.value = true;
    try {
      await fetchModels();
    } catch (e) {
      // 🔴 未登录时这里必然失败，且失败信息已经被登录窗接管 ⇒ 不占错误条
      reportError(e, () => void loadModels());
      models.value = [];
      modelService.value = null;
      forwardModel.value = null;
      stopModelsPolling();
    } finally {
      modelsLoading.value = false;
    }
  }

  /**
   * 模型只要还在加载，就每 1.5 秒重读一次 `/api/models`，直到它落到终态。
   *
   * 🔴 为什么必须轮询：`/api/load` 是**立刻返回**的（只表示"已受理"），
   *    模型要 40~90 秒才真的能用。没有轮询，界面就永远停在"加载中"，
   *    用户分不清是在正常加载还是卡死了 —— 也就谈不上"什么时候加载好显示就绪"。
   *
   * 🔴 为什么不能依赖 WebSocket / SSE：模型服务在加载期间**连 HTTP 都还没起**
   *    （它必须先在单线程阶段把模型加载完，见 web/model_server.py），
   *    没有任何长连接可挂。只能轮询。
   */
  function syncModelsPolling(): void {
    // 🔴 正向模型也要算进去：它在 HTTP 起来之后热挂，加载期间 `service.state` 是
    //    ready（逆向模型早就绪了）、`models` 里也没有任何 loading 行 —— 只看这两者
    //    的话轮询会立刻停掉，按钮就永远停在「加载中」，用户只能手动刷新页面。
    const busy =
      modelService.value?.state === 'loading' ||
      forwardModel.value?.state === 'loading' ||
      models.value.some((m) => m.state === 'loading');
    if (!busy) {
      stopModelsPolling();
      return;
    }
    if (modelsPollTimer !== null) return;
    modelsPollFails = 0;
    modelsPollTimer = setInterval(() => {
      void fetchModels()
        .then(() => {
          modelsPollFails = 0;
        })
        .catch(() => {
          // 轮询失败**静默**（不弹错误条）：网络抖一下不该刷屏。
          // 但连续失败到上限就停 —— 后端都没了还每秒打一次毫无意义。
          if (++modelsPollFails >= MODELS_POLL_MAX_FAILS) stopModelsPolling();
        });
    }, MODELS_POLL_MS);
  }

  function stopModelsPolling(): void {
    if (modelsPollTimer !== null) {
      clearInterval(modelsPollTimer);
      modelsPollTimer = null;
    }
    modelsPollFails = 0;
  }

  /**
   * 加载 / 切换模型（「模型后启动」的用户入口）。
   *
   * 后端立刻返回「已受理」，随后由 `syncModelsPolling` 接手，直到就绪。
   * 换模型 = 重启模型服务进程（加载必须在单线程阶段完成），所以这里会等几秒。
   */
  async function warmModel(key?: string): Promise<void> {
    const target = key || ctx.params.value.model;
    modelLoadingKey.value = target;
    try {
      const res = await retroApi.loadModel(target);
      if (res && res.ok === false) {
        ctx.setGlobalError(res.error || '模型加载失败', () => void warmModel(target));
        return;
      }
      await fetchModels();
    } catch (e) {
      reportError(e, () => void warmModel(target));
    } finally {
      modelLoadingKey.value = null;
    }
  }

  /** 停止模型服务（省内存）。API 不受影响 —— 解析 / 绘制 / AI 分析照常可用。 */
  async function stopModelService(): Promise<void> {
    modelStopping.value = true;
    try {
      const res = await retroApi.modelService('stop');
      if (res && res.ok === false) {
        ctx.setGlobalError(res.error || '停止模型服务失败', () => void stopModelService());
        return;
      }
      await fetchModels();
    } catch (e) {
      reportError(e, () => void stopModelService());
    } finally {
      modelStopping.value = false;
    }
  }

  /**
   * 加载正向模型（「可行性过滤」的判据）。
   *
   * 🔴 与 `warmModel` 的差别必须说清：它**不会**重启模型服务，所以
   *    ① 已加载的逆向模型照常在；② 不需要等"停旧起新"那几秒；
   *    ③ 但**必须模型服务在跑**（正向模型挂在它下面，另起一份会多一个进程）。
   */
  async function loadForward(): Promise<void> {
    if (!forwardModel.value) return;
    forwardLoadingKey.value = ctx.params.value.model; // 非 null 即「按钮转圈中」
    try {
      const res = await retroApi.loadForward(forwardModel.value.key);
      if (res && res.ok === false) {
        ctx.setGlobalError(res.error || '加载正向模型失败', () => void loadForward());
        return;
      }
      await fetchModels();
    } catch (e) {
      reportError(e, () => void loadForward());
    } finally {
      forwardLoadingKey.value = null;
    }
  }

  /** 正向模型是否已就绪 —— 「可行性过滤」开关的**唯一**可用性判据 */
  const forwardReady = computed(() => forwardModel.value?.state === 'ready');
  /** 正向模型正在加载（按钮转圈 + 开关禁用，并说明"等它一下"） */
  const forwardBusy = computed(() => forwardModel.value?.state === 'loading');
  /**
   * 能不能打开「可行性过滤」。
   * 两条都要：正向模型就绪 **且** 主模型也跑在同一个模型服务里（搜索得通过它转接）。
   */
  const canUseForwardFilter = computed(() => forwardReady.value && modelReady.value);

  /** 当前下拉里选中的那一行（拿它的 state 决定按钮长什么样） */
  const currentModel = computed<RetroModel | null>(
    () => models.value.find((m) => m.key === ctx.params.value.model) ?? null
  );

  /** 选中的模型是不是已就绪、可以立刻推理 */
  const modelReady = computed(() => currentModel.value?.state === 'ready');

  /**
   * 有任何一个模型/服务在加载中（含"选的那个不是加载的那个"这种情形）。
   *
   * TODO(Node 中转): 多模型并行时必须改成"**我要用的那个**忙不忙" —— 否则 A 模型加载中
   *   会把已经就绪的 B 模型一起挡掉（见 docs/plan-node-backend.md §6.7）。
   */
  const modelBusy = computed(
    () => modelService.value?.state === 'loading' || models.value.some((m) => m.state === 'loading')
  );

  /** 模型服务写的人话阶段文案，直接可展示 */
  const modelPhase = computed(() => modelService.value?.phase || '');

  return {
    models,
    modelsLoading,
    modelLoadingKey,
    modelStopping,
    modelService,
    forwardModel,
    forwardLoadingKey,
    forwardReady,
    forwardBusy,
    canUseForwardFilter,
    currentModel,
    modelReady,
    modelBusy,
    modelPhase,
    fetchModels,
    loadModels,
    warmModel,
    stopModelService,
    loadForward,
    stopModelsPolling
  };
}

export { createModelsPart };

export type { ModelsPartCtx };
