import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';

// 冷启动时 session-manager 可能先从空的后备 memory 加载（例如内存后端先于 sqlite 就位），
// 之后首选后端成为胜者。落盘只能删本进程显式删除过的会话，不能把首选后端里原有的会话当孤儿删掉。

function fakeMemory(initial: Record<string, Record<string, unknown>> = {}) {
  const meta = new Map(Object.entries(initial));
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

const oldSession = {
  id: 'old-1',
  name: '上次运行的会话',
  status: 'completed',
  children: [],
  createdAt: 1,
  updatedAt: 1,
};

describe('session-manager 落盘只删显式删除的会话', () => {
  it('先从空后备加载、首选后端随后上线：首选后端里原有的会话不被当孤儿删掉', async () => {
    const fallback = fakeMemory();
    const preferred = fakeMemory({ 'old-1': oldSession });
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, fallback as never, { priority: -100 });
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    host.provide(memory, preferred as never, { priority: 10 });
    await app.plugins.idle();

    await host.sessionManager.require().ensureSession('new-1', { name: '新会话', status: 'waiting' });
    await app.stop();

    expect([...preferred.meta.keys()].sort()).toEqual(['new-1', 'old-1']);
  });

  it('显式删除的会话仍从后端删掉', async () => {
    const store = fakeMemory({ keep: { ...oldSession, id: 'keep' }, drop: { ...oldSession, id: 'drop' } });
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, store as never);
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();

    await host.sessionManager.require().deleteSession('drop');
    await app.stop();

    expect([...store.meta.keys()]).toEqual(['keep']);
  });
});
