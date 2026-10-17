# Pull Request

## 改动类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `perf` 性能优化
- [ ] `refactor` 重构（行为不变）
- [ ] `style` 样式 / 格式（不影响逻辑）
- [ ] `test` 测试
- [ ] `docs` 文档
- [ ] `chore` 构建 / 工具 / 杂项
- [ ] `ci` CI 配置
- [ ] `revert` 回滚

## 关联 Issue

closes #<!-- issue 编号，无则删掉本节 -->

## 动机与背景

<!-- 解决什么问题；不写「是什么」，写「为什么」。 -->

## 主要改动

<!-- 按模块列，避免逐行复述 diff：
- src/stores/workbench.ts：…
- scripts/verify-…cjs：…
-->

## 测试证据

本地跑过的命令与结果（CI 会重复一遍，但本地先绿是对 reviewer 的基本尊重）：

- [ ] `npm run type-check`（vue-tsc -b）
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run audit:jsdoc`（改了导出函数必跑）
- [ ] `npm run verify:readme`（改了 README 陈述的事实必跑）
- [ ] `npm run verify:docs`（新增 / 改名文档必跑）
- [ ] `npm run test:release`（改了发布脚本必跑）

UI 改动请附截图或录屏，**桌面 + 移动 + 深色**三态（dev server 在跑时补跑三个浏览器关卡：`verify:retro-envelope` / `verify:ep-style` / `verify:interrupt`）：

<!-- 拖图到这里 -->

## 自检清单

- [ ] 入口形态保持 `main.ts` 门牌 + `bootstrap.ts` 编排；挂载走 `router.isReady().then(mount).catch(降级)`
- [ ] 无新增 `console.*`；无新增 `any` 债务
- [ ] 外部边界类型只收在 `src/types/external.ts`（`declare global` + zod）
- [ ] 拆分/移动源码后，「断言读文件内容」的关卡文件清单已同步
- [ ] iframe / postMessage 相关改动保留了 origin + source 双校验
- [ ] 免登录档分支没有走 `setUser → persist.clear()` 老路（只写 user + 补拉）
- [ ] 化学数据渲染（RDKit / Ketcher / CDXML）不把用户输入当可信 HTML
- [ ] UI 改动满足无障碍清单（键盘可达、结构有文字替代、错误可被听见、颜色非唯一信号）
- [ ] 新文档已登记进入口体系（`docs/README.md` 或二级入口）
- [ ] 提交信息遵循 Conventional Commits，一次提交只做一件事

## Breaking change

- [ ] 无破坏性变更
- [ ] 有破坏性变更（请在下方说明迁移路径，并在提交信息的 footer 写 `BREAKING CHANGE:` —— 这会触发 major 发版）

<!-- 迁移说明 -->

## 给 Reviewer 的提示

<!-- 你最没把握的点、希望重点看的部分；没有就删掉本节。 -->
