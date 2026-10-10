# plan 002 — 用 node:test 构建单元测试

> 执行第一条：用 dev-build 维护进度，**这个 plan 必须能安全重跑**。
> 先读进度文件 `docs/progress/002-unit-tests.progress.md` 和现状（git status / git diff），做过的跳过，别重复。

## 1. 现状检查
先确认基线，判断已经做到哪一步：
- `git status` — 看是否已有 `test/` 改动
- `ls test/ 2>/dev/null` — 已存在哪些测试文件
- `cat package.json | grep test` — 看 `scripts.test` 是否已配好
- 前置：源码已重构到 `src/`（见 plan 001）；若仍在根目录，就先做 001

约定：测试框架用 Node 内置 **`node:test`** + `node:assert`，**不引入任何新依赖**。测试放 `test/`，文件命名 `*.test.js`。

## 2. 步骤
1. 配 `package.json`：加 `"scripts": { "test": "node --test" }`，`files` 保持只发 `src`（测试不进发布包）
2. `test/config.test.js`：测 `parseDuration`（`30s`/`10m`/`1h`/`24h`）、`parseWindow`（`20:00-08:00` 跨夜、`null` 全天）、`inWindow`（窗口内外边界）、`loadConfig` 的 deepMerge（尤其是 `schedule.window: null` 不能被默认值盖回，`null` 是显式覆盖）
3. `test/queue.test.js`：用 `fs.mkdtempSync` 建临时项目，覆盖：
   - plan id 补零：yaml 里 `id: 1` → 内部 `'001'`
   - `depends_on: [1]`（YAML 八进制坑）→ 归一成 `'001'`，依赖能匹配上
   - `ready()/next()`：只有依赖全 `done` 的 pending plan 才返回；返回顺序正确
   - 成环：A↔B → 两个都标 `broken`（含成环路径），依赖它的保持 pending
   - 缺失 `file` → 该 plan `broken` 且被跳过
   - `markPlan()` 写状态、`resetFailed()` 把 `failed` 和卡住的 `running` 打回 `pending`、`prune()`
4. `test/runner.test.js`：
   - `buildPrompt(plan)`：`{plan_file}`/`{decision_log_dir}` 被替换，且**追加了 plan 文件全文**
   - 用一个假 agent 脚本（写进临时目录，`exit 0` / `exit 1` / 输出 `Out of memory`）：验证成功、失败重试到 `retry.max`、OOM 归类
   - 校验退出码/attempts 语义
5. `test/tui.test.js`（可选，若时间够）：测导出的宽度/折行纯函数（`visWidth`/`wrapLine`/`padTo`）对 CJK 双宽字符对齐正确
6. 跑 `npm test`，全绿；修到过为止

## 3. 验收
- `npm test` 全绿，退出码 0
- `test/` 下至少覆盖 `config` `queue` `runner` 三个模块
- 测试用临时目录，**不污染** 仓库（跑完 `git status` 应干净，除计划内的 `test/` 与 `package.json`）
- `npm pack --dry-run` 里**不含** `test/` 目录（发布包干净）