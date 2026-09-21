// 日志记录与持久化行格式的共享契约；不依赖 Core，不执行 I/O。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** 进程内单调递增的稳定序号（每个 LogHub 实例独立计数）。用作下游 React/UI key 与分页 cursor。 */
  seq: number;
  /** 本地时区 ISO-8601 时间戳（如 `2026-05-27T09:09:16.028+01:00`）。
   *  保留完整日期与偏移，便于人读与机器解析；sink 按需截取显示。 */
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
}

// ----- 单行日志序列化契约（format ↔ parse 对偶） -----
//
// 新行格式：`@aalis/log:1 {JSON 日志记录}\n`，字符串中的换行与反斜杠分别编码。
// 旧 `seq|timestamp|level|scope|message` 行继续可读，但不再写出。
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

/** 读取版本 1 或旧格式的单行日志；未知版本、损坏 JSON 或非法新记录返回 null。 */
export function parseLogLine(line: string): LogEntry | null {
  if (line.startsWith('@aalis/log:')) {
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
  return parseLegacyLogLine(line);
}

/** 保留既有读取语义：旧行无法区分字面反斜杠 n 与原始换行，不尝试逆推。 */
function parseLegacyLogLine(line: string): LogEntry | null {
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
  return {
    seq,
    timestamp: line.slice(i1 + 1, i2),
    level: line.slice(i2 + 1, i3) as LogLevel,
    scope: line.slice(i3 + 1, i4),
    message: line.slice(i4 + 1).replace(/\\n/g, '\n'),
  };
}
