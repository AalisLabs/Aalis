export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** 进程内单调递增的稳定序号（每个 LogHub 实例独立计数）。用作下游 React/UI key 与分页 cursor。 */
  seq: number;
  /** 本地时区 ISO-8601 时间戳（如 `2026-05-27T09:09:16.028+01:00`）。
   *  保留完整日期与偏移，便于人读与机器解析；sink 按需截取显示。 */
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

// ════════════════════════════════════════════════════════════
// 单行日志序列化契约（format ↔ parse 对偶）
//
// 行格式：`seq|timestamp|level|scope|message\n`
//   - message 内部换行被转义为字面 `\n`，保证「一行一条」可逐行解析
//   - 与 LogHub 一样零 I/O 知识：纯字符串变换，不感知文件/路径/编码
//
// 唯一权威：runtime 的 file-logger 写、webui-server / cli 读历史，全部复用这一对函数，
// 避免格式契约在多个插件里各抄一份后悄然漂移。
// ════════════════════════════════════════════════════════════

/** 把一条 LogEntry 序列化为单行文本（含结尾换行）。 */
export function formatLogLine(entry: LogEntry): string {
  const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
  return `${entry.seq}|${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
}

/** 反向解析单行日志；格式错乱时返回 null。与 {@link formatLogLine} 对偶。 */
export function parseLogLine(line: string): LogEntry | null {
  const i1 = line.indexOf('|');
  if (i1 < 0) return null;
  const i2 = line.indexOf('|', i1 + 1);
  if (i2 < 0) return null;
  const i3 = line.indexOf('|', i2 + 1);
  if (i3 < 0) return null;
  const i4 = line.indexOf('|', i3 + 1);
  if (i4 < 0) return null;
  const seq = Number(line.slice(0, i1));
  if (!Number.isFinite(seq)) return null;
  return {
    seq,
    timestamp: line.slice(i1 + 1, i2),
    level: line.slice(i2 + 1, i3) as LogLevel,
    scope: line.slice(i3 + 1, i4),
    message: line.slice(i4 + 1).replace(/\\n/g, '\n'),
  };
}

/**
 * 日志中枢：纯 pub-sub 通道。
 *
 * 设计原则：
 * - **零 I/O 知识**：LogHub 不感知 stdout / 文件 / TTY / 染色等任何渲染细节
 * - **零状态**：不持有任何 buffer。启动期日志暂存由 runtime 的 bootstrap-buffer 负责
 * - **写一次，多处订阅**：`push` 同步广播给所有 `onEntry` 订阅者
 *
 * 每个 `App` 拥有自己的 LogHub（沙盒、集成测试可独立通道）；
 * `LogHub.default` 是进程级共享中枢，供未注入自定义 hub 的 Logger 使用。
 */
export class LogHub {
  /** 进程级默认中枢——所有未显式传 hub 的 Logger 都用它 */
  static readonly default: LogHub = new LogHub();

  private listeners: Set<(entry: LogEntry) => void> = new Set();
  /** 单调递增的 entry seq；首条 = 0。 */
  private nextSeq = 0;

  /** 分配下一个 seq 给即将 push 的 entry（Logger 内部使用）。 */
  allocSeq(): number {
    return this.nextSeq++;
  }

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 接收一条日志（Logger 内部调用） */
  push(entry: LogEntry): void {
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

    // 本地时区 ISO 时间戳（YYYY-MM-DDTHH:mm:ss.sss±HH:mm）——信息保真且贴近人读。
    // sink（console / CLI / WebUI）按显示需求自行截取，不在源头丢日期。
    const timestamp = formatLocalIso(new Date());
    // 将额外参数（错误对象 / 上下文等）序列化并拼到 message 末尾，
    // 避免 sink 只读 message 时丢失错误细节。**保持运行时中立**：只用纯 ES
    // 原语，不依赖 node:util / window 等任何宿主 API。
    const tail = args.length === 0 ? '' : ` ${args.map(stringifyArg).join(' ')}`;
    const entry: LogEntry = {
      seq: this.hub.allocSeq(),
      timestamp,
      level,
      scope: this.scope,
      message: `${message}${tail}`,
    };
    this.hub.push(entry);
  }
}

/**
 * 把 logger.xxx(message, ...args) 里的 args 元素渲染成字符串。
 *
 * 设计目标：**零运行时依赖**——只用 ECMAScript 标准原语，Node/Deno/Bun/Browser
 * 都能跑。需要 `util.inspect` 级别的深度对象渲染时，由外层 sink 自行处理
 * （sink 可订阅 LogHub 后用宿主 API 二次格式化）。
 *
 * - `Error` / 任何带 `stack` 的对象：尽量打印 stack；否则退化为 name + message
 * - `string`：原样
 * - `null` / `undefined` / 原始值：`String(v)`
 * - 普通对象 / 数组：尝试 `JSON.stringify`，遇到循环引用或不可序列化值时退化
 *   为 `String(v)`（一般得到 `[object Object]`，但至少不会抛）
 */

/**
 * 把 `Date` 渲染成本地时区 ISO-8601（带显式偏移），如：
 *   `2026-05-27T09:09:16.028+01:00` / `2026-05-27T00:09:16.028Z`（UTC）
 *
 * 设计：日志默认以"运维所在地"读，避免把伦敦同事的 09:00 印成 08:00；
 * 偏移段保证仍是合法 ISO-8601，下游解析器 (`new Date(...)`) 也能精确还原。
 * 偏移 0 时输出 `Z` 以贴近通用习惯。零运行时依赖。
 */
function formatLocalIso(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const offStr = offMin === 0 ? 'Z' : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    offStr
  );
}

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    return value.stack ? value.stack : head;
  }
  // 鸭子类型：异步链路里 Error 可能跨 realm，instanceof 失效；只要含 stack 就尽量打 stack
  if (typeof value === 'object' && typeof (value as { stack?: unknown }).stack === 'string') {
    return (value as { stack: string }).stack;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
