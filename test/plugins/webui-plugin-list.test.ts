import type { CommandService } from '@aalis/api-commands';
import type { ToolService } from '@aalis/api-tools';
import type { AppService, PluginManagerService, ServiceRef } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  config,
  definePlugin,
  defineService,
  events,
  lifecycle,
  logger,
  optional,
  provide,
  services,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { captureRoutes } from '../fixtures/webui-routes.js';
import { deferred } from '../helpers/deferred.js';

// GET /api/plugins 必须按 instanceId 归属工具 / 指令 / displayName。
// 生产里 tools.register 的 pluginName 就是 contextId（= instanceId）；按 definition.name
// 索引会让 name:suffix 误挂主实例的工具。

function ref<T>(instance: unknown): ServiceRef<T> {
  return { current: instance as T, require: () => instance as T, all: () => [], follow: () => () => {} };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

const tag = defineService<{ tag: string }>('webui-list-tag');

function reusableDef(name = 'probe-pkg') {
  return definePlugin({
    name,
    reusable: true,
    displayName: '探针包',
    provides: [tag],
    uses: { provide, config },
    apply({ provide, config }) {
      provide(tag, { tag: String(config.tag ?? 'main') });
    },
  });
}

function silentApp(): App {
  const { app } = hostedApp();
  apps.push(app);
  return app;
}

function mountPluginRoutes(
  app: App,
  extras: {
    tools?: { getAll(): Array<{ name: string; pluginName: string; visibility?: string }> };
    commands?: { getAll(): Array<{ name: string; pluginName?: string; visibility?: string }> };
  } = {},
) {
  const { expressApp, invoke } = captureRoutes();
  registerPluginRoutes(
    expressApp,
    {
      app: ref<AppService>({ restart: () => {} }),
      source: { current: undefined },
      plugins: ref<PluginManagerService>(app.plugins),
      hostConfig: app.bind({ hostConfig }).hostConfig,
      tools: { current: extras.tools as ToolService | undefined },
      commands: { current: extras.commands as CommandService | undefined },
    },
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
  );
  return { invoke };
}

describe('WebUI 插件列表按 instanceId 归属工具与指令', () => {
  it('披露全部 uses：核心服务也参与依赖闸，保留参数别名与可选声明，不混入敏感标签', async () => {
    const app = silentApp();
    // hooks / contributions 由提供者插件给出：先登记它们，探针才能激活；行按名字取，列表里还有这两个提供者
    await registerHubs(app);
    // 同名描述符解析同一提供者；是否可选取决于 uses 声明，不取决于描述符来自哪里。
    const sameEvents = defineService<object>('events');
    let sameProvider = false;
    const def = definePlugin({
      name: 'declared-capabilities',
      uses: {
        bus: events,
        hooks,
        contributions,
        lifecycle,
        log: logger,
        config,
        provide,
        services,
        optionalEvents: optional(sameEvents),
      },
      apply({ optionalEvents, services }) {
        sameProvider = optionalEvents.require() === services.get(events);
      },
    });
    await app.plugin(def);
    const { invoke } = mountPluginRoutes(app);
    const out = await invoke('GET /api/plugins');
    const row = (out.body as { plugins: Array<Record<string, unknown>> }).plugins.find(
      p => p.name === 'declared-capabilities',
    );
    expect(row?.state).toBe('active');
    expect(sameProvider).toBe(true);
    expect(row?.uses).toEqual([
      { key: 'bus', service: 'events', kind: 'required' },
      { key: 'hooks', service: 'hooks', kind: 'required' },
      { key: 'contributions', service: 'contributions', kind: 'required' },
      { key: 'lifecycle', service: 'lifecycle', kind: 'required' },
      { key: 'log', service: 'logger', kind: 'required' },
      { key: 'config', service: 'config', kind: 'required' },
      { key: 'provide', service: 'provide', kind: 'required' },
      { key: 'services', service: 'services', kind: 'required' },
      { key: 'optionalEvents', service: 'events', kind: 'optional' },
    ]);
    expect(row?.requiredServices).toEqual([
      'events',
      'hooks',
      'contributions',
      'lifecycle',
      'logger',
      'config',
      'provide',
      'services',
    ]);
    expect(row?.optionalServices).toEqual(['events']);
    expect(row?.capabilities).toEqual([]);
    // 返回的是声明快照，修改投影不能反向改写插件定义。
    const statusOf = () => app.plugins.getStatus().find(s => s.name === 'declared-capabilities');
    const snapshot = statusOf();
    if (snapshot) snapshot.uses[0].service = 'changed';
    expect(statusOf()?.uses[0].service).toBe('events');
  });

  it('required 缺席的 pending 插件也披露声明；零声明返回空列表', async () => {
    const app = silentApp();
    const needed = defineService<object>('needed');
    const extra = defineService<object>('extra');
    await app.plugin(
      definePlugin({
        name: 'waiting',
        uses: { db: needed, cache: optional(extra), log: optional(logger) },
        apply() {},
      }),
    );
    await app.plugin(definePlugin({ name: 'empty', apply() {} }));
    const { invoke } = mountPluginRoutes(app);
    const rows = async () =>
      ((await invoke('GET /api/plugins')).body as { plugins: Array<Record<string, unknown>> }).plugins;
    const before = await rows();
    expect(before.find(p => p.name === 'waiting')).toMatchObject({
      state: 'pending',
      requiredServices: ['needed'],
      optionalServices: ['extra', 'logger'],
      uses: [
        { key: 'db', service: 'needed', kind: 'required' },
        { key: 'cache', service: 'extra', kind: 'optional' },
        { key: 'log', service: 'logger', kind: 'optional' },
      ],
    });
    expect(before.find(p => p.name === 'empty')?.uses).toEqual([]);
    app.bind({ provide }).provide(needed, {});
    await app.plugins.idle();
    expect((await rows()).find(p => p.name === 'waiting')).toMatchObject({
      state: 'active',
      uses: before.find(p => p.name === 'waiting')?.uses,
    });
  });

  it('激活超过慢激活阈值转入后台：列表以 activating 与 slow: true 披露，落定后不再带 slow', async () => {
    const { app } = hostedApp({}, { slowThresholdMs: 20 });
    apps.push(app);
    const gate = deferred();
    const { invoke } = mountPluginRoutes(app);
    const rows = async () =>
      ((await invoke('GET /api/plugins')).body as { plugins: Array<Record<string, unknown>> }).plugins;
    try {
      await app.plugin(definePlugin({ name: 'slow-probe', apply: () => gate.promise }));
      await app.plugin(definePlugin({ name: 'quick-probe', apply() {} }));
      await app.plugins.idle();
      const during = await rows();
      expect(during.find(p => p.name === 'slow-probe')).toMatchObject({ state: 'activating', slow: true });
      expect(during.find(p => p.name === 'quick-probe')?.state).toBe('active');
      expect(during.find(p => p.name === 'quick-probe')?.slow).toBeUndefined();
    } finally {
      gate.resolve();
    }
    await vi.waitFor(() => expect(app.plugins.getPlugin('slow-probe')?.state).toBe('active'));
    expect((await rows()).find(p => p.name === 'slow-probe')?.slow).toBeUndefined();
  });

  it('激活中但未超过慢激活阈值：列表是 activating，不带 slow', async () => {
    const { app } = hostedApp({}, { slowThresholdMs: 60_000 });
    apps.push(app);
    const gate = deferred();
    const { invoke } = mountPluginRoutes(app);
    // 阈值未到时登记一直等着激活落定，不 await，趁它挂起时查列表
    const registering = app.plugin(definePlugin({ name: 'hanging-probe', apply: () => gate.promise }));
    try {
      await vi.waitFor(() => expect(app.plugins.getPlugin('hanging-probe')?.state).toBe('activating'));
      const row = ((await invoke('GET /api/plugins')).body as { plugins: Array<Record<string, unknown>> }).plugins.find(
        p => p.name === 'hanging-probe',
      );
      expect(row?.state).toBe('activating');
      expect(row?.slow, '未超过阈值不算慢激活').toBeUndefined();
    } finally {
      gate.resolve();
      await registering;
    }
  });

  it('GET /api/plugins 的 tools/commands/capabilities 必须按 instanceId 索引，不能用 definition.name', async () => {
    const def = reusableDef();
    const app = silentApp();
    await app.plugin(def, { tag: 'main' });
    await app.plugin(def, { tag: 'work' }, 'probe-pkg:work');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('probe-pkg')?.state).toBe('active');
    expect(app.plugins.getPlugin('probe-pkg:work')?.state).toBe('active');

    const { invoke } = mountPluginRoutes(app, {
      tools: {
        getAll: () => [
          { name: 'tool-main', pluginName: 'probe-pkg', visibility: 'public' },
          { name: 'tool-work', pluginName: 'probe-pkg:work', visibility: 'restricted' },
        ],
      },
      commands: {
        getAll: () => [
          { name: 'cmd-main', pluginName: 'probe-pkg' },
          { name: 'cmd-work', pluginName: 'probe-pkg:work' },
        ],
      },
    });
    const out = await invoke('GET /api/plugins');
    expect(out.status).toBe(200);
    const plugins = (out.body as { plugins: Array<Record<string, unknown>> }).plugins;
    const main = plugins.find(p => p.instanceId === 'probe-pkg');
    const extra = plugins.find(p => p.instanceId === 'probe-pkg:work');
    expect(main).toBeDefined();
    expect(extra).toBeDefined();
    expect(main?.tools, '主实例只列自己的工具').toEqual(['tool-main']);
    expect(extra?.tools, '额外实例必须列自己的工具，不得误挂主实例的、也不得空').toEqual(['tool-work']);
    expect(extra?.commands).toEqual(['cmd-work']);
    expect(extra?.capabilities).toEqual(['visibility:restricted']);
    expect(main?.capabilities ?? []).not.toContain('visibility:restricted');
  });

  const SECRET_SCHEMA = {
    apiKey: { type: 'string', label: 'API Key', secret: true },
    auth: {
      label: '认证',
      fields: {
        user: { type: 'string', label: '用户' },
        credential: { type: 'string', label: '凭据', secret: true },
      },
    },
    connections: {
      type: 'array',
      label: '连接',
      items: {
        url: { type: 'string', label: '地址' },
        accessToken: { type: 'string', label: '令牌', secret: true },
      },
    },
    timeoutMs: { type: 'number', label: '超时', default: 30 },
  } as const;

  it('GET /api/plugins 列表给文档形态：密钥字段（顶层、分组内、数组元素内）是引用，原值不出接口；另给各键的引用处数', async () => {
    const seen: unknown[] = [];
    const def = definePlugin({
      name: 'secret-probe',
      configSchema: SECRET_SCHEMA,
      uses: { config },
      apply({ config: value }) {
        seen.push(value);
      },
    });
    const doc = {
      apiKey: { $secret: 'k.top' },
      auth: { user: 'placeholder-user', credential: { $secret: 'k.group' } },
      connections: [{ url: 'ws://127.0.0.1:0', accessToken: { $secret: 'k.item' } }],
      timeoutMs: 30,
    };
    const { app, store } = hostedApp(
      // other 只在文档里、没有登记：它对 k.top 的引用同样计数
      { plugins: { 'secret-probe': structuredClone(doc), other: { apiKey: { $secret: 'k.top' } } } },
      {
        secrets: {
          values: {
            'k.top': 'sk-PLACEHOLDER-TOP',
            'k.group': 'cred-PLACEHOLDER-GROUP',
            'k.item': 'tok-PLACEHOLDER-ITEM',
          },
        },
      },
    );
    apps.push(app);
    await registerFromDoc(app, store, def);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('secret-probe')?.state).toBe('active');
    expect(seen, '插件拿到的是解析后的原值').toEqual([
      {
        apiKey: 'sk-PLACEHOLDER-TOP',
        auth: { user: 'placeholder-user', credential: 'cred-PLACEHOLDER-GROUP' },
        connections: [{ url: 'ws://127.0.0.1:0', accessToken: 'tok-PLACEHOLDER-ITEM' }],
        timeoutMs: 30,
      },
    ]);

    const { invoke } = mountPluginRoutes(app);
    const list = await invoke('GET /api/plugins');
    expect(list.status).toBe(200);
    const body = list.body as {
      plugins: Array<{ instanceId: string; config: Record<string, unknown> }>;
      secretRefCounts: Record<string, number>;
    };
    expect(body.plugins.find(p => p.instanceId === 'secret-probe')?.config).toEqual(doc);
    expect(JSON.stringify(list.body)).not.toContain('PLACEHOLDER-');
    expect(body.secretRefCounts).toEqual({ 'k.top': 2, 'k.group': 1, 'k.item': 1 });

    const editor = await invoke('GET /api/plugins/:name/config', { params: { name: 'secret-probe' } });
    expect(editor.status).toBe(200);
    expect((editor.body as { config: Record<string, unknown> }).config).toEqual(doc);
  });

  it('宿主不提供配置文档：给运行态配置，去掉密钥字段（运行态里是原值）', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await app.plugin(definePlugin({ name: 'secret-probe', configSchema: SECRET_SCHEMA, apply() {} }), {
      apiKey: 'sk-PLACEHOLDER-TOP',
      auth: { user: 'placeholder-user', credential: 'cred-PLACEHOLDER-GROUP' },
      connections: [{ url: 'ws://127.0.0.1:0', accessToken: 'tok-PLACEHOLDER-ITEM' }],
      timeoutMs: 30,
    });
    await app.plugins.idle();
    const { invoke } = mountPluginRoutes(app);
    const body = (await invoke('GET /api/plugins')).body as {
      plugins: Array<{ instanceId: string; config: Record<string, unknown> }>;
      secretRefCounts: Record<string, number>;
    };
    expect(body.plugins.find(p => p.instanceId === 'secret-probe')?.config).toEqual({
      auth: { user: 'placeholder-user' },
      connections: [{ url: 'ws://127.0.0.1:0' }],
      timeoutMs: 30,
    });
    expect(body.secretRefCounts).toEqual({});
  });
});
