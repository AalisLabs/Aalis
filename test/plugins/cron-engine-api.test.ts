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

  it('validateCronExpr: 5 字段 / @every / 错误三态', () => {
    expect(validateCronExpr('0 9 * * *').ok).toBe(true);
    const ev = validateCronExpr('@every 30s');
    expect(ev.ok).toBe(true);
    if (ev.ok) expect(ev.intervalSeconds).toBe(30);
    expect(validateCronExpr('').ok).toBe(false);
    expect(validateCronExpr('garbage').ok).toBe(false);
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
