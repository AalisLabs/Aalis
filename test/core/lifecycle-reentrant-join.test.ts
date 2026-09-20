import { describe, expect, it } from 'vitest';
import { Context } from '../../packages/core/src/context/context.js';
import {
  ConfigManager,
  ContributionRegistry,
  DefaultLogger,
  EventBus,
  HookRegistry,
  ServiceContainer,
} from '../../packages/core/src/index.js';

describe('同步重入的异步关闭观察者', () => {
  it('清理回调仅观察关闭完成时，重入调用也等待剩余异步清理', async () => {
    const ctx = new Context({
      id: 'reentrant-close',
      events: new EventBus(),
      services: new ServiceContainer(),
      hooks: new HookRegistry(),
      contributions: new ContributionRegistry(),
      logger: new DefaultLogger('test'),
      config: new ConfigManager({ name: 'test', logLevel: 'error', plugins: {} }),
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const trace: string[] = [];
    let observed = false;
    let completed = false;
    let observer: Promise<void> | undefined;

    ctx.onDispose(async () => {
      trace.push('cleanup:start');
      await gate;
      trace.push('cleanup:end');
    });
    ctx.onDispose(() => {
      // 只登记完成观察者，不返回或 await 此 Promise，避免清理等待自身。
      observer = ctx.disposeAsync().then(() => {
        observed = true;
        trace.push('observer:done');
      });
    });

    const closing = ctx.disposeAsync().then(() => {
      completed = true;
    });
    try {
      // 原生 Promise 的微任务全部跑过后，gate 仍关闭；不使用假 Promise 或计时器。
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observer).toBeInstanceOf(Promise);
      expect([...trace]).toEqual(['cleanup:start']);
      expect(observed).toBe(false);
      expect(completed).toBe(false);
    } finally {
      release();
      await closing;
      await observer;
    }
    expect(trace).toEqual(['cleanup:start', 'cleanup:end', 'observer:done']);
    expect(observed).toBe(true);
    expect(completed).toBe(true);
  });
});
