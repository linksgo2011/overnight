# AGENTS.md

给 AI agent / 新来的人的操作手册。细节看 `README.md` 和 `docs/strategy/overnight-design.md`。

## 这是什么

**overnight —— 让 AI 上夜班。** 一个纯脚本化 Runner（无 AI 判断）：把 coding agent 的
plan 排进队列，到点（默认夜间 `20:00-08:00`）串行执行，TUI 左右分屏看 runner 重试和
agent 实时输出。

## 常用命令

```bash
node src/index.js            # 启动 TUI（主循环，Ctrl+C 退出）
node src/index.js status     # 看队列（plan 树）
node src/index.js add "标题"  # 建任务：生成 plan 骨架 + queue/NNN.yaml
node src/index.js logs       # 看今天的运行报告
npm test                     # 42 个测试，node:test，约 4s
```

`npm link` 或 `npm i -g .` 之后可直接用 `overnight`。

## 目录结构

```
src/            6 个 ESM 模块（都在这里，根目录不放代码）
  index.js        CLI + 主循环
  config.js       配置加载 / 时间窗 / duration 解析
  queue.js        队列解析、依赖调度、状态落盘
  runner.js       单个 plan 的执行与重试
  agents.js       多 agent 适配（spawn / kill / 报告）
  tui.js          分屏日志界面
test/           node:test 单元测试（config/queue/runner/tui）
docs/plans/     plan 文档（NNN-name.md）
docs/progress/  进度文件（NNN-name.progress.md，**进 git**）
queue/          队列文件（NNN.yaml，gitignore 掉，靠 agent 现场生成）
logs/           agent 输出、决策日志（gitignore）
reports/        每日报告（gitignore）
.env.local / env.local  本地环境变量（不进 git）
```

## 核心概念：三层结构

| 层 | 文件 | 说明 |
|---|---|---|
| 队列 | `queue/NNN.yaml` | 一组 plan 的执行计划：`plans[]`，每项 `id` / `title` / `file` / `depends_on` |
| plan | `docs/plans/NNN-name.md` | 一个可重复执行的目标：现状检查 + 稳定编号步骤 + 可测验收 |
| 进度 | `docs/progress/NNN-name.progress.md` | plan 执行进度，`[ ]` / `[x]`，dev-build 每步立即写 |

**依赖只在 queue 文件内**（`depends_on: [001]`）。`_` 开头的 queue 文件被跳过。
plan 文件缺失 / yaml 解析错 / 依赖成环 → 该 plan 标 `broken` 跳过。
plan 重试到 `retry.max` 仍失败 → 标 `failed`，依赖它的保持 `pending`（不跳过）。

## 在 opencode 里怎么用（三个 skill）

- `.opencode/skills/dev-plan` —— 需求 → `docs/plans/NNN-name.md`
- `.opencode/skills/dev-build` —— 执行 plan + 维护进度文件（续跑的关键）
- `.opencode/skills/overnight` —— 把 plan 串成 `queue/NNN.yaml` 排夜间跑

写 plan 的纪律：**必须能安全重跑**。不靠 plan 自身幂等，靠 dev-build 的进度文件续跑
——重跑时新 agent 读 plan + 进度，从 `[ ]` 处继续。

## 配置（overnight.yaml）

```yaml
agents:
  opencode: { command: ~/.opencode/bin/opencode, args: [run, -m, minimax/MiniMax-M3.1-Flash-Preview, --dangerously-skip-permissions, "{prompt}"] }
  claude:   { command: claude, args: [-p, "{prompt}", --dangerously-skip-permissions] }
default_agent: opencode
runner:  { timeout: 60m, idle_kill: 10m, prompt_template: "...", decision_log_dir: logs/decisions }
schedule: { window: "20:00-08:00" }   # null = 全天
retry:   { max: 3, backoff: 5m }
```

起 agent 的 prompt = `prompt_template`（替换 `{plan_file}` / `{decision_log_dir}`）+ plan 文件全文。

## 踩过的坑（改代码前先看）

1. **OpenCode 桌面 App 的环境变量**：App 会注入 `OPENCODE_CLIENT` / `OPENCODE_SERVER_*`，
   子进程 opencode 会误连桌面富服务报 `Session not found`。`src/agents.js` 的 `agentEnv()`
   会剥掉这三个，别去掉。
2. **YAML 八进制坑**：`depends_on: [001]` 会被 YAML 解析成 `[1]`。`src/queue.js` 里统一
   `padStart(3,'0')` 归一，改 id 逻辑时注意保持这个归一化。
3. **卡死的 running 状态**：daemon 被 kill 时 plan 会残留在 `running`，重启后永远不再被
   调度。`queue.resetFailed()` 启动时会把 `failed` 和残留的 `running` 都打回 `pending`。
4. **CJK 宽度**：终端里中文/emoji 占两列。`tui.js` 的对齐用显示宽度算，改布局别用
   `String.length`。`test/tui.test.js` 有覆盖。

## 发布到 npm

```bash
source env.local          # 或直接用 ~/.npmrc 里已配好的 token
npm version patch         # 改版本号（会自动改 package.json + lock）
npm publish --access public
```

- 包名 `@shaogefenhao/overnight`，bin 名 `overnight`。
- `prepublishOnly` 会自动跑 `npm test`。
- `files: ["src"]`，测试/文档/队列都不进包（`npm pack --dry-run` 校验）。
- 当前 token 在 `env.local` 和 `~/.npmrc`；失效去 npm 网页重新生成。

## 约定

- 提交信息：conventional commits + 中文描述（`feat:` / `fix:` / `refactor:` / `chore:`）。
- **未经明确要求不提交、不推送、不发布。**
- 改完代码跑 `npm test`，42 个必须全绿。
- 这个项目的 plan/进度文件本身就是文档，别只写在提交信息里。
