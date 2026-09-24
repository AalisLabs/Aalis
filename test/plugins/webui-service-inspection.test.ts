import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { defineService, type Logger, provide } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { createConfigStore, installHostConfig } from '../../packages/runtime/src/config-store.js';
import { activationHost, createInspectableApp } from '../helpers/inspectable-app.js';

it('服务目录与偏好校验：核心服务可见，偏好只认已登记的提供者', async () => {
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
  // 与 startAalis 同一装配：文档 → App → installHostConfig（host-config 由宿主登记在根上）
  const store = createConfigStore({ name: 'inspect-test', logLevel: 'error', plugins: {} });
  const app = createInspectableApp({ name: 'inspect-test', logLevel: 'error', logger: quiet });
  installHostConfig(app, store);
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
  const inspected = defineService<{ id: string }>('inspection-probe');
  try {
    const host = app.bind({ provide });
    host.provide(storage, fakeStorage);
    for (const id of ['probe-a', 'probe-b']) host.provide(inspected, { id }, { entryId: id });
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
          providers: Array<{ contextId: string; displayName?: string; exclusive: boolean }>;
          preferred: string | null;
        }
      >;
    };
    for (const name of ['events', 'hooks', 'contributions', 'lifecycle', 'logger', 'config', 'provide', 'services']) {
      expect(body.services[name].providers).toEqual([
        expect.objectContaining({
          contextId: 'root',
          displayName: '@aalis/core',
          exclusive: true,
        }),
      ]);
    }
    for (const name of ['app', 'plugins', 'host-config']) {
      expect(body.services[name].providers).toEqual([expect.objectContaining({ contextId: 'root', exclusive: true })]);
    }
    expect(body.services['inspection-probe'].providers).toEqual([
      expect.objectContaining({ contextId: 'probe-a', exclusive: false }),
      expect.objectContaining({ contextId: 'probe-b', exclusive: false }),
    ]);

    const preferred = await fetch(`${base}/api/services/inspection-probe/prefer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contextId: 'probe-b' }),
    });
    expect(preferred.status).toBe(200);
    expect(store.getServicePreferences()['inspection-probe']).toBe('probe-b');

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
        providedBy: '宿主',
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
        ...defaults.map(service => ({ service, providedBy: '宿主' })),
        { service: 'inspection-probe', providedBy: 'probe-b' },
        { service: 'missing', providedBy: null },
      ]);
    } finally {
      registry.mockRestore();
    }

    const refuse = vi.spyOn(activationHost(app).runtime.services, 'prefer').mockReturnValueOnce(false);
    const rejected = await fetch(`${base}/api/services/inspection-probe/prefer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contextId: 'probe-a' }),
    });
    refuse.mockRestore();
    expect(rejected.status).toBe(409);
    expect(store.getServicePreferences()['inspection-probe'], '容器拒绝时不能落盘假偏好').toBe('probe-b');

    const wrong = await fetch(`${base}/api/services/events/prefer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contextId: 'unregistered-provider' }),
    });
    expect(wrong.status).toBe(404);
    expect(store.getServicePreferences().events).toBeUndefined();
  } finally {
    await app.stop();
  }
});
