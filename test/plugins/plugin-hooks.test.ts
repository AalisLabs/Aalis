import { describe, expect, it } from 'vitest';
import { Registry as HookRegistry } from '../../packages/plugin-hooks/src/index.js';

// plugin-hooks 的登记表：洋葱链、截停、登记序、运行中变更与卡链上报。归属与撤回在绑定门面的账本，不在本表。

/** 登记序：生产里由 hooks 门面分配，这里按调用次序递增 */
let seq = 0;

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
      ++seq,
    );
    reg.register(
      'inbound:command',
      async (_data, next) => {
        order.push('b-before');
        await next();
        order.push('b-after');
      },
      'ctx-test',
      ++seq,
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
      ++seq,
    );
    reg.register(
      'inbound:command',
      async () => {
        order.push('b');
      },
      'ctx-test',
      ++seq,
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
      ++seq,
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
      ++seq,
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('next');
        await n();
      },
      'ctx-test',
      ++seq,
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
      ++seq,
    );
    offLater = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('later');
        await n();
      },
      'ctx-test',
      ++seq,
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('last');
        await n();
      },
      'ctx-test',
      ++seq,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any);
    expect(order).toEqual(['first', 'last']);
    expect(reached).toBe(true);
  });

  it('链清空、同一钩子再登记后，旧退订仍只撤自己那一条', async () => {
    const reg = new HookRegistry();
    const order: string[] = [];
    const offA = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('a');
        await n();
      },
      'ctx-a',
      ++seq,
    );
    offA();
    // 链清空后表项被删，再登记会新建数组；退订闭包必须重查活容器，不能捕获旧数组
    const offB = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('b');
        await n();
      },
      'ctx-b',
      ++seq,
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('c');
        await n();
      },
      'ctx-c',
      ++seq,
    );
    offA();
    offB();
    // biome-ignore lint/suspicious/noExplicitAny: test
    const reached = await reg.run('inbound:command', {} as any, async () => {
      order.push('default');
    });
    expect(order).toEqual(['c', 'default']);
    expect(reached).toBe(true);
  });
});

describe('HookRegistry 卡链上报', () => {
  const stalled = async (_d: unknown, _n: () => Promise<void>) => {
    /* 不调 next：广播型相位里这就是卡链 */
  };

  it('warnOnStall 时点名卡链者与被跳过的数量', async () => {
    const calls: unknown[][] = [];
    const reg = new HookRegistry((...args) => void calls.push(args));
    reg.register('inbound:command', stalled, 'ctx-a', ++seq);
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', ++seq);
    await reg.run('inbound:command', {} as never, undefined, { warnOnStall: true });
    expect(calls).toEqual([['inbound:command', 'ctx-a', 1]]);
  });

  it('未带 warnOnStall 时正常截停不上报：截停是中间件的正当语义', async () => {
    const calls: unknown[][] = [];
    const reg = new HookRegistry((...args) => void calls.push(args));
    reg.register('inbound:command', stalled, 'ctx-a', ++seq);
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', ++seq);
    expect(await reg.run('inbound:command', {} as never)).toBe(false);
    expect(await reg.run('inbound:command', {} as never, undefined, {})).toBe(false);
    expect(calls).toEqual([]);
  });

  it('onStall 自身抛错不打断 run：诊断回调不得否决业务流程', async () => {
    const reg = new HookRegistry(() => {
      throw new Error('sink broken');
    });
    reg.register('inbound:command', stalled, 'ctx-a', ++seq);
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', ++seq);
    await expect(reg.run('inbound:command', {} as never, undefined, { warnOnStall: true })).resolves.toBe(false);
  });
});

describe('HookRegistry 登记序', () => {
  it('按登记序插入而非按到达次序：乱序到达的登记还原成登记序', async () => {
    const reg = new HookRegistry();
    const trail: string[] = [];
    const add = (tag: string, at: number) =>
      reg.register(
        'inbound:command',
        async (_d, n) => {
          trail.push(tag);
          await n();
        },
        `ctx-${tag}`,
        at,
      );
    add('c', 30);
    add('a', 10);
    add('d', 40);
    add('b', 20);
    await reg.run('inbound:command', {} as never);
    expect(trail).toEqual(['a', 'b', 'c', 'd']);
  });
});
