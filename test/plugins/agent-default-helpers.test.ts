import { describe, expect, it } from 'vitest';
import type { Message } from '../../packages/core/src/index.js';
import {
  buildFocusGuidance,
  estimateMsgTokens,
  estimateTextTokens,
  estimateTokens,
  formatTimeLabel,
  INPUT_CONVENTIONS,
  isSameMessage,
} from '../../packages/plugin-agent/src/helpers.js';
import type { IncomingMessage } from '../../packages/plugin-message-api/src/index.js';

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

describe('buildFocusGuidance', () => {
  const base: IncomingMessage = {
    content: '你怎么看这个事',
    sessionId: 's1',
    platform: 'onebot',
    userId: 'u1',
  };

  it('群聊 + immediate（@触发）→ 返回 system 焦点指引', () => {
    const msg = buildFocusGuidance({ ...base, sessionType: 'group', triggerType: 'immediate' });
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe('system');
    expect(msg?.content).toContain('【当前焦点】');
    expect(msg?.content).toContain('焦点消息');
    expect(msg?.metadata?.source).toBe('focus-guidance');
  });

  it('群聊 + direct（直接对话）→ 返回 system 焦点指引', () => {
    const msg = buildFocusGuidance({ ...base, sessionType: 'group', triggerType: 'direct' });
    expect(msg).not.toBeNull();
  });

  it('私聊 → 返回 null（私聊本身就是 1v1，无需焦点指引）', () => {
    expect(buildFocusGuidance({ ...base, sessionType: 'private', triggerType: 'direct' })).toBeNull();
  });

  it('群聊 + interval（被动触发）→ 返回 null（无明确焦点）', () => {
    expect(buildFocusGuidance({ ...base, sessionType: 'group', triggerType: 'interval' })).toBeNull();
  });

  it('群聊 + idle → 返回 null', () => {
    expect(buildFocusGuidance({ ...base, sessionType: 'group', triggerType: 'idle' })).toBeNull();
  });

  it('群聊 + proactive（跨会话委派）→ 返回 null（任务由 system 块传递）', () => {
    expect(buildFocusGuidance({ ...base, sessionType: 'group', triggerType: 'proactive' })).toBeNull();
  });

  it('triggerType 缺失 → 返回 null（按 direct 兼容但仅在 sessionType 明确为 group 时不主动注入）', () => {
    expect(buildFocusGuidance({ ...base, sessionType: 'group' })).toBeNull();
  });

  it('sessionType 缺失 → 返回 null', () => {
    expect(buildFocusGuidance({ ...base, triggerType: 'immediate' })).toBeNull();
  });
});
