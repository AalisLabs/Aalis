declare module '@aalis/api-hooks' {
  interface HookContextMap {
    '__t:lifecycle-hook': { trail: string[] };
  }
}

import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { App, definePlugin, type Logger, services } from '../../packages/core/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// hooks 门面随插件激活的登记与撤回：经真实 App + plugin-hooks 驱动。
// 钩子名 '__t:lifecycle-hook' 经真实的 declaration merging 登记进 @aalis/api-hooks 的 HookContextMap——
// 未登记的名字在类型上不被接受，这里顺带钉住「第三方能自己扩钩子」这条契约。
// 撤回时机与关闭后登记的政策属于资源口账本，在 test/core 用测试枢纽锚定。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
async function makeApp() {
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  await registerHubs(app);
  return app;
}
async function expectActive(app: App, id: string) {
  await app.plugins.idle();
  expect(app.plugins.getPlugin(id)?.state).toBe('active');
}
/** 在 '__t:lifecycle-hook' 上登记一个记名、放行的中间件 */
function tracer(name: string) {
  return definePlugin({
    name,
    uses: { hooks },
    apply({ hooks }) {
      hooks.middleware('__t:lifecycle-hook', async (data, next) => {
        data.trail.push(name);
        await next();
      });
    },
  });
}

describe('hooks 门面：插件登记随卸载清扫', () => {
  it('middleware 参与 run（可改 data、走到底返回 true），插件卸载后自动清扫', async () => {
    const app = await makeApp();
    await app.plugin(tracer('plugin-a'));
    await expectActive(app, 'plugin-a');

    const host = app.bind({ hooks });
    const first = { trail: [] as string[] };
    expect(await host.hooks.run('__t:lifecycle-hook', first)).toBe(true);
    expect(first.trail).toEqual(['plugin-a']);

    await app.plugins.unload('plugin-a');
    const second = { trail: [] as string[] };
    await host.hooks.run('__t:lifecycle-hook', second);
    expect(second.trail).toEqual([]);
  });

  it('卸载只清扫本插件的 middleware，不动兄弟插件的', async () => {
    const app = await makeApp();
    await app.plugin(tracer('plugin-a'));
    await app.plugin(tracer('plugin-b'));
    await expectActive(app, 'plugin-a');
    await expectActive(app, 'plugin-b');

    await app.plugins.unload('plugin-a');
    const data = { trail: [] as string[] };
    await app.bind({ hooks }).hooks.run('__t:lifecycle-hook', data);
    expect(data.trail).toEqual(['plugin-b']);
  });

  it('同一插件在同一钩子上登记多个 middleware：各自成条、按登记顺序执行，不互相顶替', async () => {
    const app = await makeApp();
    await app.plugin(
      definePlugin({
        name: 'plugin-a',
        uses: { hooks },
        apply({ hooks }) {
          for (const tag of ['a1', 'a2']) {
            hooks.middleware('__t:lifecycle-hook', async (data, next) => {
              data.trail.push(tag);
              await next();
            });
          }
        },
      }),
    );
    await expectActive(app, 'plugin-a');
    const data = { trail: [] as string[] };
    await app.bind({ hooks }).hooks.run('__t:lifecycle-hook', data);
    expect(data.trail).toEqual(['a1', 'a2']);
  });

  it('middleware 返回的退订可手动解除', async () => {
    const app = await makeApp();
    let off!: () => void;
    await app.plugin(
      definePlugin({
        name: 'plugin-a',
        uses: { hooks },
        apply({ hooks }) {
          off = hooks.middleware('__t:lifecycle-hook', async (data, next) => {
            data.trail.push('a');
            await next();
          });
        },
      }),
    );
    await expectActive(app, 'plugin-a');
    const host = app.bind({ hooks });
    const first = { trail: [] as string[] };
    await host.hooks.run('__t:lifecycle-hook', first);
    off();
    const second = { trail: [] as string[] };
    await host.hooks.run('__t:lifecycle-hook', second);
    expect([first.trail, second.trail]).toEqual([['a'], []]);
  });

  it('门面不外露登记表：只有 middleware / run，没有 register', async () => {
    const app = await makeApp();
    const host = app.bind({ hooks, services });
    // 公开的是按激活绑定的门面，登记经它才盖上本激活身份、随激活撤回
    expect(host.hooks).not.toBe(host.services.get(hooks));
    expect('register' in host.hooks).toBe(false);
    expect(typeof host.hooks.run).toBe('function');
    expect(typeof host.hooks.middleware).toBe('function');
  });
});
