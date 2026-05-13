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

/** 默认环形 buffer 容量（条）。webui 日志面板/CLI 启动回放从这里取最近 N 条。 */
export const DEFAULT_LOG_BUFFER_MAX = 2000;

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
 *
 * 内存上界：`bufferSize × ~150 字节/条`。默认 2000 条 ≈ 300 KB。
 */
export class LogHub {
  /** 进程级默认中枢——所有未显式传 hub 的 Logger 都用它 */
  static readonly default: LogHub = new LogHub();

  private buffer: LogEntry[] = [];
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  private bufferMax: number;

  constructor(bufferMax: number = DEFAULT_LOG_BUFFER_MAX) {
    this.bufferMax = Math.max(1, bufferMax | 0);
  }

  /**
   * 取最近的日志条目副本。
   *
   * 返回值是浅拷贝数组（条目本身仍是原引用，但 LogEntry 是不可变 plain object
   * ——读取者改它只会影响自己手上那份）。这样外部 push/splice 不会污染内部环形 buffer。
   */
  getBuffer(): LogEntry[] {
    return this.buffer.slice();
  }

  /** 调整环形 buffer 容量。缩小时会立刻丢弃多余的旧条目。 */
  setBufferMax(size: number): void {
    this.bufferMax = Math.max(1, size | 0);
    while (this.buffer.length > this.bufferMax) this.buffer.shift();
  }

  /** 当前容量（条），用于诊断/状态查询 */
  getBufferMax(): number {
    return this.bufferMax;
  }

  /** 清空 buffer（不影响订阅者；常用于测试或会话切换） */
  clear(): void {
    this.buffer.length = 0;
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
    if (this.buffer.length > this.bufferMax) this.buffer.shift();
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
