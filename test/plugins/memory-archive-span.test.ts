import { afterEach, describe, expect, it } from 'vitest';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { MongoMemoryService } from '../../packages/plugin-memory-mongodb/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';
import { type Message, WellKnownKinds } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 三家后端同一组用例：
// - archiveSpan(s, { count, keep }) 把最早的 count 条活跃消息（顺序与 getHistory 相同：时间，同毫秒按写入序）标为归档，
//   keep 列出的位置（这一段里从 0 数）不归档，返回归档条数。count 为 0 时什么都不归档，大于活跃条数时这一段就是全部活跃
//   消息；段外的下标不起作用，重复的与一个相同。留下的照原顺序在活跃历史最前面，完整历史里留下的与归档的照原顺序交错；
//   之后追加的消息在段外，别的会话不动。
// - 带条数的读法：条数为 0 时返回空，为 Infinity 时返回全部（跨会话查询收窄到后端配置的上限）。
// - countHistory 与按条数的 getHistory 只数对话消息：事件标记（CONTROL_KINDS）不占条数，getHistory(…, limit) 读出第
//   limit+1 新的对话消息之后的全部活跃消息，夹在其间的标记一并带回；archiveSpan 按位置数，标记也占位置。
// - updateMessageContent 改最近 recentLimit 条含 oldText（按字面，区分大小写）的消息，归档的也算。
//
// mongodb 的集合用内存替身，不经 apply（apply 会直连真实的 mongod）。替身照服务端的规矩：limit(0) 表示不限条数、
// limit 不是整数时报错、没有这个字段的文档不落在 $nin 的列表里；排序键全部平票时按写入的逆序排——这是对抗方向：归档的
// 排序去掉 _id 次键，同毫秒的几条就会倒着数进这一段。
// ════════════════════════════════════════════════════════════

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

type Doc = Record<string, unknown> & { _id: number };

type Filter = Record<string, unknown>;

/** 替身认得的条件只有本文件用例走到的：相等、$or、$ne、$in、$nin、$gt、$regex */
function matches(doc: Doc, filter: Filter): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as Filter[]).some(branch => matches(doc, branch));
    const value = doc[key];
    if (cond === null || typeof cond !== 'object') return value === cond;
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$ne') return value !== arg;
      if (op === '$in') return (arg as unknown[]).includes(value);
      if (op === '$nin') return !(arg as unknown[]).includes(value);
      if (op === '$gt') return (value as number) > (arg as number);
      if (op === '$regex') return typeof value === 'string' && new RegExp(arg as string).test(value);
      throw new Error(`替身不认 ${op}`);
    });
  });
}

function fakeCollection() {
  const docs: Doc[] = [];
  const set = (hit: Doc[], update: { $set: Record<string, unknown> }) => {
    for (const d of hit) Object.assign(d, update.$set);
    return { modifiedCount: hit.length };
  };
  return {
    insertOne: async (doc: Record<string, unknown>) => {
      docs.push({ ...doc, _id: docs.length + 1 });
      return { acknowledged: true };
    },
    countDocuments: async (filter: Filter) => docs.filter(d => matches(d, filter)).length,
    find: (filter: Filter) => {
      let rows = docs.filter(d => matches(d, filter));
      const cursor = {
        sort: (spec: Record<string, 1 | -1>) => {
          rows = [...rows].sort((a, b) => {
            for (const [key, dir] of Object.entries(spec)) {
              const diff = (a[key] as number) - (b[key] as number);
              if (diff !== 0) return diff * dir;
            }
            return b._id - a._id;
          });
          return cursor;
        },
        limit: (n: number) => {
          if (!Number.isInteger(n)) throw new Error(`limit 须为整数，收到 ${n}`);
          if (n !== 0) rows = rows.slice(0, n);
          return cursor;
        },
        skip: (n: number) => {
          if (!Number.isInteger(n) || n < 0) throw new Error(`skip 须为非负整数，收到 ${n}`);
          rows = rows.slice(n);
          return cursor;
        },
        project: () => cursor,
        toArray: async () => rows,
      };
      return cursor;
    },
    updateOne: async (filter: Filter, update: { $set: Record<string, unknown> }) =>
      set(docs.filter(d => matches(d, filter)).slice(0, 1), update),
    updateMany: async (filter: Filter, update: { $set: Record<string, unknown> }) =>
      set(
        docs.filter(d => matches(d, filter)),
        update,
      ),
  };
}

/** crossSessionMaxLimit：跨会话查询的条数上限，三家各按自己的方式配（inmemory 经插件配置，另两家经构造参数） */
type Open = (opts?: { crossSessionMaxLimit?: number }) => Promise<{ mem: MemoryService; stop: () => Promise<void> }>;

const BACKENDS: Array<[string, Open]> = [
  [
    'inmemory',
    async opts => {
      const app = new App({ logLevel: 'error' });
      await app.plugin(memoryInMemory, opts);
      await app.plugins.idle();
      const mem = app.bind({ services }).services.use.get(memory);
      if (!mem) throw new Error('memory 服务未就绪');
      return { mem, stop: () => app.stop() };
    },
  ],
  [
    'sqlite',
    async opts => ({
      mem: new SQLiteMemoryService(new DatabaseSync(':memory:'), { ...opts, logger: { warn() {} } }),
      stop: async () => {},
    }),
  ],
  [
    'mongodb',
    async opts => {
      type Ctor = ConstructorParameters<typeof MongoMemoryService>;
      const mem = new MongoMemoryService(fakeCollection() as unknown as Ctor[0], {} as Ctor[1], {
        ...opts,
        logger: { warn() {} },
      });
      return { mem, stop: async () => {} };
    },
  ],
];

const msg = (content: string, timestamp: number): Message => ({ role: 'user', content, timestamp });
const contents = (messages: Message[]) => messages.map(m => m.content);
/** m0、m1……，时间戳各差一秒 */
const numbered = (count: number) => Array.from({ length: count }, (_, i) => msg(`m${i}`, 1000 * (i + 1)));

describe.each(BACKENDS)('%s：archiveSpan', (_name, open) => {
  let stop: () => Promise<void> = async () => {};
  afterEach(() => stop());

  async function seeded(messages: Message[]): Promise<MemoryService> {
    const opened = await open();
    stop = opened.stop;
    for (const m of messages) await opened.mem.saveMessage('s', m);
    await opened.mem.saveMessage('other', msg('别的会话', 1500));
    return opened.mem;
  }

  it('keep 列出的位置不归档，照原顺序留在活跃历史最前面；完整历史里留下的与归档的照原顺序交错；别的会话不动', async () => {
    const mem = await seeded(numbered(7));

    expect(await mem.archiveSpan('s', { count: 5, keep: [1, 3] })).toBe(3);
    expect(contents(await mem.getHistory('s'))).toEqual(['m1', 'm3', 'm5', 'm6']);
    expect(contents(await mem.getFullHistory!('s'))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(contents(await mem.getFullHistory!('other'))).toEqual(['别的会话']);
  });

  it('同毫秒的几条里留一条：按写入序数位置，留下的是写入序上的那一条', async () => {
    const mem = await seeded([msg('m0', 1000), ...['m1', 'm2', 'm3', 'm4'].map(c => msg(c, 2000)), msg('m5', 3000)]);

    expect(await mem.archiveSpan('s', { count: 5, keep: [2] })).toBe(4);
    expect(contents(await mem.getHistory('s'))).toEqual(['m2', 'm5']);
  });

  it('keep 为空时归档最早的 count 条（同毫秒按写入序，只数活跃的）；count 为 0 时什么都不归档', async () => {
    const mem = await seeded([msg('m0', 1000), msg('m1', 2000), msg('m2', 2000), msg('m3', 2000), msg('m4', 3000)]);

    expect(await mem.archiveSpan('s', { count: 0, keep: [] })).toBe(0);
    expect(contents(await mem.getHistory('s'))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(await mem.archiveSpan('s', { count: 3, keep: [] })).toBe(3);
    expect(contents(await mem.getHistory('s'))).toEqual(['m3', 'm4']);
    expect(await mem.archiveSpan('s', { count: 1, keep: [] })).toBe(1);
    expect(contents(await mem.getHistory('s'))).toEqual(['m4']);
    expect(contents(await mem.getFullHistory!('s'))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(contents(await mem.getHistory('other'))).toEqual(['别的会话']);
  });

  it('段外的下标不起作用；count 大于活跃条数时这一段是全部活跃消息；重复的下标与一个相同', async () => {
    const mem = await seeded(numbered(5));

    expect(await mem.archiveSpan('s', { count: 2, keep: [3] })).toBe(2);
    expect(contents(await mem.getHistory('s'))).toEqual(['m2', 'm3', 'm4']);
    expect(await mem.archiveSpan('s', { count: 9, keep: [1, 1] })).toBe(2);
    expect(contents(await mem.getHistory('s'))).toEqual(['m3']);
    expect(contents(await mem.getHistory('other'))).toEqual(['别的会话']);
  });

  it('下一次归档从新的活跃开头数：上一次留下的在最前面', async () => {
    const mem = await seeded(numbered(6));

    expect(await mem.archiveSpan('s', { count: 3, keep: [1] })).toBe(2);
    expect(await mem.archiveSpan('s', { count: 2, keep: [1] })).toBe(1);
    expect(contents(await mem.getHistory('s'))).toEqual(['m3', 'm4', 'm5']);
    expect(contents(await mem.getFullHistory!('s'))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('核对通过之后、归档之前又追加了一条（与段尾同一毫秒）：它在段外，不受影响', async () => {
    const mem = await seeded(numbered(3));
    // 压缩落定时先重读核对快照前缀、通过之后才归档，追加发生在两者之间
    await mem.saveMessage('s', msg('追加', 3000));

    expect(await mem.archiveSpan('s', { count: 3, keep: [1] })).toBe(2);
    expect(contents(await mem.getHistory('s'))).toEqual(['m1', '追加']);
  });

  it('countHistory 只数活跃的，归档后随之变，别的会话不算；没有事件标记时与 getHistory(…, Infinity) 的长度相同', async () => {
    const mem = await seeded(numbered(3));

    expect(await mem.countHistory?.('s')).toBe(3);
    await mem.archiveSpan('s', { count: 2, keep: [] });
    expect(await mem.countHistory?.('s')).toBe(1);
    expect((await mem.getHistory('s', Infinity)).length).toBe(1);
    expect([await mem.countHistory?.('other'), await mem.countHistory?.('none')]).toEqual([1, 0]);
  });
});

describe.each(BACKENDS)('%s：条数只数对话消息，事件标记不占条数', (_name, open) => {
  let stop: () => Promise<void> = async () => {};
  afterEach(() => stop());

  /** 事件标记：回合记录、压缩分隔线这一类（CONTROL_KINDS） */
  const mark = (content: string, timestamp: number): Message => ({
    role: 'system',
    kind: WellKnownKinds.EventMarker,
    content,
    timestamp,
  });

  /**
   * 对话消息 m0…m3，标记 k* 夹在开头、中间与末尾；k1、k1b 与 m1 同一毫秒，分别写在它之前与之后，k2、k3 同一毫秒。
   * 另一个会话一条
   */
  async function seeded(): Promise<MemoryService> {
    const opened = await open();
    stop = opened.stop;
    const messages = [
      mark('k0', 500),
      msg('m0', 1000),
      mark('k1', 2000),
      msg('m1', 2000),
      mark('k1b', 2000),
      msg('m2', 3000),
      mark('k2', 3500),
      mark('k3', 3500),
      msg('m3', 4000),
      mark('k4', 5000),
    ];
    for (const m of messages) await opened.mem.saveMessage('s', m);
    await opened.mem.saveMessage('other', msg('别的会话', 1500));
    return opened.mem;
  }

  it('countHistory 只数对话消息', async () => {
    const mem = await seeded();

    expect([await mem.countHistory?.('s'), await mem.countHistory?.('other')]).toEqual([4, 1]);
  });

  it('getHistory(…, limit)：第 limit+1 新的对话消息之后的全部活跃消息，夹在其间与之后的标记一并带回；同毫秒按写入序', async () => {
    const mem = await seeded();

    expect(contents(await mem.getHistory('s', 1))).toEqual(['k2', 'k3', 'm3', 'k4']);
    expect(contents(await mem.getHistory('s', 2))).toEqual(['k1b', 'm2', 'k2', 'k3', 'm3', 'k4']);
    expect(contents(await mem.getHistory('s', 3))).toEqual(['k1', 'm1', 'k1b', 'm2', 'k2', 'k3', 'm3', 'k4']);
  });

  it('对话消息不超过 limit 条时是全部活跃消息；limit 为 0 时为空', async () => {
    const mem = await seeded();
    const all = ['k0', 'm0', 'k1', 'm1', 'k1b', 'm2', 'k2', 'k3', 'm3', 'k4'];

    expect(contents(await mem.getHistory('s', 4))).toEqual(all);
    expect(contents(await mem.getHistory('s', Infinity))).toEqual(all);
    expect(await mem.getHistory('s', 0)).toEqual([]);
  });

  it('archiveSpan 按位置数，标记也占位置；归档之后两种读法只看活跃的', async () => {
    const mem = await seeded();

    expect(await mem.archiveSpan('s', { count: 3, keep: [] })).toBe(3);
    expect(await mem.countHistory?.('s')).toBe(3);
    expect(contents(await mem.getHistory('s', 3))).toEqual(['m1', 'k1b', 'm2', 'k2', 'k3', 'm3', 'k4']);
  });
});

describe.each(BACKENDS)('%s：带条数的读法，条数为 0 时返回空、为 Infinity 时返回全部', (_name, open) => {
  let stop: () => Promise<void> = async () => {};
  afterEach(() => stop());

  /** 一个空的后端，用完关掉 */
  async function fresh(opts?: Parameters<Open>[0]): Promise<MemoryService> {
    const opened = await open(opts);
    stop = opened.stop;
    return opened.mem;
  }

  /** 会话 s 五条、归档掉最早的两条；会话 other 一条 */
  async function seeded(): Promise<MemoryService> {
    const mem = await fresh();
    for (const m of numbered(5)) await mem.saveMessage('s', m);
    await mem.saveMessage('other', msg('别的会话', 1500));
    await mem.archiveSpan('s', { count: 2, keep: [] });
    return mem;
  }

  it('getHistory：Infinity 越过缺省的 50 条', async () => {
    const mem = await fresh();
    for (const m of numbered(120)) await mem.saveMessage('s', m);
    await mem.archiveSpan('s', { count: 10, keep: [] });

    expect(await mem.getHistory('s', 0)).toEqual([]);
    expect(contents(await mem.getHistory('s', Infinity))).toEqual(Array.from({ length: 110 }, (_, i) => `m${i + 10}`));
  });

  it('getFullHistory（含归档）', async () => {
    const mem = await seeded();

    expect(await mem.getFullHistory!('s', 0)).toEqual([]);
    expect(contents(await mem.getFullHistory!('s', Infinity))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('getRecentMessagesAcrossSessions（只看活跃的）', async () => {
    const mem = await seeded();

    expect(await mem.getRecentMessagesAcrossSessions!({ limit: 0 })).toEqual([]);
    const all = await mem.getRecentMessagesAcrossSessions!({ limit: Infinity });
    expect(all.map(r => [r.sessionId, r.message.content])).toEqual([
      ['other', '别的会话'],
      ['s', 'm2'],
      ['s', 'm3'],
      ['s', 'm4'],
    ]);
  });

  it('getRecentMessagesAcrossSessions：Infinity 收窄到后端配置的上限，取最近的几条', async () => {
    const mem = await fresh({ crossSessionMaxLimit: 2 });
    for (const m of numbered(3)) await mem.saveMessage('s', m);

    const recent = await mem.getRecentMessagesAcrossSessions!({ limit: Infinity });
    expect(recent.map(r => r.message.content)).toEqual(['m1', 'm2']);
  });

  it('updateMessageContent 的 recentLimit', async () => {
    const mem = await fresh();
    for (const m of numbered(3)) await mem.saveMessage('u', m);

    expect(await mem.updateMessageContent!('u', 'm', 'n', 0)).toBe(0);
    expect(contents(await mem.getHistory('u'))).toEqual(['m0', 'm1', 'm2']);
    expect(await mem.updateMessageContent!('u', 'm', 'n', Infinity)).toBe(3);
    expect(contents(await mem.getHistory('u'))).toEqual(['n0', 'n1', 'n2']);
  });

  it('updateMessageContent（含归档）：改最近 recentLimit 条含 oldText 的消息，不含的不占条数', async () => {
    const mem = await fresh();
    for (const m of [msg('旧0', 1000), msg('旧1', 2000), msg('无关2', 3000), msg('无关3', 4000), msg('旧4', 5000)]) {
      await mem.saveMessage('s', m);
    }
    await mem.archiveSpan('s', { count: 2, keep: [] });

    expect(await mem.updateMessageContent!('s', '旧', '新', 2)).toBe(2);
    expect(contents(await mem.getFullHistory!('s'))).toEqual(['旧0', '新1', '无关2', '无关3', '新4']);
  });

  it('updateMessageContent 按字面认 oldText：只是通配匹配或大小写不同的不算含，不占条数', async () => {
    const mem = await fresh();
    for (const m of [msg('img_A', 1000), msg('imgXA', 2000), msg('IMG_a', 3000)]) await mem.saveMessage('s', m);

    expect(await mem.updateMessageContent!('s', 'img_A', 'new', 1)).toBe(1);
    expect(contents(await mem.getHistory('s'))).toEqual(['new', 'imgXA', 'IMG_a']);
  });
});
