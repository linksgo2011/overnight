// 队列读写：queue/*.yaml（plans 格式）+ state.json
// 一个队列文件 = 一组 plan；每个 plan 有 id/title/file/depends_on（文件内依赖）
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const JOB_STATUS = { PENDING: 'pending', RUNNING: 'running', DONE: 'done', FAILED: 'failed', BROKEN: 'broken' };
const PLAN_STATUS = { PENDING: 'pending', RUNNING: 'running', DONE: 'done', FAILED: 'failed', BROKEN: 'broken' };

export class Queue {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = cfg.paths.queue;
    this.stateFile = join(this.dir, 'state.json');
    this.state = this.#loadState();
    this.listeners = new Set();
  }

  #loadState() {
    if (!existsSync(this.stateFile)) return {};
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  #saveState() {
    // 先写临时文件再 rename，避免写一半断电
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.stateFile);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) {
      try { fn(this.list()); } catch { /* 监听器出错不影响主流程 */ }
    }
  }

  // ---- 解析 ----

  #parseJobs() {
    let files = [];
    try {
      files = readdirSync(this.dir)
        .filter((f) => /\.ya?ml$/i.test(f) && !f.startsWith('_'))
        .sort();
    } catch {
      return [];
    }

    const jobs = [];
    for (const f of files) {
      const jobId = f.replace(/\.ya?ml$/i, '');
      jobs.push(this.#parseJob(jobId, f));
    }
    return jobs;
  }

  #parseJob(jobId, fileName) {
    let raw;
    try {
      raw = YAML.parse(readFileSync(join(this.dir, fileName), 'utf8')) || {};
    } catch (e) {
      return this.#brokenJob(jobId, fileName, `yaml 解析失败: ${e.message}`);
    }

    if (!Array.isArray(raw.plans) || raw.plans.length === 0) {
      return this.#brokenJob(jobId, fileName, 'plans 节点缺失或为空');
    }

    const plans = raw.plans.map((p, i) => this.#parsePlan(jobId, p, i));

    const cycle = this.#findCycle(plans);
    if (cycle.length) {
      for (const c of cycle) {
        c.status = PLAN_STATUS.BROKEN;
        c.reason = `依赖成环: ${cycle.map((x) => x.id).join(' -> ')}`;
      }
    }

    return {
      id: jobId,
      file: fileName,
      title: raw.title || fileName,
      agent: raw.agent || null,          // null = 用默认 agent
      plans,
      broken: null,
    };
  }

  #brokenJob(jobId, fileName, reason) {
    return { id: jobId, file: fileName, title: fileName, agent: null, plans: [], broken: reason };
  }

  #parsePlan(jobId, p, idx) {
    const id = String(p?.id ?? (idx + 1)).
      // YAML 把 001 读成八进制 1，统一补成三位
      replace(/^\d+$/, (m) => m.padStart(3, '0'));
    const plan = {
      id,
      jobId,
      title: p?.title || id,
      relFile: p?.file || null,
      depends_on: Array.isArray(p?.depends_on)
        ? p.depends_on.map(String).map((d) => d.replace(/^\d+$/, (m) => m.padStart(3, '0')))
        : [],
      status: this.state[jobId]?.plans?.[id]?.status || PLAN_STATUS.PENDING,
      reason: this.state[jobId]?.plans?.[id]?.reason || null,
      content: null,
    };

    // 读 plan 文档；缺文件 = broken
    if (plan.relFile) {
      const abs = resolve(this.cfg.paths.root, plan.relFile);
      if (existsSync(abs)) {
        plan.content = readFileSync(abs, 'utf8');
      } else {
        plan.status = PLAN_STATUS.BROKEN;
        plan.reason = `plan 文件不存在: ${plan.relFile}`;
      }
    } else {
      plan.status = PLAN_STATUS.BROKEN;
      plan.reason = '缺少 file 字段';
    }

    // 依赖的 plan id 不存在
    for (const dep of plan.depends_on) {
      if (plan.status === PLAN_STATUS.BROKEN) break;
      // 存在性检查放到 job 级（这里拿不到完整列表），见 #findBrokenDeps
    }
    return plan;
  }

  // 返回成环的 plan 数组（空 = 无环）
  #findCycle(plans) {
    const byId = new Map(plans.map((p) => [p.id, p]));
    const color = new Map(plans.map((p) => [p.id, 0]));   // 0 未访问 / 1 访问中 / 2 完成
    const stack = [];

    const visit = (id) => {
      if (!byId.has(id) || byId.get(id).status === PLAN_STATUS.BROKEN) return [];
      if (color.get(id) === 1) {
        // 找到环：从栈顶往回切到当前 id
        const i = stack.lastIndexOf(id);
        return stack.slice(i).map((x) => byId.get(x));
      }
      if (color.get(id) === 2) return [];
      color.set(id, 1);
      stack.push(id);
      for (const dep of byId.get(id).depends_on) {
        const c = visit(dep);
        if (c.length) return c;
      }
      stack.pop();
      color.set(id, 2);
      return [];
    };

    for (const p of plans) {
      const c = visit(p.id);
      if (c.length) return c;
    }
    return [];
  }

  #brokenDeps(job) {
    const ids = new Set(job.plans.map((p) => p.id));
    for (const p of job.plans) {
      if (p.status === PLAN_STATUS.BROKEN) continue;
      for (const dep of p.depends_on) {
        if (!ids.has(dep)) {
          p.status = PLAN_STATUS.BROKEN;
          p.reason = `依赖的 plan 不存在: ${dep}`;
        }
      }
    }
  }

  // ---- 查询 ----

  list() {
    const jobs = this.#parseJobs();
    for (const j of jobs) {
      if (!j.broken) this.#brokenDeps(j);
      j.status = this.#jobStatus(j);
      if (j.broken) j.status = JOB_STATUS.BROKEN;
    }
    return this.#sorted(jobs);
  }

  #jobStatus(job) {
    if (job.broken) return JOB_STATUS.BROKEN;
    const s = job.plans.map((p) => p.status);
    if (s.some((x) => x === PLAN_STATUS.RUNNING)) return JOB_STATUS.RUNNING;
    if (s.every((x) => x === PLAN_STATUS.DONE)) return JOB_STATUS.DONE;
    if (s.some((x) => x === PLAN_STATUS.FAILED || x === PLAN_STATUS.BROKEN)) return JOB_STATUS.FAILED;
    return JOB_STATUS.PENDING;
  }

  // 下一个能执行的 plan：{ job, plan } 或 null
  // 依赖没解完的（含依赖失败/成环）不会返回
  next() {
    for (const job of this.list()) {
      if (job.broken) continue;
      for (const plan of job.plans) {
        if (plan.status !== PLAN_STATUS.PENDING) continue;
        if (this.ready(job, plan)) return { job, plan };
      }
    }
    return null;
  }

  // plan 的 depends_on 全部为 done
  ready(job, plan) {
    if (plan.status !== PLAN_STATUS.PENDING) return false;
    for (const dep of plan.depends_on) {
      const d = job.plans.find((p) => p.id === dep);
      if (!d || d.status !== PLAN_STATUS.DONE) return false;
    }
    return true;
  }

  // 新会话开始时：把失败的 plan 打回 pending，让它们今晚/下轮重新尝试
  resetFailed() {
    let changed = false;
    for (const job of this.#parseJobs()) {
      if (job.broken) continue;
      for (const p of job.plans) {
        if (p.status === PLAN_STATUS.FAILED && this.state[job.id]?.plans?.[p.id]) {
          this.state[job.id].plans[p.id].status = PLAN_STATUS.PENDING;
          this.state[job.id].plans[p.id].reason = null;
          changed = true;
        }
      }
    }
    if (changed) this.#saveState();
  }

  // ---- 操作 ----

  // 新增一个队列文件（引用已存在的 plan 文档）
  add({ title, planFile, agent = null }) {
    let n = 1;
    while (existsSync(join(this.dir, `${String(n).padStart(3, '0')}.yaml`))) n++;
    const jobId = String(n).padStart(3, '0');
    const body = {
      title,
      ...(agent ? { agent } : {}),
      plans: [{
        id: '001',
        title,
        file: planFile,
        depends_on: [],
      }],
    };
    writeFileSync(join(this.dir, `${jobId}.yaml`), YAML.stringify(body, null, 2), 'utf8');
    this.#emit();
    return jobId;
  }

  remove(jobId) {
    const f = join(this.dir, `${jobId}.yaml`);
    if (!existsSync(f)) return false;
    unlinkSync(f);
    delete this.state[jobId];
    this.#saveState();
    this.#emit();
    return true;
  }

  markPlan(jobId, planId, status, extra = {}) {
    const jobState = (this.state[jobId] ||= { plans: {} });
    jobState.plans[planId] = { status, at: new Date().toISOString(), ...extra };
    this.#saveState();
    this.#emit();
  }

  // 任务文件被删了，state 里对应的记录清掉
  prune() {
    const jobs = this.#parseJobs();
    const jobIds = new Set(jobs.map((j) => j.id));
    let changed = false;

    for (const id of Object.keys(this.state)) {
      if (id === '__order') continue;
      if (!jobIds.has(id)) { delete this.state[id]; changed = true; }
    }

    // 文件内删掉的 plan，清掉对应状态
    for (const job of jobs) {
      const st = this.state[job.id];
      if (!st?.plans) continue;
      const alive = new Set(job.plans.map((p) => p.id));
      for (const pid of Object.keys(st.plans)) {
        if (!alive.has(pid)) { delete st.plans[pid]; changed = true; }
      }
    }

    // 顺序表里删掉已经不存在的 id
    if (Array.isArray(this.state.__order)) {
      const before = this.state.__order.length;
      this.state.__order = this.state.__order.filter((id) => jobIds.has(id));
      if (this.state.__order.length !== before) changed = true;
    }

    if (changed) this.#saveState();
  }

  // ---- 排序 ----

  // state.json 里记的顺序优先，没记的按文件名追加
  #sorted(jobs) {
    const order = this.state.__order || [];
    const rank = (id) => {
      const i = order.indexOf(id);
      return i === -1 ? 1e9 : i;
    };
    return [...jobs].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }
}