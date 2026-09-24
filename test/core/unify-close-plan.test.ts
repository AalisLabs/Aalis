import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { BindingPort } from '../../packages/core/src/index.js';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  optional,
  provide,
} from '../../packages/core/src/index.js';
import { activationHost, createInspectableApp, rootActivation } from '../helpers/inspectable-app.js';

// ════════════════════════════════════════════════════════════
// 关停编排与重入清理的契约测试。来源：第二轮独立复核（REVIEW-fcac1dc0）的全部反例，
// 加上各关闭入口的覆盖。断言的是数据确实交接、资源确实撤销、异步确实等到，不只是调用次序。
// ════════════════════════════════════════════════════════════

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const tick = () => new Promise<void>(r => setImmediate(r));
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Store {
  save(data: string): void;
}
const storage = defineService<Store>('zz-cp-storage');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world() {
  const log: string[] = [];
  const saved: string[] = [];
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    child: () => logger,
  };
  const app = createInspectableApp({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  return { app, log, saved, warnings, host: app.bind({ provide }).provide };
}
type World = ReturnType<typeof world>;

/** 一个提供 storage 的定义：关闭后 save 抛错，用来证明「调用时它还活着」 */
const storageDef = (w: World, name = 'storage', options?: { entryId?: string; priority?: number }) =>
  definePlugin({
    name,
    uses: { provide, lifecycle },
    provides: [storage],
    apply({ provide, lifecycle }) {
      let closed = false;
      provide(
        storage,
        {
          save(data) {
            if (closed) throw new Error(`${name} 已关闭`);
            w.saved.push(`${name}:${data}`);
          },
        },
        options,
      );
      lifecycle.onDispose(() => {
        closed = true;
        w.log.push(`close:${name}`);
      });
    },
  });

describe('关停编排：归属树与服务依赖共同决定顺序', () => {
  it('根激活用插件的服务：根的收尾先于该插件关闭；到根的清理段它已关（成文的限制）', async () => {
    const w = world();
    let inDispose: string | undefined;
    const root = w.app.bind({ storage: optional(storage), lifecycle });
    await w.app.plugin(storageDef(w));
    root.lifecycle.onDrain(() => root.storage.require().save('root:last'));
    root.lifecycle.onDispose(() => {
      inDispose = root.storage.current === undefined ? 'gone' : 'alive';
    });
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.saved).toEqual(['storage:root:last']);
    expect(inDispose, '根的清理段不能再用插件的服务').toBe('gone');
  });

  it('插件用根提供的服务：插件先收尾关闭（把数据交给根），根随后收尾', async () => {
    const w = world();
    const sink = defineService<{ push(data: string): void }>('zz-cp-sink');
    await w.app.plugin(storageDef(w));
    const root = w.app.bind({ storage, provide, lifecycle });
    const buffer: string[] = [];
    root.provide(sink, { push: data => void buffer.push(data) });
    root.lifecycle.onDrain(() => {
      for (const data of buffer.splice(0)) root.storage.require().save(data);
    });
    await w.app.plugin(
      definePlugin({
        name: 'session',
        uses: { sink, lifecycle },
        apply({ sink, lifecycle }) {
          lifecycle.onDrain(() => sink.require().push('session-state'));
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.saved, '插件的最后状态经根落到了下层').toEqual(['storage:session-state']);
  });

  it('换过提供者：已落定的旧绑定不留边，不造假环', async () => {
    const w = world();
    const sink = defineService<{ push(data: string): void }>('zz-cp-sink2');
    // old 既提供 storage，又用 consumer 的服务；consumer 先跟随 old 再换到 new：有效依赖 old → consumer → new，无环
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { storage: optional(storage), provide, lifecycle },
        apply({ storage, provide, lifecycle }) {
          provide(sink, { push() {} });
          storage.follow(() => () => {});
          lifecycle.onDrain(() => storage.require().save('last'));
          lifecycle.onDispose(() => void w.log.push('close:consumer'));
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'old',
        uses: { sink, provide, lifecycle },
        apply({ sink, provide, lifecycle }) {
          provide(storage, { save: data => void w.saved.push(`old:${data}`) }, { priority: 1 });
          lifecycle.onDrain(() => sink.require().push('bye'));
          lifecycle.onDispose(() => void w.log.push('close:old'));
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.plugin(storageDef(w, 'new', { priority: 9 }));
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.warnings.filter(x => x.includes('依赖成环'))).toEqual([]);
    expect(w.log).toEqual(['close:old', 'close:consumer', 'close:new']);
    expect(w.saved).toEqual(['new:last']);
  });

  it('optional 依赖成环：环内让步不告警，环外的下层仍最后关', async () => {
    const w = world();
    const a = defineService<{ hit(): void }>('zz-cp-a');
    const b = defineService<{ hit(): void }>('zz-cp-b');
    await w.app.plugin(storageDef(w));
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { b: optional(b), storage, provide, lifecycle },
        apply({ storage, provide, lifecycle }) {
          provide(a, { hit() {} });
          lifecycle.onDrain(() => storage.require().save('consumer:last'));
        },
      }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'peer',
        uses: { a: optional(a), provide },
        apply: ({ provide }) => void provide(b, { hit() {} }),
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.warnings.filter(x => x.includes('成环'))).toEqual([]);
    expect(w.saved).toEqual(['storage:consumer:last']);
  });

  it('required 依赖成环只在环内降级：告警只点环内的，环外的下层仍最后关', async () => {
    const w = world();
    const a = defineService<{ hit(): void }>('zz-cp-ra');
    const b = defineService<{ hit(): void }>('zz-cp-rb');
    await w.app.plugin(storageDef(w));
    await w.app.plugin(
      definePlugin({ name: 'seed', uses: { provide }, apply: ({ provide }) => void provide(b, { hit() {} }) }),
    );
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { b, storage, provide, lifecycle },
        apply({ storage, provide, lifecycle }) {
          provide(a, { hit() {} });
          lifecycle.onDrain(() => storage.require().save('consumer:last'));
        },
      }),
    );
    // peer 要 consumer 的 a，又以更高优先级顶替了 consumer 所依赖的 b：两条边都是 required
    await w.app.plugin(
      definePlugin({
        name: 'peer',
        uses: { a, provide },
        apply: ({ provide }) => void provide(b, { hit() {} }, { priority: 10 }),
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    const cycle = w.warnings.filter(x => x.includes('required 依赖成环'));
    expect(cycle).toHaveLength(1);
    expect(cycle[0]).toContain('[peer, consumer]');
    expect(w.saved).toEqual(['storage:consumer:last']);
  });

  it('提供者归属按真实激活身份认，不从 entryId 字符串前缀猜', async () => {
    const w = world();
    await w.app.plugin(storageDef(w, 'provider', { entryId: 'provider/model' }));
    // 名字合法、恰与上面的 entryId 重合的另一个插件
    await w.app.plugin(definePlugin({ name: 'provider/model', apply() {} }));
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { storage, lifecycle },
        apply({ storage, lifecycle }) {
          lifecycle.onDrain(() => storage.require().save('last'));
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.stop();
    expect(w.saved).toEqual(['provider:last']);
  });

  it('顶层 optional、消费者先于提供者注册：onDispose 仍写得到提供者', async () => {
    const w = world();
    const store = defineService<Store>('zz-cp-unfav');
    const provider = definePlugin({
      name: 'prov',
      uses: { provide, lifecycle },
      provides: [store],
      apply({ provide, lifecycle }) {
        let closed = false;
        provide(store, {
          save(data) {
            if (closed) throw new Error('prov 已关闭');
            w.saved.push(data);
          },
        });
        lifecycle.onDispose(() => {
          closed = true;
          w.log.push('prov-close');
        });
      },
    });
    const consumer = definePlugin({
      name: 'cons',
      uses: { store: optional(store), lifecycle },
      apply({ store, lifecycle }) {
        lifecycle.onDrain(() => {
          store.require().save('cons:last');
          w.log.push('cons-drain');
        });
        lifecycle.onDispose(() => {
          store.require().save('cons-dispose');
          w.log.push('cons-close');
        });
      },
    });
    await w.app.plugin(consumer);
    await w.app.plugin(provider);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('cons')?.state).toBe('active');
    expect(w.app.plugins.getPlugin('prov')?.state).toBe('active');
    await w.app.stop();
    expect(w.saved, `log=${w.log.join('>')}`).toEqual(['cons:last', 'cons-dispose']);
    expect(w.log.indexOf('cons-close')).toBeLessThan(w.log.indexOf('prov-close'));
  });
});

describe('各关闭入口共用同一套编排', () => {
  it('单独卸载提供者：正在用它的消费者先收尾，收尾时提供者仍在；随后消费者转 pending', async () => {
    const w = world();
    let seenInDrain: string | undefined;
    await w.app.plugin(storageDef(w));
    await w.app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { storage, lifecycle },
        apply({ storage, lifecycle }) {
          lifecycle.onDrain(() => {
            seenInDrain = storage.current === undefined ? 'gone' : 'alive';
          });
        },
      }),
    );
    await w.app.plugins.idle();
    await w.app.plugins.unload('storage');
    await w.app.plugins.idle();
    expect(w.app.plugins.getStatus().find(s => s.instanceId === 'consumer')?.state).toBe('pending');
    expect(seenInDrain, '管理动作与整机停机同一套交接保证').toBe('alive');
  });
});

describe('重入清理', () => {
  it('follow 回调里取消自己：回调返回的清理器不丢，关闭后资源已释放', async () => {
    const w = world();
    const d = defineService<{ tag: string }>('zz-cp-reentrant');
    w.host(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    const ref = activationHost(w.app).bind(activation, { ref: d }).ref;
    const live = new Set<string>();
    const off: () => void = ref.follow(p => {
      live.add(p.tag);
      if (p.tag === 'b') off();
      return () => void live.delete(p.tag);
    });
    w.host(d, { tag: 'b' }, { entryId: 'root/b', priority: 2 });
    await tick();
    expect([...live], '在回调里取消：刚建立的 b 立即被清理').toEqual([]);
    await activation.disposeAsync();
    expect([...live]).toEqual([]);
  });

  it('撤回途中调用另一个 track 句柄：关闭前登记的异步清理，关闭一定等到', async () => {
    const w = world();
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    const port = activationHost(w.app).bind(activation, {
      port: defineService<unknown, BindingPort<unknown>>('zz-cp-track', port => port),
    }).port;
    const gate = deferred();
    let finished = false;
    let calls = 0;
    const offA = port.track(() => {
      calls++;
      return gate.promise.then(() => {
        finished = true;
      });
    });
    port.track(() => offA());
    let closed = false;
    const closing = activation.disposeAsync().then(() => {
      closed = true;
    });
    await tick();
    expect({ closed, finished, calls }).toEqual({ closed: false, finished: false, calls: 1 });
    gate.resolve();
    await closing;
    expect(finished).toBe(true);
  });

  it('清理段里才发起的异步撤回同样被等到', async () => {
    const w = world();
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    const port = activationHost(w.app).bind(activation, {
      port: defineService<unknown, BindingPort<unknown>>('zz-cp-track2', port => port),
    }).port;
    const gate = deferred();
    let finished = false;
    const off = port.track(() =>
      gate.promise.then(() => {
        finished = true;
      }),
    );
    activation.resources.onDispose(() => off());
    let closed = false;
    const closing = activation.disposeAsync().then(() => {
      closed = true;
    });
    await tick();
    expect(closed).toBe(false);
    gate.resolve();
    await closing;
    expect(finished).toBe(true);
  });
});

describe('follow 的串行交接', () => {
  it('主动订阅：旧退订未落定时新实例不挂，同一事件不会触发新旧两个回调', async () => {
    const w = world();
    const d = defineService<{ subscribe(): () => unknown }>('zz-cp-subscriber');
    const bus = new EventEmitter();
    const gate = deferred();
    const seen: string[] = [];
    const make = (tag: string, slow: boolean) => ({
      subscribe() {
        const cb = () => void seen.push(tag);
        bus.on('tick', cb);
        return () => (slow ? gate.promise.then(() => void bus.off('tick', cb)) : void bus.off('tick', cb));
      },
    });
    w.host(d, make('a', true), { entryId: 'root/a' });
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    activationHost(w.app)
      .bind(activation, { ref: d })
      .ref.follow(p => p.subscribe());
    w.host(d, make('b', false), { entryId: 'root/b', priority: 2 });
    await tick();
    bus.emit('tick');
    expect(seen, '交接期间只有还没退完的旧订阅在收').toEqual(['a']);
    gate.resolve();
    await tick();
    seen.length = 0;
    bus.emit('tick');
    expect(seen).toEqual(['b']);
    await activation.disposeAsync();
  });

  it('排他资源：旧实例释放落定后新实例才申请；等待期间再换人只跟到最新的', async () => {
    const w = world();
    const d = defineService<{ tag: string; acquire(): () => unknown }>('zz-cp-lease');
    const gate = deferred();
    let owner: string | undefined;
    const acquired: string[] = [];
    const make = (tag: string) => ({
      tag,
      acquire() {
        if (owner) throw new Error(`租约被 ${owner} 占着`);
        owner = tag;
        acquired.push(tag);
        const release = (): void => {
          owner = undefined;
        };
        return () => (tag === 'a' ? gate.promise.then(release) : release());
      },
    });
    w.host(d, make('a'), { entryId: 'root/a' });
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    activationHost(w.app)
      .bind(activation, { ref: d })
      .ref.follow(p => p.acquire());
    w.host(d, make('b'), { entryId: 'root/b', priority: 2 });
    await tick();
    w.host(d, make('c'), { entryId: 'root/c', priority: 3 });
    await tick();
    expect(owner, 'a 还没释放完，谁也没抢').toBe('a');
    gate.resolve();
    await tick();
    expect(owner).toBe('c');
    expect(acquired, 'b 从未被挂上').toEqual(['a', 'c']);
    expect(w.warnings.filter(x => x.includes('租约'))).toEqual([]);
    await activation.disposeAsync();
    expect(owner).toBeUndefined();
  });

  it('旧清理被拒：记 warn（不代表已释放），仍继续挂新实例', async () => {
    const w = world();
    const d = defineService<{ tag: string }>('zz-cp-reject');
    const attached: string[] = [];
    w.host(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    activationHost(w.app)
      .bind(activation, { ref: d })
      .ref.follow(p => {
        attached.push(p.tag);
        return () => (p.tag === 'a' ? Promise.reject(new Error('释放失败')) : undefined);
      });
    w.host(d, { tag: 'b' }, { entryId: 'root/b', priority: 2 });
    await tick();
    expect(attached).toEqual(['a', 'b']);
    expect(w.warnings.some(x => x.includes('释放失败'))).toBe(true);
    await activation.disposeAsync();
  });

  it('截止点：旧清理阻塞 → 换提供者 → 开始关闭 → 放行旧清理 → 不再发生新挂载', async () => {
    const w = world();
    const d = defineService<{ tag: string }>('zz-cp-cutoff');
    const gate = deferred();
    const attached: string[] = [];
    w.host(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    activationHost(w.app)
      .bind(activation, { ref: d })
      .ref.follow(p => {
        attached.push(p.tag);
        return () => (p.tag === 'a' ? gate.promise : undefined);
      });
    w.host(d, { tag: 'b' }, { entryId: 'root/b', priority: 2 });
    await tick();
    let closed = false;
    const closing = activation.disposeAsync().then(() => {
      closed = true;
    });
    await tick();
    expect(closed, '关闭等旧清理落定').toBe(false);
    gate.resolve();
    await closing;
    await tick();
    expect(attached, '关闭开始后不再挂载，哪怕旧清理后来才落定').toEqual(['a']);
  });

  it('退订之后旧清理才落定：不再挂载', async () => {
    const w = world();
    const d = defineService<{ tag: string }>('zz-cp-cancel');
    const gate = deferred();
    const attached: string[] = [];
    w.host(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(w.app).create(rootActivation(w.app), 'consumer');
    const off = activationHost(w.app)
      .bind(activation, { ref: d })
      .ref.follow(p => {
        attached.push(p.tag);
        return () => (p.tag === 'a' ? gate.promise : undefined);
      });
    w.host(d, { tag: 'b' }, { entryId: 'root/b', priority: 2 });
    await tick();
    off();
    gate.resolve();
    await sleep(5);
    expect(attached).toEqual(['a']);
    await activation.disposeAsync();
  });
});
