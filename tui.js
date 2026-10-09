// TUI：上面队列状态，下面聊天
import readline from 'node:readline';
import { askAI, appendReport } from './agents.js';

const ESC = '\x1b';
const clear = () => process.stdout.write(`${ESC}[2J${ESC}[H`);
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const cyan = (s) => `${ESC}[36m${s}${ESC}[0m`;
const green = (s) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s) => `${ESC}[31m${s}${ESC}[0m`;
const yellow = (s) => `${ESC}[33m${s}${ESC}[0m`;

const STATUS = {
  running: (t) => cyan(`▶ ${t}`),
  done: () => green('✓ 完成'),
  failed: () => red('✗ 失败'),
  deferred: () => yellow('⏸ 待续'),
  broken: () => red('! 坏了'),
  pending: () => dim('  等待'),
};

// 给 AI 看的纯文本状态
const STATUS_TEXT = {
  running: '正在跑',
  done: '已完成',
  failed: '失败',
  deferred: '待续',
  broken: '配置坏了',
  pending: '等待中',
};

const oneLine = (s) => String(s).split('\n')[0].trim();

export class TUI {
  constructor(cfg, { queue, state, onCommand }) {
    this.cfg = cfg;
    this.queue = queue;
    this.state = state;           // { paused, current, lastLog }
    this.onCommand = onCommand;
    this.chat = [];               // { role: 'me'|'t3', text }
    this.agentLog = [];           // agent 输出尾巴
    this.rendering = false;
  }

  start() {
    // terminal: false —— 自己管光标和提示符，不然 readline 的 prompt 会被 clear() 冲掉
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
      prompt: '',
    });

    this.rl.on('line', (line) => this.#onLine(line));

    this.timer = setInterval(() => this.render(), 1000);
    this.render();
  }

  stop() {
    clearInterval(this.timer);
    this.rl?.close();
    if (this.state.onStop) this.state.onStop();
    clear();
    console.log('界面已关闭，后台继续跑。重新连: t3 attach');
    process.exit(0);
  }

  log(line) {
    this.agentLog.push(line);
    if (this.agentLog.length > 30) this.agentLog.shift();
  }

  async #onLine(line) {
    const text = line.trim();
    if (!text) { this.render(); return; }

    // 少量本地快捷键，不记命令的意思是大部分都能用 AI
    if (text === '/q' || text === '/exit' || text === '退出') return this.stop();

    this.chat.push({ role: 'me', text });
    this.render();

    try {
      const reply = await this.#ask(text);
      this.chat.push({ role: 't3', text: reply.text });
      if (reply.action) {
        await this.onCommand(reply.action, reply.arg);
        // 操作结果接在回复后面，别让 console.log 被清屏吃掉
        if (this.state.lastAction) {
          this.chat.push({ role: 't3', text: this.state.lastAction });
          this.state.lastAction = null;
        }
      }
    } catch (e) {
      this.chat.push({ role: 't3', text: `出错了：${e.message}` });
    }

    this.render();
  }

  async #ask(text) {
    const jobs = this.queue.list();
    const cur = this.state.current;

    const lines = jobs.map((j) => {
      if (cur && j.id === cur.id) {
        const s = Math.round((Date.now() - cur.startedAt) / 1000);
        return `  ${j.id} [正在跑, ${s} 秒] ${oneLine(j.prompt)}`;
      }
      return `  ${j.id} [${STATUS_TEXT[j.status] || j.status}] ${oneLine(j.prompt)}`;
    });

    const ctx = [
      `现在 ${new Date().toLocaleString('zh-CN')}`,
      this.state.paused ? '状态: 已暂停派单' : '状态: 正常',
      this.cfg._inWindow() ? '时间窗口: 内' : '时间窗口: 外（不派新任务）',
      `队列:`,
      ...(lines.length ? lines : ['  (空)']),
    ].join('\n');

    const reply = await askAI(this.cfg,
      '你是 T3，一个 coding agent 的看护进程，同时在跟使用者聊天。\n'
      + '你可以：读队列状态回答问题；增删改 queue/ 目录里的任务。\n'
      + '你不能：改代码、操作 git、执行 shell。\n'
      + '中文，回答简短，控制在两句话内。\n'
      + '需要操作文件时，在回复最后单独一行写：<action:add|delete|reorder_first|reorder_last|toggle> 参数',
      `${ctx}\n\n用户说：${text}`);

    const m = reply.match(/<action:(\w+)(?:\s+([^>]*))?>/);
    if (m) {
      return { text: reply.replace(m[0], '').trim(), action: m[1], arg: (m[2] || '').trim() };
    }
    return { text: reply, action: null };
  }

  render() {
    if (this.rendering) return;
    this.rendering = true;
    clear();

    const jobs = this.queue.list();
    const cur = this.state.current;
    const W = process.stdout.columns || 80;

    // 顶栏
    const running = cur ? 1 : 0;
    console.log(bold('T3'.padEnd(W - 1)));
    console.log(cyan(`队列 ${jobs.length} · agent 工作中 ${running}${this.state.paused ? ' · 已暂停' : ''}`));
    console.log('─'.repeat(W - 1));

    // 队列
    if (!jobs.length) {
      console.log(dim('  队列是空的。往 queue/ 扔个 yaml，或者直接跟我说「加个任务: xxx」'));
    }
    for (const j of jobs) {
      const isCur = cur && cur.id === j.id;
      const status = isCur
        ? cyan(`▶ 跑着 ${Math.round((Date.now() - cur.startedAt) / 1000)}s`)
        : (STATUS[j.status]?.() || dim(j.status));
      const agent = j.agent ? dim(` [${j.agent}]`) : '';
      const text = j.prompt.split('\n')[0];
      const room = W - 14 - agent.length;
      console.log(`  ${j.id}  ${status}${agent}  ${text.slice(0, Math.max(10, room))}`);
    }

    console.log('─'.repeat(W - 1));

    // agent 输出 / 对话
    if (cur) {
      console.log(dim(`  ${cur.id} 最近输出:`));
      for (const l of this.agentLog.slice(-3)) console.log(dim('  ' + l.slice(0, W - 4)));
      console.log('─'.repeat(W - 1));
    }

    for (const m of this.chat.slice(-10)) {
      if (m.role === 'me') console.log(bold('我 > ') + m.text);
      else console.log(cyan('T3 > ') + m.text);
    }

    // 输入提示：光标移回来，让用户知道能打字
    process.stdout.write(dim('> '));

    this.rendering = false;
  }
}
