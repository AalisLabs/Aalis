import { existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memorySqlite from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// 多实例的数据库位置：path 留空时按实例派生（主实例 data:/aalis.db，`:b` 实例 data:/aalis-b.db）。两个实例打开的是
// 同一个文件时（按设备号 + inode 认：同一路径、大小写不敏感卷上只差大小写的路径、硬链接），后激活的那个以配置错误失败
// （一行、不带 stack），消息点名占用它的实例，路径写法不同时带上占用者打开的路径；刚开的库立即关掉，不设 WAL、不建表。
// 占用者关闭后让出。文件系统不提供 inode（ino 为 0）时退回按路径认。开库之后任何一步失败（取文件身份、设 WAL、
// 建表），都先关掉刚开的库再以激活失败报出。
// better-sqlite3 换成替身：构造时在真实临时目录里建出空文件（文件身份要靠它），并记下开库、关库、设 WAL 与建表。
// ════════════════════════════════════════════════════════════

const NAME = '@aalis/plugin-memory-sqlite';

const native = vi.hoisted(() => ({
  opened: [] as string[],
  closed: [] as string[],
  wal: [] as string[],
  tables: [] as string[],
  /** 模拟不提供 inode 的文件系统 */
  zeroIno: false,
  /** 让取文件身份、设 WAL、建表各自抛出的错误 */
  fail: {} as { stat?: Error; pragma?: Error; exec?: Error },
}));
vi.mock('better-sqlite3', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    default: class {
      constructor(private readonly path: string) {
        fs.writeFileSync(path, '', { flag: 'a' });
        native.opened.push(path);
      }
      pragma() {
        if (native.fail.pragma) throw native.fail.pragma;
        native.wal.push(this.path);
      }
      exec() {
        if (native.fail.exec) throw native.fail.exec;
        native.tables.push(this.path);
      }
      close() {
        native.closed.push(this.path);
      }
    },
  };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: ((...args: Parameters<typeof actual.statSync>) => {
      if (native.fail.stat) throw native.fail.stat;
      const stats = actual.statSync(...args);
      return native.zeroIno ? { ...stats, ino: 0n } : stats;
    }) as typeof actual.statSync,
  };
});

/** 临时目录所在的卷是否大小写不敏感（macOS 默认的 APFS 是，Linux 的 ext4 不是） */
const caseInsensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'zz-memory-sqlite-case-'));
  try {
    writeFileSync(join(probe, 'probe'), '');
    return existsSync(join(probe, 'PROBE'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let dir: string;

function fakeStorage(): StorageService {
  const roots = [{ name: 'data', readable: true, writable: true, deletable: true }] as unknown as StorageRootInfo[];
  return {
    listRoots: () => roots,
    resolveLocalPath: async (uri: string) => join(dir, uri.slice('data:/'.length)),
  } as unknown as StorageService;
}

function recordingLogger(): Logger & { errors: unknown[][] } {
  const errors: unknown[][] = [];
  const noop = () => {};
  const logger = {
    errors,
    debug: noop,
    info: noop,
    warn: noop,
    error: (...args: unknown[]) => void errors.push(args),
    child: () => logger,
  };
  return logger as unknown as Logger & { errors: unknown[][] };
}

const apps: App[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-memory-sqlite-instances-'));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  for (const list of [native.opened, native.closed, native.wal, native.tables]) list.length = 0;
  native.zeroIno = false;
  native.fail = {};
  rmSync(dir, { recursive: true, force: true });
});

async function start(instances: Array<[string, Record<string, unknown>]>) {
  const logger = recordingLogger();
  const app = new App({ name: 'T', logger });
  apps.push(app);
  app.bind({ provide }).provide(storage, fakeStorage());
  const register = async (id: string, config: Record<string, unknown>) => {
    await app.plugins.register(memorySqlite, config, id);
    await app.plugins.idle();
  };
  for (const [id, config] of instances) await register(id, config);
  const state = (id: string) => app.plugins.getStatus().find(p => p.instanceId === id);
  return { app, logger, state, register };
}

const clash = (path: string, holder: string, id: string, via = '') =>
  `数据库文件 ${path} 已被实例 ${holder} 使用${via}，两个实例不能共用一个库：请给 ${id} 另配 path`;

describe('plugin-memory-sqlite 多实例的数据库位置', () => {
  it('显式坏 path 拒绝激活，不用默认文件开库；缺省 path 仍按实例派生', async () => {
    const { state } = await start([
      [NAME, { path: false }],
      [`${NAME}:b`, {}],
    ]);
    expect(state(NAME)?.state).toBe('error');
    expect(state(NAME)?.error).toContain('path');
    expect(state(`${NAME}:b`)?.state).toBe('active');
    expect(native.opened).toEqual([join(dir, 'aalis-b.db')]);
  });

  it('path 留空按实例派生：主实例用原默认文件，带后缀的实例在文件名上加后缀；写明的 path 照用', async () => {
    const { state } = await start([
      [NAME, { path: '' }],
      [`${NAME}:b`, { path: '' }],
      [`${NAME}:c`, { path: 'data/custom.db' }],
    ]);

    expect([NAME, `${NAME}:b`, `${NAME}:c`].map(id => state(id)?.state)).toEqual(['active', 'active', 'active']);
    expect(native.opened).toEqual([join(dir, 'aalis.db'), join(dir, 'aalis-b.db'), join(dir, 'custom.db')]);
  });

  it('两个实例解析到同一个文件：后激活的以一行配置错误失败并点名占用者，占用者关闭后可重试成功', async () => {
    const { app, logger, state } = await start([
      [NAME, {}],
      [`${NAME}:c`, { path: 'data:/aalis.db' }],
    ]);
    const db = join(dir, 'aalis.db');

    expect(state(NAME)?.state).toBe('active');
    expect(state(`${NAME}:c`)?.state).toBe('error');
    expect(state(`${NAME}:c`)?.error).toBe(clash(db, NAME, `${NAME}:c`));
    const thrown = logger.errors.flat().find((a): a is Error => a instanceof Error);
    expect(thrown?.name).toBe('ConfigError');
    expect(thrown?.stack).toBeUndefined();
    expect(native.opened).toEqual([db, db]);
    expect(native.closed, '撞库的实例开库后立即关掉').toEqual([db]);
    expect([native.wal, native.tables], '撞库的实例不设 WAL、不建表').toEqual([[db], [db]]);

    await app.plugins.unload(NAME);
    await app.plugins.bounce(`${NAME}:c`);
    await app.plugins.idle();
    expect(state(`${NAME}:c`)?.state).toBe('active');
    expect(native.opened).toEqual([db, db, db]);
  });

  it('硬链接指向占用者的库：按同一个文件拒绝，消息带上占用者打开的路径', async () => {
    const { state, register } = await start([[NAME, {}]]);
    const db = join(dir, 'aalis.db');
    const alias = join(dir, 'alias.db');
    linkSync(db, alias);

    await register(`${NAME}:ln`, { path: 'data/alias.db' });

    expect(state(`${NAME}:ln`)?.state).toBe('error');
    expect(state(`${NAME}:ln`)?.error).toBe(clash(alias, NAME, `${NAME}:ln`, `（经路径 ${db} 打开）`));
    expect(native.closed).toEqual([alias]);
  });

  it.skipIf(!caseInsensitive)('大小写不敏感的卷上只差大小写的路径：按同一个文件拒绝', async () => {
    const { state } = await start([
      [NAME, {}],
      [`${NAME}:ci`, { path: 'data/AALIS.db' }],
    ]);

    expect(state(NAME)?.state).toBe('active');
    expect(state(`${NAME}:ci`)?.state).toBe('error');
    expect(state(`${NAME}:ci`)?.error).toBe(
      clash(join(dir, 'AALIS.db'), NAME, `${NAME}:ci`, `（经路径 ${join(dir, 'aalis.db')} 打开）`),
    );
  });

  it('文件系统不提供 inode 时按路径认：不同文件互不影响，同一路径仍拒绝', async () => {
    native.zeroIno = true;
    const { state } = await start([
      [NAME, {}],
      [`${NAME}:b`, {}],
      [`${NAME}:c`, { path: 'data:/aalis.db' }],
    ]);

    expect([NAME, `${NAME}:b`, `${NAME}:c`].map(id => state(id)?.state)).toEqual(['active', 'active', 'error']);
    expect(state(`${NAME}:c`)?.error).toBe(clash(join(dir, 'aalis.db'), NAME, `${NAME}:c`));
  });

  it('实例自己重启（改配置）不算撞库', async () => {
    const { app, state } = await start([[NAME, {}]]);
    await app.plugins.updateConfig(NAME, { path: '', rangeQueryLimit: 100 });
    await app.plugins.idle();
    expect(state(NAME)?.state).toBe('active');
    expect(native.opened).toEqual([join(dir, 'aalis.db'), join(dir, 'aalis.db')]);
  });
});

describe('plugin-memory-sqlite 开库之后的失败', () => {
  it.each([
    ['取文件身份失败', { stat: new Error('ENOENT: no such file or directory') }, 'ENOENT: no such file or directory'],
    ['设 WAL 失败', { pragma: new Error('file is not a database') }, 'SQLite 打开失败: file is not a database'],
    ['建表失败', { exec: new Error('disk I/O error') }, 'SQLite 打开失败: disk I/O error'],
  ])('%s：先关掉刚开的库，再以激活失败报出', async (_step, fail, message) => {
    native.fail = fail;
    const { state } = await start([[NAME, {}]]);

    expect(state(NAME)?.state).toBe('error');
    expect(state(NAME)?.error).toBe(message);
    expect(native.closed).toEqual([join(dir, 'aalis.db')]);
  });
});
