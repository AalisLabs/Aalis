import { describe, expect, it, vi } from 'vitest';
import type { NominateInput, NominateResult, PublishService } from '../../packages/api-publish/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { Logger, ServiceRef } from '../../packages/core/src/index.js';
import { artifactUri } from '../../packages/plugin-paper/src/artifacts.js';
import type { PaperConfig } from '../../packages/plugin-paper/src/config.js';
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
  createdAt: 1,
  artifacts,
  delivered: false,
  publication: { target, title: '作品', summary: '', state: 'pending' },
});

function setup(t: TaskRecord, options: { surface?: boolean; target?: boolean; failReceipt?: boolean } = {}) {
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
    get current() {
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
  } as unknown as ServiceRef<PublishService>;
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

  it('does not choose a guessed work from ambiguous artifacts', async () => {
    const t = task([artifact('a-00000001', 'cat.png', 'png'), artifact('a-00000002', 'dog.png', 'png')]);
    const h = setup(t);
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toMatch(/手动选择/);
    expect(h.nominate).not.toHaveBeenCalled();
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
    const t = task([artifact('a-00000001', 'index.html', 'html')]);
    const h = setup(t);
    h.nominate.mockImplementationOnce(async () => ({ refused: '待审额度已满', retryAfterMs: 80 }));
    h.connect();
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.nextAttemptAt).toBeTypeOf('number'));
    expect(t.publication?.state).toBe('pending');
    expect(h.nominate).toHaveBeenCalledTimes(1);
    h.coordinator.kick();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.nominate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(t.publication?.state).toBe('submitted'));
    expect(h.nominate).toHaveBeenCalledTimes(2);
    expect(h.nominate.mock.calls[0][0]).toEqual(h.nominate.mock.calls[1][0]);
    await h.coordinator.close();
  });

  it('resumes a manual repair whose publish receipt could not be saved', async () => {
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
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.nominate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.publication?.state).toBe('submitted'));
    expect(h.nominate).toHaveBeenCalledTimes(1);
    expect(h.nominate.mock.calls[0][0]).toMatchObject({
      submissionKey: `paper:${t.id}`,
      title: '修正后的作品',
      files: [{ path: 'work.png' }],
    });
    await h.coordinator.close();
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
    const h = setup(t);
    h.coordinator.open();
    await vi.waitFor(() => expect(t.publication?.state).toBe('failed'));
    expect(t.publication?.reason).toMatch(/未提交发布/);
    expect(h.ledger.save).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.changed).toHaveBeenCalled());
    expect(h.nominate).not.toHaveBeenCalled();
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
