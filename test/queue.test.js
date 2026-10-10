import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue } from '../src/queue.js';
import { loadConfig } from '../src/config.js';

// 在临时目录里造一个最小项目：queue/*.yaml + docs/plans/*.md
function makeProject(yamlBody, planBodies = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ovn-q-'));
  mkdirSync(join(dir, 'queue'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'plans'), { recursive: true });
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'reports'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'progress'), { recursive: true });
  mkdirSync(join(dir, 'logs', 'decisions'), { recursive: true });
  writeFileSync(join(dir, 'overnight.yaml'), 'schedule:\n  window: null\n');
  writeFileSync(join(dir, 'queue', '001.yaml'), yamlBody);
  for (const [name, body] of Object.entries(planBodies)) {
    writeFileSync(join(dir, 'docs', 'plans', name), body);
  }
  return dir;
}

const plan = (id, extra = {}) => ({
  plans: [{ id, file: `docs/plans/${id}.md`, ...extra }],
});

test('plan id 补零：yaml 里 id: 1 → 内部 001', () => {
  const dir = makeProject(`title: t\nplans:\n  - id: 1\n    title: only\n    file: docs/plans/001.md\n`, {
    '001.md': '# p',
  });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    const jobs = q.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].plans[0].id, '001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('depends_on: [1] 归一成 001，能匹配上', () => {
  const yaml = `title: t
plans:
  - id: 1
    title: a
    file: docs/plans/001.md
  - id: 2
    title: b
    file: docs/plans/002.md
    depends_on: [1]
`;
  const dir = makeProject(yaml, { '001.md': '# a', '002.md': '# b' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    const jobs = q.list();
    assert.deepEqual(jobs[0].plans.map((p) => p.id), ['001', '002']);
    assert.deepEqual(jobs[0].plans[1].depends_on, ['001']);

    // ready(plan 002) 应该要 plan 001 done
    assert.equal(q.ready(jobs[0], jobs[0].plans[1]), false);
    q.markPlan('001', '001', 'done');
    const refreshed = q.list()[0];
    assert.equal(q.ready(refreshed, refreshed.plans[1]), true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('ready()/next()：只有依赖全 done 的 pending 才返回，顺序正确', () => {
  const yaml = `title: t
plans:
  - id: 001
    title: a
    file: docs/plans/001.md
  - id: 002
    title: b
    file: docs/plans/002.md
    depends_on: [001]
  - id: 003
    title: c
    file: docs/plans/003.md
    depends_on: [002]
`;
  const dir = makeProject(yaml, { '001.md': '# a', '002.md': '# b', '003.md': '# c' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);

    // 全 pending：只有 001 ready
    let nxt = q.next();
    assert.equal(nxt.plan.id, '001');

    q.markPlan('001', '001', 'done');
    nxt = q.next();
    assert.equal(nxt.plan.id, '002');

    q.markPlan('001', '002', 'done');
    nxt = q.next();
    assert.equal(nxt.plan.id, '003');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('成环：A↔B 都标 broken，依赖它的保持 pending', () => {
  const yaml = `title: t
plans:
  - id: 001
    title: a
    file: docs/plans/001.md
    depends_on: [002]
  - id: 002
    title: b
    file: docs/plans/002.md
    depends_on: [001]
  - id: 003
    title: c
    file: docs/plans/003.md
    depends_on: [001]
`;
  const dir = makeProject(yaml, { '001.md': '# a', '002.md': '# b', '003.md': '# c' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    const plans = q.list()[0].plans;
    const byId = Object.fromEntries(plans.map((p) => [p.id, p]));

    assert.equal(byId['001'].status, 'broken');
    assert.equal(byId['002'].status, 'broken');
    assert.match(byId['001'].reason, /依赖成环/);
    assert.match(byId['002'].reason, /依赖成环/);
    assert.equal(byId['003'].status, 'pending', '003 依赖 broken 的 001，应保持 pending');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('缺失 file → 该 plan broken 并被跳过', () => {
  const yaml = `title: t
plans:
  - id: 001
    title: ok
    file: docs/plans/001.md
  - id: 002
    title: missing
`;
  const dir = makeProject(yaml, { '001.md': '# a' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    const plans = q.list()[0].plans;
    assert.equal(plans[0].status, 'pending');
    assert.equal(plans[1].status, 'broken');
    assert.match(plans[1].reason, /缺少 file/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('markPlan 写状态 + 持久化', () => {
  const dir = makeProject(`title: t
plans:
  - id: 001
    title: only
    file: docs/plans/001.md
`, { '001.md': '# p' });
  try {
    const cfg = loadConfig(dir);
    const q1 = new Queue(cfg);
    q1.markPlan('001', '001', 'done', { reason: '手工标完' });

    // 重新读
    const q2 = new Queue(cfg);
    const jobs = q2.list();
    assert.equal(jobs[0].plans[0].status, 'done');
    assert.equal(jobs[0].plans[0].reason, '手工标完');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('resetFailed：failed 和卡住的 running 打回 pending', () => {
  const dir = makeProject(`title: t
plans:
  - id: 001
    title: a
    file: docs/plans/001.md
  - id: 002
    title: b
    file: docs/plans/002.md
`, { '001.md': '# a', '002.md': '# b' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    q.markPlan('001', '001', 'failed');
    q.markPlan('001', '002', 'running');
    q.resetFailed();

    const plans = q.list()[0].plans;
    assert.equal(plans[0].status, 'pending');
    assert.equal(plans[1].status, 'pending');
    assert.equal(plans[0].reason, null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('prune：state 里删掉的 plan/队列要清掉', () => {
  const dir = makeProject(`title: t
plans:
  - id: 001
    title: a
    file: docs/plans/001.md
`, { '001.md': '# a' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    q.markPlan('001', '001', 'done');
    q.markPlan('001', '002', 'done');   // 不存在的 plan
    q.markPlan('999', '001', 'done');   // 不存在的 job

    q.prune();

    // 重新读
    const q2 = new Queue(cfg);
    assert.ok(!('002' in (q2.state['001']?.plans || {})));
    assert.ok(!('999' in q2.state));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('依赖的 plan id 不存在 → broken', () => {
  const yaml = `title: t
plans:
  - id: 001
    title: a
    file: docs/plans/001.md
    depends_on: [999]
`;
  const dir = makeProject(yaml, { '001.md': '# a' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    const plans = q.list()[0].plans;
    assert.equal(plans[0].status, 'broken');
    assert.match(plans[0].reason, /依赖的 plan 不存在/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('add：新增队列后 list 能看到', () => {
  const dir = makeProject(`title: t
plans:
  - id: 001
    title: a
    file: docs/plans/001.md
`, { '001.md': '# a' });
  try {
    const cfg = loadConfig(dir);
    const q = new Queue(cfg);
    assert.equal(q.list().length, 1);
    const id = q.add({ title: 'new', planFile: 'docs/plans/new.md' });
    assert.equal(id, '002');
    assert.equal(q.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});