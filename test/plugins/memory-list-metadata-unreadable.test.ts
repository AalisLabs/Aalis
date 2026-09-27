import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MongoMemoryService } from '../../packages/plugin-memory-mongodb/src/index.js';
import { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// listMetadata 遇到读不出的条目（手改、损坏或外部写入）时逐条跳过并 warn 点名键，同一命名空间的其余条目照常返回；
// 此前一行坏数据就让整个命名空间读失败，会话表、关系图、画像等全量读取的消费方一起失效。
// 写入时间读不出的条目（sqlite 里手改成别的文本或 BLOB，mongodb 里缺失或不是日期）照常返回，updatedAt 记 0。
// sqlite 用内存库；mongodb 用替身集合直接构造服务，不经 apply、不连任何 mongod。
// ════════════════════════════════════════════════════════════

function recordingWarn() {
  const warns: string[] = [];
  return { warns, logger: { warn: (message: string) => void warns.push(message) } };
}

describe('listMetadata 跳过读不出的条目', () => {
  it('sqlite：data 不是 JSON 对象的行跳过并点名，其余照常返回', async () => {
    const db = new Database(':memory:');
    const { warns, logger } = recordingWarn();
    const svc = new SQLiteMemoryService(db, { logger });
    await svc.saveMetadata('sessions', 'good', { id: 'good' });
    const insert = db.prepare("INSERT INTO metadata (namespace, key, data) VALUES ('sessions', ?, ?)");
    insert.run('broken', '{not json');
    insert.run('null', 'null');
    insert.run('array', '[1,2]');

    const entries = await svc.listMetadata('sessions');

    expect(entries.map(e => [e.key, e.data])).toEqual([['good', { id: 'good' }]]);
    // 行序由 SQLite 决定（未排序），按内容比较
    expect(warns.toSorted()).toEqual([
      '元数据 sessions/array 不是 JSON 对象，已跳过',
      '元数据 sessions/broken 不是 JSON 对象，已跳过',
      '元数据 sessions/null 不是 JSON 对象，已跳过',
    ]);
  });

  it('sqlite：写入时间读不出（别的文本、BLOB）的行照常返回，updatedAt 为 0', async () => {
    const db = new Database(':memory:');
    const { warns, logger } = recordingWarn();
    const svc = new SQLiteMemoryService(db, { logger });
    for (const key of ['good', 'text', 'blob']) await svc.saveMetadata('sessions', key, { id: key });
    db.prepare("UPDATE metadata SET updatedAt = 'bogus' WHERE key = 'text'").run();
    db.prepare("UPDATE metadata SET updatedAt = x'00' WHERE key = 'blob'").run();

    const byKey = new Map((await svc.listMetadata('sessions')).map(e => [e.key, e]));

    expect(byKey.get('text')).toEqual({ key: 'text', data: { id: 'text' }, updatedAt: 0 });
    expect(byKey.get('blob')).toEqual({ key: 'blob', data: { id: 'blob' }, updatedAt: 0 });
    const good = byKey.get('good')?.updatedAt ?? 0;
    expect(Math.abs(good - Date.now()), '正常的写入时间照常读出').toBeLessThan(60_000);
    expect(warns).toEqual([]);
  });

  it('mongodb：data 不是对象的文档跳过并点名；缺写入时间的照常返回，updatedAt 为 0', async () => {
    const docs = [
      { namespace: 'sessions', key: 'no-time', data: { id: 'no-time' } },
      { namespace: 'sessions', key: 'null', data: null, updatedAt: new Date(3) },
      { namespace: 'sessions', key: 'array', data: [1, 2], updatedAt: new Date(4) },
      { namespace: 'sessions', key: 'good', data: { id: 'good' }, updatedAt: new Date(5) },
    ];
    const meta = { find: () => ({ toArray: async () => docs }) };
    const { warns, logger } = recordingWarn();
    type Ctor = ConstructorParameters<typeof MongoMemoryService>;
    const svc = new MongoMemoryService({} as Ctor[0], meta as unknown as Ctor[1], { logger });

    expect(await svc.listMetadata('sessions')).toEqual([
      { key: 'no-time', data: { id: 'no-time' }, updatedAt: 0 },
      { key: 'good', data: { id: 'good' }, updatedAt: 5 },
    ]);
    expect(warns).toEqual([
      '元数据 sessions/null 的 data 不是对象，已跳过',
      '元数据 sessions/array 的 data 不是对象，已跳过',
    ]);
  });
});

// listMetadataKeys 只列键、不读 data：读不出的条目也在其中，按命名空间整体清理（clearMetadataNamespaces）靠它把坏条目一并删掉
describe('listMetadataKeys 连读不出的条目一并列出', () => {
  it('sqlite：只列本命名空间的键，data 不是 JSON 对象的行也列出，不记 warn', async () => {
    const db = new Database(':memory:');
    const { warns, logger } = recordingWarn();
    const svc = new SQLiteMemoryService(db, { logger });
    await svc.saveMetadata('sessions', 'good', { id: 'good' });
    await svc.saveMetadata('other', 'elsewhere', { id: 'elsewhere' });
    const insert = db.prepare("INSERT INTO metadata (namespace, key, data) VALUES ('sessions', ?, ?)");
    insert.run('broken', '{not json');
    insert.run('array', '[1,2]');

    expect((await svc.listMetadataKeys('sessions')).toSorted()).toEqual(['array', 'broken', 'good']);
    expect(await svc.listMetadataKeys('none')).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('mongodb：按命名空间查、只投影 key，data 不是对象的文档也列出', async () => {
    const docs = [{ key: 'null' }, { key: 'good' }];
    const calls: unknown[] = [];
    const meta = {
      find: (filter: unknown) => {
        calls.push(['find', filter]);
        return {
          project: (projection: unknown) => {
            calls.push(['project', projection]);
            return { toArray: async () => docs };
          },
        };
      },
    };
    const { warns, logger } = recordingWarn();
    type Ctor = ConstructorParameters<typeof MongoMemoryService>;
    const svc = new MongoMemoryService({} as Ctor[0], meta as unknown as Ctor[1], { logger });

    expect(await svc.listMetadataKeys('sessions')).toEqual(['null', 'good']);
    expect(calls).toEqual([
      ['find', { namespace: 'sessions' }],
      ['project', { _id: 0, key: 1 }],
    ]);
    expect(warns).toEqual([]);
  });
});
