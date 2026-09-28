import { describe, expect, it, vi } from 'vitest';
import type { NominateInput } from '../../packages/api-publish/src/index.js';
import { configSchema } from '../../packages/plugin-publish-review/src/config.js';
import type { ReviewPipeline } from '../../packages/plugin-publish-review/src/pipeline.js';
import { PublishReviewService } from '../../packages/plugin-publish-review/src/service.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { memoryStorage } from '../fixtures/paper.js';

const data = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 72, 68, 82]);
const nomination = (): NominateInput => ({
  origin: { producer: 'paper', ref: 'task-1', label: '测试房间', notify: { sessionId: 'room-1', platform: 'onebot' } },
  group: 'private-group',
  groupLabel: '测试',
  surfaces: ['works'],
  title: '测试作品',
  summary: '',
  credit: '来自群友的点子',
  files: [{ path: 'work.png', bytes: data }],
});

async function open(
  files: Map<string, string | Uint8Array>,
  manualReview: boolean,
  verdict: 'allow' | 'reject' | 'unsure',
  clock: { now: number },
  run = vi.fn(),
) {
  const storage = memoryStorage(files);
  const store = new ReviewStore(storage);
  await store.load();
  const pipeline: ReviewPipeline = {
    run: async () => {
      run();
      return { verdict: { verdict, reasons: verdict === 'allow' ? [] : ['需人工判断'] }, files: nomination().files };
    },
  };
  const service = new PublishReviewService({
    storage,
    store,
    config: parseConfig(configSchema, { manualReview, ownerTimeoutHours: 1 }),
    pipeline,
    now: () => clock.now,
    notice: async () => {},
  });
  service.attachSurface({
    name: 'works',
    urlFor: id => `https://works.invalid/w/${id}/`,
    health: () => ({ ok: true }),
  });
  return { store, service, run };
}

describe('默认人工回退的时间与配置交接', () => {
  it('全人工关闭后，旧 required 待审项在重跑前不能直接批准', async () => {
    const files = new Map<string, string | Uint8Array>();
    const clock = { now: 1000 };
    const first = await open(files, true, 'allow', clock);
    const proposed = await first.service.nominate(nomination());
    if (!('id' in proposed)) throw new Error(proposed.refused);
    await first.service.processNext();
    expect(first.store.data.queue[proposed.id]?.awaitingReason).toBe('required');
    await first.service.close();
    const restarted = await open(files, false, 'allow', clock);
    expect(await restarted.service.approve(proposed.id)).toBe(false);
    expect(restarted.store.data.ledger[proposed.id]).toBeUndefined();
  });

  it('fallback 等待已过绝对截止时，定时对账尚未运行也不能批准', async () => {
    const files = new Map<string, string | Uint8Array>();
    const clock = { now: 1000 };
    const h = await open(files, false, 'reject', clock);
    const proposed = await h.service.nominate(nomination());
    if (!('id' in proposed)) throw new Error(proposed.refused);
    await h.service.processNext();
    expect(h.store.data.queue[proposed.id]?.awaitingReason).toBe('fallback');
    clock.now += 3_600_001;
    expect(await h.service.approve(proposed.id)).toBe(false);
    expect(h.store.data.ledger[proposed.id]).toBeUndefined();
  });

  it('批准排在独占锁后等待时跨过截止，也不能发布', async () => {
    const files = new Map<string, string | Uint8Array>();
    const clock = { now: 1000 };
    const h = await open(files, false, 'unsure', clock);
    const proposed = await h.service.nominate(nomination());
    if (!('id' in proposed)) throw new Error(proposed.refused);
    await h.service.processNext();
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = h.store.exclusive(async () => {
      entered();
      await gate;
    });
    await enteredLock;
    const approving = h.service.approve(proposed.id);
    clock.now += 3_600_001;
    release();
    await holding;
    expect(await approving).toBe(false);
    expect(h.store.data.ledger[proposed.id]).toBeUndefined();
  });

  it('批准排队期间待审状态变回 queued，不能借旧请求发布', async () => {
    const files = new Map<string, string | Uint8Array>();
    const clock = { now: 1000 };
    const h = await open(files, false, 'reject', clock);
    const proposed = await h.service.nominate(nomination());
    if (!('id' in proposed)) throw new Error(proposed.refused);
    await h.service.processNext();
    let release!: () => void;
    let entered!: () => void;
    const enteredLock = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = h.store.exclusive(async () => {
      entered();
      await gate;
      const next = h.store.copy();
      next.queue[proposed.id].state = 'queued';
      delete next.queue[proposed.id].outHashes;
      await h.store.save(next);
    });
    await enteredLock;
    const approving = h.service.approve(proposed.id);
    release();
    await holding;
    expect(await approving).toBe(false);
    expect(h.store.data.queue[proposed.id]?.state).toBe('queued');
    expect(h.store.data.ledger[proposed.id]).toBeUndefined();
  });
});
