import chalk from 'chalk';

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

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.cyan,
  warn: chalk.yellow,
  error: chalk.red,
};

// 全局日志缓冲区（所有 Logger 实例共享）
const logBuffer: LogEntry[] = [];
const LOG_BUFFER_MAX = 500;
const logListeners: Set<(entry: LogEntry) => void> = new Set();

export function getLogBuffer(): LogEntry[] {
  return logBuffer;
}

export function onLogEntry(listener: (entry: LogEntry) => void): () => void {
  logListeners.add(listener);
  return () => { logListeners.delete(listener); };
}

export class Logger {
  private minLevel: LogLevel;

  constructor(
    private scope: string,
    minLevel: LogLevel = 'info',
  ) {
    this.minLevel = minLevel;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel);
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
    const colorFn = LEVEL_COLORS[level];
    const prefix = `${chalk.gray(timestamp)} ${colorFn(level.toUpperCase().padEnd(5))} ${chalk.magenta(this.scope)}`;

    if (args.length > 0) {
      console.log(`${prefix} ${message}`, ...args);
    } else {
      console.log(`${prefix} ${message}`);
    }

    // 写入缓冲区
    const entry: LogEntry = { timestamp, level, scope: this.scope, message };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    for (const fn of logListeners) fn(entry);
  }
}
