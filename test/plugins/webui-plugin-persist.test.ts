import type { AppOptions, Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, ConfigSaveRefusedError, hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  appService,
  config,
  definePlugin,
  defineService,
  optional,
  type PluginDefinition,
  pluginsService,
  provide,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { type ConfigProvider, createConfigStore } from '../../packages/runtime/src/config-store.js';
import { installConfigHotReload } from '../../packages/runtime/src/config-sync.js';
import { createPluginDiscovery } from '../../packages/runtime/src/plugin-discovery.js';
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
 * `faults.unload` 设为一个错误时，路由拿到的 unload 以它拒绝（内核的 unload 实际几乎不抛）。
 * `timing`：慢激活阈值与拆卸宽限，交给 App。
 * 返回的 `external(next)` 模拟配置文件被外部改成 `next`（provider 的 watch 回调），装了热重载才有反应。
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
  const faults: { rejectSave: boolean; failSave: boolean; unload?: Error } = { rejectSave, failSave };
  let onExternal: ((next: AalisConfig) => void) | undefined;
  const provider: ConfigProvider = {
    save: snapshot => {
      if (faults.rejectSave) throw new ConfigSaveRefusedError(SAVE_REJECTED);
      if (faults.failSave) throw new Error(SAVE_FAILED);
      saved.push(structuredClone(snapshot));
    },
    watch: cb => {
      onExternal = cb;
      return () => {
        onExternal = undefined;
      };
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
      const plugins = {
        ...caps.plugins,
        get current() {
          const pm = caps.plugins.current;
          return pm && faults.unload ? { ...pm, unload: () => Promise.reject(faults.unload) } : pm;
        },
      };
      registerPluginRoutes(
        expressApp,
        {
          ...caps,
          plugins,
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
    external: (next: AalisConfig) => onExternal?.(next),
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

  it('PUT 到已禁用的插件：换上新配置、保持禁用，写入文档并落盘，启用时按新配置激活', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } });
    const applied: unknown[] = [];
    await w.boot(
      definePlugin({
        name: 'target',
        configSchema: { v: { type: 'number', label: 'V', default: 0 } },
        uses: { config },
        apply({ config }) {
          applied.push(config.v);
        },
      }),
    );
    expect((await w.disable('target')).status).toBe(200);

    const reply = await w.put('target', { v: 9 });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      ok: true,
      message: '插件 target 配置已更新；插件已禁用，启用时按新配置激活',
      ignored: [],
      removed: [],
    });
    expect(w.app.plugins.getPlugin('target')?.state).toBe('disabled');
    expect(w.store.getPluginConfig('target')).toEqual({ v: 9 });
    expect(w.saved).toHaveLength(2);
    expect((await restartFrom(w.saved, target))?.config).toEqual({ v: 9 });

    expect((await w.enable('target')).status).toBe(200);
    await w.app.plugins.idle();
    expect(applied, '启用后按新配置激活').toEqual([1, 9]);
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

  /** 配置里没有 apiKey 就激活失败的插件（同 llm-openai 连官方 API 却清空了 apiKey） */
  const keyed = definePlugin({
    name: 'keyed',
    configSchema: { apiKey: { type: 'string', label: 'API Key' } },
    uses: { config },
    apply({ config }) {
      if (!config.apiKey) throw new Error('需要配置 apiKey');
    },
  });

  it('启用后激活失败、以 error 收场：回 500 按实际状态说明，文档仍记为启用并落盘', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { keyed: {} }, disabledPlugins: ['keyed'] });
    await w.boot(keyed);
    expect(w.app.plugins.getPlugin('keyed')?.state).toBe('disabled');

    const reply = await w.enable('keyed');
    expect(w.app.plugins.getPlugin('keyed')?.state).toBe('error');
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      error: '插件 keyed 激活失败，已转为 error 态（需要配置 apiKey）；配置文件已记为启用',
    });
    expect(w.store.isPluginDisabled('keyed')).toBe(false);
    expect(w.saved).toHaveLength(1);
  });

  it('改配置后重新激活失败、以 error 收场：回 500 按实际状态说明，新配置仍写入文档并落盘', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { keyed: { apiKey: 'sk-PLACEHOLDER' } } });
    await w.boot(keyed);
    expect(w.app.plugins.getPlugin('keyed')?.state).toBe('active');

    const reply = await w.put('keyed', { apiKey: '' });
    expect(w.app.plugins.getPlugin('keyed')?.state).toBe('error');
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      error: '插件 keyed 按新配置重新激活失败，已转为 error 态（需要配置 apiKey）；配置已写入配置文件',
    });
    expect(w.store.getPluginConfig('keyed')).toEqual({ apiKey: '' });
    expect(w.saved).toHaveLength(1);
  });

  /** 配置 bad 为真就激活失败的多实例插件 */
  const fragile = definePlugin({
    name: 'fragile',
    reusable: true,
    configSchema: { bad: { type: 'boolean', label: 'Bad', default: false } },
    uses: { config },
    apply({ config }) {
      if (config.bad) throw new Error('坏配置');
    },
  });

  it('建实例后激活失败、以 error 收场：回 500 按实际状态说明，实例与配置仍写入文档并落盘', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} });
    await w.boot(fragile);

    const reply = await w.createInstance('fragile', 'x', { bad: true });
    expect(w.app.plugins.getPlugin('fragile:x')?.state).toBe('error');
    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      error: '已创建实例 fragile:x，但激活失败，已转为 error 态（坏配置）；配置已写入配置文件',
    });
    expect(w.store.getPluginConfig('fragile:x')).toEqual({ bad: true });
    expect(w.saved).toHaveLength(1);
  });

  it('激活失败且落盘被拒：回 409 + applied，回执先说明激活失败，再说明未写入文件', async () => {
    const w = world(
      { name: 'T', logLevel: 'error', plugins: { keyed: {} }, disabledPlugins: ['keyed'] },
      { rejectSave: true },
    );
    await w.boot(keyed, fragile);

    const enabled = await w.enable('keyed');
    expect(w.app.plugins.getPlugin('keyed')?.state).toBe('error');
    expect(enabled.status).toBe(409);
    expect(enabled.body).toEqual({
      error: `插件 keyed 激活失败，已转为 error 态（需要配置 apiKey）；已在运行态生效，但未写入配置文件（${SAVE_REJECTED}）；修好配置文件后，重启时以文件内容为准`,
      applied: true,
    });

    const created = await w.createInstance('fragile', 'x', { bad: true });
    expect(w.app.plugins.getPlugin('fragile:x')?.state).toBe('error');
    expect(created.status).toBe(409);
    expect(created.body).toEqual({
      error: `已创建实例 fragile:x，但激活失败，已转为 error 态（坏配置）；已在运行态生效，但未写入配置文件（${SAVE_REJECTED}）；修好配置文件后会按文件内容重载`,
      applied: true,
    });
    expect(w.saved).toHaveLength(0);
  });

  it('重新激活失败或停用超时且写入失败：回 500 + applied，回执先说明插件状态，再说明写入失败', async () => {
    const w = world(
      { name: 'T', logLevel: 'error', plugins: { keyed: { apiKey: 'sk-PLACEHOLDER' } } },
      { failSave: true, timing: { slowThresholdMs: 20, disposeTimeoutMs: 20 } },
    );
    const gate = deferred();
    try {
      await w.boot(keyed, definePlugin({ name: 'deaf', apply: () => gate.promise }));
      const kept = '改动保留在文档里，下次保存成功时一并写入';

      const put = await w.put('keyed', { apiKey: '' });
      expect(w.app.plugins.getPlugin('keyed')?.state).toBe('error');
      expect(put.status).toBe(500);
      expect(put.body).toEqual({
        error: `插件 keyed 按新配置重新激活失败，已转为 error 态（需要配置 apiKey）；已在运行态生效，但写入配置文件失败（${SAVE_FAILED}）；${kept}`,
        applied: true,
      });

      const disabled = await w.disable('deaf');
      expect(w.app.plugins.getPlugin('deaf')?.state).toBe('error');
      expect(disabled.status).toBe(500);
      expect(disabled.body).toEqual({
        error: `插件 deaf 未在宽限内停止，已转为 error 态，详见日志；已在运行态生效，但写入配置文件失败（${SAVE_FAILED}）；${kept}`,
        applied: true,
      });
      expect(w.saved).toHaveLength(0);
    } finally {
      gate.resolve();
    }
  });

  /** required 服务没有提供者，启用后停在 pending */
  const needy = definePlugin({ name: 'needy', uses: { s: defineService<object>('zz-absent') }, apply() {} });

  /**
   * 先让一次重算停在 apply 里，再发请求：管理动作只排队、立即返回。让出一段时间确认回执还没到（路由在等重算落定），
   * 再放行重算、取回执
   */
  async function replyDuringFlight(
    app: App,
    holder: string,
    request: () => Promise<{ status: number; body?: unknown }>,
  ) {
    const entered = deferred();
    const gate = deferred();
    const registering = app.plugin(
      definePlugin({
        name: holder,
        async apply() {
          entered.resolve();
          await gate.promise;
        },
      }),
      {},
    );
    await entered.promise;
    let replied = false;
    const replying = request();
    const mark = () => {
      replied = true;
    };
    replying.then(mark, mark);
    try {
      await new Promise(r => setTimeout(r, 20));
      expect(replied, '重算还在飞：回执要等它落定').toBe(false);
    } finally {
      gate.resolve();
      await registering;
    }
    return replying;
  }

  it('启用、改配置、建实例撞上在飞的重算：等它落定再读状态，报出之后的激活失败', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { keyed: {} }, disabledPlugins: ['keyed'] });
    await w.boot(keyed, fragile);

    expect(await replyDuringFlight(w.app, 'zz-hold-enable', () => w.enable('keyed'))).toEqual({
      status: 500,
      body: { error: '插件 keyed 激活失败，已转为 error 态（需要配置 apiKey）；配置文件已记为启用' },
    });
    expect(await replyDuringFlight(w.app, 'zz-hold-put', () => w.put('keyed', { apiKey: '' }))).toEqual({
      status: 500,
      body: { error: '插件 keyed 按新配置重新激活失败，已转为 error 态（需要配置 apiKey）；配置已写入配置文件' },
    });
    expect(
      await replyDuringFlight(w.app, 'zz-hold-create', () => w.createInstance('fragile', 'x', { bad: true })),
    ).toEqual({
      status: 500,
      body: { error: '已创建实例 fragile:x，但激活失败，已转为 error 态（坏配置）；配置已写入配置文件' },
    });
  });

  it('落定后仍在后台激活、或在等 required 依赖：回 200，如实说明尚未激活', async () => {
    const w = world(
      { name: 'T', logLevel: 'error', plugins: {}, disabledPlugins: ['deaf', 'needy'] },
      { timing: { slowThresholdMs: 20 } },
    );
    const gate = deferred();
    try {
      await w.boot(definePlugin({ name: 'deaf', apply: () => gate.promise }), needy);

      expect(await w.enable('deaf')).toEqual({
        status: 200,
        body: { ok: true, message: '插件 deaf 已启用；仍在激活（超过慢激活阈值，已转入后台），结果以插件列表为准' },
      });
      expect(w.app.plugins.getStatus().find(p => p.instanceId === 'deaf')?.slow).toBe(true);
      expect(await w.enable('needy')).toEqual({
        status: 200,
        body: { ok: true, message: '插件 needy 已启用；尚未激活，正在等待 required 依赖满足' },
      });
    } finally {
      gate.resolve();
    }
  });

  it('动作之后没有进入预期状态、写入又失败：回执开头先说明状态，再说明写入失败', async () => {
    const w = world(
      { name: 'T', logLevel: 'error', plugins: { target: { v: 1 } }, disabledPlugins: ['target', 'needy', 'multi:x'] },
      { failSave: true },
    );
    await w.boot(target, needy, multi);
    const failed = (lead: string) => ({
      status: 500,
      body: {
        error: `${lead}；已在运行态生效，但写入配置文件失败（${SAVE_FAILED}）；改动保留在文档里，下次保存成功时一并写入`,
        applied: true,
      },
    });

    expect(await w.put('target', { v: 5 })).toEqual(failed('插件已禁用，启用时按新配置激活'));
    expect(await w.enable('needy')).toEqual(failed('尚未激活，正在等待 required 依赖满足'));
    expect(await w.createInstance('multi', 'x', { v: 3 })).toEqual(
      failed('配置文件的 disabledPlugins 里有它，已按禁用态登记，启用后激活'),
    );
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
    // 文档里残留一条实例的禁用标记（手改配置文件留下的）
    const w = world({ name: 'T', logLevel: 'error', plugins: {}, disabledPlugins: ['multi:x'] });
    await w.boot(multi);

    const created = await w.createInstance('multi', 'x', { v: 3 });
    expect(created.status).toBe(200);
    expect(created.body, '回执说明它按禁用态登记，不只说「已创建」').toEqual({
      ok: true,
      instanceId: 'multi:x',
      message: '已创建实例 multi:x；配置文件的 disabledPlugins 里有它，已按禁用态登记，启用后激活',
      ignored: [],
    });
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

  it('停用过的实例删除后同名重建：删除时清掉禁用标记，重建以启用态登记', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} });
    await w.boot(multi);
    expect((await w.createInstance('multi', 'x', { v: 3 })).status).toBe(200);
    expect((await w.disable('multi:x')).status).toBe(200);
    expect(w.store.isPluginDisabled('multi:x')).toBe(true);

    expect((await w.deleteInstance('multi:x')).status).toBe(200);
    expect(w.store.isPluginDisabled('multi:x'), '删除实例要一并清掉它的禁用标记').toBe(false);

    const recreated = await w.createInstance('multi', 'x', { v: 4 });
    expect(recreated.body).toMatchObject({ ok: true, instanceId: 'multi:x' });
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('multi:x')?.state).toBe('active');
  });

  it('停机进行中建实例：内核拒绝登记，回 409，配置不写入文档也不落盘', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} });
    await w.boot(multi);
    const stopping = w.app.stop();
    try {
      const reply = await w.createInstance('multi', 'x', { v: 3 });
      expect(reply.status).toBe(409);
      expect(reply.body).toEqual({ error: '实例 multi:x 未登记（停机中或被拒，见日志），配置未写入' });
      expect(Object.hasOwn(w.store.getAll().plugins, 'multi:x'), '下次启动不得按文件登记这个实例').toBe(false);
      expect(w.saved).toHaveLength(0);
    } finally {
      await stopping;
    }
  });

  it('落盘被拒：启停、改配置、建实例都回 409 + applied，说明已在运行态生效、未写入文件', async () => {
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
    expect(w.saved).toHaveLength(0);
  });

  it('删实例先落盘：被拒回 409、写入失败回 500，都不卸载，文档里的配置段与禁用标记还原', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { 'multi:x': { v: 3 } }, disabledPlugins: ['multi:x'] });
    await w.boot(multi);
    await registerFromDoc(w.app, w.store, multi, 'multi:x');
    expect(w.app.plugins.getPlugin('multi:x')?.state).toBe('disabled');

    for (const [fault, status, reason] of [
      ['rejectSave', 409, SAVE_REJECTED],
      ['failSave', 500, SAVE_FAILED],
    ] as const) {
      w.faults.rejectSave = fault === 'rejectSave';
      w.faults.failSave = fault === 'failSave';
      const reply = await w.deleteInstance('multi:x');
      expect(reply.status).toBe(status);
      expect(reply.body).toEqual({ error: `未删除实例 multi:x：未写入配置文件（${reason}）` });
      expect(w.app.plugins.getPlugin('multi:x')?.state, '没写进文件就不卸载').toBe('disabled');
      expect(w.store.getPluginConfig('multi:x')).toEqual({ v: 3 });
      expect(w.store.isPluginDisabled('multi:x')).toBe(true);
    }

    // 文档里本来没有配置段的实例（宿主直接登记）：还原时不凭空补一个，免得它随下一次保存进了配置文件
    expect(await w.app.plugin(multi, { v: 4 }, 'multi:y')).toBe(true);
    expect((await w.deleteInstance('multi:y')).status).toBe(500);
    expect(w.app.plugins.getPlugin('multi:y')).toBeDefined();
    expect(Object.hasOwn(w.store.getAll().plugins, 'multi:y')).toBe(false);
    expect(w.saved).toHaveLength(0);
  });

  it('删实例落盘后卸载失败：回 500 JSON，说明已从配置文件删除、卸载失败', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { 'multi:x': { v: 3 } } });
    await w.boot(multi);
    await registerFromDoc(w.app, w.store, multi, 'multi:x');
    w.faults.unload = new Error('zz-卸载失败');

    expect(await w.deleteInstance('multi:x')).toEqual({
      status: 500,
      body: { error: '已从配置文件删除实例 multi:x，但卸载失败（zz-卸载失败）；重启后不再登记' },
    });
    expect(w.saved).toHaveLength(1);
    expect(Object.hasOwn(w.saved[0].plugins, 'multi:x'), '配置段已从文件删掉').toBe(false);
  });

  it('删实例的级联重算期间外部改了配置文件：热重载不会把它按旧文件重新登记成文件里没有的在跑实例', async () => {
    // provider:x 是 zz-s 的首选提供者，删除时 dependent 在卸载收尾的重算里改接主实例；让它的 apply 挂住，
    // 热重载就能落进这段重算（没有真实的异步工作时窗口只有微任务长）
    const initial: Partial<AalisConfig> = {
      name: 'T',
      logLevel: 'error',
      plugins: { provider: { who: 'main' }, 'provider:x': { who: 'x' } },
      servicePreferences: { 'zz-s': 'provider:x' },
    };
    const w = world(initial);
    const S = defineService<{ who: string }>('zz-s');
    const provider = definePlugin({
      name: 'provider',
      reusable: true,
      provides: [S],
      configSchema: { who: { type: 'string', label: 'W', default: '' } },
      uses: { provide, config },
      apply(caps) {
        caps.provide(S, { who: String(caps.config.who) });
      },
    });
    let hold: Promise<void> | undefined;
    const entered = deferred();
    const dependent = definePlugin({
      name: 'dependent',
      uses: { s: S },
      async apply() {
        if (!hold) return;
        entered.resolve();
        await hold;
      },
    });
    await w.boot(provider);
    await registerFromDoc(w.app, w.store, provider, 'provider:x');
    await registerFromDoc(w.app, w.store, dependent);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('dependent')?.state).toBe('active');
    const discovery = createPluginDiscovery(w.app, { discover: async () => [], load: async () => null }, w.store);
    const reloaded = deferred();
    installConfigHotReload(w.app, w.store, {
      async registerConfiguredInstances() {
        await discovery.registerConfiguredInstances();
        reloaded.resolve();
      },
    });

    const release = deferred();
    hold = release.promise;
    const deleting = w.deleteInstance('provider:x');
    await entered.promise;
    expect(w.app.plugins.getPlugin('provider:x'), '前提：已离开注册表、重算仍在途').toBeUndefined();
    // 外部改了配置文件的别处：盘上是最后一次落盘的内容（从没落过盘就是初始内容）
    w.external({ ...structuredClone((w.saved.at(-1) ?? initial) as AalisConfig), name: 'T2' });
    release.resolve();
    expect((await deleting).status).toBe(200);
    await reloaded.promise;
    await w.app.plugins.idle();

    expect(w.store.get('name'), '前提：热重载已按外部改动换了文档').toBe('T2');
    expect({
      registered: w.app.plugins.getPlugin('provider:x') !== undefined,
      inDoc: Object.hasOwn(w.store.getAll().plugins, 'provider:x'),
      inFile: Object.hasOwn(w.saved.at(-1)?.plugins ?? {}, 'provider:x'),
    }).toEqual({ registered: false, inDoc: false, inFile: false });
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
