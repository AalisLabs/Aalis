import { getLogBuffer, onLogEntry, type LogEntry } from '@aalis/core';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_LOG_FILE = 'data/latest.log';

export interface FileLoggerHandle {
  flush(): Promise<void>;
}

function formatEntry(entry: LogEntry): string {
  const safeMsg = entry.message.replace(/\r?\n/g, '\\n');
  return `${entry.timestamp}|${entry.level}|${entry.scope}|${safeMsg}\n`;
}

export async function setupFileLogger(logFile = DEFAULT_LOG_FILE): Promise<FileLoggerHandle> {
  let queue: Promise<void> = Promise.resolve();

  await mkdir(dirname(logFile), { recursive: true });
  const initial = getLogBuffer().map(formatEntry).join('');
  await writeFile(logFile, initial);

  onLogEntry((entry) => {
    queue = queue.then(() => appendFile(logFile, formatEntry(entry))).catch(() => {});
  });

  return {
    async flush() {
      await queue.catch(() => {});
    },
  };
}
