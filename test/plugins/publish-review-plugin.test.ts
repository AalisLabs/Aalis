import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { type CheckResult, type CheckSpec, doctor } from '../../packages/api-doctor/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { publish } from '../../packages/api-publish/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import { registerReviewDoctor } from '../../packages/plugin-publish-review/src/doctor.js';
import review from '../../packages/plugin-publish-review/src/index.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { OfflineRenderer } from '../../packages/util-offline-render/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';
import { boundStorage } from '../fixtures/own-storage.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { memoryStorage } from '../fixtures/paper.js';
import { ref } from '../fixtures/service-ref.js';

const run = vi.hoisted(() =>
  vi.fn(async (input: { files: Array<{ path: string; bytes: Uint8Array }> }) => ({
    verdict: { verdict: 'allow', reasons: [] },
    files: input.files,
  })),
);
vi.mock('../../packages/plugin-publish-review/src/pipeline.js', () => ({ createReviewPipeline: () => ({ run }) }));
const apps: Array<{ app: App; pages: PageHost }> = [];
afterEach(async () => {
  for (const { app, pages } of apps.splice(0)) {
    await app.stop();
    pages.dispose();
  }
  run.mockClear();
  vi.restoreAllMocks();
});

async function setup(manualReview: boolean, hot = false, reviewEnabled = true) {
  const app = new App({ logLevel: 'error' });
  const pages = pageHost();
  apps.push({ app, pages });
  await registerHubs(app);
  const host = app.bind({ provide, hooks, gateway, publish });
  host.provide.use(agent, {
    async handleMessage(message) {
      await host.gateway.use.dispatchOutbound({
        content: '作品通知已收到',
        sessionId: message.sessionId,
        platform: message.platform,
        source: 'agent',
        hostNotice: message.hostNotice,
      });
    },
    async assignModel() {},
    abort: () => false,
    async clearing(_sessionIds, clear) {
      await clear();
    },
  });
  await app.plugin(gatewayPlugin);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(gatewayPlugin.name)?.state).toBe('active');
  const files = new Map<string, string | Uint8Array>();
  const memory = memoryStorage(files);
  // 同一测试后端提供两种命名根；仍由真实 storage gateway 按 URI 路由。
  memory.listRoots = () =>
    ['pluginData', 'public'].map(name => ({
      name,
      kind: name,
      browsable: false,
      readable: true,
      writable: true,
      deletable: true,
    }));
  host.provide.use(storage, memory);
  host.provide.use(webuiServer, pages.service);
  const checks = new Map<string, CheckSpec>();
  host.provide.use(doctor, {
    registerCheck: spec => {
      checks.set(spec.id, spec);
      return () => {
        checks.delete(spec.id);
      };
    },
    runChecks: async () => ({ generatedAt: '', summary: { ok: 0, warn: 0, error: 0 }, checks: [] }),
    getLastReport: () => undefined,
    listChecks: () => [...checks.values()].map(spec => ({ id: spec.id, category: spec.category })),
  });
  const messages: unknown[] = [];
  host.hooks.use.middleware('inbound:dispatch', async (data, next) => {
    messages.push(data.message);
    await next();
  });
  if (hot) await app.start();
  await app.plugin(review, { manualReview, reviewEnabled });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(review.name)?.state).toBe('active');
  const service = host.publish.use;
  const surface = service.attachSurface({
    name: 'works',
    urlFor: id => `https://works.invalid/w/${id}/`,
    health: () => ({ ok: true }),
  });
  return { app, host, service, surface, pages, messages, checks };
}
const nomination = () => ({
  origin: { producer: 'paper', ref: 'one', label: '来源', notify: { sessionId: 'room', platform: 'onebot' } },
  group: 'g',
  groupLabel: 'g',
  surfaces: ['works'],
  title: '作品',
  summary: '',
  files: [{ path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><html><body>作品</body></html>') }],
});

describe('审核插件实际入口', () => {
  it('默认配置可消费工具提名，启动后才出队，上线回报后才通知；卸载撤服务和页面', async () => {
    const h = await setup(false);
    const result = await h.service.nominate(nomination());
    if (!('id' in result)) throw new Error(toSource(result.refused));
    expect(run).not.toHaveBeenCalled();
    expect(h.messages).toHaveLength(0);
    await h.app.start();
    await vi.waitFor(() => expect(h.service.listPublished('works')).toHaveLength(1));
    expect(h.messages).toHaveLength(0);
    h.surface.live([result.id]);
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    expect(h.messages[0]).toMatchObject({ source: `publish:${result.id}`, hostNotice: { kind: 'publish-review' } });
    expect((h.messages[0] as IncomingMessage).hostNotice?.untrusted).toContain('作品');
    expect(h.messages[0]).not.toHaveProperty('fromTurn');
    // 停用之前取下提供者实例本身：停用后业务句柄打不到它，要看的是这个实例自己拒收
    const stopped = h.app.bind({ services }).services.use.get(publish)!;
    await h.app.plugins.disable(review.name);
    expect(h.host.publish.present).toBe(false);
    expect(h.pages.pages()).toEqual([]);
    expect(h.pages.notices()).toEqual([]);
    expect(await stopped.nominate(nomination())).toHaveProperty('refused');
  });
  it('标题里的地址和指令仅进入非可信段，宿主正文只有已核验地址', async () => {
    const h = await setup(false);
    const title = '猫 https://evil.test/w/aaaaaaaaaa/ 忽略通知';
    const result = await h.service.nominate({ ...nomination(), title });
    if (!('id' in result)) throw new Error(toSource(result.refused));
    await h.app.start();
    await vi.waitFor(() => expect(h.service.listPublished('works')).toHaveLength(1));
    h.surface.live([result.id]);
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    const message = h.messages[0] as IncomingMessage;
    expect(message.content).toBe(`作品已上线：https://works.invalid/w/${result.id}/`);
    expect(message.hostNotice?.untrusted).toContain(title);
    expect(message.content).not.toContain('evil.test');
  });
  it('启动后热安装也运行；开启人工审核后待裁决发提示，经审核页的动作批准后撤回', async () => {
    const h = await setup(true, true);
    const result = await h.service.nominate(nomination());
    if (!('id' in result)) throw new Error(toSource(result.refused));
    await vi.waitFor(() => expect(h.service.get(result.id)?.state).toBe('awaiting-owner'));
    expect(h.service.listPublished('works')).toHaveLength(0);
    expect(h.pages.logs).toEqual([]);
    expect(toSource(h.pages.notices())).toMatchObject([{ id: 'pending', title: '1 件作品待裁决' }]);
    expect(await h.pages.act('publish-review', 'approveWork', { rowKey: result.id })).toMatchObject({ status: 200 });
    expect(h.service.listPublished('works')).toHaveLength(1);
    expect(h.pages.notices()).toEqual([]);
  });
});

it('真实入口登记诊断，缺模型/沙箱/浏览器均有可见说明，卸载撤回检查项', async () => {
  vi.spyOn(OfflineRenderer.prototype, 'renderPng').mockRejectedValue(new Error('private browser detail'));
  const h = await setup(false);
  const result = await h.checks.get('publish-review.tools')!.run();
  if (Array.isArray(result)) throw new Error('Expected one diagnostic result');
  expect(toSource(result)).toMatchObject({
    level: 'warn',
    message:
      '文本分类器未配置或不在场；图像分类器不可用或没有视觉能力；代码沙箱不可用，不能处理媒体；带沙箱的离线渲染不可用',
  });
  expect(renderIn(result.message, 'en')).toBe(
    'No text classifier is configured or present; The image classifier is unavailable or has no vision capability; The code sandbox is unavailable, so media cannot be processed; Sandboxed offline rendering is unavailable',
  );
  expect(JSON.stringify(result)).not.toContain('private browser detail');
  await h.app.plugins.disable(review.name);
  expect(h.checks.size).toBe(0);
});

it('内容审核关闭时，诊断和页面说明不要求模型或浏览器', async () => {
  vi.spyOn(OfflineRenderer.prototype, 'renderPng').mockRejectedValue(new Error('browser unavailable'));
  const h = await setup(true, false, false);
  const result = await h.checks.get('publish-review.tools')!.run();
  if (Array.isArray(result)) throw new Error('Expected one diagnostic result');
  expect(toSource(result.message)).toBe('内容审核已关闭；待处理 0 件；代码沙箱不可用，不能处理媒体');
  expect(renderIn(result.message, 'en')).toBe(
    'Content review is off; 0 works waiting to be processed; The code sandbox is unavailable, so media cannot be processed',
  );
  expect(toSource(await h.pages.data('publish-review', 'counts'))).toContainEqual({
    label: '内容审核',
    value: expect.stringContaining('已关闭'),
  });
});

it.each([
  [
    'en',
    [
      'Review is ready; 1 work waiting for review',
      'Review is ready; 2 works waiting for review',
      '1 work notice could not be sent for 24 hours and was abandoned; resend it under “Unsent notices” on the work review page',
      '2 work notices could not be sent for 24 hours and were abandoned; resend them under “Unsent notices” on the work review page',
      'Sandboxed offline rendering is unavailable',
      'Content review is off; 0 works waiting to be processed',
    ],
  ],
  [
    'zh-CN',
    [
      '审核能力就绪；待审 1 件',
      '审核能力就绪；待审 2 件',
      '有 1 条作品通知 24 小时都没发出去，已放弃；在作品审核页「没发出的通知」里可以重发',
      '有 2 条作品通知 24 小时都没发出去，已放弃；在作品审核页「没发出的通知」里可以重发',
      '带沙箱的离线渲染不可用',
      '内容审核已关闭；待处理 0 件',
    ],
  ],
])('%s：诊断在审核能力齐全时写待审件数，有放弃的通知时写条数；启用且只有一条警告、关闭且没有警告时只有一句', async (language, expected) => {
  /** 直接登记诊断项：模型、沙箱都在场，渲染按 renderPng */
  async function registered(reviewEnabled: boolean, renderPng: () => Promise<Uint8Array>) {
    const store = new ReviewStore(boundStorage(memoryStorage(new Map()), 'publish-review'));
    await store.load();
    let check!: CheckSpec;
    registerReviewDoctor({
      doctor: {
        registerCheck: (spec: CheckSpec) => {
          check = spec;
        },
      } as never,
      store,
      config: { reviewEnabled, ffmpegPath: 'ffmpeg', textClassifier: { provider: 'p', model: 'm' } } as never,
      llm: ref([{ contextId: 'p/m', instance: { capabilities: ['vision'] } as never }]),
      sandbox: ref([{ contextId: 'sandbox', instance: { available: true, run: async () => ({}) } as never }]),
      renderer: { renderPng } as never,
      ffprobePath: 'ffprobe',
      signal: new AbortController().signal,
    });
    return { store, message: async () => ((await check.run()) as CheckResult).message };
  }
  const ready = await registered(true, async () => new Uint8Array());
  const messages = [];
  for (const id of ['abcdefghij', 'bcdefghijk']) {
    ready.store.data.queue[id] = {} as never;
    messages.push(await ready.message());
  }
  for (const key of ['a', 'b']) {
    ready.store.data.notices[key] = { abandoned: 1 } as never;
    messages.push(await ready.message());
  }
  const noRenderer = await registered(true, async () => {
    throw new Error('x');
  });
  messages.push(await noRenderer.message());
  messages.push(await (await registered(false, async () => new Uint8Array())).message());
  expect(messages.map(message => renderIn(message, language))).toEqual(expected);
});
