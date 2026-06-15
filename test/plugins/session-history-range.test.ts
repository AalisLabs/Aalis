import { describe, expect, it } from 'vitest';
import { parseTimestamp, resolveTimeRange } from '../../packages/plugin-tool-session/src/index.js';

// ════════════════════════════════════════════════════════════
// session_get_history — 时间区间解析（纯函数）
// ════════════════════════════════════════════════════════════

const NOW = Date.parse('2026-06-15T12:00:00Z');

describe('parseTimestamp', () => {
  it('数字按毫秒时间戳原样返回', () => {
    expect(parseTimestamp(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it('纯数字字符串当毫秒时间戳', () => {
    expect(parseTimestamp('1700000000000')).toBe(1_700_000_000_000);
  });
  it('ISO 8601 字符串解析为毫秒', () => {
    expect(parseTimestamp('2026-06-15T12:00:00Z')).toBe(NOW);
  });
  it('空 / null / 非法字符串返回 null', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp('not-a-date')).toBeNull();
    expect(parseTimestamp(Number.NaN)).toBeNull();
  });
});

describe('resolveTimeRange', () => {
  it('无任何时间入参 → null（退回条数检索）', () => {
    expect(resolveTimeRange({}, NOW)).toBeNull();
  });

  it('within_minutes → [now - N 分钟, now]', () => {
    const r = resolveTimeRange({ within_minutes: 30 }, NOW);
    expect(r).toEqual({ fromTs: NOW - 30 * 60_000, toTs: NOW });
  });

  it('within_minutes 非正数 → 错误', () => {
    expect(resolveTimeRange({ within_minutes: 0 }, NOW)).toEqual({ error: expect.stringContaining('正数') });
    expect(resolveTimeRange({ within_minutes: -5 }, NOW)).toEqual({ error: expect.stringContaining('正数') });
    expect(resolveTimeRange({ within_minutes: 'abc' }, NOW)).toEqual({ error: expect.stringContaining('正数') });
  });

  it('since 给定、until 省略 → until 默认取 now', () => {
    const r = resolveTimeRange({ since: '2026-06-15T11:00:00Z' }, NOW);
    expect(r).toEqual({ fromTs: Date.parse('2026-06-15T11:00:00Z'), toTs: NOW });
  });

  it('since + until 绝对区间', () => {
    const r = resolveTimeRange({ since: '2026-06-15T08:00:00Z', until: '2026-06-15T10:00:00Z' }, NOW);
    expect(r).toEqual({
      fromTs: Date.parse('2026-06-15T08:00:00Z'),
      toTs: Date.parse('2026-06-15T10:00:00Z'),
    });
  });

  it('until 给定、since 省略 → from 取 0（开区间到上界）', () => {
    const r = resolveTimeRange({ until: '2026-06-15T10:00:00Z' }, NOW);
    expect(r).toEqual({ fromTs: 0, toTs: Date.parse('2026-06-15T10:00:00Z') });
  });

  it('since 晚于 until → 错误', () => {
    const r = resolveTimeRange({ since: '2026-06-15T10:00:00Z', until: '2026-06-15T08:00:00Z' }, NOW);
    expect(r).toEqual({ error: expect.stringContaining('不能晚于') });
  });

  it('since 不可解析 → 错误', () => {
    expect(resolveTimeRange({ since: 'yesterday' }, NOW)).toEqual({
      error: expect.stringContaining('无法解析 since'),
    });
  });

  it('until 不可解析 → 错误', () => {
    expect(resolveTimeRange({ since: '2026-06-15T08:00:00Z', until: 'soon' }, NOW)).toEqual({
      error: expect.stringContaining('无法解析 until'),
    });
  });

  it('since/until 优先于 within_minutes（绝对区间覆盖相对）', () => {
    const r = resolveTimeRange({ within_minutes: 30, since: '2026-06-15T11:00:00Z' }, NOW);
    expect(r).toEqual({ fromTs: Date.parse('2026-06-15T11:00:00Z'), toTs: NOW });
  });

  it('毫秒时间戳字符串也能作 since/until', () => {
    const from = NOW - 60 * 60_000;
    const r = resolveTimeRange({ since: String(from), until: String(NOW) }, NOW);
    expect(r).toEqual({ fromTs: from, toTs: NOW });
  });
});
