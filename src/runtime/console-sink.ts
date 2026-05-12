import { type LogEntry, LogHub, type LogLevel } from '@aalis/core';
import chalk from 'chalk';

/**
 * Console sink —— 运行时层的 stdout 输出（按需染色）。
 *
 * 与 file-logger 对偶：core 仅产生 LogEntry，染色 / 终端假设由入口层注入。
 * 关闭 core 内置 console sink 后，所有 stdout 输出都从这里走，
 * 保证 webui-only / 嵌入式部署无需 chalk。
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

function formatEntry(entry: LogEntry): string {
  const colorFn = LEVEL_COLORS[entry.level];
  const prefix = `${dim(entry.timestamp)} ${colorFn(entry.level.toUpperCase().padEnd(5))} ${accent(entry.scope)}`;
  return `${prefix} ${entry.message}`;
}

export interface ConsoleSinkHandle {
  dispose(): void;
  /** 暂停：日志仍累积进 LogHub buffer，但不再写 stdout。用于 CLI 接管终端时避免污染备用屏 */
  pause(): void;
  /** 恢复 stdout 输出。pause 期间累积的日志**不**回放——它们留在 buffer 里，订阅者（如 CLI 日志视图）自行展示 */
  resume(): void;
  /** 当前是否在写 stdout */
  readonly paused: boolean;
  /** 当前是否染色输出（供调试 / 状态视图使用） */
  readonly colorized: boolean;
}

/**
 * 安装 console sink：先冲洗启动前缓冲的日志，然后订阅后续 LogEntry。
 * 默认在调用前会关闭 core 内置 console sink，避免重复输出。
 *
 * 返回的 handle 支持 pause/resume，供"接管终端"的 UI（CLI 备用屏）在启动时暂停 stdout 写入，
 * 否则插件后续日志会污染备用屏内容。
 */
export function installConsoleSink(): ConsoleSinkHandle {
  const hub = LogHub.default;
  hub.setConsoleSinkEnabled(false);

  // 冲洗启动前缓冲
  for (const entry of hub.getBuffer()) {
    console.log(formatEntry(entry));
  }

  let paused = false;
  const off = hub.onEntry(entry => {
    if (paused) return;
    console.log(formatEntry(entry));
  });

  return {
    dispose: off,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    get paused() {
      return paused;
    },
    colorized: COLORIZE,
  };
}
