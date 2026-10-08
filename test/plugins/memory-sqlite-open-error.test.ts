import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@aalis/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memorySqlite from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// 开库失败。取不到 process.getBuiltinModule 或 node:sqlite，或 node:sqlite 缺本插件要用的接口（22.16 之前、23.x）时，
// 都按 Node 太旧报错：写明需要 Node 24.15.0 起并指向升级方法；其余失败带出原因，原错误作 cause。
// ════════════════════════════════════════════════════════════

const TOO_OLD =
  `SQLite 打开失败: 当前 Node（${process.version}）版本过低，需要 Node 24.15.0 起；` +
  '升级方法见 docs/guide/first-run.md「升级 Node」';

let dir: string;
const apps: App[] = [];
const getBuiltinModule = process.getBuiltinModule;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-memory-sqlite-open-error-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.getBuiltinModule = getBuiltinModule;
  for (const app of apps.splice(0)) await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

function fakeStorage(path: string, resolveError?: Error): StorageService {
  const roots = [{ name: 'data', readable: true, writable: true, deletable: true }] as unknown as StorageRootInfo[];
  return {
    listRoots: () => roots,
    resolveLocalPath: async () => {
      if (resolveError) throw resolveError;
      return path;
    },
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

async function activate(path = join(dir, 'aalis.db'), resolveError?: Error) {
  const logger = recordingLogger();
  const app = new App({ name: 'T', logger });
  apps.push(app);
  app.bind({ provide }).provide(storage, fakeStorage(path, resolveError));
  await app.plugins.register(memorySqlite, {});
  await app.plugins.idle();
  const entry = app.plugins.getStatus().find(p => p.name === '@aalis/plugin-memory-sqlite');
  const thrown = logger.errors.flat().find((a): a is Error => a instanceof Error);
  return { entry, thrown };
}

describe('plugin-memory-sqlite 开库失败', () => {
  it('Node 太旧、没有 node:sqlite 模块：说明需要的 Node 版本与升级方法', async () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    const { entry } = await activate();

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe(TOO_OLD);
  });

  it('Node 太旧、连 process.getBuiltinModule 都没有：同样说明需要的 Node 版本与升级方法', async () => {
    process.getBuiltinModule = undefined as never;
    const { entry } = await activate();

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe(TOO_OLD);
  });

  it('node:sqlite 缺本插件要用的接口（连接上没有 isTransaction）：同样说明，并关掉刚开的连接', async () => {
    const opened: Array<{ closed: boolean }> = [];
    class WithoutIsTransaction {
      closed = false;
      constructor() {
        opened.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue({ DatabaseSync: WithoutIsTransaction } as never);
    const { entry } = await activate();

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe(TOO_OLD);
    expect(opened).toEqual([{ closed: true }]);
  });

  it('数据库路径解析失败：消息点名 URI 与原因，原错误作 cause', async () => {
    const original = new Error('根 data 不可写');
    const { entry, thrown } = await activate(undefined, original);

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe('无法解析数据库路径 data:/aalis.db: 根 data 不可写');
    expect(thrown?.cause).toBe(original);
  });

  it('其它开库错误带出原因，原错误作 cause', async () => {
    const { entry, thrown } = await activate(join(dir, 'missing', 'aalis.db'));

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe('SQLite 打开失败: unable to open database file');
    expect((thrown?.cause as NodeJS.ErrnoException | undefined)?.code).toBe('ERR_SQLITE_ERROR');
  });
});
