/**
 * 集成测试的构建配置：把 store 测试打成 Node 可直接跑的 ESM（SSR build）。
 *
 * 用法：`npm run test:store`
 *
 * 之所以不用 vitest/jest：本项目只想验证 store 的**逻辑**（方案切换 / 分析保留 /
 * 相同分子复用），不需要 DOM 渲染，也不想为此引入一套测试框架依赖。
 * Vite 自己就能把 TS + `@/` 别名打成 Node 可执行文件，够用且零新增依赖。
 */
import { defineConfig } from 'vite';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(ROOT, 'src') }
  },
  build: {
    ssr: path.resolve(ROOT, 'tests/store-harness.ts'),
    outDir: path.resolve(ROOT, 'tests/.out'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    // vue / pinia / axios 保持 external，运行时从项目 node_modules 解析
    rolldownOptions: {
      external: ['vue', 'pinia', 'axios']
    }
  }
});
