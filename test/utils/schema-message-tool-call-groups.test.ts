import { describe, expect, it } from 'vitest';
import { groupToolCalls, type Message } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 历史里的工具调用组（schema-message 的 groupToolCalls）：读历史的各方只比单位的形状，不各自再判哪条是组外的结果
// ════════════════════════════════════════════════════════════

const call = (...ids: string[]): Message => ({
  role: 'assistant',
  content: null,
  toolCalls: ids.map(id => ({ id, type: 'function', function: { name: 'zz_probe', arguments: '{}' } })),
});
const result = (id: string): Message => ({ role: 'tool', content: 'ok', toolCallId: id });
const said = (content: string): Message => ({ role: 'user', content });

describe('groupToolCalls', () => {
  it('找齐了的组、没找齐的组、组外的工具结果与单独一条各是一种形状；夹进组里的消息挪到组后', () => {
    const messages = [
      result('x'),
      said('<甲>'),
      call('a', 'b'),
      said('<夹进来>'),
      result('a'),
      result('b'),
      call('c'),
      said('<乙>'),
    ];
    expect(groupToolCalls(messages)).toEqual([
      { at: [0], shape: 'loose' },
      { at: [1], shape: 'single' },
      { at: [2, 4, 5], shape: 'complete' },
      { at: [3], shape: 'single' },
      { at: [6], shape: 'partial' },
      { at: [7], shape: 'single' },
    ]);
  });
});
