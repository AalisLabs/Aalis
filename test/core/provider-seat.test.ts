import { describe, expect, it } from 'vitest';
import { App, definePlugin, defineService, LogHub, provide, services } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// 同优先级的提供者按登记方的位次排：宿主的根最前，插件按实例 id 的码元序，同一登记方的几条按登记先后。
// 不看条目登记的时刻：插件重启、激活快慢、插件加进应用的先后都不改变默认是哪一家。
// ════════════════════════════════════════════════════════════

const svc = defineService<{ tag: string }>('zz-seat');

/** 提供 zz-seat 的插件：entries 里每个名字登记一条，条目 id 即名字 */
function provider(name: string, entries: string[] = [name], priority?: number) {
  return definePlugin({
    name,
    reusable: true,
    provides: [svc],
    uses: { provide },
    apply({ provide }) {
      for (const tag of entries) provide.use(svc, { tag }, { entryId: tag, priority });
    },
  });
}

async function world(...definitions: Array<ReturnType<typeof provider>>) {
  const app = new App({ name: 'T', logHub: new LogHub() });
  const host = app.bind({ provide, services, svc });
  await app.pluginAll(definitions.map(definition => ({ definition })));
  await app.plugins.idle();
  return { app, host, order: () => host.services.use.all(svc).map(view => view.contextId) };
}

describe('同优先级的提供者按登记方的位次排', () => {
  it('默认那家重启之后默认仍是它', async () => {
    const { app, host, order } = await world(provider('a'), provider('b'));
    expect(order()).toEqual(['a', 'b']);
    await app.plugins.bounce('a');
    await app.plugins.idle();
    expect(order()).toEqual(['a', 'b']);
    expect(host.svc.use.tag).toBe('a');
    await app.stop();
  });

  it('不看加进应用的先后：后登记的插件 id 在前，默认就是它', async () => {
    const { app, host, order } = await world(provider('b'));
    expect(host.svc.use.tag).toBe('b');
    await app.plugin(provider('a'));
    await app.plugins.idle();
    expect(order()).toEqual(['a', 'b']);
    expect(host.svc.use.tag).toBe('a');
    await app.stop();
  });

  it('宿主的根登记的排在所有插件之前，哪怕登记得更晚', async () => {
    const { app, host, order } = await world(provider('a'));
    host.provide.use(svc, { tag: 'host' }, { entryId: 'host' });
    expect(order()).toEqual(['host', 'a']);
    await app.stop();
  });

  it('同一个插件登记的几条按登记先后，不按条目 id', async () => {
    const { app, order } = await world(provider('m', ['z', 'y']), provider('k'));
    expect(order()).toEqual(['k', 'z', 'y']);
    await app.stop();
  });

  it('后缀实例按完整的实例 id 排在主实例之后', async () => {
    const { app, order } = await world();
    await app.plugin(provider('p', ['one']), {}, 'p:2');
    await app.plugin(provider('p', ['main']));
    await app.plugins.idle();
    expect(order()).toEqual(['main', 'one']);
    await app.stop();
  });

  it('位次由 core 按登记方给，登记时在选项里另塞一个不起作用', async () => {
    const { app, order } = await world(provider('a'));
    await app.plugin(
      definePlugin({
        name: 'z',
        provides: [svc],
        uses: { provide },
        apply: ({ provide }) => void provide.use(svc, { tag: 'z' }, { seat: '' } as never),
      }),
    );
    await app.plugins.idle();
    expect(order()).toEqual(['a', 'z']);
    await app.stop();
  });

  it('优先级仍先于位次', async () => {
    const { app, order } = await world(provider('a'), provider('b', ['b'], 10));
    expect(order()).toEqual(['b', 'a']);
    await app.stop();
  });
});
