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

describe('Context.getService 即取即用语义（裸实例）', () => {
  interface FooService {
    hello(): string;
    label: string;
  }

  it('返回当时点的裸实例：拿到后切偏好不会跟随', () => {
    const ctx = makeContext();
    const a: FooService = { hello: () => 'A', label: 'a' };
    const b: FooService = { hello: () => 'B', label: 'b' };
    ctx.fork('plugin-a').provide('__foo', a);
    ctx.fork('plugin-b').provide('__foo', b);

    const handle1 = ctx.getService<FooService>('__foo')!;
    expect(handle1.hello()).toBe('A'); // 默认按注册顺序

    ctx.preferService('__foo', 'plugin-b');
    // 旧句柄仍指向 a
    expect(handle1.hello()).toBe('A');
    // 跟随切换需重新拉取
    const handle2 = ctx.getService<FooService>('__foo')!;
    expect(handle2.hello()).toBe('B');
    expect(handle2.label).toBe('b');
  });

  it('无 provider 时返回 undefined（保留 null-check 语义）', () => {
    const ctx = makeContext();
    expect(ctx.getService('__nonexistent')).toBeUndefined();
  });

  it('provider 全部注销后再次 getService 返回 undefined（旧句柄仍可用，不抛错）', () => {
    const ctx = makeContext();
    const a: FooService = { hello: () => 'A', label: 'a' };
    const disp = ctx.provide('__foo2', a);
    const handle = ctx.getService<FooService>('__foo2')!;
    expect(handle.hello()).toBe('A');
    disp();
    // 旧句柄仍可用（裸实例引用），调用方需要自己感知
    expect(handle.hello()).toBe('A');
    // 重新拉取得到 undefined
    expect(ctx.getService('__foo2')).toBeUndefined();
  });

  it('this 绑定正确：方法调用时 this 指向取出时点的 provider 实例', () => {
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
    // 旧句柄仍引用 c1
    expect(h.inc()).toBe(3);
    // 新句柄从 c2 开始
    const h2 = ctx.getService<Counter>('__cnt')!;
    expect(h2.inc()).toBe(1);
  });

  it('能力过滤参数仅在调用时点解析', () => {
    const ctx = makeContext();
    ctx.provide('__svc', { kind: 'plain' }, { capabilities: [] });
    ctx.provide('__svc', { kind: 'fancy' }, { capabilities: ['advanced'] });
    const h = ctx.getService<{ kind: string }>('__svc', ['advanced'])!;
    expect(h.kind).toBe('fancy');
  });
});

describe('Context.getServiceByContextId（per-entry 精确寻址）', () => {
  it('多 entry 同名服务可按 contextId 精确拿到指定实例', () => {
    const ctx = makeContext();
    // 模拟 per-model LLM entry：同名 'llm'，不同 contextId
    ctx.fork('@aalis/plugin-openai:main/gpt-4o').provide('llm', { provider: 'openai', model: 'gpt-4o' });
    ctx.fork('@aalis/plugin-openai:main/o1').provide('llm', { provider: 'openai', model: 'o1' });
    ctx.fork('@aalis/plugin-deepseek:main/v3').provide('llm', { provider: 'deepseek', model: 'v3' });

    // 会话里持久化的 modelContextId 可直接拿到对应实例
    const llmA = ctx.getServiceByContextId<{ model: string }>('llm', '@aalis/plugin-openai:main/o1');
    expect(llmA?.model).toBe('o1');

    const llmB = ctx.getServiceByContextId<{ model: string }>('llm', '@aalis/plugin-deepseek:main/v3');
    expect(llmB?.model).toBe('v3');
  });

  it('未匹配的 contextId 返回 undefined（不 fallback 到默认）', () => {
    const ctx = makeContext();
    ctx.provide('llm', { v: 1 });
    const llm = ctx.getServiceByContextId('llm', 'no-such-context');
    expect(llm).toBeUndefined();
  });

  it('不污染全局偏好：调用后 getService 仍走默认路由', () => {
    const ctx = makeContext();
    ctx.fork('p1').provide('llm', { tag: 'A' }, { priority: 10 });
    ctx.fork('p2').provide('llm', { tag: 'B' }, { priority: 5 });

    // 精确拿低优先级实例
    const exact = ctx.getServiceByContextId<{ tag: string }>('llm', 'p2');
    expect(exact?.tag).toBe('B');

    // getService 仍按优先级返回 A（未被污染）
    const def = ctx.getService<{ tag: string }>('llm');
    expect(def?.tag).toBe('A');

    // 也没设置偏好
    expect(ctx.getPreferredService('llm')).toBeUndefined();
  });
});
