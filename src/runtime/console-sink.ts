import { getLogBuffer, type LogEntry, type LogLevel, onLogEntry, setConsoleLogSinkEnabled } from '@aalis/core';
import chalk from 'chalk';

/**
 * Console sink —— 运行时层的 stdout 染色输出。
 *
 * 与 file-logger 对偶：core 仅产生 LogEntry，染色 / 终端假设由入口层注入。
 * 关闭 core 内置的 console sink 后，所有 stdout 输出都从这里走，
 * 保证 webui-only / 嵌入式部署无需 chalk。
 */
const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

function formatEntry(entry: LogEntry): string {
  const colorFn = LEVEL_COLORS[entry.level];
  const prefix = `${chalk.gray(entry.timestamp)} ${colorFn(entry.level.toUpperCase().padEnd(5))} ${chalk.magenta(entry.scope)}`;
  return `${prefix} ${entry.message}`;
}

export interface ConsoleSinkHandle {
  dispose(): void;
}

/**
 * 安装 console sink：先冲洗启动前缓冲的日志，然后订阅后续 LogEntry。
 * 默认在调用前会关闭 core 内置 console sink，避免重复输出。
 */
export function installConsoleSink(): ConsoleSinkHandle {
  setConsoleLogSinkEnabled(false);

  // 冲洗启动前缓冲
  for (const entry of getLogBuffer()) {
    console.log(formatEntry(entry));
  }

  const dispose = onLogEntry(entry => {
    console.log(formatEntry(entry));
  });

  return { dispose };
}
