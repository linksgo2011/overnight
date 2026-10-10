# plan 001 — 把硬编码密钥迁到环境变量

> 执行第一条：用 dev-build 维护进度，**这个 plan 必须能安全重跑**。
> 先读进度文件 `docs/progress/001-keys-to-env.progress.md` 和现状（git status / git diff），做过的跳过，别重复。

## 1. 现状检查
先跑下面两个命令，确认已经做到哪一步了：
- `git status` — 看工作区改了哪些文件
- `git diff` — 看改动内容，判断哪些步骤已完成

## 2. 步骤
1. 搜索代码里的硬编码密钥（搜 `sk-`、`password`、`secret`、`_KEY=` 等）
2. 新建 `config/env.ts`，用 `dotenv` 载入 `process.env.*`
3. 把密钥替换成 `process.env.XXX` 引用
4. 把变量名写进 `.env.example`（**只写名字，不写真实值**）
5. 跑 `npm test` 确认没挂

## 3. 验收
- `git grep` 搜不到真实密钥值
- 测试全部通过
- `.env.example` 里只有占位的变量名