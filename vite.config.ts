import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * 端口说明：oauth21 占 5174/5175，posecraft 占 5176 ⇒ 本项目固定 5177。
 * strictPort：端口被占直接报错，不静默换端口（换端口会让 iframe 父 origin 白名单失配）。
 */
export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需自动引入：同时生成 src/components.d.ts，
    // 让 vue-tsc 认识 <el-xxx>（否则模板里全是"未定义组件"错误）。
    // importStyle:false —— 样式统一由 main.ts 全量引入，避免重复注入。
    Components({
      dts: 'src/components.d.ts',
      resolvers: [ElementPlusResolver({ importStyle: false })]
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
      // 后端（node / Fastify 3000）
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
      '/user': { target: 'http://localhost:3000', changeOrigin: true },
      '/verify': { target: 'http://localhost:3000', changeOrigin: true },
      '/oauth2.1': { target: 'http://localhost:3000', changeOrigin: true },
      // 逆合成模型服务（Flask 8000）：/retro/models -> /api/models
      '/retro': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (p: string) => p.replace(/^\/retro/, '/api')
      }
    }
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Vite 8 = Rolldown + Oxc：删 console 的唯一入口是 minifier 的 compress.dropConsole
        minify: {
          compress: {
            dropConsole: true,
            dropDebugger: true
          }
        },
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/vue/') || id.includes('/pinia/') || id.includes('/vue-router/')) {
            return 'vue-vendor';
          }
          if (id.includes('/element-plus/') || id.includes('/@element-plus/')) {
            return 'ui-vendor';
          }
          if (id.includes('/axios/')) return 'net-vendor';
          return undefined;
        }
      }
    }
  }
});
