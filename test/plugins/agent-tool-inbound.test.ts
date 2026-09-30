import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { workflow } from '../../packages/api-workflow/src/index.js';
import { App, services } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import { buildMcpServer } from '../../packages/plugin-mcp-server/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import type { IncomingMessage, Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 工具调用的回合来源（ToolCallContext.inbound）：只由 agent 工具循环填写，source 取本回合入站消息的 source。
// 需要「真人发起」判据的工具据此正向判断：inbound 存在且 source 为 undefined 才是真人消息驱动的回合；
// 定时任务等内部注入带着注入方标识；workflow 节点与 mcp-server 自造的上下文没有 inbound。
// ════════════════════════════════════════════════════════════

const SESSION = 'test:tool-inbound';
const PROBE = 'zz_inbound_probe';
const probeDefinition = {
  type: 'function' as const,
  function: { name: PROBE, description: '探针', parameters: { type: 'object' as const, properties: {} } },
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 起一个 agent，模型先调探针工具再收尾，返回探针收到的调用上下文 */
async function agentTurn(incoming: IncomingMessage): Promise<ToolCallContext | undefined> {
  return (await observedAgentTurn(incoming)).ctx;
}

/** 同 agentTurn，另记下 agent:llm:before 看到的入站身份与本会话归档的消息 */
async function observedAgentTurn(incoming: IncomingMessage) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ tools, agent: agentService, hooks, memory });
  const callProbe: ChatResponse = {
    content: null,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: PROBE, arguments: '{}' } }],
  };
  await app.plugin(createMockLLMPlugin({ responses: [callProbe, { content: 'done' }] }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const name of [toolsPlugin.name, agentPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }

  let seen: ToolCallContext | undefined;
  host.tools.register({
    definition: probeDefinition,
    handler: async (_args, ctx) => {
      seen = ctx;
      return 'ok';
    },
  });
  const llmBeforeUserIds: Array<string | undefined> = [];
  const llmBeforeSources: Array<string | undefined> = [];
  host.hooks.middleware('agent:llm:before', async (data, next) => {
    llmBeforeUserIds.push(data.userId);
    llmBeforeSources.push(data.source);
    await next();
  });
  await host.agent.require().handleMessage(incoming);
  expect(seen, '探针工具应在本回合被调用').toBeDefined();
  const history = (await host.memory.require().getHistory(incoming.sessionId, 20)) as Message[];
  return { ctx: seen, llmBeforeUserIds, llmBeforeSources, history };
}

describe('ToolCallContext.inbound：agent 工具循环填写本回合的入站来源', () => {
  it('真人消息回合：inbound 存在，source 为 undefined', async () => {
    const { ctx, llmBeforeSources } = await observedAgentTurn({
      content: '帮我查一下',
      sessionId: SESSION,
      platform: 'test',
      userId: 'u1',
      sessionType: 'private',
    });
    expect(ctx?.inbound).toBeDefined();
    expect(ctx?.inbound?.source).toBeUndefined();
    expect(llmBeforeSources).toEqual([undefined, undefined]);
  });

  it('定时任务注入回合：inbound.source 为 scheduler（actor 非空也分得出来）', async () => {
    const ctx = await agentTurn({
      content: '定时提醒',
      sessionId: SESSION,
      platform: 'test',
      source: 'scheduler',
      actor: { platform: 'test', userId: 'u1' },
    });
    expect(ctx?.inbound?.source).toBe('scheduler');
    expect(ctx?.actor).toEqual({ platform: 'test', userId: 'u1' });
  });
});

describe('宿主通知延续某次调用：hostNotice.callerUserId 只填工具调用上下文的 userId', () => {
  const QQ = '10001';
  const notice = (callerUserId?: string): IncomingMessage => ({
    content: '后台进程 proc_0a1b2c_1 已退出：退出码 1，用时 3 秒。它最近的输出用 process_read 查看。',
    sessionId: SESSION,
    platform: 'onebot',
    source: 'exec-bg:proc_0a1b2c_1',
    actor: { platform: 'onebot', userId: QQ },
    hostNotice: {
      kind: 'exec-background',
      id: 'proc_0a1b2c_1',
      ...(callerUserId !== undefined ? { callerUserId } : {}),
    },
  });

  it('安全：带 callerUserId：探针上下文的 userId 为它，actor、platform、inbound.source 原样；提示词钩子与归档不认它', async () => {
    const { ctx, llmBeforeUserIds, llmBeforeSources, history } = await observedAgentTurn(notice(QQ));
    expect(ctx?.userId).toBe(QQ);
    expect(ctx?.actor).toEqual({ platform: 'onebot', userId: QQ });
    expect(ctx?.platform).toBe('onebot');
    expect(ctx?.inbound?.source).toBe('exec-bg:proc_0a1b2c_1');
    expect(llmBeforeUserIds.length).toBeGreaterThan(0);
    expect(llmBeforeUserIds.every(u => u === undefined)).toBe(true);
    expect(llmBeforeSources).toEqual(['exec-bg:proc_0a1b2c_1', 'exec-bg:proc_0a1b2c_1']);
    const archived = history.find(m => m.role === 'notice');
    expect(archived, '通知应归档为 notice').toBeDefined();
    expect(archived?.name).toBeUndefined();
    expect(archived?.metadata?.userId).toBeUndefined();
  });

  it('安全：不带 callerUserId 的宿主通知：探针上下文的 userId 为 undefined', async () => {
    const { ctx, llmBeforeUserIds } = await observedAgentTurn(notice());
    expect(ctx?.userId).toBeUndefined();
    expect(ctx?.actor).toEqual({ platform: 'onebot', userId: QQ });
    expect(llmBeforeUserIds.every(u => u === undefined)).toBe(true);
  });
});

describe('ToolCallContext.inbound：其他调用方不填写', () => {
  it('workflow 的 tool 节点（含由调用者触发的 run）：inbound 为 undefined', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
    const host = app.bind({ tools, services });
    let seen: ToolCallContext | undefined;
    host.tools.register({
      definition: probeDefinition,
      handler: async (_args, ctx) => {
        seen = ctx;
        return 'ok';
      },
    });
    await app.plugin(workflowPlugin, { enableTools: false });
    await app.plugins.idle();
    for (const name of [toolsPlugin.name, cronEnginePlugin.name, workflowPlugin.name]) {
      expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
    }
    const svc = host.services.get(workflow);
    if (!svc) throw new Error('workflow 服务不在场');
    await svc.defineWorkflow(
      { id: 'zz-inbound', trigger: { type: 'manual' }, nodes: [{ id: 'a', type: 'tool', tool: PROBE }] },
      { persist: false },
    );
    const run = await svc.runWorkflow('zz-inbound', {}, 'manual', { platform: 'test', userId: 'u1' });
    expect(run.status).toBe('success');
    expect(seen, '探针工具应被 tool 节点调用').toBeDefined();
    expect(seen?.actor, '调用者身份照常透传').toEqual({ platform: 'test', userId: 'u1' });
    expect(seen?.inbound).toBeUndefined();
  });

  it('mcp-server 的 CallTool：inbound 为 undefined', async () => {
    let seen: ToolCallContext | undefined;
    const stub = {
      getAll: () => [{ name: PROBE, description: '探针', pluginName: 'test', visibility: 'public' }],
      getDefinitions: () => [probeDefinition],
      execute: async (_name: string, _args: Record<string, unknown>, ctx: ToolCallContext) => {
        seen = ctx;
        return { content: 'ok' };
      },
    };
    const server = buildMcpServer(stub as never, {
      port: 0,
      bind: '127.0.0.1',
      toolGroups: [],
      allowRestricted: false,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: PROBE, arguments: {} });
      expect(res.isError ?? false).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
    expect(seen, '探针工具应经 CallTool 被调用').toBeDefined();
    expect(seen?.inbound).toBeUndefined();
  });
});
