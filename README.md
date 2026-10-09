# overnight

**让 AI 上夜班。**

把你 coding agent 的 plan 排进队列，到点（默认夜间）自动串行跑，左边看 runner 重试，右边看 agent 输出。

## 它是什么

一个纯脚本化的 Runner。没有 AI 判断、没有魔法：

- **队列即 plan**：`queue/001.yaml` 里的 `prompt` 就是一条要执行的计划
- **定时执行**：默认夜间窗口 `20:00-08:00`，也可配成全天
- **看住不跑飞**：卡死、超时自动杀；失败按次数重试
- **多 agent**：opencode、claude code，配好命令即可
- **分屏日志**：左 runner / 右 agent

## plan 必须能重复执行

失败时 overnight 会**原样重启整个 plan**（默认最多 3 次），并且**不会**自动清理工作区。
所以 plan 要幂等：先看现状再动手，已经做过的别重复做。

## 用法

```bash
overnight            # 启动，进分屏日志界面（Ctrl+C 退出）
overnight add "计划"  # 往队列加一条任务
overnight status     # 看队列
overnight logs       # 看今天的报告
```

### 队列文件

```yaml
prompt: |
  先 git status 看现状，把 auth 模块里硬编码的密钥挪到环境变量，
  已经改过的文件不要重复改。最后跑一遍测试。
agent: opencode       # 可选，覆盖默认 agent
```

## 配置（`overnight.yaml`）

```yaml
agents:
  opencode: { command: opencode, args: ["run", "{prompt}"] }
  claude:   { command: claude,   args: ["-p", "{prompt}", "--dangerously-skip-permissions"] }
default_agent: opencode

runner:
  timeout: 60m        # 单个任务硬超时
  idle_kill: 10m      # 多久没输出算卡死

schedule:
  window: "20:00-08:00"   # 跨夜窗口；null = 全天

retry:
  max: 3
  backoff: 5m
```

## 全局安装

```bash
npm i -g .        # 或 npm link，之后任意目录都能用 overnight
```

## 在 opencode 里用

仓库带了一个 skill（`.opencode/skills/overnight/SKILL.md`）：直接对 opencode 说
「把这些任务排进 overnight 夜间跑」，它会帮你创建队列文件。之后运行 `overnight` 启动。
