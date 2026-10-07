<script setup lang="ts">
/**
 * 结构式画板 —— Ketcher 3.14 内核（React 组件，这里做 Vue↔React 桥）。
 *
 * 为什么换掉自绘 SVG 画板：
 *   旧画板「只管拓扑，化学正确性全交后端 RDKit」，画个苯环要手动升级键型，
 *   芳香性/立体化学/模板/元素周期表都得自己攒（见 git 历史里的 rings.ts / useStructureEditor.ts）。
 *   Ketcher（EPAM 开源，Indigo 内核）是 ChemDraw 级成熟编辑器，这些全自带，
 *   并且 **standalone 模式把 Indigo 编译成 WASM 内联进 worker** —— 纯离线，
 *   不需要任何 Indigo 后端服务。
 *
 * 🔴 三条实测事实（2026-10-06 从产物里读出来的，别再踩）：
 *
 *  1. **wasm 不是外部文件，是内联 data URI。**
 *     `ketcher-standalone` 的 `findWasmBinary()` 返回
 *     `"data:application/octet-stream;base64,AGFzbQEAAAAB…"`（12,130,285 字符的
 *     worker 源码里塞着 8.9MB 的 Indigo WASM 的 base64）。三个推论：
 *       · `staticResourcesUrl` 传空串即可 —— 不需要指到任何静态目录；
 *       · 永远不会出现 wasm 404 / 相对路径基准错（worker 是 `blob:` URL，本来也没有目录）；
 *       · 代价是 `ketcher-standalone/dist/main.js` **16MB** ⇒ 必须懒加载。这里用
 *         动态 `import()`，严格只在「画结构式」弹窗首次打开时才拉（组件挂在
 *         el-dialog 里，而 el-dialog 的 `rendered` 首帧为 false ⇒ 只在打开时挂载）。
 *
 *  2. **`ketcher-react` 是一整棵 React 树**（2.4MB ESM，带 MUI / emotion /
 *     redux / draft-js / ajv / cfb…），Vue 里没法走 SFC 模板 ⇒ 用 `createRoot`
 *     手动挂载 + `createElement`（不用 JSX，省掉 @vitejs/plugin-react）。
 *     它 `import 'util'`（browserify polyfill），那里面有裸 `process` 引用 ⇒
 *     `index.html` 垫了 `window.process`，否则真被调到就是 "process is not defined"。
 *
 *  3. **`Editor` 必填 props 只有三个**：`staticResourcesUrl` / `structServiceProvider`
 *     / `errorHandler`。`ketcherId` 被组件内部接管（类型上是 `Omit<…, 'ketcherId'>`）。
 *     实例经 `onInit(ketcher)` 回传 —— 注意它比 `root.render()` 晚一拍（React 18
 *     并发渲染），所以这里用 `whenReady()` 单独等实例，不能只等 boot。
 *
 * 契约（对 TargetInput 保持不变）：
 *   入图 `loadFromMolfile(mol)` ← 前端 RDKit 算好的带 2D 坐标 molfile
 *   出图 `getMolfile()`        → 交回前端 RDKit 判真伪（valence / Markush 全兜住）
 * 所以「化学正确性由 RDKit 终审」这条分工没有变，换掉的只是**编辑器**这一层。
 *
 * ⚠️ 视觉：Ketcher 3.14 只有亮色主题（产物里搜不到 dark 主题开关），
 *   本组件在暗色应用里也保持白底画布 —— 化学编辑器的白纸观感是行业惯例，别去改。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Loading } from '@element-plus/icons-vue';
import type { Ketcher } from 'ketcher-core';
import type { Root } from 'react-dom/client';

const host = ref<HTMLDivElement | null>(null);
const status = ref<'loading' | 'ready' | 'error'>('loading');
const errMsg = ref('');

let ketcher: Ketcher | null = null;
let reactRoot: Root | null = null;
let booting: Promise<void> | null = null;
let readyPromise: Promise<Ketcher> | null = null;
let readyResolve: ((k: Ketcher) => void) | null = null;
let disposed = false;

/** boot = 拉依赖 + 挂载 React 树。只跑一次，失败后允许重试。 */
function boot(): Promise<void> {
  if (booting) return booting;
  booting = (async () => {
    const el = host.value;
    if (!el) throw new Error('画板容器尚未挂载');
    const [react, reactDom, ketcherReact, ketcherStandalone] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('ketcher-react'),
      import('ketcher-standalone')
    ]);
    // CSS 也动态引：175KB，没必要进首屏样式包
    await import('ketcher-react/dist/index.css');
    if (disposed) return;

    const root = reactDom.createRoot(el);
    reactRoot = root;
    root.render(
      react.createElement(ketcherReact.Editor, {
        // wasm 内联，静态资源目录没有意义 —— 见头注释第 1 条
        staticResourcesUrl: '',
        structServiceProvider: new ketcherStandalone.StandaloneStructServiceProvider(),
        errorHandler: (message: string) => {
          errMsg.value = message;
        },
        onInit: (k: Ketcher) => {
          ketcher = k;
          // 开发期把实例挂到 window：Ketcher 官方文档自己就是这个用法，
          // 方便在控制台直接 `ketcher.setMolecule('c1ccccc1')` 试结构，
          // 验收脚本也靠它驱动真实交互（不用去点它那堆图标按钮）。
          if (import.meta.env.DEV) {
            (window as unknown as { ketcher?: Ketcher }).ketcher = k;
          }
          status.value = 'ready';
          readyResolve?.(k);
        }
      })
    );
  })().catch((e: unknown) => {
    status.value = 'error';
    errMsg.value = e instanceof Error ? e.message : String(e);
    booting = null; // 允许用户再点一次重试
    throw e instanceof Error ? e : new Error(String(e));
  });
  return booting;
}

/**
 * 等 Ketcher 实例到手。
 * 🔴 不能只 `await boot()`：`root.render()` 之后 onInit 是**异步**触发的
 *（React 18 并发渲染），boot 返回时 ketcher 往往还是 null。分两段等才稳。
 */
async function whenReady(): Promise<Ketcher> {
  await boot();
  if (ketcher) return ketcher;
  if (!readyPromise) {
    readyPromise = new Promise<Ketcher>((resolve) => {
      readyResolve = resolve;
    });
  }
  return readyPromise;
}

/**
 * molfile 里的原子数 —— 用来判「画板是不是空的」。
 * V2000 走 counts line（第 4 行，前 3 字符是原子数，列宽是硬契约）；
 * V3000 走 `M  V30 COUNTS` 行。
 */
function atomCountOf(molfile: string): number {
  if (!molfile) return 0;
  if (molfile.includes('V3000')) {
    const m = /^M\s+V30\s+COUNTS\s+(\d+)/m.exec(molfile);
    return m ? Number(m[1]) : 0;
  }
  const counts = molfile.split(/\r?\n/)[3] ?? '';
  const n = Number.parseInt(counts.slice(0, 3), 10);
  return Number.isFinite(n) ? n : 0;
}

onMounted(() => {
  void boot().catch(() => {
    /* 失败已经反映在 status/errMsg 上，这里只吞掉未捕获的 rejection */
  });
});

onBeforeUnmount(() => {
  disposed = true;
  // React 根必须显式卸载，否则 React 的事件系统会挂在已销毁的 DOM 上
  try {
    reactRoot?.unmount();
  } catch {
    /* 卸载期报错无需上抛 */
  }
  reactRoot = null;
  ketcher = null;
});

defineExpose({
  /** 画板是不是空的（Ketcher 还没就绪时保守判空 —— 调用方据此决定要不要灌初始结构） */
  async isEmpty(): Promise<boolean> {
    const k = await whenReady();
    try {
      return atomCountOf(await k.getMolfile()) === 0;
    } catch {
      // 空画布上 Indigo 可能直接抛错，按「空」处理即可
      return true;
    }
  },
  /** 入图：带 2D 坐标的 molfile（前端 RDKit 算出） */
  async loadFromMolfile(mol: string): Promise<void> {
    if (!mol.trim()) return;
    const k = await whenReady();
    // needZoom：让结构自动缩放到刚好铺满画布，否则小分子会缩在角落
    await k.setMolecule(mol, { needZoom: true });
  },
  /** 出图：交给前端 RDKit 判真伪 */
  async getMolfile(): Promise<string> {
    const k = await whenReady();
    return k.getMolfile();
  },
  async clear(): Promise<void> {
    const k = await whenReady();
    await k.setMolecule('');
  }
});
</script>

<template>
  <div class="ked">
    <div ref="host" class="ked__host" />

    <!-- 加载/失败遮罩：盖在容器上，不遮蔽时指针事件也不透传（免得点到底下的空画布） -->
    <div v-if="status !== 'ready'" class="ked__mask">
      <el-icon v-if="status === 'loading'" class="ked__spin" :size="20"><Loading /></el-icon>
      <div class="ked__title">
        {{ status === 'error' ? '画板加载失败' : '正在加载结构式画板…' }}
      </div>
      <div class="ked__tip">
        {{
          status === 'error'
            ? errMsg
            : '首次打开要下载编辑器内核（含约 9MB 化学引擎，已内联在模块里），之后走浏览器缓存'
        }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.ked {
  position: relative;
}

/*
  高度必须给死：Ketcher 的根节点是 height:100%，容器没高度它就只有 0。
  clamp 而不是固定 460：矮屏上固定高度会把 dialog 底部按钮顶出视口。
*/
.ked__host {
  height: clamp(400px, 58vh, 620px);
  min-height: 320px;
  overflow: hidden;
  border: 1px solid var(--rw-border);
  border-radius: var(--rw-radius-sm);
  /* Ketcher 3.14 只有亮色主题，画布恒定白底 —— 别跟着 --rw-surface 变暗，
     暗色下深底 + 黑键线会看不清（键线颜色写死在 Ketcher 内部样式里，我们改不动） */
  background: #ffffff;
}

.ked__mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 24px;
  text-align: center;
  border-radius: var(--rw-radius-sm);
  background: var(--rw-surface);
}

.ked__spin {
  animation: ked-rotate 1.1s linear infinite;
  color: var(--rw-brand);
}

@keyframes ked-rotate {
  to {
    transform: rotate(360deg);
  }
}

.ked__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--rw-text);
}

.ked__tip {
  max-width: 460px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--rw-text-3);
  word-break: break-word;
}
</style>
