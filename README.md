# RetroWeb · 逆合成工作台（独立前端）

一行一个化合物，**多次一步**交互式拆分 —— 每次「展开」只发一次 `/api/predict`（单步逆合成），
采纳候选后前体各新增一行，路线树由前端自己长出来。
刻意**不**调用 `/api/search`（Retro\* 一次搜到底）。

在路线之上还叠了三层能力：**同一原料的多条路线方案并列保留、随时切换**（不是删树，切回来原样接回）·
**每次分析结果都留档、相同中间体自动复用**（不重跑模型）· **每步工艺流程 + 大模型工艺分析**
（投料顺序 / 当量 / 反应结果 / 副产物 / LCMS / NMR）。

登录采用 **iframe 嵌入 oauth21 `/mini-login`**（与 posecraft / firewall 同一套 SSO 模式），
注册 / 忘记密码 / 邮箱二次验证 / 设备超限全部由 oauth21 提供，本应用不自建登录页。

> 技术栈：Vue 3.5 + TypeScript + Vite 8 + Pinia + Vue Router + axios + Element Plus 2.14
> 端口：**5177**（oauth21 占 5174/5175，posecraft 占 5176）

---

## 一、跑起来

```bash
cd retroweb
npm install
npm run dev          # http://localhost:5177
```

### 依赖的后端（另开终端）

| 服务 | 地址 | 用途 | 是否必须 |
| --- | --- | --- | --- |
| 逆合成模型服务（Flask） | `127.0.0.1:8000` | `/api/parse`、`/api/predict`、**核心** | ✅ 必需 |
| 账号服务（Fastify） | `localhost:3000` | `userinfo` / `bind-session` | 仅**真实登录**时需要 |
| oauth21 登录页 | `localhost:5174` | iframe 登录 UI | 仅**真实登录**时需要 |
| 大模型 API（OpenAI 兼容） | 外部（默认 DeepSeek） | `/api/llm/analyze*` 工艺分析 | 仅**用 AI 分析**时需要 |

启动 Flask（后端在另一个仓库 → [**retro**](https://github.com/yijiu2025/retro)，
完整步骤见其 README；本机路径为 `F:\retrochimera`）：

```bash
cd F:\retrochimera
web\启动网页版.bat            # 双击即可；自动找 Python + 检测端口占用
```

或命令行：

```bash
cd F:\retrochimera\web
python app.py                 # 默认 8000；用 RETRO_PORT 改端口
```

> 换机器部署后端时，模型权重（9GB）与依赖都要重新准备，
> 别只看这一节 —— 以 [retro 仓库的 README](https://github.com/yijiu2025/retro) 为准。

### 开发阶段免登录（默认开）

`.env.development` 里 `VITE_AUTH_BYPASS=true`：

- 路由守卫全放行、注入 `开发者` 用户、顶栏显示橙色「开发模式 · 免登录」角标
- **不创建 iframe、不调 userinfo、不发任何登录请求**

要验证真实登录闭环：把该变量改成 `false`，并保证 3000 与 5174 都在跑。

### 生产构建

```bash
npm run build        # 先跑 vue-tsc -b（类型闸门）再 vite build
npm run preview
```

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

| 文件 | 改动 | 漏了的症状 |
| --- | --- | --- |
| `oauth21/.env.development` | `VITE_ALLOWED_PARENT_ORIGINS` 追加 `http://localhost:5177,http://127.0.0.1:5177` | 弹窗「正在加载安全登录」等满 3s 兜底；oauth21 控制台 `[SSO] 拒绝 postMessage：父 origin 未授权` |
| 后端生产 `CORS_ORIGINS` | 追加前端生产 origin | 生产 `bind-session` 403「来源不在允许列表」（**dev 白名单为空时放行，本地无感、上线才炸**） |

> 第一处已在本仓改好；第二处见根 `.env.production` 的注释。

---

## 三、目录结构

```
retroweb/
├─ public/smiles-drawer.min.js      # 纯前端 SMILES→SVG，从 retrochimera 复制
└─ src/
   ├─ config/services.ts            # SSO_URL / buildSsoLoginUrl / RETRO_BASE / AUTH_BYPASS
   ├─ api/{http,auth,retro}.ts      # http=拆信封+401；auth=会话；retro=模型服务
   ├─ composables/useSsoMessage.ts  # ★ iframe 握手 + 消息收发单一入口
   ├─ stores/{auth,workspace,settings}.ts
   ├─ types/{external,retro,sso}.ts # sso 用 zod 判别联合收敛（禁 any）
   ├─ components/
   │   ├─ sso/SsoLoginModal.vue     # ★ 弹窗壳（accounts / login 两态）
   │   ├─ mol/MolView.vue            # SMILES → SVG（只读展示）
   │   ├─ mol/StructureEditor.vue    # ★ 结构式画板：SVG 画布 + 工具条 + 元素面板
   │   ├─ layout/AppShell.vue        # 侧栏（导航 + 最近任务）+ 顶栏 + 内容区
   │   ├─ layout/{UserMenu,DevBypassBadge}.vue
   │   └─ workspace/
   │        ├─ TargetSetupPanel.vue  # ★ 标定态：整屏居中的大卡片（画布 + 输入框 + 参数）
   │        ├─ TargetInput.vue       # ★ 目标分子输入（画布 / 粘贴 / 文件 / SMILES + 解析诊断）
   │        ├─ TargetBar.vue         # ★ 路线态顶部的目标条（结构缩略 + 性质 + 换目标）
   │        ├─ RunParams.vue         # ★ 三组折叠（预测设置 / 拆分约束 / AI 工艺分析）
   │        ├─ SessionPanel.vue      # 侧栏「最近的任务」常驻列表
   │        ├─ StepTree / StepRow    # 路线树与单行（右栏页签一）
   │        ├─ CandidatePanel.vue   # ★ 候选 + 运行历史（每次分析都留档，可切回）
   │        ├─ RouteSummary.vue     # ★ 一条完整路线（步骤表 + 总概率 + 起始物料）
   │        ├─ SchemeBar.vue        # ★ 路线方案：保存 / 切换 / 改名 / 删除 / 并列对比（空态收成一行）
   │        └─ RouteFlow.vue        # ★ 每步工艺流程（前体 →条件→ 产物）+ 一键全路线分析
   │            └─ StepAnalysis.vue # ★ 单步 AI 工艺分析（投料顺序/当量/副产物/LCMS/NMR）
   ├─ composables/useStructureEditor.ts  # ★ 画板状态机（图 / 工具 / 撤销栈）
   ├─ types/editor.ts                    # 图模型（原子 / 键 / 键级 / 立体）
   └─ utils/{molfile,rings}.ts           # molfile(V2000) 读写 · 环模板与元素面板
   └─ views/{WorkspaceView,HistoryView,ProfileView,NotFoundView}.vue
```

---

## 四、工作台用法

> **版式（2026-10-05 二次重构）**：工作台有两种形态，由 `store.targetSetupOpen` 切换。
> **① 标定态** —— 首次进入 / 点「换目标」时，整屏居中的一张大卡片，把任务开头要做的
> 三件事合成一处：左栏「结构式画布 + 粘贴框 + 解析诊断」，右栏「运行参数」，
> 底部唯一出口「**确定目标，开始分析**」。
> **② 路线态** —— 点下那个按钮后卡片**整体消失**，切到以路线为主的常态版式：
> 顶部一条目标分子条（结构缩略 + 分子式/分子量/重原子 + 「换目标」），
> 中间三页签（路线树 / 合成路线 / 每步流程），右侧运行参数栏**可收起**
> （收起后主区独占整宽）。
>
> 🔴 两条容易踩的语义约定：
> - **解析成功 ≠ 开跑**。解析完只是「目标填好了」，用户可能还要改模型参数，
>   所以卡片不会自动消失；只有显式点「确定目标，开始分析」才收起面板并走第一步。
> - **换目标 = 开一个新任务**。点「换目标」会清空当前树并回到标定态
>   （不是就地展开），因为那正是「任务开头」的语境。一个目标分析 = 一个任务。
>
> 运行参数按 **预测设置 / 拆分约束 / AI 工艺分析** 分三组折叠（原生 `<details>`，
> 无额外依赖、键盘可开合），组头直接显示关键值（模型名、深度·预算、大模型状态）。
> 任务列表在**左侧导航栏下半部分常驻**（不再是按钮 + 抽屉）：导航（工作台 / 历史记录 /
> 个人中心）之下的剩余高度全给「最近的任务」，每条含状态圆点 + 相对时间 + hover 删除；
> 侧栏收起时该列表自动隐藏。

1. **目标分子**（在标定卡左栏）：**点「画结构式」开画板手画**（画完即解析出结构），或粘贴
   ChemDraw 复制的 CDXML / MOL / SDF，或选文件，或直接填 SMILES；
   解析失败会给出人话诊断 + 一键修复候选（R 基团、`[*]`、通用取代基）。
   解析成功 → 卡片里出现结构缩略 + 分子式 / 分子量 / 重原子 / 类型，
   底部「确定目标，开始分析」随之可用。
2. **② 运行参数**（分三组折叠；在标定卡里位于右栏，进入路线态后移到右侧参数栏，可收起）：
   - **预测设置**（默认展开）：模型（Pistachio / USPTO-50K）+ 预热、每步候选数
   - **拆分约束**（默认收起）：自动拆分深度、可购买重原子阈值（默认 **≤6**）、调用预算、指定起始物料
   - **AI 工艺分析**（默认收起）：大模型配置状态 + 「验证」按钮（状态在组头上也常驻可见）
   - 「自动往下拆 K 层」按钮**常驻在分组之外**，不藏在折叠组里

   > 阈值定 10 时阿司匹林拆一步就到顶（前体普遍 ≤10 重原子），「多次一步」形同虚设 ——
   > 想多拆几层就把阈值调小（苯环量级 6 是常用口径）。
3. **③ 路线树**：点行内「展开」走一步预测 → 候选卡片里「采纳」→ 前体各新增一行。
   - 终止判定：手动标记可购买 / 重原子数 ≤ 阈值 / 命中指定起始物料
   - 防环：同分支出现过的 SMILES 标「同分支重复」并禁止再展开
   - 已满足终止条件的行，「展开」按钮**直接禁用**并在 tooltip 里说清原因和解除办法
     （旧版点了没反应，最容易被当成「第二步出错了」）
   - 「自动往下拆 K 层」= 串行多次调同一个单步接口，每层取 Top-1，可随时停止
   - **每次分析都留档**：同一行反复「重新分析 / 重新选择」，结果按 `runs` 依次保留，
     行内下拉可**切回任意一次**的分析结果（候选、概率、耗时一起回滚），不会互相覆盖
   - **相同中间体自动复用**：新展开出的分子若在树里已分析过（同 canonical SMILES），
     直接挂上旧结果并标「复用分析」，**不重跑模型**；仍可手动「重新分析」覆盖
4. **合成路线**：由选定分支回溯出步骤列表 + 总概率连乘 + 起始物料汇总，可导出 JSON / CSV / 打印为 PDF。
   - 多分支合成时同一层会有好几条 —— 列表 key 用 `nodeId`，展示上补「· 分支 N」区分。
   - 每步旁带「已分析」标签 + 「查看工艺分析」直达该步的流程视图。
5. **路线方案（SchemeBar）**：同一个起始原料的**多条路线并列保留**，随时切换查看。
   - 「保存方案」把当前每个节点的选择（`nodeId → reactionId`）冻结成一条命名方案
   - 切换方案 = **改写选择**而不是删树：被摘掉的分支标 `detached`（内存里留着、不进统计），
     切回来时**原样接回**，不重跑、不丢既有分析
   - 改一条**已保存**方案的选择 → 自动 **fork 出新方案**，旧方案永不被改写
     （这是本功能最容易实现错的一点：就地改写会让历史方案悄悄变样）
   - 方案对比表：并排列出各方案的步数、总概率、起始物料数、标记终止步数
   - 🔴 方案切换的正确性靠**真实 store** 集成测试守住：`npm run test:store`
6. **每步工艺流程（RouteFlow）**：把选定路线渲染成流水线 —— 每步一张卡
   「前体 (原料) →〔条件 / 试剂 / 当量〕→ 产物」，条件来自该步的 AI 分析结果（未分析则空着）。
   卡片内可展开单步分析、可单步触发 AI 分析；顶部「一键分析全路线」串行跑完所有步。
   点树/路线表里的「工艺分析」会切到本视图并**滚动定位**到对应步。
7. **历史记录**：任务快照存 localStorage（最多 30 条），可载入 / 删除。
   快照包含路线方案（`schemes` / `currentSchemeId`）与每步分析结果。
   同时，**左侧导航栏下半部分常驻「最近的任务」**列表（按更新时间倒序，最多 12 条），
   点任意一条即可载入（恢复路线树、切回工作台并自动接回还在跑的 job 轮询）；
   行内悬停出现删除按钮，删除前二次确认。打开一个已有路线的任务会**直接进路线态**。

⚠️ 模型预测可能存在幻觉，页面常驻警示条；导出文件自带免责声明。

---

## 五、结构式画板（自绘 SVG + RDKit 校验）

点「画结构式」打开。核心分工：**画板只管拓扑与坐标，化学正确性一律交给 RDKit**。

```
画板图 ──graphToMolfile()──▶ /api/parse ──▶ canonical SMILES + 分子式 + 分子量 + 人话诊断
画板图 ◀──molfileToGraph()── /api/depict（RDKit 算 2D 坐标，用来载入已有结构）
```

**能做什么**：点空白放碳原子 · 从原子往外拖成键 · 再点键循环升级 单→双→三→芳香 ·
楔形/虚线立体键 · 元素面板（常用/卤素/金属/其他 + `*` 通配）· 电荷 ±1 ·
模板一键插入（苯、环己烷、环戊烷、环丁烷、环丙烷、吡啶、呋喃、萘）·
撤销/重做（Ctrl+Z / Ctrl+Shift+Z）· 适应画布 · 滚轮缩放 · 橡皮 · Delete 删选中原子。
画完点「用此结构搜索」→ 解析 + 设为目标 + （可选）立刻展开一步。

**为什么自研而不上 Ketcher**（调研结论，别再重踩）：

| 方案 | 结论 |
| --- | --- |
| Ketcher 3.18 | 体验最好、ChemDraw 级，但只有 React 形态（peer: react + @mui + redux，包 30 MB+），在 Vue3 里只能独立子应用 + iframe，产物 ~10 MB，构建链路要重写 |
| OpenChemLib | npm 包（`openchemlib@9.25`）**只有 core，不含 `StructureEditor`** —— 编辑器在 `full` build 里，得上 Java JDK + GWT 自己编译 |
| Kekule.js | MIT、编辑器功能全，但 UI 老旧、42 MB unpacked |

所以：**自己画 SVG 最划算**，化学式正确性由后端 RDKit 兜底，画板不需要 kekulize / 化合价校验。
真要做到 ChemDraw 全功能（反应箭头、模板库、R 基团）时，再按「独立 Ketcher 子应用 + iframe」的
路子加，画板的对外契约（`getMolfile()` / `loadFromMolfile()`）不用动。

**三个实现细节**（改错了就是静默翻车）：

1. 线宽用 `vector-effect: non-scaling-stroke`，但**字号与命中半径要除以 `view.scale`**，
   否则一缩放文字变形、点击判定偏移。
2. 连续拖动（移动原子 / 平移）只在 pointerdown 调一次 `snapshot()`；每次 pointermove 都压快照，
   撤销一次只挪一格。
3. 屏幕→世界坐标要按 `xMidYMid meet` 自己算居中偏移，直接拿 `rect` 做比例换算会整体偏。
4. molfile 列宽是硬契约：counts 行两个 3 列；原子行坐标各 10 列、元素从第 31 列起；
   键行 4 个 3 列；电荷走 `M  CHG`。写歪一点 RDKit 会**静默读成空分子**。
5. 立体标注（wedge/hash）只允许挂在单键上 —— 升级成多重键时必须清掉 `stereo`。

> ⚠️ 画板依赖 Flask 的 **`/api/depict`**（`F:\retrochimera\web\app.py`，本次新增）。
> 它是「载入已有结构到画板」的唯一来源；只有手画、不需要载入时没有它也行。

---

## 五·五、分子结构图（MolView）的两种尺寸模式

`MolView` 走 smiles-drawer 画 SVG，尺寸有**两种**模式，选错就是「图被裁掉」或「塌成 0」：

| 模式 | 用法 | 适用容器 |
| --- | --- | --- |
| 定像素（默认） | `:bond-px :min-px :maxPx` 算出明确 px 写回 SVG | **auto 尺寸**容器（候选卡、路线行、预览弹窗）—— 容器跟着图长 |
| `fit` | 宽高 100% + `viewBox` 等比缩放 | **定尺寸**容器（`.step-row__mol` 104×64、`.target__mol` 150×120、`.history-item__mol` 120×88） |

🔴 定尺寸容器都是 `overflow: hidden`，不开 `fit` 大分子会被切掉一半；
反过来，auto 高度的容器开 `fit` 会让 SVG 塌成 0 高 —— **两种模式不能互换**。

---

## 六、大模型工艺分析（可选）

在**逆合成路线**之上再加一层「这条路真做起来会怎样」的判断：每一步的投料顺序、当量、
反应结果与预期收率、可能副产物、LCMS / NMR 预测、安全提示。

### 6.1 配置（`F:\retrochimera\web\.env`）

后端只认环境变量，**默认不填 = 功能自动降级**（前端显示「未配置」，按钮给出人话提示，不会报错）：

```ini
RETRO_LLM_BASE_URL=https://token.sensenova.cn/v1   # 填到 /v1 即可，也接受完整的 /chat/completions
RETRO_LLM_API_KEY=sk-xxxxxxxx          # ← 填这里；留空即视为未配置
RETRO_LLM_MODEL=glm-5.2                # 1M 上下文 / 最大输出 131072 / 支持 json_mode + reasoning
RETRO_LLM_MAX_TOKENS=16384             # 🔴 别省：推理模型的思考 token 也算在这个额度里
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

**三条实测踩过的坑**（`detail` 记在 `.env` 注释里）：

| 坑 | 症状 | 处置 |
| --- | --- | --- |
| `/v1/models` 会骗人 | 列出 9 个模型，其中 3 个一调就 `model is not available in the current token plan` / `model is not found` | **以 `probe` 为准**，不以列表为准 |
| 限流**按模型端点**算 | 把某端点打到 `429 RateLimitExceeded.EndpointTPMExceeded` 后，连 `"hi"` 都发不出去，**同一时刻换个模型完全正常** | 换模型（本项目用 `glm-5.2`；换模型 = 换一条独立配额）|
| `max_tokens` 不给就踩截断 | 推理模型的**思考 token 也计入输出额度** ⇒ 给太小则正文一个字没出就 `finish_reason=length`，JSON 抽不出来 | 显式下发 `RETRO_LLM_MAX_TOKENS`；后端检测到 `length` 且抽不出 JSON 时**直接报「输出被截断」**，而不是含混的「解析失败」 |

### 6.2 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/llm/status` | 是否配置（**永不返回 api_key**，只回 `has_key` 布尔）。`?probe=1` 附加真实验证结果 |
| GET | `/api/llm/models` | 列出该 key 可见的模型 id（**仅列出，不代表套餐内可用**） |
| POST | `/api/llm/analyze` | 一次性返回完整 JSON |
| POST | `/api/llm/analyze/stream` | **SSE 流式**（见下） |

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

⚠️ 推理模型的时间分布很悬殊 —— 实测阿司匹林一步，两种模型对比：

| 模型 | meta | 首个 thinking | 思考结束 | done | 思考体量 |
| --- | --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | 0.7s | 2.6s | 27.8s | 40.3s | 1984 事件 / 3139 字 |
| `glm-5.2` | 0.01s | 6.2s | 55.5s | 57.8s | 427 事件 / 4646 字 |

**前 30~55 秒正文一个字都没有**，这就是为什么 `thinking` 事件不能省。
（`glm-5.2` 的思考更啰嗦、更慢，但化学内容更细，`confidence` 0.95、副产物与 LCMS 注释更具体。）

SSE 经 **Vite dev proxy 是真流式透传**（实测首字节 6.2s → `done` 57.8s，中间 51.6s 里事件陆续到达），
不需要为 dev 做额外配置。

### 6.3 前端表现（StepAnalysis.vue）

投料顺序表（序号 / 方式 / 试剂 / 当量 / 备注）· 条件描述列表（溶剂 / 温度 / 时间 / 气氛 / 催化剂 / 后处理）·
反应结果（预期 / 收率区间 / 纯度 / 风险）· 副产物表（名称 / 来源 / m/z / 控制手段）·
LCMS（**理论值来自 RDKit，注释来自模型**）· NMR（¹H / ¹³C 描述）· 安全提示 · 置信度。
流式过程中逐字上屏，可随时**取消**（`AbortController`）。

🔴 **推理模型必须显示「思考」**：`glm-5.2` / `deepseek-v4-pro` / `kimi-k3` 这类模型开头十几到几十秒（实测 `glm-5.2` 达 55 秒）
**只吐 `reasoning_content`，`delta.content` 一直是空字符串**。只读正文的话，界面在整个思考阶段
一个字都不动，看着像卡死，用户会以为服务挂了然后去点取消。所以思考单独走 `thinking` 事件、
存在 `analysis.reasoning`（与 `raw` 分开，避免污染 JSON 抽取），流式中实时显示、结束后折叠可回看。

### 6.4 几条实现约束（改之前先看）

- **SSE 走 POST + `fetch` + `ReadableStream`，不是 `EventSource`** —— 因为要带请求体。
- `reasoning_content` **不能混进 `raw`**，否则 `extract_json` 会先撞上思考文本（里面常有花括号示例）。
- 模型常把 JSON 包在 ` ```json ` 围栏里或前后带废话 ⇒ 用**花括号配平扫描器**（正确处理字符串与转义），
  正则一刀切会在遇到字符串里的 `}` 时截断。
- 分析结果**随节点存 localStorage**，原始输出截断到 2000 字符；仍超配额时自动丢弃全部 `raw` 保会话不丢。
- 路线上下文（上游产物 / 下游前体）会拼进 prompt，让模型知道这一步在整条路线里的位置。
- `.env` 热重载靠 **mtime + 基线重放**：先把 `os.environ` 里由文件注入的 `RETRO_*` 复位到
  「首次加载前的真实环境变量快照」，再重放文件 ⇒ 从文件里**删掉**的行才会真正失效。
  只用 `setdefault` 是不够的：空值会占住 key，导致后续填值永不生效（这正是修复前的 bug）。

---

## 七、已知约束

- 首次预测要加载模型 + 起规则子进程，**可达数十秒甚至数分钟**（实测 pistachio 首帧 >13 分钟仍未返回）
  ⇒ 前端超时 10 分钟、可取消、提供「预热」按钮；**正式用之前一定先点预热**。
- 前体若含通配原子 `*`（R 基团）或芳香环 kekulize 失败，Flask 会返回 **HTTP 400 + 结构化诊断**，
  该行标「失败」并列出人话原因（`reasons`）—— 这不是前端 bug，是模型给出的结构本身不可预测。
- Flask 默认**不开 CORS**：dev 走 vite proxy（`/retro/*` → `8000/api/*`）同源，无需配置；
  生产前后端不同域时，**必须**在后端设 `RETRO_CORS_ORIGINS`（见后端 README 第 6 节），
  否则页面数据永远转圈。生产也建议在前面挂一层网关顺带鉴权。
- 规则子进程内存占用大 ⇒ 自动拆分是**串行**的，并发默认 1。
- 历史任务存 localStorage（未接后端表）。
- 画板只画**单分子**（逆合成目标场景）；反应箭头、多组分同板编辑不做，走 SMILES 输入（支持 `>` 反应式）。
- **AI 工艺分析结果是模型推测**，未经实验验证；LCMS/NMR 理论值虽由 RDKit 计算，但结构本身正确与否
  取决于上游逆合成预测 —— 全链路都需人工复核。
