// 多 agent 适配（opencode / claude code ...）
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export class Agent {
  constructor(cfg) {
    this.cfg = cfg;
    this.templates = cfg.agents;
  }

  resolve(name) {
    const key = name || this.cfg.default_agent;
    const tpl = this.templates[key];
    if (!tpl) {
      const known = Object.keys(this.templates).join(', ');
      throw new Error(`没配置 agent "${key}"。已知的: ${known}`);
    }
    return { name: key, ...tpl };
  }

  // 起一个 agent 跑 prompt，收集输出
  run(name, prompt, { onOutput } = {}) {
    const tpl = this.resolve(name);

    // 数组传参，prompt 里的空格引号不会炸
    const args = tpl.args.map((a) => String(a).replace('{prompt}', prompt));

    // spawn 不认 ~，手动展开
    const cmd = String(tpl.command).replace(/^~(?=\/|$)/, homedir());

    const proc = spawn(cmd, args, {
      cwd: this.cfg.paths.root,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组，这样 kill 能连带干掉 agent 起的子进程
      detached: true,
    });

    let buf = '';
    let errBuf = '';
    const push = (s, isErr) => {
      buf += s;
      if (isErr) errBuf += s;
      onOutput?.(s, isErr);
    };

    proc.stdout.on('data', (d) => push(d.toString(), false));
    proc.stderr.on('data', (d) => push(d.toString(), true));

    return {
      name: tpl.name,
      command: `${tpl.command} ${tpl.args.map((a) => String(a).replace('{prompt}', '"…"')).join(' ')}`,
      proc,
      get output() { return buf; },
      get stderr() { return errBuf; },
      pid: proc.pid,
    };
  }

  // 杀掉整个进程组：agent 起的子进程（dev server、测试进程）也得死
  kill(handle, { graceMs = 3000 } = {}) {
    if (!handle?.proc || handle._killed) return;
    const pid = handle.proc.pid;
    if (pid == null) return;
    handle._killed = true;

    // agent 自己可能不转发信号给子进程，所以只杀父进程会留一堆孤儿
    const fire = (sig) => {
      try { process.kill(-pid, sig); return; } catch { /* 没有独立进程组 */ }
      try { handle.proc.kill(sig); } catch { /* 已经死了 */ }
    };

    fire('SIGTERM');

    // SIGTERM 不一定管用（agent 常忽略），必须补一刀 SIGKILL
    // 不能 unref：这个定时器是防止留孤儿进程的唯一保障
    this._pending = new Promise((resolve) => {
      setTimeout(() => {
        try { process.kill(-pid, 0); } catch { return resolve(); }  // 已经死了
        fire('SIGKILL');
        resolve();
      }, graceMs);
    });
  }

  // 等所有 kill 的兜底都发完（测试和优雅退出用）
  drainKills() {
    return this._pending || Promise.resolve();
  }
}

export function tail(str, lines) {
  const arr = String(str).split('\n');
  return arr.slice(-lines).join('\n');
}

// 报告：一天一个 md 文件，纯记录 runner 干了啥（无 AI 判断）
export function appendReport(cfg, section) {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(cfg.paths.reports, `${day}.md`);

  if (!existsSync(file)) writeFileSync(file, `# ${day}\n`, 'utf8');
  appendFileSync(file, section, 'utf8');
}
