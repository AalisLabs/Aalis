import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type LogEntry, LogHub, type LogLevel } from '@aalis/core';
import { getBootstrapBuffer } from './bootstrap-buffer.js';

/** 默认日志文件路径。webui-server 等下游目前各自硬编码同一相对路径。 */
const DEFAULT_LOG_FILE = 'data/latest.log';

const RUNTIME_SCOPE = 'aalis:runtime';

export interface FileLoggerHandle {
  flush(): Promise<void>;
}

/**
 * 单行日志文件格式：`seq|timestamp|level|scope|message\n`
 * - 每次启动 `writeFile` 覆盖（不保留跨进程历史）
 * - message 内部 `\n` 被转义为字面 `\\n`，保证一行一条
 * - seq 是进程内单调递增整数，下游分页 cursor 直接用它
 */
function formatEntry(entry: LogEntry): string {
  const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
  return `${entry.seq}|${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
}

/** 反向解析一行；格式错乱时返回 null。供 webui-server / cli 读取历史时复用。 */
export function parseEntry(line: string): LogEntry | null {
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
  const level = line.slice(i2 + 1, i3) as LogLevel;
  return {
    seq,
    timestamp: line.slice(i1 + 1, i2),
    level,
    scope: line.slice(i3 + 1, i4),
    message: line.slice(i4 + 1).replace(/\\n/g, '\n'),
  };
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

export async function appendCrashLog(label: string, err: unknown, logFile = DEFAULT_LOG_FILE): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(
    logFile,
    formatEntry({
      seq: LogHub.default.allocSeq(),
      timestamp: new Date().toISOString().slice(11, 23),
      level: 'error',
      scope: RUNTIME_SCOPE,
      message: `${label}: ${formatUnknownError(err)}`,
    }),
  );
}

export async function setupFileLogger(logFile = DEFAULT_LOG_FILE): Promise<FileLoggerHandle> {
  let queue: Promise<void> = Promise.resolve();

  await mkdir(dirname(logFile), { recursive: true });
  const hub = LogHub.default;
  // 启动期 entries 由 bootstrap-buffer 持有；作为文件初始内容写入。
  const initial = getBootstrapBuffer().snapshot().map(formatEntry).join('');
  await writeFile(logFile, initial);

  hub.onEntry(entry => {
    queue = queue.then(() => appendFile(logFile, formatEntry(entry))).catch(() => {});
  });

  return {
    async flush() {
      await queue.catch(() => {});
    },
  };
}
