// ============================================================
// logs.ts — 日志的历史与筛选
//
// 历史读「持久化日志」logs:/latest.log（runtime 的 file-logger 写，行格式由 @aalis/schema-log 的 parseLogLine 唯一持有），
// 从文件末尾倒着按块读，latest.log 可能几百 MB，不整个载入。路径（宿主目录布局）归 storage 的 logs 根，本插件只用 URI。
// 筛选（api-webui 的 LogFilter）在这里一处定，历史与 /admin 的实时推送用同一个判定。
// ============================================================

import { readTailLines, type StorageService } from '@aalis/api-storage';
import type { LogFilter } from '@aalis/api-webui';
import type { LogEntry, LogLevel } from '@aalis/core';
import { parseLogLine } from '@aalis/schema-log';

const LOG_FILE_URI = 'logs:/latest.log';
/** 从文件末尾往前最多扫这么多字节：筛得很窄、往前翻得很深时也有界，更早的去看 logs/latest.log 本体 */
const SCAN_BYTES = 16 * 1024 * 1024;

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 读出筛选：三项都只收字符串，级别要是四种之一，空字符串当没给；写法不对回 undefined */
export function parseLogFilter(value: unknown): LogFilter | undefined {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null) return undefined;
  const { level, plugin, text } = value as Record<string, unknown>;
  const fields = { level, plugin, text };
  if (Object.values(fields).some(field => field !== undefined && typeof field !== 'string')) return undefined;
  if (level && !LEVELS.includes(level as LogLevel)) return undefined;
  return Object.fromEntries(Object.entries(fields).filter(([, field]) => field)) as LogFilter;
}

/**
 * 一条日志所属的插件实例：作用域是根作用域、实例 id、插件自己分出的子作用域依次用「:」接起来（core 给每个激活的 logger
 * 是根 logger 的 child）。后缀实例（name:suffix）与主实例的子作用域同形，取 known 认得的最长的那个
 */
function ownerOf(scope: string, known: (instance: string) => boolean): string | undefined {
  const segments = scope.split(':').slice(1);
  for (let n = segments.length; n > 0; n--) {
    const instance = segments.slice(0, n).join(':');
    if (known(instance)) return instance;
  }
  return undefined;
}

/**
 * 按筛选判定日志的函数。registered 是此刻登记着的插件实例：按插件筛时用它分开后缀实例与子作用域；筛的那个实例本身
 * 总认得，卸掉了的插件照样能按名字筛它留下的日志
 */
export function logMatcher(registered: (instance: string) => boolean) {
  return (filter: LogFilter) => {
    const floor = filter.level === undefined ? 0 : LEVELS.indexOf(filter.level);
    const text = filter.text?.toLowerCase();
    const { plugin } = filter;
    const known = (instance: string) => instance === plugin || registered(instance);
    return (entry: LogEntry): boolean =>
      LEVELS.indexOf(entry.level) >= floor &&
      (text === undefined || entry.message.toLowerCase().includes(text)) &&
      (plugin === undefined || ownerOf(entry.scope, known) === plugin);
  };
}

/** 最后 limit 条符合 match 的日志，给了 before 时只看 seq 比它小的（往前翻页；seq 随文件位置单调递增） */
export async function readLogs(
  storage: StorageService,
  match: (entry: LogEntry) => boolean,
  limit: number,
  before?: number,
): Promise<LogEntry[]> {
  const accept = (entry: LogEntry | null): entry is LogEntry =>
    entry !== null && (before === undefined || entry.seq < before) && match(entry);
  const lines = await readTailLines(storage, LOG_FILE_URI, limit, {
    maxBytes: SCAN_BYTES,
    filter: line => accept(parseLogLine(line)),
  });
  // readTailLines 只回过了 filter 的行
  return lines.map(line => parseLogLine(line) as LogEntry);
}
