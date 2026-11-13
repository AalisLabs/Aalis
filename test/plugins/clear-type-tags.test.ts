import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { App } from '../../packages/core/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import personaPlugin from '../../packages/plugin-persona/src/index.js';
import storageLocal from '../../packages/plugin-storage-local/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear 的类型由处理它的插件经 memory:clear-type 登记，并按 memory:clear 结果行上的 type 判断显式指定的类型有没有处理者，
// 漏标的插件会被误报成「没有已启用的插件处理」。persona、checkpoint 登记各自的类型，每一行都须标注它；
// summary / vector / user-profile / user-relation 由各自的清理测试与 clear-layers 集成测试覆盖。
// ════════════════════════════════════════════════════════════

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function world() {
  const base = mkdtempSync(join(tmpdir(), 'aalis-clear-tags-'));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const app = new App({ logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  provideHostPaths(app, base);
  await app.plugins.register(storageLocal, {});
  await app.plugins.register(personaPlugin, {});
  await app.plugins.register(checkpointPlugin, { rootDir: 'data:/checkpoints', keepSessions: 0 });
  await app.plugins.idle();
  const inactive = app.plugins
    .getStatus()
    .filter(p => p.state !== 'active')
    .map(p => `${p.instanceId}: ${p.state}`);
  expect(inactive).toEqual([]);
  const host = app.bind({ hooks, contributions });
  const clear = async (scope: 'session' | 'all', types: string[]) => {
    const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 's1', results: [] };
    await host.hooks.use.run('memory:clear', data, async () => {});
    return data.results;
  };
  /** 登记的清理类型：全局键 */
  const registered = () => host.contributions.use.collect('memory:clear-type').map(({ key }) => key);
  return { clear, registered };
}

describe('memory:clear 结果行标注清理类型', () => {
  it('persona 与 checkpoint 登记各自的类型', async () => {
    const { registered } = await world();
    expect(registered()).toEqual([`${checkpointPlugin.name}/checkpoint`, `${personaPlugin.name}/persona`]);
  });

  it.each(['session', 'all'] as const)('persona 与 checkpoint（%s）', async scope => {
    const { clear } = await world();
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
