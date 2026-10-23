import { listSeparator } from '@aalis/schema-i18n';
import { type Language, language, pageLanguage, tr } from './language';

// 数字、时间、时长、列表、排序与不分大小写的比较一律按外壳实际用的语言（language.ts 的 pageLanguage，与句子里的同类参数一致），
// 时间按服务进程的时区；Intl 的格式器随语言缓存，换了语言重建

let cachedFor: Language | undefined;
let cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  if (cachedFor !== language()) {
    cachedFor = language();
    cache = new Map();
  }
  let value = cache.get(key) as T | undefined;
  if (value === undefined) {
    value = make();
    cache.set(key, value);
  }
  return value;
}

/** 时刻按 options 写；不是有限数（上游给的时间串认不出时 Date.parse 给 NaN）写成空串 */
const date = (options: Intl.DateTimeFormatOptions, at: number) =>
  Number.isFinite(at)
    ? cached(`date ${JSON.stringify(options)}`, () => {
        try {
          return new Intl.DateTimeFormat(pageLanguage(), { ...options, timeZone: language().timeZone });
        } catch {
          // 浏览器的时区库比服务端的旧、不认得这个时区：按 UTC
          return new Intl.DateTimeFormat(pageLanguage(), { ...options, timeZone: 'UTC' });
        }
      }).format(at)
    : '';

const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
const SECONDS: Intl.DateTimeFormatOptions = { ...TIME, second: '2-digit' };
const DAY: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' };
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric' };
const YEAR: Intl.DateTimeFormatOptions = { year: 'numeric' };

/** 在服务进程的时区里是今天、今年，还是更早 */
function age(at: number): 'today' | 'year' | 'older' {
  const now = Date.now();
  if (date(DAY, at) === date(DAY, now)) return 'today';
  return date(YEAR, at) === date(YEAR, now) ? 'year' : 'older';
}

const LIST_TIME = { today: TIME, year: MONTH_DAY, older: DAY };
const CLOCK_TIME = { today: TIME, year: { ...MONTH_DAY, ...TIME }, older: { ...DAY, ...TIME } };

/** 列表与表格里的时间：今天写时分，今年写月日，更早写年月日 */
export const listTime = (at: number): string => date(LIST_TIME[age(at)], at);

/** 时间线里的时刻：今天写时分，别的日子前面加上月日（不是今年再加年） */
export const clockTime = (at: number): string => date(CLOCK_TIME[age(at)], at);

/** 日志里的时刻：时、分、秒 */
export const logTime = (at: number): string => date(SECONDS, at);

/** 完整的日期与时刻（到秒），悬停提示用 */
export const fullTime = (at: number): string => date({ ...DAY, ...SECONDS }, at);

/** 数字按千位分组，至少写 digits 位小数 */
export const numberText = (value: number, digits = 0): string =>
  cached(`number ${digits}`, () => new Intl.NumberFormat(pageLanguage(), { minimumFractionDigits: digits })).format(
    value,
  );

/** 耗时：一分钟以内写到 0.1 秒，再长写分与秒 */
export function duration(ms: number): string {
  if (ms < 60_000) {
    const tenths = cached(
      'tenths',
      () => new Intl.NumberFormat(pageLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    );
    return tr('durationSeconds', { seconds: tenths.format(ms / 1000) });
  }
  const seconds = Math.round(ms / 1000);
  return tr('durationMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

/** 罗列的几项：甲、乙、丙，不加「和」，与字典里的 `{x, list}` 同一个分隔符 */
export const listText = (items: readonly string[]): string =>
  items.join(cached('list', () => listSeparator(pageLanguage(), language().packs)));

/** 排序比较文字 */
export const compareText = (a: string, b: string): number =>
  cached('collator', () => new Intl.Collator(pageLanguage())).compare(a, b);

/** 转小写：搜索不分大小写时两边都过它 */
export const lower = (text: string): string => text.toLocaleLowerCase(pageLanguage());

/** 数量缩写（token 数、下载量）：千以上写 k、百万以上写 M，一位小数、去掉末尾的 .0（1.2k、128k、1.2M），不分语言 */
export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  const thousands = Math.round(n / 100) / 10;
  return thousands < 1000 ? `${thousands}k` : `${Math.round(n / 100_000) / 10}M`;
}

/** 比例写成百分数，取整 */
export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** 说话人：owner 写「你」，房间成员写昵称，没有昵称写账号 */
export function speakerName(speaker: { platform: string; userId?: string; nickname?: string; owner: boolean }): string {
  if (speaker.owner) return tr('speakerYou');
  return speaker.nickname || speaker.userId || speaker.platform;
}
