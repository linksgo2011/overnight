// 队列读写：queue/*.yaml + state.json
import { readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

// queue/001.yaml -> id 001
// state.json 记录跑过的状态
export class Queue {
  constructor(cfg) {
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

  #parseFiles() {
    let files = [];
    try {
      files = readdirSync(this.dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
    } catch {
      return [];
    }

    const jobs = [];
    for (const f of files) {
      const id = f.replace(/\.ya?ml$/i, '');
      try {
        const raw = YAML.parse(readFileSync(join(this.dir, f), 'utf8')) || {};
        if (!raw.prompt || !String(raw.prompt).trim()) continue;
        jobs.push({
          id,
          file: f,
          prompt: String(raw.prompt).trim(),
          agent: raw.agent || null,       // null = 用默认 agent
          status: this.state[id]?.status || 'pending',
          lastError: this.state[id]?.lastError || null,
        });
      } catch (e) {
        // yaml 坏了也要显示出来，不然 TUI 上凭空少一个
        jobs.push({
          id, file: f, prompt: '(解析失败: ' + e.message + ')',
          agent: null, status: 'broken', lastError: e.message,
        });
      }
    }
    return jobs;
  }

  list() {
    return this.#sorted(this.#parseFiles());
  }

  // 下一个要跑的：按顺序第一个 pending
  next() {
    return this.list().find((j) => j.status === 'pending') || null;
  }

  // 按 id 调整顺序：顺序存在 state.json 里，不动文件
  reorder(id, position = 'first') {
    const pending = this.#parseFiles()
      .filter((j) => j.status === 'pending')
      .map((j) => j.id);
    if (!pending.includes(id)) return false;

    const rest = pending.filter((x) => x !== id);
    this.state.__order = position === 'first'
      ? [id, ...rest]
      : [...rest, id];
    this.#saveState();
    this.#emit();
    return true;
  }

  // state.json 里记的顺序优先，没记的按文件名追加
  #sorted(jobs) {
    const order = this.state.__order || [];
    const rank = (id) => {
      const i = order.indexOf(id);
      return i === -1 ? 1e9 : i;
    };
    return [...jobs].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  }

  add(prompt, agent = null) {
    // 找下一个可用编号
    let n = 1;
    while (existsSync(join(this.dir, `${String(n).padStart(3, '0')}.yaml`))) n++;

    const id = String(n).padStart(3, '0');
    const body = { prompt: String(prompt).trim() };
    if (agent) body.agent = agent;
    writeFileSync(join(this.dir, `${id}.yaml`), YAML.stringify(body), 'utf8');
    this.#emit();
    return id;
  }

  remove(id) {
    const f = join(this.dir, `${id}.yaml`);
    if (!existsSync(f)) return false;
    unlinkSync(f);
    delete this.state[id];
    this.#saveState();
    this.#emit();
    return true;
  }

  mark(id, status, extra = {}) {
    this.state[id] = { status, at: new Date().toISOString(), ...extra };
    this.#saveState();
    this.#emit();
  }

  // 任务文件被删了，state 里对应的记录清掉
  prune() {
    const ids = new Set(this.#parseFiles().map((j) => j.id));
    let changed = false;

    for (const id of Object.keys(this.state)) {
      if (id === '__order') continue;
      if (!ids.has(id)) { delete this.state[id]; changed = true; }
    }

    // 顺序表里删掉已经不存在的 id，新文件追加到末尾
    if (Array.isArray(this.state.__order)) {
      const before = this.state.__order.length;
      this.state.__order = this.state.__order.filter((id) => ids.has(id));
      if (this.state.__order.length !== before) changed = true;
    }

    if (changed) this.#saveState();
  }
}
