import type { Events } from '@aalis/core';
import { type LogEntry, LogHub, type LogLevel } from '@aalis/core';
import chalk from 'chalk';
import { getBootstrapBuffer } from './bootstrap-buffer.js';

/**
 * 运行时层注入的事件——`@aalis/core` 不感知"终端归属"这件事，
 * 仅靠 EventBus 的字符串事件名传递。
 *
 * - `terminal:claimed`：某 UI（CLI/TUI）开始独占 stdout（alt-screen/raw-mode）
 * - `terminal:released`：归还 stdout
 */
declare module '@aalis/core' {
  interface AalisEvents {
    'terminal:claimed': [owner: string];
    'terminal:released': [owner: string];
  }
}

/**
 * Console sink —— 运行时层的 stdout 输出（按需染色）。
 *
 * 与 file-logger 对偶：core 仅产生 LogEntry（零 I/O 知识），染色 / 终端假设全在本宿主层。
 * 所有 stdout 输出都从这里走；webui-only / 嵌入式部署不装本 sink 即无需 chalk。
 *
 * 染色检测顺序（命中即决定）：
 *   FORCE_COLOR=0 / FORCE_COLOR=false → 关闭
 *   FORCE_COLOR=其余值                → 开启
 *   NO_COLOR 非空                     → 关闭
 *   process.stdout.isTTY === true     → 开启
 *   其余（重定向到文件 / CI / journald / Docker -d） → 关闭
 *
 * 这样 `node dist/index.js > app.log` 文件里不会留 ANSI escape codes。
 */
function shouldColorize(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return false;
    return true;
  }
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

const IDENTITY = (s: string) => s;
const COLORIZE = shouldColorize();

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = COLORIZE
  ? {
      debug: chalk.gray,
      info: chalk.cyan,
      warn: chalk.yellow,
      error: chalk.red,
    }
  : {
      debug: IDENTITY,
      info: IDENTITY,
      warn: IDENTITY,
      error: IDENTITY,
    };

const dim = COLORIZE ? chalk.gray : IDENTITY;
const accent = COLORIZE ? chalk.magenta : IDENTITY;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function formatEntry(entry: LogEntry): string {
  const colorFn = LEVEL_COLORS[entry.level];
  // LogEntry.timestamp 是完整 ISO（YYYY-MM-DDTHH:mm:ss.sssZ）；stdout 只看当前运行，
  // 取 HH:mm:ss.sss 部分即可（与原有显示一致），完整日期保留在 file/webui。
  const shortTs = entry.timestamp.slice(11, 23);
  const prefix = `${dim(shortTs)} ${colorFn(entry.level.toUpperCase().padEnd(5))} ${accent(entry.scope)}`;
  return `${prefix} ${entry.message}`;
}

export interface ConsoleSinkHandle {
  dispose(): void;
  /**
   * 在 App 构造完成后绑定其事件总线：sink 开始监听 `terminal:claimed/released`，
   * 当任何 UI 接管终端时自动停止写 stdout。
   *
   * 必须显式调用——`installConsoleSink()` 在 App 之前运行（需要捕获最早期日志），
   * 此时还没有事件总线可订阅。传宿主根绑定的 events（`app.bind({ events }).events`）。
   */
  bindEvents(events: Events): void;
  /** 当前是否染色输出（供调试 / 状态视图使用） */
  readonly colorized: boolean;
}

/**
 * 安装 console sink：先冲洗启动前缓冲的日志，然后订阅后续 LogEntry。
 *
 * 与 CLI/TUI 等"独占终端 UI"的协调通过事件 `terminal:claimed/released` 完成，
 * sink 自己根据事件决定是否写 stdout——UI 不直接干预 sink。
 *
 * `minLevel` 缺省 debug（全量）。`consoleSink: false` 的宿主传 `warn`，让双副本
 * 「必须是单副本」与「装了没反应」仍打到 stderr，info/debug 保持安静。
 */
export function installConsoleSink(
  opts: { target?: 'stdout' | 'stderr'; minLevel?: LogLevel } = {},
): ConsoleSinkHandle {
  const hub = LogHub.default;
  // 缺省走 console.log（stdout）；子命令模式走 console.error（stderr），把 stdout 留给命令结果，
  // 脚本才能消费 `aalis <cmd>` 的输出
  const log = opts.target === 'stderr' ? console.error : console.log;
  const minPriority = LEVEL_PRIORITY[opts.minLevel ?? 'debug'];
  const write = (entry: LogEntry): void => {
    if (LEVEL_PRIORITY[entry.level] < minPriority) return;
    log(formatEntry(entry));
  };

  // 冲洗启动期 bootstrap buffer
  for (const entry of getBootstrapBuffer().snapshot()) write(entry);

  let paused = false;
  const off = hub.onEntry(entry => {
    if (paused) return;
    write(entry);
  });

  let unbind: (() => void) | undefined;

  return {
    dispose() {
      off();
      unbind?.();
    },
    bindEvents(events: Events) {
      // 多终端 owner（理论上不会同时）用计数器避免一个 release 提前解锁
      let owners = 0;
      const onClaim = (): void => {
        owners += 1;
        paused = true;
      };
      const onRelease = (): void => {
        if (owners > 0) owners -= 1;
        if (owners === 0) paused = false;
      };
      const offClaim = events.on('terminal:claimed', onClaim);
      const offRelease = events.on('terminal:released', onRelease);
      unbind = () => {
        offClaim();
        offRelease();
      };
    },
    colorized: COLORIZE,
  };
}
