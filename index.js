#!/usr/bin/env node
// overnight — 让 AI 上夜班。把 coding agent 的 plan 排进队列，按时自动跑。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseWindow, inWindow } from './config.js';
import { Queue } from './queue.js';
import { Runner, sleep } from './runner.js';
import { appendReport } from './agents.js';
import { TUI } from './tui.js';

const argv = process.argv.slice(2);
const CMD = argv[0] || 'run';

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
    if (!argv[1]) {
      console.error('用法: overnight add "要做的事" [agent]');
      process.exit(1);
    }
    // 最后一个参数是已知 agent 名时当 agent 用，其余拼成 prompt
    const known = Object.keys(cfg.agents);
    let prompt, agent = null;
    if (argv.length >= 3 && known.includes(argv[argv.length - 1])) {
      agent = argv.pop();
      prompt = argv.slice(1).join(' ');
    } else {
      prompt = argv.slice(1).join(' ');
    }
    console.log('已加入: ' + queue.add(prompt, agent));
    break;
  default:
    run();
}

function init() {
  console.log(existsSync('overnight.yaml') ? 'overnight.yaml 已存在' : '没有 overnight.yaml，会用默认配置运行。');
  console.log('\n用法:');
  console.log('  overnight              启动，进分屏日志界面');
  console.log('  overnight add "计划"    往队列加一个任务（plan 要能重复执行）');
  console.log('  overnight status       看队列');
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
    console.log(`  ${j.id}  ${j.status.padEnd(9)} ${j.prompt.split('\n')[0].slice(0, 60)}`);
  }
  console.log('');
}

// ---------- 主循环 ----------

async function run() {
  const win = parseWindow(cfg.schedule.window);
  const label = () => {
    if (!win) return '全天';
    return inWindow(win) ? '窗口内' : '窗外';
  };
  state.windowLabel = label();

  const tui = new TUI(cfg, { queue, state });
  const runner = new Runner(cfg, {
    log: (l) => tui.log(l),
    onAgentOutput: (s) => tui.agentOutput(s),
  });

  (async () => {
    while (true) {
      try {
        state.windowLabel = label();

        // 有任务在跑就等它跑完（跑起来的任务不打断）
        if (state.current) { await sleep(20_000); continue; }

        // 窗口只决定要不要开新任务；全天时 win=null，直接放行
        if (win && !inWindow(win)) { await sleep(60_000); continue; }

        queue.prune();
        const job = queue.next();
        if (!job) { await sleep(cfg.schedule.idleSleepMs); continue; }

        state.current = { id: job.id, startedAt: Date.now() };
        queue.mark(job.id, 'running');
        appendReport(cfg, `\n## 开始 — ${job.id}\n- ${job.prompt.slice(0, 200)}\n- agent: ${job.agent || cfg.default_agent}\n`);

        const res = await runner.run(job);

        state.current = null;
        queue.mark(job.id, res.status, { reason: res.reason });
        tui.log(`[${job.id}] ${res.status}${res.reason ? ' — ' + res.reason : ''}`);

        await sleep(1000);
      } catch (e) {
        tui.log('主循环出错: ' + e.message);
        await sleep(60_000);
      }
    }
  })();

  tui.start();
}
