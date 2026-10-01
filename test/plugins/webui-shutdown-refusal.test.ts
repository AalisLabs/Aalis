import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  type App,
  appService,
  definePlugin,
  optional,
  type PluginDefinition,
  pluginsService,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import type { ConfigProvider } from '../../packages/runtime/src/config-store.js';
import { hostedApp } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// 停机开始后 core 的管理动作一律返回 false。插件还在注册表里时，路由要回「拒绝」（409），不能说插件不存在。
// 真实 App + 真实路由，配置落盘用内存 provider；不起端口、不连任何外部服务。

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function world(config: Partial<AalisConfig>) {
  const saved: AalisConfig[] = [];
  const provider: ConfigProvider = { save: snapshot => void saved.push(structuredClone(snapshot)) };
  const { app, store } = hostedApp(config, { logger: silent, provider });
  apps.push(app);
  const { expressApp, invoke } = captureRoutes();
  const panel = definePlugin({
    name: 'console',
    uses: { app: optional(appService), plugins: optional(pluginsService), hostConfig: optional(hostConfig) },
    apply(caps) {
      registerPluginRoutes(
        expressApp,
        {
          ...caps,
          source: { current: undefined },
          tools: { current: undefined },
          commands: { current: undefined },
          webui: () => undefined,
        },
        () => ({ platform: 'webui', userId: 'console' }),
        () => (_req: unknown, _res: unknown, next: () => void) => next(),
        () => undefined,
      );
    },
  });
  const call = (key: string, params: Record<string, string>, body: unknown = {}) =>
    invoke(key, { params, body, headers: {} });
  return {
    app,
    store,
    saved,
    async boot(...definitions: PluginDefinition[]) {
      await app.pluginAll(
        [panel, ...definitions].map(definition => ({
          definition,
          config: store.getPluginConfig(definition.name),
          disabled: store.isPluginDisabled(definition.name),
        })),
      );
      await app.plugins.idle();
    },
    enable: (name: string) => call('POST /api/plugins/:name/enable', { name }),
    disable: (name: string) => call('POST /api/plugins/:name/disable', { name }),
    put: (name: string, config: unknown) => call('PUT /api/plugins/:name/config', { name }, { config }),
  };
}

const target = definePlugin({
  name: 'target',
  configSchema: { v: { type: 'number', label: 'V', default: 0 } },
  apply() {},
});
const off = definePlugin({ name: 'off', apply() {} });

describe('停机中的启用、禁用、改配置', () => {
  it('插件还在注册表里：回 409，说明被拒、配置未更改，文档与文件都不动', async () => {
    const w = world({
      name: 'T',
      logLevel: 'error',
      plugins: { target: { v: 1 }, off: {} },
      disabledPlugins: ['off'],
    });
    await w.boot(target, off);
    const stopping = w.app.stop();
    try {
      const replies = [await w.enable('off'), await w.disable('target'), await w.put('target', { v: 5 })];
      for (const reply of replies) {
        expect(reply.status).toBe(409);
        expect(JSON.stringify(reply.body)).toContain('配置未更改');
        expect(JSON.stringify(reply.body)).not.toContain('不存在');
      }
      expect(w.saved).toHaveLength(0);
      expect(w.store.isPluginDisabled('off')).toBe(true);
      expect(w.store.getPluginConfig('target')).toEqual({ v: 1 });
    } finally {
      await stopping;
    }
  });

  it('插件不存在：仍回 404', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} });
    await w.boot();
    for (const reply of [await w.enable('ghost'), await w.disable('ghost'), await w.put('ghost', {})]) {
      expect(reply.status).toBe(404);
      expect(JSON.stringify(reply.body)).toContain('不存在');
    }
  });
});
