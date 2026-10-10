#!/usr/bin/env node
// overnight — 让 AI 上夜班。queue 里的一组 plan 排好队，到点自动串行执行。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadConfig, parseWindow, inWindow } from './config.js';
import { Queue } from './queue.js';
import { Runner, sleep } from './runner.js';
import { appendReport } from './agents.js';
import { TUI } from './tui.js';

const argv = process.argv.slice(2);
const CMD = argv[0] || 'run';

const PLAN_STATUS_TEXT = { done: 'done', failed: 'FAILED', broken: 'broken', running: 'RUNNING', pending: 'pending' };

const cfg = loadConfig();
const queue = new Queue(cfg);

const state = { current: null, paused: false, windowLabel: '—' };

switch (CMD) {
  case 'init':
    init();
    break;
  case 'logs':
  case 'report':
    showReport(argv[1]);
    break;
  case 'status':
    showStatus();
    break;
  case 'add':
    add();
    break;
  default:
    run();
}

function init() {
  console.log(existsSync('overnight.yaml') ? 'overnight.yaml 已存在' : '没有 overnight.yaml，会用默认配置运行。');
  console.log('\n用法:');
  console.log('  overnight              启动，进分屏日志界面');
  console.log('  overnight add "标题"    建一个队列任务（自动生成 plan 骨架）');
  console.log('  overnight status       看队列（按 plan 树）');
  console.log('  overnight logs         看今天的报告');
  process.exit(0);
}

function showReport(day) {
  const d = day || new Date().toISOString().slice(0, 10);
  const f = join(cfg.paths.reports, `${d}.md`);
  if (!existsSync(f)) { console.log(`没有 ${d} 的报告`); process.exit(0); }
  console.log(readFileSync(f, 'utf8'));
}

function showStatus() {
  const jobs = queue.list();
  console.log(`\n队列 ${jobs.length} 条：\n`);
  for (const j of jobs) {
    console.log(`  ${j.id}  ${j.status.padEnd(7)} ${j.title}`);
    if (j.broken) {
      console.log(dim(`      ! ${j.broken}`));
      continue;
    }
    for (const p of j.plans) {
      const st = PLAN_STATUS_TEXT[p.status] || p.status;
      const dep = p.depends_on.length ? dim(` (depends_on: ${p.depends_on.join(',')})`) : '';
      const re = p.reason ? dim(` — ${p.reason}`) : '';
      console.log(`      ${st.padEnd(8)} ${p.id}  ${p.title}${dep}${re}`);
    }
  }
  console.log('');
}

function dim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}

// ---- add：生成 plan 骨架 + 队列文件 ----

function slugify(s) {
  const slug = String(s).toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'plan';
}

function add() {
  const args = argv.slice(1);
  if (!args.length) {
    console.error('用法: overnight add "标题" [agent]');
    process.exit(1);
  }
  // 最后一个参数是已知 agent 名时当该 job 的 agent 用
  let title, agent = null;
  if (args.length >= 2 && cfg.agents[args[args.length - 1]]) {
    agent = args.pop();
  }
  title = args.join(' ');

  // 下一个可用编号（和 queue.add 的算法一致）
  let n = 1;
  while (existsSync(join(cfg.paths.queue, `${String(n).padStart(3, '0')}.yaml`))) n++;
  const jobId = String(n).padStart(3, '0');
  const planFile = `docs/plans/${jobId}-${slugify(title)}.md`;

  writeFileSync(join(cfg.paths.root, planFile), planSkeleton(title, planFile), 'utf8');
  const id = queue.add({ title, planFile, agent });
  console.log(`已加入: ${id}`);
  console.log(`  queue 文件: queue/${id}.yaml`);
  console.log(`  plan 文档:  ${planFile}（自己补步骤和验收）`);
  process.exit(0);
}

function planSkeleton(title, planFile) {
  const progress = planFile.replace(/^docs\/plans\//, 'docs/progress/').replace(/\.md$/, '.progress.md');
  return `# plan 001 — ${title}

> 执行第一条：用 dev-build 维护进度，**这个 plan 必须能安全重跑**。
> 先读进度文件 \`${progress}\` 和现状（git status / git diff），做过的跳过，别重复。

## 1. 现状检查
- 「运行指令」确认现在的基线

## 2. 步骤
1. （第一步）
2. （第二步）

## 3. 验收
- （可测试的标准）
`;
}

// ---- 主循环 ----

async function run() {
  const win = parseWindow(cfg.schedule.window);
  const label = () => {
    if (!win) return '全天';
    return inWindow(win) ? '窗口内' : '窗外';
  };
  state.windowLabel = label();

  // 新会话：把之前失败的 plan 打回 pending，给它们新的尝试
  queue.resetFailed();
  queue.prune();

  const tui = new TUI(cfg, { queue, state });
  const runner = new Runner(cfg, {
    log: (l) => tui.log(l),
    onAgentOutput: (s) => tui.agentOutput(s),
  });

  (async () => {
    while (true) {
      try {
        state.windowLabel = label();

        // 有 plan 在跑就等它跑完（跑起来的任务不打断）
        if (state.current) { await sleep(20_000); continue; }

        // 窗口只决定要不要开新任务
        if (win && !inWindow(win)) { await sleep(60_000); continue; }

        queue.prune();
        const nxt = queue.next();       // { job, plan } 或 null
        if (!nxt) { await sleep(cfg.schedule.idleSleepMs); continue; }

        const { job, plan } = nxt;
        state.current = { jobId: job.id, planId: plan.id, startedAt: Date.now() };
        queue.markPlan(job.id, plan.id, 'running');
        appendReport(cfg, `\n## 开始 — ${job.id}/${plan.id} (${plan.title})\n`
          + `- plan: ${plan.relFile}\n- agent: ${job.agent || cfg.default_agent}\n`);

        const res = await runner.runPlan(job, plan);

        state.current = null;
        queue.markPlan(job.id, plan.id, res.status, { reason: res.attempts > 1 ? `尝试了 ${res.attempts} 次` : null });
        tui.log(`[${job.id}/${plan.id}] ${res.status}${res.reason ? ' — ' + res.reason : ''}`);

        await sleep(1000);
      } catch (e) {
        tui.log('主循环出错: ' + e.message);
        await sleep(60_000);
      }
    }
  })();

  tui.start();
}