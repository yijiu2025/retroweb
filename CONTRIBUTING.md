# 贡献指南

感谢你愿意为 RetroWeb 出力。这份指南帮你少踩坑：怎么把项目跑起来、哪些红线不能碰、提交与 PR 该走什么流程。**动手前花五分钟读完，尤其是「代码红线」一节**——这里的每一条都是实战踩出来的。

## 这个仓库是什么

**逆合成路线工作台**的纯前端：输入一个目标分子，模型逐步给出前体拆分路线，可逐步干预、编辑、比较、存档。模型与化学计算在后端（[retro](https://github.com/yijiu2025/retro)）与浏览器端 RDKit 承担，本仓不跑模型。

- 技术栈：Vue 3.5（Composition API）+ TypeScript 6 + Vite 8（Rolldown + Oxc）+ Pinia + Vue Router 5 + axios + Element Plus 2.14 + Zod 3；结构式画板用 Ketcher（React 组件嵌 Vue）
- 端口：**5177**（`strictPort`）；`/api` 经 vite proxy 转发到后端（默认 `localhost:8000`）
- 协议：[MIT](LICENSE)
- 登录：**iframe 嵌入 oauth21 `/mini-login`**（与 posecraft / firewall 同一套 SSO 模式），本应用不自建登录页

## 一、上手

前置依赖：Node.js 18+（建议 20+）、npm 9+。

```bash
git clone https://github.com/yijiu2025/retroweb.git
cd retroweb
npm install
npm run dev            # http://localhost:5177
```

> **没有后端也能 `npm run dev`**：页面能打开，但预测 / 搜索 / LLM 分析的接口会全部失败——这是预期现象。本地联调先起 retro 后端（默认 `localhost:8000`，含 9GB 模型权重）。
> **登录可跳过**：开发档走免登录分支（localStorage 用户档），不接 oauth21 也能调试界面；`.env.development` 里可切真实登录（需要 oauth21 dev server 5174 + Node 后端 3000）。

### 常用命令

| 命令                          | 作用                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `npm run dev`                 | 开发服务器（端口 5177，`strictPort`，被占直接报错，不静默换端口）      |
| `npm run type-check`          | `vue-tsc -b` 前端类型闸门                                            |
| `npm run lint`                | ESLint（`eslint .`）                                                 |
| `npm run build`               | 类型检查 + 生产构建                                                   |
| `npm run audit:jsdoc`         | JSDoc 基线审计（导出函数 `@param`/`@returns`/文件头缺口必须为 0）      |
| `npm run verify:readme`       | README 与代码事实同步关卡                                             |
| `npm run verify:docs`         | 文档入口校验（两级入口体系 + 无死链）                                 |
| `npm run test:release`        | 发布脚本行为测试（`node --test`）                                     |
| `npm run verify:retro-envelope` 等三个浏览器关卡 | 需要 dev server + 真实浏览器，**本地跑**（CI 不起服务，易 flake） |

### CI 口径

家族规范（fullstack-rules → ci-conventions.md）单一来源在 `.claude/skills/fullstack-rules/`（根仓）。本仓 CI = `ci.yml` 入口 → `ci-quality.yml` 共享门禁（类型 → 规范 → 构建；本仓无单测框架，`test-cmd` 传空跳过）+ `ci-gates.yml` 专属关卡（JSDoc / README / 文档入口 / 发布脚本）。🔴 **共享门禁字节级一致、禁止手改**，要改走技能脚本 `distribute-ci.mjs` 分发。

## 二、代码红线

- 🔴 **入口形态**：`main.ts` 只做门牌（样式导入 + `import './bootstrap'`），装配逻辑住 `bootstrap.ts`；挂载一律 `router.isReady().then(mount).catch(降级)`
- 🔴 **鸭子类型判据必须由接口派生**（`Record<keyof T,…>` 再遍历）：手抄成员名会让判据静默落后
- 🔴 **外部边界类型只收在 `src/types/external.ts`**（`declare global` + zod，禁 `any`）
- 🔴 **拆分/移动源码后，「断言读文件内容」的关卡必须同步文件清单**（踩过三次）
- 🔴 **登录态**：iframe SSO 的 `bind-session` 失败必须中断后续流程；postMessage 必须宿主 origin + source 双校验
- 🔴 **免登录档是开发专用**：bypass 分支只写 user + 补拉数据，**不清 localStorage**（曾每次刷新抹掉本地数据）
- 🔴 **无新增 `console.*`**（构建期剥离，但产物里留痕即返工）；无新增 `any` 债务
- **JSDoc 基线**：导出函数 `@param`/`@returns`/文件头注释缺口为 0，`audit:jsdoc` 是硬门禁

## 三、提交与 PR

遵循 Conventional Commits（`<type>(<scope>): <subject>`），一个提交只做一件事：

| 类型       | 示例                                        |
| ---------- | ------------------------------------------- |
| `feat`     | `feat(workbench): 路线树支持批量折叠`       |
| `fix`      | `fix(login): 修复 bind-session 失败未中断`  |
| `refactor` | `refactor(entry): main.ts 门牌化`           |
| `docs`     | `docs: 补多路线对照设计说明`                |
| `ci`       | `ci: 接入家族共享门禁`                      |
| `chore`    | `chore: 升级 element-plus`                  |

流程：从 `main` 切短支线（`feat/*` / `fix/*` / `chore/*` …）→ 小步提交 → 推送开 PR → CI 绿 → 合并（merge commit 保留拓扑）→ 删支线。**禁止直推 `main`**（受分支保护）。

PR 标题同样要符合 Conventional Commits——squash 合并时它会成为 main 上的提交信息。

## 四、发版

版本源是 git tag（`vX.Y.Z`，annotated），`package.json` 的 `version` 单向跟随；发布走 `scripts/release.mjs`（默认只预览，`--apply` 才执行）。细则见根仓 `docs/standards/git-release-rules.md`。

## 五、报告问题

- 缺陷 / 功能建议：走 [issue 模板](.github/ISSUE_TEMPLATE)
- 安全漏洞：**勿开公开 issue**，走私密渠道，见 [SECURITY.md](SECURITY.md)
- 后端 / 模型行为问题：请到 [retro](https://github.com/yijiu2025/retro/issues) 报告；登录态问题到 [oauth-web](https://github.com/yijiu2025/oauth-web/issues)
