# `src/api/` 结构说明

> 读完这一页，你就知道"某个请求该改哪个文件"。

## 三层分工

| 层 | 目录 | 判据 | 不许出现什么 |
|---|---|---|---|
| **传输层** | `http/`、`retro/client.ts` | 只认"有没有收到响应" | **业务字段名**（`model`、`delta`、`profiles`… 一律不许） |
| **业务层** | `auth.ts`、`retro/compute.ts`、`retro/llm.ts` | 一个业务域一个文件 | 实例创建、baseURL 判断、错误体归一 |
| **能力层** | `capability/`、`session/install.ts` | 跨档位 / 跨模块的**决策** | 具体端点、具体字段 |

依赖方向**单向向下**：`业务层 → 传输层`，`能力层 → 两者`。传输层**绝不** import 上层。

## 目录

```
api/
├── http/                 传输层：平台（Node 3000）
│   ├── client.ts         axios 实例 · 信封 {code,message,data} 拆包
│   ├── session.ts        401 唯一语义：单飞续期 / 登录流 / 哨兵
│   ├── sse.ts            SSE 分帧（fetch + ReadableStream）
│   └── index.ts          统一出口
├── retro/                算法服务（Python 8000 或 Node 中转）
│   ├── client.ts         三个实例 · 档位 baseURL · 错误归一 fail()
│   ├── compute.ts        计算类端点：模型状态/加载/解析/任务/预测/反馈
│   ├── llm.ts            分析类端点：端点配置/模型清单/工艺分析/追问
│   └── index.ts          统一出口
├── capability/           能力层：跨档位的唯一决策点
│   ├── endpoint-config.ts  端点配置：Python「整包」⇄ Node「逐条」形状翻译
│   └── node-llm.ts         Node 侧 LLM 端点（profiles / official）
├── session/install.ts    把 401 回调接到 auth store（入口只调这个）
└── auth.ts               账号 / 会话 / 权限
```

## 两条最容易踩的规则

### ① 两套后端，路径不能混用

| 档位 | baseURL | 端点配置接口 | 落点 |
|---|---|---|---|
| 直连 Python | `/retro`（vite 代理改写） | `/llm/settings`（**整包提交**） | `web/llm_settings.json`（**全局、不绑用户**） |
| 走 Node 中转 | `{API}/retroweb/v1` | `/llm/profiles`（**逐条 upsert**） | `retroweb_llm_profile` 表（**per-user、密钥加密**） |

Node 的前缀是**拼出来的**：`src/api/retroweb/system.json` 的 `prefix` + 组前缀，
由根仓 `framework/api/guard.js` 的 `joinUrl` 拼成 —— 不是 Python 的 `/api`。

⇒ 跨档位切换**只在 `capability/endpoint-config.ts` 里发生**。UI 不要自己判档位。

### ② 密钥往返不在前端解决

前端拿到的永远是掩码（`****ab3f`）。面板的约定是「`api_keys` 元素含 `*` = 保留那把原 key」，
但**前端没有明文、也无法凭空造出明文** ⇒ 原样回传即可，
由后端 `llm-profile.dao.js` 的 `mergeKeys` 用旧明文把掩码换回去。

🔴 `keys: []` 是**显式清空**，`undefined` 才是"不动旧 key"。传错会清空用户的密钥。

## 注释规范

结构（文件头 / 目录分层 / 为什么这么写）由各文件自己讲；**输入输出由 JSDoc 标签讲**，两者缺一不可。

### 每个导出函数必须有 `@param` 与 `@returns`

```ts
/**
 * 一句话说清"这个函数干什么 + 为什么这么写"（🔴 标出踩过的坑）。
 *
 * @param req 分析请求（产物结构、前体、路线上下文）
 * @returns 完整分析结果；**失败走 `handlers.onError`，不 reject**
 * @throws 网络错误时抛 `RetroApiError`
 */
```

写什么、不写什么：

| 项 | 要写 | 不要写 |
|---|---|---|
| `@param` | **语义 + 取值范围 + 可选性**：`ts 目标时间戳（毫秒）`、`manual 是否为手动步（显示「手动」不显示百分比）` | 把类型抄一遍（`ts: number`）—— 类型就在签名里 |
| `@returns` | **失败时发生什么**：`连不上时 resolve 空列表，不抛` / `id 不存在不是异常，原样回传当前列表` | 只写"返回值"三个字 |
| `@throws` | 抛什么 + 调用方该怎么处置 | 不抛就别写 |

### 三条本项目特有的口径

1. **`@returns` 必须交代失败路径**。本层大量方法是「**失败也 resolve**」（`llmApi.settings()` 返回形状完整的空设置、
   `nodeLlmApi.profiles()` 返回 `[]`）—— 这与"抛异常"同等重要，不写清楚调用方就会去 catch 一个永远不会发生的错。
2. **凡可能撞 401 的方法，`@returns` 要提一句哨兵**：`401 会抛带哨兵的 Error，用 isUnauthorizedError(e) 让位`。
3. **无参函数不写 `@param`**。写了是噪音。

### 文件头

`@author` / `@since` **只在文件头标一次**，函数级不加（归属以 `git blame` 为准）。

## 新增一个端点该改哪里

1. 找业务域文件（`compute.ts` / `llm.ts` / `auth.ts`），加一个方法；
2. 只写「打哪个端点、传什么、返回什么」，**并按上面的口径写全 `@param` / `@returns` / `@throws`**；
3. baseURL / 拦截器 / 错误归一**已经在 `./client` 里**，不要重复实现；
4. 类型去 `types/retro.ts` 加，**在文件末尾的导出块里补上**（本仓约定：定义处不写 `export`）。

自查：`node .tmp-probe/audit-jsdoc.cjs`（导出函数的 `@param`/`@returns` 缺口 + 文件头缺口）。
当前基线：**62 个导出函数，缺口 0**。

## 命名约定

一律 `xxxApi` 收尾：`authApi` / `retroApi` / `llmApi` / `nodeLlmApi` / `endpointConfigApi`。
`retroApi` 里的「计算类」与 `llmApi` 里的「分析类」是**并列**关系，不是一大一小。
