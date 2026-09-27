import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { App } from '../../packages/core/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 按 memory:clear 结果行上的 type 判断显式指定的类型有没有处理者，漏标的插件会被误报成
// 「没有已启用的插件处理」。persona、checkpoint 的每一行都须标注各自的类型；
// summary / vector / user-profile / user-relation 由各自的清理测试与 clear-layers 集成测试覆盖。
// ════════════════════════════════════════════════════════════

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function world() {
  const base = mkdtempSync(join(tmpdir(), 'aalis-clear-tags-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  await app.plugins.register(storageLocal, {
    roots: [
      {
        name: 'data',
        path: join(base, 'data'),
        kind: 'data',
        browsable: false,
        readable: true,
        writable: true,
        deletable: true,
      },
    ],
  });
  await app.plugins.register(personaPlugin, {});
  await app.plugins.register(checkpointPlugin, { rootDir: 'data:/checkpoints', scopes: ['*'], keepSessions: 0 });
  await app.plugins.idle();
  const inactive = app.plugins
    .getStatus()
    .filter(p => p.state !== 'active')
    .map(p => `${p.instanceId}: ${p.state}`);
  expect(inactive).toEqual([]);
  const host = app.bind({ hooks });
  return async (scope: 'session' | 'all', types: string[]) => {
    const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 's1', results: [] };
    await host.hooks.run('memory:clear', data, async () => {});
    return data.results;
  };
}

describe('memory:clear 结果行标注清理类型', () => {
  it.each(['session', 'all'] as const)('persona 与 checkpoint（%s）', async scope => {
    const clear = await world();
    for (const type of ['persona', 'checkpoint']) {
      const results = await clear(scope, [type]);
      expect(results.length, type).toBeGreaterThan(0);
      expect(
        results.map(r => r.type),
        type,
      ).toEqual(results.map(() => type));
    }
  });
});
