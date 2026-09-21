import type { CommandService } from '@aalis/api-commands';
import type { ToolService } from '@aalis/api-tools';
import type { WebUIService } from '@aalis/api-webui';
import type { AppService, ConfigManager, PluginManagerService, ServiceRef } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { App, config, definePlugin, defineService, provide } from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';

// GET /api/plugins 与 /api/pages 必须按 instanceId 归属工具 / 指令 / displayName。
// 生产里 tools.register 的 pluginName 就是 contextId（= instanceId）；按 definition.name
// 索引会让 name:suffix 误挂主实例的工具，页面展示名变成 undefined。

type Handler = (req: unknown, res: unknown, next: () => Promise<void>) => unknown;

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
  const app = new App({
    config: { name: 'T', logLevel: 'error', plugins: {} },
  });
  apps.push(app);
  return app;
}

function mountPluginRoutes(
  app: App,
  extras: {
    tools?: { getAll(): Array<{ name: string; pluginName: string; visibility?: string }> };
    commands?: { getAll(): Array<{ name: string; pluginName?: string; visibility?: string }> };
    pages?: Array<{ key: string; label: string; pluginName: string }>;
  } = {},
) {
  const routes = new Map<string, Handler[]>();
  const expressApp = new Proxy(
    {},
    {
      get:
        (_t, method: string) =>
        (path: string, ...handlers: Handler[]) => {
          routes.set(`${String(method).toUpperCase()} ${path}`, handlers);
        },
    },
  );
  registerPluginRoutes(
    expressApp as never,
    {
      app: ref<AppService>({ saveConfig: () => app.saveConfig(), restart: () => {} }),
      plugins: ref<PluginManagerService>(app.plugins),
      hostConfig: ref<ConfigManager>(app.config),
      tools: { current: extras.tools as ToolService | undefined },
      commands: { current: extras.commands as CommandService | undefined },
      webui: () =>
        extras.pages
          ? ({
              getPages: () => extras.pages,
            } as WebUIService)
          : undefined,
    },
    () => ({ platform: 'webui', userId: 'console' }),
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    () => undefined,
  );
  const invoke = async (methodPath: string, req: Record<string, unknown> = {}) => {
    const handlers = routes.get(methodPath);
    if (!handlers) throw new Error(`路由未注册: ${methodPath}`);
    const out: { status: number; body?: unknown } = { status: 200 };
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
      if (h) await h(req, res, next);
    };
    await next();
    return out;
  };
  return { invoke };
}

describe('WebUI 列表按 instanceId 归属工具 / 页面展示名', () => {
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

  it('GET /api/pages 的 pluginDisplayName 按页面 pluginName（= instanceId）解析', async () => {
    const def = reusableDef();
    const app = silentApp();
    await app.plugin(def);
    await app.plugin(def, {}, 'probe-pkg:work');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('probe-pkg')?.state).toBe('active');
    expect(app.plugins.getPlugin('probe-pkg:work')?.state).toBe('active');
    const { invoke } = mountPluginRoutes(app, {
      pages: [
        { key: 'main', label: '主页', pluginName: 'probe-pkg' },
        { key: 'work', label: '工页', pluginName: 'probe-pkg:work' },
      ],
    });
    const out = await invoke('GET /api/pages');
    const pages = out.body as Array<{ plugin: string; pluginDisplayName?: string }>;
    expect(pages.find(p => p.plugin === 'probe-pkg')?.pluginDisplayName).toBe('探针包');
    expect(pages.find(p => p.plugin === 'probe-pkg:work')?.pluginDisplayName, '额外实例页面也要有 displayName').toBe(
      '探针包',
    );
  });

  it('GET /api/plugins 列表把 schema.secret 换成固定掩码；编辑器 GET 保持未脱敏', async () => {
    const def = definePlugin({
      name: 'secret-probe',
      configSchema: {
        apiKey: { type: 'string', label: 'API Key', secret: true },
        timeoutMs: { type: 'number', label: '超时', default: 30 },
      },
      uses: { config },
      apply() {},
    });
    const app = new App({
      config: {
        name: 'T',
        logLevel: 'error',
        plugins: { 'secret-probe': { apiKey: 'sk-REAL-SECRET', timeoutMs: 30 } },
      },
    });
    apps.push(app);
    await app.plugin(def);
    await app.plugins.idle();
    expect(app.plugins.getPlugin('secret-probe')?.state).toBe('active');

    const { invoke } = mountPluginRoutes(app);
    const list = await invoke('GET /api/plugins');
    expect(list.status).toBe(200);
    const payload = JSON.stringify(list.body);
    expect(payload, '列表不得回显明文密钥').not.toContain('sk-REAL-SECRET');
    const row = (list.body as { plugins: Array<{ instanceId: string; config: Record<string, unknown> }> }).plugins.find(
      p => p.instanceId === 'secret-probe',
    );
    expect(row?.config.apiKey).toBe('••••••');
    expect(row?.config.timeoutMs).toBe(30);

    const editor = await invoke('GET /api/plugins/:name/config', { params: { name: 'secret-probe' } });
    expect(editor.status).toBe(200);
    expect((editor.body as { config: { apiKey: string } }).config.apiKey, '编辑器 GET 必须是原文').toBe(
      'sk-REAL-SECRET',
    );
  });
});
