import { afterEach, describe, expect, it } from 'vitest';
import { App, appService, definePlugin, pluginsService, services } from '../../packages/core/src/index.js';

// App 的两项宿主服务由提供方控制暴露面：只交出契约列出的方法，App / PluginManager 本体不进容器（app 看提供者本身，
// plugins 的提供者是「身份 → 门面」，看它交出的门面）。
// 配置文档（host-config）不在 core：由宿主登记，见 test/runtime/config-store.test.ts。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});
function world() {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  return app;
}
const keysOf = (value: unknown) => Object.keys(value as object).sort();

describe('宿主服务只交出契约方法', () => {
  it('app：只有 stop，拿不到注册表与根绑定', () => {
    const app = world();
    const svc = app.bind({ services }).services.use.get(appService);
    expect(keysOf(svc)).toEqual(['stop']);
    const raw = svc as unknown as Record<string, unknown>;
    expect(raw.services).toBeUndefined();
    expect(raw.bind).toBeUndefined();
  });

  it('plugins：契约方法齐全、无停机开关', () => {
    const app = world();
    expect(typeof app.bind({ services }).services.use.get(pluginsService), '容器里是「身份 → 门面」').toBe('function');
    const raw = app.bind({ plugins: pluginsService }).plugins.use;
    expect(keysOf(raw)).toEqual(
      [
        'bounce',
        'disable',
        'enable',
        'getPlugin',
        'getStatus',
        'idle',
        'register',
        'unload',
        'updateConfig',
        'watch',
      ].sort(),
    );
    expect((raw as unknown as Record<string, unknown>).beginShutdown).toBeUndefined();
  });

  it('宿主侧 app.plugins 是同一组契约方法：拿不到重算、停机开关与注册表', () => {
    const app = world();
    expect(keysOf(app.plugins)).toEqual(keysOf(app.bind({ plugins: pluginsService }).plugins.use));
    const raw = app.plugins as unknown as Record<string, unknown>;
    for (const internal of ['recompute', 'beginShutdown', 'stopAll', 'registerAll', 'ready']) {
      expect(raw[internal], internal).toBeUndefined();
    }
  });

  it('宿主侧 app.plugins.getPlugin 也是调用时刻的浅快照：写它进不了注册表；config 每次是一份拷贝，definition 是登记时那个对象', async () => {
    const app = world();
    await app.plugin(definePlugin({ name: 'p', apply() {} }), { v: 1 });
    await app.plugins.idle();
    const snap = app.plugins.getPlugin('p')!;
    expect(keysOf(snap)).toEqual(['config', 'definition', 'error', 'failure', 'instanceId', 'state']);
    snap.state = 'disabled';
    const now = app.plugins.getPlugin('p')!;
    expect(now.state).toBe('active');
    expect(now.config).toEqual(snap.config);
    expect(now.config).not.toBe(snap.config);
    expect(now.definition).toBe(snap.definition);
  });

  it('core 不登记 host-config：没有宿主时服务表里没有配置文档', () => {
    const app = world();
    expect(app.bind({ services }).services.use.get('host-config')).toBeUndefined();
  });
});
