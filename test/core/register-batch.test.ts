import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, pluginsService, provide } from '../../packages/core/src/index.js';

// pluginAll：整批落账后只重算一次。依赖方排在它 required 服务的全部提供者之后激活；
// 返回值逐项对应；apply 里再登记别的插件照常排队自愈。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world(): App {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  return app;
}

describe('pluginAll', () => {
  it('依赖方在全部提供者之后激活；逐个 plugin() 则会先挂到后备上（对照）', async () => {
    const store = defineService<{ id: string }>('rb-store');
    const make = (seen: string[]) => [
      definePlugin({
        name: 'fallback',
        uses: { provide },
        provides: [store],
        apply: ({ provide }) => {
          provide(store, { id: 'fallback' }, { priority: -100 });
        },
      }),
      definePlugin({ name: 'consumer', uses: { store }, apply: ({ store }) => void seen.push(store.require().id) }),
      definePlugin({
        name: 'preferred',
        uses: { provide },
        provides: [store],
        apply: ({ provide }) => {
          provide(store, { id: 'preferred' }, { priority: 10 });
        },
      }),
    ];
    const batched: string[] = [];
    const a = world();
    // 先等构造期的重算落定，否则整批撞上在飞 run 排队，逐项重算也会被合并，本用例就分不出两种实现
    await a.plugins.idle();
    await a.pluginAll(make(batched).map(definition => ({ definition })));
    await a.plugins.idle();
    expect(batched).toEqual(['preferred']);

    const oneByOne: string[] = [];
    const b = world();
    for (const definition of make(oneByOne)) await b.plugin(definition);
    await b.plugins.idle();
    expect(oneByOne).toEqual(['fallback']);
  });

  it('整批的激活次序：互不依赖的按登记序，依赖方只后移到其提供者之后', async () => {
    const svc = defineService<object>('rb-order');
    const order: string[] = [];
    const plain = (name: string) => definePlugin({ name, apply: () => void order.push(name) });
    const app = world();
    await app.pluginAll(
      [
        plain('a'),
        definePlugin({
          name: 'z',
          uses: { provide },
          provides: [svc],
          apply: ({ provide }) => {
            order.push('z');
            provide(svc, {});
          },
        }),
        definePlugin({ name: 'b', uses: { svc }, apply: () => void order.push('b') }),
        plain('c'),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    // 逐个 plugin() 的历史次序同为 a z b c；先就绪先出队的拓扑会排成 a z c b
    expect(order).toEqual(['a', 'z', 'b', 'c']);
  });

  it('返回值逐项对应：重名与非法定义为 false，其余照常落账', async () => {
    const app = world();
    const ok = definePlugin({ name: 'ok', apply() {} });
    expect(
      await app.pluginAll([{ definition: ok }, { definition: ok }, { definition: { name: '', apply() {} } }]),
    ).toEqual([true, false, false]);
    expect(app.plugins.getPlugin('ok')?.state).toBe('active');
  });

  it('disabled 条目以禁用态落账、不激活；只含禁用条目的批不触发重算也照常返回', async () => {
    const app = world();
    const applied: string[] = [];
    const def = (name: string) => definePlugin({ name, apply: () => void applied.push(name) });
    expect(await app.pluginAll([{ definition: def('off'), disabled: true }])).toEqual([true]);
    expect(app.plugins.getPlugin('off')?.state).toBe('disabled');
    expect(await app.pluginAll([{ definition: def('on') }, { definition: def('off2'), disabled: true }])).toEqual([
      true,
      true,
    ]);
    await app.plugins.idle();
    expect(applied).toEqual(['on']);
    expect(await app.plugins.enable('off')).toBe(true);
    await app.plugins.idle();
    expect(applied).toEqual(['on', 'off']);
  });

  it('批内插件在 apply 里登记别的插件：排队并入同一次重算收尾', async () => {
    const app = world();
    const child = definePlugin({ name: 'child', apply() {} });
    await app.pluginAll([
      {
        definition: definePlugin({
          name: 'parent',
          uses: { plugins: pluginsService },
          async apply({ plugins }) {
            await plugins.require().register(child);
          },
        }),
      },
    ]);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('child')?.state).toBe('active');
  });
});
