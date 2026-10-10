// TUI：左右分屏。左 = runner 日志（派单/重试），右 = agent 实时输出。
// 纯显示，无交互。Ctrl+C 退出。
const ESC = '\x1b';
const hideCursor = () => process.stdout.write(`${ESC}[?25l`);
const showCursor = () => process.stdout.write(`${ESC}[?25h`);
const enterAlt = () => process.stdout.write(`${ESC}[?1049h`);
const leaveAlt = () => process.stdout.write(`${ESC}[?1049l`);
const home = () => `${ESC}[H`;
const clearScreen = () => `${ESC}[2J${ESC}[H`;

const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const yellow = (s) => `${ESC}[33m${s}${ESC}[0m`;
const green = (s) => `${ESC}[32m${s}${ESC}[0m`;

// 去掉 ANSI 转义，避免 agent 自带颜色冲垮分栏
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (s) => String(s).replace(ANSI, '').replace(/\t/g, '    ');

// 东亚宽字符算 2 列，不然中文分栏会错位
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === 0x200d || cp === 0xfe0f || cp === 0x200b) return 0;
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 2;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x3000 && cp <= 0x303f)
  ) return 2;
  return 1;
}

export const visWidth = (s) => {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
};

export const padTo = (s, width) => s + ' '.repeat(Math.max(0, width - visWidth(s)));

// 按显示宽度折行
export function wrapLine(line, width) {
  if (width < 1) return [''];
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of line) {
    const c = charWidth(ch);
    if (w + c > width && cur) { out.push(cur); cur = ''; w = 0; }
    cur += ch;
    w += c;
  }
  out.push(cur);
  return out;
}

const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${m}m` : m ? `${m}m${s % 60}s` : `${s}s`;
};

export class TUI {
  constructor(cfg, { queue, state }) {
    this.cfg = cfg;
    this.queue = queue;
    this.state = state;              // { current, paused, windowLabel }
    this.runnerLog = [];             // 左栏：runner 事件
    this.agentLog = [];              // 右栏：agent 输出
    this._agentBuf = '';
    this.rendering = false;
  }

  start() {
    enterAlt();
    hideCursor();
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
    process.stdout.on('resize', () => this.render());
    this.timer = setInterval(() => this.render(), 250);
    this.render();
  }

  stop() {
    clearInterval(this.timer);
    process.stdout.write(clearScreen());
    leaveAlt();
    showCursor();
    process.exit(0);
  }

  // 左栏：runner 日志
  log(line) {
    for (const l of stripAnsi(line).split('\n')) this.runnerLog.push(l);
    if (this.runnerLog.length > 2000) this.runnerLog.splice(0, 1000);
  }

  // 右栏：agent 原始输出，按行切
  agentOutput(chunk) {
    this._agentBuf += stripAnsi(chunk).replace(/\r/g, '');
    const parts = this._agentBuf.split('\n');
    this._agentBuf = parts.pop();
    for (const p of parts) this.agentLog.push(p);
    if (this.agentLog.length > 2000) this.agentLog.splice(0, 1000);
  }

  // 顶部边框，内嵌标题：┌─ runner ──┬─ agent 001 ──┐
  #topRow(leftW, rightW, rightLabel) {
    const seg = (label, w, lc, mc) => {
      const t = label ? ` ${label} ` : '';
      const tW = visWidth(t);
      return lc + (t ? t + '─'.repeat(Math.max(0, w - tW)) : '─'.repeat(w)) + mc;
    };
    return seg('runner', leftW, '┌', '┬') + seg(rightLabel, rightW, '', '┐');
  }

  render() {
    if (this.rendering) return;
    this.rendering = true;

    const W = process.stdout.columns || 100;
    const H = process.stdout.rows || 30;
    const total = Math.max(20, W - 1);       // 末列留空，防止自动换行
    const leftW = Math.max(16, Math.floor((total - 1) * 0.38));
    const rightW = total - leftW - 1;
    const bodyH = Math.max(3, H - 4);        // 标题 + 上下边框 + 状态行

    const jobs = this.queue.list();
    const cur = this.state.current;
    const agentLabel = cur ? `agent ${cur.jobId}/${cur.planId}` : 'agent';

    const lines = [];
    lines.push(bold('overnight'.padEnd(12)) + dim(' 让 AI 上夜班 · Ctrl+C 退出'));
    lines.push(this.#topRow(leftW, rightW, agentLabel));

    // 两栏各自折行，取最后 bodyH 行，底对齐
    const leftWrapped = wrapAll(this.runnerLog, leftW).slice(-bodyH);
    const rightWrapped = wrapAll(this.agentLog, rightW).slice(-bodyH);
    while (leftWrapped.length < bodyH) leftWrapped.unshift('');
    while (rightWrapped.length < bodyH) rightWrapped.unshift('');

    for (let i = 0; i < bodyH; i++) {
      lines.push('│' + padTo(leftWrapped[i], leftW) + '│' + padTo(rightWrapped[i], rightW) + '│');
    }

    lines.push('└' + '─'.repeat(leftW) + '┴' + '─'.repeat(rightW) + '┘');

    // 状态行：统计的是 plan 粒度
    const pendingPlans = jobs.reduce((n, j) => n + (j.broken ? 0 : j.plans.filter((p) => p.status === 'pending').length), 0);
    const totalPlans = jobs.reduce((n, j) => n + (j.broken ? 0 : j.plans.length), 0);
    const curInfo = cur
      ? `当前 ${cur.jobId}/${cur.planId} (跑了 ${fmtDur(Date.now() - cur.startedAt)})`
      : '待命';
    const status = `plans ${pendingPlans}/${totalPlans} 待跑 · ${curInfo} · 窗口 ${this.state.windowLabel}`
      + (this.state.paused ? ' · 已暂停' : '');
    lines.push(cyan(status));

    process.stdout.write(home() + lines.join('\n') + `${ESC}[0K`);
    this.rendering = false;
  }
}

function wrapAll(arr, width) {
  const out = [];
  for (const line of arr) out.push(...wrapLine(line, width));
  return out;
}
