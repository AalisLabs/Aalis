import { describe, expect, it } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// user_profile_lookup：按 user_key，或按 platform + user_id 查一个用户的档案。
// ════════════════════════════════════════════════════════════

const TS = Date.UTC(2026, 0, 15, 8, 0, 0);

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, memory });
  host.provide.use(llm, { chat: async () => ({ content: '' }) } as never);
  const registered = new Map<string, Omit<RegisteredTool, 'pluginName'>>();
  host.provide.use(tools, {
    register: (tool: Omit<RegisteredTool, 'pluginName'>) => {
      registered.set(tool.definition.function.name, tool);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  await app.plugins.register(userProfile, { extractEveryNMessages: 0 });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');
  await host.memory.use.saveMetadata('user:profile', 'onebot:u1', {
    facts: [
      { id: 'f001', text: '喜欢养猫', category: '兴趣爱好', temporality: 'permanent', observedAt: TS, updatedAt: TS },
    ],
    relationScore: 12.5,
    interactionCount: 7,
    lastInteractionAt: TS,
    updatedAt: TS,
  });
  const lookup = registered.get('user_profile_lookup');
  if (!lookup) throw new Error('user_profile_lookup 未登记');
  const call = async (args: Record<string, unknown>) => JSON.parse(String(await lookup.handler(args, {} as never)));
  return { lookup, call };
}

describe('plugin-user-profile: user_profile_lookup', () => {
  it('参数只有 user_key、platform、user_id 三个', async () => {
    const { lookup } = await setup();
    const parameters = lookup.definition.function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(parameters.properties)).toEqual(['user_key', 'platform', 'user_id']);
  });

  it('user_key 直查与 platform + user_id 组合查到同一份档案', async () => {
    const { call } = await setup();
    const expected = {
      ok: true,
      userKey: 'onebot:u1',
      found: true,
      factCount: 1,
      relationScore: 12.5,
      interactionCount: 7,
      lastInteractionAt: TS,
      facts: expect.stringContaining('喜欢养猫'),
      relationSummary: '关系强度：12.5/100；累计互动：7 次。',
    };
    expect(await call({ user_key: 'onebot:u1' })).toEqual(expected);
    expect(await call({ platform: 'onebot', user_id: 'u1' })).toEqual(expected);
  });

  it('没给 user_key 也没给 platform + user_id：报错，不查任何档案', async () => {
    const { call } = await setup();
    for (const args of [{}, { platform: 'onebot' }, { self: true }]) {
      expect(await call(args), JSON.stringify(args)).toEqual({
        ok: false,
        error: '需提供 user_key 或 (platform + user_id)。',
      });
    }
  });
});
