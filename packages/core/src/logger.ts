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
 * 日志中枢：纯 pub-sub 通道。
 *
 * 设计原则：
 * - **零 I/O 知识**：LogHub 不感知 stdout / 文件 / TTY / 染色等任何渲染细节
 * - **写一次，多处订阅**：通过 `onEntry` 把 LogEntry 广播给所有订阅者
 *   （runtime/host 注入文件 sink 与 stdout sink；CLI/WebUI 注入自己的视图）
 * - **buffer**：保留最近 N 条供后接管的订阅者回放（如 CLI 启动时回填日志视图）
 *
 * 每个 `App` 拥有自己的 LogHub（沙盒、集成测试可独立通道）；
 * `LogHub.default` 是进程级共享中枢，供未注入自定义 hub 的 Logger 使用。
 */
export class LogHub {
  /** 进程级默认中枢——所有未显式传 hub 的 Logger 都用它 */
  static readonly default: LogHub = new LogHub();

  private buffer: LogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();

  getBuffer(): LogEntry[] {
    return this.buffer;
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 接收一条日志（Logger 内部调用） */
  push(entry: LogEntry, _args: unknown[]): void {
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
