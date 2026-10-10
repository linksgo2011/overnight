# plan 001 — 把源码重构到 src/ 下

> 执行第一条：用 dev-build 维护进度，**这个 plan 必须能安全重跑**。
> 先读进度文件 `docs/progress/001-refactor-to-src.progress.md` 和现状（git status / git diff），做过的跳过，别重复。

## 1. 现状检查
先确认基线，判断已经做到哪一步：
- `git status` — 看是否已有移动/改动
- `ls src/ 2>/dev/null` — 若 6 个模块已在 `src/`，说明第 1 步做过了
- `cat package.json` — 看 `bin`/`main`/`files` 是否已指向 `src/`

现状：6 个 ESM 模块（`index.js` `config.js` `queue.js` `runner.js` `agents.js` `tui.js`）都在仓库根目录，共约 1086 行。

## 2. 步骤
1. 用 `git mv` 把 6 个模块移进 `src/`：`index.js config.js queue.js runner.js agents.js tui.js` → `src/`（用 `git mv` 保留历史；已移动的跳过）
2. 检查模块间 import：都是 `./xxx.js` 相对引用，**一起移动后无需改路径**；`grep -n "import.meta.url\|__dirname" src/*.js` 确认没有依赖「代码所在目录」的路径（若报错再修）
3. 改 `package.json`：`bin.overnight` → `./src/index.js`；`main` → `src/index.js`；`files` → `["src"]`；`scripts.start` → `node src/index.js`
4. 保留 `src/index.js` 顶部 `#!/usr/bin/env node` shebang，并 `chmod +x src/index.js`
5. 更新 README 里 `node index.js` 之类命令为 `node src/index.js`
6. 冒烟：`node src/index.js status`、`node --check src/*.js` 全部通过

## 3. 验收
- `ls src/*.js` 正好 6 个模块；仓库根目录不再有这 6 个文件
- `node src/index.js status` 正常输出（可能空队列，只要不报错）
- `git log --follow src/queue.js` 能看到移动前的历史
- `package.json` 的 `bin`/`main`/`files` 均指向 `src/`
- 无 import 报错：`node -e "import('./src/queue.js')"` 成功