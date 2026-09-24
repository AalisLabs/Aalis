import { afterEach, describe, expect, it } from 'vitest';
import { type MemoryService, type MetadataOp, memory } from '../../packages/api-memory/src/index.js';
import { App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import userRelationPlugin, { userRelation } from '../../packages/plugin-user-relation/src/index.js';

// ════════════════════════════════════════════════════════════
// user-relation 每次调用解析当前 memory 胜者。
//
// 偏好切换或更高优先级的提供者上线时，memory 换了胜者，user-relation 不会重启，
// 所以 store 不能存下某一刻的实例，否则之后的读写一直打到非胜者后端。
// ════════════════════════════════════════════════════════════

/** 只实现关系图用到的 metadata 面 */
class StubMemory {
  readonly data = new Map<string, Record<string, unknown>>();

  async saveMetadata(ns: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.data.set(`${ns}/${key}`, data);
  }
  async getMetadata(ns: string, key: string): Promise<Record<string, unknown> | undefined> {
    return this.data.get(`${ns}/${key}`);
  }
  async listMetadata(ns: string) {
    return [...this.data]
      .filter(([k]) => k.startsWith(`${ns}/`))
      .map(([k, data]) => ({ key: k.slice(ns.length + 1), data, updatedAt: 0 }));
  }
  async deleteMetadata(ns: string, key: string): Promise<void> {
    this.data.delete(`${ns}/${key}`);
  }
  async commitMetadata(ops: readonly MetadataOp[]): Promise<void> {
    for (const op of ops) {
      if (op.op === 'put') this.data.set(`${op.namespace}/${op.key}`, op.data);
      else this.data.delete(`${op.namespace}/${op.key}`);
    }
  }
}

function memoryProvider(name: string, priority: number, instance: StubMemory) {
  return definePlugin({
    name,
    provides: [memory],
    uses: { provide },
    apply(caps) {
      caps.provide(memory, instance as unknown as MemoryService, { priority });
    },
  });
}

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

describe('plugin-user-relation: memory 换胜者后读写跟随当前胜者', () => {
  it('偏好切到另一个提供者后，新写入落到新胜者，插件不重启', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    apps.push(app);
    const low = new StubMemory();
    const high = new StubMemory();
    await app.plugin(memoryProvider('mem-low', 0, low));
    await app.plugin(memoryProvider('mem-high', 10, high));
    await app.plugin(userRelationPlugin, { enabled: true, extractionEnabled: false });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(userRelationPlugin.name)?.state).toBe('active');

    const host = app.bind({ relation: userRelation, services });
    const before = host.relation.require();
    await before.observePerson('onebot', 'u1');

    expect(host.services.prefer(memory, 'mem-low')).toBe(true);
    await app.plugins.idle();
    expect(host.relation.require(), '换胜者不应重启 user-relation').toBe(before);

    await before.observePerson('onebot', 'u2');
    const persons = (m: StubMemory) => [...m.data.keys()].filter(k => k.includes('person'));
    expect({ low: persons(low), high: persons(high) }).toEqual({
      low: ['user-relation/person:onebot:u2'],
      high: ['user-relation/person:onebot:u1'],
    });
  });
});
