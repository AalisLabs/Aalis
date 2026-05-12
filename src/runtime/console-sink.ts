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
  /** 当前是否染色输出（供调试 / 状态视图使用） */
  readonly colorized: boolean;
}

/**
 * 安装 console sink：注入彩色格式化器到 LogHub，并冲洗启动前缓冲。
 *
 * 通过 `setConsoleFormatter` 注入而非 `onEntry` 监听，让 LogHub 内置的
 * `setConsoleSinkEnabled(false)` 成为 console 输出的唯一 gate——CLI 进入
 * alt-screen 时一行代码能彻底静默 console，不会有"残留监听器"继续刷屏。
 */
export function installConsoleSink(): ConsoleSinkHandle {
  const hub = LogHub.default;
  // 注入彩色格式化器（取代默认 raw 格式），保持 consoleSink=true 让 push() 走 console.log
  hub.setConsoleFormatter(formatEntry);

  // 冲洗启动前缓冲（缓冲里的条目在 setConsoleFormatter 之前已经 push 过，未输出过 console）
  for (const entry of hub.getBuffer()) {
    console.log(formatEntry(entry));
  }

  return {
    dispose: () => hub.setConsoleFormatter(null),
    colorized: COLORIZE,
  };
}
