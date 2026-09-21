import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LogHub } from '@aalis/core';
import { formatLogLine } from '@aalis/schema-log';
import { getBootstrapBuffer } from './bootstrap-buffer.js';

/** 默认日志文件路径。webui-server 等下游目前各自硬编码同一相对路径。 */
export const DEFAULT_LOG_FILE = 'data/latest.log';

const RUNTIME_SCOPE = 'aalis:runtime';

export interface FileLoggerHandle {
  flush(): Promise<void>;
  /**
   * 冲洗后退订 LogHub —— 与 ConsoleSinkHandle.dispose 对称。
   * 不退订则同进程二次 setupFileLogger 会叠加订阅，每条日志写多遍。
   */
  dispose(): Promise<void>;
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

export async function appendCrashLog(label: string, err: unknown, logFile = DEFAULT_LOG_FILE): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(
    logFile,
    formatLogLine({
      seq: LogHub.default.allocSeq(),
      timestamp: new Date().toISOString(),
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
  const initial = getBootstrapBuffer().snapshot().map(formatLogLine).join('');
  await writeFile(logFile, initial);

  const off = hub.onEntry(entry => {
    queue = queue.then(() => appendFile(logFile, formatLogLine(entry))).catch(() => {});
  });

  const flush = async (): Promise<void> => {
    await queue.catch(() => {});
  };

  return {
    flush,
    async dispose() {
      await flush();
      off();
    },
  };
}
