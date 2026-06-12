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

  it('provider 下线时自动调用上次 cb 返回的 cleanup', async () => {
    const ctx = makeContext();
    const cleaned: string[] = [];
    const disposeSvc = ctx.provide('__hub', { mark: 'a' });
    ctx.whenService<{ mark: string }>('__hub', svc => {
      return () => cleaned.push(`cleanup-${svc.mark}`);
    });
    await Promise.resolve();
    expect(cleaned).toEqual([]);
    disposeSvc();
    await Promise.resolve();
    expect(cleaned).toEqual(['cleanup-a']);
  });

  it('provider 重新 provide 触发重挂：旧 cleanup 先调，新 cb 再触发', async () => {
    const ctx = makeContext();
    const attached: string[] = [];
    const cleaned: string[] = [];
    ctx.whenService<{ id: string }>('__hub', svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });

    const dispose1 = ctx.provide('__hub', { id: 'v1' });
    await Promise.resolve();
    expect(attached).toEqual(['v1']);
    expect(cleaned).toEqual([]);

    dispose1();
    await Promise.resolve();
    expect(cleaned).toEqual(['v1']);

    ctx.provide('__hub', { id: 'v2' });
    await Promise.resolve();
    expect(attached).toEqual(['v1', 'v2']);
    expect(cleaned).toEqual(['v1']);
  });

  it('手动 dispose 后 provider 上下线不再触发 cb', async () => {
    const ctx = makeContext();
    let callCount = 0;
    const off = ctx.whenService<{ v: number }>('__hub', _svc => {
      callCount++;
      return undefined;
    });
    off();
    ctx.provide('__hub', { v: 1 });
    await Promise.resolve();
    expect(callCount).toBe(0);
  });

  it('ctx.dispose 触发上次 cleanup', async () => {
    const ctx = makeContext();
    let cleaned = false;
    ctx.provide('__hub', { v: 1 });
    ctx.whenService<{ v: number }>('__hub', _svc => () => {
      cleaned = true;
    });
    await Promise.resolve();
    await ctx.dispose();
    expect(cleaned).toBe(true);
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

describe('Context.whenService 多 provider（#8.3）', () => {
  it('败者 entry 注销不打扰胜者挂载；胜者注销后自动重挂到次优', async () => {
    const ctx = makeContext();
    const attached: string[] = [];
    const cleaned: string[] = [];

    const winner = { id: 'winner' };
    const loser = { id: 'loser' };
    const disposeWinner = ctx.provide('__hub', winner, { priority: 50 });
    const disposeLoser = ctx.provide('__hub', loser, { priority: 0, entryId: 'root/loser' });

    ctx.whenService<{ id: string }>('__hub', svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });
    await Promise.resolve();
    expect(attached).toEqual(['winner']);

    // 败者下线：胜者不变 → 不 cleanup、不重挂（旧实现会无条件 cleanup 导致永久脱挂）
    disposeLoser();
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual([]);
    expect(attached).toEqual(['winner']);

    // 重新补一个次优，再撤胜者：应 cleanup 旧挂载并重挂到次优
    ctx.provide('__hub', loser, { priority: 0, entryId: 'root/loser' });
    await new Promise(r => setTimeout(r, 0));
    expect(attached).toEqual(['winner']); // 新败者上线同样不打扰

    // 撤掉胜者 entry（provide 的 dispose 自带 service:unregistered 通知）
    disposeWinner();
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual(['winner']);
    expect(attached).toEqual(['winner', 'loser']);
  });

  it('preferService 切偏好触发重挂（service:preference-changed）', async () => {
    const ctx = makeContext();
    const attached: string[] = [];
    const cleaned: string[] = [];

    ctx.provide('__llm', { id: 'default' }, { priority: 50 });
    const child = ctx.fork('plugin-alt');
    child.provide('__llm', { id: 'alt' }, { priority: 0 });

    ctx.whenService<{ id: string }>('__llm', svc => {
      attached.push(svc.id);
      return () => cleaned.push(svc.id);
    });
    await Promise.resolve();
    expect(attached).toEqual(['default']);

    ctx.preferService('__llm', 'plugin-alt');
    await new Promise(r => setTimeout(r, 0));
    expect(cleaned).toEqual(['default']);
    expect(attached).toEqual(['default', 'alt']);

    ctx.unpreferService('__llm');
    await new Promise(r => setTimeout(r, 0));
    expect(attached).toEqual(['default', 'alt', 'default']);
  });

  it('新败者注册（service:registered 但胜者不变）不触发重挂', async () => {
    const ctx = makeContext();
    let calls = 0;
    ctx.provide('__hub', { id: 'top' }, { priority: 100 });
    ctx.whenService('__hub', () => {
      calls++;
      return undefined;
    });
    await Promise.resolve();
    expect(calls).toBe(1);

    ctx.provide('__hub', { id: 'low' }, { priority: 0, entryId: 'root/low' });
    await new Promise(r => setTimeout(r, 0));
    expect(calls).toBe(1);
  });
});

describe('Context.dispose 服务自清理协议（#8.6）', () => {
  it('unregisterByPlugin 通知同名服务的所有 entry（含败者），而非只通知胜者', async () => {
    const ctx = makeContext();
    const notified: string[] = [];
    const winner = {
      unregisterByPlugin: (id: string) => notified.push(`winner:${id}`),
    };
    const loser = {
      unregisterByPlugin: (id: string) => notified.push(`loser:${id}`),
    };
    ctx.provide('__hub', winner, { priority: 50 });
    ctx.provide('__hub', loser, { priority: 0, entryId: 'root/loser' });

    const child = ctx.fork('plugin-x');
    child.dispose();

    expect(notified).toContain('winner:plugin-x');
    expect(notified).toContain('loser:plugin-x');
  });
});
