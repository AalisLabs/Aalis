// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listTime } from '../../packages/plugin-webui-client/src/format.js';

// 列表与表格里的时间：今天写时分，今年写月/日，更早写年/月/日（按本地时区）

afterEach(() => vi.useRealTimers());

describe('列表里的时间', () => {
  it('今天、今年与更早', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 3, 15, 0));
    expect(listTime(new Date(2026, 9, 3, 9, 5).getTime())).toBe('09:05');
    expect(listTime(new Date(2026, 9, 3, 0, 0).getTime())).toBe('00:00');
    expect(listTime(new Date(2026, 9, 2, 23, 59).getTime())).toBe('10/2');
    expect(listTime(new Date(2026, 0, 1, 8, 0).getTime())).toBe('1/1');
    expect(listTime(new Date(2025, 11, 31, 23, 0).getTime())).toBe('2025/12/31');
  });
});
