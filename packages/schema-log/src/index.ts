// 日志行编解码的共享契约：记录类型来自 Core，本包只做纯字符串变换，不执行 I/O。

import type { LogEntry, LogLevel } from '@aalis/core';

export type { LogEntry, LogLevel };

// ----- 单行日志序列化契约（format ↔ parse 对偶） -----
//
// 行格式：`@aalis/log:1 {JSON 日志记录}\n`，字符串中的换行与反斜杠分别编码。
// 纯字符串变换，不感知文件、路径或编码；不持有日志通道与运行状态。
//
// 唯一权威：runtime 写日志，WebUI / CLI 读历史，全部复用这一对函数，
// 避免格式契约在多个插件里各抄一份后悄然漂移。

const VERSION_PREFIX = '@aalis/log:1 ';

/** 把一条 LogEntry 无损序列化为带版本的单行文本（含结尾 LF）。 */
export function formatLogLine(entry: LogEntry): string {
  const { seq, timestamp, level, scope, message } = entry;
  // 只写契约字段；不调用传入对象自带的 toJSON，也不把额外属性带进日志协议。
  const json = JSON.stringify({ seq, timestamp, level, scope, message }).replace(
    /[\u0085\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${VERSION_PREFIX}${json}\n`;
}

/** 读取版本 1 的单行日志；缺少版本前缀、未知版本、损坏 JSON 或非法记录返回 null。 */
export function parseLogLine(line: string): LogEntry | null {
  if (!line.startsWith(VERSION_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(VERSION_PREFIX.length));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const { seq, timestamp, level, scope, message } = value as Record<string, unknown>;
  if (
    typeof seq !== 'number' ||
    !Number.isFinite(seq) ||
    typeof timestamp !== 'string' ||
    (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') ||
    typeof scope !== 'string' ||
    typeof message !== 'string'
  ) {
    return null;
  }
  return { seq, timestamp, level, scope, message };
}
