import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import stringWidth from 'string-width';
import cliTruncate from 'cli-truncate';
import type { AppService, AuthorityService, CLIService, ConfigSchema, Context, LogEntry, PersonaService, PlatformAdapter, PlatformConnection, StreamChunkMessage } from '@aalis/core';
import { getLogBuffer, onLogEntry, setConsoleLogSinkEnabled } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-cli';
export const displayName = 'CLI 终端';
export const inject = {
  optional: ['llm', 'authority', 'commands'],
};
export const provides = ['cli', 'platform'];

export const configSchema: ConfigSchema = {
  prompt: { type: 'string', label: '提示符', default: 'You', description: '命令行输入提示符前缀' },
  startupView: {
    type: 'select',
    label: '启动视图',
    default: 'last',
    description: 'CLI 接管终端后的默认视图。last 表示恢复上次视图',
    options: [
      { label: '恢复上次', value: 'last' },
      { label: '聊天', value: 'chat' },
      { label: '日志', value: 'logs' },
      { label: '状态', value: 'status' },
    ],
  },
  logLines: { type: 'number', label: '日志行数', default: 200, description: 'CLI 日志视图保留的最近日志条数。0 = 不限（仅受 core 环形缓冲 500 条限制）' },
};

export const defaultConfig = {
  prompt: 'You',
  sessionId: 'cli-default',
  startupView: 'last',
  lastView: 'chat',
  logLines: 200,
};

type CLIView = 'chat' | 'logs' | 'status' | 'help';

interface CLIConfig {
  prompt: string;
  sessionId: string;
  startupView: 'last' | CLIView;
  lastView: CLIView;
  logLines: number;
}

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cliConfig: CLIConfig = {
    prompt: (config.prompt as string) ?? defaultConfig.prompt,
    sessionId: (config.sessionId as string) ?? defaultConfig.sessionId,
    startupView: parseStartupView(config.startupView),
    lastView: parseView(config.lastView, 'chat'),
    logLines: (() => {
      const v = Number(config.logLines ?? defaultConfig.logLines);
      if (!Number.isFinite(v) || v < 0) return defaultConfig.logLines;
      // 0 = 不限，使用 core 环形缓冲的上限（500）代替
      if (v === 0) return Number.MAX_SAFE_INTEGER;
      return Math.max(50, v);
    })(),
  };

  const sessionId = cliConfig.sessionId;
  let tui: CliTui | null = null;

  const adapter: PlatformAdapter = {
    adapterName: 'CLI',
    platform: 'cli',
    sessionTypes: [], // CLI 单会话，不区分 sessionType
    getConnections(): PlatformConnection[] {
      return [{ id: sessionId, platform: 'cli', status: tui?.isRunning() ? 'online' : 'offline' }];
    },
    async sendMessage(_sessionId: string, content: string): Promise<void> {
      tui?.pushAssistant(content);
    },
  };

  ctx.provide('platform', adapter, { capabilities: ['cli'] });

  const cliService: CLIService = {
    getSessionId: () => sessionId,
    isRunning: () => tui?.isRunning() ?? false,
  };
  ctx.provide('cli', cliService);

  ctx.on('outbound:message', (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (tui?.consumeStreamedSend()) return; // 同一轮已流式输出，跳过重复
    adapter.sendMessage(msg.sessionId, msg.content);
  });

  ctx.on('outbound:stream', (chunk) => {
    if (chunk.sessionId !== sessionId) return;
    tui?.applyStreamChunk(chunk);
  });

  ctx.on('app:started', () => {
    tui = new CliTui(ctx, cliConfig, sessionId);
    tui.start();
  });
}

function parseView(value: unknown, fallback: CLIView): CLIView {
  return value === 'chat' || value === 'logs' || value === 'status' || value === 'help' ? value : fallback;
}

function parseStartupView(value: unknown): 'last' | CLIView {
  if (value === 'last') return 'last';
  if (value === 'chat' || value === 'logs' || value === 'status' || value === 'help') return value;
  return 'last';
}

class CliTui {
  private view: CLIView;
  private previousView: CLIView = 'chat';
  private running = false;
  private inputLine = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex: number | null = null;
  private chatLines: string[] = [];
  private logLines: LogEntry[];
  private logScroll = 0;
  private statusScroll = 0;
  private helpScroll = 0;
  private removeLogListener: (() => void) | null = null;
  // 流式状态：记录本 session 当前正在生成的 assistant 回复首行在 chatLines 中的下标
  private streamingStartIndex: number | null = null;
  private streamingContent = '';
  private streamedRecently = false;
  private confirmResolver: ((value: boolean) => void) | null = null;
  /** 鼠标 SGR 序列在处理中：readline 会把序列中间的数字/分号拆成独立 keypress，
   * 需要从看到 \x1b[< 起到看到 M/m 为止吞掉所有 keypress。 */
  private inMouseSeq = false;
  private confirmText = '';
  private renderQueued = false;
  private closing = false;
  private readonly restoreOnExit = () => restoreTerminalState();

  constructor(
    private ctx: Context,
    private config: CLIConfig,
    private sessionId: string,
  ) {
    this.view = config.startupView === 'last' ? config.lastView : config.startupView;
    this.logLines = getLogBuffer().slice(-config.logLines);
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    setConsoleLogSinkEnabled(false);
    // 1049h: 进入备用屏 / 25l: 隐藏光标 / 1007h: alternate scroll（兜底，部分终端不支持）
    // 1000h+1006h: SGR 鼠标上报，覆盖滚轮事件以便所有终端都能滚动
    // 注意：开启 1000h 后终端会把左/右键也发给程序，导致原生选择被吞。
    // 我们在 handleData 里仅处理滚轮 (button 64/65)，其它按键事件直接忽略。
    // 选择文本时按住平台修饰键即可绕过鼠标上报（见 help 页提示）。
    output.write('\x1b[?1049h\x1b[?25l\x1b[?1007h\x1b[?1000h\x1b[?1006h');
    output.write('\x1b[2J\x1b[H');
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on('data', this.handleData);
    process.once('exit', this.restoreOnExit);

    this.removeLogListener = onLogEntry((entry) => {
      this.logLines.push(entry);
      if (this.logLines.length > this.config.logLines) this.logLines.shift();
      if (this.view === 'logs') this.queueRender();
    });

    const persona = this.ctx.getService<PersonaService>('persona');
    const assistantName = persona?.getPersonaName() ?? 'Aalis';
    this.chatLines.push(chalk.gray(this.formatCont()) + chalk.gray(`欢迎使用 ${assistantName}。按 ${chalk.cyan('Ctrl+G')} 查看快捷键。`));

    this.ctx.getService<AuthorityService>('authority')?.setConfirmHandler('cli', async (request) => {
      return this.askConfirm(`/${request.name} 是高危指令，按 y 确认，其他键取消`);
    });

    input.on('keypress', this.handleKeypress);
    output.on('resize', this.queueRender);

    this.ctx.on('dispose', () => this.stop());
    this.render();
  }

  stop(): void {
    if (this.closing) return;
    this.closing = true;
    this.running = false;
    this.removeLogListener?.();
    this.removeLogListener = null;
    input.off('keypress', this.handleKeypress);
    input.off('data', this.handleData);
    output.off('resize', this.queueRender);
    process.off('exit', this.restoreOnExit);
    restoreTerminalState();
    setConsoleLogSinkEnabled(true);
  }

  pushAssistant(content: string): void {
    if (!content.trim()) return;
    this.appendAssistantLines(content);
    this.trimChat();
    if (this.view === 'chat') this.queueRender();
  }

  /**
   * 上一轮 是否有流式内容。调用后会重置。转发文件时 outbound:message 看到流完整后重复发送，需要跳过。
   */
  consumeStreamedSend(): boolean {
    if (this.streamedRecently) {
      this.streamedRecently = false;
      return true;
    }
    return false;
  }

  applyStreamChunk(chunk: StreamChunkMessage): void {
    if (chunk.done) {
      // 完结本轮流式
      if (this.streamingStartIndex !== null) {
        this.streamedRecently = true;
        this.streamingStartIndex = null;
        this.streamingContent = '';
        if (this.view === 'chat') this.queueRender();
      }
      return;
    }
    if (!chunk.contentDelta) return;
    // 首个块：创建一个新的 assistant 条目
    if (this.streamingStartIndex === null) {
      this.streamingContent = '';
      this.streamingStartIndex = this.chatLines.length;
      // 占位行，formatAssistantBlock 会立即替换
      this.chatLines.push('');
    }
    this.streamingContent += chunk.contentDelta;
    // 根据累积内容重建该消息占据的行
    const rebuilt = this.formatAssistantBlock(this.streamingContent);
    this.chatLines.splice(this.streamingStartIndex, this.chatLines.length - this.streamingStartIndex, ...rebuilt);
    this.trimChat();
    if (this.view === 'chat') this.queueRender();
  }

  private appendAssistantLines(content: string): void {
    const lines = this.formatAssistantBlock(content);
    for (const l of lines) this.chatLines.push(l);
  }

  /** 所有标签对齐到同一列宽，确保 │ 竖线垂直对齐 */
  private labelCol(): number {
    const persona = this.ctx.getService<PersonaService>('persona')?.getPersonaName() ?? 'Aalis';
    return Math.max(
      visibleLen('✦ ' + persona),  // assistant
      visibleLen('❯ ' + this.config.prompt), // user
      visibleLen('◆ System'),     // system
      visibleLen('∘'),            // welcome
    );
  }

  /** 把 label 右侧补空格到 labelCol 宽，再加 ` │ ` */
  private formatHead(label: string): string {
    const col = this.labelCol();
    const pad = Math.max(0, col - visibleLen(label));
    return label + ' '.repeat(pad) + ' ' + chalk.gray('│') + ' ';
  }

  private formatCont(): string {
    const col = this.labelCol();
    return ' '.repeat(col) + ' ' + chalk.gray('│') + ' ';
  }

  private formatAssistantBlock(content: string): string[] {
    const persona = this.ctx.getService<PersonaService>('persona')?.getPersonaName() ?? 'Aalis';
    const firstHead = this.formatHead(chalk.green('✦ ' + persona));
    const contHead = this.formatCont();
    return content.split('\n').map((line, i) => (i === 0 ? firstHead : contHead) + line);
  }

  private appendSystemLines(content: string): void {
    const firstHead = this.formatHead(chalk.yellow('◆ System'));
    const contHead = this.formatCont();
    for (const [i, line] of content.split('\n').entries()) {
      this.chatLines.push((i === 0 ? firstHead : contHead) + line);
    }
  }

  /** SGR 鼠标事件：\x1b[<button;col;row(M|m)。仅处理滚轮（button 64=up, 65=down，加 4/8/16 表示 Shift/Alt/Ctrl）；
   *  其它按键 (0/1/2 = 左/中/右) 一律丢弃，避免抢走原生选择/复制。 */
  private handleData = (chunk: Buffer | string): void => {
    if (!this.running) return;
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!s.includes('\x1b[<')) return;
    const re = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      if (m[2] !== 'M') continue; // 滚轮只发 'M'，无 release
      const button = parseInt(m[1], 10);
      const base = button & ~28; // 去掉 Shift(4)/Alt(8)/Ctrl(16)
      const big = (button & 4) !== 0; // Shift+滚轮 = 翻页
      if (base === 64) this.scrollCurrentView(+1, big);
      else if (base === 65) this.scrollCurrentView(-1, big);
      // base === 0/1/2 (左/中/右) 直接忽略：让用户在终端层做选择/复制
    }
  };

  /** 统一的滚动入口：direction +1 = 往旧/上滚，-1 = 往新/下滚。 */
  private scrollCurrentView(direction: 1 | -1, big: boolean): void {
    const step = (big ? 10 : 3) * direction;
    if (this.view === 'logs') {
      const max = Math.max(0, this.logLines.length - 1);
      this.logScroll = Math.max(0, Math.min(max, this.logScroll + step));
    } else if (this.view === 'status') {
      this.statusScroll = Math.max(0, this.statusScroll - step);
    } else if (this.view === 'help') {
      this.helpScroll = Math.max(0, this.helpScroll - step);
    } else {
      return;
    }
    this.queueRender();
  }

  private handleKeypress = async (chunk: string, key: readline.Key): Promise<void> => {
    if (!this.running) return;
    // 鼠标 SGR 序列状态机：从 \x1b[< 到 M/m 之间的所有 keypress 都吞掉
    if (key.sequence?.startsWith('\x1b[<') || (chunk && chunk.startsWith('\x1b[<'))) {
      this.inMouseSeq = true;
      return;
    }
    if (this.inMouseSeq) {
      if (chunk === 'M' || chunk === 'm' || key.sequence === 'M' || key.sequence === 'm') {
        this.inMouseSeq = false;
      }
      return;
    }

    if (this.confirmResolver) {
      const ok = key.name === 'y' || chunk.toLowerCase() === 'y';
      const resolve = this.confirmResolver;
      this.confirmResolver = null;
      this.confirmText = '';
      resolve(ok);
      this.queueRender();
      return;
    }

    if (key.ctrl && key.name === 'c') {
      this.stop();
      process.kill(process.pid, 'SIGINT');
      return;
    }
    if (key.ctrl && key.name === 'l') { this.switchView('logs'); return; }
    if (key.ctrl && key.name === 't') { this.switchView('chat'); return; }
    if (key.ctrl && key.name === 's') { this.switchView('status'); return; }
    if (key.ctrl && key.name === 'g') { this.switchView('help'); return; }
    if (key.name === 'escape') { this.switchView(this.previousView); return; }

    if (this.view === 'logs') { this.handleLogsKey(key); return; }
    if (this.view === 'status') { this.handleScrollKey(key, 'statusScroll'); return; }
    if (this.view === 'help') { this.handleScrollKey(key, 'helpScroll'); return; }
    if (this.view !== 'chat') return;

    // 换行快捷：Ctrl+J / Shift+Enter / Alt+Enter / 原始 \n 输入
    const isNewline =
      (key.ctrl && key.name === 'j') ||
      (key.shift && key.name === 'return') ||
      (key.meta && (key.name === 'return' || key.name === 'enter')) ||
      (!key.ctrl && !key.meta && chunk === '\n' && key.name !== 'return');
    if (isNewline) {
      this.inputLine = this.inputLine.slice(0, this.cursor) + '\n' + this.inputLine.slice(this.cursor);
      this.cursor++;
      this.queueRender();
      return;
    }

    if (key.name === 'return') { await this.submitLine(); return; }
    if (key.name === 'backspace') {
      if (this.cursor > 0) {
        this.inputLine = this.inputLine.slice(0, this.cursor - 1) + this.inputLine.slice(this.cursor);
        this.cursor--;
        this.queueRender();
      }
      return;
    }
    if (key.name === 'delete') {
      if (this.cursor < this.inputLine.length) {
        this.inputLine = this.inputLine.slice(0, this.cursor) + this.inputLine.slice(this.cursor + 1);
        this.queueRender();
      }
      return;
    }
    if (key.name === 'left') { this.cursor = Math.max(0, this.cursor - 1); this.queueRender(); return; }
    if (key.name === 'right') { this.cursor = Math.min(this.inputLine.length, this.cursor + 1); this.queueRender(); return; }
    if (key.name === 'home') { this.cursor = 0; this.queueRender(); return; }
    if (key.name === 'end') { this.cursor = this.inputLine.length; this.queueRender(); return; }
    if (key.name === 'up') { this.recallHistory(-1); return; }
    if (key.name === 'down') { this.recallHistory(1); return; }

    if (!key.ctrl && !key.meta && chunk && chunk >= ' ') {
      this.inputLine = this.inputLine.slice(0, this.cursor) + chunk + this.inputLine.slice(this.cursor);
      this.cursor += chunk.length;
      this.queueRender();
    }
  };

  private handleLogsKey(key: readline.Key): void {
    const maxScroll = Math.max(0, this.logLines.length - 1);
    if (key.name === 'up') this.logScroll = Math.min(maxScroll, this.logScroll + 1);
    else if (key.name === 'down') this.logScroll = Math.max(0, this.logScroll - 1);
    else if (key.name === 'pageup') this.logScroll = Math.min(maxScroll, this.logScroll + 10);
    else if (key.name === 'pagedown') this.logScroll = Math.max(0, this.logScroll - 10);
    else if (key.name === 'home') this.logScroll = maxScroll;
    else if (key.name === 'end') this.logScroll = 0;
    this.queueRender();
  }

  private handleScrollKey(key: readline.Key, field: 'statusScroll' | 'helpScroll'): void {
    if (key.name === 'up') this[field] = Math.max(0, this[field] - 1);
    else if (key.name === 'down') this[field] = this[field] + 1;
    else if (key.name === 'pageup') this[field] = Math.max(0, this[field] - 10);
    else if (key.name === 'pagedown') this[field] = this[field] + 10;
    else if (key.name === 'home') this[field] = 0;
    this.queueRender();
  }

  private async submitLine(): Promise<void> {
    const text = this.inputLine.trim();
    this.inputLine = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.queueRender();
    if (!text) return;

    this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    const firstHead = this.formatHead(chalk.cyan('❯ ' + this.config.prompt));
    const contHead = this.formatCont();
    for (const [i, line] of text.split('\n').entries()) {
      this.chatLines.push((i === 0 ? firstHead : contHead) + line);
    }
    this.trimChat();

    const parsed = this.ctx.commands?.parseCommand(text);
    if (parsed) {
      const result = await this.ctx.commands!.execute(parsed.name, {
        sessionId: this.sessionId,
        platform: 'cli',
        userId: 'console',
        args: parsed.args,
        raw: parsed.raw,
      });
      if (result) this.appendSystemLines(result);
      this.trimChat();
      this.queueRender();
      if (parsed.name === 'shutdown' || parsed.name === 'restart') this.stop();
      return;
    }

    await this.ctx.emit('inbound:message', { content: text, sessionId: this.sessionId, platform: 'cli' });
  }

  private recallHistory(delta: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      if (delta > 0) return;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += delta;
      if (this.historyIndex < 0) this.historyIndex = 0;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = null;
        this.inputLine = '';
        this.cursor = 0;
        this.queueRender();
        return;
      }
    }
    this.inputLine = this.history[this.historyIndex];
    this.cursor = this.inputLine.length;
    this.queueRender();
  }

  private askConfirm(text: string): Promise<boolean> {
    this.confirmText = text;
    this.queueRender();
    return new Promise(resolve => { this.confirmResolver = resolve; });
  }

  private switchView(view: CLIView): void {
    if (this.view !== view) {
      this.previousView = this.view;
      this.view = view;
      this.persistLastView(view);
    }
    this.queueRender();
  }

  private persistLastView(view: CLIView): void {
    if (view === 'help') return;
    const pluginConfig = this.ctx.config.getPluginConfig(name);
    this.ctx.config.setPluginConfig(name, { ...pluginConfig, lastView: view });
    this.ctx.getService<AppService>('app')?.saveConfig();
  }

  private trimChat(): void {
    if (this.chatLines.length > 300) this.chatLines.splice(0, this.chatLines.length - 300);
  }

  private queueRender = (): void => {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  };

  private render(): void {
    if (!this.running) return;
    const width = Math.max(40, output.columns || 100);
    const height = Math.max(14, output.rows || 30);
    // 输入框可变高度（多行输入）：内容行数 + 上下边框，最多 8 行内容
    const inputContentLines = this.computeInputDisplayLines(width);
    const inputBoxHeight = inputContentLines.length + 2;
    // 布局：header(1) + sep(1) + body + inputBox(inputBoxHeight) + footer(1)
    const bodyHeight = Math.max(3, height - 3 - inputBoxHeight);

    const out: string[] = [];
    out.push(this.renderHeader(width));
    out.push(chalk.gray(LINE_H.repeat(width)));
    out.push(...this.renderBody(width, bodyHeight));
    out.push(...this.renderInputBox(width, inputContentLines));
    out.push(this.renderFooter(width));

    output.write('\x1b[?25l\x1b[H');
    output.write(out.map(line => clearLine(line, width)).join('\n'));
    if (this.view === 'chat' && !this.confirmText) {
      // 计算光标在多行输入中的 (row, col)
      const { row: cRow, col: cCol } = this.cursorPosInInput(width);
      // 行号布局（1-based）：1=header, 2=sep, 3..2+bodyHeight=body, 之后是 inputBox(顶/中.../底), 最后是 footer
      const inputMidStartRow = 2 + bodyHeight + 1 + 1; // header+sep+body+boxTop = 1+1+bodyHeight+1，再 +1 进入第一行内容
      const screenRow = inputMidStartRow + cRow;
      const promptLen = cRow === 0 ? visibleLen(this.makePrompt()) : visibleLen(this.makeContPrompt());
      const screenCol = 2 /* │ 之后 */ + promptLen + cCol;
      output.write(`\x1b[${screenRow};${screenCol}H\x1b[?25h`);
    }
  }

  private renderHeader(width: number): string {
    const persona = this.ctx.getService<PersonaService>('persona')?.getPersonaName() ?? 'default';
    const left = ` ${chalk.bold.magenta('●')} ${chalk.bold('Aalis')} ${chalk.gray('·')} ${chalk.cyan(persona)} `;
    const tabs = (['chat', 'logs', 'status', 'help'] as CLIView[]).map(v => {
      const label = v.toUpperCase();
      return v === this.view ? chalk.bold.cyan(`[${label}]`) : chalk.gray(` ${label} `);
    }).join(' ');
    const status = this.confirmResolver
      ? chalk.yellow('● confirm')
      : chalk.green('● online');
    const right = ` ${tabs}  ${status} `;
    const pad = Math.max(1, width - visibleLen(left) - visibleLen(right));
    return left + ' '.repeat(pad) + right;
  }

  private renderBody(width: number, height: number): string[] {
    const raw = this.getBodyLines(width, height);
    // 应用滚动 / 取末尾
    let visible: string[];
    if (this.view === 'chat') {
      visible = raw.slice(-height);
    } else if (this.view === 'logs') {
      // 限制 logScroll，使最顶端日志固定在窗口顶部后无法继续向上滚动
      // （否则会出现"内容从下往上消失"的视觉错觉）
      const maxLogScroll = Math.max(0, raw.length - height);
      if (this.logScroll > maxLogScroll) this.logScroll = maxLogScroll;
      const end = Math.max(0, raw.length - this.logScroll);
      visible = raw.slice(Math.max(0, end - height), end);
    } else {
      const scroll = this.view === 'status' ? this.statusScroll : this.helpScroll;
      const maxScroll = Math.max(0, raw.length - height);
      const offset = Math.min(scroll, maxScroll);
      visible = raw.slice(offset, offset + height);
    }
    while (visible.length < height) visible.push('');
    return visible.slice(0, height).map(line => clipAnsi(line, width));
  }

  private getBodyLines(width: number, _height: number): string[] {
    if (this.view === 'logs') return this.getLogViewLines(width);
    if (this.view === 'status') return this.getStatusViewLines();
    if (this.view === 'help') return this.getHelpViewLines();
    return this.getChatViewLines(width);
  }

  private getChatViewLines(width: number): string[] {
    const lines: string[] = [];
    const inner = width - 2; // 缩进 2 列
    for (const raw of this.chatLines) {
      // 宽度感知截断为单行；超长内容直接尾部省略。
      lines.push('  ' + clipAnsi(raw, inner));
    }
    return lines;
  }

  private getLogViewLines(width: number): string[] {
    const inner = width - 2;
    // 与 console 输出格式保持一致：ts LEVEL scope message
    // scope 不截断，不足时消息尖努进行无省略号截断
    return this.logLines.map(entry => {
      const ts    = chalk.gray(entry.timestamp);
      const level = LEVEL_TAG[entry.level];
      const scope = chalk.magenta(entry.scope);
      const head  = `${ts} ${level} ${scope} `;
      const headW = visibleLen(head);
      const msgW  = Math.max(1, inner - headW);
      // 多行消息（如 agent debug 分隔条 '━'.repeat(52)）会让光标跳到下一行，
      // 在 alternate screen 中覆盖已绘制内容。统一压成单行展示，并消除 \r / \t。
      const flat = sanitizeForSingleLine(entry.message);
      const msg  = stringWidth(flat) <= msgW ? flat : clipExact(flat, msgW);
      return `  ${head}${msg}`;
    });
  }

  private getStatusViewLines(): string[] {
    const services = this.ctx.listServices();
    const platform = this.ctx.getService<PlatformAdapter>('platform', ['cli']);
    const connections = platform?.getConnections?.() ?? [];
    const persona = this.ctx.getService<PersonaService>('persona')?.getPersonaName() ?? '-';
    const sec = (t: string) => chalk.bold.cyan(`▎ ${t}`);
    const kv = (k: string, v: string) => `    ${chalk.gray(k.padEnd(14))} ${v}`;
    const out: string[] = [];
    out.push(sec('运行时'));
    out.push(kv('persona', persona));
    out.push(kv('cli session', this.sessionId));
    out.push(kv('log buffer', `${this.logLines.length} / ${this.config.logLines}`));
    out.push('');
    out.push(sec(`服务 (${services.length})`));
    for (const s of services) out.push(`    ${chalk.green('●')} ${s}`);
    out.push('');
    out.push(sec(`平台连接 (${connections.length})`));
    if (connections.length === 0) out.push(`    ${chalk.gray('— 无')}`);
    else for (const c of connections) {
      const dot = c.status === 'online' ? chalk.green('●') : c.status === 'connecting' ? chalk.yellow('●') : chalk.red('●');
      out.push(`    ${dot} ${chalk.cyan(c.platform)}:${c.id} ${chalk.gray(c.status)}`);
    }
    return out.map(l => l.length === 0 ? '' : ` ${l}`);
  }

  private getHelpViewLines(): string[] {
    const sec = (t: string) => chalk.bold.cyan(`▎ ${t}`);
    const row = (k: string, v: string) => `    ${chalk.cyan(k.padEnd(10))} ${chalk.gray(v)}`;
    const out: string[] = [];
    out.push(sec('视图切换'));
    out.push(row('Ctrl+T', 'Chat   ·  聊天 / 命令输入'));
    out.push(row('Ctrl+L', 'Logs   ·  实时日志'));
    out.push(row('Ctrl+S', 'Status ·  服务与平台状态'));
    out.push(row('Ctrl+G', 'Help   ·  当前页'));
    out.push(row('Esc',    '返回上一个视图'));
    out.push(row('Ctrl+C', '退出'));
    out.push('');
    out.push(sec('滚动 (Logs / Status / Help)'));
    out.push(row('↑ / ↓',   '逐行滚动'));
    out.push(row('PgUp/Dn', '翻页'));
    out.push(row('Home',    '回到顶部'));
    out.push('');
    out.push(sec('编辑'));
    out.push(row('Enter',     '提交输入'));
    out.push(row('Ctrl+J',    '插入换行（macOS Ctrl+Enter）'));
    out.push(row('Shift+Ent', '插入换行（如终端支持）'));
    out.push(row('↑ / ↓',     '历史记录回溯（chat 视图）'));
    out.push('');
    out.push(sec('提示'));
    out.push(`    ${chalk.gray('• 完整日志写入 data/latest.log（每次启动覆盖）；可用 tail -f 查看。')}`);
    out.push(`    ${chalk.gray('• 退出时自动恢复原终端内容（alternate screen）。')}`);
    out.push(`    ${chalk.gray('• 输入以 / 开头会按命令解析，否则发给 agent。')}`);
    out.push(`    ${chalk.gray('• 鼠标滚轮可滚动 Logs / Status / Help。')}`);
    out.push(`    ${chalk.gray(`• 选择 / 复制文本：${selectionHint()}`)}`);
    return out.map(l => l.length === 0 ? '' : ` ${l}`);
  }

  /** 计算输入框的多行内容（不含边框、不含 padding） */
  private computeInputDisplayLines(width: number): string[] {
    const inner = width - 2;
    if (this.confirmText) return [`${chalk.yellow('?')} ${this.confirmText}`];
    if (this.view !== 'chat') {
      const total = this.view === 'logs' ? this.logLines.length
        : this.view === 'status' ? this.getStatusViewLines().length
        : this.getHelpViewLines().length;
      const scroll = this.view === 'logs' ? this.logScroll
        : this.view === 'status' ? this.statusScroll
        : this.helpScroll;
      return [chalk.gray(`${this.view} · ${total} 行 · scroll ${scroll}  ·  按 Ctrl+T 回到聊天`)];
    }
    const inputLines = this.inputLine.split('\n');
    const display: string[] = [];
    const promptLen = visibleLen(this.makePrompt());
    const contLen = visibleLen(this.makeContPrompt());
    const maxBody = Math.max(1, inner - Math.max(promptLen, contLen));
    for (let i = 0; i < inputLines.length; i++) {
      const head = i === 0 ? this.makePrompt() : this.makeContPrompt();
      // 宽度感知截断（CJK / emoji 占 2 列），不加省略号以免误导
      const body = clipExact(inputLines[i], maxBody);
      display.push(head + body);
    }
    // 限制最多 8 行
    if (display.length > 8) return display.slice(-8);
    return display;
  }

  /** 根据 cursor 索引计算其在多行输入中的 (row, col)，col 为终端可见列宽 */
  private cursorPosInInput(_width: number): { row: number; col: number } {
    if (this.view !== 'chat' || this.confirmText) return { row: 0, col: 0 };
    const before = this.inputLine.slice(0, this.cursor);
    const lines = before.split('\n');
    return { row: lines.length - 1, col: stringWidth(lines[lines.length - 1]) };
  }

  private renderInputBox(width: number, contentLines: string[]): string[] {
    const inner = width - 2;
    const top = chalk.gray(`${BOX_TL}${LINE_H.repeat(inner)}${BOX_TR}`);
    const mid = contentLines.map(line => `${chalk.gray(BOX_V)}${padAnsi(line, inner)}${chalk.gray(BOX_V)}`);
    const bot = chalk.gray(`${BOX_BL}${LINE_H.repeat(inner)}${BOX_BR}`);
    return [top, ...mid, bot];
  }

  private makePrompt(): string {
    return `${chalk.cyan('❯')} ${chalk.bold(this.config.prompt)} `;
  }

  private makeContPrompt(): string {
    return `${chalk.gray('…')} ${' '.repeat(this.config.prompt.length)} `;
  }

  private renderFooter(width: number): string {
    const items = [
      `${chalk.cyan('^T')} chat`,
      `${chalk.cyan('^L')} logs`,
      `${chalk.cyan('^S')} status`,
      `${chalk.cyan('^G')} help`,
      `${chalk.cyan('Esc')} back`,
      `${chalk.cyan('^C')} exit`,
    ].join(chalk.gray('  ·  '));
    const left = ` ${items} `;
    return padAnsi(chalk.gray.dim(left), width);
  }
}

// ===== 视觉常量 / 工具 =====

const LINE_H = '─';
const BOX_TL = '╭';
const BOX_TR = '╮';
const BOX_BL = '╰';
const BOX_BR = '╯';
const BOX_V  = '│';

const LEVEL_TAG: Record<LogEntry['level'], string> = {
  debug: chalk.gray('DEBUG'),
  info:  chalk.cyan('INFO '),
  warn:  chalk.yellow('WARN '),
  error: chalk.red('ERROR'),
};

/**
 * 兜底恢复终端状态：进程在 TUI 启动后异常退出时，Context dispose 可能来不及执行。
 * 这里关闭鼠标上报、恢复光标、退出备用屏，并关闭 raw mode。
 */
function restoreTerminalState(): void {
  try {
    if (input.isTTY) input.setRawMode(false);
  } catch { /* ignore */ }
  try {
    output.write('\x1b[?1006l\x1b[?1000l\x1b[?1007l\x1b[?25h\x1b[?1049l');
  } catch { /* ignore */ }
}

/** 终端可见宽度（处理 ANSI / CJK / emoji / 零宽字符） */
function visibleLen(s: string): number {
  return stringWidth(s);
}

/** 按终端列宽截断（保留 ANSI 颜色），尾部加省略号 */
function clipAnsi(s: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(s) <= width) return s;
  return cliTruncate(s, width, { position: 'end', preferTruncationOnSpace: false });
}

/** 按终端列宽截断（保留 ANSI 颜色），不加省略号 — 用于输入框等所见即所得场景 */
function clipExact(s: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(s) <= width) return s;
  return cliTruncate(s, width, { position: 'end', preferTruncationOnSpace: false, truncationCharacter: '' });
}

/** 按终端列宽右侧补空格 */
function padAnsi(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return clipAnsi(s, width);
  return s + ' '.repeat(width - w);
}

/** 行尾补宽 + \x1b[K 清残影 */
function clearLine(s: string, width: number): string {
  return padAnsi(s, width) + '\x1b[K';
}

/**
 * 清洗多行 / 含控制字符的日志消息，使之可安全渲染到 alternate screen 单行内。
 * - \r\n / \r / \n 一律折叠为 ' ↵ '（可见的回车标记）
 * - \t 换为 4 个空格
 * - 其它 C0 控制字符（\x00-\x1F 除 \x1b 颜色序列）剔除
 */
function sanitizeForSingleLine(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, ' \u21b5 ')
    .replace(/\t/g, '    ')
    // 保留 ESC（颜色），剔除其它 C0 控制字符
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]/g, '');
}

/** 不同平台终端绕过鼠标上报、回到原生选择/复制的指引 */
function selectionHint(): string {
  switch (process.platform) {
    case 'darwin':
      return '按住 Option（⌥）拖拽选择，再用 ⌘C 复制（iTerm2 / Terminal.app / VS Code 终端通用）';
    case 'win32':
      return 'Windows Terminal 按住 Shift 拖拽选择，右键复制；ConEmu 按住 Alt 拖拽';
    case 'linux':
      return 'GNOME/Konsole/xterm 按住 Shift 拖拽选择，再用 Ctrl+Shift+C 复制';
    default:
      return '按住 Shift（多数终端）或 Option（macOS）拖拽即可绕过鼠标上报';
  }
}