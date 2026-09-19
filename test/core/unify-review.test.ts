import { afterEach, describe, expect, it } from 'vitest';
import { assemble, createPort } from '../../packages/core/src/context/binding.js';
import { App, definePlugin, defineService, type Logger, lifecycle, provide } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 独立评审（REVIEW-eebaf214）复现出的反例，逐条钉住修正后的契约。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Item {
  name: string;
  fail?: boolean;
}
interface Hub {
  register(item: Item): () => unknown;
  list(): string[];
}
function makeHub(wait?: Promise<void>): Hub {
  const entries = new Set<Item>();
  return {
    register(item) {
      if (item.fail) throw new Error('registration rejected');
      const entry = { ...item };
      entries.add(entry);
      return () => (wait ? wait.then(() => void entries.delete(entry)) : void entries.delete(entry));
    },
    list: () => [...entries].map(e => e.name).sort(),
  };
}
const hub = defineService<Hub, { register(item: Item): () => void }>('zz-review-hub', port => {
  const book = port.registrar<Item>({ key: item => item.name, register: (provider, item) => provider.register(item) });
  return { register: item => book.add(item) };
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} }, logger });
  apps.push(app);
  return { app, host: { provide: app.bind({ provide }).provide } };
}

describe('评审 1：异步撤回时的提供者切换', () => {
  it('不等旧撤回落地就在新胜者上登记（旧提供者已不是胜者）；关闭等到全部在飞撤回', async () => {
    const { app, host } = world();
    const gate = deferred();
    const a = makeHub(gate.promise);
    const b = makeHub();
    host.provide(hub, a, { priority: 1, entryId: 'root/a' });
    const ctx = app.ctx.fork('consumer');
    assemble(ctx, { hub }).hub.register({ name: 'tool' });
    host.provide(hub, b, { priority: 2, entryId: 'root/b' });
    await sleep(0);
    expect(b.list(), '新胜者上立即可用，不出现空窗').toEqual(['tool']);
    expect(a.list(), '旧撤回在飞：旧提供者上暂留，但它已不经容器解析可见').toEqual(['tool']);
    let closed = false;
    const closing = ctx.disposeAsync().then(() => {
      closed = true;
    });
    await sleep(10);
    expect(closed, '关闭等在飞的旧撤回').toBe(false);
    gate.resolve();
    await closing;
    expect(a.list()).toEqual([]);
    expect(b.list()).toEqual([]);
  });
});

describe('评审 2：同键替换失败', () => {
  it('替换失败 = 该键完整撤销并抛给调用方；之后换提供者不复活旧登记', async () => {
    const { app, host } = world();
    const a = makeHub();
    const b = makeHub();
    host.provide(hub, a, { priority: 1, entryId: 'root/a' });
    const ctx = app.ctx.fork('consumer');
    const bound = assemble(ctx, { hub }).hub;
    bound.register({ name: 'tool' });
    expect(() => bound.register({ name: 'tool', fail: true })).toThrow('registration rejected');
    expect(a.list()).toEqual([]);
    host.provide(hub, b, { priority: 2, entryId: 'root/b' });
    await sleep(0);
    expect(b.list(), '账上不留旧条目').toEqual([]);
  });
});

describe('评审 3：port.track 与 registrar 同一清理契约', () => {
  it('手动退订启动的异步清理被随后的关闭等到；重复退订只执行一次', async () => {
    const { app } = world();
    const ctx = app.ctx.fork('p');
    const port = createPort<unknown>(ctx, 'zz-any');
    const gate = deferred();
    let calls = 0;
    let finished = false;
    const off = port.track(() => {
      calls++;
      return gate.promise.then(() => {
        finished = true;
      });
    });
    off();
    off();
    expect(calls).toBe(1);
    let closed = false;
    const closing = ctx.disposeAsync().then(() => {
      closed = true;
    });
    await sleep(10);
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(finished).toBe(true);
  });

  it('手动退订的异步清理拒绝：被接住，不逃逸', async () => {
    const { app } = world();
    const ctx = app.ctx.fork('p');
    const port = createPort<unknown>(ctx, 'zz-any');
    const escaped: unknown[] = [];
    const onEscape = (err: unknown) => escaped.push(err);
    process.on('unhandledRejection', onEscape);
    try {
      port.track(() => Promise.reject(new Error('boom')))();
      await ctx.disposeAsync();
      await sleep(10);
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped).toEqual([]);
  });
});

describe('评审 5：子模块的 required 声明', () => {
  it('挂载时缺 required 即拒绝，apply 不执行；父插件不受影响', async () => {
    const { app } = world();
    let childRan = false;
    const child = definePlugin({
      name: 'child',
      uses: { hub },
      apply() {
        childRan = true;
      },
    });
    let mountError: unknown;
    await app.plugin(
      definePlugin({
        name: 'parent',
        uses: { lifecycle },
        async apply({ lifecycle }) {
          await lifecycle.module(child).catch(err => {
            mountError = err;
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(childRan).toBe(false);
    expect(String(mountError)).toContain('zz-review-hub');
    expect(app.plugins.getStatus().find(s => s.instanceId === 'parent')?.state).toBe('active');
  });
});

describe('评审 4：调用型服务的有状态消费者——follow 取代整插件重启', () => {
  interface Sdk {
    tag: string;
    closed: boolean;
  }
  const sdk = defineService<Sdk>('zz-sdk');

  it('提供者换人：只重建跟随的那一块（先清理旧的、再用新实例建），插件不重启；关闭时清理并等异步', async () => {
    const { app, host } = world();
    const a: Sdk = { tag: 'a', closed: false };
    const b: Sdk = { tag: 'b', closed: false };
    const offA = host.provide(sdk, a, { priority: 1, entryId: 'root/a' });
    const log: string[] = [];
    let applied = 0;
    let cached!: Sdk;
    const gate = deferred();
    await app.plugin(
      definePlugin({
        name: 'stateful',
        uses: { sdk },
        apply({ sdk }) {
          applied++;
          cached = sdk.require(); // 反面教材：缓存裸提供者，换人后就是失效引用——契约如此，由调用方负责
          sdk.follow(provider => {
            log.push(`open:${provider.tag}`);
            return () => {
              log.push(`close:${provider.tag}`);
              return provider.tag === 'b' ? gate.promise : undefined;
            };
          });
        },
      }),
    );
    await app.plugins.idle();
    host.provide(sdk, b, { priority: 2, entryId: 'root/b' });
    await sleep(0);
    offA();
    a.closed = true;
    await sleep(0);
    expect(log).toEqual(['open:a', 'close:a', 'open:b']);
    expect(applied, '换人不重启插件').toBe(1);
    expect(cached.closed, '缓存的裸引用已失效；重新 require() 才是当前值').toBe(true);

    let unloaded = false;
    const unloading = app.plugins.unload('stateful').then(() => {
      unloaded = true;
    });
    await sleep(10);
    expect(log.at(-1)).toBe('close:b');
    expect(unloaded, '关闭等跟随块的异步清理').toBe(false);
    gate.resolve();
    await unloading;
  });
});
