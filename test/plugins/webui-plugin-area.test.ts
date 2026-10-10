import { once } from 'node:events';
import { Agent, request } from 'node:http';
import type { Socket } from 'node:net';
import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  type App,
  type AppOptions,
  appService,
  config,
  definePlugin,
  defineService,
  lifecycle,
  optional,
  type PluginDefinition,
  pluginsService,
  provide,
  services,
} from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import type { ConfigProvider } from '../../packages/runtime/src/config-store.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { captureRoutes } from '../fixtures/webui-routes.js';
import { deferred } from '../helpers/deferred.js';
import { freePort, waitListening } from '../helpers/net.js';

// 插件区要的列表字段与管理动作：列表给子系统（插件声明的原样给）、版本、没起来的原因（缺与在等沿链追到根、待配置）与「界面所在」的标记；
// 界面所在的插件经这些路由停用不了；重载经 bounce 重建插件，失败的插件重载即重试。
// 真实 App 与真实路由，配置落盘用内存 provider。路由挂在一个叫 console 的插件里，它就是「界面所在」；
// webui-server 自己的配置校验另起真的 webui-server

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const SELF = 'console';

function world(
  doc: Partial<AalisConfig> = {},
  versions: Record<string, string> = {},
  timing: Pick<AppOptions, 'disposeTimeoutMs'> = {},
) {
  const saved: AalisConfig[] = [];
  const provider: ConfigProvider = { save: snapshot => void saved.push(structuredClone(snapshot)) };
  const { app, store } = hostedApp(doc, { logger: silent, provider, ...timing });
  apps.push(app);
  const { expressApp, invoke } = captureRoutes();
  const panel = definePlugin({
    name: SELF,
    uses: {
      app: optional(appService),
      plugins: optional(pluginsService),
      hostConfig: optional(hostConfig),
      services,
    },
    apply(caps) {
      registerPluginRoutes(
        expressApp,
        {
          ...caps,
          source: { current: undefined },
          tools: { current: undefined },
          commands: { current: undefined },
          self: SELF,
          versions: () => name => versions[name],
        },
        () => (_req: unknown, _res: unknown, next: () => void) => next(),
      );
    },
  });
  const call = (key: string, name: string) => invoke(key, { params: { name }, body: {}, headers: {} });
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
    /** 列表经 JSON 往返，与界面拿到的一致（undefined 的字段不出现） */
    async rows() {
      const { body } = await invoke('GET /api/plugins');
      return (JSON.parse(JSON.stringify(body)) as { plugins: Array<Record<string, unknown>> }).plugins;
    },
    disable: (name: string) => call('POST /api/plugins/:name/disable', name),
    reload: (name: string) => call('POST /api/plugins/:name/reload', name),
  };
}

const store = defineService<object>('zz-store');
const cache = defineService<object>('zz-cache');

describe('插件列表', () => {
  it('子系统按插件声明原样给出，没声明的不给；版本按包名查，查不到不给', async () => {
    const w = world({}, { 'zz-memory': '1.2.3' });
    await w.boot(
      definePlugin({ name: 'zz-memory', subsystem: 'memory', apply() {} }),
      definePlugin({ name: 'zz-odd', subsystem: 'zz-own-group', apply() {} }),
      definePlugin({ name: 'zz-plain', apply() {} }),
    );
    const rows = await w.rows();
    const row = (name: string) => rows.find(p => p.instanceId === name);
    expect(row('zz-memory')).toMatchObject({ subsystem: 'memory', version: '1.2.3' });
    expect(row('zz-odd')?.subsystem).toBe('zz-own-group');
    expect(row('zz-plain')).not.toHaveProperty('subsystem');
    expect(row('zz-plain')).not.toHaveProperty('version');
  });

  it('旧实例超过宽限仍未停下的插件给 lingering', async () => {
    const w = world({}, {}, { disposeTimeoutMs: 20 });
    const gate = deferred();
    let applies = 0;
    try {
      await w.boot(
        definePlugin({
          name: 'zz-slowstop',
          uses: { lifecycle },
          apply: ({ lifecycle }) => void (++applies === 1 && lifecycle.onDispose(() => gate.promise)),
        }),
      );
      await w.app.plugins.bounce('zz-slowstop');
      expect((await w.rows()).find(p => p.instanceId === 'zz-slowstop')).toMatchObject({
        state: 'pending',
        lingering: true,
      });
    } finally {
      gate.resolve();
    }
  });

  it('lacking 是此刻没有任何提供者的 required 服务，沿链追到根：可选的不算，内置的总在；提供者上线后清空', async () => {
    const w = world();
    await w.boot(definePlugin({ name: 'zz-waiting', uses: { db: store, extra: optional(cache), config }, apply() {} }));
    expect((await w.rows()).find(p => p.instanceId === 'zz-waiting')).toMatchObject({
      state: 'pending',
      lacking: [{ service: 'zz-store', chain: [], root: { kind: 'unprovided', service: 'zz-store' } }],
      waiting: [],
      unconfigured: [],
    });
    w.app.bind({ provide }).provide(store, {});
    await w.app.plugins.idle();
    expect((await w.rows()).find(p => p.instanceId === 'zz-waiting')).toMatchObject({
      state: 'active',
      lacking: [],
      waiting: [],
    });
  });

  it("unconfigured 只对失败的插件算：取自配置 schema 校验配置文档的 missing，`''` 算没填，密钥引用算填了，不合法的值不在里面", async () => {
    const schema = {
      apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
      baseUrl: { type: 'string', label: '地址', required: true },
      model: { type: 'string', label: '模型', required: true },
      timeoutMs: { type: 'number', label: '超时', required: true, default: 30 },
    } as const;
    const w = world({
      plugins: {
        'zz-keyed': { apiKey: { $secret: 'k.keyed' }, baseUrl: '', model: 'placeholder-model', timeoutMs: 'soon' },
        'zz-idle': { baseUrl: '' },
      },
      disabledPlugins: ['zz-idle'],
    });
    await w.boot(
      definePlugin({
        name: 'zz-keyed',
        configSchema: schema,
        apply() {
          throw new Error('缺少配置项 baseUrl');
        },
      }),
      definePlugin({ name: 'zz-idle', configSchema: schema, apply() {} }),
    );
    const rows = await w.rows();
    expect(rows.find(p => p.instanceId === 'zz-keyed')).toMatchObject({ state: 'error', unconfigured: ['baseUrl'] });
    expect(rows.find(p => p.instanceId === 'zz-idle')).toMatchObject({ state: 'disabled', unconfigured: [] });
  });

  it('只有界面所在的插件带 self 标记；列表不再给聚合的敏感能力', async () => {
    const w = world();
    await w.boot(definePlugin({ name: 'zz-other', apply() {} }));
    const rows = await w.rows();
    expect(rows.filter(p => p.self).map(p => p.instanceId)).toEqual([SELF]);
    for (const row of rows) expect(row).not.toHaveProperty('capabilities');
  });
});

describe('界面自我保护', () => {
  it('界面所在的插件经接口停用被拒（409），它照常运行，配置文件不动；重载自己照常；别的插件照常', async () => {
    const w = world();
    let starts = 0;
    await w.boot(
      definePlugin({
        name: 'zz-other',
        apply() {
          starts++;
        },
      }),
    );
    const refused = await w.disable(SELF);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('提供这个界面');
    expect(w.app.plugins.getPlugin(SELF)?.state).toBe('active');
    expect(w.saved).toHaveLength(0);

    expect((await w.reload(SELF)).status).toBe(200);
    expect(w.app.plugins.getPlugin(SELF)?.state).toBe('active');

    expect((await w.reload('zz-other')).status).toBe(200);
    expect(starts).toBe(2);
    expect((await w.disable('zz-other')).status).toBe(200);
    expect(w.app.plugins.getPlugin('zz-other')?.state).toBe('disabled');
  });
});

describe('webui-server 自己的配置', () => {
  it('会让它起不来的端口与监听地址在保存前就被拒（400）：它照常运行，配置文件不动', async () => {
    const TOKEN = 'zz-self-config-token-placeholder-0';
    const port = await freePort();
    const saved: AalisConfig[] = [];
    const provider: ConfigProvider = { save: snapshot => void saved.push(structuredClone(snapshot)) };
    const { app, store } = hostedApp(
      {
        plugins: {
          [webuiServer.name]: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
        },
      },
      { logger: silent, provider },
    );
    apps.push(app);
    await registerFromDoc(app, store, webuiServer);
    await app.start();
    await waitListening(port);
    for (const bad of [{ port: 70000 }, { port: -1 }, { port: 3000.5 }, { host: ' ' }]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/plugins/${encodeURIComponent(webuiServer.name)}/config`, {
        method: 'PUT',
        headers: { Cookie: `aalis_webui_token=${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: bad }),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(app.plugins.getPlugin(webuiServer.name)?.state).toBe('active');
    expect(saved).toHaveLength(0);
  });

  it('重载自己之后，承载那次请求的 keep-alive 连接应答完即关闭，后面的请求落到新实例', async () => {
    const TOKEN = 'zz-self-reload-token-placeholder-00';
    const port = await freePort();
    const { app, store } = hostedApp(
      {
        plugins: {
          [webuiServer.name]: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
        },
      },
      { logger: silent },
    );
    apps.push(app);
    await registerFromDoc(app, store, webuiServer);
    await app.start();
    await waitListening(port);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const send = (method: string, path: string) =>
      new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
        const req = request(
          { port, host: '127.0.0.1', method, path, agent, headers: { Cookie: `aalis_webui_token=${TOKEN}` } },
          res => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode ?? 0, socket: req.socket as Socket }));
          },
        );
        req.on('error', reject).end();
      });
    try {
      const reload = await send('POST', `/api/plugins/${encodeURIComponent(webuiServer.name)}/reload`);
      expect(reload.status).toBe(200);
      const closed = await Promise.race([
        once(reload.socket, 'close').then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000)),
      ]);
      expect(closed, '旧实例的连接没有关').toBe(true);
      await waitListening(port);
      expect((await send('GET', '/api/plugins')).status).toBe(200);
      expect(app.plugins.getPlugin(webuiServer.name)?.state).toBe('active');
    } finally {
      agent.destroy();
    }
  });
});

describe('重载', () => {
  it('失败的插件重载即重试：外部条件好了就转为运行中；仍失败时回 200 并说明原因', async () => {
    const w = world();
    let ready = false;
    await w.boot(
      definePlugin({
        name: 'zz-flaky',
        apply() {
          if (!ready) throw new Error('上游还没起来');
        },
      }),
    );
    expect(w.app.plugins.getPlugin('zz-flaky')?.state).toBe('error');
    const failed = await w.reload('zz-flaky');
    expect(failed.status).toBe(200);
    expect(JSON.stringify(failed.body)).toContain('上游还没起来');
    ready = true;
    const reply = await w.reload('zz-flaky');
    expect(reply).toMatchObject({ status: 200, body: { ok: true, message: '插件 zz-flaky 已重载' } });
    expect(w.app.plugins.getPlugin('zz-flaky')?.state).toBe('active');
    expect(w.saved, '重载不写配置文件').toHaveLength(0);
  });

  it('已停用的插件不重载（409，说明先启用）；不存在的回 404', async () => {
    const w = world({ name: 'T', logLevel: 'error', plugins: { 'zz-off': {} }, disabledPlugins: ['zz-off'] });
    await w.boot(definePlugin({ name: 'zz-off', apply() {} }));
    const off = await w.reload('zz-off');
    expect(off.status).toBe(409);
    expect(JSON.stringify(off.body)).toContain('已停用');
    expect(w.app.plugins.getPlugin('zz-off')?.state).toBe('disabled');
    expect((await w.reload('zz-ghost')).status).toBe(404);
  });
});
