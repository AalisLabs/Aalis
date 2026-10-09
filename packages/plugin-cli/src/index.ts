import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline';
import {
  type Approval,
  type ApprovalAttendance,
  type ApprovalFacts,
  type ApprovalSurface,
  approvals,
  type SettledState,
  sanitizeForCard,
} from '@aalis/api-approval';
import { commands } from '@aalis/api-commands';
import { unmetDependencies } from '@aalis/api-doctor';
import { hostConfig } from '@aalis/api-host-config';
import { persona } from '@aalis/api-persona';
import { getPlatformAdapters, type PlatformAdapter, type PlatformConnection, platform } from '@aalis/api-platform';
import { createStorageGateway, storage } from '@aalis/api-storage';
import {
  type BoundOf,
  config,
  definePlugin,
  defineService,
  events,
  LogHub,
  lifecycle,
  logger,
  optional,
  pluginsService,
  provide,
  services,
} from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import type { LogEntry } from '@aalis/schema-log';
import {
  AttachmentRefKind,
  type MessageAttachment,
  type OutgoingMessage,
  type StreamChunkMessage,
} from '@aalis/schema-message';
import chalk from 'chalk';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
import { ChatBuffer } from './chat-buffer.js';
import { readLogFileTail } from './log-file.js';
import type { CLIService } from './types.js';

/** 附件说明里的大小 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type { CLIService } from './types.js';

// terminal:claimed / terminal:released 是 CLI（独占终端 UI）与宿主
// console-sink 之间的协调契约：本插件发射，runtime/console-sink.ts 监听
// （同形声明在彼处亦有一份，接口合并要求两边类型一致）。
declare module '@aalis/core' {
  interface AalisEvents {
    'terminal:claimed': [owner: string];
    'terminal:released': [owner: string];
  }
}

// ----- 服务描述符（按激活绑定；调用型：绑定接口是 ServiceRef）-----
export const cli = defineService<CLIService>('cli');

// ===== 插件元数据 =====

const name = '@aalis/plugin-cli';

const configSchema = defineConfig({
  sessionId: {
    type: 'string',
    label: '默认会话 ID',
    default: 'cli-default',
    onInvalid: 'error',
    description: 'CLI 聊天所在的会话标识。',
  },
  lastView: {
    type: 'string',
    label: '上次视图',
    default: 'chat',
    description: '运行时自动写回；startupView=last 时启动恢复到这里记录的视图。',
  },
  prompt: { type: 'string', label: '提示符', default: 'You', description: '命令行输入提示符前缀' },
  maxLogEntries: {
    type: 'number',
    label: '日志内存缓冲上限（条）',
    default: 50000,
    description: '日志页内存驻留的最大条数，超出后从最旧成块丢弃；完整日志始终在家目录的 logs/latest.log',
  },
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
      { label: '帮助', value: 'help' },
    ],
  },
});

type CLIView = 'chat' | 'logs' | 'status' | 'help';

type CLIConfig = Omit<ConfigOf<typeof configSchema>, 'lastView'> & { lastView: CLIView };

// ===== 插件入口 =====

// platform 既被本插件提供又被状态页枚举，只能是可选依赖：required 会让激活等一个由自己提供的服务。
const uses = {
  events,
  logger,
  lifecycle,
  config,
  provide,
  services,
  hostConfig: optional(hostConfig),
  platform: optional(platform),
  storage: optional(storage),
  persona: optional(persona),
  /** 登记 cli 审批面：终端界面在场时审批推到这里，应答记在这个登记身份名下 */
  approvals: optional(approvals),
  /** 欢迎行下面的指路：有没有插件没起来，与 /doctor 在不在 */
  plugins: optional(pluginsService),
  commands: optional(commands),
};
type Caps = BoundOf<typeof uses>;

/** TUI 实际用到的能力：界面层不碰配置解析、服务发布与存储 */
type TuiCaps = Pick<
  Caps,
  'events' | 'logger' | 'lifecycle' | 'services' | 'hostConfig' | 'platform' | 'persona' | 'plugins' | 'commands'
>;

export default definePlugin({
  name,
  displayName: 'CLI 终端',
  subsystem: 'platform',
  configSchema,
  provides: [cli, platform],
  uses,
  apply: startCli,
});

function startCli(caps: Caps): void {
  const { config, events, logger } = caps;
  const cfg = parseConfig(configSchema, config, logger);
  const cliConfig: CLIConfig = {
    prompt: cfg.prompt,
    sessionId: cfg.sessionId,
    startupView: cfg.startupView,
    lastView: parseView(cfg.lastView, 'chat'),
    maxLogEntries: Math.max(1000, cfg.maxLogEntries || configSchema.maxLogEntries.default),
  };

  const sessionId = cliConfig.sessionId;
  const approvalSurface = caps.approvals.registerSurface('cli');
  let tui: CliTui | null = null;

  const adapter: PlatformAdapter = {
    adapterName: 'CLI',
    platform: 'cli',
    sessionTypes: [], // CLI 单会话，不区分 sessionType
    getConnections(): PlatformConnection[] {
      return [{ id: sessionId, platform: 'cli', status: tui?.isRunning() ? 'online' : 'offline' }];
    },
    // sessionId 由配置直接给出（不带 platform 前缀），需显式声明只接管自己的 sessionId
    canHandle(sid: string): boolean {
      return sid === sessionId;
    },
    async sendMessage(_sessionId: string, content: string): Promise<void> {
      if (tui) tui.pushAssistant(content);
      else logger.info(`[cli] ${content}`);
    },
  };

  caps.provide(platform, adapter);

  const cliService: CLIService = {
    getSessionId: () => sessionId,
    isRunning: () => tui?.isRunning() ?? false,
  };
  caps.provide(cli, cliService);

  // 附件：终端就是这个会话的平台，显示不了图片本身，写一行说明（类型、名称、大小、本机路径），写出即算送达并照常归档。
  // 路径在支持超链接的终端里可以点开
  const attachmentStorage = createStorageGateway(caps.storage);
  const KIND_LABELS: Record<MessageAttachment['kind'], AttachmentRefKind> = {
    image: AttachmentRefKind.Image,
    audio: AttachmentRefKind.Audio,
    video: AttachmentRefKind.Video,
    file: AttachmentRefKind.File,
  };
  async function attachmentLine(att: MessageAttachment): Promise<string> {
    const label = `[${KIND_LABELS[att.kind] ?? '附件'}]`;
    if (/^https?:\/\//i.test(att.data)) return `${label} ${att.name ?? ''} ${att.data}`.replace(/\s+/g, ' ').trim();
    if (att.data.startsWith('data:') && att.data.includes(';base64,')) {
      const bytes = Math.floor(((att.data.length - att.data.indexOf(',') - 1) * 3) / 4);
      return `${label} ${att.name ?? '内联数据'} · ${formatBytes(bytes)}`;
    }
    let path = att.data;
    let size = '';
    try {
      path = await attachmentStorage.resolveLocalPath(att.data, 'read');
      size = formatBytes((await attachmentStorage.stat(att.data)).size);
    } catch {
      // 取不到本机路径时照写存储地址
    }
    return [`${label} ${att.name ?? path.split('/').pop() ?? ''}`, size, path].filter(Boolean).join(' · ');
  }
  function sendAttachments(msg: OutgoingMessage): void {
    const attachments = (msg.attachments ?? []).map(att => ({ ...att }));
    // 同步认领：发起方 await emit 之后就要能等到它
    msg.delivery = (async () => {
      try {
        for (const att of attachments) adapter.sendMessage(msg.sessionId, await attachmentLine(att));
        void events.emit('outbound:delivered', { ...msg, attachments, delivery: undefined });
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    })();
  }

  events.on('outbound:message', msg => {
    if (msg.sessionId !== sessionId) return;
    if (msg.attachments?.length) {
      sendAttachments(msg);
      // 附件消息里的文字照常显示；它不是流式正文的整条重复，不消耗流式标记
      if (msg.content.trim()) adapter.sendMessage(msg.sessionId, msg.content);
      return;
    }
    // 纯文本同样写出即算送达，同步认领回执（作品通知等要等它）。同一轮已流式输出时，agent 的整条回复是重复、
    // 正文早已写出；系统/指令消息不是流式正文，照常显示
    const written =
      msg.source === 'agent' && tui?.consumeStreamedSend()
        ? Promise.resolve()
        : adapter.sendMessage(msg.sessionId, msg.content);
    msg.delivery = written.then(
      () => ({ ok: true as const }),
      err => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }),
    );
  });

  events.on('outbound:stream', chunk => {
    if (chunk.sessionId !== sessionId) return;
    tui?.applyStreamChunk(chunk);
  });

  // 临时缓冲：插件装配早于 app:started，但晚于 bootstrap-buffer.dispose()；
  // 我们订阅一个 onEntry 把这段窗口的实时 entry 留住，并在 app:started 时合并
  // logs/latest.log 尾部（覆盖装配之前的早期 boot 日志）。
  const liveBuffer: LogEntry[] = [];
  let liveBufferActive = true;
  const stopLiveBuffer = LogHub.default.onEntry(entry => {
    if (liveBufferActive) liveBuffer.push(entry);
  });

  events.on('app:started', async () => {
    // 非交互终端（日志重定向 / 容器 / systemd）：不接管终端、不画界面，控制台日志照常走 stdout；
    // 服务仍在线（平台枚举、子命令分发不受影响），出站消息退化为日志（见 sendMessage）。
    if (!output.isTTY || !input.isTTY) {
      liveBufferActive = false;
      stopLiveBuffer();
      logger.info('stdin/stdout 非 TTY，CLI 界面未启动');
      return;
    }
    let initial: LogEntry[] = [];
    try {
      initial = await readLogFileTail(createStorageGateway(caps.storage), 2000);
    } catch {
      // 文件未就绪可忽略——只是无早期历史
    }
    // 合并：file tail 与 live buffer 都可能含同一 seq，按 seq 去重排序
    const seen = new Set<number>();
    const merged: LogEntry[] = [];
    for (const e of initial) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      merged.push(e);
    }
    for (const e of liveBuffer) {
      if (seen.has(e.seq)) continue;
      seen.add(e.seq);
      merged.push(e);
    }
    merged.sort((a, b) => a.seq - b.seq);
    liveBufferActive = false;
    stopLiveBuffer();

    tui = new CliTui(caps, cliConfig, sessionId, approvalSurface, merged);
    tui.start();
  });
}

function parseView(value: unknown, fallback: CLIView): CLIView {
  return value === 'chat' || value === 'logs' || value === 'status' || value === 'help' ? value : fallback;
}

class CliTui {
  private view: CLIView;
  private previousView: CLIView = 'chat';
  /** 非 chat 视图期间进入聊天区的条数（确认提示、回复）；header 的 CHAT 页签带计数，切回即清 */
  private unreadChat = 0;
  private running = false;
  private inputLine = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex: number | null = null;
  private readonly chat = new ChatBuffer();
  private logLines: LogEntry[];
  private logScroll = 0;
  private logWrap = false;
  private statusScroll = 0;
  private helpScroll = 0;
  private removeLogListener: (() => void) | null = null;
  // 流式状态：正在生成的 assistant 回复，其行由 ChatBuffer 维护为末尾一段
  private streamingContent = '';
  private streamedRecently = false;
  private renderQueued = false;
  private closing = false;
  private readonly restoreOnExit = () => restoreTerminalState();
  /** 推到终端、还没结的审批，按推到的先后；卡上显示第一张 */
  private readonly cards: Approval[] = [];
  /** 卡上选中的应答。推出时不选：正在打字时按下的回车不会落到卡上 */
  private choice: ApprovalDecision | undefined;
  private readonly attendance: ApprovalAttendance;

  constructor(
    private caps: TuiCaps,
    private config: CLIConfig,
    private sessionId: string,
    approvalSurface: ApprovalSurface,
    initialEntries: LogEntry[] = [],
  ) {
    this.view = config.startupView === 'last' ? config.lastView : config.startupView;
    // 启动期日志由插件入口通过尾读 logs/latest.log + 实时 buffer 合并后注入，
    // 之后通过 LogHub.onEntry 实时累积；按 seq 单调，下方 onEntry 用 lastSeq 去重避免与 initial 重复。
    this.logLines = initialEntries.slice();
    // 以本地终端身份接入审批面（与输入消息的 userId 相同）。有按键才上报在场
    this.attendance = approvalSurface.attend(
      { platform: 'cli', userId: 'console' },
      {
        requested: approval => {
          this.cards.push(approval);
          this.queueRender();
        },
        settled: (approvalId, { state }) => this.closeCard(approvalId, SETTLED_LINES[state]),
      },
    );
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // 宣告"我接管终端"——任何写 stdout 的订阅者（runtime/console-sink 等）
    // 自行响应该事件停止写入，CLI 不直接干预日志系统。
    this.caps.events.emit('terminal:claimed', 'cli').catch(() => {});
    // 1049h: 进入备用屏 / 25l: 隐藏光标 / 1007h: alternate scroll——支持它的终端会把
    // 滚轮翻译成方向键，落到我们的键盘滚动路径上。不开启 SGR 鼠标上报（1000h/1006h）：
    // 终端保持原生的文本选择/复制，程序不接管任何鼠标事件。
    output.write('\x1b[?1049h\x1b[?25l\x1b[?1007h');
    output.write('\x1b[2J\x1b[H');
    readline.emitKeypressEvents(input);
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    process.once('exit', this.restoreOnExit);

    // 已注入 initialEntries 中最大的 seq；onEntry 收到 seq <= 此值的视为重复跳过
    let lastSeq = this.logLines.length > 0 ? this.logLines[this.logLines.length - 1].seq : -1;
    this.removeLogListener = LogHub.default.onEntry(entry => {
      if (entry.seq <= lastSeq) return;
      lastSeq = entry.seq;
      // 不限长——启动期起累积，渲染仅访问可见窗口，内存价格可接受
      this.logLines.push(entry);
      if (this.logLines.length > this.config.maxLogEntries) this.trimLogHead();
      // 用户已主动向上滚（logScroll > 0）时，新日志到来应保持视图锚定在原历史位置，
      // 而非随 raw.length 增长把旧内容挤出可见区。logScroll === 0 表示跟随底部。
      if (this.view === 'logs' && this.logScroll > 0) this.logScroll += 1;
      if (this.view === 'logs') this.queueRender();
    });

    const assistantName = this.caps.persona.current?.getPersonaName() ?? 'Aalis';
    this.chat.append([
      chalk.gray(this.formatCont()) + chalk.gray(`欢迎使用 ${assistantName}。按 ${chalk.cyan('Ctrl+G')} 查看快捷键。`),
    ]);
    void this.pointToUnready();

    input.on('keypress', this.handleKeypress);
    output.on('resize', this.queueRender);

    this.caps.lifecycle.onDispose(() => this.stop());
    this.render();
  }

  /**
   * 插件状态静置之后，有插件没起来时在欢迎行下面指路：数目是失败与缺服务之和（缺服务按 api-doctor 的共享判据，只在等
   * 别的插件启动的不算），与 /doctor 的「失败」「未就绪」两项一致；有 doctor 指令时指向它，没有时指向日志页
   */
  private async pointToUnready(): Promise<void> {
    const plugins = this.caps.plugins.current;
    if (!plugins) return;
    await plugins.idle();
    const status = plugins.getStatus();
    const lacking = [...unmetDependencies(status, this.caps.services.names()).values()].filter(
      u => u.lacking.length > 0,
    );
    const count = status.filter(p => p.state === 'error').length + lacking.length;
    if (count === 0) return;
    const how = this.caps.commands.current?.has('doctor')
      ? `输入 ${chalk.cyan('/doctor')} 查看原因与修法`
      : `按 ${chalk.cyan('Ctrl+L')} 看日志`;
    this.chat.append([chalk.gray(this.formatCont()) + chalk.yellow(`有 ${count} 个插件没起来，${how}`)]);
    this.queueRender();
  }

  stop(): void {
    if (this.closing) return;
    this.closing = true;
    this.running = false;
    this.removeLogListener?.();
    this.removeLogListener = null;
    input.off('keypress', this.handleKeypress);
    output.off('resize', this.queueRender);
    process.off('exit', this.restoreOnExit);
    restoreTerminalState();
    // 归还终端——sink 等订阅者可自行恢复
    this.caps.events.emit('terminal:released', 'cli').catch(() => {});
  }

  pushAssistant(content: string): void {
    if (!content.trim()) return;
    this.chat.append(this.formatAssistantBlock(content));
    if (this.view !== 'chat') this.unreadChat++;
    this.queueRender();
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
      if (this.chat.streaming) {
        this.streamedRecently = true;
        this.chat.endStreaming();
        this.streamingContent = '';
        if (this.view === 'chat') this.queueRender();
      }
      return;
    }
    if (!chunk.contentDelta) return;
    // 首个块：开一个新的 assistant 条目；上一轮遗留的「已流式」标记一并作废
    if (!this.chat.streaming) {
      this.streamingContent = '';
      this.streamedRecently = false;
      if (this.view !== 'chat') {
        this.unreadChat++;
        this.queueRender();
      }
    }
    this.streamingContent += chunk.contentDelta;
    // 根据累积内容重建该消息占据的行
    this.chat.replaceStreamingBlock(this.formatAssistantBlock(this.streamingContent));
    if (this.view === 'chat') this.queueRender();
  }

  /** 所有标签对齐到同一列宽，确保 │ 竖线垂直对齐 */
  private labelCol(): number {
    const persona = this.caps.persona.current?.getPersonaName() ?? 'Aalis';
    return Math.max(
      visibleLen(`✦ ${persona}`), // assistant
      visibleLen(`❯ ${this.config.prompt}`), // user
      visibleLen('◆ System'), // system
      visibleLen('∘'), // welcome
    );
  }

  /** 把 label 右侧补空格到 labelCol 宽，再加 ` │ ` */
  private formatHead(label: string): string {
    const col = this.labelCol();
    const pad = Math.max(0, col - visibleLen(label));
    return `${label + ' '.repeat(pad)} ${chalk.gray('│')} `;
  }

  private formatCont(): string {
    const col = this.labelCol();
    return `${' '.repeat(col)} ${chalk.gray('│')} `;
  }

  private formatAssistantBlock(content: string): string[] {
    const persona = this.caps.persona.current?.getPersonaName() ?? 'Aalis';
    const firstHead = this.formatHead(chalk.green(`✦ ${persona}`));
    const contHead = this.formatCont();
    return content.split('\n').map((line, i) => (i === 0 ? firstHead : contHead) + line);
  }

  private handleKeypress = async (chunk: string, key: readline.Key): Promise<void> => {
    if (!this.running) return;
    // 卡片只接它推出之后的按键：这次按键让终端变为在场而补推来的卡，owner 还没看到，这次按键照常处理
    const carded = this.cards.length > 0;
    // 终端有输入即在场：最近一次按键在审批服务的时限内，审批就推到这里
    this.attendance.presence(true);

    if (key.ctrl && key.name === 'c') {
      this.stop();
      process.kill(process.pid, 'SIGINT');
      return;
    }

    if (key.ctrl && key.name === 'l') {
      this.switchView('logs');
      return;
    }
    if (key.ctrl && key.name === 't') {
      this.switchView('chat');
      return;
    }
    if (key.ctrl && key.name === 's') {
      this.switchView('status');
      return;
    }
    if (key.ctrl && key.name === 'g') {
      this.switchView('help');
      return;
    }
    if (key.name === 'escape') {
      this.switchView(this.previousView);
      return;
    }

    // 审批卡是模态的：卡在时除了上面的切换视图与退出，按键只用来应答；打字与回车不算应答，也不进输入框
    if (carded) {
      this.handleCardKey(key);
      return;
    }

    if (this.view === 'logs') {
      this.handleLogsKey(key);
      return;
    }
    if (this.view === 'status') {
      this.handleScrollKey(key, 'statusScroll');
      return;
    }
    if (this.view === 'help') {
      this.handleScrollKey(key, 'helpScroll');
      return;
    }
    if (this.view !== 'chat') return;

    // 换行快捷：Ctrl+J / Shift+Enter / Alt+Enter / 原始 \n 输入
    const isNewline =
      (key.ctrl && key.name === 'j') ||
      (key.shift && key.name === 'return') ||
      (key.meta && (key.name === 'return' || key.name === 'enter')) ||
      (!key.ctrl && !key.meta && chunk === '\n' && key.name !== 'return');
    if (isNewline) {
      this.inputLine = `${this.inputLine.slice(0, this.cursor)}\n${this.inputLine.slice(this.cursor)}`;
      this.cursor++;
      this.queueRender();
      return;
    }

    if (key.name === 'return') {
      await this.submitLine();
      return;
    }
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
    if (key.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      this.queueRender();
      return;
    }
    if (key.name === 'right') {
      this.cursor = Math.min(this.inputLine.length, this.cursor + 1);
      this.queueRender();
      return;
    }
    if (key.name === 'home') {
      this.cursor = 0;
      this.queueRender();
      return;
    }
    if (key.name === 'end') {
      this.cursor = this.inputLine.length;
      this.queueRender();
      return;
    }
    if (key.name === 'up') {
      this.recallHistory(-1);
      return;
    }
    if (key.name === 'down') {
      this.recallHistory(1);
      return;
    }

    if (!key.ctrl && !key.meta && chunk && chunk >= ' ') {
      this.inputLine = this.inputLine.slice(0, this.cursor) + chunk + this.inputLine.slice(this.cursor);
      this.cursor += chunk.length;
      this.queueRender();
    }
  };

  /** ← 选批准、→ 选拒绝，回车确定选中的一项；Ctrl+Y 直接批准、Ctrl+N 直接拒绝 */
  private handleCardKey(key: readline.Key): void {
    if (key.ctrl && (key.name === 'y' || key.name === 'n')) {
      this.answer(key.name === 'y' ? 'approve' : 'deny');
      return;
    }
    if (key.name === 'left' || key.name === 'right') {
      this.choice = key.name === 'left' ? 'approve' : 'deny';
      this.queueRender();
      return;
    }
    if (key.name === 'return' && this.choice) this.answer(this.choice);
  }

  /** 应答卡上的第一张。成功时结算同步推回、卡片随之关掉；被拒的应答（已结算、审批服务不在等）同样关卡并写明原因 */
  private answer(decision: ApprovalDecision): void {
    const card = this.cards[0];
    const reply = this.attendance.respond({ approvalId: card.id, decision, contentHash: card.contentHash });
    if (!reply.ok) this.closeCard(card.id, `应答没有生效：${reply.message}`);
  }

  /** 审批结算了：卡片关掉，聊天区留一行 */
  private closeCard(approvalId: string, line: string): void {
    const index = this.cards.findIndex(card => card.id === approvalId);
    if (index < 0) return;
    const [card] = this.cards.splice(index, 1);
    if (index === 0) this.choice = undefined;
    this.chat.append([`${this.formatHead(chalk.yellow('◆ System'))}审批 ${sanitizeForCard(card.tool)}：${line}`]);
    if (this.view !== 'chat') this.unreadChat++;
    this.queueRender();
  }

  private handleLogsKey(key: readline.Key): void {
    if (key.ctrl && key.name === 'w') {
      this.logWrap = !this.logWrap;
      this.logScroll = 0;
      this.queueRender();
      return;
    }
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
    // End = 到底部：给个越界大值，由 renderBody 的写回钳制落到最后一屏
    else if (key.name === 'end') this[field] = Number.MAX_SAFE_INTEGER;
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
    const firstHead = this.formatHead(chalk.cyan(`❯ ${this.config.prompt}`));
    const contHead = this.formatCont();
    this.chat.append(text.split('\n').map((line, i) => (i === 0 ? firstHead : contHead) + line));

    // 指令解析已统一到全局 inbound:command 相位（plugin-commands）。
    // 适配器不再内联解析：未注册命令被放行为普通消息进入 agent，命中命令
    // 由该相位执行并经 outbound:message 回送渲染到 TUI，与 onebot/webui 一致。
    // shutdown/restart 的 TUI 清理由 lifecycle.onDispose(() => this.stop()) 兜底。
    // userId 'console'：本地终端身份（物理访问 = 运维者本人），命中 authority 的
    // cli:console owner 快速通道；缺省 userId 会被当成匿名回退 defaultAuthority。
    await this.caps.events.emit('inbound:message', {
      content: text,
      sessionId: this.sessionId,
      platform: 'cli',
      userId: 'console',
    });
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

  private switchView(view: CLIView): void {
    if (view === 'chat') this.unreadChat = 0;
    if (this.view !== view) {
      this.previousView = this.view;
      this.view = view;
      this.persistLastView(view);
    }
    this.queueRender();
  }

  private persistLastView(view: CLIView): void {
    if (view === 'help') return;
    // 宿主没提供配置文档时不记：下次启动回到默认视图
    const host = this.caps.hostConfig.current;
    if (!host) return;
    const pluginConfig = host.getPluginConfig(name);
    host.setPluginConfig(name, { ...pluginConfig, lastView: view });
    // 尽力而为：最后视图丢了只是下次回到默认视图，不值得让渲染路径变 async
    host.save().catch(err => this.caps.logger.warn('记录最后视图失败:', err));
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
    // 输入框可变高度（多行输入）：内容行数 + 上下边框，最多 8 行内容。有审批卡时卡片占这个位置
    const box =
      this.cards.length > 0
        ? this.renderCard(width, height)
        : this.renderInputBox(width, this.computeInputDisplayLines(width));
    // 布局：header(1) + sep(1) + body + box + footer(1)
    const bodyHeight = Math.max(3, height - 3 - box.length);

    const out: string[] = [];
    out.push(this.renderHeader(width));
    out.push(chalk.gray(LINE_H.repeat(width)));
    out.push(...this.renderBody(width, bodyHeight));
    out.push(...box);
    out.push(this.renderFooter(width));

    output.write('\x1b[?25l\x1b[H');
    output.write(out.map(line => clearLine(line, width)).join('\n'));
    if (this.view === 'chat' && this.cards.length === 0) {
      // 计算光标在多行输入中的 (row, col)
      const { row: cRow, col: cCol } = this.cursorPosInInput();
      // 行号布局（1-based）：1=header, 2=sep, 3..2+bodyHeight=body, 之后是 inputBox(顶/中.../底), 最后是 footer
      const inputMidStartRow = 2 + bodyHeight + 1 + 1; // header+sep+body+boxTop = 1+1+bodyHeight+1，再 +1 进入第一行内容
      const screenRow = inputMidStartRow + cRow;
      const promptLen = cRow === 0 ? visibleLen(this.makePrompt()) : visibleLen(this.makeContPrompt());
      const screenCol = 2 /* │ 之后 */ + promptLen + cCol;
      output.write(`\x1b[${screenRow};${screenCol}H\x1b[?25h`);
    }
  }

  private renderHeader(width: number): string {
    const persona = this.caps.persona.current?.getPersonaName() ?? 'default';
    const left = ` ${chalk.bold.magenta('●')} ${chalk.bold('Aalis')} ${chalk.gray('·')} ${chalk.cyan(persona)} `;
    const tabs = (['chat', 'logs', 'status', 'help'] as CLIView[])
      .map(v => {
        const label = v.toUpperCase();
        if (v === this.view) return chalk.bold.cyan(`[${label}]`);
        // 非 chat 视图期间聊天区有新内容（确认提示等）：CHAT 页签带计数高亮，切回即清
        if (v === 'chat' && this.unreadChat > 0) return chalk.bold.yellow(` ${label}(${this.unreadChat}) `);
        return chalk.gray(` ${label} `);
      })
      .join(' ');
    const status = chalk.green('● online');
    const right = ` ${tabs}  ${status} `;
    const pad = Math.max(1, width - visibleLen(left) - visibleLen(right));
    return left + ' '.repeat(pad) + right;
  }

  private renderBody(width: number, height: number): string[] {
    const raw = this.getBodyLines(width);
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
      // 写回钳制(与 logs 视图一致):按 down 越过底部时不让存储值继续累加,
      // 否则 footer 的 scroll 数字无限增大,且回滚要先消化整段越界死区
      const field = this.view === 'status' ? 'statusScroll' : 'helpScroll';
      const maxScroll = Math.max(0, raw.length - height);
      if (this[field] > maxScroll) this[field] = maxScroll;
      visible = raw.slice(this[field], this[field] + height);
    }
    while (visible.length < height) visible.push('');
    return visible.slice(0, height).map(line => clipAnsi(line, width));
  }

  private getBodyLines(width: number): string[] {
    if (this.view === 'logs') return this.getLogViewLines(width);
    if (this.view === 'status') return this.getStatusViewLines();
    if (this.view === 'help') return this.getHelpViewLines();
    return this.getChatViewLines(width);
  }

  private getChatViewLines(width: number): string[] {
    const lines: string[] = [];
    const inner = width - 2; // 缩进 2 列
    for (const raw of this.chat.lines) {
      // 宽度感知截断为单行；超长内容直接尾部省略。
      lines.push(`  ${clipAnsi(raw, inner)}`);
    }
    return lines;
  }

  /** 日志视图的增量格式化缓存。logLines 只追加、从不改写，因此已格式化的行
   * 可以按 (width, wrap) 为键永久复用——每帧只格式化"上次之后新增"的条目，
   * 把日志页渲染从 O(全部日志) 降到 O(新增)；宽度变化 / 换行模式切换时整体
   * 失效重建（罕见操作，一次性代价）。全量历史仍然完整可翻。 */
  private logViewCache = { width: -1, wrap: false, upto: 0, lines: [] as string[], lineCounts: [] as number[] };

  private getLogViewLines(width: number): string[] {
    const c = this.logViewCache;
    if (c.width !== width || c.wrap !== this.logWrap) {
      c.width = width;
      c.wrap = this.logWrap;
      c.upto = 0;
      c.lines = [];
      c.lineCounts = [];
    }
    for (; c.upto < this.logLines.length; c.upto++) {
      const before = c.lines.length;
      this.appendLogEntryLines(c.lines, this.logLines[c.upto], width);
      c.lineCounts.push(c.lines.length - before);
    }
    return c.lines;
  }

  /** 内存环形上限：超限时从最旧丢弃约 10% 一块（摊销 O(1)），格式化缓存按 lineCounts
   * 对齐裁剪而非整体失效——避免每次裁剪都 O(全量) 重建。完整日志始终在 logs/latest.log。 */
  private trimLogHead(): void {
    const drop = Math.max(1, Math.ceil(this.config.maxLogEntries / 10));
    this.logLines.splice(0, drop);
    const c = this.logViewCache;
    const cachedDrop = Math.min(drop, c.upto);
    if (cachedDrop > 0) {
      let dropLines = 0;
      for (let i = 0; i < cachedDrop; i++) dropLines += c.lineCounts[i];
      c.lines.splice(0, dropLines);
      c.lineCounts.splice(0, cachedDrop);
    }
    c.upto = Math.max(0, c.upto - drop);
  }

  /** 把单条日志按当前宽度/换行模式格式化后追加进 lines（与 console 输出格式一致：ts LEVEL scope message）。 */
  private appendLogEntryLines(lines: string[], entry: LogEntry, width: number): void {
    const inner = width - 2;
    // LogEntry.timestamp 是完整 ISO，CLI 只需 HH:mm:ss.sss
    const ts = chalk.gray(entry.timestamp.slice(11, 23));
    const level = LEVEL_TAG[entry.level];
    const scope = chalk.magenta(entry.scope);
    const head = `${ts} ${level} ${scope} `;
    const headW = visibleLen(head);
    const msgW = Math.max(1, inner - headW);

    if (!this.logWrap) {
      // 默认：压成单行展示（避免 alternate screen 中跨行覆盖）
      const flat = sanitizeForSingleLine(entry.message);
      const msg = stringWidth(flat) <= msgW ? flat : clipExact(flat, msgW);
      lines.push(`  ${head}${msg}`);
      return;
    }

    // 换行模式：保留真实换行 + 按宽度软折行；每个续行用 contHead 缩进对齐到消息列
    const contHead = ' '.repeat(headW);
    const rawLines = entry.message
      .replace(/\r\n|\r/g, '\n')
      .replace(/\t/g, '    ')
      .split('\n');
    let isFirst = true;
    for (const raw of rawLines) {
      // 按可见宽度软折行
      const wrapped = wrapByVisibleWidth(raw, msgW);
      const segs = wrapped.length > 0 ? wrapped : [''];
      for (const seg of segs) {
        const prefix = isFirst ? head : contHead;
        lines.push(`  ${prefix}${seg}`);
        isFirst = false;
      }
    }
  }

  private getStatusViewLines(): string[] {
    const serviceNames = this.caps.services.names();
    const adapter = getPlatformAdapters(this.caps.platform).find(a => a.platform === 'cli');
    const connections = adapter?.getConnections?.() ?? [];
    const persona = this.caps.persona.current?.getPersonaName() ?? '-';
    const sec = (t: string) => chalk.bold.cyan(`▎ ${t}`);
    const kv = (k: string, v: string) => `    ${chalk.gray(k.padEnd(14))} ${v}`;
    const out: string[] = [];
    out.push(sec('运行时'));
    out.push(kv('persona', persona));
    out.push(kv('cli session', this.sessionId));
    out.push(kv('log buffer', `${this.logLines.length} 条`));
    out.push('');
    out.push(sec(`服务 (${serviceNames.length})`));
    for (const s of serviceNames) out.push(`    ${chalk.green('●')} ${s}`);
    out.push('');
    out.push(sec(`平台连接 (${connections.length})`));
    if (connections.length === 0) out.push(`    ${chalk.gray('— 无')}`);
    else
      for (const c of connections) {
        const dot =
          c.status === 'online' ? chalk.green('●') : c.status === 'connecting' ? chalk.yellow('●') : chalk.red('●');
        out.push(`    ${dot} ${chalk.cyan(c.platform)}:${c.id} ${chalk.gray(c.status)}`);
      }
    return out.map(l => (l.length === 0 ? '' : ` ${l}`));
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
    out.push(row('Esc', '返回上一个视图'));
    out.push(row('Ctrl+C', '退出'));
    out.push('');
    out.push(sec('滚动 (Logs / Status / Help)'));
    out.push(row('↑ / ↓', '逐行滚动'));
    out.push(row('PgUp/Dn', '翻页'));
    out.push(row('Home', '回到顶部'));
    out.push(row('End', '到底部'));
    out.push(row('Ctrl+W', '日志页：切换换行模式（多行完整展示）'));
    out.push('');
    out.push(sec('编辑'));
    out.push(row('Enter', '提交输入'));
    out.push(row('Ctrl+J', '插入换行（macOS Ctrl+Enter）'));
    out.push(row('Shift+Ent', '插入换行（如终端支持）'));
    out.push(row('↑ / ↓', '历史记录回溯（chat 视图）'));
    out.push('');
    out.push(sec('审批卡（卡在时打字与回车不算应答，也不进输入框）'));
    out.push(row('← / →', '选批准 / 拒绝，Enter 确定'));
    out.push(row('Ctrl+Y', '批准'));
    out.push(row('Ctrl+N', '拒绝'));
    out.push('');
    out.push(sec('提示'));
    out.push(
      `    ${chalk.gray('• 完整日志写入家目录的 logs/latest.log，每次启动时上一轮改名为 latest.1.log，保留 5 份；跨重启持续跟随用 tail -F。')}`,
    );
    out.push(`    ${chalk.gray('• 退出时自动恢复原终端内容（alternate screen）。')}`);
    out.push(`    ${chalk.gray('• 输入以 / 开头会按命令解析，否则发给 agent。')}`);
    out.push(
      `    ${chalk.gray('• ↑/↓、PgUp/PgDn、Home/End 滚动 Logs / Status / Help；选择 / 复制文本直接用终端原生操作。')}`,
    );
    return out.map(l => (l.length === 0 ? '' : ` ${l}`));
  }

  /** 计算输入框的多行内容（不含边框、不含 padding） */
  private computeInputDisplayLines(width: number): string[] {
    const inner = width - 2;
    if (this.view !== 'chat') {
      const total =
        this.view === 'logs'
          ? this.logLines.length
          : this.view === 'status'
            ? this.getStatusViewLines().length
            : this.getHelpViewLines().length;
      const scroll =
        this.view === 'logs' ? this.logScroll : this.view === 'status' ? this.statusScroll : this.helpScroll;
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
  private cursorPosInInput(): { row: number; col: number } {
    if (this.view !== 'chat') return { row: 0, col: 0 };
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

  /**
   * 审批卡：标题行、事实、应答项，上下边框。卡片最多高到正文只剩 3 行：事实放不下时保留首尾几行，写明省略了多少行。
   * 事实显示前经 sanitizeForCard 清洗，太长的保留首尾、写明省略了多少字
   */
  private renderCard(width: number, height: number): string[] {
    const card = this.cards[0];
    const inner = width - 2;
    const waiting = this.cards.length > 1 ? ` · 还有 ${this.cards.length - 1} 张` : '';
    const title = `${chalk.bold.yellow('需要批准')} ${sanitizeForCard(card.tool)} · 会话 ${sanitizeForCard(card.sessionId)}${waiting}`;
    const facts = cardFacts(card.facts).flatMap(([label, text]) => factLines(label, text, inner - 2));
    // 高度：header、sep、footer 各一行，正文至少 3 行，卡片的上下边框、标题行与应答行
    const room = height - 10;
    const shown =
      facts.length <= room
        ? facts
        : [
            ...facts.slice(0, Math.ceil((room - 1) / 2)),
            chalk.gray(`…（省略 ${facts.length - room + 1} 行）…`),
            ...facts.slice(facts.length - Math.floor((room - 1) / 2)),
          ];
    const option = (decision: ApprovalDecision, label: string) =>
      this.choice === decision ? chalk.inverse(`❯ ${label}`) : `  ${label}`;
    const options = `${option('approve', '批准')}   ${option('deny', '拒绝')}   ${chalk.gray('←/→ 选择 · Enter 确定 · Ctrl+Y 批准 · Ctrl+N 拒绝')}`;
    const edge = chalk.yellow(BOX_V);
    return [
      chalk.yellow(`${BOX_TL}${LINE_H.repeat(inner)}${BOX_TR}`),
      ...[title, ...shown, options].map(line => `${edge}${padAnsi(` ${line}`, inner)}${edge}`),
      chalk.yellow(`${BOX_BL}${LINE_H.repeat(inner)}${BOX_BR}`),
    ];
  }

  private makePrompt(): string {
    return `${chalk.cyan('❯')} ${chalk.bold(this.config.prompt)} `;
  }

  private makeContPrompt(): string {
    return `${chalk.gray('…')} ${' '.repeat(this.config.prompt.length)} `;
  }

  private renderFooter(width: number): string {
    const baseItems = [
      `${chalk.cyan('^T')} chat`,
      `${chalk.cyan('^L')} logs`,
      `${chalk.cyan('^S')} status`,
      `${chalk.cyan('^G')} help`,
      `${chalk.cyan('Esc')} back`,
      `${chalk.cyan('^C')} exit`,
    ];
    if (this.view === 'logs') {
      baseItems.push(`${chalk.cyan('^W')} wrap:${this.logWrap ? chalk.green('on') : chalk.gray('off')}`);
    }
    const items = baseItems.join(chalk.gray('  ·  '));
    const left = ` ${items} `;
    return padAnsi(chalk.gray.dim(left), width);
  }
}

// ===== 审批卡 =====

type ApprovalDecision = 'approve' | 'deny';

/** 卡片结算后在聊天区留的话 */
const SETTLED_LINES: Record<SettledState, string> = {
  approved: '已批准',
  denied: '已拒绝',
  expired: '没有人应答，按拒绝处理',
  cancelled: '已撤销',
};

/** 每项事实显示的字数上限，超出的保留首尾 */
const CARD_FACT_LIMIT = 1000;

/** 卡上的事实：标签与原文 */
function cardFacts(facts: ApprovalFacts): Array<[label: string, text: string]> {
  const rows: Array<[string, string]> = [];
  if (facts.command !== undefined) rows.push(['命令', facts.command]);
  if (facts.cwd !== undefined) rows.push(['目录', facts.cwd]);
  if (facts.diff) rows.push(['文件', facts.diff.path], ['改动', facts.diff.patch ?? '疑似含密钥，不显示内容']);
  if (Object.keys(facts.params).length > 0) rows.push(['参数', JSON.stringify(facts.params)]);
  return rows;
}

/** 一项事实：清洗后按换行拆开、按宽度折行，标签只在第一行 */
function factLines(label: string, text: string, width: number): string[] {
  const head = `${chalk.gray(label)}  `;
  const indent = ' '.repeat(visibleLen(head));
  return sanitizeForCard(text, CARD_FACT_LIMIT)
    .replace(/\t/g, '    ')
    .split('\n')
    .flatMap(line => wrapByVisibleWidth(line, width - indent.length))
    .map((segment, i) => (i === 0 ? head : indent) + segment);
}

// ===== 视觉常量 / 工具 =====

const LINE_H = '─';
const BOX_TL = '╭';
const BOX_TR = '╮';
const BOX_BL = '╰';
const BOX_BR = '╯';
const BOX_V = '│';

const LEVEL_TAG: Record<LogEntry['level'], string> = {
  debug: chalk.gray('DEBUG'),
  info: chalk.cyan('INFO '),
  warn: chalk.yellow('WARN '),
  error: chalk.red('ERROR'),
};

/**
 * 兜底恢复终端状态：进程在 TUI 启动后异常退出时，清理链可能来不及执行。
 * 这里关闭鼠标上报、恢复光标、退出备用屏，并关闭 raw mode。
 */
function restoreTerminalState(): void {
  try {
    if (input.isTTY) input.setRawMode(false);
  } catch {
    /* ignore */
  }
  try {
    output.write('\x1b[?1007l\x1b[?25h\x1b[?1049l');
  } catch {
    /* ignore */
  }
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

/**
 * 把单行字符串按可见宽度软折行（CJK 算 2 列，emoji/ANSI 不破坏）。
 * 返回若干段，每段宽度 ≤ width。空字符串返回 [''] 以保留视觉空行。
 */
function wrapByVisibleWidth(s: string, width: number): string[] {
  if (width <= 0) return [s];
  if (stringWidth(s) <= width) return [s];
  const segs: string[] = [];
  let remaining = s;
  // 防御：极端长字符串避免无限循环
  while (remaining.length > 0 && segs.length < 1000) {
    if (stringWidth(remaining) <= width) {
      segs.push(remaining);
      break;
    }
    // cli-truncate 在 width 处截断，得到第一段
    const head = cliTruncate(remaining, width, {
      position: 'end',
      preferTruncationOnSpace: false,
      truncationCharacter: '',
    });
    if (!head) break;
    segs.push(head);
    // 计算消耗的字符数：以可见宽度对齐，逐字符切到与 head 同等宽度
    let consumed = 0;
    let acc = 0;
    for (const ch of remaining) {
      acc += stringWidth(ch);
      consumed += ch.length;
      if (acc >= stringWidth(head)) break;
    }
    remaining = remaining.slice(consumed);
  }
  return segs.length > 0 ? segs : [''];
}

/** 按终端列宽右侧补空格 */
function padAnsi(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return clipAnsi(s, width);
  return s + ' '.repeat(width - w);
}

/** 行尾补宽 + \x1b[K 清残影 */
function clearLine(s: string, width: number): string {
  return `${padAnsi(s, width)}\x1b[K`;
}

/**
 * 清洗多行 / 含控制字符的日志消息，使之可安全渲染到 alternate screen 单行内。
 * - \r\n / \r / \n 一律折叠为 ' ↵ '（可见的回车标记）
 * - \t 换为 4 个空格
 * - 其它 C0 控制字符（\x00-\x1F 除 \x1b 颜色序列）剔除
 */
function sanitizeForSingleLine(s: string): string {
  return (
    s
      .replace(/\r\n|\r|\n/g, ' ↵ ')
      .replace(/\t/g, '    ')
      // 保留 ESC（颜色），剔除其它 C0 控制字符
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 需要按字面匹配 C0 控制字符以清洗终端输入
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]/g, '')
  );
}
