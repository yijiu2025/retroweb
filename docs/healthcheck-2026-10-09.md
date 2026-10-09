# retroweb + retrochimera 体检报告（2026-10-09）

体检对象：前端 `C:\Users\22701\Desktop\nodeServers\retroweb`（独立 git 仓）
后端 `F:\retrochimera`（独立 git 仓）

---

## 一、四关体检结果（全绿）

| 关卡 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx vue-tsc -b` | ✅ exit 0（裸 `vue-tsc` 恒 0，口径必须是 `-b`） |
| Lint | `npx eslint .` | ✅ exit 0 |
| 生产构建 | `npx vite build --outDir <全新目录>` | ✅ 3.34s，exit 0 |
| Store 试验台 | `npm run test:store` | ✅ ALL PASS |
| 后端语法自检 | `python -m compileall web core bootstrap scripts` | ✅ exit 0（仅 1 条上游 SyntaxWarning） |

> 构建必须落到**全新 outDir**：写已有的 `dist/` 会被 safe-delete shim 拦住。
> 本次体检用的两个临时产物目录已回收，未留在仓库里。

## 二、本次清理（共腾出约 1.5 GB）

| 项 | 体积 | 去向 |
| --- | --- | --- |
| `retroweb/.tmp-probe/` | 1.2 GB / 467 项（探针脚本、`.bak.vue` 备份、内部嵌套 34 个 `dist-*`、crop/shot 截图、build 日志） | 已移出 |
| `retroweb/dist-*`（12 个） | 278 MB | 已移出 |
| `retroweb/shot-*.png`（9 张） | 420 KB | 已移出 |
| `.tmp-dev.log` / `.tmp-preview.log` / `.vite-dev.log` | 112 KB | 已移出 |
| `tests/.out/`（旧试验台产物） | — | 已移出 |

暂存区（同盘改名、可原样还原）：`C:\Users\22701\.trash\2026-10-09-retroweb\`

清理后仓库根目录只剩 `src public tests docs dist node_modules` + 配置文件，
`git status --porcelain` **完全干净**（77 个受版本控制的文件一个没动）。

**未动**（本轮没勾）：`retroweb/tests/`（已入库的 store 试验台，唯一的自动化测试入口）、
后端 `F:\retrochimera` 的临时文件。

## 三、不需要改的（已核实，别再折腾）

- **首屏体积健康**：首屏实际只加载 1.3 MB（gzip ≈ 350 KB）。Ketcher（16 MB）与
  RDKit WASM（7.4 MB）都确认是**懒加载**（`StructureEditor.vue` 里 `await import(...)`，
  `loadRdkit()` 单例 Promise 首次用到才拉）。构建分块没问题。
  ⚠️ 别被 `main-*.js 16MB` 吓到 —— 那是 ketcher-standalone 的懒加载 chunk 名字
  （`ketcher-standalone/dist/main.js`），不在首屏。
- **前后端接口契约无漂移**：前端 api 层 17 个逆合成端点（`jobs` / `models` / `parse` /
  `predict` / `load` / `forward/load` / `model-service/<action>` / `llm/*` / `feedback`）
  在后端 `web/app.py` 33 条路由里逐一能对应，无孤儿调用。
- **源码干净**：`src/` 内无 TODO/FIXME/HACK、无测试或调试残留；后端 `web/` 无裸 `except:`。
- **后端工作区干净**：`git status --porcelain` 0 条。

## 四、发现的问题

### P1 —— 建议尽快修

**1. `README.md` 三处过期（与代码/后端现状冲突）**

| 位置 | 现状 | 应为 |
| --- | --- | --- |
| L5 | 「刻意**不**调用 `/api/search`（Retro\* 一次搜到底）」 | 已支持多步搜索：「自动往下拆」= `POST /api/jobs` `kind=search` 一次搜到底（`347bd22` / `9908fda`）。这句现在是**错的** |
| L31 后端接口表 | 只列 `/api/parse`、`/api/predict` | 还缺 `/api/jobs`、`/api/jobs/<id>`、`/api/depict`、`/api/forward/load`、`/api/model-service/<action>`、`/api/llm/*`、`/api/feedback`、`/api/_threads` |
| L44 | `web\启动网页版.bat` | ❌ **该文件不存在**。真实脚本是仓库根的 `启动后端API.bat` |

> 后端《使用说明.md》上一轮已彻底重写对齐（`a86b760`），前端 README 没跟上，
> 两份文档现在口径不一致 —— 这是最该先补的一处。

**2. `src/stores/workspace.ts` 3057 行 / 126 KB**

单个 store 装了：搜索任务与轮询、逆合成树、路线方案（schemes）、会话（sessions）、
LLM 设置、模型就绪矩阵。建议按域拆成 `session / route / schemes / llm` 几个 store 或
composable —— 现在这种体量，改一处要在 3000 行里定位，且 store 试验台也得跟着改。
（拆分属于大动作，建议单独一轮做，别夹带功能改动。）

### P2 —— 可选

**3. 四个超大组件**（行数为 `wc -l`）

| 文件 | 行数 |
| --- | --- |
| `components/workspace/RunParams.vue` | 1998 |
| `components/workspace/RouteCanvas.vue` | 1828 |
| `components/workspace/StepAnalysis.vue` | 1608 |
| `components/workspace/TargetInput.vue` | 810 |

**4. 后端 `web/llm.py` 2342 行 / 106 KB** —— 后端最大文件，装了 profile 管理、
key 池轮换、SSE 流式、分析模块编排。建议按 `profiles / key-pool / sse / analyze` 拆。
（`web/app.py` 1628 行次之，主要是路由平铺，暂可接受。）

**5. vendored 上游告警**：`core/retrochimera/data/smiles_tokenizer.py:16`
`SyntaxWarning: invalid escape sequence '\['`。
是 vendored 的上游文件（最新 release 仍是 v1.3.0，无需跟进），
建议**保持原样**；若想消噪，在导入侧 `warnings.filterwarnings` 过滤，不要改上游源码。

**6. 后端未做运行时验证** —— 本次只做了静态 `compileall`。服务当时没在跑
（8000/5000 均无监听）。真跑要加载 9 GB 模型，需要你明确同意再启动。

**7. 后端根目录遗留（本轮未清理）**：`.tmp-probe/` 1.7 MB、`_startup_log.txt` 68 KB、
`.tmp-run.log`、`.tmp-model-service/`（空）、`启动后端API.bat.bak` 8 KB、4 个 `__pycache__/`。
全部已在 `.gitignore` 里（`*.log` / `*.bak` / `__pycache__/` / `.tmp-*/`），删了不影响仓库。

## 五、待办清单（挑哪个做哪个）

| # | 事项 | 优先级 | 改动面 |
| --- | --- | --- | --- |
| 1 | 重写 `README.md` 过期三处（多步搜索、接口表、启动脚本路径） | P1 | 1 文件 |
| 2 | 拆 `stores/workspace.ts`（3057 行） | P1 | store + 试验台 |
| 3 | 拆 `RunParams.vue` / `RouteCanvas.vue` / `StepAnalysis.vue` | P2 | 前端组件 |
| 4 | 拆后端 `web/llm.py`（2342 行） | P2 | 后端 |
| 5 | 清后端根目录临时文件 | P2 | 零代码改动 |
| 6 | 启动后端做一次真实接口连通性验证（需加载 9 GB 模型） | P2 | 只读 |
| 7 | 给组件层补自动化测试（现只有 store 试验台） | P3 | 新增测试 |

---

> 本文件是体检产物，可随时删除。若要长期保留，建议合并进 `README.md` 的附录。
