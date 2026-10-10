---
name: dev-plan
description: Use when the user wants a requirement or feature to be turned into one or more repeatable plan documents. Triggers on "写 plan", "拆解需求", "计划一下", "dev-plan", "规划一下怎么做", or requests to plan an implementation before building.
---

# dev-plan — 需求 → 可重复执行的 plan

把需求拆成一个个 plan 文档（`docs/plans/NNN-name.md`），每个 plan 都能被 `dev-build`
安全地重复执行：失败重跑、夜间续跑都不会重复劳动。

## 你的职责

只产 plan 文档，**不写实现代码**。产出物：

1. 一组 plan 文档（每个一行目标）
2. （可选）一个 `queue/NNN.yaml` 把它们串成执行顺序

## 第一步：澄清需求

写 plan 前先确认，说不清楚就问：

- **目标**：要达成什么，不接受什么
- **范围**：涉及哪些文件/模块，边界在哪
- **验收**：怎么算完成（可跑可测）
- **约束**：技术栈、依赖、不能碰的东西

## 第二步：拆组

- **一个 plan = 一个目标**。目标大了就拆多个，用 queue 文件的 `depends_on` 表达先后关系。
- 有依赖的放后面；能独立的别硬排队。
- 数量建议 3~7 个，扛得住一次夜间跑完。

## 第三步：写 plan 文档

每个 plan 写到 `docs/plans/NNN-name.md`，固定结构：

```markdown
# plan 001 — <目标>

> 执行第一条：用 dev-build 维护进度（docs/progress/），这个 plan 必须能安全重跑。
> 先读进度文件 <docs/progress/NNN-name.progress.md> 和现状（git status / git diff），做过的跳过。

## 1. 现状检查
- 开头先跑什么命令确认基线，判断已经做到哪了

## 2. 步骤
1. （稳定编号，每步一个可 check 的原子动作）
2. （下一步…）
3. （…）

## 3. 验收
- （可测试的标准，agent 自己跑完能确认）
```

纪律：

- **步骤必须稳定编号**：进度文件按它记，跳号/改号会让续跑乱掉。
- **每步可 check**：agent 能判断这步做没做，而不是"尽量优化一下"。
- **验收要能跑**：写具体命令/断言，别写"保证质量"。
- **写清续跑讯号**：如果 plan 可能分多次跑，注明"可以从第 X 步继续"。

## 第四步：串成队列（可选）

如果这批 plan 要交给 overnight 排夜间跑，创建 `queue/NNN.yaml`：

```yaml
title: <这组任务的名字>
agent: opencode          # 可选

plans:
  - id: 001
    title: <plan 标题，需能安全重跑>
    file: docs/plans/001-name.md
    depends_on: []
  - id: 002
    title: <依赖 001 的 plan>
    file: docs/plans/002-name.md
    depends_on: [001]
```

否则只写 plan 文档，让用户自行决定执行方式。

## 产出后

告诉用户：plan 写在哪个文件、用 `dev-build` 执行、要跑夜间就运行 `overnight`。