import { describe, expect, it } from 'vitest';
import {
  dateFieldsInTimeZone,
  matchesCron,
  normalizeCronExpr,
  parseCronField,
  validateCronExpr,
} from '../../packages/plugin-cron-engine-api/src/index.js';

describe('cron-engine-api: 表达式解析', () => {
  it('normalizeCronExpr: 别名展开 & 非法返回 null', () => {
    expect(normalizeCronExpr('@daily')).toBe('0 0 * * *');
    expect(normalizeCronExpr('@hourly')).toBe('0 * * * *');
    expect(normalizeCronExpr('0 9 * * *')).toBe('0 9 * * *');
    expect(normalizeCronExpr('not-a-cron')).toBeNull();
  });

  it('parseCronField: *, */N, A-B, A,B,C 都能解析', () => {
    expect([...parseCronField('*', 0, 3)]).toEqual([0, 1, 2, 3]);
    expect([...parseCronField('*/2', 0, 6)]).toEqual([0, 2, 4, 6]);
    expect([...parseCronField('1-3', 0, 5)]).toEqual([1, 2, 3]);
    expect([...parseCronField('0,3,5', 0, 5).values()].sort()).toEqual([0, 3, 5]);
  });

  it('parseCronField: 越界值被夹到 [min,max]，非法范围/越界单值被跳过（不再静默塞入非法值）', () => {
    // 分钟字段 0-59：旧实现 "1-100" 会塞入 60-99 这些非法分钟，现夹到 1-59
    expect(Math.max(...parseCronField('1-100', 0, 59))).toBe(59);
    expect([...parseCronField('1-100', 0, 59)].every(n => n >= 1 && n <= 59)).toBe(true);
    // 非法范围 "5-" → [5,NaN] → 跳过（不产生 NaN/全集）
    expect([...parseCronField('5-', 0, 59)]).toEqual([]);
    expect([...parseCronField('abc-def', 0, 59)]).toEqual([]);
    // 越界单值被丢弃（分钟 99 非法）
    expect([...parseCronField('99', 0, 59)]).toEqual([]);
    expect([...parseCronField('5,99,30', 0, 59).values()].sort((a, b) => a - b)).toEqual([5, 30]);
  });

  it('parseCronField: 范围+步进 1-30/5、起点+步进 0/15（修复前静默成空集→死任务）', () => {
    expect([...parseCronField('1-30/5', 0, 59)]).toEqual([1, 6, 11, 16, 21, 26]);
    expect([...parseCronField('0/15', 0, 59)]).toEqual([0, 15, 30, 45]);
    expect([...parseCronField('*/15', 0, 59)]).toEqual([0, 15, 30, 45]);
    expect([...parseCronField('1-30/0', 0, 59)]).toEqual([]); // 非法步进 → 跳过
    expect([...parseCronField('1-30/abc', 0, 59)]).toEqual([]);
  });

  it('validateCronExpr: 5 字段 / @every / 错误三态', () => {
    expect(validateCronExpr('0 9 * * *').ok).toBe(true);
    const ev = validateCronExpr('@every 30s');
    expect(ev.ok).toBe(true);
    if (ev.ok) expect(ev.intervalSeconds).toBe(30);
    expect(validateCronExpr('').ok).toBe(false);
    expect(validateCronExpr('garbage').ok).toBe(false);
    // 逐字段校验：解析为空的字段被拒（旧实现只数字段个数会放行 99 这类非法值）
    expect(validateCronExpr('99 * * * *').ok).toBe(false);
    expect(validateCronExpr('1-30/5 9 * * *').ok).toBe(true);
  });
});

describe('cron-engine-api: 时区感知 matchesCron', () => {
  // 选定一个无 DST 的稳定瞬间：2025-06-15 08:00:00 UTC
  // - 此时 Asia/Shanghai 是 16:00（+08:00 永远）
  // - 此时 Europe/London 是 09:00（BST = UTC+1）
  const utc8am = new Date('2025-06-15T08:00:00Z');

  it('dateFieldsInTimeZone: 同一瞬间在不同 tz 给出不同 hour', () => {
    const sh = dateFieldsInTimeZone(utc8am, 'Asia/Shanghai');
    expect(sh.hour).toBe(16);
    expect(sh.minute).toBe(0);
    const ldn = dateFieldsInTimeZone(utc8am, 'Europe/London');
    expect(ldn.hour).toBe(9);
    expect(ldn.minute).toBe(0);
  });

  it('matchesCron("0 9 * * *", utc8am, "Europe/London") = true', () => {
    expect(matchesCron('0 9 * * *', utc8am, 'Europe/London')).toBe(true);
    expect(matchesCron('0 16 * * *', utc8am, 'Asia/Shanghai')).toBe(true);
    expect(matchesCron('0 8 * * *', utc8am, 'UTC')).toBe(true);
  });

  it('matchesCron 不同 tz 不会假阳性', () => {
    // 上海时间 16:00 时，伦敦不是 09:00 是 09:00 — 是的会假阳性？不会，因为我们刚验证就是 9 点
    // 用一个能造成跨时区差异的：UTC 23:30 = 上海次日 07:30
    const lateUtc = new Date('2025-06-15T23:30:00Z');
    expect(matchesCron('30 23 15 * *', lateUtc, 'UTC')).toBe(true);
    // 在上海这是 16 日 07:30，所以 23 点 cron 不应命中
    expect(matchesCron('30 23 15 * *', lateUtc, 'Asia/Shanghai')).toBe(false);
    expect(matchesCron('30 7 16 * *', lateUtc, 'Asia/Shanghai')).toBe(true);
  });

  it('未传 tz 时退化为进程本地时间（保持向后兼容）', () => {
    const now = new Date();
    // 用进程当前的小时构造一个一定命中的表达式
    const expr = `${now.getMinutes()} ${now.getHours()} ${now.getDate()} ${now.getMonth() + 1} *`;
    expect(matchesCron(expr, now)).toBe(true);
  });
});
