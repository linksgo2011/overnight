# Progress — 002-unit-tests.md

plan status: done

## 步骤
- [x] 1 现状检查
- [x] 2 配 package.json scripts.test（"node --test test/*.test.js"，见 D005）
- [x] 3 test/config.test.js（13 tests）
- [x] 4 test/queue.test.js（10 tests）
- [x] 5 test/runner.test.js（9 tests：buildPrompt / classifyExit / done / 重试满 / OOM / 卡死 / backoff / 中途成功 / reports）
- [x] 6 test/tui.test.js（7 tests：visWidth×3 / padTo / wrapLine×3）— 已存在，函数已 export
- [x] 7 npm test 全绿（42 tests）
- [x] 8 验收：npm pack --dry-run 不含 test/（8 文件：README + package.json + src/×6）

## 现场记录
- D001：plan 001 改动不提交。
- 现状确认：src/ 6 模块齐，test/ 已存在 config/queue/tui 三个 .test.js（26 tests 全绿）。
- D003/D004：runner 用 fake agent（spawn 真子进程跑临时 .sh）+ 短 timeout/idle_kill。
- D005：npm test 改 `test/*.test.js` shell glob；Node v25 不展开目录。
- D006：失败归类断言走 runner.log（`this.log()` 一行），不走 `res.reason`（永远是"重试用完"）。
- D007（撤回）：原以为 tui 纯函数未 export，决定跳过 step 6；跑测试才发现 tui.test.js 已在且 7 tests 全绿，src/tui 也已 export `visWidth/padTo/wrapLine`。撤回跳过。
- 收尾：42 tests pass（config 13 + queue 10 + runner 9 + tui 7 + 其它 3）；`npm pack --dry-run` 8 文件不含 test/；git status 只有预期改动。
- 计划内产物：`test/*.test.js`（4 个），`package.json` scripts.test 行。