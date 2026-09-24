import type { AalisConfig, AppService, HostConfig, Logger, PluginManagerService, ServiceRef } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidInstanceId } from '../../packages/core/src/composition/plugin-definition.js';
import { App, appService, config, definePlugin, hostConfig, pluginsService } from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';

// PUT /api/plugins/:name/config 必须与 YAML watch 同一政策：按 configSchema 裁未知键。
// :name 非法时 core 抛 Error，路由映射为 400 并透出 message（不把管理面输入变成 500）。

type Handler = (req: unknown, res: unknown, next: () => Promise<void>) => unknown;

function refStub<T>(instance: unknown): ServiceRef<T> {
  return { current: instance as T, require: () => instance as T, all: () => [], follow: () => () => {} };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

function silentLogger(): Logger {
  const l: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => l,
  };
  return l;
}

function silentApp(opts?: { config?: AalisConfig; logger?: Logger }): App {
  const app = new App({
    config: opts?.config ?? { name: 'T', logLevel: 'error', plugins: {} },
    logger: opts?.logger ?? silentLogger(),
  });
  apps.push(app);
  return app;
}

function attachRoutes(opts: {
  app: AppService;
  plugins: PluginManagerService;
  hostConfig: HostConfig;
  logger?: Logger;
}): {
  putPlugin: (name: string, body: unknown) => Promise<{ status: number; body?: unknown }>;
  getConfig: (name: string) => Promise<{ status: number; body?: unknown }>;
} {
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
  registerPluginRoutes(
    expressApp as never,
    {
      app: refStub(opts.app),
      source: { current: undefined },
      plugins: refStub(opts.plugins),
      hostConfig: refStub(opts.hostConfig),
      tools: { current: undefined },
      commands: { current: undefined },
      webui: () => undefined,
      logger: opts.logger,
    },
    () => ({ platform: 'webui', userId: 'console' }),
    () => (_req: unknown, _res: unknown, next: () => void) => next(),
    () => undefined,
  );

  const run = async (key: string, req: unknown) => {
    const handlers = routes.get(key);
    if (!handlers) throw new Error(`${key} 未注册`);
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

  return {
    putPlugin: (name, body) =>
      run('PUT /api/plugins/:name/config', {
        params: { name },
        body: { config: body },
        headers: {},
      }),
    getConfig: name =>
      run('GET /api/plugins/:name/config', {
        params: { name },
        body: {},
        headers: {},
      }),
  };
}

const SCHEMA: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key' },
  baseUrl: { type: 'string', label: 'Base URL', default: 'https://api.example.com' },
  timeoutMs: { type: 'number', label: '超时', default: 30000 },
};

describe('PUT /api/plugins/:name/config 与 watch 路径对齐', () => {
  it('叠加 stored、PUT 响应不回显密钥、bounce 后 config 是新的且与 ConfigManager 不别名', async () => {
    const app = silentApp({
      config: {
        name: 'T',
        logLevel: 'error',
        plugins: {
          target: {
            apiKey: 'sk-REAL-SECRET',
            baseUrl: 'https://api.example.com',
            timeoutMs: 30000,
          },
        },
      },
    });
    let seen: Record<string, unknown> | undefined;
    await app.plugin(
      definePlugin({
        name: 'target',
        configSchema: SCHEMA,
        uses: { config },
        apply({ config: cfg }) {
          seen = cfg as Record<string, unknown>;
        },
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('target')?.state).toBe('active');
    expect(seen?.apiKey).toBe('sk-REAL-SECRET');

    const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
    const api = attachRoutes({
      app: bound.app.require(),
      plugins: bound.plugins.require(),
      hostConfig: bound.hostConfig.require(),
    });

    const put = await api.putPlugin('target', { timeoutMs: 60000 });
    expect(put.status).toBe(200);
    const putText = JSON.stringify(put.body);
    expect(putText, 'PUT 响应不得回显密钥').not.toContain('sk-REAL-SECRET');
    await app.plugins.idle();
    expect(app.plugins.getPlugin('target')?.state).toBe('active');

    expect(seen?.timeoutMs, 'bounce 后内置 config 是新值').toBe(60000);
    expect(seen?.apiKey, '未提交的密钥必须从 stored 叠回去').toBe('sk-REAL-SECRET');
    expect(app.plugins.getPlugin('target')?.config).toMatchObject({
      apiKey: 'sk-REAL-SECRET',
      timeoutMs: 60000,
    });

    const fromMgr = app.config.getPluginConfig('target') as { timeoutMs: number };
    expect(fromMgr).not.toBe(seen);
    expect(fromMgr).not.toBe(app.plugins.getPlugin('target')?.config);
    (seen as { timeoutMs: number }).timeoutMs = 1;
    expect(fromMgr.timeoutMs, '就地改插件 config 不得写穿 ConfigManager').toBe(60000);
    expect(app.config.getPluginConfig('target').timeoutMs).toBe(60000);
  });

  it('PUT 未知键不进 stored / 现场 config，并 warn 点名（与 config-sync 同一政策）', async () => {
    const warnings: string[] = [];
    const logger = silentLogger();
    logger.warn = (msg: string, ...rest: unknown[]) => {
      warnings.push([msg, ...rest].map(String).join(' '));
    };
    const app = silentApp({
      logger,
      config: {
        name: 'T',
        logLevel: 'error',
        plugins: { target: { apiKey: 'sk-REAL-SECRET', timeoutMs: 30000 } },
      },
    });
    await app.plugin(
      definePlugin({
        name: 'target',
        configSchema: SCHEMA,
        uses: { config },
        apply() {},
      }),
    );
    await app.plugins.idle();
    expect(app.plugins.getPlugin('target')?.state).toBe('active');

    const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
    const api = attachRoutes({
      app: bound.app.require(),
      plugins: bound.plugins.require(),
      hostConfig: bound.hostConfig.require(),
      logger,
    });
    const unknown = await api.putPlugin('target', { timeoutMs: 70000, sneaky: true });
    expect(unknown.status).toBe(200);
    await app.plugins.idle();
    expect(
      (app.config.getPluginConfig('target') as { sneaky?: unknown }).sneaky,
      'PUT 未知键应裁掉（与 config-sync 同一政策）',
    ).toBeUndefined();
    expect((app.plugins.getPlugin('target')?.config as { sneaky?: unknown }).sneaky).toBeUndefined();
    expect(app.config.getPluginConfig('target').timeoutMs).toBe(70000);
    const hit = warnings.find(w => w.includes('裁掉 schema 外字段'));
    expect(hit, '裁剪必须点名，不能静默').toBeTruthy();
    expect(hit).toContain('sneaky');
    expect(hit).toContain('target');
  });
});

describe('GET/PUT /api/plugins/:name/config 非法 id', () => {
  it(':name 含 # 时 core 抛 Error，路由返回 400 并透出 message', async () => {
    // `#` 是定义闸已拒的形状（保留字符）。在窄面外用同一道闸包一层，
    // 钉的是路由「core 抛 Error → 400 + message」而不是自己猜非法规则。
    const app = silentApp();
    const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
    const inner = bound.hostConfig.require();
    const gated: HostConfig = Object.create(inner) as HostConfig;
    gated.getPluginConfig = (id: string) => {
      assertValidInstanceId(id);
      return inner.getPluginConfig(id);
    };
    gated.setPluginConfig = (id: string, cfg: Record<string, unknown>) => {
      assertValidInstanceId(id);
      inner.setPluginConfig(id, cfg);
    };
    gated.isPluginDisabled = (id: string) => {
      assertValidInstanceId(id);
      return inner.isPluginDisabled(id);
    };
    const api = attachRoutes({
      app: bound.app.require(),
      plugins: bound.plugins.require(),
      hostConfig: gated,
    });

    const illegal = 'evil#id';
    let thrown: Error | undefined;
    try {
      assertValidInstanceId(illegal);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeInstanceOf(Error);

    const get = await api.getConfig(illegal);
    expect(get.status).toBe(400);
    expect((get.body as { error: string }).error).toBe(thrown?.message);

    const put = await api.putPlugin(illegal, { timeoutMs: 1 });
    expect(put.status).toBe(400);
    expect((put.body as { error: string }).error).toBe(thrown?.message);
  });

  it('GET/PUT /api/plugins/__proto__/config 返回 400 且 message 含 插件 id 不合法: __proto__', async () => {
    const app = silentApp();
    const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
    const api = attachRoutes({
      app: bound.app.require(),
      plugins: bound.plugins.require(),
      hostConfig: bound.hostConfig.require(),
    });

    const get = await api.getConfig('__proto__');
    expect(get.status).toBe(400);
    expect((get.body as { error: string }).error).toContain('插件 id 不合法: __proto__');

    const put = await api.putPlugin('__proto__', { timeoutMs: 1 });
    expect(put.status).toBe(400);
    expect((put.body as { error: string }).error).toContain('插件 id 不合法: __proto__');
  });
});
