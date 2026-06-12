import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../packages/core/src/index.js';

describe('EventBus', () => {
  it('on/emit 按注册顺序串行调用', async () => {
    const bus = new EventBus();
    const order: number[] = [];
    bus.on('plugin:loaded', () => {
      order.push(1);
    });
    bus.on('plugin:loaded', async () => {
      await Promise.resolve();
      order.push(2);
    });
    bus.on('plugin:loaded', () => {
      order.push(3);
    });
    await bus.emit('plugin:loaded', 'p');
    expect(order).toEqual([1, 2, 3]);
  });

  it('dispose 函数移除监听器', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('plugin:loaded', fn);
    off();
    await bus.emit('plugin:loaded', 'p');
    expect(fn).not.toHaveBeenCalled();
  });

  it('once 仅触发一次', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.once('plugin:loaded', fn);
    await bus.emit('plugin:loaded', 'a');
    await bus.emit('plugin:loaded', 'b');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('removeAll 清空指定/所有事件', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('plugin:loaded', fn);
    bus.on('plugin:unloaded', fn);
    bus.removeAll('plugin:loaded');
    await bus.emit('plugin:loaded', 'a');
    await bus.emit('plugin:unloaded', 'b');
    expect(fn).toHaveBeenCalledTimes(1);

    bus.removeAll();
    await bus.emit('plugin:unloaded', 'c');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emit 无监听器时安全 noop', async () => {
    const bus = new EventBus();
    await expect(bus.emit('plugin:loaded', 'x')).resolves.toBeUndefined();
  });
});

describe('EventBus per-handler 隔离（#8.1）', () => {
  it('单个 handler 抛错不中断其余 handler，emit 不 reject，错误经 onHandlerError 上报', async () => {
    const bus = new EventBus();
    const reported: Array<[string, unknown]> = [];
    bus.onHandlerError = (event, err) => reported.push([event, err]);

    const order: string[] = [];
    bus.on('plugin:loaded', () => {
      order.push('a');
      throw new Error('boom-a');
    });
    bus.on('plugin:loaded', async () => {
      order.push('b');
      return Promise.reject(new Error('boom-b'));
    });
    bus.on('plugin:loaded', () => {
      order.push('c');
    });

    await expect(bus.emit('plugin:loaded', 'p')).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(reported.map(([e]) => e)).toEqual(['plugin:loaded', 'plugin:loaded']);
    expect((reported[0][1] as Error).message).toBe('boom-a');
    expect((reported[1][1] as Error).message).toBe('boom-b');
  });

  it('未设置 onHandlerError 时 handler 抛错也不致 emit reject', async () => {
    const bus = new EventBus();
    bus.on('plugin:loaded', () => {
      throw new Error('silent');
    });
    await expect(bus.emit('plugin:loaded', 'p')).resolves.toBeUndefined();
  });

  it('onHandlerError 自身抛错不向外传播', async () => {
    const bus = new EventBus();
    bus.onHandlerError = () => {
      throw new Error('reporter-boom');
    };
    bus.on('plugin:loaded', () => {
      throw new Error('inner');
    });
    await expect(bus.emit('plugin:loaded', 'p')).resolves.toBeUndefined();
  });
});

describe('EventBus sticky 补发护栏（#8.2）', () => {
  it('sticky 补发时 handler 同步抛错被捕获并上报（不直达 uncaughtException）', async () => {
    const bus = new EventBus();
    const reported: string[] = [];
    bus.onHandlerError = event => reported.push(event);

    bus.markSticky('ready');
    await bus.emit('ready');

    bus.on('ready', () => {
      throw new Error('sync-boom');
    });
    // 补发在微任务里执行
    await new Promise(r => setTimeout(r, 0));
    expect(reported).toEqual(['ready']);
  });

  it('sticky 补发时 handler 异步抛错同样被捕获（不变 unhandledRejection）', async () => {
    const bus = new EventBus();
    const reported: string[] = [];
    bus.onHandlerError = event => reported.push(event);

    bus.markSticky('ready');
    await bus.emit('ready');

    bus.on('ready', async () => {
      throw new Error('async-boom');
    });
    await new Promise(r => setTimeout(r, 0));
    expect(reported).toEqual(['ready']);
  });

  it('clearSticky() 无参清空全部 sticky 缓存（#8.6 app:started 残留）', async () => {
    const bus = new EventBus();
    bus.markSticky('ready');
    bus.markSticky('app:started');
    await bus.emit('ready');
    await bus.emit('app:started');

    bus.clearSticky();

    const fired: string[] = [];
    bus.on('ready', () => {
      fired.push('ready');
    });
    bus.on('app:started', () => {
      fired.push('app:started');
    });
    await new Promise(r => setTimeout(r, 0));
    expect(fired).toEqual([]);
  });
});
