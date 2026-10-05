import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    // tests/.out 是 `npm run test:store` 的构建产物（已 gitignore），不必 lint。
    // 🔴 `dist-*/**` 而不是只写 `dist/**`：验收用的构建输出目录按 `--outDir dist-<用途>`
    //    命名（如 dist-verify），只写 dist/** 会漏掉它们 —— 那里面是打包产物，
    //    被扫到会一次性报上千条 error，把真正的源码问题淹没。
    ignores: [
      'dist/**',
      'dist-*/**',
      'node_modules/**',
      'public/**',
      'src/components.d.ts',
      'tests/.out/**',
      // .tmp-probe 是版式验收用的临时探针脚本（playwright 驱动、跑完即弃），不是产品代码
      '.tmp-probe/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue']
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'off'
    }
  }
];
