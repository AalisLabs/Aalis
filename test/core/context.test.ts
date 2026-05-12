import { describe, expect, it } from 'vitest';
import {
  ConfigManager,
  Context,
  EventBus,
  HookRegistry,
  Logger,
  ServiceContainer,
} from '../../packages/core/src/index.js';

function makeContext(id = 'root'): Context {
  const events = new EventBus();
  const services = new ServiceContainer();
  const hooks = new HookRegistry();
  const logger = new Logger('test');
  const config = new ConfigManager();
  return new Context({ id, events, services, hooks, logger, config });
}

describe('Context.extend', () => {
  it('在 prototype 上注入方法，所有实例可调用', () => {
    const dispose = Context.extend('__testGreet', function (this: Context) {
      return `hi-${this.id}`;
    });
    try {
      const ctx = makeContext('a');
      // biome-ignore lint/suspicious/noExplicitAny: extension method
      expect((ctx as any).__testGreet()).toBe('hi-a');
    } finally {
      dispose();
    }
    // dispose 后方法被移除
    const ctx2 = makeContext('b');
    // biome-ignore lint/suspicious/noExplicitAny: extension method
    expect((ctx2 as any).__testGreet).toBeUndefined();
  });

  it('重名注入抛错，避免静默覆盖', () => {
    const dispose = Context.extend('__testDup', () => {});
    try {
      expect(() => Context.extend('__testDup', () => {})).toThrow(/已存在/);
    } finally {
      dispose();
    }
  });
});

describe('Context.provide / getService', () => {
  it('注册并取出服务', () => {
    const ctx = makeContext();
    const svc = { greet: () => 'hello' };
    ctx.provide('__greeter', svc);
    expect(ctx.getService<typeof svc>('__greeter')?.greet()).toBe('hello');
  });

  it('hasService 检查能力存在', () => {
    const ctx = makeContext();
    ctx.provide('__svc', { run: () => 1 });
    expect(ctx.hasService('__svc')).toBe(true);
    expect(ctx.hasService('__nonexistent')).toBe(false);
  });
});

describe('Context.whenService', () => {
  it('服务未就绪时延迟订阅，注册后立即触发回调', async () => {
    const ctx = makeContext();
    let received: unknown = null;
    ctx.whenService('__deferred', svc => {
      received = svc;
      return undefined;
    });
    expect(received).toBeNull();
    ctx.provide('__deferred', { mark: 1 });
    // whenService 内部用 microtask，等一拍
    await Promise.resolve();
    expect(received).toEqual({ mark: 1 });
  });

  it('服务已就绪时立即触发', async () => {
    const ctx = makeContext();
    ctx.provide('__ready', { v: 42 });
    let received: unknown = null;
    ctx.whenService('__ready', svc => {
      received = svc;
      return undefined;
    });
    await Promise.resolve();
    expect(received).toEqual({ v: 42 });
  });
});

describe('Context fork / dispose', () => {
  it('fork 共享服务容器但拥有独立 disposables', async () => {
    const ctx = makeContext();
    ctx.provide('__shared', { v: 1 });
    const child = ctx.fork('child');
    expect(child.getService('__shared')).toEqual({ v: 1 });
    await child.dispose();
    // fork 后 dispose 不会清父级服务
    expect(ctx.getService('__shared')).toEqual({ v: 1 });
  });
});

describe('Context createScope (sandbox)', () => {
  it('沙盒内 provide 不污染父级', () => {
    const ctx = makeContext();
    ctx.provide('__outer', { v: 'parent' });
    const sandbox = ctx.createScope('sandbox');
    sandbox.provide('__outer', { v: 'sandbox' });
    expect(sandbox.getService('__outer')).toEqual({ v: 'sandbox' });
    expect(ctx.getService('__outer')).toEqual({ v: 'parent' });
  });

  it('沙盒能 fallback 读取父级服务', () => {
    const ctx = makeContext();
    ctx.provide('__inherited', { v: 1 });
    const sandbox = ctx.createScope('sandbox');
    expect(sandbox.getService('__inherited')).toEqual({ v: 1 });
  });
});
