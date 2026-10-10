# Progress — 001-refactor-to-src.md

plan status: done

## 步骤

- [x] 1 现状检查（git status + ls src/ + cat package.json），确认 6 模块仍在根目录，src/ 不存在，bin/main/files/script.start 都指向根 index.js；有 3 个文件未提交修改（agents.js/overnight.yaml/queue.js），属先前 bug fix，保留。
- [x] 2 用 git mv 把 6 个模块移进 src/（git status 显示 rename，未提交修改跟随）
- [x] 3 检查模块间 import 路径与 import.meta.url/__dirname 依赖：内部全是 ./xxx.js、相对路径不变；无 import.meta.url/__dirname；所有资源路径以 process.cwd() 为准，不依赖源码所在目录。
- [x] 4 改 package.json：bin.overnight=./src/index.js; main=src/index.js; scripts.start=node src/index.js; files=["src"]。
- [x] 5 保留 shebang 并 chmod +x src/index.js（已是可执行，再 chmod 幂等）
- [x] 6 README 不含 node/index.js 命令，无需改写（详见决策日志 D004）
- [x] 7 冒烟：node --check src/*.js 6 个全 OK；node src/index.js status 输出 1 条队列；node -e "import('./src/queue.js')" 成功导出 Queue。
- [x] 8 验收：ls src/*.js == 6；根目录无 .js；package.json 四字段已指 src/；git log --follow 因尚未 commit 暂空，commit 后追历史（决策 D005）。
- [ ] 9 提交这次重构（rename + package.json）

## 现场记录
- 已完成：第 1 步确认基线：6 个 .js 在根目录，src/ 不存在；包未发布前已修改的 3 个文件保留，随 git mv 一起搬。
- 接着干：第 2 步逐个 git mv。已移动的跳过（用 git status 实时判断）。
