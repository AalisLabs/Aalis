import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { MongoMemoryService } from '../../packages/plugin-memory-mongodb/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// clearAll 只清消息（含归档），不碰元数据。
//
// 元数据的各命名空间分属不同的清理类型：会话表、用户档案、关系图、第三方绑定都不属于消息历史。
// 后端分不出哪个命名空间属于哪一层，此前 clearAll 连元数据一起删，`/clear all -t context`
// 就连带清掉了用户没选的档案、关系图与绑定。改后各命名空间由归属插件经 memory:clear 自行清理。
// ════════════════════════════════════════════════════════════

const msg = (content: string, timestamp: number) => ({ role: 'user' as const, content, timestamp });

/** 两个会话各三条消息，s1 归档掉较早的两条；两个命名空间各一条元数据 */
async function seed(mem: MemoryService): Promise<void> {
  for (const s of ['s1', 's2']) {
    for (let i = 0; i < 3; i++) await mem.saveMessage(s, msg(`${s}-${i}`, 1000 + i));
  }
  await mem.trimHistory!('s1', 1);
  await mem.saveMetadata('user:profile', 'onebot:u1', { facts: ['喜欢猫'] });
  await mem.saveMetadata('sessions', 's1', { name: '会话一' });
}

async function expectMessagesGoneMetadataKept(mem: MemoryService): Promise<void> {
  await mem.clearAll!();
  for (const s of ['s1', 's2']) {
    expect(await mem.getHistory(s), `${s} 活跃消息`).toEqual([]);
    expect(await mem.getFullHistory!(s), `${s} 含归档`).toEqual([]);
  }
  expect(await mem.getMetadata('user:profile', 'onebot:u1')).toEqual({ facts: ['喜欢猫'] });
  expect(await mem.getMetadata('sessions', 's1')).toEqual({ name: '会话一' });
}

describe('clearAll 只清消息与归档', () => {
  it('sqlite', async () => {
    const mem = new SQLiteMemoryService(new Database(':memory:'), { logger: { warn() {} } });
    await seed(mem);
    expect(await mem.getFullHistory('s1')).toHaveLength(3);
    await expectMessagesGoneMetadataKept(mem);
  });

  it('inmemory', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await app.plugin(memoryInMemory);
    await app.plugins.idle();
    const mem = app.bind({ services }).services.get(memory);
    if (!mem) throw new Error('memory 服务未就绪');
    await seed(mem);
    expect(await mem.getFullHistory!('s1')).toHaveLength(3);
    await expectMessagesGoneMetadataKept(mem);
    await app.stop();
  });

  it('mongodb：只对消息集合 deleteMany，元数据集合不动', async () => {
    // 集合用替身，不经 apply（apply 会直连真实的 mongod）
    const calls: string[] = [];
    const recorder = (name: string) =>
      new Proxy(
        {},
        {
          get:
            (_t, method) =>
            async (...args: unknown[]) => {
              calls.push(`${name}.${String(method)}(${JSON.stringify(args)})`);
              return { acknowledged: true, deletedCount: 0 };
            },
        },
      );
    type Ctor = ConstructorParameters<typeof MongoMemoryService>;
    const mem = new MongoMemoryService(recorder('messages') as Ctor[0], recorder('meta') as Ctor[1], {
      logger: { warn() {} },
    });
    await mem.clearAll();
    expect(calls).toEqual(['messages.deleteMany([{}])']);
  });
});
