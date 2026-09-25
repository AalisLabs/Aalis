import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 会话表落盘失败后可重试：每次写全量快照，删除只针对墓碑；提交失败时墓碑保留，下一次落盘把删除补上。
// 墓碑按令牌清：提交期间新删的会话留下新令牌，不被这次提交的收尾清掉。
// mongodb 后端没有事务，瞬时失败后墓碑一旦丢失，用户显式删掉的会话会在下次加载时复活。

const session = (id: string) => ({ id, name: id, status: 'completed', children: [], createdAt: 1, updatedAt: 1 });

type Persistable = { persist(): Promise<void> };

async function setup(store: ReturnType<typeof fakeMemory>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, sessionManager });
  host.provide(memory, store as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  return { app, sm: host.sessionManager.require() };
}

describe('session-manager 落盘失败后的重试', () => {
  it('提交失败时墓碑保留，停机再落盘时显式删除的会话仍从后端删掉', async () => {
    const store = fakeMemory({ keep: session('keep'), drop: session('drop') });
    const commit = store.commitMetadata;
    let calls = 0;
    store.commitMetadata = async ops => {
      if (calls++ === 0) throw new Error('transient');
      return commit(ops);
    };
    const { app, sm } = await setup(store);

    await sm.deleteSession('drop');
    await expect((sm as unknown as Persistable).persist()).rejects.toThrow('transient');
    expect(store.meta.has('drop')).toBe(true);

    await app.stop();
    expect([...store.meta.keys()]).toEqual(['keep']);
  });

  it('提交期间新删的会话不被这次提交的收尾清掉墓碑', async () => {
    const store = fakeMemory({ keep: session('keep'), a: session('a'), b: session('b') });
    const commit = store.commitMetadata;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    store.commitMetadata = async ops => {
      if (calls++ === 0) await gate;
      return commit(ops);
    };
    const { app, sm } = await setup(store);

    await sm.deleteSession('a');
    const pending = (sm as unknown as Persistable).persist();
    await sm.deleteSession('b');
    release();
    await pending;

    await app.stop();
    expect([...store.meta.keys()]).toEqual(['keep']);
  });
});
