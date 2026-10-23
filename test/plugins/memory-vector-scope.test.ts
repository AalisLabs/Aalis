import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { embedding } from '../../packages/api-embedding/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type VectorSearchResult, vectorstore } from '../../packages/api-vectorstore/src/index.js';
import { App, logger, provide } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import memoryVector from '../../packages/plugin-memory-vector/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { sessionValuesPlugin } from '../fixtures/session-settings.js';
import { inputFromLastUser } from '../fixtures/turn-input.js';

// ════════════════════════════════════════════════════════════
// 跨会话检索模式（crossSessionMode，可按会话设）：生效值是召回上限，被动召回与 memory_recall 都不超过它。
// 试点群设成不互通后，同平台别的会话（包括 owner 私聊）的向量命中不进被动召回，memory_recall 传更宽的 scope 也放不宽；
// 哪一层写坏了按不互通。会话设置不在时只按插件配置。
// ════════════════════════════════════════════════════════════

const BASE_TS = Date.UTC(2026, 0, 1, 12, 0, 0);
const CUR = 'onebot:10000:group:20001';
const PRIV = 'onebot:10000:private:30001';
const WEB = 'webui:console';

type ToolHandler = (args: Record<string, unknown>, ctx: unknown) => Promise<string>;

function hits(): VectorSearchResult[] {
  return [
    { score: 0.95, metadata: { sessionId: CUR, platform: 'onebot', timestamp: BASE_TS, content: '本群记忆' } },
    { score: 0.9, metadata: { sessionId: PRIV, platform: 'onebot', timestamp: BASE_TS + 1, content: '私聊记忆' } },
    { score: 0.85, metadata: { sessionId: WEB, platform: 'webui', timestamp: BASE_TS + 2, content: '外平台记忆' } },
  ];
}

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** sessions 给出时装会话设置的替身，按会话 id 交本会话层的值 */
async function setup(crossSessionMode: string, sessions?: Record<string, Record<string, unknown>>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  const assembly = app.bind({ contributions, logger });
  if (sessions) await app.plugin(sessionValuesPlugin(sessions));
  host.provide.use(embedding, {
    async embed(): Promise<number[]> {
      return [0.1, 0.2, 0.3];
    },
  });
  const all = hits();
  host.provide.use(vectorstore, {
    async add(): Promise<void> {},
    async search(_q: number[], topK: number): Promise<VectorSearchResult[]> {
      return all.slice(0, topK);
    },
    async size(): Promise<number> {
      return all.length;
    },
    async clear(): Promise<void> {},
    async save(): Promise<void> {},
  });
  const toolHandlers = new Map<string, ToolHandler>();
  host.provide.use(tools, {
    register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      toolHandlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugins.register(memoryVector, {
    search: { topK: 5, timeWeight: 0, userPriorityBoost: 1, perItemMaxChars: 0, minScore: 0 },
    contextExpand: { window: 0, crossSession: true },
    indexing: { concurrency: 1, maxQueueSize: 10 },
    crossSessionMode,
    recallRoles: 'all',
  });
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错，「不注入」类断言会恒真
  if (app.plugins.getPlugin(memoryVector.name)?.state !== 'active') throw new Error('plugin-memory-vector 未激活');
  return { assembly, recall: toolHandlers.get('memory_recall')! };
}

/** 跑一次被动召回，返回注入块正文（没有注入时为空串） */
async function passive(assembly: Awaited<ReturnType<typeof setup>>['assembly']): Promise<string> {
  const messages: Message[] = [
    { role: 'system', content: '人设' },
    { role: 'user', content: '还记得吗' },
  ];
  await assemblePromptContributions(
    assembly,
    { messages, sessionId: CUR, platform: 'onebot' },
    inputFromLastUser(messages),
  );
  const block = messages.find(m => String(m.metadata?.injector ?? '').endsWith('/memory-vector'));
  return typeof block?.content === 'string' ? block.content : '';
}

async function recall(handler: ToolHandler, scope?: string) {
  const out = JSON.parse(
    await handler({ query: '记忆', ...(scope ? { scope } : {}) }, { sessionId: CUR, platform: 'onebot' }),
  );
  return {
    scope: out.scope as string,
    texts: (out.results ?? []).map((r: { text: string }) => r.text).join('\n'),
  };
}

describe('plugin-memory-vector：跨会话检索模式是召回上限', () => {
  it('这个会话设成不互通、插件配置同平台：同平台别的会话不进被动召回，memory_recall 传更宽的也放不宽', async () => {
    const { assembly, recall: handler } = await setup('platform', { [CUR]: { crossSessionMode: 'isolated' } });
    const text = await passive(assembly);
    expect(text).toContain('本群记忆');
    expect(text).not.toContain('私聊记忆');
    expect(text).not.toContain('外平台记忆');
    for (const scope of [undefined, 'all', 'platform']) {
      const out = await recall(handler, scope);
      expect(out.scope, `scope=${scope}`).toBe('session');
      expect(out.texts).toContain('本群记忆');
      expect(out.texts, `scope=${scope}`).not.toContain('私聊记忆');
      expect(out.texts, `scope=${scope}`).not.toContain('外平台记忆');
    }
  });

  it('这个会话设成同平台、插件配置全部打通：外平台的命中不进被动召回', async () => {
    const { assembly } = await setup('all', { [CUR]: { crossSessionMode: 'platform' } });
    const text = await passive(assembly);
    expect(text).toContain('本群记忆');
    expect(text).toContain('私聊记忆');
    expect(text).not.toContain('外平台记忆');
  });

  it('生效值就是这个会话的值：插件配置不互通、会话设成全部打通时全部可见', async () => {
    const { assembly, recall: handler } = await setup('isolated', { [CUR]: { crossSessionMode: 'all' } });
    expect(await passive(assembly)).toContain('外平台记忆');
    expect((await recall(handler)).scope).toBe('all');
  });

  it('memory_recall 传更窄的 scope 照给', async () => {
    const { recall: handler } = await setup('all', {});
    const out = await recall(handler, 'platform');
    expect(out.scope).toBe('platform');
    expect(out.texts).not.toContain('外平台记忆');
  });

  it('写坏了按不互通：会话层或插件配置里的坏值都只召回本会话', async () => {
    const atSession = await setup('all', { [CUR]: { crossSessionMode: 'everything' } });
    expect(await passive(atSession.assembly)).not.toContain('私聊记忆');
    expect((await recall(atSession.recall, 'all')).scope).toBe('session');

    const atGlobal = await setup('everything');
    const text = await passive(atGlobal.assembly);
    expect(text).toContain('本群记忆');
    expect(text).not.toContain('私聊记忆');
  });

  it('会话设置不在：行为与插件配置一致', async () => {
    const { assembly, recall: handler } = await setup('platform');
    const text = await passive(assembly);
    expect(text).toContain('本群记忆');
    expect(text).toContain('私聊记忆');
    expect(text).not.toContain('外平台记忆');
    const out = await recall(handler);
    expect(out.scope).toBe('platform');
    expect(out.texts).toContain('私聊记忆');
  });
});
