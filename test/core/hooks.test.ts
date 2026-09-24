import { describe, expect, it } from 'vitest';
import { HookRegistry } from '../../packages/core/src/primitives/hooks.js';

describe('HookRegistry', () => {
  it('handler 顺序执行（洋葱模型）+ defaultAction 在最后', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];

    reg.register(
      'inbound:command',
      async (_data, next) => {
        order.push('a-before');
        await next();
        order.push('a-after');
      },
      'ctx-test',
    );
    reg.register(
      'inbound:command',
      async (_data, next) => {
        order.push('b-before');
        await next();
        order.push('b-after');
      },
      'ctx-test',
    );

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
    reg.register(
      'inbound:command',
      async () => {
        order.push('a');
        // 不调 next
      },
      'ctx-test',
    );
    reg.register(
      'inbound:command',
      async () => {
        order.push('b');
      },
      'ctx-test',
    );
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

  it('unregisterByOwner 移除指定归属的 handler', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    const p1 = Symbol('plugin-1');
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('p1');
        await n();
      },
      'plugin-1',
      p1,
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('p2');
        await n();
      },
      'plugin-2',
      Symbol('plugin-2'),
    );
    reg.unregisterByOwner(p1);
    // biome-ignore lint/suspicious/noExplicitAny: test
    await reg.run('inbound:command', {} as any);
    expect(order).toEqual(['p2']);
  });

  it('register 返回的 dispose 精确移除该 handler', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    const off = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('x');
        await n();
      },
      'ctx-test',
    );
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
    offSelf = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('self');
        offSelf(); // 运行中注销自己（一次性 handler 模式）
        await n();
      },
      'ctx-test',
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('next');
        await n();
      },
      'ctx-test',
    );
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
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('first');
        offLater(); // 注销还没轮到的 handler
        await n();
      },
      'ctx-test',
    );
    offLater = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('later');
        await n();
      },
      'ctx-test',
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('last');
        await n();
      },
      'ctx-test',
    );
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any);
    expect(order).toEqual(['first', 'last']);
    expect(reached).toBe(true);
  });

  it('unregisterByOwner 之后旧 dispose 闭包仍能精确移除（不再 no-op 泄漏）', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    const a = Symbol('ctx-a');
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('a');
        await n();
      },
      'ctx-a',
      a,
    );
    const offB = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('b');
        await n();
      },
      'ctx-b',
      Symbol('ctx-b'),
    );
    // 旧实现的 unregisterByOwner 整体换数组，offB 捕获旧数组后会变 no-op；现在原地删，此例守的是退订闭包重查活容器
    reg.unregisterByOwner(a);
    offB();
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      order.push('default');
    });
    expect(order).toEqual(['default']);
    expect(reached).toBe(true);
  });
});

describe('HookRegistry 卡链上报', () => {
  const stalled = async (_d: unknown, _n: () => Promise<void>) => {
    /* 不调 next：广播型相位里这就是卡链 */
  };

  it('warnOnStall 时点名卡链者与被跳过的数量', async () => {
    const reg = new HookRegistry();
    const calls: unknown[][] = [];
    reg.onStall = (...args) => calls.push(args);
    reg.register('inbound:command', stalled, 'ctx-a', Symbol('a'));
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', Symbol('b'));
    await reg.run('inbound:command', {} as never, undefined, { warnOnStall: true });
    expect(calls).toEqual([['inbound:command', 'ctx-a', 1]]);
  });

  it('onStall 自身抛错不打断 run：诊断回调不得否决业务流程', async () => {
    const reg = new HookRegistry();
    reg.onStall = () => {
      throw new Error('sink broken');
    };
    reg.register('inbound:command', stalled, 'ctx-a', Symbol('a'));
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', Symbol('b'));
    await expect(reg.run('inbound:command', {} as never, undefined, { warnOnStall: true })).resolves.toBe(false);
  });
});

describe('HookRegistry unregisterByOwner', () => {
  it('同一 owner 在同一钩子上相邻的多条登记全部清掉', async () => {
    const reg = new HookRegistry();
    const a = Symbol('a');
    const hits: string[] = [];
    for (const tag of ['a1', 'a2', 'a3']) {
      reg.register(
        'inbound:command',
        async (_d, n) => {
          hits.push(tag);
          await n();
        },
        'ctx-a',
        a,
      );
    }
    reg.register(
      'inbound:command',
      async (_d, n) => {
        hits.push('b');
        await n();
      },
      'ctx-b',
      Symbol('b'),
    );
    reg.unregisterByOwner(a);
    await reg.run('inbound:command', {} as never);
    expect(hits).toEqual(['b']);
  });
});
