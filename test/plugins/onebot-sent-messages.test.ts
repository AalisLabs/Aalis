import { describe, expect, it } from 'vitest';
import { extractSentMessageId, SentMessageTracker } from '../../packages/plugin-adapter-onebot/src/sent-messages.js';

// ════════════════════════════════════════════════════════════
// OneBot 自身发出消息记录 —— 支撑「撤回自己发的消息」
// ════════════════════════════════════════════════════════════

const T0 = 1_700_000_000_000;
const SID = 'onebot:111:group:222';

describe('extractSentMessageId', () => {
  it('从 {message_id} 取出（数字/字符串都转字符串）', () => {
    expect(extractSentMessageId({ message_id: 12345 })).toBe('12345');
    expect(extractSentMessageId({ message_id: 'abc' })).toBe('abc');
  });
  it('缺失 / 空 / 非对象 → 空串', () => {
    expect(extractSentMessageId({})).toBe('');
    expect(extractSentMessageId({ message_id: '' })).toBe('');
    expect(extractSentMessageId(null)).toBe('');
    expect(extractSentMessageId('x')).toBe('');
    expect(extractSentMessageId(undefined)).toBe('');
  });
});

describe('SentMessageTracker', () => {
  it('record + recent：新→旧返回，preview 去标签/CQ码并截断', () => {
    const t = new SentMessageTracker();
    t.record(SID, '1', '你好', T0);
    t.record(SID, '2', '世界 <image src="x"/> [CQ:face,id=1]', T0 + 1);
    const recent = t.recent(SID, 10, T0 + 2);
    expect(recent.map(r => r.messageId)).toEqual(['2', '1']);
    expect(recent[0].preview).toBe('世界');
  });

  it('messageId 为空不记录', () => {
    const t = new SentMessageTracker();
    t.record(SID, '', '空 id', T0);
    expect(t.recent(SID, 10, T0)).toEqual([]);
  });

  it('每会话条数上限（默认 20）：只保留最近 20 条', () => {
    const t = new SentMessageTracker();
    for (let i = 0; i < 25; i++) t.record(SID, String(i), `m${i}`, T0 + i);
    const recent = t.recent(SID, 100, T0 + 25);
    expect(recent.length).toBe(20);
    expect(recent[0].messageId).toBe('24'); // 最新
    expect(recent[recent.length - 1].messageId).toBe('5'); // 最旧保留的
  });

  it('超出保留时窗（默认 30min）→ 不返回', () => {
    const t = new SentMessageTracker();
    t.record(SID, '1', 'old', T0);
    expect(t.recent(SID, 10, T0 + 31 * 60_000)).toEqual([]);
  });

  it('forget 移除一条，使「撤回最近一条」可重复往前走', () => {
    const t = new SentMessageTracker();
    t.record(SID, '1', 'a', T0);
    t.record(SID, '2', 'b', T0 + 1);
    expect(t.recent(SID, 1, T0 + 2)[0].messageId).toBe('2');
    t.forget(SID, '2');
    expect(t.recent(SID, 1, T0 + 2)[0].messageId).toBe('1');
    t.forget(SID, '1');
    expect(t.recent(SID, 1, T0 + 2)).toEqual([]);
  });

  it('会话隔离：不同 sessionId 互不可见', () => {
    const t = new SentMessageTracker();
    t.record('onebot:111:group:A', '1', 'a', T0);
    t.record('onebot:111:group:B', '2', 'b', T0);
    expect(t.recent('onebot:111:group:A', 10, T0).map(r => r.messageId)).toEqual(['1']);
    expect(t.recent('onebot:111:group:B', 10, T0).map(r => r.messageId)).toEqual(['2']);
  });

  it('记录新消息时清理整体过期的会话', () => {
    const t = new SentMessageTracker();
    t.record('stale', '1', 'old', T0);
    // 30min 后在另一会话写入，触发 prune → stale 会话被丢弃
    t.record('fresh', '2', 'new', T0 + 31 * 60_000);
    expect(t.recent('stale', 10, T0 + 31 * 60_000)).toEqual([]);
    expect(t.recent('fresh', 10, T0 + 31 * 60_000).map(r => r.messageId)).toEqual(['2']);
  });
});
