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

/**
 * 日志接口 —— core 各子系统与插件持有的最小日志面。
 *
 * core 不绑定具体实现：宿主可经 `AppOptions.logger` 注入任意实现
 * （如 pino/winston 适配对象）；缺省使用 {@link DefaultLogger}（写入
 * LogHub 管线，runtime 的 console/file/webui sink 监听该管线）。
 * 注入自定义实现后 LogHub 管线不再由 core 写入，日志后端由注入方自理。
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** 派生带子作用域的 Logger（创建子激活时由 ActivationHost 调用） */
  child(scope: string): Logger;
}

/**
 * 缺省 Logger 实现：按级别过滤后写入 {@link LogHub}。
 */
export class DefaultLogger implements Logger {
  private readonly minLevel: LogLevel;
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
    /**
     * 时钟：日志时间戳的唯一时间来源。缺省 `() => new Date()`（独立运行/测试兜底，保持现行为）；
     * 宿主（@aalis/runtime）经 `App({ now })` 显式注入,从而 core 逻辑不含 ambient 时间效应、
     * 测试可注入固定时钟得到确定性时间戳。
     */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.minLevel = minLevel;
    this.hub = hub;
  }

  child(scope: string): Logger {
    return new DefaultLogger(`${this.scope}:${scope}`, this.minLevel, this.hub, this.now);
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
    const timestamp = formatLocalIso(this.now());
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

/** 附加参数渲染过程本身抛错时的固定占位串 */
const UNRENDERABLE_ARG = '[无法渲染的参数]';

/**
 * 把 logger.xxx(message, ...args) 里的 args 元素渲染成字符串。**绝不抛。**
 *
 * 设计目标：**零运行时依赖**——只用 ECMAScript 标准原语，Node/Deno/Bun/Browser
 * 都能跑。需要 `util.inspect` 级别的深度对象渲染时，由外层 sink 自行处理
 * （sink 可订阅 LogHub 后用宿主 API 二次格式化）。
 *
 * - `Error` / 任何带 `stack` 的对象：尽量打印 stack；否则退化为 name + message。`Error` 其后接因果链，
 *   见 {@link causeTail}
 * - `string`：原样
 * - `null` / `undefined` / 原始值：`String(v)`
 * - 普通对象 / 数组：尝试 `JSON.stringify`，遇到循环引用或不可序列化值时退化
 *   为 `String(v)`（一般得到 `[object Object]`）；null 原型对象等无法转原始值的对象
 *   `String(v)` 也会抛，再退回 `Object.prototype.toString`
 *
 * 绝不抛：日志调用常在 catch 与拆卸路径里，渲染参数时抛错会盖掉本来要记的错误。
 * `instanceof`、读 `stack`、`JSON.stringify`、转原始值都会执行对象自己的代码（getter、
 * `toJSON`、Proxy 陷阱；已撤销的 Proxy 几乎任何操作都抛），任何一步抛错都返回 {@link UNRENDERABLE_ARG}。
 * 渲染结果不一定是字符串（`stack` 可被赋成任意值，`toJSON` 返回 `undefined` 时 `JSON.stringify`
 * 也返回 `undefined`），在同一个 try 里用 `String()` 规整，否则调用方拼接时才转换、抛在兜底之外；
 * 规整本身抛错（如 null 原型对象）同样返回占位串。
 */
function stringifyArg(value: unknown): string {
  try {
    const rendered: unknown = renderArg(value);
    return typeof rendered === 'string' ? rendered : String(rendered);
  } catch {
    return UNRENDERABLE_ARG;
  }
}

/** {@link stringifyArg} 的渲染本体：各步都可能执行对象自己的代码而抛错，也可能返回非字符串，均由 stringifyArg 兜住 */
function renderArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) {
    const head = `${value.name}: ${value.message}`;
    // 先把 stack 规整成字符串再拼因果链：stack 可被赋成 Symbol 等任意值，直接拼接会抛
    return String(value.stack ? value.stack : head) + causeTail(value);
  }
  // 鸭子类型：异步链路里 Error 可能跨 realm，instanceof 失效；只要含 stack 就尽量打 stack
  if (typeof value === 'object' && typeof (value as { stack?: unknown }).stack === 'string') {
    return (value as { stack: string }).stack;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      try {
        return String(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
  }
  return String(value);
}

// ----- 错误因果链 -----

/** 因果链最多展开的 cause 层数 */
const CAUSE_DEPTH = 5;
/** 日志里每个 AggregateError 最多列出的子错误条数 */
const AGGREGATE_ITEMS = 10;
/** 摘要里每个 AggregateError 最多列出的子错误条数 */
const SUMMARY_ITEMS = 3;
/** 摘要里非 Error 值的渲染结果最长的字符数（UTF-16 码元，含截断时结尾的「…」） */
const SUMMARY_VALUE_CHARS = 200;

/**
 * 沿 `cause` 取出至多 {@link CAUSE_DEPTH} 层（不含起点）；非 Error 的 cause 收下后不再往下走。
 * `end` 说明链为何没有自然结束：循环引用、超过层数，或读取本身抛错（getter、Proxy 陷阱）。绝不抛。
 */
function causesOf(error: Error): { causes: unknown[]; end?: string } {
  const causes: unknown[] = [];
  const seen = new Set<unknown>([error]);
  try {
    let cause: unknown = error.cause;
    while (cause !== undefined) {
      if (seen.has(cause)) return { causes, end: '[循环引用]' };
      if (causes.length === CAUSE_DEPTH) return { causes, end: `[超过 ${CAUSE_DEPTH} 层，其余省略]` };
      // 先判定再收下：判定本身可能抛（Proxy 陷阱），抛了这一层按读取失败记，不重复列出
      const layer = cause instanceof Error ? cause : undefined;
      causes.push(cause);
      seen.add(cause);
      cause = layer?.cause;
    }
    return { causes };
  } catch {
    return { causes, end: UNRENDERABLE_ARG };
  }
}

/**
 * 一层错误的文字。Error：日志取「名称: 消息」，摘要（`forSummary`）只取消息；消息为空只取名称。其余值按附加参数规则
 * 渲染后取首行（跨 realm 的错误因此只留 stack 首行），摘要里另限 {@link SUMMARY_VALUE_CHARS} 字符，超出截断、以「…」结尾，
 * 不截在代理对中间。只读名称与消息，不展开其它属性。绝不抛。
 */
function describeLayer(value: unknown, forSummary: boolean): string {
  try {
    if (value instanceof Error) {
      return forSummary ? String(value.message || value.name) : Error.prototype.toString.call(value);
    }
    const line = stringifyArg(value).split('\n', 1)[0];
    if (!forSummary || line.length <= SUMMARY_VALUE_CHARS) return line;
    return `${line.slice(0, SUMMARY_VALUE_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
  } catch {
    return UNRENDERABLE_ARG;
  }
}

/**
 * AggregateError 的子错误：`[errors] N 项` 后每项另起一行、缩进两格（多行消息原样续行），超过 {@link AGGREGATE_ITEMS} 条
 * 写「…另 N 项」。子错误不再展开各自的 cause。绝不抛：读取或遍历 `errors` 抛错（如被改成非数组）时不列。
 */
function aggregateLines(value: unknown): string {
  try {
    if (!(value instanceof AggregateError)) return '';
    const items: unknown[] = value.errors;
    const lines = items.slice(0, AGGREGATE_ITEMS).map(item => `\n  ${describeLayer(item, false)}`);
    const rest = items.length - AGGREGATE_ITEMS;
    return `\n[errors] ${items.length} 项${lines.join('')}${rest > 0 ? `\n  …另 ${rest} 项` : ''}`;
  } catch {
    return '';
  }
}

/**
 * 附在 Error 的 stack 之后的因果链：起点若是 AggregateError 先列子错误，再沿 `cause` 逐层另起一行，以
 * `[cause] 名称: 消息` 开头（多行消息原样续行；该层是 AggregateError 同样接着列子错误），链没有自然结束时末行写明原因。
 * 只有最外层带 stack。绝不抛：链上任何一处读取抛错只影响那一处，最外层照常输出。
 */
function causeTail(error: Error): string {
  const { causes, end } = causesOf(error);
  let tail = aggregateLines(error);
  for (const cause of causes) tail += `\n[cause] ${describeLayer(cause, false)}${aggregateLines(cause)}`;
  return end === undefined ? tail : `${tail}\n[cause] ${end}`;
}

/** 摘要里一层的首行 */
function summaryLine(value: unknown): string {
  return describeLayer(value, true).split('\n', 1)[0];
}

/**
 * 摘要里接在 AggregateError 层之后的子错误：`: ` 后接前 {@link SUMMARY_ITEMS} 条的首行，以 `; ` 相连，超出写「…另 N 项」；
 * 没有子错误时为空。子错误不再展开各自的 cause。绝不抛：读取或遍历 `errors` 抛错时不列。
 */
function aggregateSummary(value: unknown): string {
  try {
    if (!(value instanceof AggregateError)) return '';
    const items: unknown[] = value.errors;
    const shown = items.slice(0, SUMMARY_ITEMS).map(summaryLine);
    if (items.length > SUMMARY_ITEMS) shown.push(`…另 ${items.length - SUMMARY_ITEMS} 项`);
    return shown.length === 0 ? '' : `: ${shown.join('; ')}`;
  } catch {
    return '';
  }
}

/**
 * 抛出值的一行说明（`PluginEntry.error` 与注册校验失败的日志）。Error：消息后接因果链摘要，各层取首行，以 ` ← ` 相连，
 * 层数上限与收尾说明同日志；AggregateError 层之后接子错误（见 {@link aggregateSummary}）。包装错误常写成「前缀: cause 的消息」：
 * 上一层首行以本层首行结尾，且两者相同或其间以 `:` / `：`（其后可有空白）分隔时，省略本层；首行为空的层不列。其余值取渲染结果首行并限长
 * （见 {@link describeLayer}）。绝不抛。
 * @internal
 */
export function summarizeError(error: unknown): string {
  try {
    const message = describeLayer(error, true);
    if (!(error instanceof Error)) return message;
    let summary = message + aggregateSummary(error);
    let previous = message.split('\n', 1)[0];
    const { causes, end } = causesOf(error);
    for (const cause of causes) {
      const line = summaryLine(cause);
      // 首行为空的层（空串 cause、以换行开头的消息）没有可显示的内容：不接「←」，去重仍以上一个非空首行为准，子错误照接
      if (line) {
        const repeated =
          previous.endsWith(line) && /(?:^|[:：]\s*)$/.test(previous.slice(0, previous.length - line.length));
        if (!repeated) summary += ` ← ${line}`;
        previous = line;
      }
      summary += aggregateSummary(cause);
    }
    return end === undefined ? summary : `${summary} ← ${end}`;
  } catch {
    return UNRENDERABLE_ARG;
  }
}
