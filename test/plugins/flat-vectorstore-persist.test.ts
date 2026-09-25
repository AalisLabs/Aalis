import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type VectorStoreService, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, type BoundOf, definePlugin, lifecycle, provide, services } from '../../packages/core/src/index.js';
import vectorstoreFlat, { FlatVectorStore } from '../../packages/plugin-vectorstore-flat/src/index.js';

// ════════════════════════════════════════════════════════════
// flat 向量库的两处落地问题：
//   1. dispose 时 void store.save() 不等落盘 → 停机返回时最后一批向量还没写完；
//   2. init 的 JSON.parse 不校验是数组 → 文件被写成合法 JSON 对象时 size/search 崩。
//   3. storage 是必需依赖却没声明成 required → 停机拓扑里没有「flat 先于 storage 关」
//      这条边，storage 后注册时会先关，落盘写到一个已关停的 storage 上。
//
// storage 侧用真 fs（写到临时目录），但服务挂在 app 根 ctx 上而非插件：
// 根服务比插件子 ctx 活得久，落盘窗口不受拆卸顺序干扰；写入刻意慢 30ms，
// 让「不等待」可被确定性观察（否则 void 化也可能碰巧写完）。
// ════════════════════════════════════════════════════════════

const ROOT: StorageRootInfo = {
  name: 'ws',
  label: 'ws',
  kind: 'workspace',
  browsable: true,
  readable: true,
  writable: true,
  deletable: true,
};

/**
 * 真 fs 存储服务：只实现 flat 用到的 listRoots/readFile/writeFile。
 * `state.closed` 置位后写入抛错——用来坐实落盘确实发生在 storage 关停之前。
 */
function makeStorage(dir: () => string, state: { closed: boolean } = { closed: false }): StorageService {
  const toPath = (uri: string): string => join(dir(), basename(uri));
  return {
    listRoots: () => [ROOT],
    async readFile(uri: string): Promise<string> {
      return await readFile(toPath(uri), 'utf-8');
    },
    async writeFile(uri: string, data: string): Promise<void> {
      await new Promise(r => setTimeout(r, 30)); // 慢写：不等待就一定观察得到
      if (state.closed) throw new Error('storage 已关停，写入拒绝');
      await writeFile(toPath(uri), data);
    },
  } as unknown as StorageService;
}

/** 宿主侧用的能力：提供桩服务、查激活后的 vectorstore */
const hostUses = { provide, services };

describe('plugin-vectorstore-flat 落盘与损坏容错（真 fs）', () => {
  let dir: string;
  let app: App;
  let host: BoundOf<typeof hostUses>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-flat-'));
    app = new App({ name: 'T', logLevel: 'error' });
    host = app.bind(hostUses);
    host.provide(
      storage,
      makeStorage(() => dir),
    );
  });

  afterEach(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function loadFlat(): Promise<VectorStoreService> {
    await app.plugin(vectorstoreFlat, { path: 'ws:/vectorstore' });
    await app.plugins.idle();
    const store = host.services.get(vectorstore);
    if (!store) throw new Error('vectorstore 服务未就绪');
    return store;
  }

  it('停机（dispose）等待落盘完成：新增向量不丢', async () => {
    const store = await loadFlat();
    await store.add([1, 0, 0], { id: 'a' });

    await app.stop(); // onDispose 必须 await save()

    const file = join(dir, 'vectors.json');
    expect(existsSync(file), 'stop 返回时 vectors.json 应已落盘').toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ metadata: { id: string } }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].metadata.id).toBe('a');
  });

  it('数据文件是合法 JSON 但非数组：按空库处理，size/search 不崩；新增只在内存，停机不覆盖原文件', async () => {
    const seeded = '{"entries":{"a":1}}';
    writeFileSync(join(dir, 'vectors.json'), seeded);
    const store = await loadFlat();

    expect(await store.size()).toBe(0);
    expect(await store.search([1, 0, 0], 3)).toEqual([]);
    await store.add([0, 1, 0], { id: 'b' });
    expect(await store.size()).toBe(1);

    await app.stop();
    expect(readFileSync(join(dir, 'vectors.json'), 'utf-8')).toBe(seeded);
  });

  it('数据文件损坏（截断 JSON）：add + save + 停机都不覆盖原文件', async () => {
    const broken = '[{"vector":[1,0';
    writeFileSync(join(dir, 'vectors.json'), broken);
    const store = await loadFlat();
    await store.add([1, 0, 0], { id: 'c' });
    await store.save();

    await app.stop();
    expect(readFileSync(join(dir, 'vectors.json'), 'utf-8')).toBe(broken);
  });
});

// ════════════════════════════════════════════════════════════
// 读不懂就不回写：vectors.json 是整库快照，一次 EACCES 或坏文件曾让下一次 save 把整库换成
// 只含本次新增的内容。只有「文件不存在」算冷启动；其它失败本次运行拒写，clear 也不例外。
// ════════════════════════════════════════════════════════════
describe('FlatVectorStore 读失败拒写', () => {
  const storeWith = (read: () => Promise<string>) => {
    let writes = 0;
    const storage = {
      readFile: read,
      writeFile: async () => {
        writes++;
      },
    } as unknown as StorageService;
    return { store: new FlatVectorStore(storage, 'ws:/vectorstore/vectors.json'), writes: () => writes };
  };
  const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

  it('非 ENOENT 的读失败（EACCES，文案含 not found）：add / save / clear 都不写', async () => {
    const { store, writes } = storeWith(async () => {
      throw coded('EACCES', 'EACCES: credentials not found');
    });
    await store.init();
    await store.add([1, 0, 0], { id: 'a' });
    await store.save();
    await store.clear();
    expect(writes()).toBe(0);
    expect(await store.size()).toBe(0);
  });

  it('文件不存在（code ENOENT）：冷启动，照常写', async () => {
    const { store, writes } = storeWith(async () => {
      throw coded('ENOENT', '文件缺失');
    });
    await store.init();
    await store.add([1, 0, 0], { id: 'a' });
    await store.save();
    expect(writes()).toBe(1);
  });
});

describe('plugin-vectorstore-flat 的 storage 依赖（拓扑序）', () => {
  let dir: string;
  let app: App;
  let host: BoundOf<typeof hostUses>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aalis-flat-topo-'));
    app = new App({ name: 'T', logLevel: 'error' });
    host = app.bind(hostUses);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('storage 后于 flat 注册：flat 仍等 storage 就绪才激活，停机时先关 flat、落盘成功', async () => {
    const state = { closed: false };
    const storagePlugin = definePlugin({
      name: 'test-storage-provider',
      provides: [storage],
      uses: { provide, lifecycle },
      apply(caps) {
        caps.provide(
          storage,
          makeStorage(() => dir, state),
        );
        caps.lifecycle.onDispose(() => {
          state.closed = true;
        }, 'test-storage:close');
      },
    });

    // 注册序刻意「消费者先、提供者后」：没有 required 边时停机会按注册序反向关，
    // 即先关 storage 再关 flat，落盘写到已关停的 storage 上。
    await app.plugins.register(vectorstoreFlat, { path: 'ws:/vectorstore' });
    expect(host.services.get(vectorstore), 'storage 缺位时 flat 不该激活').toBeUndefined();

    await app.plugins.register(storagePlugin);
    await app.plugins.idle();

    const store = host.services.get(vectorstore);
    expect(store, 'storage 就绪后 flat 应被激活').toBeDefined();
    await store!.add([1, 0, 0], { id: 'topo' });

    await app.stop();

    expect(state.closed, 'storage 插件应已拆卸').toBe(true);
    const file = join(dir, 'vectors.json');
    expect(existsSync(file), '落盘应在 storage 关停之前完成').toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Array<{ metadata: { id: string } }>;
    expect(parsed.map(e => e.metadata.id)).toEqual(['topo']);
  });
});
