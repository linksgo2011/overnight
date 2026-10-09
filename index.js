#!/usr/bin/env node
// T3 — coding agent 的看护进程
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseWindow, inWindow } from './config.js';
import { Queue } from './queue.js';
import { Guard, sleep } from './guard.js';
import { appendReport, askAI } from './agents.js';
import { TUI } from './tui.js';

const argv = process.argv.slice(2);
const CMD = argv[0] || 'run';

const cfg = loadConfig();
const queue = new Queue(cfg);
cfg._inWindow = () => inWindow(cfg._window);

const state = { paused: false, current: null, lastAction: null };

// ---------- 子命令 ----------

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
      console.error('用法: t3 add "要做的事" [agent]');
      process.exit(1);
    }
    console.log('已加入: ' + queue.add(argv.slice(1).join(' '), argv[2] || null));
    break;
  default:
    run();
}

function init() {
  if (existsSync('t3.yaml')) {
    console.log('t3.yaml 已存在');
  } else {
    console.log('没有 t3.yaml。参考 docs/strategy/t3-strategy-design.md 里的配置写一份。');
  }
  console.log('\n用法:');
  console.log('  t3              启动，进 TUI');
  console.log('  t3 add "要做的事"   往队列加一个任务');
  console.log('  t3 status       看队列');
  console.log('  t3 logs         看今天的报告');
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
  cfg._window = parseWindow(cfg.schedule.window);

  const tui = new TUI(cfg, {
    queue,
    state,
    onCommand: handleAction,
  });

  const guard = new Guard(cfg, { log: (l) => tui.log(l) });

  // 主循环后台跑，TUI 只管显示
  (async () => {
    while (true) {
      try {
        // 已经有任务在跑就一直等，窗口检查交给 guard 内部的定时器
        if (state.current) { await sleep(30_000); continue; }

        if (!cfg._inWindow()) { await sleep(300_000); continue; }
        if (state.paused) { await sleep(60_000); continue; }

        queue.prune();
        const job = queue.next();

        if (!job) {
          await sleep(cfg.schedule.idleSleepMs);
          continue;
        }

        state.current = { id: job.id, startedAt: Date.now() };
        queue.mark(job.id, 'running');
        appendReport(cfg, `\n## 开始 — ${job.id}\n- ${job.prompt.slice(0, 200)}\n- agent: ${job.agent || cfg.default_agent}\n`);

        const res = await guard.run(job);

        state.current = null;
        queue.mark(job.id, res.status, { reason: res.reason });
        tui.log(`[${job.id}] ${res.status}${res.reason ? ' — ' + res.reason : ''}`);

        // deferred（窗口关了被收尾）重置成 pending，下轮继续跑
        if (res.status === 'deferred') queue.mark(job.id, 'pending', {});

        await sleep(1000);
      } catch (e) {
        tui.log('主循环出错: ' + e.message);
        await sleep(60_000);
      }
    }
  })();

  tui.start();
}

// ---------- 聊天里的操作 ----------

// 结果统一进 TUI 对话区，console.log 会被 clear() 擦掉
function say(msg) {
  state.lastAction = msg;
}

async function handleAction(action, arg) {
  switch (action) {
    case 'add':
      if (!arg) return;
      say(`加了任务 ${queue.add(arg)}`);
      break;
    case 'delete': {
      const id = matchId(arg);
      if (!id) return;
      say(queue.remove(id) ? `删了 ${id}` : `没找到 ${id}`);
      break;
    }
    case 'reorder_first': {
      const id = matchId(arg);
      if (!id) return;
      say(queue.reorder(id, 'first') ? `${id} 提到最前` : `${id} 现在跑不了，等这单结束`);
      break;
    }
    case 'reorder_last': {
      const id = matchId(arg);
      if (!id) return;
      say(queue.reorder(id, 'last') ? `${id} 排到最后` : `${id} 现在跑不了，等这单结束`);
      break;
    }
    case 'toggle':
      state.paused = !state.paused;
      say(state.paused ? '好，暂停派单' : '好，恢复派单');
      break;
    default:
      say('不认识这个操作: ' + action);
  }
}

// "把 003 提上来" -> "003"
function matchId(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{3})/);
  return m ? m[1] : null;
}
