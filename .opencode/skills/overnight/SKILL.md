---
name: overnight
description: Use when the user wants coding tasks or plans to run automatically overnight or in the background via the overnight runner. Triggers on "overnight", "跑一夜", "夜间跑", "排队跑", "让 AI 上夜班", or requests to queue agent plans for later execution.
---

# overnight — 让 AI 上夜班

overnight 是一个脚本化 Runner：把一个或多个 coding agent 的 plan 排进队列，
到点（默认夜间）自动串行执行，用分屏日志看到 runner 和 agent 的实时输出。

## 你的职责

用户想「把某件事交给 overnight 跑」时，**你负责把事情整理成 plan 并写成队列文件**，
然后告诉用户启动命令。你不需要自己执行任务。

分工：

- **写 plan 文档**：用 `dev-plan` skill（需求 → `docs/plans/NNN-name.md`）
- **执行 plan**：留给 overnight + `dev-build` skill（维护 `docs/progress/` 进度文件）
- **建队列**：下面这个格式的 `queue/NNN.yaml`

## 队列文件格式

放在项目根目录的 `queue/` 下，文件名是 `NNN.yaml`。一个队列文件 = 一组 plan，按顺序 + 依赖执行：

```yaml
title: 项目安全加固          # 元信息：这组任务的标题
agent: opencode            # 可选，默认 agent

plans:                      # plans 节点：至少一个
  - id: 001                # 组内唯一 id，用于排序和 depends_on（文件内）
    title: 把硬编码密钥迁到环境变量
    file: docs/plans/001-keys-to-env.md   # plan 文件位置（相对项目根目录）
    depends_on: []         # 可选，先跑完这些 id 再轮到这个

  - id: 002
    title: 补单元测试
    file: docs/plans/002-unit-tests.md
    depends_on: [001]
```

## 关键要求：plan 必须能重复执行

overnight 失败时会**原样重新启动整个 plan**（最多 `retry.max` 次），**不会**自动恢复工作区。
**plan 的内部进展靠 `dev-build` 维护的进度文件**（`docs/progress/`）续跑：

- 进度文件每个 plan 一个，步骤用稳定编号，`[ ]` 待做 / `[x]` 已完成
- 每步完成立刻写进度；重跑时新 agent 读 plan + 进度，从 `[ ]` 处继续

所以 plan 文档本身不用自带全部幂等逻辑，但要写清「先读进度文件再动手」。

## 工作流

1. 用 `dev-plan` 把需求拆成 plan 文档（`docs/plans/NNN-name.md`）。
2. 创建 `queue/NNN.yaml`，把 plan 串成 `plans` 节点（含 `depends_on`）。
3. 告诉用户运行 `overnight` 启动（夜间窗口默认 `20:00-08:00`）。

## 启动与查看

```bash
overnight            # 启动，进分屏日志界面（左 runner，右 agent）
overnight status     # 看队列
overnight logs       # 看今天的报告
```

时间窗口和 agent 在项目根的 `overnight.yaml` 里配置。设 `schedule.window: null` 表示全天运行。
