import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 续做与真人消息互不打断：新消息从不中止在跑的一轮。发起它的人在同一会话说话，她的话排在续做那一轮之后单独一轮；宿主通知
// 到达时排在真人的回合之后（带来源的注入各自成一轮，不与别的输入叠加）。
// ════════════════════════════════════════════════════════════

const SESSION = 'zz-slice1-preempt';
const HOLD = 'zz_hold';
const holdDefinition = {
  type: 'function' as const,
  function: { name: HOLD, description: '卡住', parameters: { type: 'object' as const, properties: {} } },
};
const callHold: ChatResponse = {
  content: null,
  toolCalls: [{ id: 'call-hold', type: 'function', function: { name: HOLD, arguments: '{}' } }],
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`等不到：${label}`);
}

/** 模型第一次调用卡住的工具，之后一律回文字；卡住的工具等到放行或本回合中止 */
async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(createMockLLMPlugin({ responses: [callHold, { content: '好' }] }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const name of [toolsPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const host = app.bind({ tools, agent: agentService, hooks });
  const held: ToolCallContext[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  host.tools.use.register({
    definition: holdDefinition,
    handler: async (_args, ctx) => {
      held.push(ctx);
      await Promise.race([
        gate,
        new Promise<void>(resolve => ctx.signal?.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      return 'held';
    },
  });
  const turns: Array<{ source?: string; outcome: string }> = [];
  host.hooks.use.middleware('agent:turn:after', async (data, next) => {
    turns.push({ source: data.inputs[0].message.source, outcome: data.outcome });
    await next();
  });
  return { agent: host.agent.use, held, release, turns };
}

const OWNER = { platform: 'webui', userId: 'console' };

/** 后台任务的结束通知：带着发起它的那一轮（owner 亲手那一轮） */
const notice: IncomingMessage = {
  content: '后台任务 bg_0a1b2c_1（exec）失败：退出码 1，用时 3 秒。结果与输出用 background_output 查看。',
  sessionId: SESSION,
  platform: 'webui',
  source: 'bg:bg_0a1b2c_1',
  fromTurn: { ...OWNER, participants: [OWNER] },
  hostNotice: { kind: 'background-task', id: 'bg_0a1b2c_1' },
};

const human: IncomingMessage = { content: '停', sessionId: SESSION, ...OWNER };

describe('续做与真人消息互不打断', () => {
  it('发起它的人在同一会话说话：续做那一轮不中止，她的话排在它之后单独一轮', async () => {
    const h = await boot();
    const noticeTurn = h.agent.handleMessage(notice);
    await waitFor(() => h.held.length === 1, '续做那一轮卡在工具上');
    const humanTurn = h.agent.handleMessage(human);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.held[0].signal?.aborted).toBe(false);
    expect(h.turns, '她的话排着').toEqual([]);
    h.release();
    await Promise.all([noticeTurn, humanTurn]);
    expect(h.turns).toEqual([
      { source: 'bg:bg_0a1b2c_1', outcome: 'replied' },
      { source: undefined, outcome: 'replied' },
    ]);
  });

  it('宿主通知到达不中止在飞的真人回合，排在它之后单独一轮', async () => {
    const h = await boot();
    const humanTurn = h.agent.handleMessage(human);
    await waitFor(() => h.held.length === 1, '真人回合卡在工具上');
    const noticeTurn = h.agent.handleMessage(notice);
    await new Promise(resolve => setImmediate(resolve));
    expect(h.held[0].signal?.aborted).toBe(false);
    h.release();
    await Promise.all([humanTurn, noticeTurn]);
    expect(h.turns).toEqual([
      { source: undefined, outcome: 'replied' },
      { source: 'bg:bg_0a1b2c_1', outcome: 'replied' },
    ]);
  });
});
