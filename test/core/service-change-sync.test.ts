// 服务变更时 core 自己的跟随（follow、registrar）在变更那次调用里收敛；选择层的 watch 回调在那之后的下一个微任务才到。
import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  LogHub,
  lifecycle,
  optional,
  type Provide,
  provide,
  type ServiceSelection,
  type Services,
  services,
} from '../../packages/core/src/index.js';

interface Hub {
  readonly items: string[];
  add(item: string): () => void;
}

function hub(): Hub {
  const items: string[] = [];
  return {
    items,
    add(item) {
      items.push(item);
      return () => {
        items.splice(items.indexOf(item), 1);
      };
    },
  };
}

function hubService(name: string) {
  return defineService<Hub, { register(item: string): () => void }>(name, port => {
    const ledger = port.registrar<string>({ key: item => item, register: (h, item) => h.add(item) });
    return { register: item => ledger.add(item) };
  });
}
const registry = hubService('zz-sync-registry');

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world(): Promise<{
  app: App;
  host: { provide: ServiceSelection<Provide>; services: ServiceSelection<Services> };
}> {
  const app = new App({ name: 'service-change-sync', logLevel: 'error', logHub: new LogHub() });
  apps.push(app);
  const host = app.bind({ provide, services });
  await app.plugins.idle();
  return { app, host };
}

/** 自供自用：apply 里先经 optional(registry) 登记，再 provide 自己那份注册表 */
function selfServing(table: Hub) {
  return definePlugin({
    name: 'zz-self-serving',
    provides: [registry],
    uses: { book: optional(registry), provide },
    apply({ book, provide }) {
      book.use.register('builtin');
      provide.use(registry, table);
    },
  });
}

/** 可选依赖 registry、登记一条的消费方 */
function consumer(item: string) {
  return definePlugin({
    name: 'zz-consumer',
    uses: { book: optional(registry) },
    apply({ book }) {
      book.use.register(item);
    },
  });
}

describe('服务变更时 core 的跟随就地收敛', () => {
  it('自供自用的服务：idle() 放行时补登记已落定', async () => {
    const { app } = await world();
    const table = hub();
    await app.plugin(selfServing(table));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('zz-self-serving')?.state).toBe('active');
    expect(table.items).toEqual(['builtin']);
  });

  it('选择层的 watch 回调收到时跟随已经收敛', async () => {
    const { app } = await world();
    const table = hub();
    const seen: string[][] = [];
    app.bind({ book: optional(registry) }).book.watch(() => void seen.push([...table.items]));
    await app.plugin(selfServing(table));
    await app.plugins.idle();
    expect(seen[0]).toEqual(['builtin']);
  });

  // 硬依赖的消费方随提供者撤回整个转入拆卸，登记由它的撤回段统一收；照常运行的只有可选依赖的消费方
  it('提供者撤回时可选依赖的消费方：登记在撤回这次调用里摘掉', async () => {
    const { app, host } = await world();
    const table = hub();
    const off = host.provide.use(registry, table);
    await app.plugin(consumer('consumer'));
    await app.plugins.idle();
    expect(app.plugins.getPlugin('zz-consumer')?.state).toBe('active');
    expect(table.items).toEqual(['consumer']);
    off();
    expect(table.items).toEqual([]);
  });

  it('切换偏好：登记在切换这次调用里搬到新选中的那一家', async () => {
    const { app, host } = await world();
    const first = hub();
    const second = hub();
    host.provide.use(registry, first, { entryId: 'root/first' });
    host.provide.use(registry, second, { entryId: 'root/second' });
    host.services.use.prefer(registry, 'root/first');
    await app.plugin(consumer('x'));
    await app.plugins.idle();
    expect([first.items, second.items]).toEqual([['x'], []]);
    host.services.use.prefer(registry, 'root/second');
    expect([first.items, second.items]).toEqual([[], ['x']]);
  });

  it('登记回调里再 provide 另一个服务：嵌套的跟随在那次 provide 里挂上，不重复登记', async () => {
    const { app } = await world();
    const table = hub();
    const second = hub();
    const both = hubService('zz-sync-both');
    let atOnce: string[] | undefined;
    await app.plugin(
      definePlugin({
        name: 'zz-nested',
        provides: [registry, both],
        uses: { book: optional(registry), pair: optional(both), provide },
        apply({ book, pair, provide }) {
          book.use.register('outer');
          pair.use.register('inner');
          const nestedTable: Hub = {
            items: table.items,
            add(item) {
              if (atOnce === undefined) {
                provide.use(both, second);
                atOnce = [...second.items];
              }
              return table.add(item);
            },
          };
          provide.use(registry, nestedTable);
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('zz-nested')?.state).toBe('active');
    expect(atOnce, '嵌套的 provide 返回时它的跟随已挂上').toEqual(['inner']);
    expect([table.items, second.items]).toEqual([['outer'], ['inner']]);
  });

  // 重算是第一个观察者：它的同步段先把要退场的消费者标成关闭，跟随随后跳过，清理照撤回段的次序排在收尾段之后
  it('required 依赖撤回：消费者先进收尾段，跟随的清理在它的撤回段里跑', async () => {
    const { app, host } = await world();
    const feature = defineService<object>('zz-sync-required');
    const off = host.provide.use(feature, {});
    const order: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'zz-dependent',
        uses: { f: feature, lifecycle },
        apply({ f, lifecycle }) {
          lifecycle.use.onDrain(() => void order.push('drain'));
          f.follow(() => () => void order.push('cleanup'));
        },
      }),
    );
    await app.plugins.idle();
    off();
    await app.plugins.idle();
    expect(app.plugins.getPlugin('zz-dependent')?.state).toBe('pending');
    expect(order).toEqual(['drain', 'cleanup']);
  });

  // 原语与归属表条目同一拍撤掉，不等下游交接：下游跟随收敛、watch 回调收到通知时，拆卸中提供者的条目都已不在
  it('提供者拆卸：本激活的归属表条目先撤，下游跟随与 watch 回调之后才收到', async () => {
    const { app, host } = await world();
    const table = hub();
    host.provide.use(registry, table);
    const feature = defineService<object, { follow(attach: () => () => void): () => void }>(
      'zz-sync-feature',
      port => ({
        follow: attach => port.follow(attach),
      }),
    );
    const heard: string[][] = [];
    app.bind({ feature: optional(feature) }).feature.watch(() => void heard.push([...table.items]));
    const atCleanup: string[][] = [];
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'zz-provider',
          provides: [feature],
          uses: { book: optional(registry), provide },
          apply({ book, provide }) {
            book.use.register('provider-item');
            provide.use(feature, {});
          },
        }),
      },
      {
        definition: definePlugin({
          name: 'zz-follower',
          uses: { f: optional(feature) },
          apply({ f }) {
            f.use.follow(() => () => void atCleanup.push([...table.items]));
          },
        }),
      },
    ]);
    await app.plugins.idle();
    expect(table.items).toEqual(['provider-item']);
    await app.plugins.disable('zz-provider');
    await app.plugins.idle();
    expect({ atCleanup, heard: heard.at(-1) }).toEqual({ atCleanup: [[]], heard: [] });
  });
});
