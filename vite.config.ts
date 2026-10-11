import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * dev 代理上游（**只被本文件读取，不进前端产物**，故刻意不带 `VITE_` 前缀）：
 *  · `DEV_API_TARGET`   —— 账号 / 会话服务（Fastify），默认 `http://localhost:3000`
 *  · `DEV_RETRO_TARGET` —— 算法服务（Flask，仅直连档用到），默认 `http://127.0.0.1:8000`
 *
 * 🔴 `loadEnv(mode, ROOT, '')` 的第三参**必须传空字符串**：
 *    默认只加载 `VITE_` 前缀的变量，传 `''` 才能读到上面这两个非 VITE_ 变量。
 *    用途：后端跑在别的机器 / 端口 / Docker 映射时，不必改本文件。
 *
 * ⚠️ 顺带一提：**带 `VITE_` 的值会原样打进 JS 产物**（F12 可读）
 *    ⇒ 地址与开关可以带，密钥一律不能带。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, '');
  const API_TARGET = env.DEV_API_TARGET || 'http://localhost:3000';
  const RETRO_TARGET = env.DEV_RETRO_TARGET || 'http://127.0.0.1:8000';

  return {
    plugins: [
      vue(),
      // Element Plus 按需自动引入：同时生成 src/components.d.ts，
      // 让 vue-tsc 认识 <el-xxx>（否则模板里全是"未定义组件"错误）。
      //
      // 🔴 importStyle: 'css' —— 组件样式**随组件按需注入**（用到 ElDialog 才带 el-dialog.css）。
      //    实测（2026-10-11）：由 `false`（改为 main.ts 全量引 dist/index.css）切换过来后，
      //    首屏 CSS 399.5KB → 167.8KB（gzip 55.1 → 24.8KB，**-55%**），
      //    视觉回归 173/173 全等（默认首屏 126 + 弹窗态 26 + 暗色 21）。
      //    ⇒ **不要再改回 false + main.ts 全量引入**：那会白背 355KB 的、八成用不到的组件样式。
      //    ⚠️ 唯一必须手写的 EP 样式是 `element-plus/theme-chalk/dark/css-vars.css`
      //       （纯变量覆盖，不隶属组件），它留在 main.ts 里 —— 见那边的注释。
      Components({
        dts: 'src/components.d.ts',
        resolvers: [ElementPlusResolver({ importStyle: 'css' })]
      })
    ],
    resolve: {
      alias: {
        '@': path.resolve(ROOT, 'src')
      }
    },
    server: {
      host: '0.0.0.0',
      port: 5177,
      strictPort: true,
      proxy: {
        // 账号 / 会话 / 认证（Node · Fastify）。四条前缀来自后端实际路由。
        ...Object.fromEntries(
          ['/auth', '/user', '/verify', '/oauth2.1'].map(p => [p, { target: API_TARGET, changeOrigin: true }])
        ),
        /** 算法服务直连档（VITE_RETRO_VIA_NODE=false）：/retro/* → /api/* */
        '/retro': {
          target: RETRO_TARGET,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/retro/, '/api')
        }
      }
    },
    build: {
      sourcemap: false,
      // 🔴 目标对齐 oauth21 / 三个前端共用的最低基线，避免每个应用各降一档语法。
      //    'es2020' 覆盖 Chrome 87+ / Safari 14+，比默认的 modules 更窄但更稳。
      target: 'es2020',
      // 🔴 单个 chunk 警告阈值。ketcher 那个 15MB 是有意为之（见 manualChunks 注释），
      //    阈值设成能把它盖住，否则每次构建都刷一条无用警告，真正的体积问题被淹没。
      chunkSizeWarningLimit: 20000,
      // 产出相对路径资源，便于部署到任意子路径（本应用走 oauth21 iframe，非根路径场景）
      assetsDir: 'assets',
      rolldownOptions: {
        output: {
          // Vite 8 = Rolldown + Oxc：删 console 的唯一入口是 minifier 的 compress.dropConsole
          minify: {
            compress: {
              dropConsole: true,
              dropDebugger: true
            }
          },
          /**
           * 手动分块：把"体积大、变更频率低"的**静态**第三方依赖从入口 chunk 拆出去。
           *
           * 🔴 **铁律：只拆静态 import 的依赖，绝不手动拆动态 `import()` 的（这里踩过）**
           *
           *   实测（2026-10-10）：我给 `ketcher-*` / `@rdkit` 加了 manualChunks 规则后，
           *   它们从"按需懒加载的 async chunk"**变成了 eager chunk**，
           *   被 Vite 写进 `index.html` 的 `<link rel="modulepreload">`
           *   ⇒ 首屏资源从 **1.08MB 暴涨到 25.2MB**（24MB 的 chem-ketcher 被预加载）。
           *
           *   原因：`manualChunks` 返回名字 = 把这个模块**钉进一个具名 chunk**，
           *   而具名 chunk 会参与入口的静态依赖图分析。动态 import 的懒加载边界
           *   **只能由 Rolldown 自己按 `import()` 切分**，手动干预就把它变成 eager。
           *
           *   ⇒ 所以下面**只列静态引入**的包：
           *      vue / vue-router / pinia / element-plus / axios / zod / three(静态部分)
           *      化学编辑器（ketcher*）与 RDKit 由 Rolldown 自动切分 —— 实测它们本来
           *      就正确地落在独立的 async chunk（`dist-*.js` / `index.modern-*.js`）里，
           *      **不动才是对的**。
           *
           * 🔴 匹配用"包目录"而不是裸子串：裸 `id.includes('/react/')` 抓不到
           *   `node_modules/react-dom/`（没有独立 `/react/` 段）。
           *
           * @param id 模块绝对路径（含 node_modules）
           * @returns chunk 名；undefined = 交给 Rolldown 自动分配（含所有动态 import）
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;

            // 归一成 posix 路径，Windows 的反斜杠也能命中
            const norm = id.replace(/\\/g, '/');
            /** 按**包目录**匹配（`…/node_modules/<pkg>/…`），避免裸子串误伤 */
            const pkg = (name: string): boolean =>
              new RegExp(`/node_modules/${name.replace(/[/\\]/g, '\\/')}(/|$)`).test(norm);

            // 🔴 下列包**必须排除**：它们是动态 import 的，交给 Rolldown 自动切分。
            //    加进来会把懒加载变成首屏 preload（实测首屏 +24MB）。
            if (pkg('ketcher-core') || pkg('ketcher-react') || pkg('ketcher-standalone')) return undefined;
            if (pkg('@rdkit')) return undefined;
            // react / react-dom / three 由 ketcher-react、MolView 动态链路引入，同理不拆
            if (pkg('react') || pkg('react-dom') || pkg('scheduler')) return undefined;
            if (pkg('three') || pkg('@react-three')) return undefined;

            // --- 以下为静态 import 的依赖，拆出来可长期缓存、缩小入口 chunk ---
            if (pkg('vue') || pkg('vue-router') || pkg('pinia') || pkg('@vue')) return 'vue-vendor';
            if (pkg('element-plus') || pkg('@element-plus')) return 'ui-vendor';
            if (pkg('axios')) return 'net-vendor';
            if (pkg('zod')) return 'zod-vendor';

            return undefined;
          }
        }
      }
    }
  };
});
