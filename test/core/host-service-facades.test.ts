import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  appService,
  definePlugin,
  hostConfig,
  lifecycle,
  pluginsService,
  provide,
} from '../../packages/core/src/index.js';

// 宿主三服务由提供方控制暴露面：只交出契约列出的方法，App / PluginManager / ConfigManager 本体不进容器。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const app = new App({ config: { name: 't', logLevel: 'error', plugins: {} }, devMode: false });
  apps.push(app);
  return app;
}
const keysOf = (value: unknown) => Object.keys(value as object).sort();

describe('宿主服务只交出契约方法', () => {
  it('app：只有 stop / restart / saveConfig / rescanPlugins，拿不到注册表与根绑定', () => {
    const app = world();
    const { appService: svc } = app.bind({ appService });
    expect(keysOf(svc.require())).toEqual(['rescanPlugins', 'restart', 'saveConfig', 'stop']);
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

  it('host-config：整份配置读写面，无 watch / unwatch / save；落盘走 app.saveConfig', async () => {
    const app = world();
    const { hostConfig: cfg, appService: svc } = app.bind({ hostConfig, appService, provide });
    const host = cfg.require() as unknown as Record<string, unknown>;
    for (const forbidden of ['watch', 'unwatch', 'reloadFrom', 'save']) expect(host[forbidden]).toBeUndefined();
    cfg.require().setPluginConfig('p', { a: 1 });
    expect(app.config.getPluginConfig('p')).toEqual({ a: 1 });
    cfg.require().setServicePreference('svc', 'ctx');
    expect(cfg.require().getServicePreferences()).toEqual({ svc: 'ctx' });
    await expect(svc.require().saveConfig()).resolves.toBeUndefined();
  });
});
