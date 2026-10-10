// Runner 单测：用 fake agent（spawn 临时脚本，行为可控）+ 短超时覆盖 runner 全部路径。
// 设计：不碰源码，构造后覆盖 `this.agent`；不在公开 API 上做手脚。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runner, classifyExit } from '../src/runner.js';
import { loadConfig } from '../src/config.js';

function makeProject({ timeout = '10s', idleKill = '5s', retryMax = 3, backoff = '10ms' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-r-'));
  mkdirSync(join(dir, 'queue'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'progress'), { recursive: true });
  mkdirSync(join(dir, 'logs', 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'overnight.yaml'),
    `runner:\n  timeout: ${timeout}\n  idle_kill: ${idleKill}\n  tail_lines: 20\n` +
    `  decision_log_dir: logs/decisions\n` +
    `  prompt_template: '执行 {plan_file}，日志到 {decision_log_dir}'\n` +
    `schedule:\n  window: null\n  idle_sleep: 1s\n` +
    `retry:\n  max: ${retryMax}\n  backoff: ${backoff}\n`);
  writeFileSync(join(dir, 'queue', '001.yaml'),
    'title: t\nplans:\n  - id: 001\n    file: docs/plans/001.md\n');
  writeFileSync(join(dir, 'docs', 'plans', '001.md'), '# x');
  return dir;
}

// 写一个 fake agent 脚本
function writeFakeAgent(dir, script) {
  const p = join(dir, 'fake-agent.sh');
  writeFileSync(p, script, { mode: 0o755 });
  return p;
}

// 起 runner，但把 this.agent 替换成一个能起 fake script 的简化版
// 真 spawn 还是要走，但 cmd/args 由我们造
function buildRunner(cfg, fakeCmd, fakeArgs, { onLog } = {}) {
  const r = new Runner(cfg, { log: onLog || (() => {}), onAgentOutput: () => {} });
  r.agent = {
    run(name, prompt, { onOutput } = {}) {
      const proc = spawn(fakeCmd, fakeArgs, {
        env: { ...process.env, PROMPT: prompt },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      let buf = '', errBuf = '';
      proc.stdout.on('data', (d) => { buf += d.toString(); onOutput?.(d.toString(), false); });
      proc.stderr.on('data', (d) => { errBuf += d.toString(); onOutput?.(d.toString(), true); });
      return {
        name, command: `${fakeCmd} ${fakeArgs.join(' ')}`,
        proc,
        get output() { return buf; },
        get stderr() { return errBuf; },
        pid: proc.pid,
      };
    },
    kill(handle) {
      if (!handle?.proc || handle._killed) return;
      const pid = handle.proc.pid;
      if (pid == null) return;
      handle._killed = true;
      try { process.kill(-pid, 'SIGKILL'); } catch { try { handle.proc.kill('SIGKILL'); } catch {} }
    },
    drainKills() { return Promise.resolve(); },
  };
  return r;
}

const job = { id: '001', agent: null };
const plan = (content = '# 假 plan\nbody') => ({
  id: '001',
  jobId: '001',
  title: 'p',
  relFile: 'docs/plans/001.md',
  depends_on: [],
  status: 'pending',
  reason: null,
  content,
});

// ---- buildPrompt ----

test('buildPrompt：替换占位符并追加 plan 全文', () => {
  const dir = makeProject();
  try {
    const cfg = loadConfig(dir);
    const r = new Runner(cfg, { log: () => {}, onAgentOutput: () => {} });
    const p = plan('PLAN BODY');
    const prompt = r.buildPrompt(p);

    assert.match(prompt, /docs\/plans\/001\.md/, '{plan_file} 替换了');
    assert.match(prompt, /logs\/decisions/, '{decision_log_dir} 替换了');
    assert.match(prompt, /--- plan 内容 ---/);
    assert.match(prompt, /PLAN BODY/, 'plan 全文已追加');
    assert.ok(prompt.indexOf('plan 内容') < prompt.indexOf('PLAN BODY'),
      'plan 内容在 plan 文件全文之前');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ---- classifyExit ----

test('classifyExit: 关键字识别', () => {
  assert.equal(classifyExit(1, null, 'Out of memory'), '内存爆了 (OOM)');
  assert.equal(classifyExit(1, null, 'ENOMEM: cannot allocate'), '内存爆了 (OOM)');
  assert.equal(classifyExit(137, null, ''), '内存爆了 (OOM)');
  assert.equal(classifyExit(143, null, ''), '被正常终止 (SIGTERM)');
  assert.equal(classifyExit(1, 'SIGKILL', ''), '被信号 SIGKILL 杀掉');
  assert.equal(classifyExit(1, null, 'ECONNREFUSED 127.0.0.1'), '网络不通');
  assert.equal(classifyExit(1, null, 'rate limit 429'), 'API 限流 / 额度用完');
  assert.equal(classifyExit(1, null, ''), '进程异常退出 (code 1)');
});

// ---- runPlan：成功 / 重试 / OOM / 卡死 ----

test('runPlan: exit 0 → done, attempts=1', async () => {
  const dir = makeProject();
  try {
    const cfg = loadConfig(dir);
    const script = writeFakeAgent(dir, '#!/bin/sh\necho hi\nexit 0\n');
    const r = buildRunner(cfg, script, []);

    const res = await r.runPlan(job, plan('# x'));
    assert.equal(res.status, 'done');
    assert.equal(res.attempts, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runPlan: 一直失败 → 试到 retry.max 后 status=failed', async () => {
  const dir = makeProject({ retryMax: 3 });
  try {
    const cfg = loadConfig(dir);
    const script = writeFakeAgent(dir, '#!/bin/sh\necho oops 1>&2\nexit 1\n');
    const r = buildRunner(cfg, script, []);

    const res = await r.runPlan(job, plan('# x'));
    assert.equal(res.status, 'failed');
    assert.equal(res.attempts, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runPlan: OOM 关键字 → 失败日志里有"内存爆了"', async () => {
  const dir = makeProject({ retryMax: 1 });
  try {
    const cfg = loadConfig(dir);
    const script = writeFakeAgent(dir,
      '#!/bin/sh\necho "JavaScript heap out of memory" 1>&2\nexit 1\n');

    const logs = [];
    const r = buildRunner(cfg, script, [], { onLog: (l) => logs.push(l) });
    const res = await r.runPlan(job, plan('# x'));

    assert.equal(res.status, 'failed');
    assert.equal(res.attempts, 1);
    assert.ok(logs.some((l) => /内存爆了/.test(l)),
      `runner 日志应含"内存爆了"，实际: ${JSON.stringify(logs)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runPlan: 卡死 — idle_kill 触发 → 日志含"卡死"', async () => {
  const dir = makeProject({ timeout: '30s', idleKill: '300ms', retryMax: 1 });
  try {
    const cfg = loadConfig(dir);
    // sleep > idle_kill 但 < timeout → 应该被 idle_kill 干掉
    const script = writeFakeAgent(dir, '#!/bin/sh\nsleep 5\nexit 0\n');

    const logs = [];
    const r = buildRunner(cfg, script, [], { onLog: (l) => logs.push(l) });
    const res = await r.runPlan(job, plan('# x'));

    assert.equal(res.status, 'failed');
    assert.ok(logs.some((l) => /卡死/.test(l)),
      `runner 日志应含"卡死"，实际: ${JSON.stringify(logs)}`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runPlan: 重试间隔生效（两次尝试至少等 backoffMs）', async () => {
  const dir = makeProject({ retryMax: 2, backoff: '80ms' });
  try {
    const cfg = loadConfig(dir);
    const script = writeFakeAgent(dir, '#!/bin/sh\nexit 1\n');
    const r = buildRunner(cfg, script, []);

    const t0 = Date.now();
    const res = await r.runPlan(job, plan('# x'));
    const dur = Date.now() - t0;

    assert.equal(res.status, 'failed');
    assert.equal(res.attempts, 2);
    assert.ok(dur >= 70, `两次尝试之间至少 80ms backoff，实际 ${dur}ms`);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runPlan: 第二次成功 → status=done, attempts=2', async () => {
  const dir = makeProject({ retryMax: 3, backoff: '20ms' });
  try {
    const cfg = loadConfig(dir);
    // 用状态文件记第几次：第 1 次 fail、第 2 次 ok
    writeFakeAgent(dir,
      '#!/bin/sh\n' +
      'F=/tmp/ovn-flaky-' + dir.replace(/[^0-9a-z]/gi, '') + '.n\n' +
      'if [ -f "$F" ]; then exit 0; fi\n' +
      'echo "$RANDOM" > "$F"\nexit 1\n');

    const r = buildRunner(cfg, 'sleep 1', []);
    // 上面脚本是用 sh 跑的；改用 spawn /bin/sh 直接喂脚本内容
    r.agent.run = (name, prompt, { onOutput } = {}) => {
      const proc = spawn('/bin/sh', ['-c', `F=/tmp/ovn-flaky-${dir.replace(/[^0-9a-z]/gi, '')}.n
if [ -f "$F" ]; then exit 0; fi
echo $RANDOM > "$F"
exit 1`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let buf = '';
      proc.stdout.on('data', (d) => { buf += d.toString(); onOutput?.(d.toString(), false); });
      return { name: 'flaky', command: 'flaky', proc, get output() { return buf; }, get stderr() { return ''; }, pid: proc.pid };
    };

    const res = await r.runPlan(job, plan('# x'));
    assert.equal(res.status, 'done');
    assert.equal(res.attempts, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('runPlan: 把失败原因写到 reports/{date}.md', async () => {
  const dir = makeProject({ retryMax: 1 });
  try {
    const cfg = loadConfig(dir);
    const script = writeFakeAgent(dir, '#!/bin/sh\nexit 1\n');
    const r = buildRunner(cfg, script, []);
    await r.runPlan(job, plan('# x'));

    // reports 目录里应该有一个今天的 md，且含 plan id
    const { readdirSync, readFileSync } = await import('node:fs');
    const files = readdirSync(cfg.paths.reports).filter((f) => f.endsWith('.md'));
    assert.ok(files.length >= 1, `reports 目录应有 md 文件，实际: ${JSON.stringify(files)}`);
    const body = files.map((f) => readFileSync(join(cfg.paths.reports, f), 'utf8')).join('\n');
    assert.match(body, /001\/001/, '报告里应有 job/plan id');
    assert.match(body, /失败|重试/, '报告里应有"失败"/"重试"');
  } finally {
    rmSync(dir, { recursive: true });
  }
});