import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memorySqlite from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// better-sqlite3 在构造 Database 时才加载原生绑定，加载失败报 ERR_DLOPEN_FAILED。原文含
// NODE_MODULE_VERSION 的是换了 Node 大版本（ABI 不符），插件改抛中文指引并附原文首行；
// 架构不符等其它加载失败不给这条指引，照录原文。原错误都留在 cause 里。
// 原生加载失败无法在测试里真实触发，这里替换 better-sqlite3，让构造函数抛出指定错误。
// ════════════════════════════════════════════════════════════

const native = vi.hoisted(() => ({ openError: new Error('未设置') as Error }));
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() {
      throw native.openError;
    }
  },
}));

function fakeStorage(resolveError?: Error): StorageService {
  const roots = [{ name: 'data', readable: true, writable: true, deletable: true }] as unknown as StorageRootInfo[];
  return {
    listRoots: () => roots,
    resolveLocalPath: async () => {
      if (resolveError) throw resolveError;
      return '/zz-memory-sqlite-test/aalis.db';
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

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
});

async function activateWith(openError: Error, resolveError?: Error) {
  native.openError = openError;
  const logger = recordingLogger();
  const app = new App({ name: 'T', logger });
  apps.push(app);
  app.bind({ provide }).provide(storage, fakeStorage(resolveError));
  await app.plugins.register(memorySqlite, {});
  await app.plugins.idle();
  const entry = app.plugins.getStatus().find(p => p.name === '@aalis/plugin-memory-sqlite');
  const thrown = logger.errors.flat().find((a): a is Error => a instanceof Error);
  return { entry, thrown };
}

describe('plugin-memory-sqlite 开库失败', () => {
  it('原生模块 ABI 不符：改抛中文指引，给出两条出路，附原文首行，原错误作 cause', async () => {
    const original = Object.assign(
      new Error(
        "The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\n" +
          'NODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 137.',
      ),
      { code: 'ERR_DLOPEN_FAILED' },
    );
    const { entry, thrown } = await activateWith(original);

    expect(entry?.state).toBe('error');
    expect(entry?.error).toContain(`当前 Node（${process.version}`);
    expect(entry?.error).toContain('npm rebuild better-sqlite3');
    expect(entry?.error).toContain('pnpm rebuild better-sqlite3');
    expect(entry?.error).toMatch(/原始错误：The module '\/x\/better_sqlite3\.node'$/);
    expect(thrown?.cause).toBe(original);
  });

  it('其它原生加载失败（如架构不符）：不给 ABI 指引，照录原文，原错误作 cause', async () => {
    const original = Object.assign(
      new Error(
        "dlopen(/x/better_sqlite3.node, 0x0001): tried: '/x/better_sqlite3.node' " +
          "(mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))",
      ),
      { code: 'ERR_DLOPEN_FAILED' },
    );
    const { entry, thrown } = await activateWith(original);

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe(`SQLite 打开失败: better-sqlite3 原生模块无法加载：${original.message}`);
    expect(thrown?.cause).toBe(original);
  });

  it('数据库路径解析失败：消息点名 URI 与原因，原错误作 cause', async () => {
    const original = new Error('根 data 不可写');
    const { entry, thrown } = await activateWith(new Error('不该开库'), original);

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe('无法解析数据库路径 data:/aalis.db: 根 data 不可写');
    expect(thrown?.cause).toBe(original);
  });

  it('其它开库错误照旧带上原文', async () => {
    const { entry } = await activateWith(new Error('unable to open database file'));

    expect(entry?.state).toBe('error');
    expect(entry?.error).toBe('SQLite 打开失败: unable to open database file');
  });
});
