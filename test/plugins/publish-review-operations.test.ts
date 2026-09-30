import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../../packages/plugin-publish-review/src/config.js';
import { PublishReviewService } from '../../packages/plugin-publish-review/src/service.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { memoryStorage } from '../fixtures/paper.js';

const html = new TextEncoder().encode('<!doctype html><html><body>作品</body></html>');
const item = () => ({
  origin: { producer: 'paper', ref: 'one', label: '来源', notify: { sessionId: 'room', platform: 'onebot' } },
  group: 'group',
  groupLabel: '组',
  surfaces: ['works'],
  title: '作品',
  summary: '',
  files: [{ path: 'index.html', bytes: html }],
});
async function world() {
  const files = new Map<string, string | Uint8Array>();
  const storage = memoryStorage(files);
  const store = new ReviewStore(storage);
  await store.load();
  const notice = vi.fn();
  const abort = new AbortController();
  const service = new PublishReviewService({
    storage,
    store,
    config: parseConfig(configSchema, { manualReview: true }),
    signal: abort.signal,
    notice,
    pipeline: {
      run: async input => ({
        verdict: { verdict: 'allow', reasons: [] },
        files: [...input.files],
        evidence: {
          flags: ['活动内容'],
          reasons: ['需人工确认'],
          images: [{ name: 'image-1.png', bytes: new Uint8Array([1, 2]) }],
          render: new Uint8Array([3, 4]),
          classification: 'allow',
        },
      }),
    },
  });
  service.attachSurface({
    name: 'works',
    urlFor: id => `https://works.invalid/w/${id}/`,
    health: () => ({ ok: true }),
  });
  return { files, store, service, notice, abort };
}

describe('审核入口使用的管理操作', () => {
  it('队列变化可观察，待裁决详情与图像可读，拒绝后通知且留下历史', async () => {
    const h = await world();
    const changed = vi.fn();
    h.service.onQueueChange(changed);
    const nomination = await h.service.nominate(item());
    if (!('id' in nomination)) throw new Error(nomination.refused);
    const { id } = nomination;
    expect(changed).toHaveBeenCalled();
    await h.service.processNext();
    expect(h.store.data.queue[id].review).toEqual({
      flags: ['活动内容'],
      reasons: ['需人工确认'],
      images: ['image-1.png'],
      hasRender: true,
      classification: 'allow',
    });
    expect(h.files.get(`pluginData:/publish-review/items/${id}/review/image-1.png`)).toEqual(new Uint8Array([1, 2]));
    expect(await h.service.reject(id)).toBe(true);
    expect(h.store.data.queue[id]).toBeUndefined();
    await vi.waitFor(() => expect(h.notice.mock.calls.at(-1)?.[1]).toContain('未获批准'));
    expect(h.store.data.history.at(-1)).toMatchObject({ id, event: 'rejected' });
    expect(await h.service.reject(id)).toBe(false);
  });
  it('关闭人工审核后重新执行自动审核，不把旧待裁决条目悬空或直接放行', async () => {
    const h = await world();
    const nomination = await h.service.nominate(item());
    if (!('id' in nomination)) throw new Error(nomination.refused);
    await h.service.processNext();
    const run = vi.fn(async (input: { files: readonly { path: string; bytes: Uint8Array }[] }) => ({
      verdict: { verdict: 'unsure' as const, reasons: ['拿不准'] },
      files: [...input.files],
    }));
    const service = new PublishReviewService({
      storage: h.store.storage,
      store: h.store,
      config: parseConfig(configSchema, { manualReview: false }),
      pipeline: { run },
    });
    await service.reconcile();
    expect(h.store.data.queue[nomination.id].state).toBe('queued');
    expect(h.store.data.queue[nomination.id].outHashes).toBeUndefined();
    await service.processNext();
    expect(run).toHaveBeenCalledOnce();
    expect(h.store.data.queue[nomination.id]).toMatchObject({ state: 'awaiting-owner', awaitingReason: 'fallback' });
    await service.reconcile();
    await service.processNext();
    expect(run).toHaveBeenCalledOnce();
    expect(service.listPublished('works')).toHaveLength(0);
    expect(await service.approve(nomination.id)).toBe(true);
    expect(service.listPublished('works')).toHaveLength(1);
  });

  it('已停止的实例拒收且不启动流水', async () => {
    const h = await world();
    h.abort.abort();
    expect(await h.service.nominate(item())).toHaveProperty('refused');
    expect(h.store.data.queue).toEqual({});
  });
});

it('重启对账会清理不再属于待审队列的私有快照，保留仍待裁决的文件', async () => {
  const h = await world();
  const nomination = await h.service.nominate(item());
  if (!('id' in nomination)) throw new Error(nomination.refused);
  h.files.set('pluginData:/publish-review/items/abcdefghij/out/index.html', new TextEncoder().encode('orphan'));
  await h.service.reconcile();
  expect(h.files.has('pluginData:/publish-review/items/abcdefghij/out/index.html')).toBe(false);
  expect(h.files.has(`pluginData:/publish-review/items/${nomination.id}/src/index.html`)).toBe(true);
});
