import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  definePlugin,
  defineService,
  lifecycle,
  logger,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';

// 内置五项与第三方服务同一种登记：根激活经 provide 独占登记，提供者是「身份 → 门面」，
// 认得出调用方的激活就交出它的门面。原语登记按身份归属，拆卸时同栈整体切断。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const app = new App({ name: 't', logLevel: 'error', devMode: false });
  apps.push(app);
  return app;
}
/** 只为测试造的描述符：把资源口的身份交给 apply，供以调用方自己的身份调用内置提供者 */
const me = defineService<unknown, symbol>('t:uniform:me', port => port.identity);

const BUILTINS = ['lifecycle', 'logger', 'config', 'provide', 'services'];

describe('内置服务与第三方同一种登记', () => {
  it('五项都由根激活独占登记，第三方不能顶替，服务页看到的元数据与宿主服务同形', () => {
    const app = world();
    const host = app.bind({ provide, services });
    for (const name of [...BUILTINS, 'app', 'plugins']) {
      expect(host.services.use.inspect(name), name).toEqual([
        expect.objectContaining({ contextId: 'root', exclusive: true }),
      ]);
    }
    expect(() => host.provide.use(logger, () => ({}) as never)).toThrow('独占');
  });

  it('只声明 services：动态查到的内置提供者凭自己的身份交出自己的门面，认不出的身份一律拒绝', async () => {
    const app = world();
    let ownId: string | undefined;
    let unknown: unknown;
    await app.plugin(
      definePlugin({
        name: 'lookup',
        uses: { services, me: optional(me) },
        apply({ services, me }) {
          ownId = services.use.get(lifecycle)!(me.use).id;
          try {
            services.use.get(logger)!(Symbol('x'));
          } catch (error) {
            unknown = error;
          }
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('lookup')?.state).toBe('active');
    expect(ownId).toBe('lookup');
    expect(String(unknown)).toContain('内置服务 "logger" 收到的身份不属于任何在册的激活');
  });

  it('经动态查询以自己身份取到的 provide 登记的服务同样归自己、卸载即撤回', async () => {
    const app = world();
    const S = defineService<{ v: number }>('t:uniform:dynamic');
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { services, me: optional(me) },
        apply({ services, me }) {
          services.use.get(provide)!(me.use)(S, { v: 1 });
        },
      }),
    );
    await app.plugins.idle();
    const host = app.bind({ services });
    expect(host.services.use.inspect(S)).toEqual([expect.objectContaining({ contextId: 'p' })]);
    await app.plugins.unload('p');
    expect(host.services.use.get(S)).toBeUndefined();
  });
});

describe('原语登记按身份整体切断，不逐条记清理链', () => {
  it('本激活的跟随清理与 onDispose 运行时，自己的服务登记已不可见', async () => {
    const app = world();
    const S = defineService<{ v: number }>('t:uniform:s');
    const Mine = defineService<{ v: number }>('t:uniform:mine');
    const host = app.bind({ provide, services });
    host.provide.use(S, { v: 1 });
    const seen: string[] = [];
    await app.plugin(
      definePlugin({
        name: 'cut',
        uses: { provide, lifecycle, s: S },
        apply({ provide, lifecycle, s }) {
          provide.use(Mine, { v: 2 });
          const probe = (where: string) =>
            void seen.push(`${where} mine=${host.services.use.get(Mine) ? 'visible' : 'gone'}`);
          s.follow(() => () => probe('follow-cleanup'));
          lifecycle.use.onDispose(() => probe('onDispose'));
        },
      }),
    );
    await app.plugins.idle();
    await app.plugins.unload('cut');
    expect(seen).toEqual(['follow-cleanup mine=gone', 'onDispose mine=gone']);
  });

  it('手动退订直接撤原语登记：退订后服务条目消失并发出变更通知', async () => {
    const app = world();
    const S = defineService<{ v: number }>('t:uniform:manual');
    const gone: string[] = [];
    const host = app.bind({ services, s: optional(S) });
    host.s.watch(() => void gone.push(S.name));
    let off!: () => void;
    await app.plugin(
      definePlugin({
        name: 'manual',
        uses: { provide },
        apply({ provide }) {
          off = provide.use(S, { v: 1 });
        },
      }),
    );
    await app.plugins.idle();
    expect(host.services.use.get(S)).toEqual({ v: 1 });
    gone.length = 0;
    off();
    expect(host.services.use.get(S)).toBeUndefined();
    await Promise.resolve();
    expect(gone).toEqual([S.name]);
  });
});
