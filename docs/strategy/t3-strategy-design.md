# T3 — 设计文档

> Claude Code 的看护进程。你把要做的事写成一句话丢进队列，CC 去干，T3 盯着。
> CC 挂了就分析日志，判断该不该重试，然后重试。

---

# 第一部分：需求

## 1. 是什么

T3 是个守护进程，只干一件事：**让 Claude Code 一直有活干，且不会一挂就废。**

```
你/CI  →  写一句话进队列
              ↓
         T3 守护进程
              ↓
         Claude Code  ← 真正干活的
              ↓
         挂了？  T3 看日志、判断、重试
```

CC 是执行者，T3 是看护者。T3 自己不写代码。

## 2. 队列就是提示词

队列里每条就是一句话，扔给 agent 跑。

```
queue/
  ├── 001.yaml
  ├── 002.yaml
  └── 003.yaml
```

`001.yaml` 全文：

```yaml
prompt: 重构 auth 模块，提升安全性，补上单元测试
```

就这些。没有 name、没有 task 拆分、没有审批、没有依赖。

**谁能加**：团队里任何人，往目录扔个 yaml 就行。放 git 里提 PR，或者共享目录直接写。

## 2.1 支持多个 Coding Agent

`claude`、`opencode` 都能跑，配置里切，也可以每条任务指定。

```yaml
# queue/001.yaml
prompt: 重构 auth 模块
agent: claude     # 可选，不写就用默认的

# queue/002.yaml
prompt: 补支付测试
agent: opencode
```

两个 agent 都是**非交互 + 免授权**跑，不弹窗不等人：

| Agent | 命令 | 免授权参数 |
|--------|------|-----------|
| claude | `claude -p "..."` | `--dangerously-skip-permissions` |
| opencode | `opencode run "..."` | 默认就是非交互 |

加新 agent 就是往 `agents:` 里加一段命令模板，不用改代码。

## 3. 什么时候跑

| 触发 | 说明 |
|------|------|
| **夜里跑** | 配个时间段（默认 20:00-08:00），窗口外**不派新单** |
| **24h 轮询** | 每 24h 扫一次队列，有活就派 |

**串行执行**，一次一条。任务经常要跑浏览器和数据库，并行会打架。

**窗口外正在跑的任务怎么办？** 不打断，让它跑完。但**超过窗口结束时间还没完的**，T3 会拿 AI 决策一次：

```
窗口 20:00-08:00，任务 02:00 还没完（已跑 4 小时）
  ↓
问 AI: "这单跑了 4 小时，还在写，窗口要关了，继续还是收尾？"
  ↓
AI: "改了 12 个文件但没跑测试，跑了大概率白干" → 收尾，标记待续
AI: "正在跑测试，再等 20 分钟就行"         → 宽限 20 分钟
```

决策结果写进 `reports/`，第二天能看到。

**一次一条，串行。** 任务经常要跑浏览器和数据库，并行会打架。

```
      ┌──────────┐
  ┌──►│  取一条   │
  │   └────┬─────┘
  │        │ 有？
  │   ┌────┴────┐
  │   │有      │没有
  │   ▼         ▼
  │ 交给 CC   睡到下一轮
  │   │
  │   ▼
  │ CC 退出
  │   │
  │   ├─ exit 0 ────────► 成功，标记，取下一条
  │   │
  │   └─ 非 0 / 卡死 ──► 看日志 ──► AI 判断 ──┐
  │                                          │
  │        ┌─────────────────────────────────┘
  │        ▼
  └── 重试（带着上次的失败信息）
```

## 4. 挂了怎么处理

CC 会以各种方式挂：

| 挂法 | 怎么发现 |
|------|---------|
| 进程直接没了 | `exit code != 0` |
| OOM 被杀 | exit code 137 |
| 卡死不输出 | 超过 N 分钟没新日志 |
| 网络/API 报错 | 日志里有 error |
| 改到一半崩了 | 日志最后有未完成动作 |

T3 拿到失败日志后问 AI 一句话：**重试还是放弃。**

```
判断: "第 47 行 permission denied，不是超时，重试也会一样"
      → 放弃，标记 failed，写报告，等人看

判断: "API rate limit，等一下就好"
      → 等 5 分钟再重试
```

AI 输出的原话原样记进报告，方便你早上扫一眼就知道为啥。

## 5. 报告

每天一个文件。

```markdown
# 2026-01-15

## 跑完
- 001 重构 auth 模块           00:12 - 00:48  ✓

## 没跑完
- 002 补支付测试
  重试 3 次都失败。
  最后一次: exit 137 (OOM)
  AI: "改到一半，核心逻辑没动，看着不像简单超时"
  → 放弃

## 统计
- 派了 3 单：成 1，废 2
- 重试 5 次
```

## 6. 跟它说话

启动进 TUI，上面队列 + 状态，下面聊天框。**不记命令，直接说。**

```
┌─────────────────────────────────────────────────────────────────┐
│ T3                                       队列 3 · CC 工作中     │
├─────────────────────────────────────────────────────────────────┤
│ ▶ 001 重构 auth 模块        跑了 12 分 14 秒                      │
│   002 补支付测试            等待                                │
│   003 更新依赖版本          等待                                │
├─────────────────────────────────────────────────────────────────┤
│ 我 > 002 咋样了                                                │
│ T3 > 还没轮到它，前面 001 在跑，12 分钟了，上一条输出是            │
│      "正在改 token 校验"，看着正常。                              │
│                                                                 │
│ 我 > 002 不急，先把 003 提上来                                    │
│ T3 > 好，003 插到第二位了，001 跑完就派它。                      │
│                                                                 │
│ 我 > 现在队列里啥                                                │
│ T3 > 001（CC 正在跑，12 分钟）、002 补支付测试、003 更新依赖。     │
│      队列是 queue/ 里的 yaml，扔进去就排队。                      │
├─────────────────────────────────────────────────────────────────┤
│ 直接说就行，Ctrl+C 退出（CC 继续跑）                            │
└─────────────────────────────────────────────────────────────────┘
```

常说的话：

| 你说 | 它做 |
|------|------|
| "001 咋样了" / "状态" | 讲当前进度 |
| "把 003 提上来" | 调队列顺序 |
| "002 不用了" | 删掉那个 yaml |
| "加一个：修复登录崩溃" | 写个新 yaml |
| "别跑了" / "继续" | 开关派单 |
| "今天的报告" | 读 reports/ |

**边界**：只能读状态、改 `queue/` 目录。不能改代码、不能碰 git、不能跑 shell。

---

# 第二部分：技术方案

## 1. 就几个文件

```
t3/
├── t3.yaml        # 配置
├── queue/         # 队列，一堆 yaml
├── logs/          # 每单一个日志
├── reports/       # 每天一个报告（含所有决策）
├── guard.js       # 看护：起 agent、看它、救它   ← 核心
├── agents.js      # 多 agent 适配（claude/opencode/...）
├── queue.js       # 队列读写
├── tui.js         # 界面 + 聊天
└── index.js       # 主循环
```

## 2. 配置

```yaml
# t3.yaml

# AI（看护决策 + 聊天，同一个 token）
ai:
  base_url: https://api.anthropic.com
  api_key: ${ANTHROPIC_API_KEY}
  model: claude-sonnet-4

# 可用的 coding agent
agents:
  claude:
    command: claude
    args: ["-p", "{prompt}", "--dangerously-skip-permissions"]
  opencode:
    command: opencode
    args: ["run", "{prompt}"]
default_agent: claude

# 单个任务的看护
guard:
  timeout: 60m         # 硬超时
  idle_kill: 10m       # 多久没输出算卡死
  window_grace: 20m    # 窗口结束后最多再宽限多久

# 什么时候派单
schedule:
  window: "20:00-08:00"   # 留空 = 全天
  idle_sleep: 24h         # 队列空时睡多久

# 重试
retry:
  max: 3
  backoff: 5m
```

`{prompt}` 是占位符，T3 起进程时替换成实际提示词。加新 agent 只改配置。

## 3. 主循环

```js
while (true) {
  if (!inWindow())       { sleep(5m); continue; }
  if (paused)            { sleep(1m); continue; }

  const job = nextJob();               // queue/ 里挑一个没派过的
  if (!job)             { sleep(idleSleep); continue; }

  await guard(job);                    // 全程守到 CC 干完
  markDone(job);
}
```

`nextJob()` 就是读 `queue/*.yaml`，跳过 `state.json` 里已完成的。

## 4. 看护核心

这是整个项目最实在的部分。**起进程，盯输出，判死活。**

```js
async function guard(job) {
  for (let attempt = 1; attempt <= config.retry.max; attempt++) {

    // 第一次不带任何前情，重试时带上次的失败原因
    const prompt = attempt === 1
      ? job.prompt
      : `${job.prompt}\n\n---\n上次执行到一半挂了，错误如下：\n${job.lastError}\n继续干。`;

    const proc = startAgent(job, prompt);   // 按 agent 模板起进程

    // 四条线同时盯
    const result = await Promise.race([
      exited(proc),                          // 进程退出
      idle(proc, config.guard.idle_kill),    // 长时间没输出
      timer(config.guard.timeout),           // 硬超时
      windowClosed(job, proc),               // 窗口关了，问 AI 续不续
    ]);

    if (result === 'ok') return { status: 'done' };

    // 挂了 —— 把日志尾巴和 stderr 一起给 AI 看
    const err = tail(proc.output, 80) + '\n' + proc.stderr;

    const verdict = await askAI(`
任务：${job.prompt}
执行方式：${job.agent}
失败信息：
${err}

这个能重试吗？一句话说明理由。如果重试没意义就说"放弃"。
`);

    job.lastError = err;                  // 记下来，重试时喂回去
    logEvent({ job, attempt, err, verdict });

    if (verdict.includes('放弃')) return { status: 'failed', verdict };
    await sleep(config.retry.backoff);
  }

  return { status: 'failed' };
}
```

**四个要点：**

1. **重试要把失败原因喂回给 agent**。光重跑没意义，得让它知道上次卡在哪。
2. **AI 只答一句话**，不搞结构化输出。T3 就判断有没有"放弃"两个字。
3. **AI 的原话进报告**。它判断错了你能看出来。
4. **窗口决策也是 AI**，但它不杀进程，只决定"再宽限多久"还是"收尾走人"。

## 4.1 起 agent（多适配）

```js
function startAgent(job, prompt) {
  const tpl = config.agents[job.agent || config.default_agent];
  const args = tpl.args.map(a => a.replace('{prompt}', prompt));

  const proc = spawn(tpl.command, args, {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  const output = [];
  proc.stdout.on('data', d => { output.push(d.toString()); tui.log(d.toString()); });
  proc.stderr.on('data', d => { output.push(d.toString()); });

  return { proc, output, stderr: () => output.join('') };
}
```

**注意用数组传 args，不要拼字符串** — prompt 里有空格引号就不会炸。

## 4.2 窗口关了怎么办

```js
function windowClosed(job, proc) {
  return new Promise((resolve) => {
    if (!inWindow() && !job.graceGiven) {
      // 已经出窗口了，问 AI 一句
      const d = await askAI(`
任务：${job.prompt}
已经跑 ${job.elapsed()}，还在执行，配置的时间窗口刚关了。
最后输出：${tail(proc.output, 30)}

继续等，还是收尾停掉？一句话。
      `);

      logDecision(job, d);              // 决策写进报告

      if (d.includes('收尾') || d.includes('停')) {
        kill(proc);
        return resolve('window-closed');
      }
      job.graceGiven = true;           // 宽限 grace 分钟
    }

    // 宽限期内继续等，超了就收尾
    const t = setTimeout(() => {
      if (job.graceGiven) { kill(proc); resolve('window-closed'); }
      else resolve('window-closed');
    }, config.guard.window_grace);
  });
}
```

**所有决策（重试判断 + 窗口决策）都写进 `reports/YYYY-MM-DD.md`**，AI 原话保留。

## 5. 怎么发现 CC 卡死

```js
function idle(cc, limit) {
  let last = Date.now();
  cc.stdout.on('data', () => { last = Date.now(); });

  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (Date.now() - last > limit) {
        kill(cc);
        resolve('stuck');
      }
    }, 30_000);
  });
}
```

只看有没有新输出，不解析内容。CC 思考时会输出，所以 10 分钟静默基本就是死了。

## 6. 聊天

跟 CC 挂掉时的判断是同一个 AI，就是多给一段当前状态。

**每轮塞给 AI 的上下文**（很便宜）：

```
现在: 2026-01-15 03:42
队列: 001(CC 跑着, 12分14秒, 最后输出"正在改 token 校验")
      002 补支付测试
      003 更新依赖版本
```

**system prompt**：

```
你是 T3，Claude Code 的看护进程。
你可以读队列状态，也可以增删改 queue/ 目录里的 yaml。
不能改代码、不能操作 git、不能执行 shell。
中文，简短。
```

**要动文件时**，返回个标记：

```
T3> 002 我删掉了。
     <action:delete> 002
```

T3 认字符串就去操作 `queue/`，把结果带进下一轮。**不用 tool calling**，匹配字符串就行。

## 7. 团队怎么加任务

`queue/` 扔进 git：

```bash
echo 'prompt: 修复登录崩溃' > queue/004.yaml
git add queue/004.yaml && git commit -m "task: 修复登录" && git push
```

或者共享目录直接写文件。T3 只管扫本地 `queue/`，要不要 `git pull` 自己决定，拉挂了也不影响干活。

## 8. 启动

```bash
npm install -g t3
t3 init     # 生成 t3.yaml
t3          # 启动，直接进 TUI
```

Ctrl+C 只关界面，**CC 照跑**。`t3 attach` 重新连。

## 9. 依赖

```json
{
  "dependencies": {
    "yaml": "^2.0.0"
  }
}
```

`fetch` 调 AI，`child_process` 起 CC，界面自己画 ANSI。**就这一个依赖。**

---

## 就这些

- 读 `queue/*.yaml`，每个文件一句话
- 按配置起 `claude -p` 或 `opencode run`，免授权非交互
- 盯着，挂了把日志给 AI，问一句重试还是放弃
- 出窗口了，问 AI 续不续，宽限多久
- 重试的时候把失败原因一起喂回去
- 所有决策写进 `reports/`，画个界面让你能看着、能说话

**大概 400 行。** 不加功能，不加抽象。跑起来再说。
