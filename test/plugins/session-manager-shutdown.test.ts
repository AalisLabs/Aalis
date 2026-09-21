import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';

// 关停时 session-manager 必须自己把仍 active 的会话收口并立即落盘。
// 不能指望 agent:turn:after 还在：agent↔SM 是 optional 互用，core 只保证彼此 drain
// 期间存活，钩子在对方 close 之后不可用。本用例不装 agent，专门钉这条自立契约。

/** 只实现 SessionManager 用到的方法的假 memory；测试从 meta 读落盘结果。 */
function fakeMemory() {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
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

describe('关停：active 会话自行收口落盘', () => {
  it('stop() 时 active 会话被收口落盘，waiting 不动', async () => {
    const store = fakeMemory();
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, store as never);
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin(sessionManagerPlugin.name)?.state).toBe('active');

    const sm = host.sessionManager.require();
    await sm.ensureSession('in-flight', { name: '在飞', status: 'active' });
    await sm.ensureSession('idle-waiting', { name: '空会话', status: 'waiting' });
    await sm.ensureSession('already-done', { name: '已完成', status: 'completed' });

    await app.stop();

    // 断言走落盘后的 metadata，不看停机后仍驻留的内存对象——漏 persist 必须红。
    expect(store.meta.get('in-flight')?.status, '在飞会话应收口，不得冻在 active').toBe('completed');
    expect(store.meta.get('idle-waiting')?.status, '未开始的 waiting 会话不该被顺手收口').toBe('waiting');
    expect(store.meta.get('already-done')?.status).toBe('completed');
  });
});
