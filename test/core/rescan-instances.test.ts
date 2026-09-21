import { afterEach, describe, expect, it } from 'vitest';
import { App, definePlugin, type PluginDefinition, type PluginDescriptor } from '../../packages/core/src/index.js';

// rescanPlugins 与 autoLoadPlugins 共用配置键里的 name:suffix 循环：
// 市场热激活走 rescan，不得比引导少登记 yaml 里的额外实例。

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const NAME = 'rs-scan';
const def = definePlugin({ name: NAME, reusable: true, apply() {} });

function loader(): { discover(): Promise<PluginDescriptor[]>; load(): Promise<PluginDefinition> } {
  return {
    async discover() {
      return [{ name: NAME, source: 'mem', metadata: {} }];
    },
    async load() {
      return def;
    },
  };
}

describe('rescanPlugins 对配置里的 name:suffix', () => {
  it('autoLoadPlugins 会登记配置里的后缀实例', async () => {
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { [`${NAME}:work`]: { k: 1 } } },
      pluginLoader: loader(),
    });
    apps.push(app);
    await app.autoLoadPlugins();
    expect(app.plugins.getPlugin(NAME)?.state).toBe('active');
    expect(app.plugins.getPlugin(`${NAME}:work`)?.state, '引导路径应收齐后缀实例').toBe('active');
  });

  it('rescanPlugins（市场安装热激活路径）同样应收齐配置里的后缀实例', async () => {
    const app = new App({
      config: { name: 'T', logLevel: 'error', plugins: { [`${NAME}:work`]: { k: 1 } } },
      pluginLoader: loader(),
    });
    apps.push(app);
    await app.rescanPlugins();
    await app.plugins.idle();
    expect(app.plugins.getPlugin(NAME)?.state).toBe('active');
    expect(
      app.plugins.getPlugin(`${NAME}:work`)?.state,
      '市场热激活走 rescan，不得比 autoLoad 少登记配置里的多实例',
    ).toBe('active');
  });
});
