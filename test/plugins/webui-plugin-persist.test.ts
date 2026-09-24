import type { AalisConfig, Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  App,
  appService,
  definePlugin,
  hostConfig,
  optional,
  type PluginDefinition,
  pluginsService,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';

// 管理动作只改运行态；WebUI 的启停与改配置路由在动作成功后自己写配置文档并落盘。
// 这里用真实 App 与真实路由：按落盘的文档重建 App，状态要与重启前一致。
// 路由挂在一个插件的激活上（与 webui-server 同样经 uses 取服务），也覆盖经自己的路由禁用自己。

type Handler = (req: unknown, res: unknown, next: () => Promise<void>) => unknown;
type Reply = { status: number; body?: unknown };

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const target = definePlugin({
  name: 'target',
  configSchema: { v: { type: 'number', label: 'V', default: 0 } },
  apply() {},
});

function world(config: AalisConfig) {
  const saved: AalisConfig[] = [];
  const app = new App({
    config,
    logger: silent,
    configProvider: {
      save: snapshot => {
        saved.push(structuredClone(snapshot));
      },
    },
  });
  apps.push(app);
  const routes = new Map<string, Handler[]>();
  const expressApp = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (path: string, ...handlers: Handler[]) => {
          routes.set(`${method.toUpperCase()} ${path}`, handlers);
        },
    },
  );
  const panel = definePlugin({
    name: 'console',
    uses: { app: optional(appService), plugins: optional(pluginsService), hostConfig: optional(hostConfig) },
    apply(caps) {
      registerPluginRoutes(
        expressApp as never,
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
  const call = async (key: string, name: string, body: unknown = {}): Promise<Reply> => {
    const handlers = routes.get(key);
    if (!handlers) throw new Error(`${key} 未注册`);
    const out: Reply = { status: 200 };
    const res = {
      status(code: number) {
        out.status = code;
        return res;
      },
      json(payload: unknown) {
        out.body = payload;
        return res;
      },
    };
    let i = 0;
    const next = async (): Promise<void> => {
      const h = handlers[i++];
      if (h) await h({ params: { name }, body, headers: {} }, res, next);
    };
    await next();
    return out;
  };
  return {
    app,
    saved,
    async boot(...definitions: PluginDefinition[]) {
      await app.pluginAll([panel, ...definitions].map(definition => ({ definition })));
      await app.plugins.idle();
    },
    enable: (name: string) => call('POST /api/plugins/:name/enable', name),
    disable: (name: string) => call('POST /api/plugins/:name/disable', name),
    put: (name: string, config: unknown) => call('PUT /api/plugins/:name/config', name, { config }),
  };
}

/** 按最后一次落盘的文档重建 App，登记同一份定义，返回它重启后的条目 */
async function restartFrom(saved: AalisConfig[], definition: PluginDefinition) {
  const snapshot = saved.at(-1);
  if (!snapshot) throw new Error('从未落盘');
  const app = new App({ config: structuredClone(snapshot), logger: silent });
  apps.push(app);
  await app.plugin(definition);
  await app.plugins.idle();
  return app.plugins.getPlugin(definition.name);
}

describe('WebUI 管理路由自己写文档并落盘，重启后状态一致', () => {
  it('禁用、启用、改配置各落盘一次，按落盘文档重建的 App 恢复同一状态', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } });
    await w.boot(target);

    expect((await w.disable('target')).status).toBe(200);
    expect(w.app.plugins.getPlugin('target')?.state).toBe('disabled');
    expect(w.app.config.isPluginDisabled('target')).toBe(true);
    expect(w.saved).toHaveLength(1);
    expect((await restartFrom(w.saved, target))?.state).toBe('disabled');

    expect((await w.enable('target')).status).toBe(200);
    await w.app.plugins.idle();
    expect(w.app.config.isPluginDisabled('target')).toBe(false);
    expect(w.saved).toHaveLength(2);
    expect((await restartFrom(w.saved, target))?.state).toBe('active');

    expect((await w.put('target', { v: 5 })).status).toBe(200);
    await w.app.plugins.idle();
    expect(w.app.plugins.getPlugin('target')?.config).toEqual({ v: 5 });
    expect(w.app.config.getPluginConfig('target')).toEqual({ v: 5 });
    expect(w.saved).toHaveLength(3);
    expect((await restartFrom(w.saved, target))?.config).toEqual({ v: 5 });
  });

  it('PUT 到运行中已禁用的插件返回 409，文档不写', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { target: { v: 1 } } });
    await w.boot(target);
    // 直接调管理动作禁用：只改运行态，文档里仍是启用
    expect(await w.app.plugins.disable('target')).toBe(true);
    expect(w.app.config.isPluginDisabled('target')).toBe(false);

    const reply = await w.put('target', { v: 9 });
    expect(reply.status).toBe(409);
    expect(w.app.config.getPluginConfig('target')).toEqual({ v: 1 });
    expect(w.saved).toHaveLength(0);
  });

  it('经自己的路由禁用自己：激活被拆掉后仍写入文档并落盘', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: {} });
    await w.boot();

    expect((await w.disable('console')).status).toBe(200);
    expect(w.app.plugins.getPlugin('console')?.state).toBe('disabled');
    expect(w.app.config.isPluginDisabled('console')).toBe(true);
    expect(w.saved).toHaveLength(1);
  });
});
