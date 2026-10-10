# overnight

**让 AI 上夜班。**

把 coding agent 的 plan 排进队列，到点（默认夜间）自动跑，左边看 runner 重试，右边看 agent 输出。

## 它是什么

一个纯脚本化的 Runner。没有 AI 判断、没有魔法：

- **队列 = 一组 plan**：`queue/NNN.yaml` 里是 `plans` 列表（id / title / 文件位置 / depends_on）
- **依赖调度**：每个 plan 的 `depends_on` 全部完成才轮到它；失败的重试到 `retry.max` 次，依赖它的保持 pending
- **定时执行**：默认夜间窗口 `20:00-08:00`，也可配成全天
- **看住不跑飞**：卡死、超时自动杀；失败按次数重试
- **无打扰会话**：起 agent 带 bypass 权限 + 通用提示词（执行 plan、自行决策、写决策日志）
- **多 agent**：opencode、claude code，配好命令即可
- **分屏日志**：左 runner / 右 agent

## plan 必须能重复执行

失败时 overnight 会**原样重启整个 plan**，并且**不会**自动清理工作区。plan 的重启进展
靠 `dev-build` skill 维护的**进度文件**：`docs/progress/NNN-name.progress.md` 用稳定编号
记录每步 `[ ]`/`[x]`，重跑时的新 agent 读 plan + 进度，从没完成的地方继续。

## 用法

```bash
overnight            # 启动，进分屏日志界面（Ctrl+C 退出）
overnight add "标题"  # 建一个任务：自动生成 plan 骨架 + 队列文件
overnight status     # 看队列（plan 树）
overnight logs       # 看今天的报告
```

### 队列文件

一个队列文件 = 一组 plan，按顺序 + 依赖执行：

```yaml
title: 项目安全加固          # 元信息：这组任务的标题
agent: opencode            # 可选，默认 agent

plans:                      # plans 节点：至少一个
  - id: 001
    title: 把硬编码密钥迁到环境变量
    file: docs/plans/001-keys-to-env.md   # plan 文件位置（相对项目根目录）
    depends_on: []         # 可选，先跑完这些 id 再轮到这个
  - id: 002
    title: 补单元测试
    file: docs/plans/002-unit-tests.md
    depends_on: [001]
```

plan 文档放 `docs/plans/`，进度文件放 `docs/progress/`（两者都进 git）。

## 配置（`overnight.yaml`）

```yaml
agents:
  opencode: { command: opencode, args: ["run", "--dangerously-skip-permissions", "{prompt}"] }
  claude:   { command: claude,   args: ["-p", "{prompt}", "--dangerously-skip-permissions"] }
default_agent: opencode

runner:
  timeout: 60m        # 单个计划硬超时
  idle_kill: 10m      # 多久没输出算卡死
  prompt_template: |  # 追加给 agent 的通用提示词（{plan_file}/{decision_log_dir} 会替换）
    执行 plan 文件 {plan_file}，执行过程中不要询问，自行决策，
    并记录决策日志，写入 {decision_log_dir}
  decision_log_dir: logs/decisions   # 决策日志目录

schedule:
  window: "20:00-08:00"   # 跨夜窗口；null = 全天

retry:
  max: 3
  backoff: 5m
```

## 在 opencode 里用

仓库带三个 skill：

- `overnight`：把需求排进 overnight 夜间跑（建队列）
- `dev-plan`：需求 → plan 文档
- `dev-build`：执行 plan 文档 + 维护进度文件

## 全局安装

```bash
npm i -g .        # 或 npm link，之后任意目录都能用 overnight
```
