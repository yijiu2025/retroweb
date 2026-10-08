# 点板/过柱极性预测 与 错误反馈学习机制

> 本文档说明 RetroWeb 逆合成工作台的两项增强：
> 1. AI 工艺分析新增「点板 / 过柱极性预测」模块；
> 2. 一套「预测 vs 实测」错误反馈学习机制 —— 把用户实验后发现的偏差沉淀成可训练数据。
>
> 最后更新：2026-10-08

---

## 一、点板 / 过柱极性预测

### 1.1 设计目标

给「这一步反应」额外产出一份**可照着做**的分离纯化指引：

- **点板（TLC）**：产物在硅胶板上的估算 Rf 范围、展开剂、点板判据；
- **过柱（柱层析）**：洗脱剂系统与梯度、极性排序、拖尾/吸附等注意点。

### 1.2 核心原则：确定性数值与经验解读分离

这是本项目一贯的「两条数据线」原则在极性预测上的落地：

| 数据线 | 内容 | 谁来算 | 可靠性 |
| ------ | ---- | ------ | ------ |
| **确定性数值** | logP、TPSA、氢键供体（HBD）、氢键受体（HBA）、可旋转键数、芳环数 | 后端 **RDKit** | 可复现、可核对 |
| **经验解读** | Rf 范围、洗脱剂梯度、极性排序、点板判据、过柱注意 | **大模型** | 经验估计，给范围而非精确值 |

- **为什么 RDKit 只算数值、不直接估 Rf**：Rf 与洗脱剂是强经验量，受硅胶批次、展开剂、湿度、温度影响大，RDKit 没有可靠的定量模型；但它能算出 logP / TPSA / 氢键供受体这些**极性刻画量**，正是估计 Rf 和选洗脱剂的关键输入。
- **为什么不让模型自己编数值**：大模型倾向于「编一个像样的数」。把 logP 等喂给它、要求它**直接引用**，等于给它一个可信锚点，把它的输出约束在「解读」而非「造数」。

### 1.3 数据流

```
一步反应（产物 + 前体）
   │
   ├─ 后端 RDKit：算产物/前体的 logP / TPSA / HBD / HBA / 可旋转键 / 芳环
   │        ↓ 写进 prompt 的「已知的确定性数据」段
   ├─ 大模型：引用这些数值，输出 tlc 结构化字段
   │        ↓
   └─ 前端 StepAnalysis 渲染：
        ┌─「点板 / 过柱极性预测」区块
        ├─ 极性数值表（RDKit 算的，标「由 RDKit 计算」）
        └─ 5 行解读：估算 Rf / 洗脱剂 / 极性排序 / 点板判据 / 过柱注意
```

### 1.4 结构化字段（`tlc`）

```json
{
  "tlc": {
    "rf_est": "0.35~0.50（PE:EA=2:1）",
    "eluent": "先用 PE 冲掉低极性杂质，再用 PE:EA=5:1→2:1 梯度洗脱",
    "polarity_order": "产物（酚羟基+酰胺）> 乙酸 > 低极性副产物",
    "spotting": "UV 254 nm 可见产物点；产物与乙酸前体点距离 > 0.2",
    "note": "产物含酚羟基易拖尾，展开剂可加 0.5% 乙酸改善"
  }
}
```

### 1.5 实现位置

- **后端** `web/llm.py`
  - `_one_mass()`：RDKit 增算 `logp / tpsa / hbd / hba / rotatable / aromatic_rings`；
  - `_fmt_mass_row()`：把这些数值追加进 prompt 的确定性数据行；
  - `_SYSTEM`：JSON 骨架新增 `tlc` 字段说明；
  - `_MODULE_FIELDS`：新增 `"tlc"` 模块（与前端 key 对齐）。
- **前端** `retroweb`
  - `src/types/retro.ts`：`StepTlc` 接口、`MassRow` 增极性字段、`AnalysisModuleKey` 加 `'tlc'`；
  - `src/stores/workspace.ts`：`ALL_ANALYSIS_MODULES` + `ANALYSIS_MODULE_LABELS` 加 `tlc`；
  - `src/components/workspace/StepAnalysis.vue`：渲染「点板 / 过柱极性预测」区块。

---

## 二、错误反馈学习机制

### 2.1 动机

大模型的工艺分析（收率、条件、点板、LCMS…）是**经验估计**，跟实测有偏差很正常。
但偏差信息目前是「用过即丢」——用户发现预测不准，顶多在追问里抱怨一句，没有沉淀。

这套机制的思路：**把「预测值 ↔ 实测值」成对记录下来**，累积成有标注的数据集，用于后续
**微调 / 蒸馏 / 偏好对齐（RLHF）**，让模型在同一类反应上越用越准。

### 2.2 交互流程

```
1. 用户在 StepAnalysis 里看某一步的 AI 分析（含点板/收率/条件等预测）
2. 用户做完实验，发现预测与实际偏差较大
3. 点「反馈实测结果」→ 选反馈类型（点板/收率/条件/其他）
4. 系统预填「预测值」（从已生成的分析里取），用户填「实测结果」+ 可选「差异说明」
5. 提交 → 后端落盘 feedback.jsonl（一条 JSON）
```

### 2.3 数据落盘

- **位置**：`web/data/feedback.jsonl`（JSON Lines，每行一条，便于逐条喂训练流水线）
- **写入口**：`POST /api/feedback`（不依赖大模型模块，llm 未配置也能记录）
- **读出口**：`GET /api/feedback?limit=200`（供前端导出/查看）

### 2.4 字段 Schema

一条反馈一行，字段全部可选（但 `predicted` / `observed` 至少要有一个才有训练价值，否则拒绝写入）：

```json
{
  "kind": "tlc",
  "module": "tlc",
  "target": "CC(=O)Oc1ccccc1C(=O)O",
  "product": "CC(=O)Nc1ccc(O)cc1",
  "precursors": ["CC(=O)O"],
  "reaction_id": "r1",
  "model": "deepseek-v4-pro",
  "predicted": "Rf 0.35~0.50（PE:EA=2:1）",
  "observed": "实际 PE:EA=2:1 时产物 Rf ≈ 0.15，比预测低很多，且拖尾",
  "delta_note": "预测 Rf 偏高，实测明显拖尾，可能因酚羟基未加酸改性",
  "at": "2026-10-08T09:00:00+0800"
}
```

| 字段 | 类型 | 说明 |
| ---- | ---- | ---- |
| `kind` | string | 反馈类型：`tlc` / `yield` / `condition` / `other` |
| `module` | string | 对应分析模块：`tlc` / `outcome` / `conditions` … |
| `target` | string | 整条路线目标分子 SMILES（可选） |
| `product` | string | 这一步产物 SMILES |
| `precursors` | string[] | 前体 SMILES |
| `reaction_id` | string | 前端确定性 reactionId（`reactionIdFor(nodeId, precursors)`） |
| `model` | string | 预测用的模型名 |
| `predicted` | string | 预测内容（Rf 范围 / 洗脱剂 / 收率…） |
| `observed` | string | 实测结果（用户实验后填的） |
| `delta_note` | string | 差异描述：差了多少、可能因为什么 |
| `at` | string | 落盘时间戳（后端补） |

### 2.5 后端清洗策略

`_sanitize_feedback()` 做**白名单 + 截断**，避免任意字段注入污染训练集：

- 只接受上表列出的字段（`at` 由后端生成）；
- 每个字段截断到上限（`predicted` / `observed` / `delta_note` 上限 4096 字符）；
- `precursors` 归一化为字符串列表；
- 至少要有 `predicted` 或 `observed` 之一，否则 400。

### 2.6 训练用途（后续）

沉淀下来的 `feedback.jsonl` 是一份**「反应上下文 + 预测 + 实测」三元组**数据集，可用于：

1. **偏好对齐 / RLHF**：把「预测」当 base 输出，「实测 + 差异说明」当偏好信号，训练模型少犯同类偏差；
2. **监督微调（SFT）**：以 `product + precursors + 反应上下文` 为输入、`observed` 为输出，直接学「实测值」的分布；
3. **偏差分析**：按 `module` / `reaction_type` 聚合，找出模型系统性高估/低估的场景（如「含酚羟基的产物 Rf 系统性偏高」），针对性补数据。

> ⚠️ 数据量达到一定规模前，不建议直接上训练——先把数据攒起来、定期人工清洗
> （去掉明显误填/重复/非通用性个例），再决定训练方案。

---

## 三、维护约定

- **模块 key 前后端对齐**：新增分析模块必须同时改两处，且顺序一致 ——
  前端 `ALL_ANALYSIS_MODULES`（`src/stores/workspace.ts`）↔ 后端 `_MODULE_FIELDS`（`web/llm.py`）。
  `summary` 是每次分析的兜底字段，不进前端可勾选列表。
- **反馈字段改动**：加字段要同步改 `_FEEDBACK_FIELDS`（后端白名单）+ `FeedbackEntry`（前端类型）
  + `_sanitize_feedback()` 的截断上限。
- **反馈数据是纯记录**，不触发新的模型调用、不影响已生成的分析——「反馈」与「分析」解耦。
