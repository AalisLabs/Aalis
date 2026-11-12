import { describe, expect, it, vi } from 'vitest';
import { Bus } from '../../packages/plugin-events/src/index.js';

// plugin-events 的总线：按登记序派发并逐个等待、监听器之间互相隔离、一次派发只送达开始时已登记的。
// 归属与撤回在绑定门面的归属表，不在本表。

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const CAP = 1000; // 违例时会无限送达；数到上限停手，免得阻塞测试进程

/** 依次取号的登记：与门面分配登记序的做法相同。位次都给空串，比的是同一登记方之内的登记序 */
function world(logger?: ConstructorParameters<typeof Bus>[0]) {
  const bus = new Bus(logger);
  let n = 0;
  const on = (event: string, handler: (...args: never[]) => unknown, contextId = 'p') =>
    bus.on(event, handler as never, contextId, ++n, '');
  return { bus, on };
}

describe('派发', () => {
  it('按登记顺序逐个调用，异步监听器落定后才到下一个', async () => {
    const { bus, on } = world();
    const order: number[] = [];
    on('e', () => void order.push(1));
    on('e', async () => {
      await tick();
      order.push(2);
    });
    on('e', () => void order.push(3));
    await bus.emit('e');
    expect(order).toEqual([1, 2, 3]);
  });

  it('参数原样交给每个监听器；第一个监听器在 emit 的调用栈上同步执行', async () => {
    const { bus, on } = world();
    const got: unknown[][] = [];
    on('e', (...args: unknown[]) => void got.push(args));
    const payload = { n: 1 };
    const emitting = bus.emit('e', payload, 'x');
    expect(got, 'emit 返回时第一个监听器已经执行').toEqual([[payload, 'x']]);
    expect(got[0][0]).toBe(payload);
    await emitting;
  });

  it('没有监听器时什么都不做', async () => {
    const { bus } = world();
    await expect(bus.emit('nobody', 1)).resolves.toBeUndefined();
  });

  it('只调用同名事件的监听器', async () => {
    const { bus, on } = world();
    const a = vi.fn();
    const b = vi.fn();
    on('a', a);
    on('b', b);
    await bus.emit('a');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});

describe('登记与退订', () => {
  it('退订后不再收到；重复退订是空操作', async () => {
    const { bus, on } = world();
    const gone = vi.fn();
    const kept = vi.fn();
    const off = on('e', gone);
    on('e', kept);
    off();
    off();
    await bus.emit('e');
    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('同一函数登记两次：各算各的，各自退订', async () => {
    const { bus, on } = world();
    const fn = vi.fn();
    const offFirst = on('e', fn);
    on('e', fn);
    await bus.emit('e');
    expect(fn).toHaveBeenCalledTimes(2);
    offFirst();
    await bus.emit('e');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('按登记序插入：序号小的后到也排在前面（换提供者整批重挂时靠它还原次序）', async () => {
    const bus = new Bus();
    const order: string[] = [];
    bus.on('e', () => void order.push('third'), 'p', 30, '');
    bus.on('e', () => void order.push('first'), 'p', 10, '');
    bus.on('e', () => void order.push('second'), 'p', 20, '');
    await bus.emit('e');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('事件的监听器全部退订后又有人登记：早先那批的退订不影响新登记', async () => {
    const { bus, on } = world();
    const offOld = on('e', () => {});
    offOld();
    const fresh = vi.fn();
    on('e', fresh);
    offOld();
    await bus.emit('e');
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});

describe('监听器之间互相隔离', () => {
  it('同步抛错与返回被拒的 Promise 都不中断其余监听器，emit 照常兑现；各记一条 warn，点名事件与登记方、附上错误对象', async () => {
    const warns: unknown[][] = [];
    const { bus, on } = world({ warn: (...args) => void warns.push(args) });
    const boomA = new Error('boom-a');
    const boomB = new Error('boom-b');
    const order: string[] = [];
    on(
      'e',
      () => {
        order.push('a');
        throw boomA;
      },
      'plugin-a',
    );
    on(
      'e',
      async () => {
        order.push('b');
        throw boomB;
      },
      'plugin-b',
    );
    on('e', () => void order.push('c'), 'plugin-c');
    await expect(bus.emit('e')).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(warns).toEqual([
      ['事件 "e" 的监听器抛错（已隔离，来自 plugin-a）:', boomA],
      ['事件 "e" 的监听器抛错（已隔离，来自 plugin-b）:', boomB],
    ]);
  });

  it('不给日志器时监听器抛错也不让 emit 被拒', async () => {
    const { bus, on } = world();
    on('e', () => {
      throw new Error('silent');
    });
    await expect(bus.emit('e')).resolves.toBeUndefined();
  });

  it('日志器自己抛错不向外传，后面的监听器照常执行', async () => {
    const { bus, on } = world({
      warn: () => {
        throw new Error('logger-boom');
      },
    });
    const later = vi.fn();
    on('e', () => {
      throw new Error('inner');
    });
    on('e', later);
    await expect(bus.emit('e')).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe('一次派发只送达它开始时已登记的', () => {
  it('监听器处理时退订自己再重新登记：一次 emit 只送达一次', async () => {
    const { bus, on } = world();
    let calls = 0;
    on('e', () => {});
    const arm = () => {
      const off = on('e', () => {
        off();
        if (++calls < CAP) arm();
      });
    };
    arm();
    await bus.emit('e');
    expect(calls).toBe(1);
    await bus.emit('e');
    expect(calls).toBe(2);
  });

  it('派发途中被前一个监听器退订的：这一次不再收到', async () => {
    const { bus, on } = world();
    const got: string[] = [];
    let offLater = () => {};
    on('e', () => {
      got.push('first');
      offLater();
    });
    offLater = on('e', () => void got.push('later'));
    await bus.emit('e');
    expect(got).toEqual(['first']);
  });

  it('外层派发途中登记、随后嵌套再发一次：登记的监听器只经嵌套那次收到', async () => {
    const { bus, on } = world();
    let registered = false;
    let calls = 0;
    on('e', async () => {
      if (registered) return;
      registered = true;
      on('e', () => void calls++);
      await bus.emit('e');
    });
    await bus.emit('e');
    await tick();
    expect(calls).toBe(1);
  });

  it('派发途中事件的监听器被全部退订、又有人重新登记：这一次不送达新登记的', async () => {
    const { bus, on } = world();
    const fresh = vi.fn();
    let offSecond = () => {};
    const offFirst = on('e', () => {
      offFirst();
      offSecond();
      on('e', fresh);
    });
    offSecond = on('e', () => {});
    await bus.emit('e');
    expect(fresh).not.toHaveBeenCalled();
    await bus.emit('e');
    expect(fresh).toHaveBeenCalledTimes(1);
  });
});
