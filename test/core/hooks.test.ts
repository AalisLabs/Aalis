import { describe, expect, it } from 'vitest';
import { HookRegistry } from '../../packages/core/src/index.js';

describe('HookRegistry', () => {
  it('handler 顺序执行（洋葱模型）+ defaultAction 在最后', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];

    reg.register('inbound:command', async (_data, next) => {
      order.push('a-before');
      await next();
      order.push('a-after');
    });
    reg.register('inbound:command', async (_data, next) => {
      order.push('b-before');
      await next();
      order.push('b-after');
    });

    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      order.push('default');
    });

    expect(order).toEqual(['a-before', 'b-before', 'default', 'b-after', 'a-after']);
    expect(reached).toBe(true);
  });

  it('handler 不调 next 中断管道，返回 false', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    reg.register('inbound:command', async () => {
      order.push('a');
      // 不调 next
    });
    reg.register('inbound:command', async () => {
      order.push('b');
    });
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      order.push('default');
    });
    expect(order).toEqual(['a']);
    expect(reached).toBe(false);
  });

  it('无 handler 时直接执行 defaultAction，返回 true', async () => {
    const reg = new HookRegistry();
    let ran = false;
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(reached).toBe(true);
  });

  it('unregisterByContext 移除指定 contextId 的 handler', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('p1');
        await n();
      },
      'plugin-1',
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('p2');
        await n();
      },
      'plugin-2',
    );
    reg.unregisterByContext('plugin-1');
    // biome-ignore lint/suspicious/noExplicitAny: test
    await reg.run('inbound:command', {} as any);
    expect(order).toEqual(['p2']);
  });

  it('register 返回的 dispose 精确移除该 handler', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    const off = reg.register('inbound:command', async (_d, n) => {
      order.push('x');
      await n();
    });
    off();
    // biome-ignore lint/suspicious/noExplicitAny: test
    await reg.run('inbound:command', {} as any);
    expect(order).toEqual([]);
  });
});
