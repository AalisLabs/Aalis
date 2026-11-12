import { afterEach, describe, expect, it } from 'vitest';
import {
  agent as agentService,
  type PromptContributionView,
  type TurnInput,
} from '../../packages/api-agent/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import type { IncomingMessage, Message, StreamChunkMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// agent 的两层入站钩子：agent:input:before 每条输入一次（data 只有这条消息，预处理器挂在它上面）；agent:turn:before 每轮
// 一次，带回合 id、会话与这一轮的输入。开轮的输入在 turn:before 的默认动作开头归档，带这一轮的回合 id 与进入方式；
// 不调 next 即这一轮不跑、输入不归档、不发回合结束，流结束标记照发。回合结束与提示词贡献的视图带同一份输入。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function start() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const recorder: ChatModelRequest[] = [];
  await app.plugin(createMockLLMPlugin({ responses: [{ content: '好的' }], recorder }));
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(agentPlugin.name)?.state).toBe('active');
  const host = app.bind({ agent: agentService, hooks, events, memory, contributions });
  const streams: StreamChunkMessage[] = [];
  host.events.use.on('outbound:stream', chunk => void streams.push(chunk));
  const history = (sessionId: string) => host.memory.use.getHistory(sessionId, 50);
  return { host, recorder, streams, history };
}

const message = (sessionId: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content: '看看这个',
  sessionId,
  platform: 'test',
  userId: 'u1',
  sessionType: 'private',
  ...extra,
});

describe('agent:input:before 每条输入一次', () => {
  it('data 只有这条消息；它在 agent:turn:before 之前跑，预处理器写好的附件正文进了归档正文', async () => {
    const { host, history } = await start();
    const order: string[] = [];
    const inputKeys: string[][] = [];
    host.agent.use.registerPreprocessor('zz-file', async (msg, next) => {
      msg._attachmentDescriptions = ['<文件正文>'];
      await next();
    });
    host.hooks.use.middleware('agent:input:before', async (data, next) => {
      order.push('input');
      inputKeys.push(Object.keys(data));
      await next();
    });
    host.hooks.use.middleware('agent:turn:before', async (_data, next) => {
      order.push('turn');
      await next();
    });

    await host.agent.use.handleMessage(
      message('test:input-hook', {
        attachments: [{ kind: 'file', name: 'a.txt', data: 'data:text/plain;base64,eA==' }],
      }),
    );

    expect(order).toEqual(['input', 'turn']);
    expect(inputKeys).toEqual([['message']]);
    const [archived] = await history('test:input-hook');
    expect(archived?.content).toContain('<文件正文>');
  });
});

describe('agent:input:before 不调 next', () => {
  it('这条丢掉：不开轮、不归档、不调模型，流结束标记照发（前端据此收起加载）', async () => {
    const { host, recorder, streams, history } = await start();
    const begun: string[] = [];
    host.hooks.use.middleware('agent:input:before', async () => {});
    host.hooks.use.middleware('agent:turn:before', async (data, next) => {
      begun.push(data.turnId);
      await next();
    });

    await host.agent.use.handleMessage(message('test:input-dropped'));

    expect(begun).toEqual([]);
    expect(recorder).toEqual([]);
    expect(await history('test:input-dropped')).toEqual([]);
    expect(streams).toEqual([
      { sessionId: 'test:input-dropped', platform: 'test', turnId: expect.any(String), done: true },
    ]);
  });
});

describe('agent:turn:before 每轮一次', () => {
  it('带回合 id、会话与这一轮的输入（就是入站的那条），回合 id 与 agent:turn:after 相同', async () => {
    const { host } = await start();
    const incoming = message('test:turn-hook');
    const begun: Array<HookContextMap['agent:turn:before']> = [];
    const ended: Array<HookContextMap['agent:turn:after']> = [];
    host.hooks.use.middleware('agent:turn:before', async (data, next) => {
      begun.push(data);
      await next();
    });
    host.hooks.use.middleware('agent:turn:after', async (data, next) => {
      ended.push(data);
      await next();
    });

    await host.agent.use.handleMessage(incoming);

    expect(begun).toHaveLength(1);
    expect(begun[0]?.sessionId).toBe('test:turn-hook');
    expect(begun[0]?.inputs.map(i => i.message)).toEqual([incoming]);
    expect(begun[0]?.turnId).toEqual(expect.any(String));
    expect(ended.map(e => e.turnId)).toEqual([begun[0]?.turnId]);
  });

  it('不调 next：这一轮不跑、输入不归档、不发 agent:turn:after，流结束标记照发', async () => {
    const { host, recorder, streams, history } = await start();
    let turnId: string | undefined;
    const ended: string[] = [];
    host.hooks.use.middleware('agent:turn:before', async data => {
      turnId = data.turnId;
    });
    host.hooks.use.middleware('agent:turn:after', async (data, next) => {
      ended.push(data.turnId);
      await next();
    });

    await host.agent.use.handleMessage(message('test:turn-blocked'));

    expect(turnId).toEqual(expect.any(String));
    expect(recorder).toEqual([]);
    expect(await history('test:turn-blocked')).toEqual([]);
    expect(ended).toEqual([]);
    expect(streams).toEqual([{ sessionId: 'test:turn-blocked', platform: 'test', turnId, done: true }]);
  });
});

describe('开轮的输入在 agent:turn:before 的默认动作开头归档', () => {
  it('归档的输入带这一轮的回合 id 与进入方式 opened；中间件里读历史还没有它，回合里有', async () => {
    const { host, history } = await start();
    const sessionId = 'test:turn-archive';
    let turnId: string | undefined;
    let beforeNext: Message[] | undefined;
    let inTurn: Message[] | undefined;
    host.hooks.use.middleware('agent:turn:before', async (data, next) => {
      turnId = data.turnId;
      beforeNext = await history(sessionId);
      await next();
    });
    host.hooks.use.middleware('agent:llm:before', async (_data, next) => {
      inTurn ??= await history(sessionId);
      await next();
    });

    await host.agent.use.handleMessage(message(sessionId));

    expect(beforeNext).toEqual([]);
    expect(inTurn?.map(m => [m.role, m.metadata?.turnId, m.metadata?.turnEntry])).toEqual([['user', turnId, 'opened']]);
  });
});

describe('agent:llm:before 带这一轮的中止信号', () => {
  it('停下这一轮时 data.signal 随之断开，这一轮按中止收尾', async () => {
    const { host } = await start();
    const sessionId = 'test:llm-before-signal';
    const signals: Array<AbortSignal | undefined> = [];
    const outcomes: string[] = [];
    host.hooks.use.middleware('agent:turn:after', async (data, next) => {
      outcomes.push(data.outcome);
      await next();
    });
    host.hooks.use.middleware('agent:llm:before', async (data, next) => {
      signals.push(data.signal);
      host.agent.use.abort(sessionId);
      await next();
    });

    await host.agent.use.handleMessage(message(sessionId));

    expect(signals.map(signal => signal?.aborted)).toEqual([true]);
    expect(outcomes).toEqual(['aborted']);
  });
});

describe('回合结束与提示词贡献带这一轮的输入', () => {
  it('agent:turn:after 与贡献的视图带 inputs：inputs[0].message 是入站的那条，archived 是归档的那一条；不带旧的几项', async () => {
    const { host, history } = await start();
    const sessionId = 'test:turn-inputs';
    const incoming = message(sessionId);
    const ended: Array<HookContextMap['agent:turn:after']> = [];
    const views: PromptContributionView[] = [];
    host.hooks.use.middleware('agent:turn:after', async (data, next) => {
      ended.push(data);
      await next();
    });
    host.contributions.use.contribute('agent:prompt', {
      id: 'zz-probe',
      anchor: 'turn-hint',
      build(view) {
        views.push(view);
        return null;
      },
    });

    await host.agent.use.handleMessage(incoming);

    const [stored] = await history(sessionId);
    const expected: TurnInput[] = [{ message: incoming, archived: stored }];
    expect(ended[0]?.inputs).toEqual(expected);
    expect(ended[0]).not.toHaveProperty('message');
    expect(ended[0]).not.toHaveProperty('metadata');
    expect(views[0]?.inputs).toEqual(expected);
    expect(views[0]).not.toHaveProperty('userId');
    expect(views[0]).not.toHaveProperty('triggerType');
  });
});
