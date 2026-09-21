import { afterEach, describe, expect, it } from 'vitest';
import { type BoundTools, tools } from '../../packages/api-tools/src/index.js';
import { assemble } from '../../packages/core/src/context/binding.js';
import {
  App,
  definePlugin,
  defineService,
  type Logger,
  optional,
  provide,
  ServiceContainer,
} from '../../packages/core/src/index.js';
import { rootActivation } from '../../packages/core/src/orchestration/app.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';

const tick = () => new Promise<void>(r => setImmediate(r));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function silentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
  };
  return logger;
}

function world() {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => void warnings.push(a.map(String).join(' ')),
    child: () => logger,
  };
  const app = new App({
    config: { name: 'H', logLevel: 'error', plugins: {} },
    logger,
  });
  apps.push(app);
  return { app, warnings, host: app.bind({ provide }).provide };
}

function toolDef(name: string) {
  return {
    type: 'function' as const,
    function: { name, description: name, parameters: { type: 'object' as const, properties: {} } },
  };
}

async function execTool(reg: ToolRegistry, name: string) {
  return (await reg.execute(name, {}, { sessionId: 's', platform: 'test' })).content;
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
  it('真实枢纽 tools：卸载消费者后 execute 必须报未注册', async () => {
    const { app } = world();
    const reg = new ToolRegistry(silentLogger());
    const box: { bound?: BoundTools } = {};
    const orig = reg.register.bind(reg);
    reg.register = (tool, ctx) => {
      const off = orig(tool, ctx);
      if (tool.definition.function.name === 'alpha' && box.bound) {
        box.bound.register({ definition: toolDef('zulu'), handler: async () => 'from-reenter' });
      }
      return off;
    };
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { tools: optional(tools) },
        apply({ tools }) {
          box.bound = tools;
          tools.register({ definition: toolDef('alpha'), handler: async () => 'alpha' });
          tools.register({ definition: toolDef('keep'), handler: async () => 'keep' });
          tools.register({ definition: toolDef('zulu'), handler: async () => 'from-ledger' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    app.bind({ provide }).provide(tools, reg);
    await tick();
    expect(
      reg
        .getAll()
        .map(t => t.name)
        .sort(),
    ).toEqual(['alpha', 'keep', 'zulu']);

    await app.plugins.unload('consumer');
    const names = reg
      .getAll()
      .map(t => t.name)
      .sort();
    const zulu = await execTool(reg, 'zulu');
    const keep = await execTool(reg, 'keep');
    const alpha = await execTool(reg, 'alpha');
    expect({ names, zulu, keep, alpha }, '卸载后枢纽应空，execute 应全部未找到').toEqual({
      names: [],
      zulu: expect.stringContaining('未找到'),
      keep: expect.stringContaining('未找到'),
      alpha: expect.stringContaining('未找到'),
    });
  });

  it('真实枢纽 tools：换人后旧表与新表在消费者卸载后都不可再派活', async () => {
    const { app, host } = world();
    const a = new ToolRegistry(silentLogger());
    const b = new ToolRegistry(silentLogger());
    const box: { bound?: BoundTools } = {};
    const wrap = (reg: ToolRegistry) => {
      const orig = reg.register.bind(reg);
      reg.register = (tool, ctx) => {
        const off = orig(tool, ctx);
        if (tool.definition.function.name === 'alpha' && box.bound) {
          box.bound.register({ definition: toolDef('zulu'), handler: async () => 'reenter' });
        }
        return off;
      };
    };
    wrap(a);
    wrap(b);
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { tools: optional(tools) },
        apply({ tools }) {
          box.bound = tools;
          tools.register({ definition: toolDef('alpha'), handler: async () => 'a' });
          tools.register({ definition: toolDef('zulu'), handler: async () => 'ledger' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    host(tools, a, { priority: 1, entryId: 'root/a' });
    await tick();
    host(tools, b, { priority: 2, entryId: 'root/b' });
    await tick();
    await app.plugins.unload('consumer');
    expect(await execTool(a, 'zulu'), '旧表不得留孤儿').toContain('未找到');
    expect(await execTool(b, 'zulu'), '新表不得留孤儿').toContain('未找到');
  });

  it('合成枢纽：账上已有后续键，首挂时 register 重入替换该键，每键一条且关闭后空', async () => {
    const { app, host } = world();
    const a = uniqueHub('A');
    let bound!: { add(slot: Slot): () => void };
    await app.plugin(
      definePlugin({
        name: 'consumer',
        uses: { slots: optional(slots) },
        apply({ slots }) {
          bound = slots;
          slots.add({
            key: 'head',
            body: 'head-1',
            onRegister: () => bound.add({ key: 'z', body: 'z-reenter' }),
          });
          slots.add({ key: 'keep', body: 'keep-1' });
          slots.add({ key: 'z', body: 'z-ledger' });
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('consumer')?.state).toBe('active');
    host(slots, a, { priority: 1, entryId: 'root/a' });
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
    host(slots, a, { priority: 1, entryId: 'root/a' });
    const ctx = rootActivation(app).fork('c');
    const bound = assemble(ctx, { slots }).slots;
    bound.add({ key: 't', body: 'v1' });
    expect(a.leftover()).toEqual(['t=v1']);
    bound.add({ key: 't', body: 'v2' });
    expect(a.leftover(), '同键替换须立刻在当前提供者上只留新条目').toEqual(['t=v2']);
    host(slots, b, { priority: 2, entryId: 'root/b' });
    await tick();
    expect(a.leftover(), '旧提供者上的当前登记随换人撤回').toEqual([]);
    expect(b.leftover(), '新提供者只挂最新条目').toEqual(['t=v2']);
    await ctx.disposeAsync();
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
      host(d, { tag: 'a' }, { entryId: 'root/a' });
      const ctx = rootActivation(app).fork('c');
      const ref = assemble(ctx, { ref: d }).ref;
      // attach 必须同步返回 cleanup；这里故意喂 async，钉运行期接住拒绝
      // @ts-expect-error 期望 TS 拒绝 async attach
      ref.follow(async () => {
        await sleep(1);
        throw new Error('async attach boom');
      });
      await sleep(20);
      await ctx.disposeAsync();
      await sleep(20);
    } finally {
      process.off('unhandledRejection', onEscape);
    }
    expect(escaped, `逃逸 ${escaped.join(' | ')}`).toEqual([]);
    const thenableWarns = warnings.filter(w => w.includes('attach 应同步返回 cleanup'));
    expect(thenableWarns, `warnings=${warnings.join(' | ')}`).toHaveLength(1);
  });

  it('同步函数返回已拒绝 Promise：无 unhandledRejection 且 warn 一次', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-thenable-attach');
    const escaped: string[] = [];
    const onEscape = (err: unknown) => escaped.push(String(err));
    process.on('unhandledRejection', onEscape);
    try {
      host(d, { tag: 'a' }, { entryId: 'root/a' });
      const ctx = rootActivation(app).fork('c');
      const ref = assemble(ctx, { ref: d }).ref;
      // FollowCleanup 不含 Promise；运行期仍须接住 JS 绕过
      // @ts-expect-error 期望 TS 拒绝返回 Promise
      ref.follow(() => Promise.reject(new Error('sync-return-reject')));
      await sleep(15);
      await ctx.disposeAsync();
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
    host(d, { tag: 'a' }, { entryId: 'root/a' });
    const ctx = rootActivation(app).fork('c');
    const ref = assemble(ctx, { ref: d }).ref;
    // @ts-expect-error 非函数返回值不得当 cleanup
    ref.follow(() => 1);
    host(d, { tag: 'b' }, { entryId: 'root/b', priority: 2 });
    await tick();
    await ctx.disposeAsync();
    expect(
      warnings.some(w => w.includes('is not a function')),
      `warnings=${warnings.join(' | ')}`,
    ).toBe(false);
  });

  it('返回对象不得当 cleanup，关闭不抛', async () => {
    const { app, host, warnings } = world();
    const d = defineService<{ tag: string }>('zz-bind-object-cleanup');
    host(d, { tag: 'a' }, { entryId: 'root/a' });
    const ctx = rootActivation(app).fork('c');
    const ref = assemble(ctx, { ref: d }).ref;
    // @ts-expect-error 对象不得当 cleanup
    ref.follow(() => ({ close() {} }));
    await ctx.disposeAsync();
    expect(
      warnings.some(w => w.includes('is not a function')),
      `warnings=${warnings.join(' | ')}`,
    ).toBe(false);
  });
});

describe('optional：品牌标记，自有 optional 字段不能绕过激活闸', () => {
  it('描述符挂自有 optional: true：定义期不抛，缺席时 pending', async () => {
    const { app } = world();
    const d = defineService<{ n: number }>('zz-bind-poison-true');
    const poisoned = Object.assign(d, { optional: true });
    let ran = false;
    let threw: unknown;
    try {
      await app.plugin(
        definePlugin({
          name: 'c-true',
          uses: { s: poisoned },
          apply() {
            ran = true;
          },
        }),
      );
    } catch (err) {
      threw = err;
    }
    await app.plugins.idle();
    expect(threw, `定义期不应抛：${threw}`).toBeUndefined();
    expect(ran, '误把 required 描述符认成 optional 会让 apply 跑起来').toBe(false);
    expect(app.plugins.getPlugin('c-true')?.state).toBe('pending');
  });

  it('描述符挂自有 optional: 描述符自身 仍按 required 走激活闸', async () => {
    const { app } = world();
    const d = defineService<{ n: number }>('zz-bind-poison');
    // 自有 optional 字段不是 optional() 包装：须仍走 required 激活闸
    const poisoned = Object.assign(d, { optional: d });
    let ran = false;
    await app.plugin(
      definePlugin({
        name: 'c',
        uses: { s: poisoned },
        apply() {
          ran = true;
        },
      }),
    );
    await app.plugins.idle();
    expect(ran, '误把 required 描述符认成 optional 会让 apply 跑起来').toBe(false);
    expect(app.plugins.getPlugin('c')?.state).toBe('pending');
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
  it('provide(null) 抛，提供者 error、消费者不得 active', async () => {
    const ping = defineService<{ ping(): string }>('zz-bind-null');
    const { app, host } = world();
    expect(() => host(ping, null as never)).toThrow('provide 的实现不能为空');

    await app.plugin(
      definePlugin({
        name: 'null-prov',
        provides: [ping],
        uses: { provide },
        apply({ provide }) {
          provide(ping, null as never);
        },
      }),
    );
    let required: unknown = 'unset';
    await app.plugin(
      definePlugin({
        name: 'null-cons',
        uses: { ping },
        apply({ ping }) {
          required = ping.require();
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
    expect(() => host(ping, undefined as never)).toThrow('provide 的实现不能为空');

    await app.plugin(
      definePlugin({
        name: 'undef-prov',
        provides: [ping],
        uses: { provide },
        apply({ provide }) {
          provide(ping, undefined as never);
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
    expect(() => host(kv, { get: () => 2 }, { priority: 'high' as never, entryId: 'root/b' })).toThrow(
      'provide 的 priority 必须是有限数字（收到 high）',
    );
    expect(() => host(kv, { get: () => 2 }, { priority: Number.NaN, entryId: 'root/n' })).toThrow(
      'provide 的 priority 必须是有限数字（收到 NaN）',
    );
    expect(() => host(kv, { get: () => 2 }, { priority: Number.POSITIVE_INFINITY, entryId: 'root/i' })).toThrow(
      'provide 的 priority 必须是有限数字（收到 Infinity）',
    );
    host(kv, { get: () => 1 }, { priority: 10, entryId: 'root/a' });
    expect(app.services.get<{ get(): number }>('zz-bind-prio')?.get()).toBe(1);
  });

  it('ServiceContainer.register 同样拒空实现与非有限 priority', () => {
    const c = new ServiceContainer();
    expect(() => c.register('x', null, 'id')).toThrow('provide 的实现不能为空');
    expect(() => c.register('x', undefined, 'id')).toThrow('provide 的实现不能为空');
    expect(() => c.register('x', { v: 1 }, 'id', undefined, { priority: Number.NaN })).toThrow(
      'provide 的 priority 必须是有限数字（收到 NaN）',
    );
  });
});

describe('defineService：name 须 trim 后非空', () => {
  it('空串与空白拒绝', () => {
    expect(() => defineService('')).toThrow('服务 name 不能为空');
    expect(() => defineService('   ')).toThrow('服务 name 不能为空');
  });
});
