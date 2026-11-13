import { afterEach, describe, expect, it } from 'vitest';
import {
  type App,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { ServiceContainer } from '../../packages/core/src/primitives/services.js';
import { createActivationFixture } from '../helpers/activation.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

const OWNER = Symbol('owner');

const tick = () => new Promise<void>(r => setImmediate(r));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    child: () => logger,
  };
  const app = createInspectableApp({
    logLevel: 'error',
    logger,
  });
  apps.push(app);
  return { app, warnings, host: app.bind({ provide }).provide };
}

/** 句柄按登记身份存，同名可以并存——用来看见快照双挂，不被按名覆盖掩盖 */
function uniqueHub(tag: string) {
  const live = new Map<number, { key: string; body: string }>();
  let seq = 0;
  return {
    tag,
    live,
    register(key: string, body: string, onRegister?: () => void) {
      const id = ++seq;
      live.set(id, { key, body });
      onRegister?.();
      return () => void live.delete(id);
    },
    leftover(key?: string) {
      const rows = [...live.values()];
      return key ? rows.filter(r => r.key === key).map(r => r.body) : rows.map(r => `${r.key}=${r.body}`);
    },
  };
}

type UniqueHub = ReturnType<typeof uniqueHub>;
interface Slot {
  key: string;
  body: string;
  onRegister?: () => void;
}
const slots = defineService<UniqueHub, { add(slot: Slot): () => void }>('zz-bind-slots', port => {
  const book = port.registrar<Slot>({
    key: s => s.key,
    register: (hub, slot) => hub.register(slot.key, slot.body, slot.onRegister),
  });
  return { add: slot => book.add(slot) };
});

describe('registrar：重入替换后续键不留孤儿', () => {
  it('合成枢纽：归属表里已有后续键，首挂时 register 重入替换该键，每键一条且关闭后空', async () => {
    const { app, host } = world();
    const a = uniqueHub('A');
    let bound!: { add(slot: Slot): () => void };
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { slots: optional(slots) },
        apply({ slots }) {
          bound = slots.use;
          slots.use.add({
            key: 'head',
            body: 'head-1',
            onRegister: () => bound.add({ key: 'z', body: 'z-reenter' }),
          });
          slots.use.add({ key: 'keep', body: 'keep-1' });
          slots.use.add({ key: 'z', body: 'z-ledger' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    host.use(slots, a, { priority: 1, entryId: 'root/a' });
    await tick();
    const during = a.leftover();
    await app.stop();
    expect({ during, after: a.leftover() }, `在线 ${JSON.stringify(during)}`).toEqual({
      during: expect.arrayContaining(['head=head-1', 'keep=keep-1', 'z=z-reenter']),
      after: [],
    });
    expect(new Set(during.filter(x => x.startsWith('z='))).size, `z 双挂: ${during}`).toBe(1);
  });

  it('同键替换在当前提供者上立即重挂，旧退订不误删新登记；换人只带最新条目', async () => {
    const { app, host } = world();
    const a = uniqueHub('A');
    const b = uniqueHub('B');
    host.use(slots, a, { priority: 1, entryId: 'root/a' });
    const activation = activationHost(app).create('c');
    const bound = activationHost(app).bind(activation, { slots }).slots;
    bound.use.add({ key: 't', body: 'v1' });
    expect(a.leftover()).toEqual(['t=v1']);
    bound.use.add({ key: 't', body: 'v2' });
    expect(a.leftover(), '同键替换须立刻在当前提供者上只留新条目').toEqual(['t=v2']);
    host.use(slots, b, { priority: 2, entryId: 'root/b' });
    await tick();
    expect(a.leftover(), '旧提供者上的当前登记随换人撤回').toEqual([]);
    expect(b.leftover(), '新提供者只挂最新条目').toEqual(['t=v2']);
    await activation.disposeAsync();
    expect(a.leftover()).toEqual([]);
    expect(b.leftover()).toEqual([]);
  });
});

describe('follow：只认函数 cleanup，thenable 拒绝被接住', () => {
  it('async attach 稍后拒绝：无 unhandledRejection 且 warn 一次', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-async-throw');
    const escaped: string[] = [];
    const onEscape = (err: unknown) => escaped.push(String(err));
    process.on('unhandledRejection', onEscape);
    try {
      host.use(d, { tag: 'a' }, { entryId: 'root/a' });
      const activation = activationHost(app).create('c');
      const ref = activationHost(app).bind(activation, { ref: d }).ref;
      // attach 必须同步返回 cleanup；这里故意喂 async，钉运行期接住拒绝
      // @ts-expect-error 期望 TS 拒绝 async attach
      ref.follow(async () => {
        await sleep(1);
        throw new Error('async attach boom');
      });
      await sleep(20);
      await activation.disposeAsync();
      await sleep(20);
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped, `逃逸 ${escaped.join(' | ')}`).toEqual([]);
    const thenableWarns = warnings.filter(w => w.includes('attach 应同步返回 cleanup'));
    expect(thenableWarns, `warnings=${warnings.join(' | ')}`).toHaveLength(1);
  });

  it('返回的 Promise 被拒：拒绝原因记进日志，不被吞掉', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-async-reason');
    host.use(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(app).create('c');
    const ref = activationHost(app).bind(activation, { ref: d }).ref;
    // @ts-expect-error 期望 TS 拒绝 async attach
    ref.follow(async () => {
      throw new Error('ECONNREFUSED-zz');
    });
    await sleep(5);
    expect(warnings.filter(w => w.includes('ECONNREFUSED-zz'))).toHaveLength(1);
    await activation.disposeAsync();
  });

  it('同步函数返回已拒绝 Promise：无 unhandledRejection 且 warn 一次', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-thenable-attach');
    const escaped: string[] = [];
    const onEscape = (err: unknown) => escaped.push(String(err));
    process.on('unhandledRejection', onEscape);
    try {
      host.use(d, { tag: 'a' }, { entryId: 'root/a' });
      const activation = activationHost(app).create('c');
      const ref = activationHost(app).bind(activation, { ref: d }).ref;
      // FollowCleanup 不含 Promise；运行期仍须接住 JS 绕过
      // @ts-expect-error 期望 TS 拒绝返回 Promise
      ref.follow(() => Promise.reject(new Error('sync-return-reject')));
      await sleep(15);
      await activation.disposeAsync();
      await sleep(15);
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped, `逃逸 ${escaped.join(' | ')}`).toEqual([]);
    expect(
      warnings.filter(w => w.includes('attach 应同步返回 cleanup')),
      `warnings=${warnings.join(' | ')}`,
    ).toHaveLength(1);
  });

  it('返回数字不得当 cleanup，换人与关闭不抛', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-number-cleanup');
    host.use(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(app).create('c');
    const ref = activationHost(app).bind(activation, { ref: d }).ref;
    // @ts-expect-error 非函数返回值不得当 cleanup
    ref.follow(() => 1);
    host.use(d, { tag: 'b' }, { entryId: 'root/b', priority: 2 });
    await tick();
    await activation.disposeAsync();
    expect(
      warnings.some(w => w.includes('is not a function')),
      `warnings=${warnings.join(' | ')}`,
    ).toBe(false);
  });

  it('返回对象不得当 cleanup，关闭不抛', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-object-cleanup');
    host.use(d, { tag: 'a' }, { entryId: 'root/a' });
    const activation = activationHost(app).create('c');
    const ref = activationHost(app).bind(activation, { ref: d }).ref;
    // @ts-expect-error 对象不得当 cleanup
    ref.follow(() => ({ close() {} }));
    await activation.disposeAsync();
    expect(
      warnings.some(w => w.includes('is not a function')),
      `warnings=${warnings.join(' | ')}`,
    ).toBe(false);
  });
});

describe('描述符与 optional 包装：造出即冻结，插件定义只收本份 core 造的', () => {
  it('改名、换 bind、挂字段都抛 TypeError', () => {
    const d = defineService<{ n: number }>('zz-bind-frozen');
    const o = optional(d);
    expect(() => {
      (d as { name: string }).name = 'zz-bind-renamed';
    }).toThrow(TypeError);
    expect(() => {
      (d as { bind: unknown }).bind = () => ({});
    }).toThrow(TypeError);
    expect(() => Object.assign(d, { optional: true })).toThrow(TypeError);
    expect(() => {
      (o as { optional: unknown }).optional = defineService('zz-bind-other');
    }).toThrow(TypeError);
    expect(() => Object.assign(o, { extra: 1 })).toThrow(TypeError);
    expect(d.name).toBe('zz-bind-frozen');
    expect(o.optional).toBe(d);
  });

  const d = defineService<{ n: number }>('zz-bind-hand');
  it.each([
    ['手写的 { name, bind }', () => ({ name: 'zz-bind-hand', bind: (port: { provider: unknown }) => port.provider })],
    ['缺 name 的手写对象', () => ({ bind: (port: { provider: unknown }) => port.provider })],
    ['描述符的展开副本', () => ({ ...d })],
    ['展开副本上挂自有 optional 字段', () => ({ ...d, optional: d })],
    ['optional 包装的展开副本', () => ({ ...optional(d) })],
    ['optional() 里包着手写对象', () => optional({ ...d })],
    ['optional() 套 optional()', () => optional(optional(d) as never)],
    ['以描述符为原型派生的对象', () => Object.create(d)],
    ['null', () => null],
  ])('手写的对象放进 uses：定义时拒绝（%s）', (_label, make) => {
    expect(() => definePlugin({ name: 'c', uses: { s: make() as never }, apply() {} })).toThrow(
      '不是服务描述符（应为 defineService 的结果）',
    );
  });

  it('手写的对象、optional 包装、派生的对象与空值放进 provides：定义时拒绝', () => {
    for (const item of [{ ...d }, optional(d), Object.create(d), null]) {
      expect(() => definePlugin({ name: 'c', provides: [item as never], apply() {} })).toThrow('不是描述符的元素');
    }
  });

  it('抄了章的手写对象：按另一份 core 造的拒绝', () => {
    const forged = Object.defineProperty({ ...d }, Symbol.for('aalis.core.minted'), { value: true });
    // 直接放进 uses、包在本份的 optional() 里、放进 provides，三处都点名另一份 core
    for (const uses of [{ s: forged }, { s: optional(forged as never) }]) {
      expect(() => definePlugin({ name: 'c', uses: uses as never, apply() {} })).toThrow('另一份 @aalis/core');
    }
    expect(() => definePlugin({ name: 'c', provides: [forged as never], apply() {} })).toThrow('另一份 @aalis/core');
  });

  it('没经 definePlugin 的定义带手写描述符：登记时拒绝并记 error', async () => {
    const { app, warnings } = world();
    const handwritten = { name: 'c', uses: { s: { ...d } }, apply() {} };
    expect(await app.plugin(handwritten as never)).toBe(false);
    expect(app.plugins.getStatus()).toEqual([]);
    expect(warnings.filter(m => m.includes('不是服务描述符（应为 defineService 的结果）'))).toHaveLength(1);
  });

  it('真正的 optional() 缺席时仍激活', async () => {
    const { app } = world();
    const d = defineService<{ n: number }>('zz-bind-real-opt');
    let ran = false;
    await app.plugin(
      definePlugin({
        name: 'c',
        uses: { s: optional(d) },
        apply() {
          ran = true;
        },
      }),
    );
    await app.plugins.idle();
    expect(ran).toBe(true);
    expect(app.plugins.getPlugin('c')?.state).toBe('active');
  });
});

describe('provide：空实现与非有限 priority 拒绝', () => {
  it('第一个参数不是描述符（没有服务名）：拒绝，不登记到空名字下', () => {
    const { app } = world();
    const publish = app.bind({ provide }).provide.use as (descriptor: unknown, implementation: unknown) => unknown;
    for (const wrong of [{}, { name: '' }, { name: '  ' }, { name: 7 }, { bind() {} }]) {
      expect(() => publish(wrong, { n: 1 })).toThrow('不是服务描述符');
    }
    // 手写对象只要带着服务名，照常按名字登记
    publish({ name: 'zz-bind-by-name' }, { n: 1 });
    expect(app.bind({ services }).services.use.get('zz-bind-by-name')).toEqual({ n: 1 });
  });

  it('provide(null) 抛，提供者 error、消费者不得 active', async () => {
    const ping = defineService<{ ping(): string }>('zz-bind-null');
    const { app, host } = world();
    expect(() => host.use(ping, null as never)).toThrow('provide 的实现不能为空');

    await app.plugin(
      definePlugin({
        name: 'null-prov',
        provides: [ping],
        uses: { provide },
        apply({ provide }) {
          provide.use(ping, null as never);
        },
      }),
    );
    let required: unknown = 'unset';
    await app.plugin(
      definePlugin({
        name: 'null-cons',
        uses: { ping },
        apply({ ping }) {
          required = ping.use.ping();
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('null-prov')?.state).toBe('error');
    expect(app.plugins.getPlugin('null-prov')?.error).toMatch(/provide 的实现不能为空/);
    expect(required).toBe('unset');
    expect(app.plugins.getPlugin('null-cons')?.state).not.toBe('active');
  });

  it('provide(undefined) 抛，不得提供者 active 而消费者永久 pending', async () => {
    const ping = defineService<{ ping(): string }>('zz-bind-undef');
    const { app, host } = world();
    expect(() => host.use(ping, undefined as never)).toThrow('provide 的实现不能为空');

    await app.plugin(
      definePlugin({
        name: 'undef-prov',
        provides: [ping],
        uses: { provide },
        apply({ provide }) {
          provide.use(ping, undefined as never);
        },
      }),
    );
    await app.plugin(definePlugin({ name: 'undef-cons', uses: { ping }, apply() {} }));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('undef-prov')?.state).toBe('error');
    expect(app.plugins.getPlugin('undef-prov')?.error).toMatch(/provide 的实现不能为空/);
    expect(app.plugins.getPlugin('undef-cons')?.state).toBe('pending');
  });

  it('priority 非有限数字抛；随后有限 10 仍可登记', () => {
    const { app, host } = world();
    const kv = defineService<{ get(): number }>('zz-bind-prio');
    expect(() => host.use(kv, { get: () => 2 }, { priority: 'high' as never, entryId: 'root/b' })).toThrow(
      'provide 的 priority 必须是有限数字（收到 high）',
    );
    expect(() => host.use(kv, { get: () => 2 }, { priority: Number.NaN, entryId: 'root/n' })).toThrow(
      'provide 的 priority 必须是有限数字（收到 NaN）',
    );
    expect(() => host.use(kv, { get: () => 2 }, { priority: Number.POSITIVE_INFINITY, entryId: 'root/i' })).toThrow(
      'provide 的 priority 必须是有限数字（收到 Infinity）',
    );
    host.use(kv, { get: () => 1 }, { priority: 10, entryId: 'root/a' });
    expect((app.bind({ services }).services.use.get('zz-bind-prio') as { get(): number } | undefined)?.get()).toBe(1);
  });

  it('ServiceContainer.register 同样拒空实现与非有限 priority', () => {
    const c = new ServiceContainer();
    expect(() => c.register('x', null, 'id', OWNER)).toThrow('provide 的实现不能为空');
    expect(() => c.register('x', undefined, 'id', OWNER)).toThrow('provide 的实现不能为空');
    expect(() => c.register('x', { v: 1 }, 'id', OWNER, { priority: Number.NaN })).toThrow(
      'provide 的 priority 必须是有限数字（收到 NaN）',
    );
  });
});

describe('defineService：造时校验 name 与 bind', () => {
  it('name 是空串或空白：拒绝', () => {
    expect(() => defineService('')).toThrow('服务 name 不能为空');
    expect(() => defineService('   ')).toThrow('服务 name 不能为空');
  });

  it('给了 bind 却不是函数：拒绝，不留到激活绑定时才报', () => {
    for (const bind of [42, null, {}]) {
      expect(() => defineService('zz-bind-bad', bind as never)).toThrow('服务 bind 必须是函数');
    }
  });
});

describe('uses 里同一服务既 required 又 optional：按 required 连关停边', () => {
  it('同一份 uses 里或先后两次绑定，required 与 optional 不论谁在前，对提供者都记 required', async () => {
    const { host } = createActivationFixture();
    const svc = defineService<{ v: number }>('t:dual-use');
    const provider = host.create('provider');
    host.bind(provider, { provide }).provide.use(svc, { v: 1 });
    const both = host.create('both');
    host.bind(both, { a: svc, b: optional(svc) });
    const bothOptionalFirst = host.create('both-optional-first');
    host.bind(bothOptionalFirst, { b: optional(svc), a: svc });
    const rebound = host.create('rebound');
    host.bind(rebound, { a: svc });
    host.bind(rebound, { b: optional(svc) });
    const reboundOptionalFirst = host.create('rebound-optional-first');
    host.bind(reboundOptionalFirst, { b: optional(svc) });
    host.bind(reboundOptionalFirst, { a: svc });
    for (const consumer of [both, bothOptionalFirst, rebound, reboundOptionalFirst]) {
      expect(consumer.providers().get(provider), consumer.id).toBe(true);
    }
    await host.root.disposeAsync();
  });

  // 绑定函数可以当场建归属表（创建即跟随，绑定时就连上跟随边）：依赖要先记下，这条边才按 required 记
  it('绑定时当场连上的跟随边：提供者撤下服务、撤回还没落定时只剩这条边，它也按 required 记', async () => {
    const { host } = createActivationFixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const hub = defineService<{ add(x: string): () => Promise<void> }, { add(x: string): void }>('t:dual-hub', port => {
      const registry = port.registrar({ key: (x: string) => x, register: (p, x: string) => p.add(x) });
      return { add: (x: string) => void registry.add(x) };
    });
    const provider = host.create('provider');
    const off = host.bind(provider, { provide }).provide.use(hub, { add: () => () => pending });
    const consumer = host.create('consumer');
    host.bind(consumer, { h: hub }).h.use.add('k');
    off();
    await Promise.resolve();
    expect(consumer.providers().get(provider)).toBe(true);
    release();
    await host.root.disposeAsync();
  });
});
