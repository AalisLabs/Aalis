import { afterEach, describe, expect, it } from 'vitest';
import { type MemoryService, type MetadataOp, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, lifecycle, provide } from '../../packages/core/src/index.js';
import { RelationStore } from '../../packages/plugin-user-relation/src/index.js';
import type { PersonNode } from '../../packages/plugin-user-relation/src/types.js';

// ════════════════════════════════════════════════════════════
// RelationStore 每次调用解析当前 memory 提供者。
//
// memory 可有多个提供者，胜者被重启（如 WebUI 保存配置触发的 bounce）或下线时，
// user-relation 有兜底提供者可用、自身不会重启。store 若存下某一刻的实例，
// 之后的读写会一直打到已关闭的旧实例上。
// ════════════════════════════════════════════════════════════

/** 只实现关系图用到的 metadata 面；关闭后任何调用都抛错，模拟已断开的后端连接。 */
class StubMemory {
  readonly data = new Map<string, Record<string, unknown>>();
  closed = false;

  private check(): void {
    if (this.closed) throw new Error('memory 实例已关闭');
  }
  async saveMetadata(ns: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.check();
    this.data.set(`${ns}/${key}`, data);
  }
  async getMetadata(ns: string, key: string): Promise<Record<string, unknown> | undefined> {
    this.check();
    return this.data.get(`${ns}/${key}`);
  }
  async listMetadata(ns: string) {
    this.check();
    return [...this.data]
      .filter(([k]) => k.startsWith(`${ns}/`))
      .map(([k, data]) => ({ key: k.slice(ns.length + 1), data, updatedAt: 0 }));
  }
  async deleteMetadata(ns: string, key: string): Promise<void> {
    this.check();
    this.data.delete(`${ns}/${key}`);
  }
  async commitMetadata(ops: readonly MetadataOp[]): Promise<void> {
    this.check();
    for (const op of ops) {
      if (op.op === 'put') this.data.set(`${op.namespace}/${op.key}`, op.data);
      else this.data.delete(`${op.namespace}/${op.key}`);
    }
  }
}

/** 桩 memory 提供者：每次激活新建一个实例，拆卸时关闭它 */
function memoryProvider(name: string, priority: number, created: StubMemory[]) {
  return definePlugin({
    name,
    provides: [memory],
    uses: { provide, lifecycle },
    apply(caps) {
      const mem = new StubMemory();
      created.push(mem);
      caps.provide(memory, mem as unknown as MemoryService, { priority });
      caps.lifecycle.onDispose(() => {
        mem.closed = true;
      });
    },
  });
}

const person = (userId: string): PersonNode => ({
  id: `onebot:${userId}`,
  platform: 'onebot',
  userId,
  firstSeenAt: 1,
  lastSeenAt: 1,
});

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function setup() {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  apps.push(app);
  const low: StubMemory[] = [];
  const high: StubMemory[] = [];
  await app.plugin(memoryProvider('test-memory-low', 0, low));
  await app.plugin(memoryProvider('test-memory-high', 10, high));
  await app.plugins.idle();
  const ref = app.bind({ memory }).memory;
  const store = new RelationStore(() => ref.require());
  return { app, low, high, store };
}

describe('plugin-user-relation: memory 提供者换人后 store 跟随当前胜者', () => {
  it('首选提供者重启后，读写打到新实例而不是已关闭的旧实例', async () => {
    const { app, low, high, store } = await setup();
    await store.upsertPerson(person('u1'));
    expect(high).toHaveLength(1);
    const [before] = high;

    expect(await app.plugins.bounce('test-memory-high')).toBe(true);
    await app.plugins.idle();
    expect(before?.closed, '旧实例应已关闭').toBe(true);
    expect(high).toHaveLength(2);
    const after = high[1];

    await store.upsertPerson(person('u2'));
    expect(await store.getPerson('onebot', 'u2')).toMatchObject({ userId: 'u2' });
    expect([...(after?.data.keys() ?? [])]).toEqual(['user-relation/person:onebot:u2']);
    expect((await store.loadAll()).persons.map(p => p.userId)).toEqual(['u2']);
    expect(before?.data.size, '旧实例不应再被写入').toBe(1);
    expect(low[0]?.data.size).toBe(0);
  });

  it('首选提供者下线后，读写回落到剩下的提供者', async () => {
    const { app, low, high, store } = await setup();
    await store.upsertPerson(person('u1'));

    expect(await app.plugins.unload('test-memory-high')).toBe(true);
    await app.plugins.idle();
    expect(high[0]?.closed).toBe(true);

    await store.upsertPerson(person('u2'));
    expect(await store.getPerson('onebot', 'u2')).toMatchObject({ userId: 'u2' });
    expect([...(low[0]?.data.keys() ?? [])]).toEqual(['user-relation/person:onebot:u2']);
  });
});
