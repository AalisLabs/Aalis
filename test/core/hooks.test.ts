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

describe('HookRegistry 运行中变更（#8.4）', () => {
  it('handler 执行中 dispose 自己不跳过下一个 handler，reachedEnd 仍正确', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    let offSelf: () => void = () => {};
    offSelf = reg.register('inbound:command', async (_d, n) => {
      order.push('self');
      offSelf(); // 运行中注销自己（一次性 handler 模式）
      await n();
    });
    reg.register('inbound:command', async (_d, n) => {
      order.push('next');
      await n();
    });
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      order.push('default');
    });
    expect(order).toEqual(['self', 'next', 'default']);
    expect(reached).toBe(true);

    // 第二次 run：self 已注销，只剩 next
    order.length = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test
    await reg.run('inbound:command', {} as any);
    expect(order).toEqual(['next']);
  });

  it('handler 执行中 dispose 尚未执行的后续 handler，该 handler 被跳过', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    let offLater: () => void = () => {};
    reg.register('inbound:command', async (_d, n) => {
      order.push('first');
      offLater(); // 注销还没轮到的 handler
      await n();
    });
    offLater = reg.register('inbound:command', async (_d, n) => {
      order.push('later');
      await n();
    });
    reg.register('inbound:command', async (_d, n) => {
      order.push('last');
      await n();
    });
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any);
    expect(order).toEqual(['first', 'last']);
    expect(reached).toBe(true);
  });

  it('unregisterByContext 之后旧 dispose 闭包仍能精确移除（不再 no-op 泄漏）', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('a');
        await n();
      },
      'ctx-a',
    );
    const offB = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('b');
        await n();
      },
      'ctx-b',
    );
    // unregisterByContext 整体换数组——旧实现中 offB 捕获旧数组后会变 no-op
    reg.unregisterByContext('ctx-a');
    offB();
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      order.push('default');
    });
    expect(order).toEqual(['default']);
    expect(reached).toBe(true);
  });
});
