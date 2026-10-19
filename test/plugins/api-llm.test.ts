import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { estimateMsgTokens, estimateTextTokens, idleTimeout } from '../../packages/api-llm/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

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

describe('estimateMsgTokens', () => {
  it('单条消息基线开销 4 tokens', () => {
    const msg: Message = { role: 'user', content: '' };
    expect(estimateMsgTokens(msg)).toBe(4);
  });
});

describe('idleTimeout', () => {
  it.each([2 ** 31, Number.POSITIVE_INFINITY])('ms 超过定时器上限（%s）时按上限计，不会立刻中止', async ms => {
    const { signal } = idleTimeout(ms);
    await sleep(50);
    expect(signal.aborted).toBe(false);
  });
});
