import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memorySqlite from '../../packages/plugin-memory-sqlite/src/index.js';

// ════════════════════════════════════════════════════════════
// 多实例的数据库位置：path 留空时按实例派生（主实例 data:/aalis.db，`:b` 实例 data:/aalis-b.db）；两个实例
// 解析到同一个文件时，后激活的那个以配置错误失败（一行、不带 stack），消息点名占用它的实例；占用者关闭后让出。
// better-sqlite3 换成只记路径的替身，storage 把 data 根映射到一个不存在的虚拟目录，不碰真实文件。
// ════════════════════════════════════════════════════════════

const NAME = '@aalis/plugin-memory-sqlite';
const BASE = '/zz-memory-sqlite-instances';

const native = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor(path: string) {
      native.opened.push(path);
    }
    pragma() {}
    exec() {}
    close() {}
  },
}));

function fakeStorage(): StorageService {
  const roots = [{ name: 'data', readable: true, writable: true, deletable: true }] as unknown as StorageRootInfo[];
  return {
    listRoots: () => roots,
    resolveLocalPath: async (uri: string) => `${BASE}/${uri.slice('data:/'.length)}`,
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
  native.opened.length = 0;
});

async function start(instances: Array<[string, Record<string, unknown>]>) {
  const logger = recordingLogger();
  const app = new App({ name: 'T', logger });
  apps.push(app);
  app.bind({ provide }).provide(storage, fakeStorage());
  for (const [id, config] of instances) await app.plugins.register(memorySqlite, config, id);
  await app.plugins.idle();
  const state = (id: string) => app.plugins.getStatus().find(p => p.instanceId === id);
  return { app, logger, state };
}

describe('plugin-memory-sqlite 多实例的数据库位置', () => {
  it('path 留空按实例派生：主实例用原默认文件，带后缀的实例在文件名上加后缀；写明的 path 照用', async () => {
    const { state } = await start([
      [NAME, { path: '' }],
      [`${NAME}:b`, { path: '' }],
      [`${NAME}:c`, { path: 'data/custom.db' }],
    ]);

    expect([NAME, `${NAME}:b`, `${NAME}:c`].map(id => state(id)?.state)).toEqual(['active', 'active', 'active']);
    expect(native.opened).toEqual([`${BASE}/aalis.db`, `${BASE}/aalis-b.db`, `${BASE}/custom.db`]);
  });

  it('两个实例解析到同一个文件：后激活的以一行配置错误失败并点名占用者，占用者关闭后可重试成功', async () => {
    const { app, logger, state } = await start([
      [NAME, {}],
      [`${NAME}:c`, { path: 'data:/aalis.db' }],
    ]);

    expect(state(NAME)?.state).toBe('active');
    expect(state(`${NAME}:c`)?.state).toBe('error');
    expect(state(`${NAME}:c`)?.error).toBe(
      `数据库文件 ${BASE}/aalis.db 已被实例 ${NAME} 使用，两个实例不能共用一个库：请给 ${NAME}:c 另配 path`,
    );
    const thrown = logger.errors.flat().find((a): a is Error => a instanceof Error);
    expect(thrown?.name).toBe('ConfigError');
    expect(thrown?.stack).toBeUndefined();
    expect(native.opened, '撞库的实例不开库').toEqual([`${BASE}/aalis.db`]);

    await app.plugins.unload(NAME);
    await app.plugins.bounce(`${NAME}:c`);
    await app.plugins.idle();
    expect(state(`${NAME}:c`)?.state).toBe('active');
    expect(native.opened).toEqual([`${BASE}/aalis.db`, `${BASE}/aalis.db`]);
  });

  it('实例自己重启（改配置）不算撞库', async () => {
    const { app, state } = await start([[NAME, {}]]);
    await app.plugins.updateConfig(NAME, { path: '', rangeQueryLimit: 100 });
    await app.plugins.idle();
    expect(state(NAME)?.state).toBe('active');
    expect(native.opened).toEqual([`${BASE}/aalis.db`, `${BASE}/aalis.db`]);
  });
});
