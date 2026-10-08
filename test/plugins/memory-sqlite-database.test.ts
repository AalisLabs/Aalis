import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MetadataOp, memory } from '../../packages/api-memory/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import memorySqlite, { SQLiteMemoryService } from '../../packages/plugin-memory-sqlite/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 数据库用 Node 自带的 node:sqlite。
// - 旧库照常可用：fixtures/memory-sqlite/legacy.db 由改用 node:sqlite 之前的实现经插件本身写下（WAL 模式，关库时已并回
//   主文件）：两个会话共 7 条消息，其中 2 条已归档；sessions、user:profile、summary 三个命名空间。复制到临时目录后经插件
//   开库：全部读出、能接着写，关库重开后新旧数据都在；计数与时间戳照旧是 number。
// - 插件开的连接：WAL 日志模式、NORMAL 同步级别、遇锁最多等 5 秒。
// - 批量写在一个事务里：中途抛错整批回滚；SQLite 已自行撤销事务（如库满）时报出原错误；之后连接照常可写。
// 测试里直接开库用 process.getBuiltinModule 取 node:sqlite：vitest 解析不了静态的 `import 'node:sqlite'`。
// ════════════════════════════════════════════════════════════

const sqlite = process.getBuiltinModule('node:sqlite');
const FIXTURE = join(import.meta.dirname, '../fixtures/memory-sqlite/legacy.db');
/** 夹具里元数据的写入时间（库里存的是无时区后缀的 UTC 文本） */
const LEGACY_UPDATED_AT = Date.parse('2026-10-08T15:32:10.540Z');

const ALPHA: Message[] = [
  { role: 'user', content: '问题一', timestamp: 1000, metadata: { platform: 'webui', senderId: 'user-a' } },
  {
    role: 'assistant',
    content: null,
    reasoningContent: '思考一',
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{"text":"占位"}' } }],
    segments: [
      { type: 'reasoning_text', content: '思考一' },
      { type: 'tool_call', name: 'echo', args: { text: '占位' }, callId: 'call-1' },
    ],
    timestamp: 2000,
  },
  { role: 'tool', content: '占位', toolCallId: 'call-1', name: 'echo', timestamp: 2000 },
  { role: 'assistant', content: '回答一', segments: [{ type: 'text', content: '回答一' }], timestamp: 3000 },
];
const BETA_ARCHIVED: Message[] = [
  { role: 'user', content: '问题二', timestamp: 1500, metadata: { platform: 'onebot' } },
  { role: 'notice', kind: 'poke', content: '戳了一下', timestamp: 1600 },
];
const BETA_ACTIVE: Message = { role: 'system', kind: 'event-marker', content: '分隔', timestamp: 2500 };

let dir: string;
const apps: App[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-memory-sqlite-database-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** 经插件开临时目录下的 aalis.db */
async function activate(): Promise<{ app: App; mem: SQLiteMemoryService }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  const roots = [{ name: 'data', readable: true, writable: true, deletable: true }] as unknown as StorageRootInfo[];
  app.bind({ provide }).provide(storage, {
    listRoots: () => roots,
    resolveLocalPath: async () => join(dir, 'aalis.db'),
  } as unknown as StorageService);
  await app.plugins.register(memorySqlite, {});
  await app.plugins.idle();
  const mem = app.bind({ services }).services.get(memory);
  expect(mem).toBeInstanceOf(SQLiteMemoryService);
  return { app, mem: mem as SQLiteMemoryService };
}

/** 记下插件开的连接：插件经 process.getBuiltinModule 取 node:sqlite，这里换上会登记实例的子类 */
function recordConnections(): DatabaseSync[] {
  const opened: DatabaseSync[] = [];
  class Recording extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      super(...args);
      opened.push(this);
    }
  }
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
    id === 'node:sqlite' ? { ...sqlite, DatabaseSync: Recording } : getBuiltinModule(id)) as typeof getBuiltinModule);
  return opened;
}

describe('plugin-memory-sqlite 开库', () => {
  it('插件开的连接：WAL 日志模式、NORMAL 同步级别、遇锁最多等 5 秒', async () => {
    const opened = recordConnections();
    await activate();

    expect(opened).toHaveLength(1);
    const pragma = (name: string) => opened[0]?.prepare(`PRAGMA ${name}`).get();
    expect([pragma('journal_mode'), pragma('synchronous'), pragma('busy_timeout')]).toEqual([
      { journal_mode: 'wal' },
      { synchronous: 1 },
      { timeout: 5000 },
    ]);
  });
});

describe('plugin-memory-sqlite 旧库照常可用', () => {
  beforeEach(() => copyFileSync(FIXTURE, join(dir, 'aalis.db')));

  it('消息（含已归档的）与元数据全部读出', async () => {
    const { mem } = await activate();

    expect(await mem.getFullHistory('s-alpha')).toEqual(ALPHA);
    expect(await mem.getHistory('s-alpha')).toEqual(ALPHA);
    expect(await mem.getFullHistory('s-beta')).toEqual([...BETA_ARCHIVED, BETA_ACTIVE]);
    expect(await mem.getHistory('s-beta'), '已归档的不进历史').toEqual([BETA_ACTIVE]);
    expect(await mem.listMetadata('sessions')).toEqual([
      { key: 's-alpha', data: { title: '会话甲' }, updatedAt: LEGACY_UPDATED_AT },
      { key: 's-beta', data: { title: '会话乙' }, updatedAt: LEGACY_UPDATED_AT },
    ]);
    expect(await mem.listMetadata('user:profile')).toEqual([
      { key: 'webui:user-a', data: { facts: ['占位事实'] }, updatedAt: LEGACY_UPDATED_AT },
    ]);
    expect(await mem.listMetadata('summary')).toEqual([
      { key: 's-alpha', data: { text: '摘要占位' }, updatedAt: LEGACY_UPDATED_AT },
    ]);
  });

  it('能接着写：增删改归档都生效，计数是 number，关库重开后新旧数据都在', async () => {
    const first = await activate();
    const added: Message = { role: 'user', content: '问题三', timestamp: 4000 };
    await first.mem.saveMessage('s-alpha', added);
    expect(await first.mem.updateMessageContent('s-alpha', '回答一', '回答一（改）')).toBe(1);
    expect(await first.mem.trimHistory('s-alpha', 2)).toBe(3);
    expect(await first.mem.deleteMessagesByTimestamps('s-beta', [1500, 1600])).toBe(2);
    await first.mem.saveMetadata('sessions', 's-gamma', { title: '会话丙' });
    await first.mem.commitMetadata([{ op: 'del', namespace: 'summary', key: 's-alpha' }]);
    await first.app.stop();

    const { mem } = await activate();
    const edited = { ...ALPHA[3], content: '回答一（改）' };
    expect(await mem.getFullHistory('s-alpha')).toEqual([...ALPHA.slice(0, 3), edited, added]);
    expect(await mem.getHistory('s-alpha')).toEqual([edited, added]);
    expect(await mem.getFullHistory('s-beta')).toEqual([BETA_ACTIVE]);
    expect((await mem.listMetadata('sessions')).map(e => [e.key, e.data])).toEqual([
      ['s-alpha', { title: '会话甲' }],
      ['s-beta', { title: '会话乙' }],
      ['s-gamma', { title: '会话丙' }],
    ]);
    expect(await mem.listMetadata('summary')).toEqual([]);
  });
});

describe('SQLiteMemoryService 写入', () => {
  function service() {
    const db = new sqlite.DatabaseSync(':memory:');
    const svc = new SQLiteMemoryService(db, { logger: { warn() {} } });
    const keys = () =>
      (db.prepare('SELECT key FROM metadata ORDER BY key').all() as Array<{ key: string }>).map(row => row.key);
    return { db, svc, keys };
  }

  it('批量写中途抛错：整批回滚，之后照常可写', async () => {
    const { svc, keys } = service();
    await svc.saveMetadata('ns', 'keep', { v: 1 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      svc.commitMetadata([
        { op: 'put', namespace: 'ns', key: 'new', data: { v: 2 } },
        { op: 'del', namespace: 'ns', key: 'keep' },
        { op: 'put', namespace: 'ns', key: 'bad', data: circular },
      ]),
    ).rejects.toThrow(/circular/);
    expect(keys()).toEqual(['keep']);
    expect(await svc.getMetadata('ns', 'keep')).toEqual({ v: 1 });

    await svc.commitMetadata([{ op: 'put', namespace: 'ns', key: 'after', data: { v: 3 } }]);
    expect(keys()).toEqual(['after', 'keep']);
  });

  it('SQLite 已自行撤销事务（库满）：报出原错误，数据不变，之后照常可写', async () => {
    const { db, svc, keys } = service();
    await svc.saveMetadata('ns', 'keep', { v: 1 });
    const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number };
    db.exec(`PRAGMA max_page_count = ${page_count}`);
    const big = 'x'.repeat(8192);
    const ops: MetadataOp[] = ['a', 'b'].map(key => ({ op: 'put', namespace: 'ns', key, data: { big } }));

    await expect(svc.commitMetadata(ops)).rejects.toThrow('database or disk is full');
    expect(keys()).toEqual(['keep']);

    db.exec('PRAGMA max_page_count = 1000000');
    await svc.commitMetadata([{ op: 'put', namespace: 'ns', key: 'after', data: { v: 3 } }]);
    expect(keys()).toEqual(['after', 'keep']);
  });

  it('按时间戳删消息跨多批：一并删掉并返回总条数，别的会话不动', async () => {
    const { svc } = service();
    const timestamps = Array.from({ length: 1200 }, (_, i) => i + 1);
    for (const timestamp of timestamps) await svc.saveMessage('s-a', { role: 'user', content: '占位', timestamp });
    for (const timestamp of [1, 2]) await svc.saveMessage('s-b', { role: 'user', content: '占位', timestamp });

    expect(await svc.deleteMessagesByTimestamps('s-a', [...timestamps, 5000])).toBe(1200);
    expect(await svc.getFullHistory('s-a')).toEqual([]);
    expect(await svc.getFullHistory('s-b')).toHaveLength(2);
  });

  it('按时间戳删消息在第二批出错：第一批已删的整体回滚', async () => {
    const { svc } = service();
    const timestamps = Array.from({ length: 600 }, (_, i) => i + 1);
    for (const timestamp of timestamps) await svc.saveMessage('s-a', { role: 'user', content: '占位', timestamp });
    const broken = timestamps.with(549, undefined as unknown as number);

    await expect(svc.deleteMessagesByTimestamps('s-a', broken)).rejects.toThrow('cannot be bound');
    expect(await svc.getFullHistory('s-a', 1000)).toHaveLength(600);
  });

  it('content 缺失的消息按 null 存：上游没给 content 时照常落库', async () => {
    const { svc } = service();
    const toolCalls = [{ id: 'call-1', type: 'function' as const, function: { name: 'echo', arguments: '{}' } }];
    await svc.saveMessage('s-a', { role: 'assistant', toolCalls, timestamp: 1 } as unknown as Message);

    expect(await svc.getHistory('s-a')).toEqual([{ role: 'assistant', content: null, toolCalls, timestamp: 1 }]);
  });
});
