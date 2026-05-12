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
