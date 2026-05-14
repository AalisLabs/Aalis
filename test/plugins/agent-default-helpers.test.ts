import { describe, expect, it } from 'vitest';
import type { Message } from '../../packages/core/src/index.js';
import {
  estimateMsgTokens,
  estimateTextTokens,
  estimateTokens,
  formatTimeLabel,
  INPUT_CONVENTIONS,
  isSameMessage,
} from '../../packages/plugin-agent/src/helpers.js';

describe('formatTimeLabel', () => {
  it('同一天显示「今天 HH:mm」', () => {
    const now = new Date('2025-01-15T14:30:00').getTime();
    const ts = new Date('2025-01-15T09:05:00').getTime();
    expect(formatTimeLabel(ts, now)).toBe('今天 09:05');
  });

  it('跨天同年显示 月/日 HH:mm', () => {
    const now = new Date('2025-01-15T14:30:00').getTime();
    const ts = new Date('2025-01-10T09:05:00').getTime();
    expect(formatTimeLabel(ts, now)).toBe('1/10 09:05');
  });

  it('跨年显示 年/月/日 HH:mm', () => {
    const now = new Date('2025-01-15T14:30:00').getTime();
    const ts = new Date('2024-12-30T09:05:00').getTime();
    expect(formatTimeLabel(ts, now)).toBe('2024/12/30 09:05');
  });
});

describe('estimateTextTokens', () => {
  it('纯 ASCII：约 3.5 字符 / token', () => {
    const t = estimateTextTokens('hello world this is a test');
    // 26 字符 / 3.5 ≈ 8
    expect(t).toBeGreaterThanOrEqual(7);
    expect(t).toBeLessThanOrEqual(9);
  });

  it('纯 CJK：~1.5 token / 字符', () => {
    const t = estimateTextTokens('你好世界这是测试');
    // 8 字符 × 1.5 = 12
    expect(t).toBe(12);
  });

  it('混合：ASCII + CJK 加和', () => {
    const t = estimateTextTokens('hello 你好');
    expect(t).toBeGreaterThan(3);
  });

  it('空字符串返回 0', () => {
    expect(estimateTextTokens('')).toBe(0);
  });
});

describe('estimateMsgTokens / estimateTokens', () => {
  it('单条消息基线开销 4 tokens', () => {
    const msg: Message = { role: 'user', content: '' };
    expect(estimateMsgTokens(msg)).toBe(4);
  });

  it('多条消息求和', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(estimateTokens(msgs)).toBe(estimateMsgTokens(msgs[0]) + estimateMsgTokens(msgs[1]));
  });
});

describe('isSameMessage', () => {
  it('role + timestamp + name + content 全等则为同一消息', () => {
    const a: Message = { role: 'user', content: 'hi', timestamp: 1000, name: 'alice' };
    const b: Message = { role: 'user', content: 'hi', timestamp: 1000, name: 'alice' };
    expect(isSameMessage(a, b)).toBe(true);
  });

  it('content 不同则不同', () => {
    const a: Message = { role: 'user', content: 'hi', timestamp: 1000 };
    const b: Message = { role: 'user', content: 'hello', timestamp: 1000 };
    expect(isSameMessage(a, b)).toBe(false);
  });

  it('timestamp 不同则不同', () => {
    const a: Message = { role: 'user', content: 'hi', timestamp: 1000 };
    const b: Message = { role: 'user', content: 'hi', timestamp: 1001 };
    expect(isSameMessage(a, b)).toBe(false);
  });
});

describe('INPUT_CONVENTIONS', () => {
  it('包含输入约定标题', () => {
    expect(INPUT_CONVENTIONS).toContain('【输入约定】');
    expect(INPUT_CONVENTIONS).toContain('<forward');
  });
});
