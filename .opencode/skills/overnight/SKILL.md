---
name: overnight
description: Use when the user wants coding tasks or plans to run automatically overnight or in the background via the overnight runner. Triggers on "overnight", "跑一夜", "夜间跑", "排队跑", "让 AI 上夜班", or requests to queue agent plans for later execution.
---

# overnight — 让 AI 上夜班

overnight 是一个脚本化 Runner：把一个或多个 coding agent 的 plan 排进队列，
到点（默认夜间）自动串行执行，用分屏日志看到 runner 和 agent 的实时输出。

## 你的职责

用户想「把某件事交给 overnight 跑」时，**你负责把这件事写成队列文件**，然后告诉用户启动
命令。你不需要自己执行任务，只需要准备好 plan。

## 队列文件格式

放在项目根目录的 `queue/` 下，文件名是 `NNN.yaml`（三位数字，按顺序执行）：

```yaml
prompt: |
  这里写完整的、自包含的 plan 提示词
agent: opencode        # 可选，覆盖默认 agent
```

一条任务就是一个 plan 的提示词。可选的 `agent` 用来换 agent（如 `claude`）。

## 关键要求：plan 必须能重复执行

overnight 在失败时会**原样重新启动整个 plan**（最多 `retry.max` 次，默认 3）。
它**不会**自动恢复工作区。所以 plan 必须幂等：

- 先检查当前状态再动手（例如「如果测试已存在就跳过」）
- 不要依赖「只跑一次」的副作用
- 尽量让每一步都能安全重跑

写 plan 时把这条明确写进提示词里，例如：
「先 `git status` 看现状，已经做过的部分不要重复做。」

## 工作流

1. 跟用户确认要跑的任务，把它整理成一个自包含、可重复执行的 plan。
2. 找到 `queue/` 里下一个可用编号（`001`、`002`…），写入 `queue/NNN.yaml`。
3. 告诉用户运行 `overnight` 启动（夜间窗口默认 `20:00-08:00`）。

## 启动与查看

```bash
overnight            # 启动，进分屏日志界面（左 runner，右 agent）
overnight status     # 看队列
overnight logs       # 看今天的报告
```

时间窗口和 agent 在项目根的 `overnight.yaml` 里配置。设 `schedule.window: null` 表示全天运行。
