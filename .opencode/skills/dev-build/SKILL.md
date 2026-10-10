---
name: dev-build
description: Use when the user wants to execute a plan document, or continue a plan that was interrupted or failed (e.g. overnight retried it). Triggers on "执行 plan", "跑 plan", "继续跑", "dev-build", "执行 docs/plans/xxx.md". Maintains a progress file so plans are safely repeatable.
---

# dev-build — 执行 plan + 维护进度文件

执行一个 plan 文档，并且**每步完成都写进度文件**，让 plan 在任何时候被打断/重跑都能
接着干，而不是从头再来或重复劳动。

## 工作流

### 1. 确定要执行的 plan

- 用户没指定 → 找 `docs/plans/` 里最新的一个。
- 用户说"继续上次的" → 找该 plan 对应的进度文件，从没完成的地方接着。

### 2. 读 plan，找/建进度文件

- 读 plan 文档：`docs/plans/NNN-name.md`
- 进度文件：`docs/progress/NNN-name.progress.md`（同一个名字，`.progress.md` 结尾）
- 不存在就新建，先初始化成「全 `[ ]`」骨架，把 plan 里每个稳定编号步骤列出来

进度文件格式：

```markdown
# Progress — <plan 标题>
plan status: in_progress      # in_progress / done

## 步骤
- [x] 1 现状检查
- [ ] 2 第一步
- [ ] 3 第二步

## 现场记录
- 已完成：第 1 步确认基线…
- 接着干：第 2 步做到一半，已改 config/env.ts…
```

### 3. 逐步骤执行

对每个步骤（从第一个 `[ ]` 开始）：

1. **跳过 `[x]`**：已经 done 的绝不重做。
2. **先确认现状**：`git status` / `git diff`（或 plan 开头指定的命令），判断这步到底能不能从当前状态继续。
3. **标 in-progress**：在进度文件的「现场记录」写下"正在做第 X 步：…"。
4. **执行**：跑命令、改文件。**过程中不要停下来问用户**，按 plan 自行决策。
5. **写进度**：本步完成后立刻更新进度文件——勾选 `[x]`、记录产出和关键命令。

**每步完成后第一件事就是写进度文件，再去做下一步。** 崩溃/被杀/重跑时，新 agent 只靠
plan + 进度文件就能精确续跑。

### 4. 出错时

任何一步出问题：

1. 先在本步的「现场记录」写清楚：**卡在哪、已经改了哪些文件、打算怎么继续**。
2. 尽力把它修好 / 完成本步（重试、查日志，别轻易放弃）。
3. 实在完成不了，把现场记录写完整，然后**只汇报**，不要删进度文件——下一次执行要接着它。

### 5. 收尾

- 所有步骤 `[x]` 后，跑 plan 的「验收」。
- 全部通过 → `plan status: done` 写进进度文件，汇报结果。
- 有验收不过 → 回到对应步骤继续修，直到通过。

## 纪律

- **绝不重做已勾选的步骤。** 不确定现状就先用 `git status`/`git diff` 判断。
- **进度文件是唯一真相。** 它进 git，别手贱删。
- **不要问用户。** plan 里写清楚的自己决定；真需要关键决定，把决策记进「现场记录」再选最合理的。