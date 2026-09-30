import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { publish } from '../../packages/api-publish/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { events } from '../../packages/core/src/index.js';
import { artifactUri } from '../../packages/plugin-paper/src/artifacts.js';
import type { TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import review from '../../packages/plugin-publish-review/src/index.js';
import works from '../../packages/plugin-works-site/src/index.js';
import { type FakePages, startFakePages } from '../fixtures/fake-pages.js';
import {
  emptyLedger,
  human,
  LEDGER_URI,
  PAPER,
  type PaperHub,
  PILOT_CONFIG,
  REMOTE,
  ROOM,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';
import { ScriptedRemote } from '../fixtures/paper-remote.js';

const mock = vi.hoisted(() => ({
  debounceMs: undefined as number | undefined,
  realPipeline: false,
  pages: null as null | { apiBase: string; hostSuffix: string },
  pipeline: vi.fn(async (input: { files: readonly { path: string; bytes: Uint8Array }[] }) => ({
    verdict: { verdict: 'allow' as const, reasons: [] },
    files: input.files.map(file => ({ path: file.path, bytes: new Uint8Array(file.bytes) })),
    thumbnail: Uint8Array.of(1, 2, 3),
  })),
}));

vi.mock('../../packages/plugin-works-site/src/deploy.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/plugin-works-site/src/deploy.js')>();
  return {
    ...actual,
    WorksDeployer: class extends actual.WorksDeployer {
      constructor(input: ConstructorParameters<typeof actual.WorksDeployer>[0]) {
        super({ ...input, debounceMs: mock.debounceMs });
      }
    },
  };
});

vi.mock('../../packages/plugin-publish-review/src/pipeline.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/plugin-publish-review/src/pipeline.js')>();
  return {
    createReviewPipeline: (deps: Parameters<typeof actual.createReviewPipeline>[0]) =>
      mock.realPipeline ? actual.createReviewPipeline(deps) : { run: mock.pipeline },
  };
});
vi.mock('../../packages/plugin-works-site/src/cloudflare/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/plugin-works-site/src/cloudflare/client.js')>();
  return {
    ...actual,
    PagesClient: class extends actual.PagesClient {
      constructor(opts: ConstructorParameters<typeof actual.PagesClient>[0]) {
        if (!mock.pages) throw new Error('fake Pages 未安装');
        super({
          ...opts,
          apiBase: mock.pages.apiBase,
          hostSuffix: mock.pages.hostSuffix,
          protocol: 'http:',
          ratePerSecond: 1000,
          pollIntervalMs: 10,
          retryBaseMs: 10,
          deployTimeoutMs: 3000,
        });
      }
    },
  };
});

let fake: FakePages | undefined;
let restoreFetch: (() => void) | undefined;
afterEach(async () => {
  await stopPaperHubs();
  restoreFetch?.();
  restoreFetch = undefined;
  await fake?.close();
  fake = undefined;
  mock.pages = null;
  mock.debounceMs = undefined;
  mock.realPipeline = false;
  mock.pipeline.mockClear();
});

function routeSiteRequests(pages: FakePages): void {
  const native = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const main = url.origin === 'https://aalis.pages.dev';
    const local = url.hostname.endsWith('.aalis.localhost') || url.hostname === 'aalis.localhost';
    if (!main && !local) {
      if (url.hostname !== '127.0.0.1') throw new Error(`测试不允许外部请求：${url.hostname}`);
      return native(input, init);
    }
    const host = main ? `aalis.localhost:${pages.port}` : url.host;
    const headers = new Headers(init?.headers);
    headers.set('host', host);
    const result = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: pages.port,
          method: init?.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(headers),
          signal: init?.signal ?? undefined,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.from(chunk)));
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers as HeadersInit,
              }),
            ),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    if (init?.redirect !== 'manual' && [301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get('location');
      if (location) return globalThis.fetch(new URL(location, url), init);
    }
    return result;
  };
  restoreFetch = () => {
    globalThis.fetch = native;
  };
}

async function ready(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 20_000, interval: 25 });
}

function handlePublishedNotices(hub: PaperHub): void {
  const host = hub.app.bind({ gateway, events });
  const service = host.gateway.require();
  const originalDispatch = service.dispatchOutbound.bind(service);
  service.dispatchOutbound = async message => {
    await originalDispatch(message);
    await host.events.emit('outbound:message', message);
  };
  service.ingressMessage = async message => {
    hub.injected.push(message);
    await service.dispatchOutbound({
      content: `已转述：${message.content}`,
      sessionId: message.sessionId,
      platform: message.platform,
      source: 'agent',
      hostNotice: message.hostNotice && { kind: message.hostNotice.kind, id: message.hostNotice.id },
    });
  };
}

describe('用户从白纸提名到作品站上线与撤下', () => {
  it('省略 publish 的 paper_task 自动上线；显式 false 的成品保持私有', async () => {
    fake = await startFakePages();
    fake.tokens.set('test-token-sentinel', { kind: 'account' });
    fake.project.deployment_configs.production.fail_open = false;
    fake.project.deployment_configs.preview.fail_open = false;
    fake.queuedMs = 10;
    mock.pages = { apiBase: fake.apiBase, hostSuffix: fake.hostSuffix };
    mock.debounceMs = 10;
    mock.realPipeline = true;
    routeSiteRequests(fake);
    const remote = new ScriptedRemote();
    const hub = await startPaperHub({ remotes: { [REMOTE]: remote } });
    handlePublishedNotices(hub);
    const backend = hub.app.bind({ storage }).storage.require();
    const roots = backend.listRoots.bind(backend);
    backend.listRoots = () => [
      ...roots(),
      { name: 'public', kind: 'public', browsable: false, readable: true, writable: true, deletable: true },
    ];

    // 完成时发布插件尚未加载，也不会发送原始成品通知。
    const accepted = await hub.call('paper_task', { name: '自动猫站', text: '做一个猫站' });
    expect(accepted.ok).toBe(true);
    const taskId = String(accepted.taskId);
    expect(hub.ledger().tasks[taskId].publication).toMatchObject({ target: 'works', state: 'pending' });
    await ready(() => expect(hub.ledger().tasks[taskId].state).toBe('running'));
    remote.outputs.set(taskId, [
      { rel: 'index.html', data: new TextEncoder().encode('<!doctype html><html><body>自动猫站成品</body></html>') },
    ]);
    remote.finish(hub.ledger().tasks[taskId].runId!, 'finished', '不应提前转述的远端原文');
    await ready(() => expect(hub.ledger().tasks[taskId].state).toBe('done'));
    expect(hub.injected).toHaveLength(0);
    expect(await hub.call('paper_send', { artifact_id: hub.ledger().tasks[taskId].artifacts[0].id })).toMatchObject({
      ok: false,
    });
    expect(hub.outbound).toHaveLength(0);
    await hub.app.plugin(review, { reviewEnabled: false, manualReview: false });
    await hub.app.plugin(works, {
      accountId: fake.accountId,
      apiToken: 'test-token-sentinel',
      projectName: fake.projectName,
      siteOrigin: 'https://aalis.pages.dev',
      failOpen: false,
    });
    await hub.app.plugins.idle();
    await vi.waitFor(
      () =>
        expect(
          hub.injected,
          JSON.stringify({
            publication: hub.ledger().tasks[taskId].publication,
            logs: hub.logs,
          }),
        ).toHaveLength(1),
      { timeout: 40_000, interval: 25 },
    );
    const message = hub.injected[0];
    expect(message.source).toMatch(/^publish:/);
    expect(message.hostNotice).toMatchObject({ kind: 'publish-review' });
    expect(message.content).toContain('已上线');
    expect(message.content).not.toContain('不应提前转述');
    const workId = message.source!.slice('publish:'.length);
    const url = `https://aalis.pages.dev/w/${workId}/`;
    expect(message.content).toContain(url);
    expect(hub.outbound).toContainEqual(
      expect.objectContaining({
        source: 'agent',
        content: expect.stringContaining(url),
        hostNotice: { kind: 'publish-review', id: workId },
      }),
    );
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const wrapper = await response.text();
    expect(wrapper).toContain('自动猫站');
    const frame = /<iframe src="([^"]+)"/.exec(wrapper)?.[1];
    expect(frame).toBeDefined();
    expect(await (await fetch(frame!, { headers: { 'Sec-Fetch-Dest': 'iframe' } })).text()).toContain('自动猫站成品');
    expect(mock.pipeline).not.toHaveBeenCalled();
    expect(hub.app.bind({ publish }).publish.require().get(workId)?.live).toBe(true);
    await vi.waitFor(() => expect(hub.ledger().tasks[taskId].publication).toMatchObject({ state: 'live', workId }), {
      timeout: 40_000,
      interval: 25,
    });

    const deployments = fake.deployments.length;
    const privateTask = await hub.call('paper_task', { name: '私有猫站', text: '只做网页', publish: false });
    expect(privateTask.ok).toBe(true);
    const privateId = String(privateTask.taskId);
    expect(hub.ledger().tasks[privateId].publication).toBeUndefined();
    await ready(() => expect(hub.ledger().tasks[privateId].state).toBe('running'));
    remote.outputs.set(privateId, [
      { rel: 'index.html', data: new TextEncoder().encode('<!doctype html><html><body>私有成品</body></html>') },
    ]);
    remote.finish(hub.ledger().tasks[privateId].runId!, 'finished', '私有任务的远端说明');
    await ready(() => expect(hub.ledger().tasks[privateId].state).toBe('done'));
    await ready(() =>
      expect(hub.injected.some(message => message.source === `paper:n:${PAPER}:${privateId}`)).toBe(true),
    );
    expect(hub.ledger().tasks[privateId].publication).toBeUndefined();
    expect(hub.injected.filter(message => message.source?.startsWith('publish:'))).toHaveLength(1);
    expect(fake.deployments).toHaveLength(deployments);
  }, 90_000);

  it.each([
    '/',
    '/draw/',
  ])('发布目录 %s 走真实三个插件入口、假 Pages 核验与通知；撤下后旧链接返回墓碑', async basePath => {
    fake = await startFakePages();
    fake.tokens.set('test-token-sentinel', { kind: 'account' });
    fake.project.deployment_configs.production.fail_open = false;
    fake.project.deployment_configs.preview.fail_open = false;
    fake.queuedMs = 10;
    mock.pages = { apiBase: fake.apiBase, hostSuffix: fake.hostSuffix };
    routeSiteRequests(fake);

    const paperId = `n:${PAPER}`;
    const id = 't-00000001';
    const html = new TextEncoder().encode('<!doctype html><html><body>猫站内容</body></html>');
    const task: TaskRecord = {
      id,
      paperId,
      room: ROOM,
      platform: 'onebot',
      initiator: { platform: 'onebot', userId: '30001' },
      name: '猫站',
      text: '做网页',
      state: 'done',
      createdAt: Date.now() - 1000,
      artifacts: [{ id: 'a-00000001', rel: 'site/index.html', type: 'html', sizeBytes: html.length }],
      delivered: false,
    };
    const ledger = emptyLedger();
    ledger.papers[paperId] = { lastClearedAt: Date.now() };
    ledger.tasks[id] = task;
    const files = new Map<string, string | Uint8Array>([
      [LEDGER_URI, JSON.stringify(ledger)],
      [artifactUri(paperId, id, task.artifacts[0]), html],
    ]);
    const priorId = 'abcdefghij';
    const priorHtml = new TextEncoder().encode('<!doctype html><html><body>先前作品</body></html>');
    files.set(`public:/${priorId}/files/index.html`, priorHtml);
    files.set(
      'pluginData:/publish-review/state.json',
      JSON.stringify({
        version: 1,
        queue: {},
        ledger: {
          [priorId]: {
            id: priorId,
            state: 'published',
            origin: { producer: 'paper', ref: 'prior', label: '白纸' },
            group: paperId,
            groupLabel: '白纸',
            surfaces: ['works'],
            title: '先前作品',
            summary: '重启前已发布',
            credit: '旧版署名',
            kind: 'html',
            files: [
              {
                path: 'index.html',
                size: priorHtml.length,
                contentType: 'text/html; charset=utf-8',
                sha256: createHash('sha256').update(priorHtml).digest('hex'),
              },
            ],
            nominatedAt: Date.now() - 2000,
            publishedAt: Date.now() - 1000,
            hasThumbnail: false,
            notice: 'none',
          },
        },
        nominations: [],
        history: [],
        notices: {},
      }),
    );
    const hub = await startPaperHub({ files, config: PILOT_CONFIG });
    handlePublishedNotices(hub);
    // Review uses pluginData/public, Paper uses pluginData/paper; both share the in-memory storage provider.
    const backend = hub.app.bind({ storage }).storage.current!;
    const roots = backend.listRoots.bind(backend);
    backend.listRoots = () => [
      ...roots(),
      { name: 'public', kind: 'public', browsable: false, readable: true, writable: true, deletable: true },
    ];
    await hub.app.plugin(works, {
      accountId: fake.accountId,
      apiToken: 'test-token-sentinel',
      projectName: fake.projectName,
      siteOrigin: 'https://aalis.pages.dev',
      basePath,
      failOpen: false,
    });
    await hub.app.plugins.idle();
    expect(hub.app.bind({ publish }).publish.current).toBeUndefined();
    await hub.app.plugin(review, { manualReview: false });
    await hub.app.plugins.idle();
    expect(hub.app.plugins.getPlugin(review.name)?.state).toBe('active');
    expect(hub.app.plugins.getPlugin(works.name)?.state).toBe('active');
    await ready(() =>
      expect(JSON.parse(String(files.get('pluginData:/works-site/state.json'))).current.main).toBeDefined(),
    );
    // Review appears after Works starts; its loaded ledger emits no fresh onChange event.
    await ready(async () =>
      expect(await (await fetch(`https://aalis.pages.dev${basePath}w/${priorId}/`)).text()).toContain('先前作品'),
    );

    const nomination = await hub.call('works_nominate', {
      task_id: id,
      artifact_ids: ['a-00000001'],
      title: '猫站',
      summary: '群友作品',
    });
    expect(nomination).toMatchObject({ ok: true });
    const workId = String(nomination.workId);
    const service = hub.app.bind({ publish }).publish.require();
    await ready(() => expect(service.get(workId)?.state).toBe('published'));
    expect(hub.injected.filter(message => message.source === `publish:${workId}`)).toHaveLength(0);
    expect(await hub.action('worksRetry')).toMatchObject({ ok: true });
    await ready(() => expect(hub.injected.filter(message => message.source === `publish:${workId}`)).toHaveLength(1));
    expect(hub.outbound).toContainEqual(
      expect.objectContaining({
        source: 'agent',
        hostNotice: { kind: 'publish-review', id: workId },
        content: expect.stringContaining(`https://aalis.pages.dev${basePath}w/${workId}/`),
      }),
    );
    expect(await hub.action('worksItems')).toContainEqual(
      expect.objectContaining({ id: workId, url: `https://aalis.pages.dev${basePath}w/${workId}/` }),
    );
    const thumbnailRead = vi.spyOn(service, 'readThumbnail');
    expect(await hub.action('worksThumbnail', { id: workId })).toEqual({
      name: `${workId}.png`,
      mime: 'image/png',
      base64: 'AQID',
    });
    expect(thumbnailRead).toHaveBeenCalledWith(workId);
    expect([...files.keys()].some(path => path.startsWith(`pluginData:/publish-review/items/${workId}/`))).toBe(false);
    const publicUrl = `https://aalis.pages.dev${basePath}w/${workId}/`;
    const live = await fetch(publicUrl);
    expect(live.status).toBe(200);
    expect(await live.text()).toContain('猫站');

    expect(await hub.call('works_takedown', { work: publicUrl })).toMatchObject({ ok: true });
    await ready(() => expect(service.get(workId)?.state).toBe('withdrawn'));
    await ready(async () => expect(await (await fetch(publicUrl)).text()).toContain('该作品已下架'));
    await ready(async () =>
      expect(await hub.action('worksItems')).not.toContainEqual(expect.objectContaining({ id: workId })),
    );
    await hub.app.plugins.disable(review.name);
    expect(
      await hub.call('works_nominate', { task_id: id, artifact_ids: ['a-00000001'], title: '猫站' }),
    ).toMatchObject({ ok: false, error: '作品发布服务不可用' });
    const oldTakedown = hub.tools.get('works_takedown');
    await hub.app.plugins.disable('@aalis/plugin-paper');
    expect(hub.tools.has('works_takedown')).toBe(false);
    if (!oldTakedown) throw new Error('撤下工具未登记');
    const stale = await oldTakedown.handler({ work: workId }, human());
    expect(JSON.parse(typeof stale === 'string' ? stale : stale.content)).toMatchObject({ ok: false });
  });
});
