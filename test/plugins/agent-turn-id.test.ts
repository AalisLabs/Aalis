import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService, type TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { createStorageGateway, storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, type ToolExecuteMessage, tools } from '../../packages/api-tools/src/index.js';
import { App, events } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import checkpointPlugin from '../../packages/plugin-checkpoint/src/index.js';
import type { CheckpointServiceImpl } from '../../packages/plugin-checkpoint/src/service.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage, OutgoingMessage, StreamChunkMessage } from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 回合 id 与工具调用 id：agent 在回合开始时生成 turnId，入站钩子、流式片段、工具开始与结束、用量、
// 回合结束都带同一个 turnId；每次工具调用另有 callId，开始与结束靠它配对，跨回合、跨会话也不重复。
// 停止键可以只停某一轮：abort 带 turnId 时只停那一轮，对不上就什么都不停并返回 false。
// ════════════════════════════════════════════════════════════

const PROBE = 'zz_turn_probe';
const probeDefinition = {
  type: 'function' as const,
  function: { name: PROBE, description: '探针', parameters: { type: 'object' as const, properties: {} } },
};
/** 模型给的 tool call id 故意每轮都一样：callId 不能直接用它 */
const callProbe: ChatResponse = {
  content: null,
  toolCalls: [{ id: 'call-1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
};

const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 起一个带探针工具的 agent；handler 决定探针怎么跑，返回各面观察到的事件。
 * `before` 在 agent 之前装别的插件（如存储与检查点）。
 */
async function startAgent(
  responses: ChatResponse[],
  handler: (ctx: ToolCallContext) => Promise<string>,
  before?: (app: App) => Promise<void>,
) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await before?.(app);
  await app.plugin(createMockLLMPlugin({ responses }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const name of [toolsPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ tools, agent: agentService, hooks, events });
  host.tools.register({ definition: probeDefinition, handler: (_args, ctx) => handler(ctx) });

  const seen = {
    inputs: [] as Array<{ sessionId: string; turnId: string }>,
    streams: [] as StreamChunkMessage[],
    toolEvents: [] as ToolExecuteMessage[],
    usages: [] as TokenUsageEvent[],
    turnEnds: [] as Array<{ sessionId: string; turnId: string; outcome: string }>,
  };
  host.hooks.middleware('agent:input:before', async (data, next) => {
    seen.inputs.push({ sessionId: data.message.sessionId, turnId: data.turnId });
    await next();
  });
  host.hooks.middleware('agent:turn:after', async (data, next) => {
    seen.turnEnds.push({ sessionId: data.sessionId, turnId: data.turnId, outcome: data.outcome });
    await next();
  });
  host.events.on('outbound:stream', chunk => void seen.streams.push(chunk));
  host.events.on('tool:execute', info => void seen.toolEvents.push(info));
  host.events.on('token:usage', usage => void seen.usages.push(usage));
  return { agent: host.agent.require(), seen };
}

const message = (sessionId: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content: '帮我查一下',
  sessionId,
  platform: 'test',
  userId: 'u1',
  sessionType: 'private',
  ...extra,
});

describe('回合 id 贯穿一轮的各个事件', () => {
  it('入站钩子、流式片段、工具开始与结束、工具上下文、用量、回合结束带同一个 turnId', async () => {
    let ctx: ToolCallContext | undefined;
    const { agent, seen } = await startAgent([callProbe, { content: '查好了' }], async c => {
      ctx = c;
      return 'ok';
    });
    await agent.handleMessage(message('test:turn-id'));

    expect(seen.inputs).toHaveLength(1);
    const turnId = seen.inputs[0]?.turnId;
    expect(turnId, 'agent:input:before 应带回合 id').toEqual(expect.any(String));
    expect(turnId).not.toBe('');

    expect(seen.streams.length, '应有流式片段').toBeGreaterThan(1);
    expect(seen.streams.every(c => c.turnId === turnId)).toBe(true);
    expect(seen.streams.at(-1)?.done).toBe(true);

    expect(seen.toolEvents.map(e => e.phase)).toEqual(['start', 'end']);
    expect(seen.toolEvents.every(e => e.turnId === turnId)).toBe(true);
    expect(ctx?.turnId, '工具上下文带回合 id').toBe(turnId);
    expect(ctx?.callId, '工具上下文带调用 id').toEqual(expect.any(String));
    expect(seen.toolEvents.every(e => e.callId === ctx?.callId)).toBe(true);
    expect(ctx?.callId, 'callId 不直接取模型给的 tool call id').not.toBe('call-1');

    expect(seen.usages.length, '每次 LLM 调用之后推一次用量').toBe(2);
    expect(seen.usages.every(u => u.turnId === turnId)).toBe(true);

    expect(seen.turnEnds).toEqual([{ sessionId: 'test:turn-id', turnId, outcome: 'replied' }]);
  });

  it('消息被入站钩子拦下：收尾的流结束标记也带这一轮的 turnId', async () => {
    const { agent, seen } = await startAgent([{ content: '不应调用' }], async () => 'ok');
    const app = apps.at(-1) as App;
    app.bind({ hooks }).hooks.middleware('agent:input:before', async () => {
      /* 不调 next：拦下整条消息 */
    });
    await agent.handleMessage(message('test:turn-id-blocked'));

    const turnId = seen.inputs[0]?.turnId;
    expect(turnId).toEqual(expect.any(String));
    expect(seen.streams).toEqual([{ sessionId: 'test:turn-id-blocked', platform: 'test', turnId, done: true }]);
    expect(seen.turnEnds).toEqual([]);
  });

  it('并发两轮：模型给的 tool call id 相同，callId 仍各不相同，开始与结束按 callId 配对且归属各自的回合', async () => {
    const bothInTool = deferred();
    const ctxs: ToolCallContext[] = [];
    const { agent, seen } = await startAgent([callProbe, callProbe, { content: '好了' }], async c => {
      ctxs.push(c);
      if (ctxs.length === 2) bothInTool.resolve();
      await bothInTool.promise; // 两轮都进了工具才一起放行：开始与结束事件交错
      return 'ok';
    });
    await Promise.all([agent.handleMessage(message('test:turn-a')), agent.handleMessage(message('test:turn-b'))]);

    const turnOf = new Map(seen.inputs.map(i => [i.sessionId, i.turnId]));
    expect(turnOf.size).toBe(2);
    expect(new Set(turnOf.values()).size, '两轮的 turnId 不同').toBe(2);

    const callIds = ctxs.map(c => c.callId);
    expect(new Set(callIds).size, '两次调用的 callId 不同').toBe(2);
    for (const ctx of ctxs) {
      expect(ctx.turnId, '工具上下文的 turnId 属于它所在的会话那一轮').toBe(turnOf.get(ctx.sessionId));
      const events = seen.toolEvents.filter(e => e.callId === ctx.callId);
      expect(events.map(e => e.phase)).toEqual(['start', 'end']);
      expect(events.every(e => e.turnId === ctx.turnId && e.sessionId === ctx.sessionId)).toBe(true);
    }
    // 交错确实发生：第二次开始出现在第一次结束之前
    expect(seen.toolEvents.map(e => e.phase)).toEqual(['start', 'start', 'end', 'end']);
  });
});

describe('落库的消息带回合 id', () => {
  it('这一轮落库的工具调用组与最后的回复都带 turnId；提问不带（它在回合开头经消息归档落库）', async () => {
    const { agent, seen } = await startAgent([callProbe, { content: '查好了' }], async () => 'ok');
    await agent.handleMessage(message('test:archive-turn'));
    const turnId = seen.inputs[0]?.turnId;
    const stored = await (apps.at(-1) as App).bind({ memory }).memory.require().getHistory('test:archive-turn', 50);
    expect(stored.map(m => [m.role, m.metadata?.turnId])).toEqual([
      ['user', undefined],
      ['assistant', turnId],
      ['tool', turnId],
      ['assistant', turnId],
    ]);
  });

  it('工具结果的钩子写进 metadata 的键随这次工具结果落库，turnId 与 callId 由 agent 写；回复的出站消息带这一轮的 turnId', async () => {
    const { agent, seen } = await startAgent([callProbe, { content: '查好了' }], async () => 'ok');
    const host = (apps.at(-1) as App).bind({ hooks, memory, events });
    host.hooks.middleware('agent:tool:after', async (data, next) => {
      data.metadata.note = '记一笔';
      data.metadata.turnId = 'forged';
      await next();
    });
    const outbound: OutgoingMessage[] = [];
    host.events.on('outbound:message', msg => void outbound.push(msg));
    await agent.handleMessage(message('test:tool-metadata'));
    const turnId = seen.inputs[0]?.turnId;
    const stored = await host.memory.require().getHistory('test:tool-metadata', 50);
    expect(stored.find(m => m.role === 'tool')?.metadata).toEqual({
      note: '记一笔',
      turnId,
      callId: seen.toolEvents[0]?.callId,
    });
    expect(outbound.map(m => [m.content, m.turnId])).toEqual([['查好了', turnId]]);
  });
});

describe('abort 按回合 id 停止', () => {
  /** 起一轮停在工具里的回合，返回它的 turnId 与放行口 */
  async function turnInTool(sessionId: string) {
    const entered = deferred();
    const release = deferred();
    const started = await startAgent([callProbe, { content: '完成' }], async () => {
      entered.resolve();
      await release.promise;
      return 'ok';
    });
    const turn = started.agent.handleMessage(message(sessionId));
    await entered.promise;
    const turnId = started.seen.inputs[0]?.turnId as string;
    return { ...started, turn, turnId, release: () => release.resolve() };
  }

  it('turnId 对不上：返回 false，当前回合不受影响、照常完成', async () => {
    const sessionId = 'test:abort-mismatch';
    const { agent, seen, turn, turnId, release } = await turnInTool(sessionId);
    expect(agent.abort?.(sessionId, 'not-this-turn')).toBe(false);
    release();
    await turn;
    expect(seen.turnEnds).toEqual([{ sessionId, turnId, outcome: 'replied' }]);
  });

  it('turnId 对得上：只停这一轮，返回 true，回合以 aborted 收尾', async () => {
    const sessionId = 'test:abort-match';
    const { agent, seen, turn, turnId, release } = await turnInTool(sessionId);
    expect(agent.abort?.(sessionId, turnId)).toBe(true);
    release();
    await turn;
    expect(seen.turnEnds).toEqual([{ sessionId, turnId, outcome: 'aborted' }]);
  });

  it('同一会话两条 lane 并发：带 turnId 只停其中一轮，另一轮照常完成；不带 turnId 时返回是否停了回合', async () => {
    const sessionId = 'test:abort-lanes';
    const entered = deferred();
    const release = deferred();
    let inTool = 0;
    const { agent, seen } = await startAgent([callProbe, callProbe, { content: '完成' }], async () => {
      inTool++;
      if (inTool === 2) entered.resolve();
      await release.promise;
      return 'ok';
    });
    const userTurn = agent.handleMessage(message(sessionId));
    const scheduledTurn = agent.handleMessage(message(sessionId, { source: 'scheduler', userId: undefined }));
    await entered.promise;
    expect(seen.inputs).toHaveLength(2);
    const [userTurnId, scheduledTurnId] = seen.inputs.map(i => i.turnId);

    expect(agent.abort?.(sessionId, scheduledTurnId)).toBe(true);
    release.resolve();
    await Promise.all([userTurn, scheduledTurn]);
    expect(seen.turnEnds).toHaveLength(2);
    expect(seen.turnEnds).toEqual(
      expect.arrayContaining([
        { sessionId, turnId: userTurnId, outcome: 'replied' },
        { sessionId, turnId: scheduledTurnId, outcome: 'aborted' },
      ]),
    );
    expect(agent.abort?.(sessionId), '没有在飞的回合').toBe(false);
  });
});

describe('checkpoint 用 agent 的回合 id', () => {
  it('工具在回合里经存储写的文件，记进与这一轮 turnId 相同的检查点', async () => {
    const base = mkdtempSync(join(tmpdir(), 'aalis-turn-cp-'));
    dirs.push(base);
    const ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    let files: ReturnType<typeof createStorageGateway> | undefined;
    const { agent, seen } = await startAgent(
      [callProbe, { content: '写好了' }],
      async () => {
        await files?.writeFile('ws:/by-tool.txt', 'x');
        return 'ok';
      },
      async app => {
        provideHostPaths(app, base);
        await app.plugin(storageLocalPlugin, {
          roots: [
            {
              name: 'ws',
              path: ws,
              kind: 'workspace',
              browsable: true,
              readable: true,
              writable: true,
              deletable: true,
            },
          ],
        });
        await app.plugin(checkpointPlugin, { rootDir: 'data:/checkpoints', scopes: ['*'], keepSessions: 0 });
      },
    );
    const app = apps.at(-1) as App;
    expect(app.plugins.getPlugin(checkpointPlugin.name)?.state).toBe('active');
    const host = app.bind({ storage, checkpoint });
    files = createStorageGateway(host.storage);

    await agent.handleMessage(message('test:turn-checkpoint'));
    const turnId = seen.inputs[0]?.turnId;
    const service = host.checkpoint.require() as CheckpointServiceImpl;
    const turns = await service.listTurns('test:turn-checkpoint');
    expect(turns.map(t => [t.turnId, t.filesPreview])).toEqual([[turnId, ['ws:/by-tool.txt']]]);
  });
});
