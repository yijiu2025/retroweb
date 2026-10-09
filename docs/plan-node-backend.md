# retroweb 接入 Node 中转后端 · 数据与用户绑定（规划）

> 目标：把"任务 / 路线树 / 方案 / 端点配置"从浏览器 localStorage 搬到服务端，
> 与登录用户绑定，并让前端不再直连 Python 算法服务。
> 本文是**实施规划**（含取舍与阶段），不是最终设计稿；文中 ✅=已核实的事实，❓=待拍板。

---

## 0. 一句话结论

**不用新建后端。** `nodeServers` 根项目就是那层 Node 中转（Fastify 3000 + Sequelize 6 +
MySQL2 + Redis 5，已有账号 / 会话 / 权限 / 审计 / 迁移体系），retroweb 目前只用它做了
登录（`/auth/v1/*`）。要做的三件事：

1. 在它上面**新增一个 `retroweb` 业务模块**（建目录即可，框架自动扫描）；
2. 前端把"数据落哪儿"收拢成一个适配层，从 localStorage 切到 API；
3. 算法调用改走 Node 中转（Node 持有 job 与结果，Python 退成无状态计算）。

---

## 1. 现状盘点（已核实）

### 1.1 数据现在全在浏览器里 ✅

| localStorage 键 | 内容 | 位置 |
| --- | --- | --- |
| `retroweb_sessions` | **任务**（目标分子 + 整棵路线树 + 未跑完的 job_id），上限 10 条 | `stores/workspace.ts` |
| `retroweb_history` | 手动保存的快照，上限 30 条 | 同上 |
| `retroweb_cond_pref` | 候选条件枚举的偏好 | 同上 |
| `retroweb_saved_accounts` | 多账号免切清单 | `stores/auth.ts` |
| `retroweb_settings_*` / 供应商偏好 / 设备 id / PubChem 缓存 | UI 偏好类 | `stores/settings.ts`、`utils/device.ts`、`utils/pubchem.ts` |

后果（都是已存在的问题）：换浏览器 / 清缓存 = 任务全丢；多端不同步；localStorage 配额
撑爆时 `writeSessions` 只能"瘦身重试"（丢 AI 原文）；**数据与用户无关，任何能开这台浏览器
的人都能看到**。

### 1.2 后端 A：nodeServers（Node，已存在）✅

- 技术栈：`fastify ^5.8` · `sequelize ^6.37` · `mysql2 ^3.22` · `redis ^5.12`
- 启动链路（`framework/loader/registry/`）：`00-globals → 01-monitor → 02-redis → 03-db →
  04-auth → 05-firewall → 06-models → 07-keys → 08-api → 09-notice → 10-apps`
- **模型自动扫描**：`src/models/<命名空间>/Xxx.js`，按子目录建命名空间 ⇒ 挂到
  `app.db.<namespace>.<Model>`（新增 `src/models/retroweb/` 即可）
- **路由自动扫描**：`src/api/<app>/v1/*.js` 递归加载，目录根放 `system.json` 声明应用元信息
- 鉴权写法（照抄 posecraft 即可）：
  `registerSecureRoute(fastify, { requireLogin: true, permission: 'retroweb:task:use', ... })`，
  handler 里 `request.state.user.userId`
- 分层惯例：`api/<app>/v1/*.js`（路由，只做参数与应答）→ `app/<app>/dao/*.dao.js`（数据访问）
  → `models/<app>/*.js`（表定义）；迁移放 `migrations/<app>/<时间戳>-*.js`
- 已有 `framework/keys`（密钥管理）与 `audit-logger`（审计）

### 1.3 后端 B：retrochimera（Python，纯算法）✅

- Flask 8000 + 独立常驻模型服务进程 8001；**无用户概念、无持久化**
- 异步任务存在**进程内 dict**（`web/jobhub.py: _jobs`，上限 200 条，**重启即失**）
- LLM 端点配置在 `web/llm_settings.json`（**服务端全局一份，不分用户**）
- 前端现在直连它（`VITE_RETRO_URL`，dev 经 vite proxy，生产 `https://retro.example.com/api`）

---

## 2. 目标架构

```
浏览器 ──► Node 中转（nodeServers :3000）
           ├─ 鉴权（已有 sid cookie / sid_r 续期）
           ├─ 业务 API  /retroweb/v1/tasks|schemes|settings|llm-profiles|jobs
           ├─ 算法中转  /retroweb/v1/parse|depict|analyze|conditions|followup|models
           │            （同步转发；SSE 流式透传；异步 job 落库）
           └─ MySQL（任务/方案/设置/密钥）+ Redis（job 进度、会话缓存）
                        │
                        └─► Python retrochimera（内网，不对外）
```

职责边界（**必须写死，否则以后会互相渗透**）：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Python | 算：解析、预测、搜索、结构图、LLM 流式 | 不认识用户、不存数据、不管配额 |
| Node | 存：任务树、方案、设置、密钥（加密）、job 与结果；鉴权、配额、审计 | 不做化学计算、不解析 SMILES |
| 前端 | 展示与交互；本地只留**缓存** | 不再持有权威数据 |

---

## 3. 数据模型（草案）

表名统一 `retroweb_*`，`underscored: true`，时间戳由 Sequelize 管。

### 3.1 `retroweb_task`（任务 = 一个目标分子的整棵路线树）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | BIGINT PK | |
| user_id | BIGINT | 索引 `(user_id, updated_at)` |
| name / target / model | VARCHAR / TEXT / VARCHAR | 列表页直接显示 |
| status | ENUM running/incomplete/done | 与前端 `SessionStatus` 同枚举 |
| node_count / step_count / depth / scheme_count | INT | 🔴 **冗余列**：列表/筛选/排序不解析 JSON |
| sig | VARCHAR(64) | 内容签名（前端已有 `sessionSignature`），用于乐观锁与"是否真变了" |
| snapshot | MEDIUMBLOB | 整棵树 JSON（**gzip 后存**，见 §6.2） |
| size_bytes | INT | 配额统计 |
| deleted_at | DATETIME | 软删，误删可恢复 |

### 3.2 `retroweb_scheme`（路线方案）

`id, user_id, task_id, name, route_json, stats_json, created_at, updated_at`
—— 独立于 snapshot，因为"方案对比 / 横向选优"要按任务查方案列表，翻 JSON 太贵。

### 3.3 `retroweb_job`（算法任务，🔴 关键）

`id, user_id, task_id, kind(predict/search/analyze/conditions/followup),
provider_job_id（Python 侧的 job id）, status(queued/running/done/failed/**stale**),
params_json, progress_json, result_json, error_text, created_at, finished_at`

`stale` 这个状态是专门为 Python 的"job 存内存、重启即失"设计的（见 §6.4）。

### 3.4 `retroweb_user_settings` / `retroweb_llm_profile`

- 设置表：UI 偏好（主题、供应商偏好、面板折叠态）—— 1:1 用户
- 端点配置表：`id, user_id, name, base_url, model, keys_enc, active, max_tokens...`
  🔴 **keys 必须加密存储**（复用 `framework/keys`），**回前端一律走掩码**
  （前端已有 `mask_key` 保尾部的口径）。现在是全站共用一份 `llm_settings.json`，
  绑定用户后必须拆成 per-user，否则 A 用户能花 B 用户的 token。

### 3.5 配额（已定，用户拍板）

| 用户类型 | 任务数上限 |
| --- | --- |
| 普通用户 | **2 个** |
| 会员用户 | **50 个** |

- 判据走 **PBAC 权限点**（框架已有 `utils/PbacRegistry.js`；posecraft 的 VIP 权益
  `posecraft:vip:*` 就是同一套做法）：定义权限 **`retroweb:quota:member`**，命中即 50，
  否则 2；再由角色 `retroweb_member` 把该权限打包进去。
  🔴 判定用**权限**而不是角色码字符串 —— 权限可单独授予、可在管理后台勾选，角色只是打包；
  写死角色码会让"给某个用户单独加配额"变成改代码。
  🔴 **不要**另建会员字段 / 会员表 —— 那会和 IAM 形成两套会员体系，对不上账。
- 校验位置：**只在"新建任务"入口做一次**（`/tasks` POST），不是每次写快照都查 ——
  快照更新不该因为配额被拒（否则用户改不动已有任务）。
- 超限返回 `reply.result.tooManyRequests('任务数已达上限（普通用户 2 个）…')`，
  文案里给出上限与当前用量，并提示"删除旧任务或升级会员"，**不要静默失败**。
- 🔴 软删（`deleted_at`）的任务**仍占配额**：否则"删了再建"可以无限绕过上限。真正释放
  走 S4 的回收任务（或管理员清理）。
- 字节配额暂不设（先只看条数），`size_bytes` 照记，将来要加时不用改表。

---

## 4. 接口契约（Node 侧新增，前缀 `/retroweb/v1`）

**数据类**

```
GET    /tasks                 列表：只回元数据（含 node_count/step_count/depth/updated_at）
POST   /tasks                 新建
GET    /tasks/:id             详情：含 snapshot（全量）
PATCH  /tasks/:id             改名 / 存快照 / 改状态（带 sig，冲突返 409）
DELETE /tasks/:id             软删
POST   /tasks/import          本地 localStorage 批量上传（迁移用，幂等）
GET    /tasks/:id/schemes     POST / PATCH / DELETE 同族
GET    /settings              PUT /settings
GET    /llm/profiles          PUT /llm/profiles（key 只回掩码）
```

**算法中转类**

```
POST   /parse                 同步转发（快）
POST   /depict                同步转发
GET    /models                POST /models/load · POST /forward/load · POST /model-service/:action
POST   /jobs                  提交（kind=predict/search）→ 返回 job_id
GET    /jobs/:id              状态 + 进度 + 结果（前端轮询这一个，不再问 Python）
DELETE /jobs/:id              取消（同时取消上游）
POST   /analyze               SSE 透传（conditions / followup 同）
```

前端侧对应改动：`VITE_RETRO_URL` 退役，全部走 `API_BASE_URL`；`api/retro.ts` 的 baseURL
换成 Node，路径前缀加 `/retroweb/v1`。

---

## 5. 分阶段落地（每阶段可独立上线、可回退）

| 阶段 | 做什么 | 验收关卡 |
| --- | --- | --- |
| **S0 抽象层** | 把 store 里散落的 localStorage 读写收拢成 `stores/persist/` 适配层（local / server 两种实现，用配置切）；Node 侧先建**空壳路由**（返回 501） | 行为零变化；四关（tsc/lint/test:store/build）全绿 |
| **S1 云端落地 + 迁移** | 建表 + 迁移；登录后把本地任务一次性 `/tasks/import`；双写（本地保留只读副本） | 迁移脚本对同一份数据跑两次不产生重复；断网时自动回退本地 |
| **S2 读路径切云端** | 任务列表 / 打开任务走 API；本地降级为**缓存**（不是权威） | 换浏览器能看到同样的任务；清缓存后重新拉取一致 |
| **S3 算法中转** | SSE 透传 + job 落库；Python 从公网下线 | 断连 / 上游 500 / Python 重启三种情形前端都有明确提示，不会无限转圈 |
| **S4 多端与治理** | 配额、软删回收、审计、并发冲突提示、导出/导入 | 两处编辑同一任务 → 后者收到 409 且能选"用我的 / 用服务端的" |

依赖顺序：**S0 → S1 → S2 → S3 → S4**，S3 最重（SSE + job），建议单独排期。

---

## 6. 六个必须提前定的决策（含已知陷阱）

### 6.1 🔴 用户隔离的最大坑：切账号时本地缓存没清

`stores/auth.ts` 支持**多账号免切**（`savedAccounts` + `switchAccount`）。数据绑定用户后：
切换账号 / 登出 / 401 过期 ⇒ **必须清空内存与本地缓存里的任务**，否则上一个用户的任务
会出现在新用户的工作台里（串号，且可能被写回去污染云端）。

落地：`authStore` 的 `setUser(null)` / `applyLogin` / `markExpired` 三处都挂钩子，
统一调 `workspaceStore.clearLocalData()`。

### 6.2 快照怎么存：整树 JSON + 压缩（推荐）vs 规范化分表

- **推荐整树 JSON（gzip 后 MEDIUMBLOB）**：与现在的 localStorage 快照结构 **1:1**，
  迁移成本最低，读写简单，前端几乎不用改数据结构。
- 规范化（node / reaction / analysis 分表）查询更灵活（"跨任务找用过某反应的步骤"、全局统计），
  但写入路径长、迁移要重写一遍序列化逻辑。
- 折中：**先整树 JSON，同时把列表/筛选要用的数字冗余成列**（§3.1 的 node_count 等），
  将来真需要跨任务检索时再加一张 `retroweb_route_edge` 的派生表，不动主链路。

### 6.3 SSE 透传（S3 最难的一环）

前端现在是 `fetch` + ReadableStream 直连 Python（`streamAnalyze` 等）。改由 Node 转发要处理：
① 上游超时（前端 axios 已给 600s，Node 侧要更长 + 心跳）；② 客户端断开 ⇒ 必须取消上游请求
（否则 Python 白算）；③ 背压（Reply.raw 写不动时要暂停上游）；④ **落库时机**：流式结束后
把完整结果写进 task snapshot / job.result —— 中途断连则只记 error，不写半截数据。

### 6.4 Python 的 job 是内存 dict（上限 200、重启即失）

所以 Node 必须有自己的 `retroweb_job` 记录，并且：
- 提交 → Node 先落库（queued）→ 调 Python 拿 `provider_job_id`
- 轮询 → Node 问 Python；**Python 返回 404 / 服务不可达时把 Node 侧标成 `stale`**
- 前端拿到 `stale` ⇒ 显示"服务重启导致结果丢失，请重跑"，而不是现在的"一直转圈"
  （现有 `resumeSessions` 刷新后恢复 job 轮询，正是踩这个坑）

### 6.5 LLM 密钥 per-user

现状 `web/llm_settings.json` 是**服务端全局一份**（谁都能用、谁改都影响别人）。
绑定用户后必须拆：加密列 + 掩码回传 + 只认激活套（前端已有 `mask_key` / key 轮换口径）。
⚠️ 前端"端点配置"面板现在容忍"后端无 profiles 字段"的老版本，改造时要同步。

### 6.6 并发与冲突

同一任务被两个端同时编辑 ⇒ 用现有 `sig` 做乐观锁，PATCH 带 `If-Match: <sig>`，
不匹配返 **409 + 服务端当前版本**，前端给"保留我的 / 用服务端的"两个按钮。
不要静默覆盖（静默覆盖在逆合成这种长任务里代价极高）。

---

## 7. 需要你拍板的问题

| # | 问题 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| Q1 | 中转范围 | ① Python 全部接口都由 Node 转发；② 只中转异步 job 与落库，parse/depict 等同步接口仍直连 | ① —— 否则 Python 仍要对外暴露、仍要自己做鉴权，且"数据绑定"少一半意义 |
| Q2 | 快照存储形态 | ① 整树 JSON + gzip（推荐）；② 规范化分表 | ① 起步，冗余列兜住列表查询 |
| Q3 | 离线可用 | ① 保留本地缓存，断网可只读；② 纯云端，断网即不可用 | ① —— 迁移期和非联网演示都需要，且成本很低（S1 已经是双写） |
| Q4 | 配额 | 每用户任务数 / 总字节 | ✅ **已定：普通 2 个 / 会员 50 个**（用角色 `retroweb_member` 判定，见 §3.5） |
| Q5 | 历史记录（`retroweb_history`） | ① 并入 task 用 `archived` 标志；② 独立表 | ① —— 两者结构几乎相同，分表要维护两份序列化 |

---

## 8. 粗估工作量

S0 2–3d · S1 3–4d · S2 3–5d · S3 4–6d（SSE + job 是重头）· S4 3–4d。
前后端各占一半；S3 需要 Python 侧配合（暴露 job 查询、允许取消）。
