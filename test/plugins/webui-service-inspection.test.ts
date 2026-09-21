import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, defineService, type Logger, provide, serviceFactory } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';

it('服务目录及偏好校验只查元数据，核心服务可见且不构造未使用的工厂', async () => {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const quiet: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
  };
  const app = new App({ config: { name: 'inspect-test', logLevel: 'error', plugins: {} }, logger: quiet });
  const token = 'service-inspection-test';
  const headers = { Cookie: `aalis_webui_token=${token}`, 'Content-Type': 'application/json' };
  const fakeStorage = {
    listRoots: () => [],
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
    list: async () => ({ entries: [] }),
    resolveLocalPath: async () => '/tmp/aalis-inspection/access.txt',
  } as unknown as StorageService;
  let creations = 0;
  const scoped = defineService<{ id: string }>('inspection-probe');
  try {
    const host = app.bind({ provide });
    host.provide(storage, fakeStorage);
    for (const id of ['factory-a', 'factory-b']) {
      host.provide(
        scoped,
        serviceFactory(() => {
          creations++;
          return { id };
        }),
        { entryId: id },
      );
    }
    await app.plugin(webuiServer, {
      port,
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'fixed',
      fixedToken: token,
      marketplaceRegistry: 'https://registry.example.invalid',
    });
    await app.plugins.idle();
    await app.start();
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/services`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      services: Record<
        string,
        {
          providers: Array<{ contextId: string; displayName?: string; scope: string; exclusive: boolean }>;
          preferred: string | null;
        }
      >;
    };
    for (const name of ['events', 'hooks', 'contributions', 'lifecycle', 'logger', 'config', 'provide', 'services']) {
      expect(body.services[name].providers).toEqual([
        expect.objectContaining({
          contextId: 'root',
          displayName: '@aalis/core',
          scope: 'activation',
          exclusive: true,
        }),
      ]);
    }
    for (const name of ['app', 'plugins', 'host-config']) {
      expect(body.services[name].providers).toEqual([expect.objectContaining({ contextId: 'root', scope: 'shared' })]);
    }
    expect(body.services['inspection-probe'].providers).toEqual([
      expect.objectContaining({ contextId: 'factory-a', scope: 'activation', exclusive: false }),
      expect.objectContaining({ contextId: 'factory-b', scope: 'activation', exclusive: false }),
    ]);
    expect(creations, '打开服务页不能实例化任意服务').toBe(0);

    const preferred = await fetch(`${base}/api/services/inspection-probe/prefer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contextId: 'factory-b' }),
    });
    expect(preferred.status).toBe(200);
    expect(app.config.getServicePreferences()['inspection-probe']).toBe('factory-b');
    expect(creations, '校验提供者存在不能调用工厂').toBe(0);

    const currentGraph = await fetch(`${base}/api/marketplace/depgraph?name=${encodeURIComponent(webuiServer.name)}`, {
      headers,
    });
    expect(currentGraph.status).toBe(200);
    const current = (await currentGraph.json()) as {
      services: { required: Array<{ service: string; providedBy: string | null }> };
    };
    expect(current.services.required).toEqual(
      ['events', 'logger', 'lifecycle', 'config', 'provide', 'services'].map(service => ({
        service,
        providedBy: '@aalis/core',
      })),
    );

    const defaults = [
      'events',
      'hooks',
      'contributions',
      'lifecycle',
      'logger',
      'config',
      'provide',
      'services',
      'app',
      'plugins',
      'host-config',
    ];
    const originalFetch = globalThis.fetch;
    const registry = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (String(url) === 'https://registry.example.invalid/uninstalled-inspection-probe') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              'dist-tags': { latest: '1.0.0' },
              versions: { '1.0.0': { aalis: { service: { required: [...defaults, 'inspection-probe', 'missing'] } } } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return originalFetch(url, init);
    });
    try {
      const remoteGraph = await fetch(`${base}/api/marketplace/depgraph?name=uninstalled-inspection-probe`, {
        headers,
      });
      expect(remoteGraph.status).toBe(200);
      const remote = (await remoteGraph.json()) as typeof current;
      expect(remote.services.required).toEqual([
        ...defaults.map(service => ({ service, providedBy: '@aalis/core' })),
        { service: 'inspection-probe', providedBy: 'factory-b' },
        { service: 'missing', providedBy: null },
      ]);
      expect(creations, '市场装前披露也不能实例化工厂').toBe(0);
    } finally {
      registry.mockRestore();
    }

    const refuse = vi.spyOn(app.services, 'prefer').mockReturnValueOnce(false);
    const rejected = await fetch(`${base}/api/services/inspection-probe/prefer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contextId: 'factory-a' }),
    });
    refuse.mockRestore();
    expect(rejected.status).toBe(409);
    expect(app.config.getServicePreferences()['inspection-probe'], '容器拒绝时不能落盘假偏好').toBe('factory-b');

    const wrong = await fetch(`${base}/api/services/events/prefer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contextId: 'unregistered-provider' }),
    });
    expect(wrong.status).toBe(404);
    expect(app.config.getServicePreferences().events).toBeUndefined();
  } finally {
    await app.stop();
  }
});
