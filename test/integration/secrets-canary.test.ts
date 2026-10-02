import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { hostConfig } from '../../packages/api-host-config/src/index.js';
import {
  App,
  appService,
  config,
  definePlugin,
  type Logger,
  type LogLevel,
  pluginsService,
  type ServiceRef,
} from '../../packages/core/src/index.js';
import { registerPluginRoutes } from '../../packages/plugin-webui-server/src/routes/plugins.js';
import { createConfigStore, installHostConfig } from '../../packages/runtime/src/config-store.js';
import { installConfigHotReload, withPluginConfigSync } from '../../packages/runtime/src/config-sync.js';
import { createPluginDiscovery, type PluginLoader } from '../../packages/runtime/src/plugin-discovery.js';
import { createFsSecretsProvider, createFsYamlConfigProvider } from '../../packages/runtime/src/providers.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { captureRoutes } from '../fixtures/webui-routes.js';

// ════════════════════════════════════════════════════════════
// 金丝雀：密钥只进 secrets.yaml，不进 aalis.config.yaml，也不经 WebUI 的读接口回到浏览器。
// 真实文件、与 startAalis 同一装配（配置与密钥两个 provider → 存储 → host-config → 同步 → 发现 → 热重载），
// 逐条走会写配置文件的路径：启动时的同步、WebUI 改配置、建实例、手改配置文件后的热重载、删实例。
// 每一步之后主配置文件里都找不到任何金丝雀；secrets.yaml 一直是 0600；删实例后它的键随之删除。
// ════════════════════════════════════════════════════════════

const SCHEMA = {
  apiKey: { type: 'string', label: 'Key', secret: true },
  model: { type: 'string', label: 'Model', default: 'm1' },
} as const;

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function refStub<T>(instance: T): ServiceRef<T> {
  return { current: instance, require: () => instance, all: () => [], follow: () => () => {} };
}

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('金丝雀密钥不进主配置文件', () => {
  it('启动同步、WebUI 改配置与建实例、手改后热重载、删实例：主配置与读接口里都没有原值', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aalis-canary-'));
    dirs.push(home);
    const configPath = join(home, 'aalis.config.yaml');
    const secretsPath = join(home, 'secrets.yaml');
    writeFileSync(configPath, 'name: T\nlogLevel: error\nplugins:\n  p:\n    apiKey: CANARY-1-PLACEHOLDER\n');
    writeFileSync(secretsPath, '', { mode: 0o600 });

    const seen: string[] = [];
    // 插件照真实写法经 parseConfig 读配置，记下各实例拿到的 apiKey
    const probe = definePlugin({
      name: 'p',
      reusable: true,
      configSchema: SCHEMA,
      uses: { config },
      apply({ config: raw }) {
        const parsed = parseConfig(SCHEMA, raw) as { apiKey?: string };
        seen.push(parsed.apiKey ?? '');
      },
    });
    const loader: PluginLoader = {
      discover: async () => [{ name: 'p', source: 'p' }],
      load: async () => probe,
    };

    const { config: doc, provider } = createFsYamlConfigProvider(configPath);
    const secrets = createFsSecretsProvider(secretsPath);
    const store = createConfigStore(doc, provider, secrets);
    const app = new App({ name: store.get('name'), logLevel: store.get('logLevel') as LogLevel, logger: silent });
    apps.push(app);
    installHostConfig(app, store);
    const prepared = withPluginConfigSync(loader, app, store);
    const discovery = createPluginDiscovery(app, prepared.loader, store);
    try {
      await discovery.loadAll();
    } finally {
      prepared.finishInitialLoad();
    }
    installConfigHotReload(app, store, discovery);

    const canaries = () => readFileSync(configPath, 'utf-8').match(/CANARY-\d/g) ?? [];
    const secretsFile = () => parse(readFileSync(secretsPath, 'utf-8')) as Record<string, string>;
    await waitFor(() => secretsFile()?.['p.apiKey'] === 'CANARY-1-PLACEHOLDER');
    expect(canaries(), '启动同步把手写进配置文件的明文移走').toEqual([]);
    expect(seen).toEqual(['CANARY-1-PLACEHOLDER']);

    const bound = app.bind({ app: appService, plugins: pluginsService, hostConfig });
    const { expressApp, invoke } = captureRoutes();
    registerPluginRoutes(
      expressApp,
      {
        app: refStub(bound.app.require()),
        source: { current: undefined },
        plugins: refStub(bound.plugins.require()),
        hostConfig: refStub(bound.hostConfig.require()),
        tools: { current: undefined },
        commands: { current: undefined },
        webui: () => undefined,
      },
      () => ({ platform: 'webui', userId: 'console' }),
      () => (_req: unknown, _res: unknown, next: () => void) => next(),
      () => undefined,
    );

    const put = await invoke('PUT /api/plugins/:name/config', {
      params: { name: 'p' },
      body: { config: { apiKey: 'CANARY-2-PLACEHOLDER' } },
      headers: {},
    });
    expect(put.status).toBe(200);
    expect(canaries(), 'WebUI 改配置').toEqual([]);
    expect(secretsFile()['p.apiKey']).toBe('CANARY-2-PLACEHOLDER');

    const created = await invoke('POST /api/plugins/:name/instances', {
      params: { name: 'p' },
      body: { suffix: 'b', config: { apiKey: 'CANARY-3-PLACEHOLDER' } },
      headers: {},
    });
    expect(created.status).toBe(200);
    expect(canaries(), 'WebUI 建实例').toEqual([]);
    expect(secretsFile()['p:b.apiKey']).toBe('CANARY-3-PLACEHOLDER');

    for (const route of ['GET /api/plugins', 'GET /api/config']) {
      const out = await invoke(route, { params: {}, body: {}, headers: {} });
      expect(JSON.stringify(out.body), route).not.toMatch(/CANARY/);
    }
    const one = await invoke('GET /api/plugins/:name/config', { params: { name: 'p:b' }, body: {}, headers: {} });
    expect(JSON.stringify(one.body)).not.toMatch(/CANARY/);
    const list = await invoke('GET /api/plugins', { params: {}, body: {}, headers: {} });
    expect((list.body as { secretRefCounts: Record<string, number> }).secretRefCounts).toEqual({
      'p.apiKey': 1,
      'p:b.apiKey': 1,
    });

    // 手改配置文件，把 p:b 的引用改成明文：热重载里的同步把它移走、文件随之改写，实例按新值重载。
    // 新值写回原来引用的那个键（同 WebUI 替换），旧值不留在 secrets.yaml 里
    const edited = parse(readFileSync(configPath, 'utf-8')) as { plugins: Record<string, Record<string, unknown>> };
    edited.plugins['p:b'].apiKey = 'CANARY-4-PLACEHOLDER';
    const tmp = `${configPath}.edit`;
    writeFileSync(tmp, stringify(edited));
    renameSync(tmp, configPath);
    await waitFor(() => canaries().length === 0 && secretsFile()['p:b.apiKey'] === 'CANARY-4-PLACEHOLDER');
    await waitFor(() => seen.includes('CANARY-4-PLACEHOLDER'));

    const removed = await invoke('DELETE /api/plugins/:instanceId/instance', {
      params: { instanceId: 'p:b' },
      body: {},
      headers: {},
    });
    expect(removed.status).toBe(200);
    expect(Object.keys(secretsFile()), '删实例：它引用的键随之删除').toEqual(['p.apiKey']);
    expect(canaries()).toEqual([]);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
  });
});
