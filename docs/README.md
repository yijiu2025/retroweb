# retroweb 项目文档

本目录放**本项目自己的文档**。**写文档前先读本文决定放哪；找文档也从本文进。**

通用规范（适合所有项目）的 master 在 CoreFlow 仓库 `docs/standards/`，文档规范见
<https://github.com/yijiu2025/CoreFlow/blob/main/docs/standards/>（入口 `docs/README.md`
「文档地图」）。本仓是独立仓库，需自包含的规范持本地副本。

## 项目文档（只适用于本项目）

| 文档 | 内容 |
| --- | --- |
| [plan-node-backend.md](./plan-node-backend.md) | 接入 Node 中转后端 · 数据与用户绑定**实施规划**：结论 = 复用根项目 Fastify 中转而非新建后端，含取舍与阶段 |
| [feedback-learning.md](./feedback-learning.md) | 点板/过柱极性预测与「预测 vs 实测」错误反馈学习机制设计（把实验偏差沉淀成可训练数据） |
| [how-to-read-diff.md](./how-to-read-diff.md) | 怎么看提交记录与文件变动（GitHub 网页 + 命令行两条路，面向不熟悉 git 的协作者） |
| [healthcheck-2026-10-09.md](./healthcheck-2026-10-09.md) | 2026-10-09 体检报告（前端 + retrochimera 后端四关结果，历史快照不再维护） |

## 约定

- 命名：小写连字符（`how-to-read-diff.md`），不用下划线和全大写；一次性报告可带日期后缀
- 新文档**先在本表登记再提交**——本表是仓内文档的唯一索引，漏登记 = 文档不可发现
- 站内互链用相对路径；跨仓引用 CoreFlow 用完整 GitHub URL（本仓独立，外部用户没有根仓上下文）
- 只服务某个模块的文档与代码共置（`src/<模块>/`），刻意不集中到本目录
- 一次性 / 已过期的报告标注「不再维护」，勿删——查证价值

## 其他项目的文档在哪

CoreFlow 总文档站（含全部通用规范）：<https://github.com/yijiu2025/CoreFlow/tree/main/docs>，
入口是 `docs/README.md`（文档地图）。
