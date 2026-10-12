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

/* 🔴 函数式 API 的样式必须**手写**引 —— 按需机制看不见它们。
 *
 *    `ElementPlusResolver` 是靠扫描**模板里的组件标签**来工作的，
 *    而 `ElMessage` / `ElMessageBox` 是 `ElMessageBox.confirm(...)` 这种**JS 调用**，
 *    模板里根本没有对应的标签 ⇒ 解析器认为"没用到这个组件" ⇒ 样式永不注入。
 *
 *    症状（实测）：弹窗**完全没有底板**、标题挤在左上角、正文穿透叠在底层内容上、
 *    按钮跑到左上角；toast 同理。但 JS 逻辑全对 —— 所以它既不是报错也不是类型问题，
 *    只能靠肉眼看出来（或本仓的 `npm run verify:ep-style`）。
 *
 *    ⚠️ 加一条检查：**凡在 `<script>` 里 `from 'element-plus'` 导入并当函数调用的**，
 *    都要在这里补一行。目前用到两个：ElMessage（75 处调用）、ElMessageBox（18 处）。
 *    这两个入口文件会自动带出各自的依赖样式（message-box → base/input/button/overlay；
 *    message → base/badge），不用逐个列。
 */
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';

import './styles/index.scss';

// 启动编排（顺序见 bootstrap.ts）
import './bootstrap';
