/**
 * RetroWeb 入口文件。
 *
 * 🔴 只做两件事：**引样式** + **转交启动编排**（`./bootstrap`）。
 *    启动顺序（pinia → router → 401 注入 → router.isReady → mount）全部在 bootstrap.ts，
 *    本文件刻意保持极简 —— 与 posecraft / firewall / admin 的入口形态一致。
 *
 * 🔴 样式分为两段，**两段的职责不能混**：
 *    · 全局 reset / 设计 token / 本项目通用类 → `styles/index.scss`（本项目自己的）
 *    · Element Plus 组件样式 → 由 vite.config.ts 的 `ElementPlusResolver({ importStyle: 'css' })`
 *      在**用到哪个组件时**注入哪个组件的 css（按需，不在这里手写 import）
 *    这里额外保留的只有 `dark/css-vars.css`：它是**纯变量覆盖**（html.dark 下的
 *    --el-* 一整套），不属于任何单个组件、按需机制不会带进来，必须单独引。
 *
 *    实测（2026-10-11）：全量 import 'element-plus/dist/index.css'（355KB / gzip 47KB）
 *    换成按需后，首屏 CSS 从 399.5KB → 167.8KB（gzip 55.1 → 24.8KB，-55%），
 *    三组视觉回归 173/173 通过（默认首屏 126 + 弹窗态 26 + 暗色 21，几何与计算样式全等）。
 *
 * @author yijiu2025
 * @since 2026-10-11
 */
// Element Plus 组件样式由 vite.config.ts 的 ElementPlusResolver({ importStyle: 'css' }) 按需注入，
// **不在这里引 dist/index.css**（全量 355KB，实测首屏 CSS 因此多 47KB gzip）。
// 暗色**变量**是例外：它是纯 --el-* 覆盖、不隶属任何组件，按需机制带不进来，必须单独引。
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles/index.scss';

// 启动编排（顺序见 bootstrap.ts）
import './bootstrap';
