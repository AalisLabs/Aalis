import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { I18nService } from '../../packages/api-i18n/src/index.js';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { type ProcessService, processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide, services } from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import onebot from '../../packages/plugin-adapter-onebot/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fixedRef } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 合并转发原文（持久化命名空间 onebot:forward 与进程内缓存）是聊天内容，归入 context：
// 全局清理且类型为空或含 context 时清掉。会话级清理不动它（靠 7 天回收）。
// 条目记下收到这条转发的会话（工具取原文时按它们过取别的会话的规则）：别的会话再收到同一条时补上；不论展开没展开、获取成功与否都记
// （关掉展开的、获取失败的与嵌套在里面的只有会话）；持久化层里没记会话或记录损坏的条目读回时会话为空，取用判定判不出。
// 多实例共用同一命名空间、各有一份内存缓存：每个实例都清，回显合并成一条。回显是文字对象，按读者的语言显示。
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
  const app = new App({ logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  const mem = app.bind({ services }).services.use.get(memory);
  if (!mem) throw new Error('memory 服务未就绪');
  return { app, mem };
}

async function seed(mem: MemoryService, ids = ['F1', 'F2']): Promise<void> {
  for (const id of ids) await mem.saveMetadata(NS, id, entry(id));
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
      i18n: fixedRef<I18nService>(undefined),
      storage: {} as StorageService,
      processService: fixedRef<ProcessService>(undefined),
      forwardCfg: CFG,
      attachmentMaxBytes: 1024,
      signal: new AbortController().signal,
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

describe('forward-expand: 条目记下收到它的会话', () => {
  const P = 'onebot:1:private:2';
  const G = 'onebot:1:group:3';
  const expanderOn = (
    mem: MemoryService,
    forwardCfg = CFG,
    sendAction: (state: null, action: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({
      messages: [{ type: 'node', data: { nickname: '甲', content: '在' } }],
    }),
  ) =>
    createForwardExpander<null>({
      logger,
      memory: fixedRef(mem),
      media: fixedRef<MediaService>(undefined),
      llm: fixedRef<LLMModel>(undefined),
      i18n: fixedRef<I18nService>(undefined),
      storage: {} as StorageService,
      processService: fixedRef<ProcessService>(undefined),
      forwardCfg,
      attachmentMaxBytes: 1024,
      signal: new AbortController().signal,
      sendAction,
    });

  it('展开时记下收到它的会话；别的会话再收到同一条时补上并写进持久化层，同一会话不重复记', async () => {
    const { mem } = await inMemory();
    const expander = expanderOn(mem);
    const forward = [{ type: 'forward', data: { id: 'F-s' } }];
    await expander.expandForwards(null, forward, P);
    expect((await expander.getOrLoadForward('F-s'))?.sessionIds).toEqual([P]);
    await expander.expandForwards(null, forward, G);
    await expander.expandForwards(null, forward, G);
    expect((await expander.getOrLoadForward('F-s'))?.sessionIds).toEqual([P, G]);
    await new Promise(resolve => setImmediate(resolve));
    expect(await mem.getMetadata(NS, 'F-s')).toMatchObject({ sessionIds: [P, G] });
  });

  it('关掉展开的、顶层获取失败的：只记下收到它的会话，写进持久化层；别的会话再收到时补上', async () => {
    const { mem } = await inMemory();
    const off = expanderOn(mem, { ...CFG, enabled: false });
    await off.expandForwards(null, [{ type: 'forward', data: { id: 'F-off' } }], P);
    await off.expandForwards(null, [{ type: 'forward', data: { id: 'F-off' } }], G);
    expect(await off.getOrLoadForward('F-off')).toEqual({ sessionIds: [P, G] });
    const failing = expanderOn(mem, CFG, async () => {
      throw new Error('<占位原话>');
    });
    await failing.expandForwards(null, [{ type: 'forward', data: { id: 'F-fail' } }], P);
    expect(await failing.getOrLoadForward('F-fail')).toEqual({ sessionIds: [P] });
    await new Promise(resolve => setImmediate(resolve));
    expect(await mem.getMetadata(NS, 'F-off')).toEqual({ sessionIds: [P, G] });
    expect(await expanderOn(mem).getOrLoadForward('F-fail'), '新实例从持久化层读回').toEqual({ sessionIds: [P] });
  });

  it('嵌套在里面的转发（含超过深度没展开的）：同样记下收到它的会话；别的会话再收到外层时一并补上', async () => {
    const { mem } = await inMemory();
    const node = (content: unknown) => ({ type: 'node', data: { nickname: '甲', content } });
    const expander = expanderOn(mem, { ...CFG, maxDepth: 1 });
    const forward = [
      { type: 'forward', data: { id: 'F-outer', content: [node([{ type: 'forward', data: { id: 'F-inner' } }])] } },
    ];
    await expander.expandForwards(null, forward, P);
    expect((await expander.getOrLoadForward('F-outer'))?.fullText).toContain('F-inner 已超过深度上限');
    expect(await expander.getOrLoadForward('F-inner')).toEqual({ sessionIds: [P] });
    await expander.expandForwards(null, forward, G);
    expect(await expander.getOrLoadForward('F-inner')).toEqual({ sessionIds: [P, G] });
  });

  it('持久化层里没记会话或记录损坏的条目：读回时会话为空', async () => {
    const { mem } = await inMemory();
    await seed(mem, ['F1']);
    await mem.saveMetadata(NS, 'F2', { ...entry('F2'), sessionIds: [P, 3] });
    const expander = expanderOn(mem);
    expect(await expander.getOrLoadForward('F1')).toMatchObject({ fullText: 'F1 的原文', sessionIds: [] });
    expect((await expander.getOrLoadForward('F2'))?.sessionIds).toEqual([P]);
  });
});

describe('plugin-adapter-onebot: 参与 memory:clear', () => {
  /** 两个实例共用一个 memory；不配连接，只验证清理中间件 */
  async function world() {
    const { app, mem } = await inMemory();
    const host = app.bind({ provide, hooks });
    host.provide.use(storage, {} as never);
    host.provide.use(processService, {} as never);
    await app.plugin(onebot, { connections: [] });
    await app.plugin(onebot, { connections: [] }, `${onebot.name}:b`);
    await app.plugins.idle();
    for (const id of [onebot.name, `${onebot.name}:b`]) expect(app.plugins.getPlugin(id)?.state, id).toBe('active');
    /** 先存入 ids 这几条转发原文再清；回显按 language 渲染 */
    async function clear(scope: 'session' | 'all', types?: string[], { ids = ['F1', 'F2'], language = 'zh-CN' } = {}) {
      await seed(mem, ids);
      const data: HookContextMap['memory:clear'] = { scope, types, sessionId: 'onebot:1:group:2', results: [] };
      await host.hooks.use.run('memory:clear', data, async () => {});
      return data.results
        .filter(r => r.source === 'onebot-forward')
        .map(r => ({ ...r, message: renderIn(r.message, language) }));
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
      { source: 'onebot-forward', success: false, message: '合并转发原文清空失败：后端故障' },
    ]);
  });

  it('回显按读者的语言：清空 1 条、2 条与清空失败', async () => {
    const { mem, clear } = await world();
    const lines: unknown[] = [];
    for (const ids of [['F1'], ['F1', 'F2']]) {
      lines.push(...(await clear('all', undefined, { ids, language: 'en' })).map(r => r.message));
    }
    vi.spyOn(mem, 'commitMetadata').mockRejectedValue(new Error('后端故障'));
    lines.push(...(await clear('all', undefined, { language: 'en' })).map(r => r.message));
    expect(lines).toEqual([
      'Cleared the original text of merged forwards (1 entry)',
      'Cleared the original text of merged forwards (2 entries)',
      'Failed to clear the original text of merged forwards: 后端故障',
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
