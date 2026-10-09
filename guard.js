// 看护核心：起 agent、盯四条线、AI 决策、重试
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, tail, judgeFailure, judgeWindow, appendReport } from './agents.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}小时${m}分` : m ? `${m}分${sec}秒` : `${sec}秒`;
};

// 退出码 + 日志关键字 -> 人话原因
// 只做客观归类，不做决策（决策交给 AI）
const SIGNATURES = [
  [/out of memory|heap out of memory|ENOMEM|oom-?kill/i, '内存爆了 (OOM)'],
  [/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo/i, '网络不通'],
  [/rate.?limit|429|too many requests|quota/i, 'API 限流 / 额度用完'],
  [/authentication|401|403|invalid.*key|unauthorized/i, '认证失败 (key 过期?)'],
  [/permission denied|EACCES|not permitted/i, '权限不足'],
  [/git.*conflict|CONFLICT|merge.*fail/i, 'git 冲突'],
  [/test.*fail|assertion|jest.*failed|npm ERR! test/i, '测试没过'],
  [/command not found|ENOENT/i, '命令找不到'],
  [/ENOSPC|no space left/i, '磁盘满了'],
];

function classifyExit(code, sig, output) {
  for (const [re, why] of SIGNATURES) {
    if (re.test(output)) return why;
  }
  if (code === 137) return '内存爆了 (OOM)';
  if (code === 143) return '被正常终止 (SIGTERM)';
  if (sig) return `被信号 ${sig} 杀掉`;
  return `进程异常退出 (code ${code})`;
}

export class Guard {
  constructor(cfg, { log } = {}) {
    this.cfg = cfg;
    this.agent = new Agent(cfg);
    this.log = log || (() => {});
    this.current = null;   // { job, handle, startedAt, graceGiven }
  }

  // 跑一个任务直到成功或彻底放弃
  async run(job) {
    const max = this.cfg.retry.max;
    let lastErr = '';

    for (let attempt = 1; attempt <= max; attempt++) {
      // 第一次干净跑，重试时把上次失败原因喂回去
      const prompt = attempt === 1
        ? job.prompt
        : `${job.prompt}\n\n---\n上次执行到一半挂了，错误如下：\n${lastErr}\n接着干。`;

      const res = await this.#oneShot(job, prompt, attempt);
      if (res.status === 'done') {
        return { status: 'done', attempts: attempt };
      }

      lastErr = res.error;

      if (res.reason === 'window') {
        // 窗口关了被收尾，不算任务失败，等下轮继续
        this.#report(job, attempt, '窗口关闭', res.error, res.verdict || '收尾停掉', 'deferred');
        return { status: 'deferred', attempts: attempt, reason: res.error };
      }

      // 让 AI 判断该不该重试
      let verdict;
      try {
        verdict = await judgeFailure(this.cfg, job, res.error);
      } catch (e) {
        // AI 挂了，退化成"重试"，别因为判断不了就丢任务
        verdict = { action: 'retry', reason: 'AI 决策失败(' + e.message + ')，默认重试' };
      }

      this.#report(job, attempt, res.reason, res.error, verdict.reason,
        verdict.action === 'retry' ? 'retry' : 'failed');

      if (verdict.action === 'giveup') {
        return { status: 'failed', attempts: attempt, reason: verdict.reason };
      }

      if (attempt < max) await sleep(this.cfg.retry.backoffMs);
    }

    return { status: 'failed', attempts: max, reason: '重试用完' };
  }

  // 跑一次，盯到出结果
  async #oneShot(job, prompt, attempt) {
    mkdirSync(this.cfg.paths.logs, { recursive: true });
    const logFile = join(this.cfg.paths.logs, `${job.id}-a${attempt}.log`);

    let handle;
    try {
      handle = this.agent.run(job.agent, prompt, {
        onOutput: (s) => this.log(s.replace(/\n$/, '')),
      });
    } catch (e) {
      return { status: 'err', reason: '启动失败', error: e.message };
    }

    this.current = { job, handle, startedAt: Date.now(), graceGiven: false };
    this.log(`▶ [${job.id}] 第 ${attempt} 次: ${handle.name} — ${handle.command}`);

    const outcome = await this.#watch(job, handle, logFile);
    this.current = null;

    return outcome;
  }

  // 四条线：退出 / 卡死 / 超时 / 窗口关闭
  #watch(job, handle, logFile) {
    const { idleKillMs, timeoutMs, windowGraceMs, tailLines } = this.cfg.guard;
    const started = Date.now();

    return new Promise((resolve) => {
      let settled = false;
      let idleTimer, hardTimer, winTimer;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearInterval(idleTimer);
        clearInterval(winTimer);
        clearTimeout(hardTimer);
        resolve(r);
      };

      // 1. 进程退出
      handle.proc.on('exit', (code, sig) => {
        if (code === 0) {
          this.log(`✓ [${job.id}] 完成，跑了 ${fmtDur(Date.now() - started)}`);
          return done({ status: 'done' });
        }
        const all = handle.output + '\n' + handle.stderr;
        const err = tail(all, tailLines) || `进程退出 code=${code} sig=${sig}，无输出`;
        done({ status: 'err', reason: classifyExit(code, sig, all), error: err });
      });

      handle.proc.on('error', (e) => {
        done({ status: 'err', reason: '进程起不来', error: e.message });
      });

      // 2. 卡死：多久没新输出
      let last = Date.now();
      // 轮询间隔跟着 idle_kill 走，短阈值也能及时发现
      const poll = Math.max(1000, Math.min(30_000, Math.floor(idleKillMs / 3)));
      idleTimer = setInterval(() => {
        if (Date.now() - last > idleKillMs) {
          this.agent.kill(handle);
          // 不等 exit 事件：agent 可能带子进程，父进程不一定马上退
          done({ status: 'err', reason: '卡死（长时间无输出）',
            error: tail(handle.output + '\n' + handle.stderr, tailLines) });
        }
      }, poll);

      // 3. 硬超时
      hardTimer = setTimeout(() => {
        this.agent.kill(handle);
        done({ status: 'err', reason: '超时', error: tail(handle.output, tailLines) });
      }, timeoutMs);

      // 4. 窗口关闭：问 AI 续不续
      const winPoll = this.cfg.guard.window_poll || 30_000;
      winTimer = setInterval(
        () => this.#checkWindow(job, handle, started, done, () => clearInterval(winTimer)),
        winPoll
      );

      // 记录原始输出到文件，方便事后翻
      const stream = createWriteStream(logFile, { flags: 'w' });
      handle.proc.stdout.on('data', (d) => { last = Date.now(); stream.write(d); });
      handle.proc.stderr.on('data', (d) => { last = Date.now(); stream.write(d); });
      handle.proc.on('exit', () => stream.end());
    });
  }

  // 出窗口了但还在跑 -> AI 决策
  async #checkWindow(job, handle, started, done, stopPolling) {
    const cur = this.current;
    if (!cur || cur.graceGiven || cur.graceDone) return;
    if (this.cfg._inWindow()) return;   // 还在窗口内，不打扰

    cur.graceDone = true;               // 防止 AI 慢的时候被重复触发
    stopPolling();

    const elapsed = fmtDur(Date.now() - started);
    const outTail = tail(handle.output, 30);

    let verdict;
    try {
      verdict = await judgeWindow(this.cfg, job, elapsed, outTail);
    } catch (e) {
      verdict = { action: 'grace', reason: 'AI 决策失败，默认宽限' };
    }

    const graceMin = Math.round(this.cfg.guard.windowGraceMs / 60000);
    const graceText = graceMin >= 1 ? `宽限 ${graceMin} 分钟` : `宽限 ${Math.round(this.cfg.guard.windowGraceMs / 1000)} 秒`;

    appendReport(this.cfg, `\n### 窗口决策 — ${job.id}\n`
      + `- 跑了: ${elapsed}\n- AI 判断: ${verdict.reason}\n`
      + `- 处理: ${verdict.action === 'stop' ? '收尾停掉' : graceText}\n`);

    this.log(`⏰ [${job.id}] 出窗口（已跑 ${elapsed}）AI: ${verdict.reason}`);

    if (verdict.action === 'stop') {
      this.agent.kill(handle);
      return done({ status: 'err', reason: 'window', verdict: verdict.reason,
        error: `时间窗口已关，AI 判断收尾。跑了 ${elapsed}。` });
    }

    // 宽限：再等 window_grace，到点强制收尾
    setTimeout(() => {
      this.agent.kill(handle);
      done({ status: 'err', reason: 'window', verdict: '宽限用完',
        error: '时间窗口已关，AI 让再等等，等完了还没完。' });
    }, this.cfg.guard.windowGraceMs).unref?.();
  }

  #report(job, attempt, reason, err, verdict, result) {
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    appendReport(this.cfg,
      `\n## ${result === 'retry' ? '重试' : result === 'deferred' ? '推迟' : '失败'} — ${job.id} (${now})\n`
      + `- 任务: ${job.prompt.slice(0, 80).replace(/\n/g, ' ')}\n`
      + `- 第 ${attempt} 次尝试，${reason}\n`
      + `- AI 判断: ${verdict}\n`
      + `- 日志末尾:\n\`\`\`\n${String(err).slice(-600)}\n\`\`\`\n`);
  }
}
