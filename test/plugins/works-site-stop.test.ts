import { describe, expect, it, vi } from 'vitest';
import type { PublishedItem } from '../../packages/api-publish/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import type { PagesClient, PagesDeployment } from '../../packages/plugin-works-site/src/cloudflare/client.js';
import { readConfig } from '../../packages/plugin-works-site/src/config.js';
import { WorksDeployer } from '../../packages/plugin-works-site/src/deploy.js';
import { STATE_URI, WorksStore } from '../../packages/plugin-works-site/src/state.js';
import { memoryStorage } from '../fixtures/paper.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = readConfig(
  { accountId: '0'.repeat(32), apiToken: 'token', projectName: 'site-one', siteOrigin: 'https://site-one.pages.dev' },
  logger,
);
const item: PublishedItem = {
  id: 'abcdefghij',
  group: 'opaque',
  groupLabel: 'room',
  surfaces: ['works'],
  kind: 'media',
  title: 'sample',
  summary: '',
  publishedAt: 1,
  files: [{ path: 'image.png', size: 1, contentType: 'image/png' }],
  hasThumbnail: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function deployer(store: WorksStore, client: PagesClient, live: (ids: readonly string[]) => void) {
  return new WorksDeployer({
    config,
    store,
    client,
    publish: () => ({
      listPublished: () => [item],
      readFile: async () => new Uint8Array(),
      readThumbnail: async () => new Uint8Array(),
    }),
    live,
    logger,
    signal: new AbortController().signal,
  });
}

describe('works-site shutdown ownership', () => {
  it('ignores a late remote list after stop, preserving the next instance ledger and suppressing old live', async () => {
    const files = new Map<string, string>();
    const store = new WorksStore(memoryStorage(files));
    await store.load();
    await store.update(state => {
      state.current.main = {
        id: '11111111',
        branch: 'main',
        nonce: 'old',
        at: 1,
        files: {},
        works: [item],
        verified: true,
      };
      state.known['11111111'] = { branch: 'main', at: 1 };
      state.known['22222222'] = { branch: 'main', at: 2 };
    });
    const entered = deferred<void>();
    const remote = deferred<PagesDeployment[]>();
    const lateWriteAttempt = deferred<void>();
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(change => {
      lateWriteAttempt.resolve();
      return update(change);
    });
    const client = {
      listDeployments: () => {
        entered.resolve();
        return remote.promise;
      },
    } as unknown as PagesClient;
    const live = vi.fn();
    const old = deployer(store, client, live);
    old.start();
    await entered.promise;
    await old.stop(); // A replacement is allowed to take the same state URI after this resolves.
    const replacement = new WorksStore(memoryStorage(files));
    await replacement.load();
    expect(Object.keys(replacement.data?.known ?? {})).toEqual(['11111111', '22222222']);
    await replacement.update(state => {
      state.known['33333333'] = { branch: 'main', at: 3 };
    });
    remote.resolve([]);
    await lateWriteAttempt.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(Object.keys(replacement.data?.known ?? {})).toEqual(['11111111', '22222222', '33333333']);
    expect(JSON.parse(files.get(STATE_URI) ?? '{}').known).toHaveProperty('22222222');
    expect(JSON.parse(files.get(STATE_URI) ?? '{}').known).toHaveProperty('33333333');
    expect(live).not.toHaveBeenCalled();
  });

  it('waits for a started local state write before releasing the old instance', async () => {
    const files = new Map<string, string>();
    const memory = memoryStorage(files);
    const entered = deferred<void>();
    const release = deferred<void>();
    let hold = false;
    const storage = {
      ...memory,
      async writeFile(uri: string, bytes: string | Buffer) {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        await memory.writeFile(uri, bytes);
      },
    } as StorageService;
    const store = new WorksStore(storage);
    await store.load();
    const old = deployer(store, {} as PagesClient, () => {});
    hold = true;
    const writing = store.update(state => {
      state.known['33333333'] = { branch: 'main', at: 3 };
    });
    await entered.promise;
    const queued = store.update(state => {
      state.known['44444444'] = { branch: 'main', at: 4 };
    });
    const queuedRejected = expect(queued).rejects.toThrow(/已停止/);
    let stopped = false;
    const stopping = old.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([writing, stopping]);
    await queuedRejected;
    expect(stopped).toBe(true);
    const replacement = new WorksStore(memoryStorage(files));
    await replacement.load();
    expect(replacement.data?.known).toHaveProperty('33333333');
    expect(replacement.data?.known).not.toHaveProperty('44444444');
    await expect(store.update(() => {})).rejects.toThrow(/已停止/);
  });
});
