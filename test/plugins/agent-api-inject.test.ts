import { describe, expect, it } from 'vitest';
import type { Message } from '../../packages/core/src/index.js';
import { injectSystemBlock } from '../../packages/plugin-agent-api/src/index.js';

function base(): Message[] {
  return [
    { role: 'system', content: 'persona', metadata: { injector: 'persona' } },
    { role: 'system', content: '摘要', metadata: { injector: 'memory-summary' } },
    { role: 'user', content: '你好' },
  ] as Message[];
}

describe('injectSystemBlock', () => {
  it('默认锚点:插到头部 system 块末尾(第一条非 system 之前)', () => {
    const msgs = base();
    expect(injectSystemBlock(msgs, { injector: 'x', content: 'X' })).toBe(true);
    expect(msgs[2].metadata?.injector).toBe('x');
    expect(msgs[3].role).toBe('user');
  });

  it('afterFirstSystem 锚点:紧贴 persona 之后', () => {
    const msgs = base();
    injectSystemBlock(msgs, { injector: 'x', content: 'X', anchor: 'afterFirstSystem' });
    expect(msgs[1].metadata?.injector).toBe('x');
  });

  it('幂等:同标签已存在则不重复插入', () => {
    const msgs = base();
    expect(injectSystemBlock(msgs, { injector: 'x', content: 'X' })).toBe(true);
    expect(injectSystemBlock(msgs, { injector: 'x', content: 'X2' })).toBe(false);
    expect(msgs.filter(m => m.metadata?.injector === 'x')).toHaveLength(1);
  });

  it('无 system 消息时落点安全(afterFirstSystem 退化为队首,head 落在首个非 system 前)', () => {
    const onlyUser = [{ role: 'user', content: 'hi' }] as Message[];
    injectSystemBlock(onlyUser, { injector: 'x', content: 'X', anchor: 'afterFirstSystem' });
    expect(onlyUser[0].metadata?.injector).toBe('x');
    const empty = [] as Message[];
    injectSystemBlock(empty, { injector: 'y', content: 'Y' });
    expect(empty[0].metadata?.injector).toBe('y');
  });
});
