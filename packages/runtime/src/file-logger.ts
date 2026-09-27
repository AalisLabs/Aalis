import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { DefaultLogger, LogHub } from '@aalis/core';
import { formatLogLine } from '@aalis/schema-log';
import { getBootstrapBuffer } from './bootstrap-buffer.js';

/** 默认日志文件路径。webui-server 等下游目前各自硬编码同一相对路径。 */
export const DEFAULT_LOG_FILE = 'data/latest.log';

const RUNTIME_SCOPE = 'aalis:runtime';

/** 启动时保留的上几轮日志份数：latest.1.log（上一轮）到 latest.5.log，更早的被挤掉。 */
const LOG_HISTORY_COUNT = 5;

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

/** 第 n 份历史日志的路径，编号插在扩展名前：data/latest.log → data/latest.1.log。 */
function historyPath(logFile: string, n: number): string {
  const ext = extname(logFile);
  return `${logFile.slice(0, logFile.length - ext.length)}.${n}${ext}`;
}

/**
 * 各份日志后移一位：latest.4.log → latest.5.log（原 latest.5.log 被覆盖）……latest.log → latest.1.log。
 * 从旧往新挪，缺号跳过；某一步失败即停并抛出，此时除了本就该挤掉的最旧一份，没有文件被覆盖。
 */
async function rotateLogs(logFile: string): Promise<void> {
  for (let n = LOG_HISTORY_COUNT; n >= 1; n--) {
    try {
      await rename(n === 1 ? logFile : historyPath(logFile, n - 1), historyPath(logFile, n));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * 装文件日志：先把上一轮的日志改名保留（见 rotateLogs），再把启动期日志写入新的 logFile，之后实时追加。
 * 轮转失败不拦启动：照旧覆盖写 logFile，并记一条告警写明原因。不接在原内容后面写：一个文件只装一轮，
 * seq 从 0 起随文件位置单调递增，webui 的历史分页与 CLI 的启动恢复都以此为前提。
 */
export async function setupFileLogger(logFile = DEFAULT_LOG_FILE): Promise<FileLoggerHandle> {
  let queue: Promise<void> = Promise.resolve();

  await mkdir(dirname(logFile), { recursive: true });
  let rotateError: string | undefined;
  try {
    await rotateLogs(logFile);
  } catch (err) {
    rotateError = err instanceof Error ? err.message : String(err);
  }
  const hub = LogHub.default;
  // 启动期 entries 由 bootstrap-buffer 持有；作为文件初始内容写入。
  const initial = getBootstrapBuffer().snapshot().map(formatLogLine).join('');
  await writeFile(logFile, initial);

  const off = hub.onEntry(entry => {
    queue = queue.then(() => appendFile(logFile, formatLogLine(entry))).catch(() => {});
  });
  // 订阅之后再记：告警经 LogHub 同时进控制台与本文件。
  if (rotateError !== undefined) {
    new DefaultLogger(RUNTIME_SCOPE).warn(`上一轮的日志没能改名保留（${rotateError}），本轮已覆盖写入 ${logFile}`);
  }

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
