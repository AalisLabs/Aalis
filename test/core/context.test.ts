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
  const config = new ConfigManager({ name: 'T', logLevel: 'error', plugins: {} });
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

describe('Context.getService 动态句柄（Proxy）', () => {
  interface FooService {
    hello(): string;
    label: string;
  }

  it('在 provider 切换偏好后，长期持有的句柄自动跟随新 provider', () => {
    const ctx = makeContext();
    const a: FooService = { hello: () => 'A', label: 'a' };
    const b: FooService = { hello: () => 'B', label: 'b' };
    ctx.fork('plugin-a').provide('__foo', a);
    ctx.fork('plugin-b').provide('__foo', b);

    const handle = ctx.getService<FooService>('__foo')!;
    expect(handle.hello()).toBe('A'); // 默认按注册顺序

    ctx.preferService('__foo', 'plugin-b');
    // 同一个 handle 引用，无需重新 getService
    expect(handle.hello()).toBe('B');
    expect(handle.label).toBe('b');

    ctx.preferService('__foo', 'plugin-a');
    expect(handle.hello()).toBe('A');
  });

  it('无 provider 时返回 undefined（保留 null-check 语义）', () => {
    const ctx = makeContext();
    expect(ctx.getService('__nonexistent')).toBeUndefined();
  });

  it('持有句柄期间所有 provider 被注销，访问属性抛错', () => {
    const ctx = makeContext();
    const a: FooService = { hello: () => 'A', label: 'a' };
    const disp = ctx.provide('__foo2', a);
    const handle = ctx.getService<FooService>('__foo2')!;
    expect(handle.hello()).toBe('A');
    disp();
    expect(() => handle.hello()).toThrow(/不再可用/);
  });

  it('this 绑定正确：方法调用时 this 指向当前 provider 实例', () => {
    const ctx = makeContext();
    class Counter {
      private n = 0;
      inc(): number {
        this.n += 1;
        return this.n;
      }
    }
    const c1 = new Counter();
    const c2 = new Counter();
    ctx.fork('one').provide('__cnt', c1);
    ctx.fork('two').provide('__cnt', c2);

    const h = ctx.getService<Counter>('__cnt')!;
    expect(h.inc()).toBe(1);
    expect(h.inc()).toBe(2); // 仍在 c1 上累加

    ctx.preferService('__cnt', 'two');
    expect(h.inc()).toBe(1); // 切到 c2，从 0 开始
  });

  it('能力过滤参数被句柄持续保留', () => {
    const ctx = makeContext();
    ctx.provide('__svc', { kind: 'plain' }, { capabilities: [] });
    ctx.provide('__svc', { kind: 'fancy' }, { capabilities: ['advanced'] });
    const h = ctx.getService<{ kind: string }>('__svc', ['advanced'])!;
    expect(h.kind).toBe('fancy');
  });
});
