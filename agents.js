// 多 agent 适配 + AI 决策
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

// 调 AI 问一句话
export async function askAI(cfg, system, user) {
  const res = await fetch(`${cfg.ai.base_url}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.ai.api_key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.ai.model,
      max_tokens: cfg.ai.max_tokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`AI 请求失败 ${res.status}: ${t.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

// ---- 决策 ----

// 任务挂了，该不该重试
export async function judgeFailure(cfg, job, errText) {
  const v = await askAI(cfg,
    '你是 coding agent 的看护。判断任务失败后重试有没有意义。一句话回答，'
    + '如果重试也没用就回答"放弃"，不要写别的。',
    `任务：${job.prompt}
用的 agent：${job.agent || cfg.default_agent}
失败信息：
${errText}

这个能重试吗？一句话说明理由。`
  );
  const giveUp = v.includes('放弃') || v.includes('重试也没') || v.includes('没意义');
  return { action: giveUp ? 'giveup' : 'retry', reason: v };
}

// 时间窗口关了，还跑着，续不续
export async function judgeWindow(cfg, job, elapsed, outTail) {
  const v = await askAI(cfg,
    '你是 coding agent 的看护。现在配置的时间窗口关了，但任务还在跑。'
    + '决定是"再宽限一会儿"还是"收尾停掉"。一句话回答。',
    `任务：${job.prompt}
已经跑了：${elapsed}
最近输出：
${outTail}

继续等，还是收尾停掉？一句话说明理由。`
  );
  const stop = v.includes('收尾') || v.includes('停掉') || v.includes('没必要');
  return { action: stop ? 'stop' : 'grace', reason: v };
}

// ---- 决策写入报告 ----

export function appendReport(cfg, section) {
  const day = new Date().toISOString().slice(0, 10);
  const file = join(cfg.paths.reports, `${day}.md`);

  if (!existsSync(file)) writeFileSync(file, `# ${day}\n`, 'utf8');
  appendFileSync(file, section, 'utf8');
  return file;
}
