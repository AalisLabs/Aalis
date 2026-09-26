import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 读不到会话表时（连接抖动、某行元数据解析失败），空表不能当作权威表和落盘目标：否则之后 ensureSession
// 新建的空白记录会覆盖后端里的原记录，会话名、标题、父子关系与会话级配置全部丢失。
// 冷启动与运行中换胜者两种形态都要守住；换胜者时落盘目标不能留在上一个后端，否则空表会写进旧后端。

const original = {
  id: 'old-1',
  name: '上次运行的会话',
  title: '原标题',
  status: 'completed',
  children: ['old-1::child'],
  config: { llm: { provider: 'p', model: 'm' } },
  createdAt: 1,
  updatedAt: 1,
};

function failingOnce(store: ReturnType<typeof fakeMemory>) {
  const list = store.listMetadata;
  let calls = 0;
  store.listMetadata = async () => {
    if (calls++ === 0) throw new Error('network blip');
    return list();
  };
  return store;
}

describe('session-manager 会话表加载失败', () => {
  it('冷启动读表失败：之后建档与停机都不覆盖后端原记录', async () => {
    const store = failingOnce(fakeMemory({ 'old-1': original }));
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, store as never);
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    const sm = host.sessionManager.require();

    expect(sm.getSession('old-1')).toBeUndefined();
    await sm.ensureSession('old-1', { config: { persona: 'x' } });
    await app.stop();

    expect(store.meta.get('old-1')).toEqual(original);
    expect([...store.meta.keys()]).toEqual(['old-1']);
  });

  it('换胜者后读新表失败：空表既不写进新后端，也不写进上一个后端', async () => {
    const fallback = fakeMemory({ 'old-1': original });
    const preferred = failingOnce(fakeMemory({ 'pref-1': { ...original, id: 'pref-1', children: [] } }));
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, fallback as never, { priority: -100 });
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    const sm = () => host.sessionManager.require();
    expect(sm().getSession('old-1')?.name).toBe('上次运行的会话');

    host.provide(memory, preferred as never, { priority: 10 });
    await app.plugins.idle();
    await expect.poll(() => sm().getSession('old-1')).toBeUndefined();

    await sm().ensureSession('old-1', { config: { persona: 'x' } });
    await sm().ensureSession('pref-1', { config: { persona: 'x' } });
    await app.stop();

    expect(fallback.meta.get('old-1')).toEqual(original);
    expect([...fallback.meta.keys()]).toEqual(['old-1']);
    expect(preferred.meta.get('pref-1')).toEqual({ ...original, id: 'pref-1', children: [] });
    expect([...preferred.meta.keys()]).toEqual(['pref-1']);
  });
});
