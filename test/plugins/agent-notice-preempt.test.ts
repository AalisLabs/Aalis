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
import { type IncomingMessage, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 真人打断延续其本人身份的宿主通知回合：真人消息（不带 source）到达时，中止同一会话里 hostNotice.callerUserId
// 等于这条消息 userId 的通知回合。别人的消息、不延续任何人身份的通知（白纸等）不受影响；宿主通知从不打断别的回合。
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
  host.tools.register({
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
  host.hooks.middleware('agent:turn:after', async (data, next) => {
    turns.push({ source: data.message.source, outcome: data.outcome });
    await next();
  });
  return { agent: host.agent.require(), held, release, turns };
}

const notice = (callerUserId?: string): IncomingMessage => ({
  content: '后台进程 proc_0a1b2c_1 已退出：退出码 1，用时 3 秒。它最近的输出用 process_read 查看。',
  sessionId: SESSION,
  platform: 'webui',
  source: 'exec-bg:proc_0a1b2c_1',
  actor: callerUserId !== undefined ? { platform: 'webui', userId: callerUserId } : selfInitiatedActor('webui'),
  hostNotice: {
    kind: 'exec-background',
    id: 'proc_0a1b2c_1',
    ...(callerUserId !== undefined ? { callerUserId } : {}),
  },
});

const human = (userId: string): IncomingMessage => ({
  content: '停',
  sessionId: SESSION,
  platform: 'webui',
  userId,
});

describe('真人打断延续其本人身份的宿主通知回合', () => {
  it('安全：通知回合在飞时，本人在同一会话说话，通知回合被中止', async () => {
    const h = await boot();
    const noticeTurn = h.agent.handleMessage(notice('console'));
    await waitFor(() => h.held.length === 1, '通知回合卡在工具上');
    await h.agent.handleMessage(human('console'));
    await noticeTurn;
    expect(h.held[0].signal?.aborted).toBe(true);
    expect(h.turns).toContainEqual({ source: 'exec-bg:proc_0a1b2c_1', outcome: 'aborted' });
    expect(h.turns).toContainEqual({ source: undefined, outcome: 'replied' });
  });

  it('别人的消息不中止通知回合', async () => {
    const h = await boot();
    const noticeTurn = h.agent.handleMessage(notice('console'));
    await waitFor(() => h.held.length === 1, '通知回合卡在工具上');
    await h.agent.handleMessage(human('someone-else'));
    expect(h.held[0].signal?.aborted).toBe(false);
    h.release();
    await noticeTurn;
    expect(h.turns).toContainEqual({ source: 'exec-bg:proc_0a1b2c_1', outcome: 'replied' });
  });

  it('不延续任何人身份的通知（不带 callerUserId）不被真人消息中止', async () => {
    const h = await boot();
    const noticeTurn = h.agent.handleMessage(notice());
    await waitFor(() => h.held.length === 1, '通知回合卡在工具上');
    await h.agent.handleMessage(human('console'));
    expect(h.held[0].signal?.aborted).toBe(false);
    h.release();
    await noticeTurn;
  });

  it('宿主通知到达不中止在飞的真人回合', async () => {
    const h = await boot();
    const humanTurn = h.agent.handleMessage(human('console'));
    await waitFor(() => h.held.length === 1, '真人回合卡在工具上');
    await h.agent.handleMessage(notice('console'));
    expect(h.held[0].signal?.aborted).toBe(false);
    h.release();
    await humanTurn;
    expect(h.turns).toContainEqual({ source: undefined, outcome: 'replied' });
  });
});
