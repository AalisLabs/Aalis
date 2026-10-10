import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  appService,
  config,
  definePlugin,
  defineService,
  events,
  type Logger,
  lifecycle,
  logger,
  optional,
  pluginsService,
  provide,
  type ServiceSelection,
  services,
} from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// caps.xxx 两层：选择层（list / use / of / present / follow）由 core 定、只读；业务层是活句柄，每次访问按
// 「本插件偏好 > 全局偏好 > 优先级 > 注册顺序」重新解析。偏好只经管理面 services.prefer 写，按插件的给 { for }。
// ════════════════════════════════════════════════════════════

interface Kv {
  tag: string;
  get(): string;
}
const kv = defineService<Kv>('zz-shape-kv');
const impl = (tag: string): Kv => ({ tag, get: () => tag });

/** 登记型契约：提供者是一张登记表，业务层只有登记口 */
interface Hub {
  items: string[];
  add(item: string): () => void;
}
const hub = (): Hub => {
  const items: string[] = [];
  return {
    items,
    add: item => {
      items.push(item);
      return () => void items.splice(items.indexOf(item), 1);
    },
  };
};
const registry = defineService<Hub, { register(item: string): () => void }>('zz-shape-registry', port => {
  const ledger = port.registrar<string>({ key: item => item, register: (h, item) => h.add(item) });
  return { register: item => ledger.add(item) };
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

function world() {
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'shape', logger });
  apps.push(app);
  const host = app.bind({ provide, services });
  const give = (tag: string, priority = 0) => host.provide.use(kv, impl(tag), { priority, entryId: tag });
  return { app, host, give, warns };
}

/** 一个只声明 kv 的插件，交出它的选择层 */
async function consumer(app: App, name = 'consumer') {
  let selection!: ServiceSelection<Kv>;
  await app.plugin(
    definePlugin({
      name,
      uses: { kv: optional(kv) },
      apply: caps => {
        selection = caps.kv;
      },
    }),
  );
  return selection;
}

describe('两层形状', () => {
  it('内置项、宿主服务、默认契约与自定义绑定的 caps.xxx 都是同一个选择层，成员集合固定', () => {
    const custom = defineService<object, { register(): void }>('zz-shape-custom', () => ({ register() {} }));
    const caps = world().app.bind({
      events,
      lifecycle,
      logger,
      config,
      provide,
      services,
      appService,
      pluginsService,
      kv,
      custom,
    });
    for (const [key, selection] of Object.entries(caps))
      expect(Object.keys(selection).sort(), key).toEqual(['follow', 'list', 'of', 'present', 'use']);
  });
});

describe('业务句柄是活的', () => {
  it('存下来的 use 句柄换人后打到新的那一家，取到的方法在调用时才解析', async () => {
    const { app, give } = world();
    give('a');
    const kvs = await consumer(app);
    const stored = kvs.use;
    const method = stored.get;
    give('b', 1);
    expect(stored.tag).toBe('b');
    expect(method()).toBe('b');
  });

  it('of(id) 在那一家撤回后访问即抛错，同一个 id 回来后照常可用', async () => {
    const { app, give } = world();
    const off = give('a');
    give('b');
    const kvs = await consumer(app);
    const a = kvs.of('a');
    off();
    expect(() => a.tag).toThrow(/服务 "zz-shape-kv" 不可用（"consumer" 声明的依赖当前没有 "a" 这一家）/);
    expect(kvs.use.tag, 'use 落到还在的那一家').toBe('b');
    give('a', 5);
    expect(a.tag).toBe('a');
  });

  it('选不到时访问 use 的成员同步抛 ServiceUnavailableError，present 为假', async () => {
    const { app } = world();
    const kvs = await consumer(app);
    expect(kvs.present).toBe(false);
    expect(() => kvs.use.get).toThrow(expect.objectContaining({ name: 'ServiceUnavailableError' }));
  });

  it('then、symbol 键与 toJSON 不转发：await 句柄得到句柄本身，序列化与打印不触发解析', async () => {
    const { app } = world();
    const kvs = await consumer(app);
    expect(await kvs.use).toBe(kvs.use);
    expect(JSON.stringify({ handle: kvs.use })).toBe('{}');
    expect((kvs.use as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
  });

  it('方法以真实实例作 this 调用：用 # 私有字段的提供者照常工作；提供者是函数时句柄可直接调用', async () => {
    class Private {
      readonly #secret = 'p';
      reveal(): string {
        return this.#secret;
      }
    }
    const priv = defineService<Private>('zz-shape-private');
    const fn = defineService<(x: number) => number>('zz-shape-fn');
    const app = world().app;
    app.bind({ provide }).provide.use(priv, new Private());
    app.bind({ provide }).provide.use(fn, x => x + 1);
    const caps = app.bind({ priv, fn });
    expect(caps.priv.use.reveal()).toBe('p');
    expect(caps.fn.use(1)).toBe(2);
  });
});

describe('选择层', () => {
  it('list() 选中的那一条在前、标记与 use 打到的一致，条目的 use 与 of(id) 是同一个句柄', async () => {
    const { app, give } = world();
    give('a');
    give('b', 1);
    const kvs = await consumer(app);
    const entries = kvs.list();
    expect(entries.map(p => [p.id, p.selected, p.basis])).toEqual([
      ['b', true, 'rank'],
      ['a', false, undefined],
    ]);
    expect(entries.find(p => p.selected)?.use.tag).toBe(kvs.use.tag);
    expect(entries[1].use).toBe(kvs.of('a'));
  });

  it('本插件偏好优先于全局偏好，只作用于那一个插件', async () => {
    const { app, host, give } = world();
    give('a');
    give('b');
    give('c');
    const mine = await consumer(app, 'mine');
    const other = await consumer(app, 'other');
    host.services.use.prefer(kv, 'b');
    host.services.use.prefer(kv, 'c', { for: 'mine' });
    expect(host.services.use.preferred(kv, { for: 'mine' })).toBe('c');
    expect([mine.use.tag, mine.list()[0].basis]).toEqual(['c', 'plugin']);
    expect([other.use.tag, other.list()[0].basis]).toEqual(['b', 'global']);
    host.services.use.unprefer(kv, { for: 'mine' });
    expect(mine.use.tag).toBe('b');
  });

  it('偏好指向的那家不在场时按下一级挑，回来后自动切回', async () => {
    const { app, host, give } = world();
    give('a');
    const off = give('b');
    const kvs = await consumer(app);
    host.services.use.prefer(kv, 'b', { for: 'consumer' });
    off();
    expect([kvs.use.tag, kvs.list()[0].basis]).toEqual(['a', 'rank']);
    give('b');
    expect(kvs.use.tag).toBe('b');
  });

  it('本插件偏好变化时 follow 先跑旧清理再以新的那一家重挂', async () => {
    const { app, host, give } = world();
    give('a');
    give('b');
    const kvs = await consumer(app);
    const log: string[] = [];
    kvs.follow(handle => {
      const { tag } = handle;
      log.push(`attach ${tag}`);
      return () => void log.push(`cleanup ${tag}`);
    });
    host.services.use.prefer(kv, 'b', { for: 'consumer' });
    await app.plugins.idle();
    await expect.poll(() => log).toEqual(['attach a', 'cleanup a', 'attach b']);
  });

  it('use 上的登记在本插件的选择换人时整体重挂', async () => {
    const { app, host } = world();
    const [a, b] = [hub(), hub()];
    host.provide.use(registry, a, { entryId: 'a' });
    host.provide.use(registry, b, { entryId: 'b' });
    await app.plugin(
      definePlugin({
        name: 'registrant',
        uses: { registry },
        apply: ({ registry }) => void registry.use.register('x'),
      }),
    );
    expect([a.items, b.items]).toEqual([['x'], []]);
    host.services.use.prefer(registry, 'b', { for: 'registrant' });
    await expect.poll(() => [a.items, b.items]).toEqual([[], ['x']]);
  });
});

describe('follow 的句柄钉在挂上的那一条登记', () => {
  interface Marked {
    marks: string[];
    mark(m: string): void;
  }
  const marked = defineService<Marked>('zz-shape-marked');
  const make = (): Marked => {
    const marks: string[] = [];
    return { marks, mark: m => void marks.push(m) };
  };

  it('同一个 id 换了新实例：旧挂载的异步清理仍打到旧实例，新实例另挂一次，不告警', async () => {
    const { app, host, warns } = world();
    const [v1, v2] = [make(), make()];
    const off = host.provide.use(marked, v1, { entryId: 'same' });
    let selection!: ServiceSelection<Marked>;
    await app.plugin(
      definePlugin({
        name: 'follower',
        uses: { marked: optional(marked) },
        apply: caps => {
          selection = caps.marked;
        },
      }),
    );
    selection.follow(handle => {
      handle.mark('attach');
      return async () => {
        await Promise.resolve();
        handle.mark('cleanup');
      };
    });
    off();
    host.provide.use(marked, v2, { entryId: 'same' });
    await expect.poll(() => v2.marks).toEqual(['attach']);
    expect(v1.marks).toEqual(['attach', 'cleanup']);
    expect(warns).toEqual([]);
  });

  it('提供者撤回时清理仍调得到它（守卫式的 setter），不告警；清理落定之后句柄才失效', async () => {
    interface Guarded {
      guard?: string;
      setGuard(guard?: string): void;
    }
    const guarded = defineService<Guarded>('zz-shape-guarded');
    const hub: Guarded = {
      setGuard(guard) {
        this.guard = guard;
      },
    };
    const { app, warns } = world();
    await app.plugin(
      definePlugin({
        name: 'hub',
        provides: [guarded],
        uses: { provide },
        apply: ({ provide }) => void provide.use(guarded, hub),
      }),
    );
    let held!: Guarded;
    await app.plugin(
      definePlugin({
        name: 'guard',
        uses: { guarded: optional(guarded) },
        apply: ({ guarded }) =>
          void guarded.follow(handle => {
            held = handle;
            handle.setGuard('on');
            return () => handle.setGuard(undefined);
          }),
      }),
    );
    expect(hub.guard).toBe('on');
    await app.plugins.unload('hub');
    expect(hub.guard).toBeUndefined();
    expect(warns).toEqual([]);
    expect(() => held.guard).toThrow(expect.objectContaining({ name: 'ServiceUnavailableError' }));
  });
});

describe('自定义绑定', () => {
  it('经 follow 句柄做的登记打到挂上的那一家，随这次挂载一起撤回', async () => {
    const { app, host } = world();
    const [a, b] = [hub(), hub()];
    host.provide.use(registry, a, { entryId: 'a' });
    host.provide.use(registry, b, { entryId: 'b' });
    await app.plugin(
      definePlugin({
        name: 'registrant',
        uses: { registry },
        apply: ({ registry }) => void registry.follow(handle => void handle.register('x')),
      }),
    );
    expect([a.items, b.items]).toEqual([['x'], []]);
    host.services.use.prefer(registry, 'b', { for: 'registrant' });
    await expect.poll(() => [a.items, b.items]).toEqual([[], ['x']]);
  });

  it('资源口的 present 与选择层同口径：绑定判在不在不必接错误', () => {
    const probe = defineService<object, { present(): boolean }>('zz-shape-probe', port => ({
      present: () => port.present,
    }));
    const { app, host } = world();
    const caps = app.bind({ probe: optional(probe) });
    expect(caps.probe.use.present()).toBe(false);
    host.provide.use(probe, {});
    expect([caps.probe.use.present(), caps.probe.of('root').present(), caps.probe.of('x').present()]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('在活句柄之上包装或添加成员：没覆盖的成员照常转发，选谁仍由 core 定', async () => {
    interface Chat {
      tag: string;
      chat(req: { text: string; caller?: string }): string;
    }
    const llm = defineService<Chat, Chat>('zz-shape-llm', port =>
      Object.assign(Object.create(port.provider) as Chat, {
        chat: (req: { text: string }) => port.provider.chat({ ...req, caller: port.id }),
      }),
    );
    const { app, host } = world();
    const model = (tag: string): Chat => ({ tag, chat: req => `${tag}:${req.text}@${req.caller}` });
    host.provide.use(llm, model('a'), { entryId: 'a' });
    let caps!: { llm: ServiceSelection<Chat> };
    await app.plugin(
      definePlugin({
        name: 'caller',
        uses: { llm },
        apply: c => {
          caps = c;
        },
      }),
    );
    expect([caps.llm.use.tag, caps.llm.use.chat({ text: 'hi' })]).toEqual(['a', 'a:hi@caller']);
    host.provide.use(llm, model('b'), { priority: 1, entryId: 'b' });
    expect([caps.llm.use.tag, caps.llm.use.chat({ text: 'hi' })]).toEqual(['b', 'b:hi@caller']);
    expect(caps.llm.of('a').chat({ text: 'x' })).toBe('a:x@caller');
  });
});

describe('缺席与初始化重试', () => {
  it('of(id) 缺席不借用 required 的重试资格：插件转 error，说明点名那一家', async () => {
    const { app, give } = world();
    give('a');
    await app.plugin(
      definePlugin({
        name: 'pinned',
        uses: { kv },
        apply: ({ kv }) => void kv.of('missing').get(),
      }),
    );
    expect(app.plugins.getPlugin('pinned')?.state).toBe('error');
    expect(app.plugins.getPlugin('pinned')?.error).toContain('"missing" 这一家');
  });
});

describe('内置项同样两层', () => {
  it('logger 与 config 的业务句柄在本次激活拆卸后照常可用，不抛错', async () => {
    const { app } = world();
    let caps!: { logger: ServiceSelection<Logger>; config: ServiceSelection<Readonly<Record<string, unknown>>> };
    await app.plugin(
      definePlugin({
        name: 'late',
        uses: { logger, config, lifecycle },
        apply: c => {
          caps = c;
        },
      }),
      {
        k: 1,
      },
    );
    await app.plugins.unload('late');
    expect(() => caps.logger.use.info('拆卸之后')).not.toThrow();
    expect(caps.config.use).toEqual({ k: 1 });
    expect(caps.logger.list().map(p => [p.id, p.selected])).toEqual([['root', true]]);
  });
});
