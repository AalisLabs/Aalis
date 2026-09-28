import { describe, expect, it, vi } from 'vitest';
import type { BoundPublish, PublishedItem } from '../../packages/api-publish/src/index.js';
import type { BoundWebui } from '../../packages/api-webui/src/index.js';
import {
  PagesApiError,
  PagesClient,
  type PagesDeployment,
} from '../../packages/plugin-works-site/src/cloudflare/client.js';
import { assetKey } from '../../packages/plugin-works-site/src/cloudflare/hash.js';
import type { WorksSiteConfig } from '../../packages/plugin-works-site/src/config.js';
import { WorksDeployer } from '../../packages/plugin-works-site/src/deploy.js';
import { STATE_URI, WorksStore } from '../../packages/plugin-works-site/src/state.js';
import { ContentMismatchError, checkPreflight, verifyContent } from '../../packages/plugin-works-site/src/verify.js';
import { registerWorksPage } from '../../packages/plugin-works-site/src/webui.js';
import { startFakePages } from '../fixtures/fake-pages.js';
import { memoryStorage } from '../fixtures/paper.js';

const settings = { fail_open: false, env_vars: {}, kv_namespaces: [] };
const project = {
  name: 'aalis',
  productionBranch: 'main',
  subdomain: 'aalis.pages.dev',
  domains: ['aalis.pages.dev'],
  deploymentConfigs: { production: settings, preview: settings },
};
function fixture(overrides: Record<string, unknown> = {}) {
  return {
    getProject: vi.fn(async () => ({ ...project, ...overrides })),
    listDomains: vi.fn(async () => [] as string[]),
    listDeployments: vi.fn(async (): Promise<PagesDeployment[]> => []),
  };
}

describe('作品站部署前核对', () => {
  it('已知绑定、域名与账外部署暂停上新，未知新增字段只告警', async () => {
    const bound = await checkPreflight(
      fixture({
        deploymentConfigs: {
          production: { ...settings, env_vars: { SECRET: { value: 'x' } } },
          preview: settings,
        },
      }),
      { productionBranch: 'main', failOpen: false, mainOrigins: ['https://aalis.pages.dev'] },
      new Set(),
    );
    expect(bound.pause).toBe(true);
    expect(bound.issues.some(i => i.kind === 'settings')).toBe(true);

    const unknown = await checkPreflight(
      fixture({
        deploymentConfigs: {
          production: { ...settings, future_setting: { enabled: true } },
          preview: settings,
        },
      }),
      { productionBranch: 'main', failOpen: false, mainOrigins: ['https://aalis.pages.dev'] },
      new Set(),
    );
    expect(unknown.pause).toBe(false);
    expect(unknown.issues.some(i => i.kind === 'settings')).toBe(true);

    const otherDomain = fixture();
    otherDomain.listDomains.mockResolvedValue(['evil.example']);
    expect(
      (
        await checkPreflight(
          otherDomain,
          { productionBranch: 'main', failOpen: false, mainOrigins: ['https://aalis.pages.dev'] },
          new Set(),
        )
      ).pause,
    ).toBe(true);

    const rogue = fixture();
    rogue.listDeployments.mockResolvedValue([
      {
        id: 'aaaaaaaa-1111',
        branch: 'main',
        environment: 'production',
        stage: { name: 'deploy', status: 'success' },
        aliases: [],
      },
    ]);
    expect(
      (
        await checkPreflight(
          rogue,
          { productionBranch: 'main', failOpen: false, mainOrigins: ['https://aalis.pages.dev'] },
          new Set(),
        )
      ).issues,
    ).toContainEqual(expect.objectContaining({ kind: 'unknown-deployment', pause: true }));
  });
});

describe('作品站持久状态与内容核对', () => {
  it('stop 后迟到的预检结果不得创建在飞部署或写新状态', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    let release: ((value: unknown) => void) | undefined;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const getProject = vi.fn(() => gate);
    const deploy = vi.fn();
    const client = {
      getProject,
      listDomains: async () => [],
      listDeployments: async () => [],
      deploy,
    } as unknown as PagesClient;
    const config: WorksSiteConfig = {
      accountId: '0'.repeat(32),
      apiToken: 'sentinel',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const controller = new AbortController();
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => ({
        listPublished: () => [],
        readFile: async () => new Uint8Array(),
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    deployer.start();
    await eventually(() => getProject.mock.calls.length > 0);
    await deployer.stop();
    release?.({
      name: 'aalis',
      productionBranch: 'main',
      subdomain: 'aalis.pages.dev',
      domains: ['aalis.pages.dev'],
      deploymentConfigs: { production: { fail_open: false }, preview: { fail_open: false } },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(deploy).not.toHaveBeenCalled();
    expect(store.data?.inFlight).toBeUndefined();
    expect(store.data?.history).toHaveLength(0);
  });

  it('失败的新生产部署仍是远端当前版时保留 known，等待下一次主站替换', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const oldId = 'aaaaaaaa';
    const failedId = 'bbbbbbbb';
    await store.update(state => {
      state.current.main = { id: oldId, branch: 'main', nonce: 'old', at: 1, files: {}, works: [], verified: true };
      state.known[oldId] = { branch: 'main', at: 1 };
      state.known[failedId] = { branch: 'main', at: 2 };
      state.paused = { reason: '部署后线上核对失败', at: 2 };
    });
    const deployment: PagesDeployment = {
      id: failedId,
      branch: 'main',
      environment: 'production',
      stage: { name: 'deploy', status: 'success' },
      aliases: [],
    };
    const deleteDeployment = vi.fn(async () => {});
    const client = {
      listDeployments: vi.fn(async () => [deployment, { ...deployment, id: oldId }]),
      deleteDeployment,
    } as unknown as PagesClient;
    const config: WorksSiteConfig = {
      accountId: '0'.repeat(32),
      apiToken: 'sentinel',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const controller = new AbortController();
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => undefined,
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    try {
      deployer.start();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(deleteDeployment).not.toHaveBeenCalled();
      expect(store.data?.known[failedId]).toBeDefined();
      expect(store.data?.paused?.reason).toContain('核对失败');
    } finally {
      controller.abort();
      await deployer.stop();
    }
  });

  it('新分支回滚 DELETE 失败后，孤儿 known 部署自动重试强删', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const branch = 'p-12345678';
    const id = 'aaaaaaaa';
    await store.update(state => {
      state.groups.opaque = { branch, createdAt: 1 };
      state.known[id] = { branch, at: 2 };
    });
    const deployment: PagesDeployment = {
      id,
      branch,
      environment: 'preview',
      stage: { name: 'deploy', status: 'success' },
      aliases: [],
    };
    const deleteDeployment = vi
      .fn()
      .mockRejectedValueOnce(new PagesApiError('transient', 'temporary'))
      .mockResolvedValue(undefined);
    const client = { listDeployments: vi.fn(async () => [deployment]), deleteDeployment } as unknown as PagesClient;
    const config: WorksSiteConfig = {
      accountId: '0'.repeat(32),
      apiToken: 'sentinel',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const controller = new AbortController();
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => undefined,
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
      retryBaseMs: 10,
    });
    try {
      deployer.start();
      await eventually(() => !store.data?.known[id]);
      expect(deleteDeployment).toHaveBeenCalledTimes(2);
      expect(deleteDeployment).toHaveBeenCalledWith(id, expect.objectContaining({ force: true }));
      expect(store.data?.paused).toBeUndefined();
    } finally {
      controller.abort();
      await deployer.stop();
    }
  });

  it('发布服务暂不在场时仍清理账内旧部署，停机后的动作拒绝', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const oldId = 'aaaaaaaa';
    const currentId = 'bbbbbbbb';
    await store.update(state => {
      state.current.main = { id: currentId, branch: 'main', nonce: 'new', at: 2, files: {}, works: [], verified: true };
      state.known[oldId] = { branch: 'main', at: 1 };
      state.known[currentId] = { branch: 'main', at: 2 };
    });
    const deployed: PagesDeployment = {
      id: oldId,
      branch: 'main',
      environment: 'production',
      stage: { name: 'deploy', status: 'success' },
      aliases: [],
    };
    const deleteDeployment = vi.fn(async () => {});
    const client = {
      listDeployments: vi.fn(async () => [{ ...deployed, id: currentId }, deployed]),
      deleteDeployment,
    } as unknown as PagesClient;
    const config: WorksSiteConfig = {
      accountId: '0'.repeat(32),
      apiToken: 'sentinel',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const controller = new AbortController();
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => undefined,
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    deployer.start();
    await eventually(() => !store.data?.known[oldId]);
    expect(deleteDeployment).toHaveBeenCalledWith(oldId, expect.objectContaining({ force: false }));
    await deployer.stop();
    await expect(deployer.acknowledge('missing')).rejects.toThrow(/已停止/);
  });

  it('撤下部署别名不合格时仍清旧并把 current 指向已建成的新部署', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const id = 'abcdefghij';
    const branch = 'p-12345678';
    const oldId = 'aaaaaaaa';
    const newId = 'bbbbbbbb';
    const item: PublishedItem = {
      id,
      group: 'opaque',
      groupLabel: '朋友',
      surfaces: ['works'],
      kind: 'html',
      title: '网页',
      summary: '',
      credit: '群友',
      publishedAt: 1,
      files: [{ path: 'index.html', size: 1, contentType: 'text/html; charset=utf-8' }],
      hasThumbnail: false,
    };
    await store.update(state => {
      state.groups.opaque = { branch, alias: 'https://p-12345678.aalis.pages.dev', createdAt: 1 };
      state.current[branch] = { id: oldId, branch, nonce: 'old', at: 1, files: {}, works: [item], verified: true };
      state.known[oldId] = { branch, at: 1 };
      state.known[newId] = { branch, at: 2 };
      state.inFlight = {
        id: newId,
        branch,
        nonce: 'fresh',
        at: 2,
        files: {},
        works: [],
        changed: [],
        kind: 'withdraw',
      };
      state.tombstones.push({ branch: 'opaque', path: `/${id}/index.html`, until: Date.now() + 10000 });
    });
    const deployed: PagesDeployment = {
      id: newId,
      branch,
      environment: 'preview',
      stage: { name: 'deploy', status: 'success' },
      aliases: ['https://evil.invalid'],
    };
    const deleteDeployment = vi.fn(async () => {});
    const client = {
      waitForDeployment: vi.fn(async () => deployed),
      aliasOf: () => ({ ok: false, reason: '主机不对' }),
      listDeployments: vi.fn(async () => [deployed, { ...deployed, id: oldId }]),
      deleteDeployment,
    } as unknown as PagesClient;
    const config: WorksSiteConfig = {
      accountId: '0'.repeat(32),
      apiToken: 'sentinel',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const controller = new AbortController();
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => ({
        listPublished: () => [],
        readFile: async () => new Uint8Array(),
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    try {
      deployer.start();
      await eventually(() => store.data?.current[branch]?.id === newId);
      expect(store.data?.current[branch]?.works).toEqual([]);
      expect(store.data?.paused?.reason).toContain('别名');
      expect(store.data?.known[oldId]).toBeUndefined();
      expect(deleteDeployment).toHaveBeenCalledWith(oldId, expect.objectContaining({ force: false }));
    } finally {
      controller.abort();
      await deployer.stop();
    }
  });

  it('坏状态不得被新盐覆盖，也不得继续部署', async () => {
    const files = new Map<string, string | Uint8Array>([[STATE_URI, '{broken']]);
    const store = new WorksStore(memoryStorage(files));
    await store.load();
    expect(store.failure).toBeTruthy();
    expect(files.get(STATE_URI)).toBe('{broken');
    expect(() => store.copy()).toThrow();
  });

  it('变更文件逐个用随机查询串核对哈希，投毒内容被拒', async () => {
    const called: string[] = [];
    const file = { path: '/w/abcdefghij/index.html', bytes: new TextEncoder().encode('expected') };
    await expect(
      verifyContent(
        async input => {
          called.push(String(input));
          return new Response('poisoned', { status: 200 });
        },
        'https://example.test',
        [file],
        [file.path],
        false,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ContentMismatchError);
    expect(called).toHaveLength(1);
    expect(called[0]).toMatch(/\?c=[0-9a-f-]+$/);
  });

  it('并发页面告警已读与部署更新不互相覆盖', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    await store.update(state => {
      state.alerts.push({ id: 'one', kind: 'settings', detail: 'test', at: 1 });
    });
    await Promise.all([
      store.update(state => {
        state.alerts[0].acknowledged = true;
      }),
      store.update(state => {
        state.history.push({ at: 2, branch: 'main', deployment: 'aaaaaaaa', result: 'live' });
      }),
    ]);
    expect(store.data?.alerts[0].acknowledged).toBe(true);
    expect(store.data?.history).toHaveLength(1);
  });

  it('发布后的页面缩略图只从 publish 服务读取，不碰审核插件临时目录', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const id = 'abcdefghij';
    const item: PublishedItem = {
      id,
      group: 'opaque',
      groupLabel: '朋友',
      surfaces: ['works'],
      kind: 'media',
      title: '画',
      summary: '',
      credit: '来自群友的点子',
      publishedAt: 1,
      files: [{ path: 'image.png', size: 3, contentType: 'image/png' }],
      hasThumbnail: true,
    };
    await store.update(state => {
      state.current.main = { id: 'aaaaaaaa', branch: 'main', nonce: 'a', at: 2, files: {}, works: [item] };
    });
    const actions = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const webui = {
      registerPage: vi.fn(),
      registerAction: (name: string, fn: (args: Record<string, unknown>) => Promise<unknown>) => {
        actions.set(name, fn);
        return () => {};
      },
    } as unknown as BoundWebui;
    const readThumbnail = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const publish = { current: { readThumbnail } } as unknown as BoundPublish;
    const config: WorksSiteConfig = {
      accountId: '0'.repeat(32),
      apiToken: 'sentinel',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const deployer = { health: () => ({ ok: true }), onlineFailOpen: false, active: true } as unknown as WorksDeployer;
    registerWorksPage({ webui, publish, store, deployer, config });
    expect(await actions.get('worksStatus')?.({})).toEqual(
      expect.objectContaining({
        content: expect.stringContaining('主站：https://aalis.pages.dev'),
      }),
    );
    expect(await actions.get('worksThumbnail')?.({ id })).toEqual({
      name: `${id}.png`,
      mime: 'image/png',
      base64: Buffer.from([1, 2, 3]).toString('base64'),
    });
    expect(readThumbnail).toHaveBeenCalledWith(id);
  });
});

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('部署未在时限内完成');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('作品站编排与假 Pages', () => {
  it('重启认领同一 nonce 的两个在飞部署时暂停，不猜一份继续', async () => {
    const fake = await startFakePages();
    const controller = new AbortController();
    const token = 'test-token-sentinel';
    fake.tokens.set(token, { kind: 'account' });
    fake.project.deployment_configs.production.fail_open = false;
    fake.project.deployment_configs.preview.fail_open = false;
    fake.customDomains.push('aalis.localhost');
    const marker = 'restartnonce';
    const at = Date.now() - 10_000;
    fake.seedDeployment({ branch: 'main', manifest: { [`/v/${marker}.txt`]: 'a'.repeat(32) }, createdAt: at + 1 });
    fake.seedDeployment({ branch: 'main', manifest: { [`/v/${marker}.txt`]: 'a'.repeat(32) }, createdAt: at + 2 });
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    await store.update(state => {
      state.inFlight = { branch: 'main', nonce: marker, at, files: {}, works: [], changed: [], kind: 'new' };
    });
    const siteOrigin = `http://aalis.localhost:${fake.port}`;
    const config: WorksSiteConfig = {
      accountId: fake.accountId,
      apiToken: token,
      projectName: fake.projectName,
      productionBranch: 'main',
      siteOrigin,
      mainOrigins: [siteOrigin],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const client = new PagesClient({
      accountId: fake.accountId,
      apiToken: token,
      projectName: fake.projectName,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
      signal: controller.signal,
      apiBase: fake.apiBase,
      hostSuffix: fake.hostSuffix,
      protocol: 'http:',
      ratePerSecond: 1000,
      retryBaseMs: 10,
      pollIntervalMs: 10,
    });
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => ({
        listPublished: () => [],
        readFile: async () => new Uint8Array(),
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    try {
      deployer.start();
      await eventually(() => !!store.data?.paused);
      expect(store.data?.alerts).toContainEqual(
        expect.objectContaining({
          kind: 'unknown-deployment',
          detail: '同一 nonce 对应多个部署',
        }),
      );
      expect(store.data?.inFlight?.id).toBeUndefined();
      expect(fake.deployments).toHaveLength(2);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  });

  it('凭据格式错误立即归类鉴权失败，不暂停且不发任何请求', async () => {
    const controller = new AbortController();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('unexpected fetch');
    });
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const config: WorksSiteConfig = {
      accountId: 'invalid-account',
      apiToken: 'token',
      projectName: 'aalis',
      productionBranch: 'main',
      siteOrigin: 'https://aalis.pages.dev',
      mainOrigins: ['https://aalis.pages.dev'],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const client = new PagesClient({
      accountId: config.accountId,
      apiToken: config.apiToken,
      projectName: config.projectName,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => ({
        listPublished: () => [],
        readFile: async () => new Uint8Array(),
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    try {
      deployer.start();
      await eventually(() => store.data?.lastFailure === 'auth');
      expect(store.data?.paused).toBeUndefined();
      expect(deployer.health()).toEqual({ ok: false, reason: 'Cloudflare 鉴权失败' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await deployer.stop();
      fetchSpy.mockRestore();
    }
  });

  it('激活只落本机盐，后台首次部署空主站并在确认后回报', async () => {
    const fake = await startFakePages();
    const controller = new AbortController();
    const files = new Map<string, string | Uint8Array>();
    const store = new WorksStore(memoryStorage(files));
    await store.load();
    expect(store.data?.assetSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.requests).toHaveLength(0);
    const token = 'test-token-sentinel';
    fake.tokens.set(token, { kind: 'account' });
    fake.project.deployment_configs.production.fail_open = false;
    fake.project.deployment_configs.preview.fail_open = false;
    fake.queuedMs = 10;
    fake.customDomains.push('aalis.localhost');
    const siteOrigin = `http://aalis.localhost:${fake.port}`;
    const config: WorksSiteConfig = {
      accountId: fake.accountId,
      apiToken: token,
      projectName: fake.projectName,
      productionBranch: 'main',
      siteOrigin,
      mainOrigins: [siteOrigin],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const client = new PagesClient({
      accountId: fake.accountId,
      apiToken: token,
      projectName: fake.projectName,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
      signal: controller.signal,
      apiBase: fake.apiBase,
      hostSuffix: fake.hostSuffix,
      protocol: 'http:',
      ratePerSecond: 1000,
      retryBaseMs: 10,
      pollIntervalMs: 10,
      deployTimeoutMs: 2000,
    });
    const live = vi.fn();
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      publish: () => ({
        listPublished: () => [],
        readFile: async () => new Uint8Array(),
        readThumbnail: async () => new Uint8Array(),
      }),
      live,
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    try {
      deployer.start();
      await eventually(() => !!store.data?.current.main || !!store.data?.lastFailure);
      expect(store.data?.current.main).toBeDefined();
      expect(live).toHaveBeenCalledWith([]);
      expect(fake.requestsTo('GET', /^\/v\//).some(request => request.path.includes('?t='))).toBe(true);
      expect(files.get('pluginData:/works-site/state.json')).not.toContain(token);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  });

  it('上新先分支后主站；撤下先主站后分支且防抖中的新作不会夹带上线', async () => {
    const fake = await startFakePages();
    const controller = new AbortController();
    const files = new Map<string, string | Uint8Array>();
    const store = new WorksStore(memoryStorage(files));
    await store.load();
    const token = 'test-token-sentinel';
    fake.tokens.set(token, { kind: 'account' });
    fake.project.deployment_configs.production.fail_open = false;
    fake.project.deployment_configs.preview.fail_open = false;
    fake.customDomains.push('aalis.localhost');
    fake.queuedMs = 10;
    const siteOrigin = `http://aalis.localhost:${fake.port}`;
    const config: WorksSiteConfig = {
      accountId: fake.accountId,
      apiToken: token,
      projectName: fake.projectName,
      productionBranch: 'main',
      siteOrigin,
      mainOrigins: [siteOrigin],
      failOpen: false,
      siteTitle: '作品集',
      siteIntro: '',
    };
    const client = new PagesClient({
      accountId: fake.accountId,
      apiToken: token,
      projectName: fake.projectName,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
      signal: controller.signal,
      apiBase: fake.apiBase,
      hostSuffix: fake.hostSuffix,
      protocol: 'http:',
      ratePerSecond: 1000,
      retryBaseMs: 10,
      pollIntervalMs: 10,
      deployTimeoutMs: 2000,
    });
    const html = new TextEncoder().encode('<!doctype html><p>hello</p>');
    const html2 = new TextEncoder().encode('<!doctype html><p>world</p>');
    const firstId = 'abcdefghij';
    const make = (id: string): PublishedItem => ({
      id,
      group: 'opaque-room',
      groupLabel: '朋友',
      surfaces: ['works'],
      kind: 'html',
      title: `作品 ${id}`,
      summary: '',
      credit: '来自群友的点子',
      publishedAt: Date.now(),
      files: [{ path: 'index.html', size: html.length, contentType: 'text/html; charset=utf-8' }],
      hasThumbnail: false,
    });
    let published: PublishedItem[] = [];
    let lagOn = false;
    const deployer = new WorksDeployer({
      config,
      store,
      client,
      debounceMs: 30,
      retryBaseMs: 20,
      convergenceMs: 40,
      convergencePauseMs: 10,
      publish: () => ({
        listPublished: () => [...published],
        readFile: async id => (id === firstId ? html : html2),
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      fetch: (input, init) =>
        lagOn && String(input) === `${siteOrigin}/index.html`
          ? Promise.resolve(new Response('old cached page', { status: 200 }))
          : fetch(input, init),
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
    });
    try {
      deployer.start();
      await eventually(() => !!store.data?.current.main);
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(store.data?.alerts.some(alert => alert.kind === 'cache-lag')).toBe(false);
      lagOn = true;
      const first = make(firstId);
      published = [first];
      deployer.change();
      await eventually(() => store.data?.current.main?.works.some(item => item.id === first.id) === true, 6000);
      await eventually(() => store.data?.alerts.some(alert => alert.kind === 'cache-lag') === true, 2000);
      lagOn = false;
      expect(store.data?.paused).toBeUndefined();
      expect(fake.deployments.slice(-2).map(item => item.branch)).toEqual([
        store.data?.groups[first.group].branch,
        'main',
      ]);
      const oldMainId = store.data!.current.main.id;
      fake.intercept(
        'DELETE',
        new RegExp(`/deployments/${oldMainId}$`),
        { status: 503, body: { success: false, errors: [{ code: 500, message: 'temporary' }] } },
        3,
      );
      const beforeWithdrawal = fake.deployments.length;
      const second = make('bbcdefghij');
      const poisonedKey = await assetKey(store.data!.assetSalt, 'html', html2);
      fake.assets.set(poisonedKey, {
        bytes: new TextEncoder().encode('<script>poisoned</script>'),
        contentType: 'text/html; charset=utf-8',
      });
      published = [second];
      deployer.change();
      await eventually(() => store.data?.current.main?.works.every(item => item.id !== first.id) === true, 6000);
      await eventually(() => store.data?.current[store.data.groups[first.group].branch]?.works.length === 0, 6000);
      expect(store.data?.current.main?.works).toEqual([]);
      expect(fake.deployments.slice(beforeWithdrawal, beforeWithdrawal + 2).map(item => item.branch)).toEqual([
        'main',
        store.data?.groups[first.group].branch,
      ]);
      expect(store.data?.tombstones).toContainEqual(
        expect.objectContaining({ branch: 'main', path: `/w/${first.id}/index.html` }),
      );
      expect(store.data?.current.main?.works.some(item => item.id === second.id)).toBe(false);
      await eventually(() => fake.deployments.find(item => item.id === oldMainId)?.deleted === true, 6000);
      await eventually(() => !!store.data?.paused, 6000);
      expect(store.data?.alerts.some(alert => alert.kind === 'content')).toBe(true);
      expect(store.data?.history.some(entry => entry.result === 'rolled-back')).toBe(true);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 20_000);
});
