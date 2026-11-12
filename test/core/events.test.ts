import { describe, expect, it, vi } from 'vitest';
import { events, type Logger } from '../../packages/core/src/index.js';
import { EventBus } from '../../packages/core/src/primitives/events.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

describe('EventBus', () => {
  it('on/emit 按注册顺序串行调用', async () => {
    const bus = new EventBus();
    const order: number[] = [];
    bus.on('zz:named', () => {
      order.push(1);
    });
    bus.on('zz:named', async () => {
      await Promise.resolve();
      order.push(2);
    });
    bus.on('zz:named', () => {
      order.push(3);
    });
    await bus.emit('zz:named', 'p');
    expect(order).toEqual([1, 2, 3]);
  });

  it('dispose 函数移除监听器', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('zz:named', fn);
    off();
    await bus.emit('zz:named', 'p');
    expect(fn).not.toHaveBeenCalled();
  });

  it('emit 无监听器时安全 noop', async () => {
    const bus = new EventBus();
    await expect(bus.emit('zz:named', 'x')).resolves.toBeUndefined();
  });
});

describe('EventBus per-handler 隔离', () => {
  it('单个 handler 抛错不中断其余 handler，emit 不 reject，错误经 onHandlerError 上报', async () => {
    const reported: Array<[string, unknown]> = [];
    const bus = new EventBus({ onHandlerError: (event, err) => reported.push([event, err]) });

    const order: string[] = [];
    bus.on('zz:named', () => {
      order.push('a');
      throw new Error('boom-a');
    });
    bus.on('zz:named', async () => {
      order.push('b');
      return Promise.reject(new Error('boom-b'));
    });
    bus.on('zz:named', () => {
      order.push('c');
    });

    await expect(bus.emit('zz:named', 'p')).resolves.toBeUndefined();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(reported.map(([e]) => e)).toEqual(['zz:named', 'zz:named']);
    expect((reported[0][1] as Error).message).toBe('boom-a');
    expect((reported[1][1] as Error).message).toBe('boom-b');
  });

  it('经 events 能力注册的监听器抛错，上报的注册者身份就是 ctx.id', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args) => void warnings.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const app = createInspectableApp({ name: 'T', logLevel: 'error', logger });
    const host = activationHost(app);
    const child = host.create('plugin-x');
    host.bind(child, { events }).events.use.on('zz:named', () => {
      throw new Error('x');
    });
    await app.bind({ events }).events.use.emit('zz:named', 'p');
    expect(warnings.filter(w => w.includes('来自 plugin-x'))).toHaveLength(1);
    await app.stop();
  });

  it('onHandlerError 点名注册者：经门面注册的报 ctx.id，无 owner 的裸登记报 undefined', async () => {
    const who: Array<string | undefined> = [];
    const bus = new EventBus({ onHandlerError: (_event, _err, contextId) => who.push(contextId) });
    bus.on(
      'zz:named',
      () => {
        throw new Error('x');
      },
      Symbol('plugin-a'),
    );
    bus.on('zz:named', () => {
      throw new Error('y');
    });
    await bus.emit('zz:named', 'p');
    expect(who).toEqual(['plugin-a', undefined]);
  });

  it('未设置 onHandlerError 时 handler 抛错也不致 emit reject', async () => {
    const bus = new EventBus();
    bus.on('zz:named', () => {
      throw new Error('silent');
    });
    await expect(bus.emit('zz:named', 'p')).resolves.toBeUndefined();
  });

  it('onHandlerError 自身抛错不向外传播', async () => {
    const bus = new EventBus({
      onHandlerError: () => {
        throw new Error('reporter-boom');
      },
    });
    bus.on('zz:named', () => {
      throw new Error('inner');
    });
    await expect(bus.emit('zz:named', 'p')).resolves.toBeUndefined();
  });
});

describe('EventBus 登记身份', () => {
  it('同一 handler 登记两次：触发两次，各自退订互不影响', async () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off1 = bus.on('zz:named', fn);
    bus.on('zz:named', fn);
    await bus.emit('zz:named', 'p');
    expect(fn).toHaveBeenCalledTimes(2);
    off1();
    await bus.emit('zz:named', 'p');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
