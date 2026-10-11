# RetroWeb · 逆合成工作台（独立前端）

[English](README.en.md) | **简体中文**

一个目标分子 → 一条（或几条）逆合成路线，配一套工艺分析。前端负责路线树的长成与
交互，模型与化学计算由后端/浏览器端 RDKit 承担。

**两条起跑线**（这是最容易被搞混的一点）：

| 起跑线         | 走什么                          | 语义                                                             |
| -------------- | ------------------------------- | ---------------------------------------------------------------- |
| **手动逐步挑** | `POST /api/jobs` `kind=predict` | 一次只拆**一步**，人在候选里挑，采纳后前体各新增一行             |
| **自动往下拆** | `POST /api/jobs` `kind=search`  | 一次**搜到底**（Retro\* 吃满调用预算），返回多条完整路线，再建树 |

两条都会长成同一棵树，只是"谁来挑"不同。早期 README 里那句「刻意**不**调用
多步搜索」已经不成立 —— 多步搜索现在是正式入口之一。

在路线之上还叠了三层能力：**多条路线网络并列保留、随时切换**（不是删树，切回来原样接回）·
**每次分析都留档、相同中间体自动复用**（不重跑模型）· **每步工艺流程 + 大模型工艺分析**
（投料顺序 / 当量 / 反应结果 / 副产物 / LCMS / NMR）。

登录采用 **iframe 嵌入 oauth21 `/mini-login`**（与 posecraft / firewall 同一套 SSO 模式），
注册 / 忘记密码 / 邮箱二次验证 / 设备超限全部由 oauth21 提供，本应用不自建登录页。

> 技术栈：Vue 3.5 + TypeScript 6 + Vite 8（Rolldown + Oxc）+ Pinia + Vue Router + axios + Element Plus 2.14
> 端口：**5177**（oauth21 占 5174/5175，posecraft 占 5176）

## 这是什么

RetroWeb 是一套开箱即用的**逆合成路线工作台**：输入一个目标产物，模型逐步给出前体拆分路线，
你可以逐步干预、编辑、比较，并把走通的路线存成多个方案对照。

- **仓库**：<https://github.com/yijiu2025/retroweb>
- **界面内查看**：应用内「运行设置」弹窗与「个人中心」页面底部都有同一份介绍与仓库地址。

**能力一览**

| 能力 | 说明 |
| --- | --- |
| 逐步可干预的逆合成拆分 | 一次拆一步，人在候选里挑，采纳后前体各新增一行 |
| Retro\* 整段搜索 | 一次搜到底，预算（深度 / 调用数 / 重原子数）可控 |
| 多路线方案对照 | 随时切换方案，不删树，切回来原样接回 |
| 分析复用 | 相同中间体自动复用已有结果，不重跑模型 |
| LLM 工艺分析 | 投料顺序 / 当量 / 反应结果 / 副产物 / LCMS / NMR，另支持自由追问 |
| 化学工具 | 浏览器内 RDKit 本地解析（CDXML 除外）、结构式画板、CAS / 分子式 / 分子量一键复制 |
| 部署形态 | 纯前端本地存储，或经 Node 中转按用户落库 |

> ⚠️ **AI 分析结果是模型推测，未经实验验证**；结构预测的成败取决于上游模型，全链路都需人工复核。
> 本项目用于研发辅助，不直接用于生产决策。

## 快速索引

| 想做的事 | 看哪节 |
| --- | --- |
| 把它跑起来 | [一、跑起来](#一跑起来) |
| 搞懂登录怎么接的（跨项目配置） | [二、登录](#二登录iframe-sso-是怎么接的) |
| 看代码该从哪读起 | [三、目录结构](#三目录结构) |
| 学会用工作台 | [四、工作台用法](#四工作台用法) |
| 用结构式画板 | [五、结构式画板](#五结构式画板--ketcher-314) |
| 配大模型 / 看分析接口 | [六、大模型工艺分析](#六大模型工艺分析可选) |
| 踩坑前先看 | [七、已知约束](#七已知约束) |

---

## 一、跑起来

```bash
cd retroweb
npm install
npm run dev          # http://localhost:5177
```

### 依赖的后端（另开终端）

| 服务                      | 地址             | 用途                        | 是否必须               |
| ------------------------- | ---------------- | --------------------------- | ---------------------- |
| 逆合成模型服务（Flask）   | `127.0.0.1:8000` | 见下方接口清单              | ✅ 必需                |
| 账号服务（Fastify）       | `localhost:3000` | `userinfo` / `bind-session` | 仅**真实登录**时需要   |
| oauth21 登录页            | `localhost:5174` | iframe 登录 UI              | 仅**真实登录**时需要   |
| 大模型 API（OpenAI 兼容） | 外部             | `/api/llm/*` 工艺分析       | 仅**用 AI 分析**时需要 |

**模型服务接口清单**（`F:\retrochimera\web\app.py`）：

| 路径                                                        | 用途                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/models`                                           | 模型就绪矩阵（主模型 / 正向模型各自的加载状态与耗时）           |
| `POST /api/jobs`                                            | **主入口**：`kind=predict`（单步）/ `kind=search`（多步搜到底） |
| `GET /api/jobs/<job_id>` · `POST /api/jobs/<job_id>/cancel` | 任务轮询与取消                                                  |
| `POST /api/parse`                                           | 结构解析（**CDXML 专用**：浏览器端 RDKit 读不了 CDXML）         |
| `POST /api/depict`                                          | RDKit 算 2D 坐标，用来把已有结构载入画板                        |
| `POST /api/load` · `POST /api/forward/load`                 | 加载逆向模型 / **热挂**正向模型（可行性过滤用，不重启服务）     |
| `POST /api/model-service/<action>`                          | 模型常驻进程的控制（start / stop / restart）                    |
| `GET·POST /api/llm/*`                                       | 大模型设置、端点配置、模型列表、分析与 SSE 流式                 |
| `POST /api/feedback` · `GET /api/feedback`                  | 错误反馈与学习                                                  |
| `GET /api/_threads`                                         | 线程诊断                                                        |
| `POST /api/predict` · `POST /api/search`                    | **旧接口，兼容保留**；新代码统一走 `/api/jobs`                  |

启动后端（后端在另一个仓库 → [**retro**](https://github.com/yijiu2025/retro)，
本机路径为 `F:\retrochimera`）：

```bash
cd F:\retrochimera
启动后端API.bat            # 双击即可；脚本在**仓库根**，不是 web/ 下
```

或命令行：

```bash
cd F:\retrochimera\web
python app.py                 # 默认 8000；用 RETRO_PORT 改端口
```

> 换机器部署后端时，模型权重（9GB）与依赖都要重新准备，
> 别只看这一节 —— 以 [retro 仓库的 README](https://github.com/yijiu2025/retro) 为准。

### 环境变量：只有三个 env 文件

| 文件                      | 作用                                                                                                | 入库                              |
| ------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------- |
| `.env.example`            | 完整字段文档（模板，**不参与构建**）                                                                | ✅                                |
| `.env.development`        | 开发档。默认「免登录 + 直连 Python」；切「真实登录 + Node 中转」的写法作为**档位 B** 写在它的注释里 | ✅                                |
| `.env.production.example` | 正式档模板 → 复制为 `.env.production` 使用                                                          | ✅（模板）/ ❌（.env.production） |

> 🔴 `*.local` 覆盖机制**已废弃** —— 它排在最后会静默盖掉团队档，
> 典型症状是「改了 `.env.development` 却不起作用」。切档位请直接改该文件。
> 改完**必须重启 dev server**（Vite 只在启动时读 env）。
> 后端机器/端口要换，用 `DEV_API_TARGET` / `DEV_RETRO_TARGET`（不带 `VITE_` 前缀，只被 proxy 读取）。

### 开发阶段免登录（默认开）

`.env.development` 里 `VITE_AUTH_BYPASS=true`：

- 路由守卫全放行、注入 `开发者` 用户、顶栏显示橙色「开发模式 · 免登录」角标
- **不创建 iframe、不调 userinfo、不发任何登录请求**

要验证真实登录闭环：按 `.env.development` 里的「档位 B」把 5 行开关换掉，
并保证 3000 与 5174 都在跑。

### 三道关卡（改完必须全绿）

```bash
npm run type-check   # vue-tsc -b（🔴 必须是 -b，裸 vue-tsc 恒返回 0，是假绿）
npm run lint         # eslint .
npm run build        # 先 type-check 再 vite build
```

> `vite build` 若要落到已存在的 `dist/`，会被 safe-delete shim 拦住 ——
> 需要临时验证时加 `--outDir <一个全新目录>`，别去删 `dist/`。

---

## 二、登录：iframe SSO 是怎么接的

```
头像「登录」→ SsoLoginModal
   ├─ 有历史账号 → 'accounts' 态（一键免切 / 忘掉 / 登录其他账号）
   └─ 否则      → 'login' 态：<iframe src=oauth21/mini-login?appName=retroweb…>
        ├─ @load       → 只启动 3s 兜底定时器（不关 loading）
        ├─ SSO_READY   → 关 loading + postMessage THEME_CHANGE
        ├─ LOGIN_SUCCESS → adoptDeviceId(deviceId) → POST /auth/v1/bind-session
        │                   ├─ 成功 → 写 authStore + savedAccounts → 关弹窗
        │                   └─ 失败 → 提示并**中断**（绝不静默关窗 = 假登录）
        ├─ MAX_SESSIONS → 提示设备超限
        └─ SSO_DENIED   → 提示拒绝授权
```

收消息双重校验（缺一即可被伪造 `LOGIN_SUCCESS` 注入攻击者会话）：

```ts
if (event.origin !== ssoOrigin) return;
if (!iframeRef.value || event.source !== iframeRef.value.contentWindow) return;
```

### 🔴 两处跨项目配置（漏了就调不通）

| 文件                       | 改动                                                                             | 漏了的症状                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `oauth21/.env.development` | `VITE_ALLOWED_PARENT_ORIGINS` 追加 `http://localhost:5177,http://127.0.0.1:5177` | 弹窗「正在加载安全登录」等满 3s 兜底；oauth21 控制台 `[SSO] 拒绝 postMessage：父 origin 未授权` |
| 后端生产 `CORS_ORIGINS`    | 追加前端生产 origin                                                              | 生产 `bind-session` 403「来源不在允许列表」（**dev 白名单为空时放行，本地无感、上线才炸**）     |

> 第一处已在本仓改好；第二处见根 `.env.production` 的注释。

---

## 三、目录结构

```
retroweb/
├─ public/smiles-drawer.min.js      # 纯前端 SMILES→SVG（只读展示用）
└─ src/
   ├─ config/services.ts            # SSO_URL / buildSsoLoginUrl / RETRO_BASE / AUTH_BYPASS
   ├─ api/{http,auth,retro}.ts      # http=拆信封+401；auth=会话；retro=模型服务
   ├─ composables/
   │    ├─ useSsoMessage.ts         # ★ iframe 握手 + 消息收发单一入口
   │    └─ useMolIdents.ts          # ★ 分子标识（CAS / SMILES / 名称）复制的单一来源
   ├─ stores/{auth,workspace,settings}.ts
   ├─ types/{external,retro,sso}.ts # external=window 上的第三方全局；sso 用 zod 判别联合（禁 any）
   ├─ utils/
   │    ├─ rdkit.ts                 # ★ 浏览器端 RDKit WASM（懒加载单例）
   │    ├─ smiles-drawer.ts         # SMILES → SVG
   │    ├─ pubchem.ts               # ★ CAS 查询（POST 表单；404 = 未收录）
   │    ├─ suppliers.ts             # ★ 询价供应商标识单一来源
   │    ├─ route-copy.ts            # 复制模式的单一来源
   │    ├─ scheme-save.ts · probability.ts · smiles.ts · clipboard.ts · device.ts
   ├─ components/
   │    ├─ sso/SsoLoginModal.vue    # ★ 弹窗壳（accounts / login 两态）
   │    ├─ mol/
   │    │    ├─ StructureEditor.vue # ★ 结构式画板 = Ketcher 3.14（Vue↔React 桥，懒加载）
   │    │    ├─ MolView.vue         #   只读结构图
   │    │    ├─ MolPreviewDialog.vue · MolChip.vue · CasTag.vue
   │    ├─ layout/AppShell.vue      # 侧栏（导航 + 最近任务 + 目标分析）+ 顶栏 + 内容区
   │    ├─ layout/{UserMenu,DevBypassBadge}.vue · AsidePanel.vue
   │    └─ workspace/
   │         ├─ TargetSetupPanel.vue  # ★ 标定态：整屏居中的大卡片（输入 + 参数 + 唯一出口）
   │         ├─ TargetInput.vue       # ★ 目标输入（一个框吃 CDXML/MOL/SDF/SMILES + 诊断）
   │         ├─ TargetBar.vue         #   路线态顶部的目标条
   │         ├─ TargetOverview.vue    #   「目标分析」页签
   │         ├─ RunParams.vue         # ★ 运行参数（预测设置 / 拆分约束 / AI 工艺分析 + 端点配置）
   │         ├─ SessionPanel.vue      #   侧栏「最近的任务」
   │         ├─ StepTree.vue · StepRow.vue      # 「逆合成树」页签
   │         ├─ RouteCanvas.vue · RouteStats.vue # 「路线网络」页签（画布 + 统计）
   │         ├─ RouteFlow.vue · StepAnalysis.vue # 「步骤详情」页签（流程 + 单步 AI 分析）
   │         ├─ SchemeBar.vue · SchemeCompare.vue # 路线网络：保存/切换/对比
   │         ├─ CandidatePanel.vue    # 候选 + 运行历史（每次分析都留档）
   │         ├─ StepEditDialog.vue    # 手动改路线（指定某一步的前体）
   │         ├─ SearchProgress.vue    # 多步搜索进行中的动画面板
   │         └─ JobProgress.vue
   ├─ utils/time.ts               # 相对/绝对时间文案（侧栏与任务列表共用）
   └─ views/{WorkspaceView,TasksView,HistoryView,ProfileView,NotFoundView}.vue
```

---

## 四、工作台用法

> **版式**：工作台有两种形态，由 `store.targetSetupOpen` 切换。
> **① 标定态** —— 首次进入 / 点「换目标」时，整屏居中的一张大卡片，把任务开头要做的
> 三件事合成一处：左栏「结构式画布 + 粘贴框 + 解析诊断」，右栏「运行参数」，
> 底部唯一出口「**确定目标，开始分析**」。
> **② 路线态** —— 点下那个按钮后卡片**整体消失**，切到以路线为主的常态版式：
> 顶部一条目标分子条（结构缩略 + 分子式/分子量/重原子 + 「换目标」），
> 中间**四个页签**，右侧运行参数栏**可收起**（收起后主区独占整宽）。
>
> 🔴 两条容易踩的语义约定：
>
> - **解析成功 ≠ 开跑**。解析完只是「目标填好了」，用户可能还要改模型参数，
>   所以卡片不会自动消失；只有显式点「确定目标，开始分析」才收起面板并走第一步。
> - **换目标 = 开一个新任务**。点「换目标」会清空当前树并回到标定态
>   （不是就地展开），因为那正是「任务开头」的语境。一个目标分析 = 一个任务。
>
> 运行参数按 **预测设置 / 拆分约束 / AI 工艺分析** 分三组折叠（原生 `<details>`，
> 无额外依赖、键盘可开合），组头直接显示关键值（模型名、深度·预算、大模型状态）。
> 任务有两个入口，分工不同：
>
> - **侧栏「最近的任务」** 常驻在导航之下，占满剩余高度 —— 它是"切回上一个活"的捷径，
>   只列前 6 条（其余进折叠的「更早的任务」），每条含状态圆点 + 相对时间 + hover 删除；
>   侧栏收起时该列表自动隐藏。任务超过 6 条时末尾出现「查看全部 N 个任务 →」。
> - **一级菜单「任务列表」（`/tasks`）** 与工作台并列 —— 全量列出，能按关键词
>   （名称 / SMILES / 模型）搜、按状态筛、按更新时间或名称排，每条给出节点数 / 已定步数 /
>   层数 / 方案数，可打开接着做或删除。
>
> 🔴 任务（`store.sessions`）≠ 历史记录（`store.history`）：前者是还在手上的活，
> 带整棵路线树与未跑完的 job，点开是**接着做**；后者是手动「保存」沉淀的快照，
> 点开是**回看 / 载入**。

### 四个页签

| 页签         | 组件                         | 看什么                                  |
| ------------ | ---------------------------- | --------------------------------------- |
| **目标分析** | `TargetOverview`             | 目标分子性质、CAS、可购买性、统计 chips |
| **逆合成树** | `StepTree` / `StepRow`       | 一行一化合物，展开 / 采纳 / 复用        |
| **路线网络** | `RouteCanvas` / `SchemeBar`  | 已确认的路线网、多条方案并列对比        |
| **步骤详情** | `RouteFlow` / `StepAnalysis` | 每步工艺流程 + 单步 AI 分析             |

1. **目标分子**（在标定卡左栏）：**点「画结构式」开 Ketcher 画板手画**（画完即解析出结构），
   或粘贴 ChemDraw 复制的 CDXML / MOL / SDF，或选文件，或直接填 SMILES —— **一个输入框吃四种格式**，
   格式自动识别（见 `needsBackendParse()`）。解析失败会给出人话诊断 + 一键修复候选
   （R 基团、`[*]`、通用取代基）。解析成功 → 卡片里出现结构缩略 + 分子式 / 分子量 /
   重原子 / 类型，底部「确定目标，开始分析」随之可用。
2. **运行参数**（分三组折叠；标定卡里在右栏，进入路线态后移到右侧参数栏，可收起）：
   - **预测设置**（默认展开）：模型（Pistachio / USPTO-FULL / USPTO-50K）+ 预热、每步候选数
   - **拆分约束**（默认收起）：自动拆分深度、可购买重原子阈值（默认 **≤6**）、调用预算、指定起始物料
   - **AI 工艺分析**（默认收起）：端点配置状态 + 「验证」按钮（状态在组头上也常驻可见）
   - 「自动往下拆」按钮**常驻在分组之外**，不藏在折叠组里
   - **可行性过滤**：勾选后多步搜索会用正向模型过滤不可行的步 —— 正向模型**可热挂**
     （`/api/forward/load`，不重启服务），未就绪时**拦在提交前**，不会跑了才失败。

   > 阈值定 10 时阿司匹林拆一步就到顶（前体普遍 ≤10 重原子）,
   > 想多拆几层就把阈值调小（苯环量级 6 是常用口径）。
   > ⚠️ 「每步候选数」**只作用于单步预测**：syntheseus 的 `DEFAULT_NUM_RESULTS=100`，
   > 多步搜索主循环调 `reaction_model(mols)` 时不带 `num_results` ⇒ 改它对多步无效。

3. **逆合成树**：点行内「展开」走一步预测 → 候选卡片里「采纳」→ 前体各新增一行。
   - 终止判定：手动标记可购买 / 重原子数 ≤ 阈值 / 命中指定起始物料
   - 防环：同分支出现过的 SMILES 标「同分支重复」并禁止再展开
   - 已满足终止条件的行，「展开」按钮**直接禁用**并在 tooltip 里说清原因和解除办法
   - **每次分析都留档**：同一行反复「重新分析 / 重新选择」，结果按 `runs` 依次保留，
     行内下拉可**切回任意一次**的分析结果（候选、概率、耗时一起回滚），不会互相覆盖
   - **相同中间体自动复用**：新展开出的分子若在树里已分析过（同 canonical SMILES），
     直接挂上旧结果并标「复用分析」，**不重跑模型**；仍可手动「重新分析」覆盖
   - **手动改路线**：`StepEditDialog` 直接指定某一步的前体（模型拆不出来时兜底），
     手工步的概率是 **`null`**，不要兜成 0
4. **路线网络 / 方案（SchemeBar）**：同一目标的**多条路线并列保留**，随时切换查看。
   - 一条路线可以有**分支**（一步拆出 ≥2 个前体）⇒ 它是一张**网**而不是一条链
   - 确认入口在「逆合成树」：拆到满意就在树上点「确认路线网络」
     （当前方案被改过 ⇒ **自动分叉**一条新记录，不覆盖旧的）
   - 切换方案 = **改写选择**而不是删树：被摘掉的分支标 `detached`（内存里留着、不进统计），
     切回来时**原样接回**，不重跑、不丢既有分析
   - 改一条**已保存**方案的选择 → 自动 **fork 出新方案**，旧方案永不被改写
   - 方案对比表：并排列出各方案的步数、总概率、起始物料数、标记终止步数
   - 🔴 方案切换的正确性靠**真实 store** 守住（`applySearchRoutes` 只铺 candidates、
     禁逐路线 adopt —— 共享节点互覆会让树只剩根）
5. **步骤详情（RouteFlow）**：把选定路线渲染成流水线 —— 每步一张卡
   「前体 (原料) →〔条件 / 试剂 / 当量〕→ 产物」，条件来自该步的 AI 分析结果（未分析则空着）。
   卡片内可展开单步分析、可单步触发 AI 分析；顶部「一键分析全路线」串行跑完所有步。
   点树/路线表里的「工艺分析」会切到本视图并**滚动定位**到对应步。
6. **历史记录**：任务快照存 localStorage（最多 30 条），可载入 / 删除。
   快照包含路线方案（`schemes` / `currentSchemeId`）与每步分析结果。
   同时，**左侧导航栏下半部分常驻「最近的任务」**列表（按更新时间倒序，最多 12 条），
   点任意一条即可载入（恢复路线树、切回工作台并自动接回还在跑的 job 轮询）；
   行内悬停出现删除按钮，删除前二次确认。打开一个已有路线的任务会**直接进路线态**。

⚠️ 模型预测可能存在幻觉，页面常驻警示条；导出文件自带免责声明。

---

## 五、结构式画板 = Ketcher 3.14

点「画结构式」打开。编辑器是 **Ketcher**（EPAM 开源，Indigo WASM 内核），
`components/mol/StructureEditor.vue` 做 Vue↔React 桥：

```
画板（Ketcher）──getMolfile()──▶ 前端 RDKit.js ──▶ canonical SMILES + 分子式 + 分子量 + 诊断
前端 RDKit ──depictMolfile()──▶ 画板 loadFromMolfile(mol)   （载入已有结构）
```

**分工没有变**：画板只管编辑，**化学正确性一律由 RDKit 终审**（valence / Markush 全兜住）。
早期版本是自绘 SVG 画板（`rings.ts` / `useStructureEditor.ts`，已删），
换成 Ketcher 是因为芳香性 / 立体化学 / 模板库 / 元素周期表这些 Ketcher 全自带，
且 **standalone 模式把 Indigo 编译成 WASM 内联进 worker**，纯离线、不需要 Indigo 后端服务。

🔴 **四条实测事实**（改之前先看，别再踩）：

1. **WASM 不是外部文件，是内联 data URI** —— `ketcher-standalone` 的 `findWasmBinary()`
   返回 `data:application/octet-stream;base64,…`（worker 源码里塞着 8.9MB 的 base64）。
   推论：`staticResourcesUrl` 传空串即可，永远不会 wasm 404；
   代价是 `ketcher-standalone/dist/main.js` **16MB** ⇒ **必须懒加载**。
   这里用动态 `import()`，严格只在弹窗首次打开时才拉。
2. **`ketcher-react` 是一整棵 React 树**（2.4MB ESM，带 MUI / emotion / redux / draft-js…），
   Vue 里没法走 SFC 模板 ⇒ `createRoot` + `createElement` 手动挂载（不用 JSX）。
   它 `import 'util'`（browserify polyfill）里有裸 `process` 引用 ⇒
   `index.html` 垫了 `window.process`，否则真被调到就是 "process is not defined"。
3. **`Editor` 必填 props 只有三个**：`staticResourcesUrl` / `structServiceProvider` /
   `errorHandler`；`ketcherId` 被组件内部接管。实例经 `onInit(ketcher)` 回传 ——
   它比 `root.render()` **晚一拍**（React 18 并发渲染），所以要单独 `whenReady()` 等实例。
4. **接口全是异步的**（要过 WASM worker）⇒ `isEmpty()` / `getMolfile()` 必须 `await`。
   打开画板时要把当前结构**带进去**（`resolveSeed()`）—— 开一张空画板等于让用户把刚粘的再画一遍。

> ⚠️ Ketcher 3.14 **只有亮色主题**（产物里搜不到 dark 开关）。暗色应用下也保持白底画布 ——
> 化学编辑器的白纸观感是行业惯例，别去改。
>
> ⚠️ 别被构建产物吓到：`main-*.js 16MB` 是**这个**懒加载 chunk（Vite 按源文件名命名），
> **不在首屏**。首屏实际只有 ~1.3MB（gzip ≈350KB）。

---

## 五·五、分子结构图（MolView）的两种尺寸模式

`MolView` 走 smiles-drawer 画 SVG，尺寸有**两种**模式，选错就是「图被裁掉」或「塌成 0」：

| 模式           | 用法                                           | 适用容器                                                                                       |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 定像素（默认） | `:bond-px :min-px :maxPx` 算出明确 px 写回 SVG | **auto 尺寸**容器（候选卡、路线行、预览弹窗）—— 容器跟着图长                                   |
| `fit`          | 宽高 100% + `viewBox` 等比缩放                 | **定尺寸**容器（`.step-row__mol` 104×64、`.target__mol` 150×120、`.history-item__mol` 120×88） |

🔴 定尺寸容器都是 `overflow: hidden`，不开 `fit` 大分子会被切掉一半；
反过来，auto 高度的容器开 `fit` 会让 SVG 塌成 0 高 —— **两种模式不能互换**。

---

## 六、大模型工艺分析（可选）

在**逆合成路线**之上再加一层「这条路真做起来会怎样」的判断：每一步的投料顺序、当量、
反应结果与预期收率、可能副产物、LCMS / NMR 预测、安全提示。

### 6.1 配置：首选「端点配置」，`.env` 只是兜底

**推荐路径**：前端「运行参数 → AI 工艺分析 → 端点配置」里管理。
那里把 **接口地址 + 模型 + 一组 API Key 绑成一「套」**，可存多套（DeepSeek 官方 / 公司网关…）
随时切换 —— 换供应商就是切整套，不会出现「地址换了模型忘了换」这种一调就 401/404 的组合。
同一套里可放多个 Key，请求失败（失效 / 限流 / 额度不足）自动切下一个，
且**每套配置各有一份独立的轮换状态**。保存到 `web/llm_settings.json`，改完立即生效。

**兜底路径**：`web/.env` 的 `RETRO_LLM_*`（只在「一个端点配置都没有」时生效，
优先级**低于** `llm_settings.json`）：

```ini
RETRO_LLM_BASE_URL=https://api.deepseek.com/v1
RETRO_LLM_API_KEY=sk-xxxxxxxx          # 留空 = 功能自动降级（前端显示「未配置」，不报错）
RETRO_LLM_MODEL=deepseek-chat
RETRO_LLM_MAX_TOKENS=32768             # 🔴 必须显式给：推理模型的思考 token 也算进输出额度
RETRO_LLM_TIMEOUT=300                  # 秒；推理模型 + 长 prompt 建议留足
RETRO_LLM_JSON_MODE=1                  # 要求 response_format=json_object
RETRO_LLM_TEMPERATURE=0.3              # 化学场景要稳，别调高
```

**改完立即生效，不需要重启**（后端按文件 mtime 热重载；空值视为「未设置」，删行也能真正失效）。
任意 OpenAI 兼容端点都可（自建 vLLM / Ollama / OneAPI 一样用）。

🔴 **「填了」不等于「能用」**——这是最容易浪费半小时的地方。三步自检：

```bash
curl "http://127.0.0.1:8000/api/llm/status?probe=1"   # 真发一次最小请求，验证 key+模型
curl "http://127.0.0.1:8000/api/llm/models"           # 列出该 key 能看到的模型
curl -sI "https://<你的端点>/v1/models" -H "Authorization: Bearer <key>"   # 最省：只探鉴权，不耗 token
```

前端「运行参数」里的**「验证」按钮**就是 `probe=1`，标签会区分四态：
灰=未配置 / 黄=已填未验证 / 绿=验证可用 / 红=验证失败（tooltip 里给原始报错）。

**三条实测踩过的坑**：

| 坑                        | 症状                                                                                                            | 处置                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/v1/models` 会骗人       | 列出 9 个模型，其中 3 个一调就 `model is not available in the current token plan` / `model is not found`        | **以 `probe` 为准**，不以列表为准                                                                |
| 限流**按模型端点**算      | 把某端点打到 `429 RateLimitExceeded.EndpointTPMExceeded` 后，连 `"hi"` 都发不出去，**同一时刻换个模型完全正常** | 换模型（换模型 = 换一条独立配额）                                                                |
| `max_tokens` 不给就踩截断 | 推理模型的**思考 token 也计入输出额度** ⇒ 给太小则正文一个字没出就 `finish_reason=length`，JSON 抽不出来        | 显式下发；后端检测到 `length` 且抽不出 JSON 时**直接报「输出被截断」**，而不是含混的「解析失败」 |

> `max_tokens=0` = **无限制**（后端会整个字段不下发），别误当成"输出 0 个字"。

### 6.2 接口

| 方法     | 路径                         | 说明                                                                               |
| -------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| GET      | `/api/llm/status`            | 是否配置（**永不返回 api_key**，只回 `has_key` 布尔）。`?probe=1` 附加真实验证结果 |
| GET      | `/api/llm/models`            | 列出该 key 可见的模型 id（**仅列出，不代表套餐内可用**）                           |
| GET·POST | `/api/llm/settings`          | 端点配置（多套 profiles）读写                                                      |
| POST     | `/api/llm/settings/active`   | 切换生效的那套                                                                     |
| POST     | `/api/llm/keys/reset`        | 重置某套的 key 轮换状态                                                            |
| POST     | `/api/llm/analyze`           | 一次性返回完整 JSON                                                                |
| POST     | `/api/llm/analyze/stream`    | **SSE 流式**（见下）                                                               |
| POST     | `/api/llm/conditions/stream` | 候选反应条件流式生成                                                               |
| POST     | `/api/llm/followup/stream`   | 追问（自由文本，**必须关掉 `response_format`**）                                   |

请求体：`{product_smiles, precursors[], conditions?, context?}`。
服务端会**先用 RDKit 把精确质量算好**（`[M+H]+` / `[M-H]-` / `[M+Na]+`）塞进 prompt，
大模型只负责**解读**，不许它自己算数 —— 这是刻意防幻觉的设计。

流式事件序列：

```
meta         → {model, computed}     先到，前端立刻能画出质量表
thinking     → {text}                推理模型的思考增量（反复；非推理模型不发）
thinking_end → {chars}               思考结束、正文开始
delta        → {text}                正文增量（反复）
done         → {data, computed, raw, model, reasoning, finish_reason}
error        → {error}
```

⚠️ 推理模型的时间分布很悬殊 —— 实测阿司匹林一步：

| 模型                | meta  | 首个 thinking | 思考结束 | done  | 思考体量            |
| ------------------- | ----- | ------------- | -------- | ----- | ------------------- |
| `deepseek-v4-flash` | 0.7s  | 2.6s          | 27.8s    | 40.3s | 1984 事件 / 3139 字 |
| `glm-5.2`           | 0.01s | 6.2s          | 55.5s    | 57.8s | 427 事件 / 4646 字  |

**前 30~55 秒正文一个字都没有**，这就是为什么 `thinking` 事件不能省。
SSE 经 **Vite dev proxy 是真流式透传**，不需要为 dev 做额外配置。

### 6.3 前端表现（StepAnalysis.vue）

投料顺序表（序号 / 方式 / 试剂 / 当量 / 备注）· 条件描述列表（溶剂 / 温度 / 时间 / 气氛 / 催化剂 / 后处理）·
反应结果（预期 / 收率区间 / 纯度 / 风险）· 副产物表（名称 / 来源 / m/z / 控制手段）·
LCMS（**理论值来自 RDKit，注释来自模型**）· NMR（¹H / ¹³C 描述）· 安全提示 · 置信度。
流式过程中逐字上屏，可随时**取消**（`AbortController`）。
另有**点板 / 过柱极性预测**模块（`tlc` / `workup`）。

🔴 **推理模型必须显示「思考」**：`glm-5.2` / `deepseek-v4-pro` / `kimi-k3` 这类模型开头十几到几十秒
（实测 `glm-5.2` 达 55 秒）**只吐 `reasoning_content`，`delta.content` 一直是空字符串**。
只读正文的话，界面在整个思考阶段一个字都不动，看着像卡死，用户会以为服务挂了然后去点取消。
所以思考单独走 `thinking` 事件、存在 `analysis.reasoning`（与 `raw` 分开），流式中实时显示、
结束后折叠可回看。

### 6.4 几条实现约束（改之前先看）

- **SSE 走 POST + `fetch` + `ReadableStream`，不是 `EventSource`** —— 因为要带请求体。
- `reasoning_content` **不能混进 `raw`**，否则 `extract_json` 会先撞上思考文本（里面常有花括号示例）。
- 模型常把 JSON 包在 ` ```json ` 围栏里或前后带废话 ⇒ 用**花括号配平扫描器**（正确处理字符串与转义），
  正则一刀切会在遇到字符串里的 `}` 时截断。
- **追问的自由文本必须关掉 `response_format`**（`json_mode=False`），否则模型被强制吐 JSON、答非所问。
- 分析结果**随节点存 localStorage**，原始输出截断到 2000 字符；仍超配额时自动丢弃全部 `raw` 保会话不丢。
- 路线上下文（上游产物 / 下游前体）会拼进 prompt，让模型知道这一步在整条路线里的位置。
- `.env` 热重载靠 **mtime + 基线重放**：先把 `os.environ` 里由文件注入的 `RETRO_*` 复位到
  「首次加载前的真实环境变量快照」，再重放文件 ⇒ 从文件里**删掉**的行才会真正失效。
  只用 `setdefault` 是不够的：空值会占住 key，导致后续填值永不生效。

---

## 七、已知约束

- 首次预测要加载模型 + 起规则子进程，**可达数十秒甚至数分钟**（实测 pistachio 首帧 >13 分钟仍未返回）
  ⇒ 前端超时 10 分钟、可取消、提供「预热」按钮；**正式用之前一定先点预热**。
- **搜索预算会被"历史调用"吃掉**：模型常驻服务下 `num_calls()` 跨搜索累计，
  涨过 `limit_reaction_model_calls` 就**开局即停**（表现为 0 秒结束、0 条路线）。
  所以预算按「`num_calls()` + 本次」算，不是「本次」。
- 前体若含通配原子 `*`（R 基团）或芳香环 kekulize 失败，Flask 会返回 **HTTP 400 + 结构化诊断**，
  该行标「失败」并列出人话原因（`reasons`）—— 这不是前端 bug，是模型给出的结构本身不可预测。
- Flask 默认**不开 CORS**：dev 走 vite proxy（`/retro/*` → `8000/api/*`）同源，无需配置；
  生产前后端不同域时，**必须**在后端设 `RETRO_CORS_ORIGINS`，否则页面数据永远转圈。
  生产也建议在前面挂一层网关顺带鉴权。
- 规则子进程内存占用大 ⇒ 自动拆分是**串行**的，并发默认 1。
- 历史任务存 localStorage（未接后端表）。
- **AI 工艺分析结果是模型推测**，未经实验验证；LCMS/NMR 理论值虽由 RDKit 计算，但结构本身正确与否
  取决于上游逆合成预测 —— 全链路都需人工复核。

---

## 八、体检记录

2026-10-09 做过一次全仓体检（清理 1.5GB 临时物 + 四关验证），
结果见 `docs/healthcheck-2026-10-09.md`。

---

## 九、自愿支持

这是**自愿**的，不影响任何功能使用 —— 项目不会因为没打赏而限制功能、变慢，或多弹任何提示。

本项目按**本地部署**使用（模型与推理都在你自己的机器上），不产生服务器开销。
若你所在机构有相关预算，走机构采购 / 科研经费流程对双方都更省事。

> 以微薄之力，为人类社会的进步添一点实在的东西 —— 与同道一起推进我国有机 AI 研究生态，
> 为生物化学的基础研究往前推一步。

<table>
  <tr>
    <td align="center"><img src="public/donate/wechat.png" width="220" alt="微信收款码"></td>
    <td align="center"><img src="public/donate/alipay.png" width="220" alt="支付宝收款码"></td>
  </tr>
  <tr>
    <td align="center"><sub>微信</sub></td>
    <td align="center"><sub>支付宝</sub></td>
  </tr>
</table>

收款人：**世间無晚風(\*功)**

### 公众号

<p align="center">
  <img src="public/donate/mp-qrcode.jpg" width="150" alt="柒染靓月公众号二维码">
</p>

微信搜索公众号 **柒染靓月** 即可找到。项目进展、用法分享、更新公告都在这里发。

---

## 十、许可与免责

本项目采用 **[MIT 协议](LICENSE)** —— 你可以自由使用、复制、修改、合并、再分发（含商用），
唯一要求是在所有副本中保留版权声明与许可声明。

> ⚠️ MIT **不含专利授权**。若你需要明确的专利许可（例如打算进企业内部产品），请改用 Apache-2.0。

第三方组件各自遵循其原许可，商用前须逐项确认（下列取自 `node_modules/*/package.json`
的 `license` 字段，非记忆）：

| 组件 | 协议 |
| --- | --- |
| Ketcher（结构式画板） | Apache-2.0 |
| RDKit（`@rdkit/rdkit`，WASM） | BSD-3-Clause |
| Element Plus / Vue / axios / Pinia / Vue Router / zod | MIT |
| Vite / ESLint / Sass / unplugin-vue-components | MIT |
| TypeScript | Apache-2.0 |
| Ketcher 内含的 Indigo | 见 Ketcher 仓库声明 |

逆合成预测与 AI 工艺分析均为**模型推测**，未经实验验证；用于研发辅助，
不应直接作为生产或安全决策依据。
