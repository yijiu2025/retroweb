import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  {
    // 🔴 `dist-*/**` 而不是只写 `dist/**`：验收用的构建输出目录按 `--outDir dist-<用途>`
    //    命名（如 dist-verify），只写 dist/** 会漏掉它们 —— 那里面是打包产物，
    //    被扫到会一次性报上千条 error，把真正的源码问题淹没。
    ignores: [
      'dist/**',
      'dist-*/**',
      'node_modules/**',
      'public/**',
      'src/components.d.ts',
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
  },
  {
    // 导出位置约定（与根仓 `eslint.config.js` 的「5.2 导出位置约定」同口径）：
    // 所有 export 一律收拢到文件末尾，定义处不写 `export` 关键字。
    //   正确：function foo() {}  …  export { foo };  /  export type { T };  /  export default foo;
    //   禁止：export function foo() {}  /  export const x = 1  /  export interface T {}  /  export default () => {}
    //
    // 理由：定义与导出分离，导出面一眼可见 —— 否则导出散落各处，模块契约难以审计。
    //
    // ⚠️ 比根仓的规则**多了三个 TS 选择器**（InterfaceDeclaration / TSTypeAliasDeclaration /
    //    TSEnumDeclaration）—— 根仓那条只作用于 `src/**/*.js`，管不到 TS 的 `export interface`。
    // ⚠️ 只作用于 `src/**/*.ts` —— 与根仓的 `src/**/*.js` 同范围：
    //    · 不含根级工具配置（`vite.config.ts` 的 `export default defineConfig(...)` 是惯用写法，
    //      强行改成"先命名再导出"只是噪音）；
    //    · 也不含 `.vue`：`<script setup>` 本就禁止顶层 export。
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportNamedDeclaration > FunctionDeclaration',
          message: '导出须放在文件末尾：去掉定义处的 `export`，改为末尾统一 `export { name };`'
        },
        {
          selector: 'ExportNamedDeclaration > ClassDeclaration',
          message: '导出须放在文件末尾：去掉定义处的 `export`，改为末尾统一 `export { Name };`'
        },
        {
          selector: 'ExportNamedDeclaration > VariableDeclaration',
          message: '导出须放在文件末尾：去掉定义处的 `export`，改为末尾统一 `export { name };`'
        },
        {
          selector: 'ExportNamedDeclaration > TSInterfaceDeclaration',
          message: '导出须放在文件末尾：去掉定义处的 `export`，改为末尾统一 `export type { Name };`'
        },
        {
          selector: 'ExportNamedDeclaration > TSTypeAliasDeclaration',
          message: '导出须放在文件末尾：去掉定义处的 `export`，改为末尾统一 `export type { Name };`'
        },
        {
          selector: 'ExportNamedDeclaration > TSEnumDeclaration',
          message: '导出须放在文件末尾：去掉定义处的 `export`，改为末尾统一 `export { Name };`'
        },
        {
          selector: 'ExportDefaultDeclaration:not(:has(> Identifier))',
          message: '默认导出须放在文件末尾：先命名（`const x = ...`）或把函数具名化，再末尾 `export default x;`'
        }
      ]
    }
  }
];
