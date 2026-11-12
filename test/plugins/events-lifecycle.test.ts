import { afterEach, describe, expect, it } from 'vitest';
import { type Events, events } from '../../packages/api-events/src/index.js';
import { App, definePlugin, type Logger, lifecycle, provide, services } from '../../packages/core/src/index.js';
import eventsPlugin, { Bus } from '../../packages/plugin-events/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createActivationFixture } from '../helpers/activation.js';

// ════════════════════════════════════════════════════════════
// events 门面随插件激活的登记与撤回，以及提供者不在、重启、换人时的行为：经真实 App + plugin-events 驱动。
//   - 监听器归登记它的那次激活：卸载即撤回，关闭时与服务登记同一拍切断，关闭后的登记拒收；
//   - 没有提供者时 emit 什么都不做，on 的登记留在归属表里、提供者上线后挂上；
//   - 监听器抛错由 plugin-events 的日志器点名登记方；
//   - 提供者重启：required 依赖方随之重启，宿主根的登记重挂到新总线；
//   - 第二个提供者以更高优先级上线：依赖方不重启，归属表整批重挂，派发次序不变。
// 事件名 'zz:named'、'zz:plain' 经 declaration merging 登记在 test/fixtures/zz-events.ts。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world(logger?: Logger): App {
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  return app;
}

async function withHubs(logger?: Logger): Promise<App> {
  const app = world(logger);
  await registerHubs(app);
  return app;
}

/** 在 'zz:named' 上登记一个把「自己的名字:收到的名字」记进 trail 的监听器；门面留给用例在运行期再登记 */
function listener(name: string, trail: string[], applied: string[] = [], facades?: Map<string, Events>) {
  return definePlugin({
    name,
    uses: { events },
    apply({ events }) {
      applied.push(name);
      facades?.set(name, events.use);
      events.use.on('zz:named', given => void trail.push(`${name}:${given}`));
    },
  });
}

describe('监听器归登记它的那次激活', () => {
  it('on 登记的监听器收到 emit；插件卸载后撤回，兄弟插件的不动', async () => {
    const app = await withHubs();
    const trail: string[] = [];
    await app.pluginAll([listener('a', trail), listener('b', trail)].map(definition => ({ definition })));
    await app.plugins.idle();
    const host = app.bind({ events });
    await host.events.use.emit('zz:named', '1');
    expect(trail).toEqual(['a:1', 'b:1']);

    await app.plugins.unload('a');
    trail.length = 0;
    await host.events.use.emit('zz:named', '2');
    expect(trail).toEqual(['b:2']);
  });

  it('手动退订只撤这一条；同一函数登记两次各算各的', async () => {
    const app = await withHubs();
    const host = app.bind({ events });
    let calls = 0;
    const fn = () => void calls++;
    const offFirst = host.events.use.on('zz:plain', fn);
    host.events.use.on('zz:plain', fn);
    await host.events.use.emit('zz:plain');
    expect(calls).toBe(2);
    offFirst();
    offFirst();
    await host.events.use.emit('zz:plain');
    expect(calls).toBe(3);
  });

  it('两个插件用同一个函数监听同一事件：各算各的，卸载一个不影响另一个', async () => {
    const app = await withHubs();
    let calls = 0;
    const shared = () => void calls++;
    const sharing = (name: string) =>
      definePlugin({ name, uses: { events }, apply: ({ events }) => void events.use.on('zz:plain', shared) });
    await app.pluginAll([{ definition: sharing('l') }, { definition: sharing('r') }]);
    await app.plugins.idle();
    const host = app.bind({ events });
    await host.events.use.emit('zz:plain');
    expect(calls).toBe(2);
    await app.plugins.unload('l');
    await host.events.use.emit('zz:plain');
    expect(calls, '左边卸载后右边的登记仍在').toBe(3);
  });

  it('门面不外露总线：只有 on 与 emit，不是提供者本身', async () => {
    const app = await withHubs();
    const host = app.bind({ events, services });
    expect(host.events.use).not.toBe(host.services.use.get(events));
    expect(Object.keys(host.events.use).sort()).toEqual(['emit', 'on']);
  });

  it('关闭时与服务登记同一拍切断：清理还没跑完的这段时间里，本激活的监听器已不再收到事件', async () => {
    const root = createActivationFixture();
    root.caps.provide.use(events, new Bus());
    const dying = root.host.create('dying');
    const caps = root.host.bind(dying, { events, lifecycle });
    const host = root.host.bind(root.activation, { events });
    let hits = 0;
    caps.events.use.on('zz:plain', () => void hits++);
    await host.events.use.emit('zz:plain');
    expect(hits, '对照：关闭前收得到').toBe(1);

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const inDispose = new Promise<void>(resolve => {
      entered = resolve;
    });
    caps.lifecycle.use.onDispose(async () => {
      entered();
      await gate;
    }, 'slow');
    const closing = dying.disposeAsync(5000);
    await inDispose;
    await host.events.use.emit('zz:plain');
    expect(hits, '清理段还卡着，监听器已经撤回').toBe(1);
    release();
    await closing;
  });

  it('关闭之后再登记：拒收并记 warn，返回的退订是空操作', async () => {
    const warns: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
      error() {},
      child: () => logger,
    };
    const app = await withHubs(logger);
    let facade!: Events;
    await app.plugin(
      definePlugin({
        name: 'late',
        uses: { events },
        apply: ({ events }) => {
          facade = events.use;
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('late');
    let hits = 0;
    const off = facade.on('zz:plain', () => void hits++);
    expect(() => off()).not.toThrow();
    await app.bind({ events }).events.use.emit('zz:plain');
    expect(hits).toBe(0);
    expect(warns.some(line => line.includes('late') && line.includes('zz:plain'))).toBe(true);
  });
});

describe('没有提供者', () => {
  it('emit 什么都不做、照常兑现（不抛、不拒）', async () => {
    const app = world();
    const host = app.bind({ events });
    expect(host.events.present).toBe(false);
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = host.events.use.emit('zz:named', 'x');
    }).not.toThrow();
    await expect(pending).resolves.toBeUndefined();
  });

  it('提供者上线之前登记的监听器留在归属表里，上线后挂上；之前发的事件不补发', async () => {
    const app = world();
    const host = app.bind({ events });
    const got: string[] = [];
    host.events.use.on('zz:named', name => void got.push(name));
    await host.events.use.emit('zz:named', 'early');
    await app.plugin(eventsPlugin);
    await app.plugins.idle();
    await host.events.use.emit('zz:named', 'late');
    expect(got).toEqual(['late']);
  });
});

describe('监听器抛错', () => {
  it('由 plugin-events 的日志器记 warn，点名事件与登记方、附上错误对象；其余监听器照常收到，emit 照常兑现', async () => {
    const warns: unknown[][] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void warns.push(args),
      error() {},
      child: () => logger,
    };
    const app = await withHubs(logger);
    const trail: string[] = [];
    const boom = new Error('boom');
    await app.pluginAll(
      [
        definePlugin({
          name: 'thrower',
          uses: { events },
          apply: ({ events }) =>
            void events.use.on('zz:named', () => {
              throw boom;
            }),
        }),
        listener('after', trail),
      ].map(definition => ({ definition })),
    );
    await app.plugins.idle();
    await expect(app.bind({ events }).events.use.emit('zz:named', 'x')).resolves.toBeUndefined();
    expect(trail).toEqual(['after:x']);
    expect(warns).toEqual([['事件 "zz:named" 的监听器抛错（已隔离，来自 thrower）:', boom]]);
  });
});

describe('提供者重启', () => {
  it('required 依赖方随之重启并重新登记；宿主根不重启，它的登记重挂到新总线', async () => {
    const trail: string[] = [];
    const applied: string[] = [];
    const app = await withHubs();
    const host = app.bind({ events });
    host.events.use.on('zz:named', name => void trail.push(`root:${name}`));
    await app.pluginAll([listener('a', trail, applied), listener('b', trail, applied)].map(d => ({ definition: d })));
    await app.plugins.idle();
    await host.events.use.emit('zz:named', '1');
    expect(trail).toEqual(['root:1', 'a:1', 'b:1']);

    expect(await app.plugins.bounce('@aalis/plugin-events')).toBe(true);
    await app.plugins.idle();
    expect(applied, '两个 required 依赖方都随提供者重启').toEqual(['a', 'b', 'a', 'b']);
    trail.length = 0;
    await host.events.use.emit('zz:named', '2');
    expect(trail, '各收到一次：旧登记没有留在新总线上').toEqual(['root:2', 'a:2', 'b:2']);
  });
});

describe('第二个提供者以更高优先级上线', () => {
  it('依赖方不重启，归属表整批重挂到新总线；派发次序与换人前相同', async () => {
    const trail: string[] = [];
    const applied: string[] = [];
    const facades = new Map<string, Events>();
    const app = await withHubs();
    await app.pluginAll(
      [listener('a', trail, applied, facades), listener('b', trail, applied, facades)].map(d => ({ definition: d })),
    );
    await app.plugins.idle();
    // a 在 b 之后再登记一条：按位次排，a 的两条都在 b 之前
    facades.get('a')?.on('zz:named', name => void trail.push(`a2:${name}`));
    const host = app.bind({ events, services });
    await host.events.use.emit('zz:named', '1');
    expect(trail).toEqual(['a:1', 'a2:1', 'b:1']);

    const alt = new Bus();
    await app.plugin(
      definePlugin({
        name: 'alt-events',
        uses: { provide },
        provides: [events],
        apply: ({ provide }) => void provide.use(events, alt, { priority: 10 }),
      }),
    );
    await app.plugins.idle();
    expect(host.services.use.get(events), '胜者已换成新总线').toBe(alt);
    expect(applied, '依赖方没有重启').toEqual(['a', 'b']);
    trail.length = 0;
    await host.events.use.emit('zz:named', '2');
    expect(trail, '新总线上次序相同，各收到一次').toEqual(['a:2', 'a2:2', 'b:2']);
  });

  it('换人那次 provide 返回时各归属表已重挂到新总线：同一拍发的事件照样送达', async () => {
    const app = await withHubs();
    const trail: string[] = [];
    await app.plugin(listener('a', trail));
    await app.plugins.idle();
    const host = app.bind({ events, provide });
    host.provide.use(events, new Bus(), { priority: 10, entryId: 'root/alt-events' });
    await host.events.use.emit('zz:named', 'same-tick');
    expect(trail).toEqual(['a:same-tick']);
  });
});
