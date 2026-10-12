# plan 003 — 打包与发布配置，发布到 npm

> 执行第一条：用 dev-build 维护进度，**这个 plan 必须能安全重跑**。
> 先读进度文件 `docs/progress/003-npm-publish.progress.md` 和现状（git status / git diff），做过的跳过，别重复。

## 1. 现状检查
先确认基线，判断已经做到哪一步：
- `git status`、`cat package.json` — 看元信息字段是否已补齐
- `ls LICENSE 2>/dev/null` — 是否有 LICENSE
- `npm whoami` — 是否已登录 npm（未登录则最后一步再登）
- `npm view @shaogefenhao/overnight version 2>/dev/null` — 是否已发布过
- 前置：源码已到 `src/`（plan 001）、测试已就绪（plan 002）；未完成就先做前置

**包名已定：`@shaogefenhao/overnight`（scoped，需 `--access public`）。** 命令仍是 `overnight`。

## 2. 步骤
1. 补 `package.json` 发布元信息：
   - `name` → `@shaogefenhao/overnight`
   - `description`、`keywords`（如 `ai` `coding-agent` `automation` `opencode` `claude` `night`）
   - `author`、`repository`(url + type git)、`homepage`、`bugs`
   - `publishConfig`：`{ "access": "public" }`（scoped 包默认 private，必须显式公开）
   - `engines.node: ">=20"`（已有，保留）
   - 加 `"scripts": { "prepublishOnly": "npm test" }`（发布前自动跑测试）
2. 加 `LICENSE` 文件（MIT，作者署名 `linksgo2011`）；确认 `package.json.license: "MIT"`
3. 确认 `files` 只含发布所需：`["src"]`（README/LICENSE/package.json 会被 npm 自动带上；`test/`、`docs/`、`queue/`、`logs/`、`.opencode/` **都不发**）
4. 校验打包内容：`npm pack --dry-run` —— 应看到 `src/*.js` + `README.md` + `LICENSE` + `package.json`，**没有** test/docs/queue/logs
5. 本地安装冒烟（不发布）：`npm pack` 生成 tarball → `npm i -g ./shaogefenhao-overnight-*.tgz` → 新终端 `overnight status` 能跑 → 卸载 `npm rm -g @shaogefenhao/overnight`
6. 登录并发布：`npm whoami`（未登录先 `npm login`）→ `npm publish --access public`
7. 验证线上：`npm view @shaogefenhao/overnight version` 有值；`npx @shaogefenhao/overnight status` 能拉起

## 3. 验收
- `npm pack --dry-run` 内容干净（只有 src + README + LICENSE + package.json）
- 全局装 tarball 后 `overnight status` 可用
- `npm view @shaogefenhao/overnight` 能查到，version 与本地一致
- `npx @shaogefenhao/overnight status` 可运行
- 若本次发布失败（版本已存在），**不要删进度文件**——在进度里写清现场，下次 bump `version` 后从第 6 步继续