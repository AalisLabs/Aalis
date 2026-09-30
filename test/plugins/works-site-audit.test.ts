import { describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../../packages/api-doctor/src/index.js';
import type { PublishedItem } from '../../packages/api-publish/src/index.js';
import { PagesClient, type PagesDeployment } from '../../packages/plugin-works-site/src/cloudflare/client.js';
import type { WorksSiteConfig } from '../../packages/plugin-works-site/src/config.js';
import { WorksDeployer } from '../../packages/plugin-works-site/src/deploy.js';
import { registerWorksDoctor } from '../../packages/plugin-works-site/src/doctor.js';
import { buildGallery } from '../../packages/plugin-works-site/src/site/build.js';
import { WorksStore } from '../../packages/plugin-works-site/src/state.js';
import { hashFiles, sha256 } from '../../packages/plugin-works-site/src/verify.js';
import { type FakePages, startFakePages } from '../fixtures/fake-pages.js';
import { memoryStorage } from '../fixtures/paper.js';

async function eventually(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('expected transition did not occur');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function setup(fake: FakePages, signal: AbortSignal) {
  const token = 'test-token-sentinel';
  fake.tokens.set(token, { kind: 'account' });
  fake.project.deployment_configs.production.fail_open = false;
  fake.project.deployment_configs.preview.fail_open = false;
  fake.customDomains.push('aalis.localhost');
  const siteOrigin = `http://aalis.localhost:${fake.port}`;
  const config: WorksSiteConfig = {
    targetId: 'works',
    basePath: '/',
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
    signal,
    apiBase: fake.apiBase,
    hostSuffix: fake.hostSuffix,
    protocol: 'http:',
    ratePerSecond: 1000,
    retryBaseMs: 5,
    pollIntervalMs: 5,
  });
  return { config, client };
}

describe('作品站独立故障交接审计', () => {
  it('非根目录部署仅服务所选目标，撤下墓碑也留在同一目录', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    deps.config.targetId = 'draw';
    deps.config.basePath = '/draw/';
    let published: PublishedItem[] = [
      {
        id: 'abcdefghij',
        group: 'opaque',
        groupLabel: '朋友',
        surfaces: ['draw'],
        kind: 'media',
        title: '画',
        summary: '',
        publishedAt: 1,
        files: [{ path: 'image.png', size: 1, contentType: 'image/png' }],
        hasThumbnail: false,
      },
    ];
    const listPublished = vi.fn((surface: string) => (surface === 'draw' ? published : []));
    const live = vi.fn();
    const deployer = new WorksDeployer({
      ...deps,
      store,
      publish: () => ({
        listPublished,
        readFile: async () => new Uint8Array([1]),
        readThumbnail: async () => new Uint8Array(),
      }),
      live,
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
      debounceMs: 1,
      retryBaseMs: 20,
    });
    try {
      deployer.start();
      await eventually(() => store.data?.current.main?.works.some(work => work.id === 'abcdefghij') ?? false);
      expect(listPublished).toHaveBeenCalledWith('draw');
      const current = fake.deployments.find(item => !item.deleted && item.branch === 'main');
      expect(current?.manifest).toHaveProperty('/draw/index.html');
      expect(current?.manifest).toHaveProperty('/draw/w/abcdefghij/index.html');
      expect(current?.manifest).not.toHaveProperty('/w/abcdefghij/index.html');
      // current 先落盘，完成旧部署清理后才发出上线回调。
      await eventually(() => live.mock.calls.length > 0);
      expect(live).toHaveBeenCalledWith(['abcdefghij']);
      published = [];
      deployer.change();
      await eventually(() => store.data?.current.main?.works.length === 0);
      expect(store.data?.tombstones).toContainEqual(
        expect.objectContaining({ branch: 'main', path: '/draw/w/abcdefghij/index.html' }),
      );
      expect(store.data?.current.main?.files).toHaveProperty('/draw/w/abcdefghij/index.html');
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);

  it('非根 HTML 先建隔离分支，撤下后主站与分支墓碑均完成', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    deps.config.targetId = 'draw';
    deps.config.basePath = '/draw/';
    const bytes = new TextEncoder().encode('<!doctype html><html><body>ok</body></html>');
    let published: PublishedItem[] = [
      {
        id: 'abcdefghij',
        group: 'opaque',
        groupLabel: '朋友',
        surfaces: ['draw'],
        kind: 'html',
        title: '网页',
        summary: '',
        publishedAt: 1,
        files: [{ path: 'index.html', size: bytes.length, contentType: 'text/html; charset=utf-8' }],
        hasThumbnail: false,
      },
    ];
    const deployer = new WorksDeployer({
      ...deps,
      store,
      publish: () => ({
        listPublished: () => published,
        readFile: async () => bytes,
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
      debounceMs: 1,
      retryBaseMs: 20,
    });
    try {
      deployer.start();
      await eventually(
        () =>
          store.data?.current.main?.verified === true &&
          Object.values(store.data?.current ?? {}).some(item => item.branch.startsWith('p-') && item.verified),
      );
      published = [];
      deployer.change();
      await eventually(
        () =>
          store.data?.current.main?.works.length === 0 &&
          Object.values(store.data?.current ?? {})
            .filter(item => item.branch.startsWith('p-'))
            .every(item => item.works.length === 0),
      );
      expect(store.data?.tombstones).toContainEqual(
        expect.objectContaining({ branch: 'main', path: '/draw/w/abcdefghij/index.html' }),
      );
      expect(store.data?.tombstones).toContainEqual(
        expect.objectContaining({ branch: 'opaque', path: '/abcdefghij/index.html' }),
      );
      expect(store.data?.paused).toBeUndefined();
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);

  it('注册的 doctor 检查在 token 距过期不足十四天时给 warn', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const now = 1_000_000;
    const expires = now + 14 * 24 * 60 * 60_000 - 1;
    let run!: () => CheckResult;
    const doctor = {
      registerCheck: (check: { run: () => CheckResult }) => {
        run = check.run;
      },
    } as never;
    const deployer = {
      health: () => ({ ok: true }),
      onlineFailOpen: false,
      tokenExpiresOn: expires,
    } as unknown as WorksDeployer;
    const config = { failOpen: false } as WorksSiteConfig;
    registerWorksDoctor({ doctor, config, deployer, store, now: () => now });
    expect(run()).toMatchObject({
      id: 'works-site.config',
      level: 'warn',
      message: 'Cloudflare token 将在 14 天内过期',
    });
  });

  it('注册的 doctor 检查在 token 到期当刻给 error', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const now = 1_000_000;
    let run!: () => CheckResult;
    const doctor = {
      registerCheck: (check: { run: () => CheckResult }) => {
        run = check.run;
      },
    } as never;
    const deployer = {
      health: () => ({ ok: true }),
      onlineFailOpen: false,
      tokenExpiresOn: now,
    } as unknown as WorksDeployer;
    const config = { failOpen: false } as WorksSiteConfig;
    registerWorksDoctor({ doctor, config, deployer, store, now: () => now });
    expect(run()).toMatchObject({ id: 'works-site.config', level: 'error', message: 'Cloudflare token 已过期' });
  });

  it('无 id 的在飞部署没有 nonce 匹配时清掉旧计划并重做空主站', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const staleNonce = 'lostnonce';
    await store.update(state => {
      state.inFlight = {
        kind: 'new',
        branch: 'main',
        nonce: staleNonce,
        at: Date.now() - 1000,
        files: {},
        works: [],
        changed: [],
      };
    });
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    const live = vi.fn();
    const deployer = new WorksDeployer({
      ...deps,
      store,
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
      await eventually(() => !!store.data?.current.main);
      expect(store.data?.inFlight).toBeUndefined();
      expect(store.data?.current.main?.nonce).not.toBe(staleNonce);
      expect(store.data?.current.main?.verified).toBe(true);
      expect(fake.deployments.filter(item => !item.deleted)).toHaveLength(1);
      await eventually(() => live.mock.calls.length > 0);
      expect(live).toHaveBeenCalledWith([]);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);

  it('无 id 的在飞部署唯一 nonce 匹配时认领原部署，完成线上核对而不重建', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const marker = 'recoverednonce';
    const built = await buildGallery({
      items: [],
      tombstones: [],
      nonce: marker,
      now: Date.now(),
      aliases: {},
      siteTitle: '作品集',
      siteIntro: '',
      readFile: async () => new Uint8Array(),
      readThumbnail: async () => new Uint8Array(),
    });
    const manifest: Record<string, string> = {};
    for (const [index, file] of built.files.entries()) {
      const key = (index + 1).toString(16).padStart(32, '0');
      manifest[file.path] = key;
      fake.assets.set(key, { bytes: file.bytes, contentType: file.contentType });
    }
    const deployed = fake.seedDeployment({ branch: 'main', manifest, headers: built.headers });
    const files = await hashFiles(built.files);
    files['/_headers'] = await sha256(new TextEncoder().encode(built.headers));
    await store.update(state => {
      state.inFlight = {
        kind: 'new',
        branch: 'main',
        nonce: marker,
        at: deployed.createdAt - 1000,
        files,
        works: [],
        changed: built.files.map(file => file.path),
      };
    });
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    const live = vi.fn();
    const deployer = new WorksDeployer({
      ...deps,
      store,
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
      await eventually(() => store.data?.current.main?.id === deployed.id);
      expect(store.data?.inFlight).toBeUndefined();
      expect(store.data?.known[deployed.id]).toBeDefined();
      expect(store.data?.current.main?.nonce).toBe(marker);
      expect(store.data?.current.main?.verified).toBe(true);
      expect(fake.deployments.filter(item => !item.deleted)).toHaveLength(1);
      expect(
        fake.requests.filter(request => request.method === 'GET' && request.path.startsWith(`/v/${marker}.txt?t=`))
          .length,
      ).toBeGreaterThan(0);
      await eventually(() => live.mock.calls.length > 0);
      expect(live).toHaveBeenCalledWith([]);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);

  it('发布提供者迟到时重试既有发布集合并建主站', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    let provider:
      | {
          listPublished: () => PublishedItem[];
          readFile: () => Promise<Uint8Array>;
          readThumbnail: () => Promise<Uint8Array>;
        }
      | undefined;
    const deployer = new WorksDeployer({
      ...deps,
      store,
      publish: () => provider,
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
      retryBaseMs: 20,
    });
    try {
      deployer.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(fake.deployments).toHaveLength(0);
      const item: PublishedItem = {
        id: 'abcdefghij',
        group: 'opaque',
        groupLabel: '朋友',
        surfaces: ['works'],
        kind: 'media',
        title: '画',
        summary: '',
        publishedAt: 1,
        files: [{ path: 'image.png', size: 1, contentType: 'image/png' }],
        hasThumbnail: false,
      };
      provider = {
        listPublished: () => [item],
        readFile: async () => new Uint8Array([1]),
        readThumbnail: async () => new Uint8Array(),
      };
      deployer.providerChanged();
      await eventually(() => !!store.data?.current.main);
      expect(store.data?.current.main?.works.map(work => work.id)).toEqual([item.id]);
      expect(fake.deployments.filter(item => !item.deleted).map(item => item.branch)).toEqual(['main']);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);

  it('停机不等待在飞网络；迟到的成功响应不能改账或发上线回报', async () => {
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const id = 'aaaaaaaa';
    await store.update(state => {
      state.inFlight = {
        kind: 'new',
        branch: 'main',
        nonce: 'pending',
        at: Date.now(),
        id,
        files: {},
        works: [],
        changed: [],
      };
      state.known[id] = { branch: 'main', at: Date.now() };
    });
    let resolveDeployment!: (value: PagesDeployment) => void;
    const pending = new Promise<PagesDeployment>(resolve => {
      resolveDeployment = resolve;
    });
    const waitForDeployment = vi.fn(() => pending);
    const client = { waitForDeployment } as unknown as PagesClient;
    const controller = new AbortController();
    const config: WorksSiteConfig = {
      targetId: 'works',
      basePath: '/',
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
    deployer.start();
    await eventually(() => waitForDeployment.mock.calls.length > 0);
    await deployer.stop();
    resolveDeployment({
      id,
      branch: 'main',
      environment: 'production',
      stage: { name: 'deploy', status: 'success' },
      aliases: [],
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(store.data?.inFlight?.id).toBe(id);
    expect(store.data?.current.main).toBeUndefined();
    expect(live).not.toHaveBeenCalled();
    controller.abort();
  });

  it('暂停上新时仍先撤主站，防抖中的新作不夹进撤下部署', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const old = fake.seedDeployment({ branch: 'main' });
    const media = (id: string): PublishedItem => ({
      id,
      group: 'opaque',
      groupLabel: '朋友',
      surfaces: ['works'],
      kind: 'media',
      title: '画',
      summary: '',
      publishedAt: 1,
      files: [{ path: 'image.png', size: 1, contentType: 'image/png' }],
      hasThumbnail: false,
    });
    const withdrawn = media('abcdefghij');
    const awaiting = media('bbcdefghij');
    await store.update(state => {
      state.current.main = {
        id: old.id,
        branch: 'main',
        nonce: 'old',
        at: 1,
        files: {},
        works: [withdrawn],
        verified: true,
      };
      state.known[old.id] = { branch: 'main', at: 1 };
      state.paused = { reason: '先前核对异常', at: Date.now() };
    });
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    const deployer = new WorksDeployer({
      ...deps,
      store,
      publish: () => ({
        listPublished: () => [awaiting],
        readFile: async () => new Uint8Array([1]),
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
      debounceMs: 1000,
      retryBaseMs: 20,
    });
    try {
      deployer.start();
      await eventually(() => store.data?.current.main?.id !== old.id);
      await eventually(() => old.deleted);
      expect(store.data?.current.main?.works).toEqual([]);
      expect(store.data?.tombstones).toContainEqual(
        expect.objectContaining({ branch: 'main', path: `/w/${withdrawn.id}/index.html` }),
      );
      expect(fake.deployments.filter(item => !item.deleted).map(item => item.branch)).toEqual(['main']);
      expect(store.data?.paused).toBeDefined();
      expect(store.data?.current.main?.works.some(item => item.id === awaiting.id)).toBe(false);
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);

  it('新分支核对失败且强删失败，停机重启后清除孤儿部署', async () => {
    const fake = await startFakePages();
    const files = new Map<string, string | Uint8Array>();
    const store = new WorksStore(memoryStorage(files));
    await store.load();
    const branch = 'p-12345678';
    const deployed = fake.seedDeployment({ branch });
    fake.aliasFor = () => 'http://untrusted.invalid';
    const html = new TextEncoder().encode('<!doctype html><p>work</p>');
    const item: PublishedItem = {
      id: 'abcdefghij',
      group: 'opaque',
      groupLabel: '朋友',
      surfaces: ['works'],
      kind: 'html',
      title: '网页',
      summary: '',
      publishedAt: 1,
      files: [{ path: 'index.html', size: html.length, contentType: 'text/html; charset=utf-8' }],
      hasThumbnail: false,
    };
    await store.update(state => {
      state.groups.opaque = { branch, createdAt: Date.now() };
      state.inFlight = {
        kind: 'new',
        branch,
        nonce: 'restartnonce',
        at: Date.now() - 1000,
        id: deployed.id,
        files: {},
        works: [item],
        changed: [],
      };
      state.known[deployed.id] = { branch, at: Date.now() - 1000 };
    });
    fake.intercept(
      'DELETE',
      new RegExp(`/deployments/${deployed.id}$`),
      {
        status: 503,
        body: { success: false, errors: [{ code: 500, message: 'temporary' }] },
      },
      3,
    );
    const firstSignal = new AbortController();
    const firstDeps = setup(fake, firstSignal.signal);
    const first = new WorksDeployer({
      ...firstDeps,
      store,
      publish: () => ({
        listPublished: () => [item],
        readFile: async () => html,
        readThumbnail: async () => new Uint8Array(),
      }),
      live: () => {},
      logger: { info: () => {}, warn: () => {} },
      signal: firstSignal.signal,
      retryBaseMs: 1000,
    });
    try {
      first.start();
      await eventually(() => !store.data?.inFlight && !!store.data?.known[deployed.id], 5000).catch(() => {
        throw new Error(JSON.stringify({ state: store.data, requests: fake.requestsTo('DELETE', /deployments/) }));
      });
      expect(deployed.deleted).toBe(false);
      await first.stop();
      firstSignal.abort();
      const restarted = new WorksStore(memoryStorage(files));
      await restarted.load();
      expect(restarted.data?.known[deployed.id]).toBeDefined();
      const secondSignal = new AbortController();
      const secondDeps = setup(fake, secondSignal.signal);
      const second = new WorksDeployer({
        ...secondDeps,
        store: restarted,
        publish: () => undefined,
        live: () => {},
        logger: { info: () => {}, warn: () => {} },
        signal: secondSignal.signal,
        retryBaseMs: 20,
      });
      try {
        second.start();
        await eventually(() => deployed.deleted && !restarted.data?.known[deployed.id]);
        expect(fake.requestsTo('DELETE', new RegExp(`/deployments/${deployed.id}$`)).length).toBeGreaterThan(3);
      } finally {
        secondSignal.abort();
        await second.stop();
      }
    } finally {
      firstSignal.abort();
      await first.stop();
      await fake.close();
    }
  }, 10000);

  it('没有新作品或新事件时，旧部署删除失败后自动重试并补发已核对主站上线回报', async () => {
    const fake = await startFakePages();
    const store = new WorksStore(memoryStorage(new Map()));
    await store.load();
    const old = fake.seedDeployment({ branch: 'main', createdAt: Date.now() - 1000 });
    const current = fake.seedDeployment({ branch: 'main' });
    const id = 'abcdefghij';
    await store.update(state => {
      state.current.main = {
        id: current.id,
        branch: 'main',
        nonce: 'verified',
        at: Date.now(),
        files: {},
        works: [
          {
            id,
            group: 'opaque',
            groupLabel: '朋友',
            surfaces: ['works'],
            kind: 'media',
            title: '画',
            summary: '',
            publishedAt: 1,
            files: [{ path: 'image.png', size: 1, contentType: 'image/png' }],
            hasThumbnail: false,
          },
        ],
        verified: true,
      };
      state.known[old.id] = { branch: 'main', at: Date.now() - 1000 };
      state.known[current.id] = { branch: 'main', at: Date.now() };
    });
    fake.intercept(
      'DELETE',
      new RegExp(`/deployments/${old.id}$`),
      {
        status: 503,
        body: { success: false, errors: [{ code: 500, message: 'temporary' }] },
      },
      3,
    );
    const controller = new AbortController();
    const deps = setup(fake, controller.signal);
    const live = vi.fn();
    const deployer = new WorksDeployer({
      ...deps,
      store,
      publish: () => undefined,
      live,
      logger: { info: () => {}, warn: () => {} },
      signal: controller.signal,
      retryBaseMs: 20,
    });
    try {
      deployer.start();
      await eventually(() => old.deleted && !store.data?.known[old.id]);
      expect(fake.requestsTo('DELETE', new RegExp(`/deployments/${old.id}$`)).length).toBeGreaterThan(3);
      expect(live).toHaveBeenCalledWith([id]);
      expect(store.data?.paused).toBeUndefined();
    } finally {
      controller.abort();
      await deployer.stop();
      await fake.close();
    }
  }, 10000);
});
