import { describe, expect, it } from 'vitest';
import type { LifecycleCap, Logger } from '../../packages/core/src/index.js';
import { openAndProvide } from '../../packages/plugin-memory-mongodb/src/index.js';

// ════════════════════════════════════════════════════════════
// 记忆库按家目录区分：库名加 profile 一段，库里记着它归哪个家目录与实例。两个家目录（开发用的 .aalis-dev 与
// 生产的 ~/.aalis，或复制出来的测试实例）连同一个 MongoDB、派生出同一个库名时，后来的那个以一行配置错误失败，
// 不会共写；库里已有数据却没有记录时不默认认走；claimFrom 用来在搬迁后认领。
// 客户端与集合都是替身，不连任何真实的 mongod。
// ════════════════════════════════════════════════════════════

type Client = Parameters<typeof openAndProvide>[0];
type Doc = Record<string, unknown>;

const NAME = '@aalis/plugin-memory-mongodb';
const OWNER = { namespace: 'aalis.home', key: 'owner' };

/** 筛选只认字段相等；缺字段与 null 等同（与 MongoDB 的 `{ f: null }` 一样） */
function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => JSON.stringify(doc[k] ?? null) === JSON.stringify(v ?? null));
}

/**
 * 一个库：集合名 → 文档。同一个 server 可以给多个客户端共用。
 * beforeWrite 在下一次写入之前执行一次，模拟另一个家目录在本次读与写之间抢先写入。
 */
function fakeServer(seed: Record<string, Doc[]> = {}) {
  const store = new Map(Object.entries(seed).map(([name, docs]) => [name, [...docs]]));
  const calls = { metaReads: 0, writes: 0, closes: 0, dbs: [] as string[] };
  const hooks: { beforeWrite?: () => void } = {};
  const docs = (name: string) => {
    if (!store.has(name)) store.set(name, []);
    return store.get(name)!;
  };
  const takeHook = () => {
    const hook = hooks.beforeWrite;
    hooks.beforeWrite = undefined;
    hook?.();
  };
  const collection = (name: string) => ({
    // 建索引会建出集合
    createIndex: async () => void docs(name),
    findOne: async (filter: Doc = {}) => {
      if (name === 'metadata') calls.metaReads++;
      // 与真实驱动一样交回副本：调用方拿到的不随库里的文档变
      const found = docs(name).find(d => matches(d, filter));
      return found ? structuredClone(found) : null;
    },
    insertOne: async (doc: Doc) => {
      takeHook();
      if (docs(name).some(d => matches(d, OWNER) && matches(doc, OWNER))) {
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      calls.writes++;
      docs(name).push(doc);
    },
    updateOne: async (filter: Doc, update: { $set: Doc }) => {
      takeHook();
      const found = docs(name).find(d => matches(d, filter));
      if (!found) return { matchedCount: 0 };
      calls.writes++;
      Object.assign(found, update.$set);
      return { matchedCount: 1 };
    },
  });
  const client = {
    connect: async () => {},
    db: (dbName: string) => {
      calls.dbs.push(dbName);
      return {
        collection,
        listCollections: () => ({ toArray: async () => [...store.keys()].map(name => ({ name })) }),
      };
    },
    close: async () => {
      calls.closes++;
    },
  } as unknown as Client;
  const owner = () => store.get('metadata')?.find(d => matches(d, OWNER))?.data;
  return { client, calls, hooks, owner, docs };
}

const ownerDoc = (data: unknown) => ({ ...OWNER, data });

function caps(id: string) {
  const lines: string[] = [];
  const noop = () => {};
  const logger = {
    debug: noop,
    info: (msg: string) => void lines.push(`info ${msg}`),
    warn: (msg: string) => void lines.push(`warn ${msg}`),
    error: noop,
    child: () => logger,
  } as unknown as Logger;
  const lifecycle: LifecycleCap = {
    id,
    signal: new AbortController().signal,
    onDrain: () => noop,
    onDispose: () => noop,
  };
  return { logger, lifecycle, provide: (() => noop) as never, lines };
}

const config = (claimFrom = '', database = '') => ({
  uri: `mongodb://owner-${Math.random()}.invalid`,
  database,
  claimFrom,
  collection: 'messages',
});
const failure = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (err: unknown) => err as Error,
  );

describe('plugin-memory-mongodb 库名的派生', () => {
  it('主家目录 aalis，profile 家目录 aalis_<p>，后缀实例再加后缀；宿主不给家目录时按旧规则', async () => {
    const opened: string[] = [];
    for (const [id, owner] of [
      [NAME, { home: '/h' }],
      [NAME, { home: '/u/.aalis-test', profile: 'test' }],
      [`${NAME}:b`, { home: '/u/.aalis-test', profile: 'test' }],
      [NAME, { home: '/u/.aalis-test-b', profile: 'test-b' }],
      [`${NAME}:b`, undefined],
    ] as const) {
      const server = fakeServer();
      await openAndProvide(server.client, config(), caps(id), owner);
      opened.push(...server.calls.dbs);
    }
    // profile 不含下划线：profile test 的 :b 实例与 profile test-b 的主实例不撞名
    expect(opened).toEqual(['aalis', 'aalis_test', 'aalis_test_b', 'aalis_test-b', 'aalis-b']);
  });

  it('库名超过 63 字节时以配置错误失败，不发起连接', async () => {
    const server = fakeServer();
    const err = await failure(
      openAndProvide(server.client, config(), caps(`${NAME}:${'x'.repeat(58)}`), { home: '/h' }),
    );
    expect(err?.name).toBe('ConfigError');
    expect(err?.message).toContain('63 字节');
    expect(server.calls.dbs).toEqual([]);
  });
});

describe('plugin-memory-mongodb 库的归属', () => {
  it('新库：记下本家目录与实例；再次以同一家目录启动照常使用、不再写', async () => {
    const server = fakeServer();
    await openAndProvide(server.client, config(), caps(NAME), { home: '/h' });
    expect(server.owner()).toEqual({ home: '/h', instance: NAME });
    const writes = server.calls.writes;
    await openAndProvide(server.client, config(), caps(NAME), { home: '/h' });
    expect(server.calls.writes).toBe(writes);
  });

  it('库已归别的家目录：以配置错误失败、关闭客户端，点名并提示先停掉原实例；claimFrom 写的正是那个家目录时改记到本家目录', async () => {
    const server = fakeServer({ metadata: [ownerDoc({ home: '/old/.aalis', instance: NAME })] });
    const err = await failure(openAndProvide(server.client, config(), caps(NAME), { home: '/new/.aalis' }));
    expect(err?.name).toBe('ConfigError');
    expect(err?.message).toContain('已归家目录 /old/.aalis');
    expect(err?.message).toContain('先停掉那个家目录的实例');
    expect(err?.message).toContain('claimFrom: /old/.aalis');
    expect(server.calls.closes).toBe(1);
    expect(server.owner()).toEqual({ home: '/old/.aalis', instance: NAME });

    const wrong = await failure(
      openAndProvide(server.client, config('/elsewhere'), caps(NAME), { home: '/new/.aalis' }),
    );
    expect(wrong?.message).toContain('已归家目录 /old/.aalis');

    const claim = caps(NAME);
    await openAndProvide(server.client, config('/old/.aalis'), claim, { home: '/new/.aalis' });
    expect(server.owner()).toEqual({ home: '/new/.aalis', instance: NAME });
    expect(claim.lines.join('\n')).toContain('请从配置里删掉 claimFrom');
  });

  it('同一家目录、别的实例（显式写了同一个库）：点名那个实例，不当成搬迁', async () => {
    const server = fakeServer({ metadata: [ownerDoc({ home: '/h', instance: NAME })] });
    const err = await failure(openAndProvide(server.client, config('', 'aalis'), caps(`${NAME}:c`), { home: '/h' }));
    expect(err?.message).toContain(`归本家目录的实例 ${NAME}`);
    expect(err?.message).not.toContain('搬来');
  });

  it('claimFrom 用完还留着：库已归本家目录时告警，提示删掉', async () => {
    const server = fakeServer({ metadata: [ownerDoc({ home: '/h', instance: NAME })] });
    const c = caps(NAME);
    await openAndProvide(server.client, config('unowned'), c, { home: '/h' });
    expect(c.lines.filter(l => l.startsWith('warn'))).toEqual([expect.stringContaining('claimFrom 用不上了')]);
  });

  it.each([
    ['消息集合里有消息', { messages: [{ sessionId: 's' }] }],
    ['只剩别的命名空间的元数据', { metadata: [{ namespace: 'user-profile', key: 'u', data: {} }] }],
    ['数据在另一个名字的消息集合里', { history: [{ sessionId: 's' }] }],
  ])('库里已有数据却没有归属记录（%s）：不默认认走；claimFrom: unowned 时认领', async (_label, seed) => {
    const server = fakeServer(seed);
    const err = await failure(openAndProvide(server.client, config(), caps(NAME), { home: '/dev/.aalis-dev' }));
    expect(err?.name).toBe('ConfigError');
    expect(err?.message).toContain('没有记录它归哪个家目录');
    expect(server.calls.closes).toBe(1);
    expect(server.owner()).toBeUndefined();

    await openAndProvide(server.client, config('unowned'), caps(NAME), { home: '/h' });
    expect(server.owner()).toEqual({ home: '/h', instance: NAME });
  });

  it('只建了索引的空集合（上次激活中途失败留下的）不算有数据', async () => {
    const server = fakeServer({ messages: [], 'system.views': [{ x: 1 }] });
    await openAndProvide(server.client, config(), caps(NAME), { home: '/h' });
    expect(server.owner()).toEqual({ home: '/h', instance: NAME });
  });

  it.each([
    ['data 为 null', null],
    ['缺 data', undefined],
    ['缺实例', { home: '/h' }],
  ])('归属记录坏了（%s）：报错、不死循环；claimFrom: unowned 时改写', async (_label, data) => {
    const doc = data === undefined ? { ...OWNER } : ownerDoc(data);
    const server = fakeServer({ metadata: [doc] });
    const err = await failure(openAndProvide(server.client, config(), caps(NAME), { home: '/h' }));
    expect(err?.name).toBe('ConfigError');
    expect(err?.message).toContain('归属记录坏了');

    await openAndProvide(server.client, config('unowned'), caps(NAME), { home: '/h' });
    expect(server.owner()).toEqual({ home: '/h', instance: NAME });
  });

  it('两个家目录同时认领一个新库：唯一索引挡住后到的写入，它按对方的记录报错', async () => {
    const server = fakeServer();
    server.hooks.beforeWrite = () => void server.docs('metadata').push(ownerDoc({ home: '/other', instance: NAME }));
    const err = await failure(openAndProvide(server.client, config(), caps(NAME), { home: '/h' }));
    expect(err?.message).toContain('已归家目录 /other');
    expect(server.owner()).toEqual({ home: '/other', instance: NAME });
  });

  it('两个家目录同时用 claimFrom 认领：比对后写入，后到的不覆盖，按新的记录报错', async () => {
    const server = fakeServer({ metadata: [ownerDoc({ home: '/old', instance: NAME })] });
    server.hooks.beforeWrite = () => {
      const owner = server.owner() as Doc;
      owner.home = '/first';
    };
    const err = await failure(openAndProvide(server.client, config('/old'), caps(NAME), { home: '/second' }));
    expect(err?.message).toContain('已归家目录 /first');
    expect(server.owner()).toEqual({ home: '/first', instance: NAME });
  });

  it('宿主不提供家目录（嵌入式宿主、测试夹具）时不做归属检查', async () => {
    const server = fakeServer({ metadata: [ownerDoc({ home: '/someone', instance: 'x' })] });
    await openAndProvide(server.client, config(), caps(NAME));
    expect(server.calls.metaReads).toBe(0);
  });
});
