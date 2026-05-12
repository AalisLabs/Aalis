export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_BUFFER_MAX = 500;

/**
 * 日志中枢：封装 buffer / listener / consoleSink 开关。
 *
 * 每个 `App` 拥有自己的 LogHub（沙盒、集成测试可独立通道）；
 * `LogHub.default` 是进程级共享中枢，供未注入自定义 hub 的 Logger 使用。
 */
export class LogHub {
  /** 进程级默认中枢——所有未显式传 hub 的 Logger 都用它 */
  static readonly default: LogHub = new LogHub();

  private buffer: LogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private consoleSink = true;
  /**
   * 可选的"console 输出格式化器"。若设置，则 push() 用它生成 console 行；
   * 未设置时回退到默认的 raw 格式。这让"彩色 console 输出"由 runtime 注入，
   * 而 LogHub 内部仍是 console 输出的唯一 gate——setConsoleSinkEnabled(false)
   * 能彻底静默全部 console 输出（CLI 进入 alt-screen 时需要这个保证，否则
   * 外挂的 console 监听器会继续刷屏，把 TUI 画面冲乱）。
   */
  private consoleFormatter: ((entry: LogEntry) => string) | null = null;

  getBuffer(): LogEntry[] {
    return this.buffer;
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConsoleSinkEnabled(enabled: boolean): void {
    this.consoleSink = enabled;
  }

  isConsoleSinkEnabled(): boolean {
    return this.consoleSink;
  }

  /**
   * 设置 console 输出格式化器（runtime 注入彩色版本时使用）。
   * 传 null 恢复默认 raw 格式。
   */
  setConsoleFormatter(formatter: ((entry: LogEntry) => string) | null): void {
    this.consoleFormatter = formatter;
  }

  /** 接收一条日志（Logger 内部调用） */
  push(entry: LogEntry, args: unknown[]): void {
    if (this.consoleSink) {
      const line = this.consoleFormatter
        ? this.consoleFormatter(entry)
        : `${entry.timestamp} ${entry.level.toUpperCase().padEnd(5)} ${entry.scope} ${entry.message}`;
      if (args.length > 0) {
        console.log(line, ...args);
      } else {
        console.log(line);
      }
    }
    this.buffer.push(entry);
    if (this.buffer.length > LOG_BUFFER_MAX) this.buffer.shift();
    for (const fn of this.listeners) fn(entry);
  }
}

export class Logger {
  private minLevel: LogLevel;
  private readonly hub: LogHub;

  /**
   * @param scope    日志作用域（构造前缀）
   * @param minLevel 最低输出级别
   * @param hub      日志中枢；缺省使用 `LogHub.default`。
   *                 多 App / 沙盒场景可注入独立 `new LogHub()` 实现隔离。
   */
  constructor(
    private scope: string,
    minLevel: LogLevel = 'info',
    hub: LogHub = LogHub.default,
  ) {
    this.minLevel = minLevel;
    this.hub = hub;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel, this.hub);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const timestamp = new Date().toISOString().slice(11, 23);
    const entry: LogEntry = { timestamp, level, scope: this.scope, message };
    this.hub.push(entry, args);
  }
}
