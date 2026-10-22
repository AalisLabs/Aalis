import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import type { MediaService } from '../../packages/api-media/src/index.js';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import type { ProcessService } from '../../packages/api-process/src/index.js';
import type { StorageService } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import {
  App,
  definePlugin,
  events,
  type Logger,
  provide,
  type ServiceSelection,
  services,
} from '../../packages/core/src/index.js';
import { createForwardExpander, type ForwardConfig } from '../../packages/plugin-adapter-onebot/src/forward-expand.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import serper from '../../packages/plugin-websearch-serper/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeSummaryLLM } from '../fixtures/memory-summary.js';
import { fixedRef } from '../fixtures/service-ref.js';
import { recordingLogger } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 后台功能的模型：记忆摘要、QQ 转发摘要、用户画像的事实提取、网页搜索的结果压缩都不另设模型字段，一律按 llm 服务给本插件挑的
// 那一个取（本插件偏好 › 全局偏好 › 优先级，只挑能对话的）；偏好指向的模型不在时落到下一级。没有能对话的模型时各打一条 warn
// 「没有可用的对话模型，<功能>跳过」，同一插件只打一次，有了模型之后再缺再打；记忆摘要在这个原因下不再逐次打「压缩没有压成」。
// ════════════════════════════════════════════════════════════

const NO_MODEL = '没有可用的对话模型';
const settle = () => new Promise<void>(r => setTimeout(r, 30));

const apps: App[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.stop();
});

/** 只给出一个不能对话的模型：llm 服务在场，但挑不出能对话的 */
const embedOnly = { id: 'embed', contextLength: 8192, capabilities: ['embedding'], chat: async () => ({}) } as never;

/** 以插件提供一个能对话的模型，条目 id 为 `zz-chat/<模型 id>`；卸掉插件即没有了 */
const chatPlugin = (model: LLMModel) =>
  definePlugin({
    name: 'zz-chat',
    provides: [llm],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(llm, model, { entryId: `zz-chat/${model.id}` });
    },
  });

async function recordingApp() {
  const warns: string[] = [];
  const app = new App({ name: 'T', logLevel: 'error', logger: recordingLogger(warns) });
  apps.push(app);
  await registerHubs(app);
  return { app, warns, noModel: () => warns.filter(w => w.includes(NO_MODEL)) };
}

describe('记忆摘要', () => {
  async function setup() {
    const env = await recordingApp();
    const host = env.app.bind({ provide, services, memory, compression });
    await env.app.plugin(memoryInMemory);
    await env.app.plugin(messageArchive, { debugLogs: false });
    host.provide.use(llm, embedOnly, { entryId: 'zz-embed/embed' });
    await env.app.plugin(memorySummary);
    await env.app.plugins.idle();
    expect(env.app.plugins.getPlugin(memorySummary.name)?.state).toBe('active');
    /** 说一句再手动压缩一次 */
    const compress = async (sessionId: string) => {
      await host.memory.use.saveMessage(sessionId, { role: 'user', content: '在吗' });
      return host.compression.use.compress(sessionId, { reason: 'manual' });
    };
    return { ...env, host, compress };
  }

  it('按本插件偏好取摘要模型；它指向的模型不在时落到全局偏好，再落到优先级', async () => {
    const { host, compress } = await setup();
    const a = { ...fakeSummaryLLM(), id: 'a' };
    const b = { ...fakeSummaryLLM(), id: 'b' };
    host.provide.use(llm, { ...a.model, id: 'a' }, { entryId: 'zz-models/a', priority: 10 });
    host.provide.use(llm, { ...b.model, id: 'b' }, { entryId: 'zz-models/b', priority: 0 });

    host.services.use.prefer(llm, 'zz-models/b', { for: memorySummary.name });
    await compress('s1');
    expect([a.requests.length, b.requests.length]).toEqual([0, 1]);

    host.services.use.prefer(llm, 'zz-models/gone', { for: memorySummary.name });
    host.services.use.prefer(llm, 'zz-models/b');
    await compress('s2');
    expect([a.requests.length, b.requests.length]).toEqual([0, 2]);

    host.services.use.unprefer(llm);
    await compress('s3');
    expect([a.requests.length, b.requests.length]).toEqual([1, 2]);
  });

  it('没有能对话的模型：压缩以原因拒绝，只打一条 warn、不打「压缩没有压成」；有了模型之后再缺再打', async () => {
    const { app, warns, noModel, compress } = await setup();
    for (const id of ['s1', 's2']) await expect(compress(id)).rejects.toThrow(NO_MODEL);
    expect(noModel()).toEqual([expect.stringContaining(`${NO_MODEL}，记忆摘要跳过`)]);
    expect(warns.filter(w => w.includes('压缩没有压成'))).toEqual([]);

    const chat = fakeSummaryLLM();
    await app.plugin(chatPlugin(chat.model));
    await app.plugins.idle();
    await compress('s3');
    expect(chat.requests).toHaveLength(1);

    await app.plugins.unload('zz-chat');
    await expect(compress('s4')).rejects.toThrow(NO_MODEL);
    expect(noModel()).toHaveLength(2);
  });

  it('别的原因没压成照旧打「压缩没有压成」', async () => {
    const { host, warns, compress } = await setup();
    const failing = fakeSummaryLLM({
      reply: () => {
        throw new Error('<超时>');
      },
    });
    host.provide.use(llm, failing.model, { entryId: 'zz-models/failing' });
    await expect(compress('s1')).rejects.toThrow('<超时>');
    expect(warns.filter(w => w.includes('压缩没有压成'))).toHaveLength(1);
  });
});

describe('QQ 转发摘要', () => {
  const CFG: ForwardConfig = {
    enabled: true,
    maxDepth: 3,
    maxNodesPerLevel: 30,
    imageRecognition: false,
    imageRecognitionConcurrency: 1,
    recognitionMaxItems: 0,
    summarize: true,
    summaryMaxChars: 600,
    summaryInputLimit: 0,
  };
  const node = (text: string) => ({
    type: 'node',
    data: { nickname: '甲', user_id: '1', content: [{ type: 'text', data: { text } }] },
  });

  it('取服务挑的那一个（列表里排在前面的）；没有时只打一条 warn，有了之后再缺再打', async () => {
    const warns: string[] = [];
    const logger = recordingLogger(warns);
    const called: string[] = [];
    const model = (id: string) =>
      ({
        id,
        capabilities: ['chat'],
        chat: async () => {
          called.push(id);
          return { content: `<${id} 的摘要>` };
        },
      }) as unknown as LLMModel;
    let models: LLMModel[] = [];
    const selection: ServiceSelection<LLMModel> = {
      list: () => models.map((m, i) => ({ id: `p/${m.id}`, priority: 0, selected: i === 0, use: m })) as never,
      get use() {
        return models[0];
      },
      of: () => models[0],
      get present() {
        return models.length > 0;
      },
      follow: () => () => {},
    };
    const expander = createForwardExpander<null>({
      logger: logger as Logger,
      memory: fixedRef<MemoryService>(undefined),
      media: fixedRef<MediaService>(undefined),
      llm: selection,
      i18n: fixedRef(undefined) as never,
      storage: {} as StorageService,
      processService: fixedRef<ProcessService>(undefined),
      forwardCfg: CFG,
      attachmentMaxBytes: 1024,
      sendAction: async () => ({ messages: [node('hello')] }),
    });
    const expand = (id: string) =>
      expander.expandForwardsInText(null, `<forward id="${id}">[合并转发消息]</forward>`, undefined, 's');

    await expand('F1');
    await expand('F2');
    expect(warns.filter(w => w.includes(`${NO_MODEL}，转发摘要跳过`))).toHaveLength(1);

    models = [model('first'), model('second')];
    expect(await expand('F3')).toContain('<first 的摘要>');
    expect(called).toEqual(['first']);

    models = [];
    await expand('F4');
    expect(warns.filter(w => w.includes(NO_MODEL))).toHaveLength(2);
  });
});

describe('用户画像的事实提取', () => {
  it('没有能对话的模型时只打一条 warn；有了模型照常提取；再缺再打', async () => {
    const { app, noModel } = await recordingApp();
    const host = app.bind({ provide, events, memory });
    host.provide.use(llm, embedOnly, { entryId: 'zz-embed/embed' });
    await app.plugin(memoryInMemory);
    await app.plugin(userProfile, { extractEveryNMessages: 1, relationIncrementWitness: 0 });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(userProfile.name)?.state).toBe('active');
    const say = async (userId: string) => {
      await host.memory.use.saveMessage('onebot:g1', {
        role: 'user',
        content: '我喜欢猫',
        metadata: { userId, platform: 'onebot' },
      });
      await host.events.use.emit('inbound:message:archived', {
        sessionId: 'onebot:g1',
        incoming: { userId, platform: 'onebot' },
      } as never);
    };

    await say('u1');
    await vi.waitFor(() => expect(noModel()).toEqual([expect.stringContaining(`${NO_MODEL}，事实提取跳过`)]));
    await say('u2');
    await settle();
    expect(noModel()).toHaveLength(1);

    const chat = vi.fn(async () => ({ content: '{"add": [], "update": [], "remove": []}' }));
    await app.plugin(chatPlugin({ id: 'chat', contextLength: 8192, capabilities: ['chat'], chat } as never));
    await app.plugins.idle();
    await say('u3');
    await vi.waitFor(() => expect(chat).toHaveBeenCalled());

    await app.plugins.unload('zz-chat');
    await say('u4');
    await vi.waitFor(() => expect(noModel()).toHaveLength(2));
  });
});

describe('网页搜索的结果压缩', () => {
  it('没有能对话的模型时返回原始结果、只打一条 warn；有了模型时按它压缩', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ organic: [{ title: '<标题>', link: 'https://example.com', snippet: '<摘要>' }] }),
          ),
      ),
    );
    const { app, noModel } = await recordingApp();
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<string>>();
    app.bind({ provide }).provide.use(tools, {
      register(tool: {
        definition: { function: { name: string } };
        handler: (args: Record<string, unknown>) => Promise<string>;
      }) {
        handlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    await app.plugin(serper, { apiKey: '<密钥>', enableCompression: true });
    await app.plugins.idle();
    const search = () => handlers.get('web_search')!({ query: '<关键词>' });

    expect(await search()).toContain('<标题>');
    await search();
    expect(noModel()).toEqual([expect.stringContaining(`${NO_MODEL}，搜索结果压缩跳过`)]);

    const chat = vi.fn(async () => ({ content: '<压缩后的结果>' }));
    await app.plugin(chatPlugin({ id: 'chat', contextLength: 8192, capabilities: ['chat'], chat } as never));
    await app.plugins.idle();
    expect(await search()).toBe('<压缩后的结果>');

    await app.plugins.unload('zz-chat');
    await search();
    expect(noModel()).toHaveLength(2);
  });
});
