import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../../packages/plugin-publish-review/src/config.js';
import { PublishReviewService } from '../../packages/plugin-publish-review/src/service.js';
import { ReviewStore } from '../../packages/plugin-publish-review/src/state.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';
import { memoryStorage } from '../fixtures/paper.js';

const input = () => ({
  origin: { producer: 'paper', ref: 'one', label: 'room', notify: { sessionId: 'room', platform: 'onebot' } },
  group: 'room',
  groupLabel: 'room',
  surfaces: ['works'],
  title: 'work',
  summary: '',
  credit: 'writer',
  files: [{ path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><p>hi</p>') }],
});

async function setup(manualReview = false, now: () => number = Date.now) {
  const files = new Map<string, string | Uint8Array>();
  const storage = memoryStorage(files);
  const store = new ReviewStore(storage);
  await store.load();
  const abort = new AbortController();
  const notice = vi.fn();
  const pipelineRun = vi.fn(async (item: { files: readonly { path: string; bytes: Uint8Array }[] }) => ({
    verdict: { verdict: 'allow' as const, reasons: [] },
    files: [...item.files],
  }));
  const service = new PublishReviewService({
    storage,
    store,
    config: parseConfig(configSchema, { manualReview, ownerTimeoutHours: 1 }),
    now,
    signal: abort.signal,
    pipeline: { run: pipelineRun },
    notice,
  });
  const binding = service.attachSurface({
    name: 'works',
    urlFor: id => `https://works.invalid/w/${id}/`,
    health: () => ({ ok: true }),
  });
  const proposed = await service.nominate(input());
  if (!('id' in proposed)) throw new Error(proposed.refused);
  return { files, storage, store, abort, notice, pipelineRun, service, binding, id: proposed.id };
}

describe('作品审核停机交错', () => {
  it('已排队的上线回执遇到停机不耗尽 pending 通知，也不发停机后消息', async () => {
    const h = await setup();
    await h.service.processNext();
    expect(h.store.data.ledger[h.id]?.notice).toBe('pending');
    h.binding.live([h.id]);
    h.abort.abort();
    await h.service.close();
    expect(h.store.data.ledger[h.id]?.notice).toBe('pending');
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('输出写入与停机相遇时保留 checking 原件供重启，不结案也不通知', async () => {
    const h = await setup();
    const original = h.storage.writeFile.bind(h.storage);
    h.storage.writeFile = async (uri, data) => {
      if (uri.includes('/out/')) {
        h.abort.abort();
        throw new Error('stopped during output write');
      }
      return original(uri, data);
    };
    await h.service.processNext();
    await h.service.close();
    expect(h.store.data.queue[h.id]?.state).toBe('checking');
    expect(h.store.data.ledger[h.id]).toBeUndefined();
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('出队等待独占锁时停机，不把 queued 改成 checking 或启动流水', async () => {
    const h = await setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = h.store.exclusive(() => gate);
    const processing = h.service.processNext();
    h.abort.abort();
    release();
    await Promise.all([holding, processing]);
    expect(h.store.data.queue[h.id]?.state).toBe('queued');
    expect(h.pipelineRun).not.toHaveBeenCalled();
  });

  it('超时对账等待独占锁时停机，不结案成 expired 且漏掉超时通知', async () => {
    let now = 1_000;
    const h = await setup(true, () => now);
    await h.service.processNext();
    expect(h.store.data.queue[h.id]?.state).toBe('awaiting-owner');
    h.notice.mockClear();
    now += 3_600_001;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = h.store.exclusive(() => gate);
    const reconciling = h.service.reconcile();
    h.abort.abort();
    release();
    await Promise.all([holding, reconciling]);
    expect(h.store.data.queue[h.id]?.state).toBe('awaiting-owner');
    expect(h.store.data.history.at(-1)?.event).not.toBe('expired');
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('人工拒绝等待独占锁时停机，不结案成 rejected 且漏掉拒绝通知', async () => {
    const h = await setup(true);
    await h.service.processNext();
    expect(h.store.data.queue[h.id]?.state).toBe('awaiting-owner');
    h.notice.mockClear();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const holding = h.store.exclusive(() => gate);
    const rejecting = h.service.reject(h.id);
    h.abort.abort();
    release();
    await Promise.all([holding, rejecting]);
    expect(h.store.data.queue[h.id]?.state).toBe('awaiting-owner');
    expect(h.store.data.history.at(-1)?.event).not.toBe('rejected');
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('停机时首条通知在飞，第二条留在持久化 outbox 并于重启后补发', async () => {
    const h = await setup();
    await h.service.processNext();
    const second = await h.service.nominate(input());
    if (!('id' in second)) throw new Error(second.refused);
    await h.service.processNext();
    let entered!: () => void;
    let release!: () => void;
    const began = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    h.notice.mockImplementationOnce(async () => {
      entered();
      await gate;
    });
    h.binding.live([h.id, second.id]);
    await began;
    // Both live receipts have been persisted before close; only the first emit may complete now.
    await h.store.exclusive(async () => {});
    expect(h.store.data.notices[`${second.id}:live`]).toBeDefined();
    const closing = h.service.close();
    release();
    await closing;
    expect(h.store.data.notices[`${second.id}:live`]).toBeDefined();
    const restarted = new ReviewStore(memoryStorage(h.files));
    await restarted.load();
    const replayed = vi.fn();
    const resumed = new PublishReviewService({
      storage: restarted.storage,
      store: restarted,
      config: parseConfig(configSchema, {}),
      pipeline: { run: h.pipelineRun },
      notice: replayed,
    });
    await resumed.flushNotices();
    expect(replayed).toHaveBeenCalledWith(expect.any(Object), expect.stringContaining('已通过审核并上线'), second.id);
    expect(restarted.data.notices).toEqual({});
    expect(restarted.data.ledger[second.id]?.notice).toBe('sent');
  });

  it('通知 emit 失败保留 outbox，重启后重试才把 ledger 记为 sent', async () => {
    const h = await setup();
    await h.service.processNext();
    h.notice.mockRejectedValueOnce(new Error('transient event failure'));
    h.binding.live([h.id]);
    await h.store.exclusive(async () => {});
    await h.service.flushNotices();
    expect(h.store.data.notices[`${h.id}:live`]).toBeDefined();
    expect(h.store.data.ledger[h.id]?.notice).toBe('pending');
    await h.service.close();
    const restarted = new ReviewStore(memoryStorage(h.files));
    await restarted.load();
    const replayed = vi.fn();
    const resumed = new PublishReviewService({
      storage: restarted.storage,
      store: restarted,
      config: parseConfig(configSchema, {}),
      pipeline: { run: h.pipelineRun },
      notice: replayed,
    });
    await resumed.flushNotices();
    expect(restarted.data.notices[`${h.id}:live`]).toBeUndefined();
    expect(restarted.data.ledger[h.id]?.notice).toBe('sent');
    expect(h.notice).toHaveBeenCalledTimes(1);
    expect(replayed).toHaveBeenCalledTimes(1);
  });

  it('通知回调同步撤下作品时不持独占锁等待自身，过时上线消息不被确认', async () => {
    const h = await setup();
    await h.service.processNext();
    h.notice.mockImplementation(async () => {
      await h.service.withdraw(h.id, { kind: 'origin' }, '来源撤下');
    });
    h.binding.live([h.id]);
    await h.store.exclusive(async () => {});
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        h.service.flushNotices(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('通知回调死锁')), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    expect(h.store.data.ledger[h.id]?.state).toBe('withdrawn');
    expect(h.store.data.notices[`${h.id}:live`]).toBeUndefined();
  });
});
