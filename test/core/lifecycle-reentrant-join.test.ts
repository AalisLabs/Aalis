import { describe, expect, it } from 'vitest';
import { createActivationFixture } from '../helpers/activation.js';

describe('同步重入的异步关闭观察者', () => {
  it('清理回调仅观察关闭完成时，重入调用也等待剩余异步清理', async () => {
    const { activation } = createActivationFixture({ id: 'reentrant-close' });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const trace: string[] = [];
    let observed = false;
    let completed = false;
    let observer: Promise<void> | undefined;

    activation.resources.onDispose(async () => {
      trace.push('cleanup:start');
      await gate;
      trace.push('cleanup:end');
    });
    activation.resources.onDispose(() => {
      // 只登记完成观察者，不返回或 await 此 Promise，避免清理等待自身。
      observer = activation.disposeAsync().then(() => {
        observed = true;
        trace.push('observer:done');
      });
    });

    const closing = activation.disposeAsync().then(() => {
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
