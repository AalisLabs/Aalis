import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  appService,
  definePlugin,
  optional,
  type PluginDefinition,
  pluginsService,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { type ConfigProvider, createConfigStore } from '../../packages/runtime/src/config-store.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// 管理动作只改运行态；WebUI 的启停与改配置路由在动作成功后自己写配置文档并落盘。
// 这里用真实 App 与真实路由：按落盘的文档重建 App，状态要与重启前一致。
// 路由挂在一个插件的激活上（与 webui-server 同样经 uses 取服务），也覆盖经自己的路由禁用自己。
// 登记一律按文档取配置与禁用标记（与 runtime 发现驱动的登记同一口径），core 不读文档。

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const SAVE_REJECTED = '配置文件有尚未生效的外部修改，为免覆盖已拒绝本次保存';

const target = definePlugin({
  name: 'target',
  configSchema: { v: { type: 'number', label: 'V', default: 0 } },
  apply() {},
});

/**
 * `provideDoc: false`：宿主持有文档、照它登记，但不把它作为 host-config 交给插件。
 * `rejectSave`：落盘一律被拒（同 runtime 在配置文件有尚未生效的外部修改时拒写）。
 */
function world(config: Partial<AalisConfig>, { provideDoc = true, rejectSave = false } = {}) {
  const saved: AalisConfig[] = [];
  const provider: ConfigProvider = {
    save: snapshot => {
      if (rejectSave) throw new Error(SAVE_REJECTED);
      saved.push(structuredClone(snapshot));
    },
  };
  const { app, store } = provideDoc
    ? hostedApp(config, { logger: silent, provider })
    : {
        app: new App({ name: 'T', logLevel: 'error', logger: silent }),
        store: createConfigStore({ name: 'T', logLevel: 'error', plugins: {}, ...config }, provider),
      };
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
    createInstance: (name: string, suffix: string, config: unknown) =>
      call('POST /api/plugins/:name/instances', { name }, { suffix, config }),
    deleteInstance: (instanceId: string) => call('DELETE /api/plugins/:instanceId/instance', { instanceId }),
    putGlobal: (updates: unknown) => call('PUT /api/config', {}, updates),
  };
}

const multi = definePlugin({
  name: 'multi',
  reusable: true,
  configSchema: { v: { type: 'number', label: 'V', default: 0 } },
  apply() {},
});

/** 按最后一次落盘的文档重建 App，登记同一份定义，返回它重启后的条目 */
async function restartFrom(saved: AalisConfig[], definition: PluginDefinition) {
  const snapshot = saved.at(-1);
  if (!snapshot) throw new Error('从未落盘');
  const { app, store } = hostedApp(structuredClone(snapshot), { logger: silent });
  apps.push(app);
  await registerFromDoc(app, store, definition);
  await app.plugins.idle();
  return app.plugins.getPlugin(definition.name);
}

describe('WebUI 管理路由自己写文档并落盘，重启后状态一致', () => {
  it('禁用、启用、改配置各落盘一次，按落盘文档重建的 App 恢复同一状态', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } });
    await w.boot(target);

    expect((await w.disable('target')).status).toBe(200);
    expect(w.app.plugins.getPlugin('target')?.state).toBe('disabled');
    expect(w.store.isPluginDisabled('target')).toBe(true);
    expect(w.saved).toHaveLength(1);
    expect((await restartFrom(w.saved, target))?.state).toBe('disabled');

    expect((await w.enable('target')).status).toBe(200);
    await w.app.plugins.idle();
    expect(w.store.isPluginDisabled('target')).toBe(false);
    expect(w.saved).toHaveLength(2);
    expect((await restartFrom(w.saved, target))?.state).toBe('active');

    expect((await w.put('target', { v: 5 })).status).toBe(200);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('target')?.config).toEqual({ v: 5 });
    expect(w.store.getPluginConfig('target')).toEqual({ v: 5 });
    expect(w.saved).toHaveLength(3);
    expect((await restartFrom(w.saved, target))?.config).toEqual({ v: 5 });
  });

  it('PUT 到运行中已禁用的插件返回 409，文档不写', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } });
    await w.boot(target);
    // 直接调管理动作禁用：只改运行态，文档里仍是启用
    expect(await w.app.plugins.disable('target')).toBe(true);
    expect(w.store.isPluginDisabled('target')).toBe(false);

    const reply = await w.put('target', { v: 9 });
    expect(reply.status).toBe(409);
    expect(w.store.getPluginConfig('target')).toEqual({ v: 1 });
    expect(w.saved).toHaveLength(0);
  });

  it('经自己的路由禁用自己：激活被拆掉后仍写入文档并落盘', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} });
    await w.boot();

    expect((await w.disable('console')).status).toBe(200);
    expect(w.app.plugins.getPlugin('console')?.state).toBe('disabled');
    expect(w.store.isPluginDisabled('console')).toBe(true);
    expect(w.saved).toHaveLength(1);
  });

  it('宿主没提供 host-config：启停与改配置路由 503，运行态与文档都不动', async () => {
    const w = world({ plugins: { target: { v: 1 } } }, { provideDoc: false });
    await w.boot(target);
    expect(w.app.plugins.getPlugin('target')?.state).toBe('active');

    expect((await w.disable('target')).status).toBe(503);
    expect(w.app.plugins.getPlugin('target')?.state, '缺文档时不得先动运行态').toBe('active');
    expect((await w.put('target', { v: 5 })).status).toBe(503);
    expect(w.app.plugins.getPlugin('target')?.config).toEqual({ v: 1 });
    expect(w.store.isPluginDisabled('target')).toBe(false);
    expect(w.saved).toHaveLength(0);
  });

  it('建实例沿用文档里残留的禁用标记并写入配置落盘，删实例移除文档键并落盘', async () => {
    // 文档里残留一条实例的禁用标记（此前禁用后删掉、或手改配置留下的）
    const w = world({ name: 'T', logLevel: 'error', plugins: {}, disabledPlugins: ['multi:x'] });
    await w.boot(multi);

    const created = await w.createInstance('multi', 'x', { v: 3 });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, instanceId: 'multi:x' });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('multi:x')?.state, '残留的禁用标记要随登记生效').toBe('disabled');
    expect(w.store.getPluginConfig('multi:x')).toEqual({ v: 3 });
    expect(w.saved).toHaveLength(1);
    expect(w.saved[0].plugins['multi:x']).toEqual({ v: 3 });

    expect((await w.deleteInstance('multi:x')).status).toBe(200);
    expect(w.app.plugins.getPlugin('multi:x')).toBeUndefined();
    expect(Object.hasOwn(w.store.getAll().plugins, 'multi:x')).toBe(false);
    expect(w.saved).toHaveLength(2);
    expect(Object.hasOwn(w.saved[1].plugins, 'multi:x')).toBe(false);
  });

  it('落盘被拒：启停、改配置、实例增删都回 409 + applied，说明已在运行态生效、未写入文件', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } }, { rejectSave: true });
    await w.boot(target, multi);
    const expectApplied = (reply: { status: number; body?: unknown }, reconcile: string) => {
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({
        error: expect.stringContaining(`已在运行态生效，但未写入配置文件（${SAVE_REJECTED}）；`),
        applied: true,
      });
      expect((reply.body as { error: string }).error).toContain(reconcile);
    };

    expectApplied(await w.disable('target'), '重启时以文件内容为准');
    expect(w.app.plugins.getPlugin('target')?.state).toBe('disabled');
    expectApplied(await w.enable('target'), '重启时以文件内容为准');
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('target')?.state).toBe('active');
    expectApplied(await w.put('target', { v: 5 }), '按文件内容重载');
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('target')?.config).toEqual({ v: 5 });
    expectApplied(await w.createInstance('multi', 'x', { v: 3 }), '按文件内容重载');
    expect(w.app.plugins.getPlugin('multi:x')).toBeDefined();
    expectApplied(await w.deleteInstance('multi:x'), '重启时以文件内容为准');
    expect(w.app.plugins.getPlugin('multi:x')).toBeUndefined();
    expect(w.saved).toHaveLength(0);
  });

  it('全局配置落盘被拒：返回 409 并撤回文档里的改动，免得下一次保存把它写进文件', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} }, { rejectSave: true });
    await w.boot();
    const reply = await w.putGlobal({ logLevel: 'debug' });
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({ error: `未写入配置文件（${SAVE_REJECTED}），本次修改已撤回` });
    expect(w.store.get('logLevel'), '被拒的改动留在文档里').toBe('error');
    expect(w.saved).toHaveLength(0);
  });
});
