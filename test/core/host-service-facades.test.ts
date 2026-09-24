import { afterEach, describe, expect, it } from 'vitest';
import { App, appService, definePlugin, lifecycle, pluginsService, services } from '../../packages/core/src/index.js';

// App 的两项宿主服务由提供方控制暴露面：只交出契约列出的方法，App / PluginManager 本体不进容器。
// 配置文档（host-config）不在 core：由宿主登记，见 test/runtime/config-store.test.ts。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const app = new App({ name: 't', logLevel: 'error', devMode: false });
  apps.push(app);
  return app;
}
const keysOf = (value: unknown) => Object.keys(value as object).sort();

describe('宿主服务只交出契约方法', () => {
  it('app：只有 stop / restart，拿不到注册表与根绑定', () => {
    const app = world();
    const { appService: svc } = app.bind({ appService });
    expect(keysOf(svc.require())).toEqual(['restart', 'stop']);
    const raw = svc.require() as unknown as Record<string, unknown>;
    expect(raw.services).toBeUndefined();
    expect(raw.bind).toBeUndefined();
  });

  it('plugins：契约方法齐全、无停机开关；getPlugin 返回不含激活记录的快照', async () => {
    const app = world();
    const { pluginsService: svc } = app.bind({ pluginsService });
    expect(keysOf(svc.require())).toEqual(
      ['bounce', 'disable', 'enable', 'getPlugin', 'getStatus', 'idle', 'register', 'unload', 'updateConfig'].sort(),
    );
    expect((svc.require() as unknown as Record<string, unknown>).beginShutdown).toBeUndefined();
    await app.plugin(definePlugin({ name: 'p', uses: { lifecycle }, apply() {} }));
    await app.plugins.idle();
    const entry = svc.require().getPlugin('p');
    expect(entry?.state).toBe('active');
    expect(keysOf(entry)).not.toContain('activation');
    expect(app.plugins.getPlugin('p')).not.toBe(entry);
  });

  it('core 不登记 host-config：没有宿主时服务表里没有配置文档', () => {
    const app = world();
    expect(app.bind({ services }).services.get('host-config')).toBeUndefined();
  });
});
