import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { AppService, AuthorityService, CLIService, ConfigSchema, Context, LogEntry, PersonaService, PlatformAdapter, PlatformConnection } from '@aalis/core';
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
  logLines: { type: 'number', label: '日志行数', default: 200, description: 'CLI 日志视图保留的最近日志条数' },
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
    logLines: Math.max(50, Number(config.logLines ?? defaultConfig.logLines) || defaultConfig.logLines),
  };

  const sessionId = cliConfig.sessionId;
  let tui: CliTui | null = null;

  const adapter: PlatformAdapter = {
    adapterName: 'CLI',
    platform: 'cli',
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

  ctx.on('message:send', (msg) => {
    if (msg.sessionId !== sessionId) return;
    adapter.sendMessage(msg.sessionId, msg.content);
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
  private removeLogListener: (() => void) | null = null;
  private confirmResolver: ((value: boolean) => void) | null = null;
  private confirmText = '';
  private renderQueued = false;
  private closing = false;

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
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();

    this.removeLogListener = onLogEntry((entry) => {
      this.logLines.push(entry);
      if (this.logLines.length > this.config.logLines) this.logLines.shift();
      if (this.view === 'logs') this.queueRender();
    });

    const persona = this.ctx.getService<PersonaService>('persona');
    const assistantName = persona?.getPersonaName() ?? 'Aalis';
    this.chatLines.push(`欢迎使用 ${assistantName}。按 Ctrl+G 查看快捷键。`);

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
    output.off('resize', this.queueRender);
    if (input.isTTY) input.setRawMode(false);
    setConsoleLogSinkEnabled(true);
    output.write('\x1b[?25h\x1b[2J\x1b[H');
  }

  pushAssistant(content: string): void {
    if (!content.trim()) return;
    for (const line of content.split('\n')) this.chatLines.push(`${chalk.green('Aalis')}> ${line}`);
    this.trimChat();
    if (this.view === 'chat') this.queueRender();
  }

  private handleKeypress = async (chunk: string, key: readline.Key): Promise<void> => {
    if (!this.running) return;

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
    if (this.view !== 'chat') return;

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

  private async submitLine(): Promise<void> {
    const text = this.inputLine.trim();
    this.inputLine = '';
    this.cursor = 0;
    this.historyIndex = null;
    this.queueRender();
    if (!text) return;

    this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.chatLines.push(`${chalk.blue(this.config.prompt)}> ${text}`);
    this.trimChat();

    const parsed = this.ctx.commands?.parseCommand(text);
    if (parsed) {
      const result = await this.ctx.commands!.execute(parsed.name, {
        sessionId: this.sessionId,
        platform: 'cli',
        args: parsed.args,
        raw: parsed.raw,
      });
      if (result) this.chatLines.push(`${chalk.yellow('System')}> ${result}`);
      this.trimChat();
      this.queueRender();
      if (parsed.name === 'shutdown' || parsed.name === 'restart') this.stop();
      return;
    }

    await this.ctx.emit('message:received', { content: text, sessionId: this.sessionId, platform: 'cli' });
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
    const height = Math.max(12, output.rows || 30);
    const bodyHeight = height - 4;

    output.write('\x1b[?25l\x1b[2J\x1b[H');
    output.write(this.renderHeader(width));
    output.write('\n');
    output.write(this.renderBody(width, bodyHeight));
    output.write('\n');
    output.write(this.renderFooter(width));
    output.write('\n');
    output.write(this.renderInput(width));
    output.write('\x1b[?25h');
  }

  private renderHeader(width: number): string {
    const title = ` Aalis CLI [${this.view}] `;
    const right = this.ctx.disposed ? 'disposed ' : 'online ';
    return chalk.inverse((title + ' '.repeat(Math.max(1, width - title.length - right.length)) + right).slice(0, width));
  }

  private renderBody(width: number, height: number): string {
    const lines = this.getBodyLines(width, height);
    while (lines.length < height) lines.push('');
    return lines.slice(0, height).map(line => fitLine(line, width)).join('\n');
  }

  private getBodyLines(width: number, height: number): string[] {
    if (this.view === 'logs') return this.getLogViewLines(height);
    if (this.view === 'status') return this.getStatusViewLines();
    if (this.view === 'help') return this.getHelpViewLines();
    return this.chatLines.slice(-height).map(line => line.length > width ? line.slice(0, width - 1) : line);
  }

  private getLogViewLines(height: number): string[] {
    const end = Math.max(0, this.logLines.length - this.logScroll);
    const start = Math.max(0, end - height);
    return this.logLines.slice(start, end).map(entry => {
      const level = entry.level.toUpperCase().padEnd(5);
      return `${entry.timestamp} ${level} ${entry.scope} ${entry.message}`;
    });
  }

  private getStatusViewLines(): string[] {
    const services = this.ctx.listServices();
    const platform = this.ctx.getService<PlatformAdapter>('platform');
    const connections = platform?.getConnections?.() ?? [];
    return [
      '状态',
      '',
      `服务数量: ${services.length}`,
      `服务列表: ${services.join(', ') || '-'}`,
      '',
      `当前 CLI session: ${this.sessionId}`,
      `日志缓存: ${this.logLines.length}/${this.config.logLines}`,
      '',
      '平台连接:',
      ...(connections.length > 0 ? connections.map(c => `- ${c.platform}:${c.id} ${c.status}`) : ['- 无平台连接信息']),
    ];
  }

  private getHelpViewLines(): string[] {
    return [
      '快捷键',
      '',
      '^T  Chat    切回聊天输入',
      '^L  Logs    查看日志；上下/PageUp/PageDown 滚动',
      '^S  Status  查看服务和连接状态',
      '^G  Help    查看当前帮助',
      'Esc 返回上一个视图',
      '^C  退出',
      '',
      '说明',
      '日志视图和状态视图不接收聊天输入，避免“看日志时还在输入指令”的混乱。',
      '需要和 agent 交流时按 ^T 回到 Chat。',
    ];
  }

  private renderFooter(width: number): string {
    return chalk.inverse(fitLine(' ^T Chat  ^L Logs  ^S Status  ^G Help  Esc Back  ^C Exit ', width));
  }

  private renderInput(width: number): string {
    if (this.confirmText) return fitLine(`${chalk.yellow('?')} ${this.confirmText}`, width);
    if (this.view !== 'chat') return chalk.gray(fitLine('非聊天视图：按 ^T 回到 Chat 后输入消息', width));
    const prefix = `${chalk.blue(this.config.prompt)}${chalk.gray('>')} `;
    const cursorLine = this.inputLine.slice(0, this.cursor) + chalk.inverse(this.inputLine[this.cursor] ?? ' ') + this.inputLine.slice(this.cursor + 1);
    return fitLine(prefix + cursorLine, width);
  }
}

function fitLine(line: string, width: number): string {
  if (line.length > width) return line.slice(0, width - 1);
  return line + ' '.repeat(Math.max(0, width - line.length));
}