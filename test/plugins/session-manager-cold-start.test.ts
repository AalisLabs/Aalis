import { App, definePlugin, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { HUB_PLUGINS, registerHubs } from '../fixtures/hubs.js';

// 会话表跟随 memory 胜者：运行中胜者换成另一个后端（新装或启用首选后端）时，先把旧表的未落盘变更写回
// 旧后端，再从新后端读表整体替换（换后端即换库，不跨后端合并）。落盘只删本进程显式删除过的会话，
// 不按差集清扫。冷启动整批登记时会话管理排在全部 memory 提供者之后激活，首轮就从首选后端加载。

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

describe('session-manager 会话表跟随 memory 胜者', () => {
  it('先从空后备加载、首选后端随后上线：换成首选后端的会话表，原有会话可见且不被删', async () => {
    const fallback = fakeMemory();
    const preferred = fakeMemory({ 'old-1': oldSession });
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, fallback as never, { priority: -100 });
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    host.provide(memory, preferred as never, { priority: 10 });
    await app.plugins.idle();
    await expect.poll(() => host.sessionManager.require().getSession('old-1')?.name).toBe('上次运行的会话');

    await host.sessionManager.require().ensureSession('new-1', { name: '新会话', status: 'waiting' });
    await app.stop();

    expect([...preferred.meta.keys()].sort()).toEqual(['new-1', 'old-1']);
    expect([...fallback.meta.keys()], '旧表不写进新后端，新表也不写回旧后端').toEqual([]);
  });

  it('换人时先把旧表的未落盘变更写回旧后端，再以新后端的表为准', async () => {
    const fallback = fakeMemory();
    const preferred = fakeMemory({ 'old-1': oldSession });
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, fallback as never, { priority: -100 });
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    const sm = () => host.sessionManager.require();
    // 在后备上建一个会话，赶在 1 秒防抖落盘之前换后端
    await sm().ensureSession('draft', { name: '后备上的会话', status: 'waiting' });
    expect(fallback.meta.has('draft')).toBe(false);

    host.provide(memory, preferred as never, { priority: 10 });
    await app.plugins.idle();
    await expect.poll(() => sm().getSession('old-1')?.name).toBe('上次运行的会话');

    expect(fallback.meta.has('draft'), '换人前未落盘的变更写回了旧后端').toBe(true);
    expect(sm().getSession('draft'), '新后端的表里没有旧后端的会话').toBeUndefined();
    expect(preferred.meta.has('draft')).toBe(false);
    await app.stop();
    expect([...preferred.meta.keys()]).toEqual(['old-1']);
  });

  it('显式删除的会话仍从后端删掉', async () => {
    const store = fakeMemory({ keep: { ...oldSession, id: 'keep' }, drop: { ...oldSession, id: 'drop' } });
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, store as never);
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();

    await host.sessionManager.require().deleteSession('drop');
    await app.stop();

    expect([...store.meta.keys()]).toEqual(['keep']);
  });
});

describe('冷启动整批登记：首选后端首轮即可见', () => {
  it('后备先于首选被发现：pluginAll 让会话管理从首选后端加载，原有会话首轮就在列表里', async () => {
    const fallback = fakeMemory();
    const preferred = fakeMemory({ 'old-1': oldSession });
    const backend = (name: string, impl: unknown, priority: number) =>
      definePlugin({
        name,
        uses: { provide },
        provides: [memory],
        apply: ({ provide }) => {
          provide(memory, impl as never, { priority });
        },
      });
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ sessionManager });
    await app.plugins.idle();
    await app.pluginAll([
      ...HUB_PLUGINS.map(definition => ({ definition })),
      { definition: backend('zz-fallback', fallback, -100) },
      { definition: sessionManagerPlugin, config: {} },
      { definition: backend('zz-preferred', preferred, 10) },
    ]);
    await app.plugins.idle();
    expect(host.sessionManager.require().getSession('old-1')?.name).toBe('上次运行的会话');
    await app.stop();
  });
});
