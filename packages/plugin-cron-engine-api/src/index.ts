// ===== Cron 引擎服务契约 =====
//
// scheduler / workflow 等插件共享的 cron 解析与订阅协议。
// 实现见 @aalis/plugin-cron-engine。

import type { Context } from '@aalis/core';

// ─── 公开的纯函数（无状态、可独立调用） ───

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
 * 解析 cron 字段（如 `*`、`*\/5`、`1-5`、`1,3,5`），返回命中数字集合。
 */
export function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (step > 0) for (let i = min; i <= max; i += step) result.add(i);
    } else if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      for (let i = a; i <= b; i++) result.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n)) result.add(n);
    }
  }
  return result;
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
    parseCronField(weekday, 0, 6).has(f.weekday)
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
  if (normalized.split(/\s+/).length !== 5) return { ok: false, reason: `cron 必须为 5 字段: ${normalized}` };
  return { ok: true, kind: 'cron', normalized };
}

// ─── 服务接口 ───

/** 订阅 / nextFireTime 的可选参数。 */
export interface CronSubscribeOptions {
  /**
   * IANA 时区名（如 `Asia/Shanghai`、`Europe/London`）。
   * 空串或未传时使用进程本地时区，与历史行为兼容。
   * 只对 5 字段 cron 生效；`@every` interval 与时区无关。
   */
  timeZone?: string;
}

export interface CronEngine {
  /**
   * 订阅一个 cron / @every 表达式。返回 dispose 函数。
   * 失败时抛 Error（建议先用 validateCronExpr 校验）。
   *
   * - 5 字段 cron 或别名：挂接到引擎共享的整分钟 tick
   * - `@every Ns/Nm/Nh`：单独 setInterval
   * - `options.timeZone` 用于在指定时区评估 cron（默认进程本地）
   */
  subscribe(expr: string, handler: () => void | Promise<void>, options?: CronSubscribeOptions): () => void;

  /** 表达式校验。 */
  validate(expr: string): ValidateResult;

  /**
   * 从给定时间起向前找下一次触发时间戳（ms）。
   * - cron：在 `lookaheadMinutes`（默认 366*24*60）内未命中返回 null
   * - interval：返回 `from + intervalSeconds*1000`
   * - `options.timeZone` 与 subscribe 语义相同
   */
  nextFireTime(expr: string, from?: Date, lookaheadMinutes?: number, options?: CronSubscribeOptions): number | null;
}

// ----- 服务类型注册 -----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'cron-engine': CronEngine;
  }
}

export function useCronEngine(ctx: Context): CronEngine {
  const svc = ctx.getService<CronEngine>('cron-engine');
  if (!svc) throw new Error('cron-engine 服务未就绪，请在 inject.required 中声明 "cron-engine"');
  return svc;
}
