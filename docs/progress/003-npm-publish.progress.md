# Progress — 003-npm-publish.md

plan status: in_progress

## 步骤
- [x] 1 现状检查（src/ 6 模块、test/ 4 个 .test.js 42 tests 全绿、README 已有、LICENSE 无、npm 未登录、@linksgo2011/overnight 未发、package.json 是旧名 `overnight`）
- [x] 2 补 package.json 发布元信息（name/description/keywords/author/repository/homepage/bugs/publishConfig/scripts.prepublishOnly）— D001~D005
- [x] 3 加 LICENSE（MIT，linksgo2011） + package.json.license:"MIT" — D006
- [x] 4 确认 files:["src"] 干净（D008）
- [x] 5 npm pack --dry-run 内容干净（9 文件：LICENSE + README + package.json + src/×6，无 test/docs/queue/logs）— D008
- [x] 6 本地冒烟：npm pack → npm i -g ./xxx.tgz → `overnight status` 输出现有 003 计划行 → npm rm -g — D009
- [ ] 7 npm login（待人工/交互登录）→ npm publish --access public — **卡点**
- [ ] 8 验证：npm view @linksgo2011/overnight + npx status

## 现场记录
- 起点状态：plan 001/002 已 done；src/ 与 test/ 在，README 在，无 LICENSE，npm 未登录，scoped 包未发。
- name: 当前 `overnight` → 改 `@linksgo2011/overnight`，注意 version 维持 0.1.0 首发。
- 改动文件：会改 package.json、新建 LICENSE、新建 docs/progress/003-*.progress.md（本文件）、logs/decisions/003-npm-publish.decisions.md。
- 第 2/3 步：package.json 改完；LICENSE（MIT，Copyright (c) 2026 linksgo2011）已建。
- 第 5 步：npm pack --dry-run = 9 文件：LICENSE + README.md + package.json + src/{agents,config,index,queue,runner,tui}.js。无 test/docs/queue/logs/.opencode。tarball 16.1 kB。
- 第 6 步：本地 i -g 成功（添加 yaml 2 个包），`overnight status` 在 /opt/homebrew/bin/overnight 输出当前队列（含本 003 计划），已卸载。
- **卡点（step 7）**：发布前必须先登录 npm。`npm whoami` → ENEEDAUTH；`~/.npmrc` 不存在；无 NPM_TOKEN/NODE_AUTH_TOKEN 环境变量；本环境是非交互 agent shell，`npm login` 会阻塞等待 stdin 用户名/密码/OTP。我没有凭据可注入，也没法绕过身份验证。
