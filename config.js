// 配置加载 + 时长解析 + 窗口判断
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';

const DEFAULTS = {
  ai: {
    base_url: 'https://api.anthropic.com',
    api_key: '',
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
  },
  agents: {
    claude: { command: 'claude', args: ['-p', '{prompt}', '--dangerously-skip-permissions'] },
  },
  default_agent: 'claude',
  guard: {
    timeout: '60m',
    idle_kill: '10m',
    window_grace: '20m',
    tail_lines: 80,
  },
  schedule: {
    window: '20:00-08:00',
    idle_sleep: '24h',
  },
  retry: { max: 3, backoff: '5m' },
  report: { dir: 'reports' },
};

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over ?? base;
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
  const file = resolve(cwd, 't3.yaml');
  let user = {};
  if (existsSync(file)) {
    try {
      user = YAML.parse(readFileSync(file, 'utf8')) || {};
    } catch (e) {
      throw new Error(`t3.yaml 解析失败: ${e.message}`);
    }
  }

  const cfg = deepExpand(deepMerge(DEFAULTS, user));

  // 时长转毫秒
  cfg.guard.timeoutMs = parseDuration(cfg.guard.timeout);
  cfg.guard.idleKillMs = parseDuration(cfg.guard.idle_kill);
  cfg.guard.windowGraceMs = parseDuration(cfg.guard.window_grace);
  cfg.schedule.idleSleepMs = parseDuration(cfg.schedule.idle_sleep);
  cfg.retry.backoffMs = parseDuration(cfg.retry.backoff);

  // 目录
  cfg.paths = {
    root: cwd,
    queue: resolve(cwd, 'queue'),
    logs: resolve(cwd, 'logs'),
    reports: resolve(cwd, cfg.report.dir),
  };
  for (const p of [cfg.paths.queue, cfg.paths.logs, cfg.paths.reports]) {
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

// "20:00-08:00" -> 是否在窗口内（支持跨夜）
export function parseWindow(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`时间窗口格式不对: ${str}（应该像 20:00-08:00）`);

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
