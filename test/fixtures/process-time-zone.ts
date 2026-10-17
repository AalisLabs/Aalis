import { expect } from 'vitest';

/**
 * 「时间按服务进程的时区」用例的前提：time 在进程时区下写成的时刻与 Asia/Tokyo 下的不同（用例里冒充读者时区的是东京）。
 * 相同时（进程本身在东京或同一时差）期望值区分不出时区，断言恒真，直接失败
 */
export function expectProcessTimeZoneDistinct(time = 0): void {
  const at = (timeZone?: string) =>
    new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(time);
  expect(at(), '进程时区写成的时刻与 Asia/Tokyo 下的相同，这条用例区分不出时区').not.toBe(at('Asia/Tokyo'));
}
