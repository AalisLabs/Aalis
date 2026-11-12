import { afterEach, describe, expect, it } from 'vitest';
import { App, type AppOptions, definePlugin, lifecycle } from '../../packages/core/src/index.js';

// ════════════════════════════════════════════════════════════
// App.stopping：应用是否已开始停机，给持有 App 本体的宿主读。
//   - 运行中是 false；stop() 一开始即 true（重启策略发起的停机也一样），停完之后不变；
//   - 插件的 lifecycle 只有本激活的五项，不带应用整体的状态：收尾与清理做什么，不因整机停机还是单独停用而不同。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world(options: Partial<AppOptions> = {}) {
  const app = new App({ name: 'T', logLevel: 'error', ...options });
  apps.push(app);
  return app;
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('App.stopping', () => {
  it('运行中是 false，单独停用、重启插件不改它；stop() 返回之前已是 true，停完之后不变', async () => {
    const app = world();
    await app.plugin(definePlugin({ name: 'p', apply() {} }));
    expect(app.stopping).toBe(false);
    await app.plugins.bounce('p');
    await app.plugins.disable('p');
    expect(app.stopping).toBe(false);
    const stopping = app.stop();
    expect(app.stopping, 'stop() 返回之前就已置上').toBe(true);
    await stopping;
    expect(app.stopping).toBe(true);
  });

  it('重启已受理、策略还没开始停机时仍是 false；策略调交给它的 stop 之后是 true', async () => {
    let strategyStop: (() => Promise<void>) | undefined;
    const app = world({
      restartStrategy: {
        restart: ({ stop }) => {
          strategyStop = stop;
        },
      },
    });
    app.restart();
    // 策略在下一拍才拿到 stop
    await tick();
    expect(app.stopping).toBe(false);
    const stopping = strategyStop!();
    expect(app.stopping).toBe(true);
    await stopping;
  });

  it('停机一开始就读得到：仍在初始化的插件在取消信号的监听器里读到 true', async () => {
    const app = world();
    let atAbort: boolean | undefined;
    void app.plugin(
      definePlugin({
        name: 'initializing',
        uses: { lifecycle },
        apply({ lifecycle }) {
          lifecycle.use.signal.addEventListener('abort', () => {
            atAbort = app.stopping;
          });
          return new Promise<void>(resolve => lifecycle.use.signal.addEventListener('abort', () => resolve()));
        },
      }),
    );
    await tick();
    expect(app.plugins.getStatus()[0].state).toBe('activating');
    await app.stop();
    expect(atAbort).toBe(true);
  });
});

describe('lifecycle 不带应用整体的状态', () => {
  it('插件与宿主根拿到的 lifecycle 都只有 id、signal、onReady、onDrain、onDispose', async () => {
    const app = world();
    let members: string[] | undefined;
    await app.plugin(
      definePlugin({
        name: 'p',
        uses: { lifecycle },
        apply({ lifecycle }) {
          members = Object.keys(lifecycle.use).sort();
        },
      }),
    );
    const five = ['id', 'onDispose', 'onDrain', 'onReady', 'signal'];
    expect(members).toEqual(five);
    expect(Object.keys(app.bind({ lifecycle }).lifecycle.use).sort()).toEqual(five);
  });
});
