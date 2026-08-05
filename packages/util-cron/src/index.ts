// ===== Cron 表达式解析与匹配（零依赖纯函数） =====
//
// POSIX 5 字段 cron + `@hourly`/`@daily`/... 别名 + `@every Ns` 间隔语法。
// 与 Aalis 的任何概念无关——不 import core、不碰 node:，可在任何 JS 运行时调用。
//
// 订阅协议（CronEngine 服务契约）在 @aalis/api-cron-engine，
// 实现在 @aalis/plugin-cron-engine。

/**
 * 把 cron 表达式标准化：
 * - 5 字段 cron 原样返回
 * - 别名 `@hourly` / `@daily` / `@midnight` / `@weekly` / `@monthly` / `@yearly` / `@annually` 展开
 * - `@every Ns/Nm/Nh` 不在此处理（属于 interval 范畴），原样返回
 * - 其他无法识别返回 null
 */
export function normalizeCronExpr(input: string): string | null {
  const s = input.trim();
  if (s.startsWith('@every')) return s;
  const aliases: Record<string, string> = {
    '@hourly': '0 * * * *',
    '@daily': '0 0 * * *',
    '@midnight': '0 0 * * *',
    '@weekly': '0 0 * * 0',
    '@monthly': '0 0 1 * *',
    '@yearly': '0 0 1 1 *',
    '@annually': '0 0 1 1 *',
  };
  if (aliases[s]) return aliases[s];
  // 5 字段格式检查
  if (s.split(/\s+/).length === 5) return s;
  return null;
}

/**
 * 解析 cron 字段，返回命中数字集合。支持：`*`、`*\/5`、`1-5`、`1,3,5`、
 * 以及范围+步进 `1-30/5` 与 起点+步进 `0/15`（从起点步进到 max）。
 * 非法字段（如 `abc`、`5-`、超界单值）解析为空集，由 validateCronExpr 在创建期拒绝。
 */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    // 先拆步进：a-b/step、lo/step、*/step、a-b、lo、* 统一在此处理
    const [rangePart, stepPart] = trimmed.split('/');
    const step = stepPart !== undefined ? parseInt(stepPart, 10) : 1;
    if (Number.isNaN(step) || step <= 0) continue; // 非法/缺失步进值 → 跳过该 part
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (Number.isNaN(a) || Number.isNaN(b)) continue; // "5-"、"abc-def" 等
      lo = a;
      hi = b;
    } else {
      const n = parseInt(rangePart, 10);
      if (Number.isNaN(n)) continue;
      lo = n;
      hi = stepPart !== undefined ? max : n; // `lo/step` → lo..max 步进；裸单值 → 仅该值
    }
    // 夹到 [min,max]，避免越界（如分钟字段 "1-100" 不塞入 60-99 这些非法分钟）
    for (let i = Math.max(min, lo); i <= Math.min(max, hi); i += step) result.add(i);
  }
  return result;
}

/**
 * 星期字段：cron 惯例允许 0-7，其中 0 与 7 均表示周日。以 [0,7] 解析后把 7 归一到 0，
 * 以匹配 Date/Intl 的 0-6（周日=0）语义 —— 否则 `* * * * 7` 会校验通过却永不触发。
 */
function parseWeekdayField(field: string): Set<number> {
  const set = parseCronField(field, 0, 7);
  if (set.has(7)) {
    set.delete(7);
    set.add(0);
  }
  return set;
}

/**
 * 拆分 Date 为 cron 字段需要的本地化数字。
 * - 未传 `timeZone`（或传空串）：使用进程本地时区（与 `Date.prototype.getXxx` 等价）
 * - 传 IANA tz（如 `Asia/Shanghai` / `Europe/London`）：用 Intl.DateTimeFormat 把同一瞬时换算到该时区
 *
 * 内部不缓存，单次构造 formatter 成本可忽略（cron 1 次/分钟）。
 */
export function dateFieldsInTimeZone(
  date: Date,
  timeZone?: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  if (!timeZone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay(),
    };
  }
  // weekday 用单独 formatter（'short' 才能稳定 ASCII 输出）；其它字段一次 formatToParts 全取
  const partsFmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const wdFmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const parts: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Intl 在 hour12=false 时午夜可能返回 "24" —— 换回 0 以匹配 cron 0-23 语义
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: parseInt(parts.minute, 10),
    hour,
    day: parseInt(parts.day, 10),
    month: parseInt(parts.month, 10),
    weekday: weekdayMap[wdFmt.format(date)] ?? date.getUTCDay(),
  };
}

/**
 * 判断给定时间是否匹配 cron 表达式（5 字段或别名）。
 * 不处理 @every（应由订阅层用 setInterval）。
 *
 * @param timeZone 可选 IANA 时区名（如 `Asia/Shanghai`）。空串/未传 = 进程本地时区。
 */
export function matchesCron(expr: string, date: Date, timeZone?: string): boolean {
  const normalized = normalizeCronExpr(expr);
  if (!normalized || normalized.startsWith('@every')) return false;
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  const f = dateFieldsInTimeZone(date, timeZone);
  return (
    parseCronField(minute, 0, 59).has(f.minute) &&
    parseCronField(hour, 0, 23).has(f.hour) &&
    parseCronField(day, 1, 31).has(f.day) &&
    parseCronField(month, 1, 12).has(f.month) &&
    parseWeekdayField(weekday).has(f.weekday)
  );
}

/**
 * 解析 `@every 30s` / `@every 5m` / `@every 2h` 为秒数；不识别返回 0。
 */
export function parseEverySeconds(input: string): number {
  const m = input
    .trim()
    .toLowerCase()
    .match(/^@every\s+(\d+)\s*(s|m|h)?$/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const unit = m[2] ?? 's';
  if (unit === 'h') return n * 3600;
  if (unit === 'm') return n * 60;
  return n;
}

// ─── 表达式类型 ───

export type CronExprKind = 'cron' | 'interval';

export type ValidateResult =
  | { ok: true; kind: CronExprKind; normalized: string; intervalSeconds?: number }
  | { ok: false; reason: string };

/**
 * 校验表达式：cron（5 字段或别名）或 interval（`@every Ns/Nm/Nh`）。
 */
export function validateCronExpr(input: string): ValidateResult {
  const s = input.trim();
  if (!s) return { ok: false, reason: '表达式为空' };
  if (s.startsWith('@every')) {
    const sec = parseEverySeconds(s);
    if (sec <= 0) return { ok: false, reason: `无法识别的 @every 表达式: ${s}` };
    return { ok: true, kind: 'interval', normalized: s, intervalSeconds: sec };
  }
  const normalized = normalizeCronExpr(s);
  if (!normalized) return { ok: false, reason: `非法 cron 表达式（需 5 字段或别名）: ${s}` };
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return { ok: false, reason: `cron 必须为 5 字段: ${normalized}` };
  // 逐字段校验：任一字段解析为空集（如 `abc`、`5-`、超界单值）即拒绝，避免静默生成永不触发的死任务。
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7], // 星期：0-7，0 与 7 均为周日（cron 惯例）
  ];
  for (let i = 0; i < 5; i++) {
    if (parseCronField(fields[i], ranges[i][0], ranges[i][1]).size === 0) {
      return { ok: false, reason: `cron 第 ${i + 1} 字段非法（解析为空）: "${fields[i]}"` };
    }
  }
  return { ok: true, kind: 'cron', normalized };
}
