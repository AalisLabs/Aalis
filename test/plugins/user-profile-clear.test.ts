import { afterEach, describe, expect, it } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// /clear all -t user-profile 同时清第三方行为指令（aalis:instructions），不看 enableInstructions：
// 开关管功能用不用，不管已有数据能不能清。关掉功能后留下的指令此前没有任何途径清理
// （/instruct 指令同样受开关门控）。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function world(enableInstructions: boolean) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  const host = app.bind({ provide, services, hooks });
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat: async () => ({ content: '{}' }) } as never);
  await app.plugin(userProfile, { enableInstructions });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');
  const mem = host.services.get(memory);
  if (!mem) throw new Error('memory 服务未就绪');
  await mem.saveMetadata('user:profile', 'onebot:u1', { facts: [] });
  await mem.saveMetadata('aalis:instructions', 'Aalis', { instructions: [] });
  async function clear(scope: 'session' | 'all', types?: string[]) {
    const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 's1', results: [] };
    await host.hooks.run('memory:clear', data, async () => {});
    return data.results;
  }
  const keys = async (ns: string) => (await mem.listMetadata(ns)).map(e => e.key);
  return { clear, keys };
}

describe('plugin-user-profile: 全局清理同时清指令', () => {
  it('关闭 enableInstructions 时也清 aalis:instructions', async () => {
    for (const enabled of [false, true]) {
      const { clear, keys } = await world(enabled);
      const results = await clear('all', ['user-profile']);
      expect(
        results.map(r => [r.source, r.success]),
        `enableInstructions=${enabled}`,
      ).toEqual([
        ['user-profile', true],
        ['user-profile-instructions', true],
      ]);
      expect(await keys('user:profile')).toEqual([]);
      expect(await keys('aalis:instructions'), `enableInstructions=${enabled}`).toEqual([]);
    }
  });

  it('会话级或不含 user-profile 的类型：两者都不动', async () => {
    const cases: Array<{ scope: 'session' | 'all'; types?: string[] }> = [
      { scope: 'session' },
      { scope: 'all', types: ['context'] },
    ];
    for (const c of cases) {
      const { clear, keys } = await world(false);
      expect(await clear(c.scope, c.types), JSON.stringify(c)).toEqual([]);
      expect(await keys('user:profile')).toEqual(['onebot:u1']);
      expect(await keys('aalis:instructions')).toEqual(['Aalis']);
    }
  });
});
