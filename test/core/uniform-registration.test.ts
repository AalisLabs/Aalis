import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  events,
  lifecycle,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';

declare module '@aalis/core' {
  interface AalisEvents {
    't:uniform:ping': [];
    't:uniform:cut': [];
    't:uniform:manual': [];
  }
}

// 内置八项与第三方服务同一种登记：根激活经 provide 独占登记，提供者是「身份 → 门面」，
// 只认在 uses 里声明过本服务的激活。原语登记按身份归属，拆卸时同栈整体切断。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const app = new App({ config: { name: 't', logLevel: 'error', plugins: {} }, devMode: false });
  apps.push(app);
  return app;
}
/** 只为测试造的描述符：把资源口的身份交给 apply，模拟拿到凭据的调用方 */
const me = defineService<unknown, symbol>('t:uniform:me', port => port.identity);

const BUILTINS = ['events', 'hooks', 'contributions', 'lifecycle', 'logger', 'config', 'provide', 'services'];

describe('内置服务与第三方同一种登记', () => {
  it('八项都由根激活独占登记，第三方不能顶替，服务页看到的元数据与宿主服务同形', () => {
    const app = world();
    const host = app.bind({ provide, services });
    for (const name of [...BUILTINS, 'app', 'plugins', 'host-config']) {
      expect(host.services.inspect(name), name).toEqual([
        expect.objectContaining({ contextId: 'root', exclusive: true }),
      ]);
    }
    expect(() => host.provide(events, () => ({}) as never)).toThrow('独占');
  });

  it('只声明 services：动态查到的内置提供者对未声明者一律拒绝，凭自己的身份也不行', async () => {
    const app = world();
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'sneaky',
        uses: { services, me: optional(me) },
        apply({ services, me }) {
          const eventsProvider = services.get(events)!;
          const provideProvider = services.get(provide)!;
          for (const attempt of [
            () => eventsProvider(me),
            () => provideProvider(me),
            () => eventsProvider(Symbol('x')),
          ]) {
            try {
              attempt();
              seen.push('ok');
            } catch (error) {
              seen.push(String((error as Error).message));
            }
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('sneaky')?.state).toBe('active');
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s).toContain('只能由在 uses 里声明了它的激活取用');
  });

  it('声明了 events 的插件经动态查询以自己身份登记的监听同样归自己、卸载即切断', async () => {
    const app = world();
    let hits = 0;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { services, events, me: optional(me) },
        apply({ services, me }) {
          services.get(events)!(me).on('t:uniform:ping', () => {
            hits++;
          });
        },
      }),
    );
    await app.plugins.idle();
    const host = app.bind({ events });
    await host.events.emit('t:uniform:ping');
    await app.plugins.unload('p');
    await host.events.emit('t:uniform:ping');
    expect(hits).toBe(1);
  });
});

describe('四原语按身份整体切断，不逐条记清理链', () => {
  it('本激活的跟随清理与 onDispose 运行时，自己的监听、中间件与服务登记已不可见', async () => {
    const app = world();
    const S = defineService<{ v: number }>('t:uniform:s');
    const Mine = defineService<{ v: number }>('t:uniform:mine');
    const host = app.bind({ provide, services, events });
    host.provide(S, { v: 1 });
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'cut',
        uses: { events, provide, lifecycle, s: S },
        apply({ events, provide, lifecycle, s }) {
          events.on('t:uniform:cut', () => void seen.push('handler fired'));
          provide(Mine, { v: 2 });
          const probe = (where: string) => {
            void events.emit('t:uniform:cut');
            seen.push(`${where} mine=${host.services.get(Mine) ? 'visible' : 'gone'}`);
          };
          s.follow(() => () => probe('follow-cleanup'));
          lifecycle.onDispose(() => probe('onDispose'));
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('cut');
    expect(seen).toEqual(['follow-cleanup mine=gone', 'onDispose mine=gone']);
  });

  it('手动退订直接撤原语登记：退订后监听不再触发、服务条目消失并发出下线通知，清理链不留条目', async () => {
    const app = world();
    const S = defineService<{ v: number }>('t:uniform:manual');
    const gone: string[] = [];
    const host = app.bind({ events, services });
    host.events.on('service:unregistered', name => void gone.push(name));
    let hits = 0;
    let off!: () => void;
    let offEvent!: () => void;
    await app.plugin(
      definePlugin({
        name: 'manual',
        uses: { events, provide },
        apply({ events, provide }) {
          off = provide(S, { v: 1 });
          offEvent = events.on('t:uniform:manual', () => {
            hits++;
          });
        },
      }),
    );
    await app.plugins.idle();
    await host.events.emit('t:uniform:manual');
    offEvent();
    await host.events.emit('t:uniform:manual');
    expect(hits).toBe(1);
    expect(host.services.get(S)).toEqual({ v: 1 });
    off();
    expect(host.services.get(S)).toBeUndefined();
    await Promise.resolve();
    expect(gone).toEqual([S.name]);
    off();
    await Promise.resolve();
    expect(gone, '重复退订不重复通知').toEqual([S.name]);
  });
});
