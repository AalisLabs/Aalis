import { describe, expect, it } from 'vitest';
import { DiscoveredToolsRegistry, extractDiscoveredTools } from '../../packages/plugin-tool-search/src/index.js';

/** 模拟一段含真实调用证据的消息史:assistant 调了 fetch_url 且收到 tool 响应 */
function messagesWithEvidence() {
  return [
    { role: 'user', content: '抓一下这个网页' },
    { role: 'assistant', content: null, toolCalls: [{ id: 'c1', function: { name: 'fetch_url' } }] },
    { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
  ];
}

/** 裁剪后的消息史:工具调用组被压成纯文本,结构证据(toolCalls/toolCallId)消失 */
function messagesAfterTrim() {
  return [
    { role: 'user', content: '抓一下这个网页' },
    { role: 'system', content: '[早前操作摘要] 调用了 fetch_url 并成功' },
    { role: 'user', content: '继续下一个' },
  ];
}

describe('DiscoveredToolsRegistry', () => {
  it('裁剪摧毁消息证据后,注册表仍记得已发现的工具', () => {
    const reg = new DiscoveredToolsRegistry(20);
    const round1 = reg.absorb('s1', extractDiscoveredTools(messagesWithEvidence(), 20));
    expect(round1.has('fetch_url')).toBe(true);

    // 第二轮:消息里已无任何结构证据(模拟 trim Phase 3/4 之后)
    const round2 = reg.absorb('s1', extractDiscoveredTools(messagesAfterTrim(), 20));
    expect(round2.has('fetch_url')).toBe(true);
  });

  it('会话之间互相隔离', () => {
    const reg = new DiscoveredToolsRegistry(20);
    reg.absorb('s1', ['tool_a']);
    expect(reg.peek('s2').has('tool_a')).toBe(false);
  });

  it('单会话容量按 LRU 淘汰,重复出现顶到最新', () => {
    const reg = new DiscoveredToolsRegistry(2);
    reg.absorb('s1', ['a', 'b']);
    reg.absorb('s1', ['a']); // a 变最新
    const now = reg.absorb('s1', ['c']); // 容量 2,最旧的 b 出局
    expect(now.has('a')).toBe(true);
    expect(now.has('c')).toBe(true);
    expect(now.has('b')).toBe(false);
  });

  it('会话数超上限时淘汰最久未活跃的会话', () => {
    const reg = new DiscoveredToolsRegistry(20, 2);
    reg.absorb('s1', ['a']);
    reg.absorb('s2', ['b']);
    reg.absorb('s1', ['a2']); // s1 活跃,顶到尾部
    reg.absorb('s3', ['c']); // 超上限,最旧的 s2 出局
    expect(reg.peek('s2').size).toBe(0);
    expect(reg.peek('s1').has('a')).toBe(true);
  });

  it('memory:clear 语义:clear(sessionId) 只清该会话,clear() 全清', () => {
    const reg = new DiscoveredToolsRegistry(20);
    reg.absorb('s1', ['a']);
    reg.absorb('s2', ['b']);
    reg.clear('s1');
    expect(reg.peek('s1').size).toBe(0);
    expect(reg.peek('s2').has('b')).toBe(true);
    reg.clear();
    expect(reg.peek('s2').size).toBe(0);
  });
});
