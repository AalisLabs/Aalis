import type { AppOptions, Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, ConfigSaveRefusedError, hostConfig } from '../../packages/api-host-config/src/index.js';
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
import { deferred } from '../helpers/deferred.js';

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
const SAVE_FAILED = 'EACCES: permission denied';

const target = definePlugin({
  name: 'target',
  configSchema: { v: { type: 'number', label: 'V', default: 0 } },
  apply() {},
});

/**
 * `provideDoc: false`：宿主持有文档、照它登记，但不把它作为 host-config 交给插件。
 * `rejectSave`：落盘一律被拒（同 runtime 在配置文件有尚未生效的外部修改时拒写）。
 * `failSave`：落盘一律写入失败（权限、磁盘写满等，文件不变）。两个故障开关经返回的 `faults` 可中途改。
 * `timing`：慢激活阈值与拆卸宽限，交给 App。
 */
function world(
  config: Partial<AalisConfig>,
  {
    provideDoc = true,
    rejectSave = false,
    failSave = false,
    timing = {} as Pick<AppOptions, 'slowThresholdMs' | 'disposeTimeoutMs'>,
  } = {},
) {
  const saved: AalisConfig[] = [];
  const faults = { rejectSave, failSave };
  const provider: ConfigProvider = {
    save: snapshot => {
      if (faults.rejectSave) throw new ConfigSaveRefusedError(SAVE_REJECTED);
      if (faults.failSave) throw new Error(SAVE_FAILED);
      saved.push(structuredClone(snapshot));
    },
  };
  const { app, store } = provideDoc
    ? hostedApp(config, { logger: silent, provider, ...timing })
    : {
        app: new App({ name: 'T', logLevel: 'error', logger: silent, ...timing }),
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
    faults,
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

  it('停用时插件未在宽限内停止、以 error 收场：回 500 按实际状态说明，文档仍记为禁用并落盘', async () => {
    const w = world(
      { name: 'T', logLevel: 'error', plugins: {} },
      { timing: { slowThresholdMs: 20, disposeTimeoutMs: 20 } },
    );
    const gate = deferred();
    try {
      await w.boot(definePlugin({ name: 'deaf', apply: () => gate.promise }));
      expect(w.app.plugins.getPlugin('deaf')?.state).toBe('activating');

      const reply = await w.disable('deaf');
      expect(w.app.plugins.getPlugin('deaf')?.state).toBe('error');
      expect(reply.status).toBe(500);
      expect(reply.body).toEqual({
        error: '插件 deaf 未在宽限内停止，已转为 error 态，详见日志；配置文件已记为禁用',
      });
      expect(w.store.isPluginDisabled('deaf')).toBe(true);
      expect(w.saved).toHaveLength(1);
    } finally {
      gate.resolve();
    }
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

  it('落盘写入失败（非拒写）：回 500 + applied，改动留在文档里，下一次成功保存时一并写入', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } }, { failSave: true });
    await w.boot(target, multi);
    const expectKept = (reply: { status: number; body?: unknown }) => {
      expect(reply.status).toBe(500);
      expect(reply.body).toEqual({
        error: `已在运行态生效，但写入配置文件失败（${SAVE_FAILED}）；改动保留在文档里，下次保存成功时一并写入`,
        applied: true,
      });
    };

    expectKept(await w.disable('target'));
    expect(w.store.isPluginDisabled('target')).toBe(true);
    expectKept(await w.enable('target'));
    await w.app.plugins.idle();
    expect(w.store.isPluginDisabled('target')).toBe(false);
    expectKept(await w.put('target', { v: 5 }));
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('target')?.config).toEqual({ v: 5 });
    expect(w.store.getPluginConfig('target'), '文档保留这次改动').toEqual({ v: 5 });
    expectKept(await w.createInstance('multi', 'x', { v: 3 }));
    expect(w.store.getPluginConfig('multi:x')).toEqual({ v: 3 });
    expectKept(await w.deleteInstance('multi:x'));
    expect(Object.hasOwn(w.store.getAll().plugins, 'multi:x')).toBe(false);
    expect(w.saved).toHaveLength(0);
  });

  it('写入失败后原样重试插件配置：不再重建插件，但补写进文件，重启后仍是新配置', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } }, { failSave: true });
    let applies = 0;
    const counted = definePlugin({
      name: 'target',
      configSchema: { v: { type: 'number', label: 'V', default: 0 } },
      apply() {
        applies++;
      },
    });
    await w.boot(counted);

    expect((await w.put('target', { v: 5 })).status).toBe(500);
    await w.app.plugins.idle();
    expect(applies).toBe(2);
    expect(w.saved).toHaveLength(0);

    // 磁盘恢复后用户原样再点一次保存：运行态与文档都已是 {v:5}，文件里还是 {v:1}
    w.faults.failSave = false;
    const retry = await w.put('target', { v: 5 });
    expect(retry.status).toBe(200);
    expect(retry.body, '回复说明这次写了盘，不让人以为什么都没保存').toEqual({
      ok: true,
      message: '插件 target 配置无改动，已写回配置文件',
      ignored: [],
      removed: [],
    });
    await w.app.plugins.idle();
    expect(applies, '配置没变，不该再重建').toBe(2);
    expect(w.saved, '这次必须补写进文件，否则重启就丢').toHaveLength(1);
    expect((await restartFrom(w.saved, target))?.config).toEqual({ v: 5 });
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

  it('全局配置落盘写入失败：返回 500，同样撤回文档里的改动', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} }, { failSave: true });
    await w.boot();
    const reply = await w.putGlobal({ logLevel: 'debug' });
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({ error: `未写入配置文件（${SAVE_FAILED}），本次修改已撤回` });
    expect(w.store.get('logLevel')).toBe('error');
    expect(w.saved).toHaveLength(0);
  });
});
