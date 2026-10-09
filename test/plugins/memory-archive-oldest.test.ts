import { afterEach, describe, expect, it } from 'vitest';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { MongoMemoryService } from '../../packages/plugin-memory-mongodb/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 三家后端同一组用例：
// - archiveOldest(n) 把最早的 n 条活跃消息标为归档，顺序与 getHistory 相同（时间，同毫秒按写入序），返回归档条数；
//   只数活跃的，n 为 0 时什么都不归档，n 大于活跃条数时归档全部；归档的消息完整历史里照样有，别的会话不动。
// - getHistory(…, Infinity) 返回全部活跃消息。
//
// mongodb 的集合用内存替身，不经 apply（apply 会直连真实的 mongod）。替身照服务端的规矩：limit(0) 表示不限条数、
// limit 不是整数时报错；排序键全部平票时按写入的逆序排——这是对抗方向：archiveOldest 的排序去掉 _id 次键，
// 同毫秒里后写的那条就会先被归档。
// ════════════════════════════════════════════════════════════

const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

type Doc = Record<string, unknown> & { _id: number };

function fakeCollection() {
  const docs: Doc[] = [];
  return {
    insertOne: async (doc: Record<string, unknown>) => {
      docs.push({ ...doc, _id: docs.length + 1 });
      return { acknowledged: true };
    },
    find: (filter: { sessionId: string; archived?: unknown }) => {
      let rows = docs.filter(d => d.sessionId === filter.sessionId && !(filter.archived && d.archived === true));
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
        project: () => cursor,
        toArray: async () => rows,
      };
      return cursor;
    },
    updateMany: async (filter: { _id: { $in: number[] } }, update: { $set: Record<string, unknown> }) => {
      const hit = docs.filter(d => filter._id.$in.includes(d._id));
      for (const d of hit) Object.assign(d, update.$set);
      return { modifiedCount: hit.length };
    },
  };
}

const BACKENDS: Array<[string, () => Promise<{ mem: MemoryService; stop: () => Promise<void> }>]> = [
  [
    'inmemory',
    async () => {
      const app = new App({ name: 'T', logLevel: 'error' });
      await app.plugin(memoryInMemory);
      await app.plugins.idle();
      const mem = app.bind({ services }).services.get(memory);
      if (!mem) throw new Error('memory 服务未就绪');
      return { mem, stop: () => app.stop() };
    },
  ],
  [
    'sqlite',
    async () => ({
      mem: new SQLiteMemoryService(new DatabaseSync(':memory:'), { logger: { warn() {} } }),
      stop: async () => {},
    }),
  ],
  [
    'mongodb',
    async () => {
      type Ctor = ConstructorParameters<typeof MongoMemoryService>;
      const mem = new MongoMemoryService(fakeCollection() as unknown as Ctor[0], {} as Ctor[1], {
        logger: { warn() {} },
      });
      return { mem, stop: async () => {} };
    },
  ],
];

const msg = (content: string, timestamp: number): Message => ({ role: 'user', content, timestamp });
const contents = (messages: Message[]) => messages.map(m => m.content);

describe.each(BACKENDS)('%s：archiveOldest 与读全部活跃消息', (_name, open) => {
  let stop: () => Promise<void> = async () => {};
  afterEach(() => stop());

  async function seeded(messages: Message[]): Promise<MemoryService> {
    const opened = await open();
    stop = opened.stop;
    for (const m of messages) await opened.mem.saveMessage('s', m);
    await opened.mem.saveMessage('other', msg('别的会话', 1500));
    return opened.mem;
  }

  it('归档最早的 n 条，同毫秒按写入序；只数活跃的；完整历史里照样有，别的会话不动', async () => {
    const mem = await seeded([msg('m0', 1000), msg('m1', 2000), msg('m2', 2000), msg('m3', 2000), msg('m4', 3000)]);

    expect(await mem.archiveOldest('s', 3)).toBe(3);
    expect(contents(await mem.getHistory('s'))).toEqual(['m3', 'm4']);
    expect(await mem.archiveOldest('s', 1)).toBe(1);
    expect(contents(await mem.getHistory('s'))).toEqual(['m4']);
    expect(contents(await mem.getFullHistory!('s'))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(contents(await mem.getHistory('other'))).toEqual(['别的会话']);
  });

  it('n 为 0 时什么都不归档；n 大于活跃条数时归档全部', async () => {
    const mem = await seeded([msg('m0', 1000), msg('m1', 2000), msg('m2', 3000)]);

    expect(await mem.archiveOldest('s', 0)).toBe(0);
    expect(contents(await mem.getHistory('s'))).toEqual(['m0', 'm1', 'm2']);
    expect(await mem.archiveOldest('s', 5)).toBe(3);
    expect(await mem.getHistory('s')).toEqual([]);
    expect(contents(await mem.getFullHistory!('s'))).toEqual(['m0', 'm1', 'm2']);
    expect(contents(await mem.getHistory('other'))).toEqual(['别的会话']);
  });

  it('getHistory 的 limit 为 Infinity 时返回全部活跃消息', async () => {
    const mem = await seeded(Array.from({ length: 120 }, (_, i) => msg(`m${i}`, 1000 + i)));
    await mem.archiveOldest('s', 10);

    expect(contents(await mem.getHistory('s', Infinity))).toEqual(Array.from({ length: 110 }, (_, i) => `m${i + 10}`));
  });
});
