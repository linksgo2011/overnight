// Runner：纯脚本看护。起 agent、盯三条线（退出/卡死/超时）、失败按次数重试。
// 调度按 plan 粒度：谁 ready 谁跑；deps 没解完的（含依赖失败）不碰。
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, tail, appendReport } from './agents.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}小时${m}分` : m ? `${m}分${sec}秒` : `${sec}秒`;
};

// 退出码 + 日志关键字 -> 人话原因（只归类，不决策）
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

export function classifyExit(code, sig, output) {
  for (const [re, why] of SIGNATURES) {
    if (re.test(output)) return why;
  }
  if (code === 137) return '内存爆了 (OOM)';
  if (code === 143) return '被正常终止 (SIGTERM)';
  if (sig) return `被信号 ${sig} 杀掉`;
  return `进程异常退出 (code ${code})`;
}

export class Runner {
  constructor(cfg, { log, onAgentOutput } = {}) {
    this.cfg = cfg;
    this.agent = new Agent(cfg);
    this.log = log || (() => {});            // runner 日志 -> 左栏
    this.onAgentOutput = onAgentOutput || (() => {});  // agent 输出 -> 右栏
    this.current = null;
  }

  // 按配置把 prompt_template 拼上 plan 全文
  buildPrompt(plan) {
    const tpl = this.cfg.runner.prompt_template || '';
    const header = tpl
      .replace(/\{plan_file\}/g, plan.relFile || plan.title)
      .replace(/\{decision_log_dir\}/g, this.cfg.runner.decision_log_dir)
      .trim();
    return [header, '--- plan 内容 ---', plan.content].filter(Boolean).join('\n\n');
  }

  // 跑一个 plan：单 plan 重试，最多 retry.max 次
  async runPlan(job, plan) {
    const max = this.cfg.retry.max;
    let lastErr = '';

    for (let attempt = 1; attempt <= max; attempt++) {
      // 重放同一份 prompt：plan 自己靠 docs/progress/ 的进度文件续跑
      const prompt = this.buildPrompt(plan);
      const res = await this.#oneShot(job, plan, prompt, attempt);
      if (res.status === 'done') return { status: 'done', attempts: attempt };

      lastErr = res.error;
      this.#report(job, plan, attempt, res.reason, res.error, attempt < max ? 'retry' : 'failed');
      this.log(`✗ [${job.id}/${plan.id}] 第 ${attempt}/${max} 次失败 — ${res.reason}`);

      if (attempt < max) await sleep(this.cfg.retry.backoffMs);
    }

    return { status: 'failed', attempts: max, reason: lastErr ? '重试用完' : '重试用完' };
  }

  // 跑一次，盯到出结果
  async #oneShot(job, plan, prompt, attempt) {
    mkdirSync(this.cfg.paths.logs, { recursive: true });
    const logFile = join(this.cfg.paths.logs, `${job.id}-${plan.id}-a${attempt}.log`);

    let handle;
    try {
      handle = this.agent.run(job.agent || this.cfg.default_agent, prompt, {
        onOutput: (s) => this.onAgentOutput(s),
      });
    } catch (e) {
      return { status: 'err', reason: '启动失败', error: e.message };
    }

    this.current = { job, plan, handle, startedAt: Date.now() };
    this.log(`▶ [${job.id}/${plan.id}] 第 ${attempt} 次: ${handle.name} — ${handle.command}`);

    const outcome = await this.#watch(job, plan, handle, logFile);
    this.current = null;
    return outcome;
  }

  // 三条线：退出 / 卡死 / 超时
  #watch(job, plan, handle, logFile) {
    const { idleKillMs, timeoutMs, tailLines } = this.cfg.runner;
    const started = Date.now();
    const tag = `${job.id}/${plan.id}`;

    return new Promise((resolve) => {
      let settled = false;
      let idleTimer, hardTimer;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearInterval(idleTimer);
        clearTimeout(hardTimer);
        resolve(r);
      };

      // 1. 进程退出
      handle.proc.on('exit', (code, sig) => {
        if (code === 0) {
          this.log(`✓ [${tag}] 完成，跑了 ${fmtDur(Date.now() - started)}`);
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
      const poll = Math.max(1000, Math.min(30_000, Math.floor(idleKillMs / 3)));
      idleTimer = setInterval(() => {
        if (Date.now() - last > idleKillMs) {
          this.agent.kill(handle);
          done({ status: 'err', reason: '卡死（长时间无输出）',
            error: tail(handle.output + '\n' + handle.stderr, tailLines) });
        }
      }, poll);

      // 3. 硬超时
      hardTimer = setTimeout(() => {
        this.agent.kill(handle);
        done({ status: 'err', reason: '超时', error: tail(handle.output, tailLines) });
      }, timeoutMs);

      // 落盘原始输出，方便事后翻
      const stream = createWriteStream(logFile, { flags: 'w' });
      handle.proc.stdout.on('data', (d) => { last = Date.now(); stream.write(d); });
      handle.proc.stderr.on('data', (d) => { last = Date.now(); stream.write(d); });
      handle.proc.on('exit', () => stream.end());
    });
  }

  #report(job, plan, attempt, reason, err, result) {
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    appendReport(this.cfg,
      `\n## ${result === 'retry' ? '重试' : '失败'} — ${job.id}/${plan.id} (${now})\n`
      + `- 任务: ${plan.title}\n- 第 ${attempt} 次尝试，${reason}\n`
      + `- 日志末尾:\n\`\`\`\n${String(err).slice(-600)}\n\`\`\`\n`);
  }
}