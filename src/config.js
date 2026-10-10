// 配置加载 + 时长解析 + 窗口判断
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const CONFIG_FILE = 'overnight.yaml';

const DEFAULTS = {
  agents: {
    opencode: { command: 'opencode', args: ['run', '--dangerously-skip-permissions', '{prompt}'] },
    claude: { command: 'claude', args: ['-p', '{prompt}', '--dangerously-skip-permissions'] },
  },
  default_agent: 'opencode',
  runner: {
    timeout: '60m',
    idle_kill: '10m',
    tail_lines: 80,
    prompt_template: '执行 plan 文件 {plan_file}，执行过程中不要询问，自行决策，并记录决策日志，写入 {decision_log_dir}',
    decision_log_dir: 'logs/decisions',
  },
  schedule: {
    window: '20:00-08:00',   // null / 空 = 全天
    idle_sleep: '24h',
  },
  retry: { max: 3, backoff: '5m' },
  report: { dir: 'reports' },
};

function deepMerge(base, over) {
  if (over === undefined) return base;
  // null 是显式覆盖（比如 schedule.window: null 表示全天），不能当成没填
  if (over === null || Array.isArray(over) || typeof over !== 'object') return over;
  if (typeof base !== 'object' || base === null) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

// ${VAR} 展开
function expandEnv(str) {
  return String(str).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

function deepExpand(obj) {
  if (typeof obj === 'string') return expandEnv(obj);
  if (Array.isArray(obj)) return obj.map(deepExpand);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepExpand(v);
    return out;
  }
  return obj;
}

export function loadConfig(cwd = process.cwd()) {
  const file = resolve(cwd, CONFIG_FILE);
  let user = {};
  if (existsSync(file)) {
    try {
      user = YAML.parse(readFileSync(file, 'utf8')) || {};
    } catch (e) {
      throw new Error(`${CONFIG_FILE} 解析失败: ${e.message}`);
    }
  }

  const cfg = deepExpand(deepMerge(DEFAULTS, user));

  // 时长转毫秒
  cfg.runner.timeoutMs = parseDuration(cfg.runner.timeout);
  cfg.runner.idleKillMs = parseDuration(cfg.runner.idle_kill);
  cfg.schedule.idleSleepMs = parseDuration(cfg.schedule.idle_sleep);
  cfg.retry.backoffMs = parseDuration(cfg.retry.backoff);

  // 目录
  cfg.paths = {
    root: cwd,
    queue: resolve(cwd, 'queue'),
    plans: resolve(cwd, 'docs', 'plans'),
    progress: resolve(cwd, 'docs', 'progress'),
    decisions: resolve(cwd, cfg.runner.decision_log_dir),
    logs: resolve(cwd, 'logs'),
    reports: resolve(cwd, cfg.report.dir),
  };
  for (const p of [cfg.paths.queue, cfg.paths.plans, cfg.paths.progress,
    cfg.paths.decisions, cfg.paths.logs, cfg.paths.reports]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }

  return cfg;
}

// 60m / 30s / 2h / 1d
export function parseDuration(s) {
  if (typeof s === 'number') return s * 1000;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
  if (!m) throw new Error(`时长格式不对: ${s}`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}

// "20:00-08:00" -> 是否在窗口内（支持跨夜）；null/空 = 全天
export function parseWindow(str) {
  if (str === null || str === undefined || String(str).trim() === '') return null;
  const m = String(str).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`时间窗口格式不对: ${str}（应该像 20:00-08:00，或 null 表示全天）`);

  const toMin = (h, mm) => parseInt(h, 10) * 60 + parseInt(mm, 10);
  const start = toMin(m[1], m[2]);
  const end = toMin(m[3], m[4]);

  if (start === end) return { start, end, always: true };
  return { start, end, always: false, crossNight: end < start };
}

export function inWindow(window, now = new Date()) {
  if (!window || window.always) return true;
  const cur = now.getHours() * 60 + now.getMinutes();
  const { start, end, crossNight } = window;
  if (crossNight) return cur >= start || cur < end;
  return cur >= start && cur < end;
}
