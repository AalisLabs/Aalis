import { describe, expect, it, vi } from 'vitest';
import type { NominateInput, NominateResult, PublishService } from '../../packages/api-publish/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger, ServiceSelection } from '../../packages/core/src/index.js';
import { artifactUri } from '../../packages/plugin-paper/src/artifacts.js';
import type { PaperConfig } from '../../packages/plugin-paper/src/config.js';
import { rawDeliveryAllowed } from '../../packages/plugin-paper/src/deliver.js';
import type { LedgerStore, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import { PaperPublication } from '../../packages/plugin-paper/src/publication.js';

const artifact = (id: string, rel: string, type: TaskRecord['artifacts'][number]['type']) => ({
  id,
  rel,
  type,
  sizeBytes: 3,
});
const task = (artifacts: TaskRecord['artifacts'], target = 'works'): TaskRecord => ({
  id: 't-00000001',
  paperId: 'n:demo',
  room: 'room-1',
  platform: 'onebot',
  initiator: { platform: 'onebot', userId: 'user-1' },
  name: '作品',
  text: '制作作品',
  state: 'done',
  createdAt: Date.now(),
  artifacts,
  delivered: false,
  publication: { target, title: '作品', summary: '', state: 'pending' },
});

function setup(
  t: TaskRecord,
  options: { surface?: boolean; target?: boolean; failReceipt?: boolean; now?: () => number } = {},
) {
  const files = new Map(t.artifacts.map(a => [artifactUri(t.paperId, t.id, a), new Uint8Array([1, 2, 3])]));
  const storage = {
    readFile: vi.fn(async (uri: string) => {
      const bytes = files.get(uri);
      if (!bytes) throw new Error('missing');
      return bytes;
    }),
  } as unknown as StorageService;
  let failReceipt = options.failReceipt ?? false;
  const ledger = {
    data: { tasks: { [t.id]: t } },
    failure: undefined,
    exclusive: async <T>(fn: () => Promise<T>) => fn(),
    save: vi.fn(async () => {
      if (failReceipt && t.publication?.state === 'submitted') {
        failReceipt = false;
        throw new Error('disk unavailable');
      }
    }),
  } as unknown as LedgerStore;
  const cfg = {
    defaults: { publishTargets: options.target === false ? [] : ['works'] },
    papers: new Map([['demo', { publishTargets: options.target === false ? [] : ['works'] }]]),
  } as unknown as PaperConfig;
  const subscribers = new Set<() => void>();
  const nominate = vi.fn(async (_input: NominateInput): Promise<NominateResult> => ({ id: 'abcdefghij' }));
  let itemState: 'queued' | 'published' | 'rejected' = 'queued';
  let live = false;
  const service = {
    listSurfaces: vi.fn(() => (options.surface === false ? [] : [{ name: 'works', available: true }])),
    nominate,
    get: vi.fn(() => ({
      state: itemState,
      live,
      origin: { producer: 'paper-instance', ref: `${t.paperId}/${t.id}` },
      title: '作品',
    })),
    onChange: (fn: () => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  } as unknown as PublishService;
  let current: PublishService | undefined;
  let attach: ((service: PublishService) => void) | undefined;
  let cleanup: (() => unknown) | undefined;
  const ref = {
    list: () => (current ? [{ id: 'publish', priority: 0, selected: true, use: current }] : []),
    get present() {
      return current !== undefined;
    },
    get use() {
      return current;
    },
    follow: (fn: (service: PublishService) => undefined | (() => unknown)) => {
      attach = next => {
        cleanup?.();
        cleanup = fn(next) as (() => unknown) | undefined;
      };
      if (current) attach(current);
      return () => {
        cleanup?.();
        attach = undefined;
      };
    },
  } as unknown as ServiceSelection<PublishService>;
  const controller = new AbortController();
  const logger = { warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  const changed = vi.fn();
  const coordinator = new PaperPublication({
    ledger,
    cfg,
    storage,
    publish: ref,
    producer: 'paper-instance',
    signal: controller.signal,
    logger,
    onChange: changed,
    ...(options.now ? { now: options.now } : {}),
  });
  const connect = () => {
    current = service;
    attach?.(service);
  };
  const notify = () => {
    for (const fn of subscribers) fn();
  };
  return {
    coordinator,
    ledger,
    storage,
    cfg,
    nominate,
    service,
    connect,
    notify,
    controller,
    changed,
    setState: (state: typeof itemState, isLive = false) => {
      itemState = state;
      live = isLive;
      notify();
    },
  };
}

const settled = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('PaperPublication', () => {
  it('waits for a late service, submits a single HTML as index.html, and marks live only after confirmation', async () => {
    const t = task([artifact('a-00000001', 'draft/page.html', 'html')]);
    const h = setup(t);
    h.coordinator.open();
    await settled();
    expect(h.nominate).not.toHaveBeenCalled();
    h.connect();
    await vi.waitFor(() => expect(t.publication?.state).toBe('submitted'));
    expect(h.nominate).toHaveBeenCalledTimes(1);
    expect(h.nominate.mock.calls[0][0]).toMatchObject({
      submissionKey: 'paper:t-00000001',
      origin: { producer: 'paper-instance', ref: 'n:demo/t-00000001', actorKey: 'onebot:user-1' },
      files: [{ path: 'index.html' }],
    });
    h.setState('published', true);
    await vi.waitFor(() => expect(t.publication?.state).toBe('live'));
    await h.coordinator.close();
  });

  it('gives up a pending submission 24 hours after the task ended when the target never comes back', async () => {
    const t = { ...task([artifact('a-00000001', 'page.html', 'html')]), endedAt: 0 };
    let now = 24 * 3_600_000 - 1;
    const h = setup(t, { surface: false, now: () => now });
    h.connect();
    h.coordinator.open();
    await settled();
    expect(t.publication?.state).toBe('pending');
    now = 24 * 3_600_000;
    h.notify();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toContain('24 小时');
    expect(t.publication?.directSend).toBe(true);
    expect(h.nominate).not.toHaveBeenCalled();
    await h.coordinator.close();
  });

  it('a manual re-nomination counts its 24 hours from the re-nomination, not from the task end', async () => {
    const t = { ...task([artifact('a-00000001', 'page.html', 'html')]), endedAt: 0 };
    t.publication = { ...t.publication!, pendingSince: 24 * 3_600_000 };
    let now = 24 * 3_600_000;
    const h = setup(t, { surface: false, now: () => now });
    h.connect();
    h.coordinator.open();
    await settled();
    expect(t.publication?.state).toBe('pending');
    now = 48 * 3_600_000;
    h.notify();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toContain('24 小时');
    await h.coordinator.close();
  });

  it('a re-nominated task refused by review earlier stays undeliverable when the retry later fails for an outage', async () => {
    const t = { ...task([artifact('a-00000001', 'page.html', 'html')]), endedAt: 0 };
    t.publication = { ...t.publication!, reviewRefused: true };
    const h = setup(t, { surface: false, now: () => 24 * 3_600_000 });
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toContain('24 小时');
    expect(rawDeliveryAllowed(t), '审核结论不因之后的期限失败被洗成可直接发').toBe(false);
    await h.coordinator.close();
  });

  it('a permanent check refusal fails without direct delivery: that is a verdict, not an outage', async () => {
    const t = task([artifact('a-00000001', 'page.html', 'html')]);
    const h = setup(t);
    h.nominate.mockImplementationOnce(async () => ({ refused: '路径不符合要求' }));
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toBe('作品未通过发布检查');
    expect(t.publication?.directSend).toBeUndefined();
    await h.coordinator.close();
  });

  it('does not choose a guessed work from ambiguous artifacts', async () => {
    const t = task([artifact('a-00000001', 'cat.png', 'png'), artifact('a-00000002', 'dog.png', 'png')]);
    const h = setup(t);
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toMatch(/手动选择/);
    expect(h.nominate).not.toHaveBeenCalled();
    expect(t.publication?.directSend, '挑不出成品属于发布环节的问题：通知前先直接发').toBe(true);
    await h.coordinator.close();
  });

  it('publishes a single rooted site with relative assets and rejects an unrelated file', async () => {
    const rooted = task([
      artifact('a-00000001', 'site/index.html', 'html'),
      artifact('a-00000002', 'site/assets/cat.png', 'png'),
      artifact('a-00000003', 'site/main.js', 'other'),
    ]);
    const first = setup(rooted);
    first.connect();
    first.coordinator.open();
    await vi.waitFor(() => expect(rooted.publication?.state).toBe('submitted'));
    expect(first.nominate.mock.calls[0][0].files.map(f => f.path)).toEqual(['index.html', 'assets/cat.png', 'main.js']);
    await first.coordinator.close();

    const mixed = task([
      artifact('a-00000001', 'site/index.html', 'html'),
      artifact('a-00000002', 'source/workspace.tar.gz', 'other'),
    ]);
    const second = setup(mixed);
    second.connect();
    second.coordinator.open();
    await vi.waitFor(() => expect(mixed.publication?.state).toBe('failed'));
    expect(second.nominate).not.toHaveBeenCalled();
    await second.coordinator.close();
  });

  it('checks public paths before submitting: an automatic pick with an unlisted extension, and stored manual paths', async () => {
    const rooted = task([
      artifact('a-00000001', 'site/index.html', 'html'),
      artifact('a-00000002', 'site/workspace.tar.gz', 'other'),
    ]);
    const automatic = setup(rooted);
    automatic.connect();
    automatic.coordinator.open();
    await vi.waitFor(() => expect(rooted.publication?.state).toBe('failed'));
    expect(rooted.publication?.reason).toBe('作品路径不符合发布要求，请手动选择成品');
    expect(automatic.nominate).not.toHaveBeenCalled();
    await automatic.coordinator.close();

    // 账本里存着的手选路径只差大小写（公开根可能不分大小写）
    const manual = task([artifact('a-00000001', 'cat.png', 'png'), artifact('a-00000002', 'cat-2.png', 'png')]);
    manual.publication = {
      ...manual.publication!,
      artifactIds: ['a-00000001', 'a-00000002'],
      paths: ['Cat.png', 'cat.png'],
    };
    const stored = setup(manual);
    stored.connect();
    stored.coordinator.open();
    await vi.waitFor(() => expect(manual.publication?.state).toBe('failed'));
    expect(manual.publication?.reason).toBe('已选作品路径不符合发布要求');
    expect(stored.nominate).not.toHaveBeenCalled();
    await stored.coordinator.close();
  });

  it('enforces the paper target allowlist before reading files or submitting', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const h = setup(t, { target: false });
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(h.storage.readFile).not.toHaveBeenCalled();
    expect(h.nominate).not.toHaveBeenCalled();
    await h.coordinator.close();
  });

  it('retries a lost receipt with the same key and bytes, and serializes repeated kicks', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const h = setup(t, { failReceipt: true });
    h.nominate.mockImplementationOnce(async () => {
      return { id: 'abcdefghij' };
    });
    h.connect();
    h.coordinator.open();
    h.coordinator.kick();
    h.coordinator.kick();
    h.coordinator.kick();
    await vi.waitFor(() => expect(t.publication?.state).toBe('submitted'));
    expect(h.nominate).toHaveBeenCalledTimes(2);
    expect(h.nominate.mock.calls[0][0]).toEqual(h.nominate.mock.calls[1][0]);
    await h.coordinator.close();
  });

  it('waits for a temporary quota refusal and submits once the slot becomes free', async () => {
    vi.useFakeTimers();
    try {
      const t = task([artifact('a-00000001', 'index.html', 'html')]);
      const h = setup(t);
      h.nominate.mockImplementationOnce(async () => ({ refused: '待审额度已满', retryAfterMs: 80 }));
      h.connect();
      h.coordinator.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.publication?.nextAttemptAt).toBe(Date.now() + 80);
      expect(t.publication?.state).toBe('pending');
      expect(h.nominate).toHaveBeenCalledTimes(1);
      h.coordinator.kick();
      await vi.advanceTimersByTimeAsync(79);
      expect(h.nominate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.publication?.state).toBe('submitted');
      expect(h.nominate).toHaveBeenCalledTimes(2);
      expect(h.nominate.mock.calls[0][0]).toEqual(h.nominate.mock.calls[1][0]);
      await h.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed artifact read after 30 seconds even when another task waits hours for its quota slot', async () => {
    vi.useFakeTimers();
    try {
      const t = task([artifact('a-00000001', 'index.html', 'html')]);
      const h = setup(t);
      const waiting: TaskRecord = { ...task([artifact('a-00000002', 'index.html', 'html')]), id: 't-00000002' };
      waiting.publication = { ...waiting.publication!, nextAttemptAt: Date.now() + 3_600_000 };
      h.ledger.data.tasks[waiting.id] = waiting;
      const read = vi.mocked(h.storage.readFile);
      const original = read.getMockImplementation();
      read.mockImplementation(async () => {
        throw new Error('disk unavailable');
      });
      h.connect();
      h.coordinator.open();
      await vi.advanceTimersByTimeAsync(100);
      expect(t.publication?.state).toBe('pending');
      read.mockImplementation(original!);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(100);
      expect(t.publication?.state, '读成品失败的重试不被另一件任务的推迟时刻盖掉').toBe('submitted');
      expect(waiting.publication?.state).toBe('pending');
      await h.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['the publish service is absent', 'absent'],
    ['listing surfaces throws', 'throws'],
    ['the surface stays unavailable', 'unavailable'],
  ] as const)('keeps retrying every 30 seconds while %s, so the 24-hour deadline is reached without any other wake-up', async (_label, outage) => {
    vi.useFakeTimers();
    try {
      const t = { ...task([artifact('a-00000001', 'page.html', 'html')]), endedAt: 0 };
      let now = 0;
      const h = setup(t, { surface: outage !== 'unavailable', now: () => now });
      if (outage === 'throws')
        vi.mocked(h.service.listSurfaces).mockImplementation(() => {
          throw new Error('surface registry unavailable');
        });
      if (outage !== 'absent') h.connect();
      h.coordinator.open();
      await vi.advanceTimersByTimeAsync(100);
      expect(t.publication?.state).toBe('pending');
      now = 24 * 3_600_000;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(t.publication?.state, '推进不了时 30 秒后重试，期限到了自然会查到').toBe('failed');
      expect(t.publication?.reason).toContain('24 小时');
      expect(h.nominate).not.toHaveBeenCalled();
      await h.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a manual repair whose publish receipt could not be saved', async () => {
    vi.useFakeTimers();
    try {
      const t = task([
        artifact('a-00000001', 'preview.png', 'png'),
        artifact('a-00000002', 'source/workspace.tar.gz', 'other'),
      ]);
      t.publication = {
        target: 'works',
        title: '修正后的作品',
        summary: '选定图片',
        state: 'pending',
        artifactIds: ['a-00000001'],
        paths: ['work.png'],
        nextAttemptAt: Date.now() + 80,
      };
      const h = setup(t);
      h.connect();
      h.coordinator.open();
      h.coordinator.kick();
      await vi.advanceTimersByTimeAsync(79);
      expect(h.nominate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(t.publication?.state).toBe('submitted');
      expect(h.nominate).toHaveBeenCalledTimes(1);
      expect(h.nominate.mock.calls[0][0]).toMatchObject({
        submissionKey: `paper:${t.id}`,
        title: '修正后的作品',
        files: [{ path: 'work.png' }],
      });
      await h.coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a rejected decision and stops on close', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const h = setup(t);
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('submitted'));
    h.setState('rejected');
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    await h.coordinator.close();
    h.coordinator.kick();
    expect(h.nominate).toHaveBeenCalledTimes(1);
  });

  it('waits for a read in flight on close and never submits afterward', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const h = setup(t);
    let finishRead!: (bytes: Uint8Array) => void;
    vi.mocked(h.storage.readFile).mockImplementation(
      () =>
        new Promise(resolve => {
          finishRead = resolve as typeof finishRead;
        }),
    );
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(h.storage.readFile).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = h.coordinator.close().then(() => {
      closed = true;
    });
    await settled();
    expect(closed).toBe(false);
    finishRead(new Uint8Array([1, 2, 3]));
    await closing;
    expect(h.nominate).not.toHaveBeenCalled();
    expect(t.publication?.state).toBe('pending');
  });

  it('rechecks target permission after asynchronous artifact reads', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const h = setup(t);
    let finishRead!: (bytes: Uint8Array) => void;
    vi.mocked(h.storage.readFile).mockImplementation(
      () =>
        new Promise(resolve => {
          finishRead = resolve as typeof finishRead;
        }),
    );
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(h.storage.readFile).toHaveBeenCalledTimes(1));
    (h.cfg.papers as Map<string, PaperConfig['defaults']>).set('demo', { publishTargets: [] } as never);
    finishRead(new Uint8Array([1, 2, 3]));
    await settled();
    expect(h.nominate).not.toHaveBeenCalled();
    await h.coordinator.close();
  });

  it.each(['failed', 'cancelled'] as const)('marks a %s creation terminal without a publish provider', async state => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    t.state = state;
    const notice = { id: 'n-00000001', at: 1 };
    t.notice = notice;
    const h = setup(t);
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toMatch(/未提交发布/);
    expect(t.notice, '创作失败的通知已经报过这件任务，不因发布随之失败再报一次').toBe(notice);
    expect(h.ledger.save).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.changed).toHaveBeenCalled());
    expect(h.nominate).not.toHaveBeenCalled();
    await h.coordinator.close();
  });

  // 经 works_nominate 重新提名的任务带着上一次失败的通知标记。只有提交之前转为失败才清它（由完成通知报新结果）；
  // 只是推迟、或已提交之后才失败（作品通知那边报）时标记照旧，写盘失败回滚时标记也一并还原
  it('keeps the earlier notice marker when a re-nomination is only postponed', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const notice = { id: 'n-00000001', at: 1 };
    t.notice = notice;
    const h = setup(t);
    h.nominate.mockImplementationOnce(async () => ({ refused: '待审额度已满', retryAfterMs: 60_000 }));
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.nextAttemptAt).toBeTypeOf('number'));
    expect(t.publication?.state).toBe('pending');
    expect(t.notice).toBe(notice);
    await h.coordinator.close();
  });

  it('keeps the earlier notice marker when a re-nominated work fails after submission', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const notice = { id: 'n-00000001', at: 1 };
    t.notice = notice;
    const h = setup(t);
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('submitted'));
    h.setState('rejected');
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.workId).toBe('abcdefghij');
    expect(t.notice).toBe(notice);
    await h.coordinator.close();
  });

  it('restores the notice marker together with the publication when saving a pre-submission failure fails', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    t.publication = { ...t.publication!, artifactIds: ['a-00000001'], paths: ['index.html'] };
    const pending = t.publication;
    const notice = { id: 'n-00000001', at: 1 };
    t.notice = notice;
    const h = setup(t);
    h.nominate.mockImplementation(async () => ({ refused: '路径不符合要求' }));
    // 失败结论一直写不进盘：每次都回滚
    vi.mocked(h.ledger.save).mockImplementation(async () => {
      if (t.publication?.state === 'failed') throw new Error('disk unavailable');
    });
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(h.ledger.save).toHaveBeenCalled());
    await settled();
    expect(t.publication).toBe(pending);
    expect(t.notice).toBe(notice);
    await h.coordinator.close();
  });

  it('reconciles a terminal task left pending across shutdown on the next open', async () => {
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const first = setup(t);
    first.coordinator.open();
    await first.coordinator.close();
    t.state = 'failed';
    const restarted = setup(t);
    restarted.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(restarted.nominate).not.toHaveBeenCalled();
    await restarted.coordinator.close();
  });
});
