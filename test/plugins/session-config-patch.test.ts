import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin, { normalizeSessionConfigPatch } from '../../packages/plugin-session-manager/src/index.js';

// WebUI 会话配置「重置为继承」：JSON 带不了 undefined，前端用 null 表示删除该键；
// updateSession 是合并语义，键置为 undefined 后 resolveConfig 里就不再有它。
// 旧行为：前端直接删掉键 → 请求体里没有 → 服务端保留旧值，「重置」永远不生效。

function fakeMemory() {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    listMetadata: async () => [...meta].map(([key, data]) => ({ key, data })),
    commitMetadata: async (ops: Array<{ op: string; key: string; data?: Record<string, unknown> }>) => {
      for (const o of ops) {
        if (o.op === 'put' && o.data) meta.set(o.key, o.data);
        else if (o.op === 'del') meta.delete(o.key);
      }
    },
    getHistory: async () => [],
    clearSession: async () => {},
  };
}

describe('normalizeSessionConfigPatch', () => {
  it('null → undefined（键保留、值为 undefined，合并时才能盖掉旧值），其余原样', () => {
    const out = normalizeSessionConfigPatch({ persona: null, enabledToolGroups: ['*'], think: false });
    // toEqual 会忽略值为 undefined 的属性——那样的断言分不清「键被删」和「键置 undefined」，这里显式查键
    expect('persona' in out).toBe(true);
    expect(out.persona).toBeUndefined();
    expect(out.enabledToolGroups).toEqual(['*']);
    expect(out.think).toBe(false);
  });

  it('非对象拒绝', () => {
    expect(() => normalizeSessionConfigPatch(null)).toThrow();
    expect(() => normalizeSessionConfigPatch([])).toThrow();
  });
});

describe('会话配置重置为继承', () => {
  it('置 null 的键从生效配置里消失，回落到平台档', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const host = app.bind({ provide, sessionManager });
    // memory 是会话管理的 required 依赖：不先摆上，插件会停在 pending
    host.provide(memory, fakeMemory() as never);
    await app.plugin(sessionManagerPlugin, {
      platformProfiles: [{ platform: 'webui', persona: 'from-profile', enabledToolGroups: ['*'] }],
    });
    await app.plugins.idle();
    const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
    if (state !== 'active') throw new Error(`会话管理未激活（state=${state}）`);
    const sm = host.sessionManager.require();
    try {
      const s = await sm.createSession({ config: { persona: 'own', enabledToolGroups: ['system'] } });
      expect(sm.resolveConfig(s.id, 'webui')).toMatchObject({ persona: 'own', enabledToolGroups: ['system'] });
      await sm.updateSession(s.id, {
        config: normalizeSessionConfigPatch({ persona: null, enabledToolGroups: null }),
      });
      expect(sm.resolveConfig(s.id, 'webui')).toMatchObject({ persona: 'from-profile', enabledToolGroups: ['*'] });
    } finally {
      await app.stop().catch(() => {});
    }
  });
});
