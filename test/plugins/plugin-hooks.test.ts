import { describe, expect, it } from 'vitest';
import { Registry as HookRegistry } from '../../packages/plugin-hooks/src/index.js';

// plugin-hooks 的登记表：洋葱链、截停、登记序、运行中变更与卡链上报。归属与撤回在绑定门面的归属表，不在本表。
// 这里的登记都给同一个位次（空串），比的是同一登记方之内的登记序；跨登记方的次序见 hub-seat-order.test.ts。

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
      '',
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
      '',
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
      '',
    );
    reg.register(
      'inbound:command',
      async () => {
        order.push('b');
      },
      'ctx-test',
      ++seq,
      '',
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
});

describe('HookRegistry：同一个中间件里 next() 只能调一次', () => {
  it('next() 落定之后再调一次：抛错并点名，默认动作只执行一次，后面的中间件只跑一次', async () => {
    const reg = new HookRegistry();
    const trail: string[] = [];
    let second: unknown;
    reg.register(
      'zz:once',
      async (_data, next) => {
        await next();
        second = await next().catch(err => err);
      },
      'ctx-twice',
      ++seq,
      '',
    );
    reg.register(
      'zz:once',
      async (_data, next) => {
        trail.push('下游');
        await next();
      },
      'ctx-down',
      ++seq,
      '',
    );
    const reached = await reg.run('zz:once', {}, async () => void trail.push('默认动作'));
    expect(reached).toBe(true);
    expect(trail).toEqual(['下游', '默认动作']);
    expect((second as Error).message).toBe('钩子 zz:once: handler(来自 ctx-twice) 重复调用 next()');
  });

  it('下游抛错之后再调一次：抛错，不越过抛错的那个接着往下走', async () => {
    const reg = new HookRegistry();
    const trail: string[] = [];
    reg.register(
      'zz:once',
      async (_data, next) => {
        try {
          await next();
        } catch {
          await next();
        }
      },
      'ctx-retry',
      ++seq,
      '',
    );
    reg.register(
      'zz:once',
      async () => {
        throw new Error('拦下');
      },
      'ctx-guard',
      ++seq,
      '',
    );
    reg.register(
      'zz:once',
      async (_data, next) => {
        trail.push('越过了拦截者');
        await next();
      },
      'ctx-tail',
      ++seq,
      '',
    );
    await expect(reg.run('zz:once', {}, async () => void trail.push('默认动作'))).rejects.toThrow(
      '钩子 zz:once: handler(来自 ctx-retry) 重复调用 next()',
    );
    expect(trail).toEqual([]);
  });

  it('前一次还没落定就再调：第二次抛错，游标不动，下游与默认动作各跑一次', async () => {
    const reg = new HookRegistry();
    const trail: string[] = [];
    let second: unknown;
    reg.register(
      'zz:once',
      async (_data, next) => {
        const first = next();
        second = await next().catch(err => err);
        await first;
      },
      'ctx-both',
      ++seq,
      '',
    );
    reg.register(
      'zz:once',
      async (_data, next) => {
        trail.push('下游');
        // 先让出一拍：上游第二次调用发出时，游标还停在下一个中间件之前
        await null;
        await next();
      },
      'ctx-down',
      ++seq,
      '',
    );
    reg.register(
      'zz:once',
      async (_data, next) => {
        trail.push('再下游');
        await next();
      },
      'ctx-tail',
      ++seq,
      '',
    );
    expect(await reg.run('zz:once', {}, async () => void trail.push('默认动作'))).toBe(true);
    expect(trail).toEqual(['下游', '再下游', '默认动作']);
    expect(second).toBeInstanceOf(Error);
  });

  it('再调而不等结果：被拒的 Promise 不成为未处理的拒绝（宿主把未处理的拒绝当致命错误）', async () => {
    const reg = new HookRegistry();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      reg.register(
        'zz:once',
        async (_data, next) => {
          await next();
          void next();
        },
        'ctx-twice',
        ++seq,
        '',
      );
      expect(await reg.run('zz:once', {})).toBe(true);
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('只调一次时交回的是链自己的 Promise：await next() 不多绕微任务', async () => {
    const reg = new HookRegistry();
    // 微任务时钟：每过一个微任务加一
    let tick = 0;
    let defaultAt = -1;
    let resumedAt = -1;
    reg.register(
      'zz:once',
      async (_data, next) => {
        const clock = (async () => {
          while (tick < 20) {
            await null;
            tick++;
          }
        })();
        await next();
        resumedAt = tick;
        await clock;
      },
      'ctx-clock',
      ++seq,
      '',
    );
    await reg.run('zz:once', {}, async () => {
      defaultAt = tick;
    });
    // 默认动作落定一拍，链的 next 落定一拍；交回的要是另包一层的 Promise，这里会更多
    expect(resumedAt - defaultAt).toBe(2);
  });
});

describe('HookRegistry 运行中变更', () => {
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
      '',
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('next');
        await n();
      },
      'ctx-test',
      ++seq,
      '',
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
      '',
    );
    offLater = reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('later');
        await n();
      },
      'ctx-test',
      ++seq,
      '',
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('last');
        await n();
      },
      'ctx-test',
      ++seq,
      '',
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
      '',
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
      '',
    );
    reg.register(
      'inbound:command',
      async (_d, n) => {
        order.push('c');
        await n();
      },
      'ctx-c',
      ++seq,
      '',
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
    reg.register('inbound:command', stalled, 'ctx-a', ++seq, '');
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', ++seq, '');
    await reg.run('inbound:command', {} as never, undefined, { warnOnStall: true });
    expect(calls).toEqual([['inbound:command', 'ctx-a', 1]]);
  });

  it('上游调了 next、下游卡链：只点名下游', async () => {
    const calls: unknown[][] = [];
    const reg = new HookRegistry((...args) => void calls.push(args));
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-a', ++seq, '');
    reg.register('inbound:command', stalled, 'ctx-b', ++seq, '');
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-c', ++seq, '');
    await reg.run('inbound:command', {} as never, undefined, { warnOnStall: true });
    expect(calls).toEqual([['inbound:command', 'ctx-b', 1]]);
  });

  it('未带 warnOnStall 时正常截停不上报：截停是中间件的正当语义', async () => {
    const calls: unknown[][] = [];
    const reg = new HookRegistry((...args) => void calls.push(args));
    reg.register('inbound:command', stalled, 'ctx-a', ++seq, '');
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', ++seq, '');
    expect(await reg.run('inbound:command', {} as never)).toBe(false);
    expect(await reg.run('inbound:command', {} as never, undefined, {})).toBe(false);
    expect(calls).toEqual([]);
  });

  it('onStall 自身抛错不打断 run：诊断回调不得否决业务流程', async () => {
    const reg = new HookRegistry(() => {
      throw new Error('sink broken');
    });
    reg.register('inbound:command', stalled, 'ctx-a', ++seq, '');
    reg.register('inbound:command', async (_d, n) => n(), 'ctx-b', ++seq, '');
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
        '',
      );
    add('c', 30);
    add('a', 10);
    add('d', 40);
    add('b', 20);
    await reg.run('inbound:command', {} as never);
    expect(trail).toEqual(['a', 'b', 'c', 'd']);
  });
});
