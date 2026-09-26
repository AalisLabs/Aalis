import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide, services } from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import onebot from '../../packages/plugin-adapter-onebot/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 合并转发原文（持久化命名空间 onebot:forward 与进程内缓存）是聊天内容，归入 context：
// 全局清理且类型为空或含 context 时清掉。条目没有会话维度，会话级清理不动它（靠 7 天回收）。
// 多实例共用同一命名空间、各有一份内存缓存：每个实例都清，回显合并成一条。
// ════════════════════════════════════════════════════════════

const NS = 'onebot:forward';
const entry = (id: string) => ({ fullText: `${id} 的原文`, count: 1, participants: ['甲'] });

const logger: Logger = { info() {}, warn() {}, debug() {}, error() {}, child: () => logger };

const CFG: ForwardConfig = {
  enabled: true,
  maxDepth: 3,
  maxNodesPerLevel: 30,
  imageRecognition: false,
  imageRecognitionConcurrency: 1,
  recognitionMaxItems: 0,
  summarize: false,
  summaryMaxChars: 500,
  summaryInputLimit: 0,
};

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

async function inMemory(): Promise<{ app: App; mem: MemoryService }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const mem = app.bind({ services }).services.get(memory);
  if (!mem) throw new Error('memory 服务未就绪');
  return { app, mem };
}

async function seed(mem: MemoryService): Promise<void> {
  for (const id of ['F1', 'F2']) await mem.saveMetadata(NS, id, entry(id));
  await mem.saveMetadata('user:profile', 'onebot:u1', { facts: [] });
}

describe('forward-expand: clearAll', () => {
  it('清空内存缓存与持久化层，返回持久化层删除的条数；其它命名空间不动', async () => {
    const { mem } = await inMemory();
    await seed(mem);
    const expander = createForwardExpander<null>({
      logger,
      memory: fixedRef(mem),
      media: fixedRef<MediaService>(undefined),
      llm: fixedRef<LLMModel>(undefined),
      storage: {} as StorageService,
      processService: fixedRef<ProcessService>(undefined),
      forwardCfg: CFG,
      attachmentMaxBytes: 1024,
      sendAction: async () => null,
    });
    // 读回持久化条目会回填内存缓存
    expect(await expander.getOrLoadForward('F1')).toMatchObject({ fullText: 'F1 的原文' });
    await new Promise(resolve => setImmediate(resolve));

    expect(await expander.clearAll()).toBe(2);
    expect(await mem.listMetadata(NS)).toEqual([]);
    expect(await expander.getOrLoadForward('F1'), '内存缓存也已清空').toBeUndefined();
    expect(await mem.getMetadata('user:profile', 'onebot:u1')).toEqual({ facts: [] });
  });
});

describe('plugin-adapter-onebot: 参与 memory:clear', () => {
  /** 两个实例共用一个 memory；不配连接，只验证清理中间件 */
  async function world() {
    const { app, mem } = await inMemory();
    const host = app.bind({ provide, hooks });
    host.provide(storage, {} as never);
    host.provide(processService, {} as never);
    await app.plugin(onebot, { connections: [] });
    await app.plugin(onebot, { connections: [] }, `${onebot.name}:b`);
    await app.plugins.idle();
    for (const id of [onebot.name, `${onebot.name}:b`]) expect(app.plugins.getPlugin(id)?.state, id).toBe('active');
    async function clear(scope: 'session' | 'all', types?: string[]) {
      await seed(mem);
      const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 'onebot:1:group:2', results: [] };
      await host.hooks.run('memory:clear', data, async () => {});
      return data.results.filter(r => r.source === 'onebot-forward');
    }
    return { mem, clear };
  }

  it('全局且类型为空或含 context：两个实例都清，回显只有一条', async () => {
    for (const types of [undefined, ['context'], ['vector', 'context']]) {
      const { mem, clear } = await world();
      const list = vi.spyOn(mem, 'listMetadata');
      expect(await clear('all', types), JSON.stringify(types)).toEqual([
        { source: 'onebot-forward', success: true, message: '合并转发原文已清空（2 条）' },
      ]);
      expect(
        list.mock.calls.filter(([ns]) => ns === NS),
        '每个实例各清一次',
      ).toHaveLength(2);
      expect(await mem.listMetadata(NS)).toEqual([]);
      expect(await mem.getMetadata('user:profile', 'onebot:u1')).toEqual({ facts: [] });
    }
  });

  it('前一实例失败、后一实例成功：回显改写为成功', async () => {
    const { mem, clear } = await world();
    vi.spyOn(mem, 'commitMetadata').mockRejectedValueOnce(new Error('瞬时故障'));
    expect(await clear('all')).toEqual([
      { source: 'onebot-forward', success: true, message: '合并转发原文已清空（2 条）' },
    ]);
    expect(await mem.listMetadata(NS)).toEqual([]);
  });

  it('两个实例都失败：回显一条失败', async () => {
    const { mem, clear } = await world();
    vi.spyOn(mem, 'commitMetadata').mockRejectedValue(new Error('后端故障'));
    expect(await clear('all')).toEqual([
      { source: 'onebot-forward', success: false, message: '合并转发原文清空失败: 后端故障' },
    ]);
  });

  it('会话级或不含 context 的类型：不动转发原文', async () => {
    const cases: Array<{ scope: 'session' | 'all'; types?: string[] }> = [
      { scope: 'session' },
      { scope: 'session', types: ['context'] },
      { scope: 'all', types: ['image'] },
    ];
    for (const c of cases) {
      const { mem, clear } = await world();
      expect(await clear(c.scope, c.types), JSON.stringify(c)).toEqual([]);
      expect((await mem.listMetadata(NS)).map(e => e.key).sort(), JSON.stringify(c)).toEqual(['F1', 'F2']);
    }
  });
});
