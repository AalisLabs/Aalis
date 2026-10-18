// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clockTime,
  compactNumber,
  duration,
  fullTime,
  listText,
  listTime,
  logTime,
  numberText,
} from '../../packages/plugin-webui-client/src/format.js';
import { setLanguage, tr } from '../../packages/plugin-webui-client/src/language.js';
import { t as shell } from '../../packages/plugin-webui-client/src/texts.js';
import { fingerprint, indexPacks } from '../../packages/schema-i18n/src/index.js';
import { expectProcessTimeZoneDistinct } from '../fixtures/process-time-zone.js';

// 数字、列表、时长与时间按外壳实际用的语言（全局默认层的语言链选中的字典的语言，与句子里的同类参数一致；i18n 不在时按原文的
// 语言）写，时间按服务进程的时区，不按浏览器的（冒充服务进程时区的是东京）

const TOKYO = 'Asia/Tokyo';

/** 界面的语言：这条语言链，服务进程在东京 */
const use = (chain: string[]) => setLanguage({ chain, timeZone: TOKYO, packs: new Map() });

/** 东京的某个时刻（月份从 0 起） */
const tokyo = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  Date.UTC(year, month, day, hour - 9, minute);

afterEach(() => {
  vi.useRealTimers();
  setLanguage({ chain: [], timeZone: 'UTC', packs: new Map() });
});

describe('时间', () => {
  it('列表里的时间：按服务进程的时区分今天、今年与更早，今天写时分，今年写月日，更早写年月日；时间线里别的日子另写时分', () => {
    expectProcessTimeZoneDistinct(tokyo(9, 3, 0, 0));
    vi.useFakeTimers();
    vi.setSystemTime(tokyo(9, 3, 15, 0));
    use(['zh-CN']);
    expect(listTime(tokyo(9, 3, 9, 5))).toBe('09:05');
    expect(listTime(tokyo(9, 3, 0, 0))).toBe('00:00');
    expect(listTime(tokyo(9, 2, 23, 59))).toBe('10/2');
    expect(listTime(tokyo(0, 1, 8, 0))).toBe('1/1');
    expect(listTime(tokyo(11, 31, 23, 0, 2025))).toBe('2025/12/31');
    expect(clockTime(tokyo(9, 2, 23, 59))).toBe('10/2 23:59');
    use(['en']);
    expect(listTime(tokyo(11, 31, 23, 0, 2025))).toBe('12/31/2025');
    expect(clockTime(tokyo(9, 2, 23, 59))).toBe('10/2, 23:59');
  });

  it('悬停的完整时间与日志里的时刻到秒，与列表里的时间同是 24 小时制', () => {
    const at = tokyo(9, 17, 9, 5) + 3_000;
    use(['zh-CN']);
    expect([fullTime(at), logTime(at)]).toEqual(['2026/10/17 09:05:03', '09:05:03']);
    use(['en']);
    expect([fullTime(at), logTime(at)]).toEqual(['10/17/2026, 09:05:03', '09:05:03']);
  });

  it('认不出的时刻（Date.parse 给的 NaN 一类）写成空串，不抛', () => {
    use(['zh-CN']);
    expect([
      listTime(Number.NaN),
      clockTime(Number.NaN),
      fullTime(Number.POSITIVE_INFINITY),
      logTime(Number.NaN),
    ]).toEqual(['', '', '', '']);
  });
});

describe('格式与文字同一种语言', () => {
  it('语言链的第一项没有字典时，数字、列表与日期按外壳实际用的语言写，与句子里的同类参数一致', () => {
    vi.useFakeTimers();
    vi.setSystemTime(tokyo(9, 3, 15, 0));
    const formatted = () => [listText(['a', 'b', 'c']), numberText(1234.5, 1), listTime(tokyo(11, 31, 23, 0, 2025))];
    use(['de-DE', 'en']);
    expect(formatted()).toEqual(['a, b, c', '1,234.5', '12/31/2025']);
    expect([tr('rootCycle', { instances: ['a', 'b', 'c'] }), tr('tableSelected', { count: 1234.5 })]).toEqual([
      'Waiting on each other in a cycle: a, b, c',
      '1,234.5 selected',
    ]);
    use(['ja', 'zh-CN', 'en']);
    expect(formatted()).toEqual(['a、b、c', '1,234.5', '2025/12/31']);
    expect(tr('rootCycle', { instances: ['a', 'b', 'c'] })).toBe('互相等待成环：a、b、c');
  });
});

describe('数字、列表与时长', () => {
  it('按语言链写；i18n 不在时按原文的语言', () => {
    use(['en']);
    expect([numberText(1234.5, 2), listText(['a', 'b', 'c']), duration(3_240), duration(65_400)]).toEqual([
      '1,234.50',
      'a, b, c',
      '3.2 s',
      '1 min 5 s',
    ]);
    use([]);
    expect([listText(['a', 'b', 'c']), duration(3_240), duration(65_400)]).toEqual(['a、b、c', '3.2 秒', '1 分 5 秒']);
  });

  it('罗列与字典里的 {x, list} 同一个分隔符：语言包给了外壳与分隔符的日文时，两处都按包里的写', () => {
    const packs = indexPacks([
      {
        id: 'zz-ja',
        language: 'ja',
        entries: {
          [shell.ns]: {
            pageLanguage: { text: 'ja', from: fingerprint(shell.source.pageLanguage) },
            rootCycle: { text: '循環待ち：{instances, list}', from: fingerprint(shell.source.rootCycle) },
          },
          '@aalis/schema-i18n': { listSeparator: { text: '・', from: fingerprint('、') } },
        },
      },
    ]);
    setLanguage({ chain: ['ja'], timeZone: TOKYO, packs });
    expect(listText(['a', 'b', 'c'])).toBe('a・b・c');
    expect(tr('rootCycle', { instances: ['a', 'b', 'c'] })).toBe('循環待ち：a・b・c');
  });
});

describe('数量缩写', () => {
  it('千以下原样，千以上写 k、百万以上写 M，一位小数、末尾的 .0 去掉，舍入到 1000k 的进成 1M；不分语言', () => {
    const counts = [999, 1000, 1234, 128_000, 999_949, 999_950, 999_999, 1_000_000, 1_200_000];
    const written = ['999', '1k', '1.2k', '128k', '999.9k', '1M', '1M', '1M', '1.2M'];
    for (const chain of [['zh-CN'], ['en']]) {
      use(chain);
      expect(counts.map(compactNumber)).toEqual(written);
    }
  });
});
