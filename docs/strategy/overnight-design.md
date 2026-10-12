# overnight — 设计文档

## 定位

**让 AI 上夜班。** 一个脚本化的 Runner：把 coding agent 的 plan 排成一个队列，
按时间窗（默认夜间）自动串行执行，用分屏日志看着它跑完。

刻意不做的事：不做 AI 判断、不做聊天、不自动恢复工作区、不搞复杂队列语义。
失败就按固定次数重试，重试的是「同一个 plan」。

```
  用户 / skill 写 queue/NNN.yaml (prompt=一个 plan)
                  │
   oveRnight 守护循环  ── 时间窗内 ──▶ 串行取队首 ──▶ 起 agent ──▶ 盯三条线
                  │                              ▲                │
                  │                              └── 退出/卡死/超时 ──┘
                  │                                   │ 失败
                  │                              max 次重试（同样 prompt + 上次错误）
                  │                                   │ 用完
                  │                              标记 failed，写报告
```

## 队列 = plan 列表

- 每个文件 `queue/NNN.yaml`，一条任务 = 一个 plan 提示词。
- 顺序按文件名；`state.json` 记状态（pending / running / done / failed）。
- 团队协作：谁要跑什么，往 `queue/` 丢一个 yaml 就行。

## plan 必须可重复执行（幂等）

重试会把同一个 plan 原样重启，**不会自动清理工作区**，所以 plan 得先看现状再动手：

- 已在做的工作要能识别出来（「如果测试已存在就跳过」）
- 失败重试时把上次错误追加到 prompt 末尾，让 agent 接着干

## 执行时机

- 默认窗口 `20:00-08:00`（跨夜）。`queue: null` = 全天。
- **窗口只管「要不要开新任务」**；已经在跑的任务不打断、不 AI 决策、不宽限。
- 队列空了按 `idle_sleep` 轮询兜底。

## 三条防线（纯脚本）

| 线 | 触发 | 动作 |
|----|------|------|
| 退出 | 进程退出 code!=0 | 按日志关键字归类原因（OOM/网络/限流/认证/测试/磁盘…） |
| 卡死 | `idle_kill` 内无新输出 | 杀进程组 |
| 超时 | `timeout` 到点 | 杀进程组 |

杀用整个进程组（`detached` + `kill(-pid)`），SIGTERM + 3s 后 SIGKILL 兜底，不留孤儿。

## 重试

纯脚本：失败 → 等到 `backoff` → 重试，最多 `retry.max` 次。无 AI 判断。

## 分屏 TUI

```
│ 跑哪个                        │ agent 001                    │
│ ▶ 001 第1次: opencode …        │ 读取 auth/middleware.ts      │
│ ✓ 001 完成 5分钟              │ 发现 3 处硬编码密钥          │
└───────────────────────────────┴──────────────────────────────┘
队列 2 待跑 · 当前 001 · 窗口 夜间
```

- 左栏 runner 事件，右栏 agent 实时输出。CJK 按双宽对齐。Ctrl+C 退出。
- 纯 ANSI 画框，无依赖。日志同时落盘 `logs/NNN-aN.log`，报告在 `reports/YYYY-MM-DD.md`。

## 多 agent

`overnight.yaml` 里配命令模板，`{prompt}` 占位符用数组传参（引号安全）：

```yaml
agents:
  opencode: { command: opencode, args: ["run", "{prompt}"] }
  claude:   { command: claude,   args: ["-p", "{prompt}", "--dangerously-skip-permissions"] }
```

## 作为 skill 使用

`.opencode/skills/overnight/SKILL.md`：对 opencode 说「把这些任务排进 overnight 夜间跑」，
skill 负责把任务整理成可重复执行的 plan 写进 `queue/`，然后 `overnight` 启动。

## 文件结构

```
overnight/
├── overnight.yaml   # 配置
├── queue/           # 任务队列（plan 提示词）
├── logs/            # agent 原始输出
├── reports/         # 每日报告
├── agent 启动：index.js（CLI+主循环）/ runner.js（看护）/ agents.js（多agent）/ queue.js / config.js / tui.js（分屏）
└── .opencode/skills/overnight/SKILL.md
```

## 为什么去掉了 AI

早期版本用 AI 判断「失败该不该重试」「出窗口续不续」，并要求 AI 有权限改队列。
代价：要 API key、决策不可复现、聊天 UI 复杂。这个场景真正需要的是**能复现、能解释**
的看护：跑挂了就按规矩重试，谁都能看懂。判断留给写 plan 的人和日志本身。

## 安装

`npm link` 或 `npm i -g`，bin 名 `overnight`，任意目录可用。