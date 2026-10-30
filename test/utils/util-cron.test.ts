import { describe, expect, it } from 'vitest';
import { resolveText } from '../../packages/schema-i18n/src/index.js';
import {
  dateFieldsInTimeZone,
  MAX_INTERVAL_SECONDS,
  matchesCron,
  normalizeCronExpr,
  parseCronField,
  validateCronExpr,
  validateIntervalSeconds,
} from '../../packages/util-cron/src/index.js';

describe('util-cron: 表达式解析', () => {
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

  it('validateCronExpr 拒绝时给本包字典里的文字对象：显示方按读者语言渲染', () => {
    const rejected = (input: string) => {
      const result = validateCronExpr(input);
      if (result.ok || typeof result.text === 'string') throw new Error(`${input} 应被拒，原因是文字对象`);
      return { en: resolveText(result.text, ['en']), source: result.text.source };
    };
    expect(rejected(' ')).toEqual({ en: 'The expression is empty', source: '表达式为空' });
    expect(rejected('@every soon')).toEqual({
      en: 'Unrecognized @every expression: @every soon',
      source: '无法识别的 @every 表达式：@every soon',
    });
    expect(rejected('garbage')).toEqual({
      en: 'Invalid cron expression (needs 5 fields or an alias): garbage',
      source: '非法 cron 表达式（需 5 字段或别名）：garbage',
    });
    expect(rejected('0 99 * * *')).toEqual({
      en: 'Cron field 2 is invalid (parses to nothing): "99"',
      source: 'cron 第 2 字段非法（解析为空）："99"',
    });
  });
});

// 间隔交给 setInterval：延时超过 2^31-1 毫秒（约 24.8 天）时按 1 毫秒处理，「每 30 天」变成每毫秒触发一次
describe('util-cron: 间隔的上限', () => {
  it('上限是定时器能排的最长延时折成的整秒数', () => {
    expect(MAX_INTERVAL_SECONDS).toBe(2147483);
    expect(MAX_INTERVAL_SECONDS * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('@every 超过上限不通过，原因是本包字典里的文字对象；上限本身照收', () => {
    const tooLong = validateCronExpr('@every 720h');
    if (tooLong.ok || typeof tooLong.text === 'string') throw new Error('@every 720h 应被拒，原因是文字对象');
    expect(tooLong.text.source).toBe('间隔须大于 0 且不超过 2,147,483 秒（约 24.8 天）：@every 720h');
    expect(resolveText(tooLong.text, ['en'])).toBe(
      'The interval must be greater than 0 and at most 2,147,483 seconds (about 24.8 days): @every 720h',
    );
    expect(validateCronExpr('@every 2147484s').ok).toBe(false);
    expect(validateCronExpr('@every 2147483s')).toEqual({
      ok: true,
      kind: 'interval',
      normalized: '@every 2147483s',
      intervalSeconds: 2147483,
    });
  });

  it('间隔秒数：大于 0、不超过上限的数通过，其余给原因', () => {
    for (const ok of [0.5, 1, 60, 2147483]) expect(validateIntervalSeconds(ok), String(ok)).toBeNull();
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2147483.5, 2592000, 'abc', undefined]) {
      expect(validateIntervalSeconds(bad), String(bad)).not.toBeNull();
    }
    expect(validateIntervalSeconds(2592000)?.source).toBe('间隔须大于 0 且不超过 2,147,483 秒（约 24.8 天）：2592000');
    expect(validateIntervalSeconds('abc')?.source).toBe('间隔须大于 0 且不超过 2,147,483 秒（约 24.8 天）：abc');
  });
});

describe('util-cron: 时区感知 matchesCron', () => {
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

describe('util-cron: 星期字段 0-7（0 与 7 均为周日）', () => {
  const sundayUtc = new Date('2025-06-15T08:00:00Z'); // 周日
  const mondayUtc = new Date('2025-06-16T08:00:00Z'); // 周一

  it('前置确认：2025-06-15 UTC=周日(0)、06-16=周一(1)', () => {
    expect(dateFieldsInTimeZone(sundayUtc, 'UTC').weekday).toBe(0);
    expect(dateFieldsInTimeZone(mondayUtc, 'UTC').weekday).toBe(1);
  });

  it('validateCronExpr 接受星期 7（周日），仍拒绝越界的 8', () => {
    expect(validateCronExpr('0 8 * * 7').ok).toBe(true);
    expect(validateCronExpr('0 8 * * 0').ok).toBe(true);
    expect(validateCronExpr('0 8 * * 8').ok).toBe(false);
  });

  it('matchesCron: "* * * * 7" 命中周日、不命中周一（与 0 等价）', () => {
    expect(matchesCron('0 8 * * 7', sundayUtc, 'UTC')).toBe(true);
    expect(matchesCron('0 8 * * 0', sundayUtc, 'UTC')).toBe(true);
    expect(matchesCron('0 8 * * 7', mondayUtc, 'UTC')).toBe(false);
  });
});

describe('util-cron: 别名表不受 Object.prototype 成员干扰', () => {
  const protoKeys = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'];

  it('normalizeCronExpr 对原型成员名返回 null（不返回函数/对象，守住 string|null 契约）', () => {
    for (const key of protoKeys) {
      expect(normalizeCronExpr(key)).toBeNull();
    }
  });

  it('validateCronExpr / matchesCron 不抛 TypeError（否则 scheduler 的 initJob 整个 apply 抛出）', () => {
    for (const key of protoKeys) {
      expect(() => validateCronExpr(key)).not.toThrow();
      expect(validateCronExpr(key).ok).toBe(false);
      expect(() => matchesCron(key, new Date())).not.toThrow();
      expect(matchesCron(key, new Date())).toBe(false);
    }
  });

  it('真别名仍照常展开', () => {
    expect(normalizeCronExpr('@weekly')).toBe('0 0 * * 0');
    expect(validateCronExpr('@annually')).toEqual({ ok: true, kind: 'cron', normalized: '0 0 1 1 *' });
  });
});
