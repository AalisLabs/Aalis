import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type LogEntry, LogHub } from '@aalis/core';

const DEFAULT_LOG_FILE = 'data/latest.log';
const RUNTIME_SCOPE = 'aalis:runtime';

export interface FileLoggerHandle {
  flush(): Promise<void>;
}

function formatEntry(entry: LogEntry): string {
  const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
  return `${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
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
  const initial = hub.getBuffer().map(formatEntry).join('');
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
