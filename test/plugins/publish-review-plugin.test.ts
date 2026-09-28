import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CheckSpec, doctor } from '../../packages/api-doctor/src/index.js';
import { publish } from '../../packages/api-publish/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import review from '../../packages/plugin-publish-review/src/index.js';
import { OfflineRenderer } from '../../packages/util-offline-render/src/index.js';
import { memoryStorage } from '../fixtures/paper.js';

const run = vi.hoisted(() =>
  vi.fn(async (input: { files: Array<{ path: string; bytes: Uint8Array }> }) => ({
    verdict: { verdict: 'allow', reasons: [] },
    files: input.files,
  })),
);
vi.mock('../../packages/plugin-publish-review/src/pipeline.js', () => ({ createReviewPipeline: () => ({ run }) }));
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  run.mockClear();
  vi.restoreAllMocks();
});

async function setup(manualReview: boolean, hot = false) {
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide, events, publish });
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
  host.provide(storage, memory);
  const actions = new Map<string, (args: Record<string, unknown>) => unknown>();
  const pages: unknown[] = [];
  host.provide(webuiServer, {
    getPort: () => 0,
    getHost: () => '127.0.0.1',
    getPages: () => [],
    registerPage: page => {
      pages.push(page);
      return () => void pages.splice(pages.indexOf(page), 1);
    },
    registerAction: (name, handler) => {
      actions.set(name, handler);
      return () => void actions.delete(name);
    },
  });
  const checks = new Map<string, CheckSpec>();
  host.provide(doctor, {
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
  host.events.on('inbound:message', message => {
    messages.push(message);
  });
  if (hot) await app.start();
  await app.plugin(review, { manualReview });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(review.name)?.state).toBe('active');
  const service = host.publish.require();
  const surface = service.attachSurface({
    name: 'works',
    urlFor: id => `https://works.invalid/w/${id}/`,
    health: () => ({ ok: true }),
  });
  return { app, host, service, surface, pages, actions, messages, checks };
}
const nomination = () => ({
  origin: { producer: 'paper', ref: 'one', label: '来源', notify: { sessionId: 'room', platform: 'onebot' } },
  group: 'g',
  groupLabel: 'g',
  surfaces: ['works'],
  title: '作品',
  summary: '',
  credit: '群友',
  files: [{ path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><html><body>作品</body></html>') }],
});

describe('审核插件实际入口', () => {
  it('默认配置可消费工具提名，启动后才出队，上线回报后才通知；卸载撤服务和页面', async () => {
    const h = await setup(false);
    const result = await h.service.nominate(nomination());
    if (!('id' in result)) throw new Error(result.refused);
    expect(run).not.toHaveBeenCalled();
    expect(h.messages).toHaveLength(0);
    await h.app.start();
    await vi.waitFor(() => expect(h.service.listPublished('works')).toHaveLength(1));
    expect(h.messages).toHaveLength(0);
    h.surface.live([result.id]);
    await vi.waitFor(() => expect(h.messages).toHaveLength(1));
    expect(h.messages[0]).toMatchObject({ source: `publish:${result.id}`, hostNotice: { kind: 'publish-review' } });
    expect(h.messages[0]).not.toHaveProperty('callerUserId');
    await h.app.plugins.disable(review.name);
    expect(h.host.publish.current).toBeUndefined();
    expect(h.pages).toHaveLength(0);
    expect(h.actions.size).toBe(0);
    expect(await h.service.nominate(nomination())).toHaveProperty('refused');
  });
  it('启动后热安装也运行；开启人工审核后通过实际WebUI动作批准', async () => {
    const h = await setup(true, true);
    const result = await h.service.nominate(nomination());
    if (!('id' in result)) throw new Error(result.refused);
    await vi.waitFor(() => expect(h.service.get(result.id)?.state).toBe('awaiting-owner'));
    expect(h.service.listPublished('works')).toHaveLength(0);
    expect(h.actions.has('reviewApprove')).toBe(true);
    expect(await h.actions.get('reviewApprove')?.({ id: result.id })).toMatchObject({ ok: true });
    expect(h.service.listPublished('works')).toHaveLength(1);
  });
});

it('真实入口登记诊断，缺模型/沙箱/浏览器均有可见说明，卸载撤回检查项', async () => {
  vi.spyOn(OfflineRenderer.prototype, 'renderPng').mockRejectedValue(new Error('private browser detail'));
  const h = await setup(false);
  const result = await h.checks.get('publish-review.tools')!.run();
  expect(result).toMatchObject({ level: 'warn', message: expect.stringContaining('文本分类器') });
  expect(result).toMatchObject({ message: expect.stringContaining('图像分类器') });
  expect(result).toMatchObject({ message: expect.stringContaining('代码沙箱') });
  expect(result).toMatchObject({ message: expect.stringContaining('离线渲染') });
  expect(JSON.stringify(result)).not.toContain('private browser detail');
  await h.app.plugins.disable(review.name);
  expect(h.checks.size).toBe(0);
});
