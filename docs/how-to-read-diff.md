# 怎么看提交记录与文件变动

> 本文回答两个问题：**提交记录在哪看**、**某个文件改了哪几行怎么查**。
> 网页和命令行两条路都给，按习惯挑一条即可。

仓库地址：<https://github.com/yijiu2025/retroweb>

---

## 一、在 GitHub 网页上看

### ① 提交列表（谁在什么时候改了什么）

<https://github.com/yijiu2025/retroweb/commits/main>

每条都有**提交标题 + 完整说明 + 短 SHA + 时间**。说明里带 🔴 标记的是"这里踩过坑、别再改错"的地方。

### ② 单个提交：看这个提交动了哪些文件、哪几行

点任意一条提交的标题（或短 SHA），例如：

<https://github.com/yijiu2025/retroweb/commit/0978ee8>

页面结构：

| 位置 | 内容 |
| --- | --- |
| 顶部 | 完整提交说明（就是你在 `git log` 看到的那段） |
| 右上角 | `6 files changed` + `+111 −4`，点它可以展开/折叠全部 diff |
| **左侧** | 文件树，点文件名切换；顶部有 "Filter files" 可按文件名过滤 |
| **右侧** | **逐行 diff**：绿色 = 新增、红色 = 删除，行号在两侧 |

### ③ 两个版本之间的完整对比（最常用）

<https://github.com/yijiu2025/retroweb/compare/v1.0.0...v1.0.1>

URL 格式：`/compare/<旧版本>...<新版本>`，想比哪两版就替换两端。

页面顶部直接给出总量：`88 files changed` / `9,579 additions` / `3,327 deletions`，
往下就是按文件排开的逐行 diff。右上角 `Split` / `Unified` 可切换左右分栏或单栏视图。

**这个页面就是"v1.0.0 到 v1.0.1 到底改了什么"的权威答案。**

### ④ 某个文件的完整历史

在仓库里打开任一文件 → 点右上角 **History** → 列出该文件的所有提交；
再点某次提交，就只显示**这一个文件**在那次改了什么。

命令行等价：`git log -p -- src/config/about.ts`

---

## 二、在本地命令行看（更快、更可控）

### ① 看某次提交改了哪些文件、各改了多少

```bash
git show --stat 0978ee8
```

输出形如 `6 files changed, 111 insertions(+), 4 deletions(-)`，后跟每个文件的增删行数。

### ② 看某个文件在两个版本之间改了哪几行

```bash
git diff v1.0.0 v1.0.1 -- src/config/about.ts
```

- `--stat` 版本：只统计每个文件改了多少行
- 不加 `--stat`：完整逐行 diff

### ③ 看某次提交的完整 diff

```bash
git show 0978ee8              # 全部文件
git show 0978ee8 -- src/api/  # 只看 src/api/ 下的
```

### ④ 按内容搜索改动（查"谁把这段改了"）

```bash
git log -S "runSettingsOpen" --oneline      # 谁增删过这个字符串
git log -p -S "runSettingsOpen" -- src/     # 连同逐行 diff
```

### ⑤ 找出"哪些改动还没提交"

```bash
git status --short          # 哪些文件改了
git diff                    # 未暂存的逐行改动
git diff --staged           # 已 add 未 commit 的
```

### ⑥ 交互式浏览（最推荐日常用）

```bash
git log -p                  # 按时间倒序，逐个提交看 diff
git log --oneline --graph --all
```

---

## 三、几个实用提示

**看行号的两种方式**：GitHub 左侧有 "Display unified diff" 开关；命令行加 `--unified=0`
只显示改动行、不带上下文，更清爽：

```bash
git diff --unified=0 v1.0.0 v1.0.1 -- src/config/about.ts
```

**只看某几类改动**（比如只关心代码、不关心文档）：

```bash
git diff --stat v1.0.0 v1.0.1 -- 'src/**/*.ts'
```

**导出一份完整变更清单**（比如写 release 说明时用）：

```bash
git log --oneline v1.0.0..v1.0.1
git diff --shortstat v1.0.0 v1.0.1
```

**推送后如何确认远端真的收到了**（不信本地、不信退出码）：

```bash
git ls-remote origin main                       # 远端 main 的真实 SHA
git ls-remote --tags origin | grep -v '\^{}'    # 远端 tag
```

`git ls-remote` 的输出与本地 `git rev-parse HEAD` 一致，才说明推送成功。

---

## 四、相关：Release 与 Tag 的区别

这两个常被混淆：

| | 是什么 | 本仓库现状 |
| --- | --- | --- |
| **Tag**（`v1.0.1`） | 给某个 commit 打的版本标记，GitHub 上显示为紫色标签 | ✅ 已有，`v1.0.0`、`v1.0.1` |
| **Release** | 一个独立的页面，可放变更日志、产物下载、讨论区 | 见 Releases 页 |

创建 Release（网页）：<https://github.com/yijiu2025/retroweb/releases/new>
—— 选 tag、写标题、把变更日志粘进描述框即可。
