import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { approvals } from '../../packages/api-approval/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatModelRequest, ChatResponse } from '../../packages/api-llm/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { memoryStorage } from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 无人值守：不连任何界面，owner 在自己的会话里交代一个多步任务，其中一步需要确认。整条真实链路
// （agent 工具循环、工具注册表、权限守卫、审批服务）跑完：需要确认的那步立即按没人在场拒绝，
// 模型收到原因后换一步继续，回合正常结束，全程没有等审批的挂起（等满 300 秒才结算会撞上用例时限）。
// ════════════════════════════════════════════════════════════

const DEPLOY = 'zz_deploy';
const NOTES = 'zz_write_notes';

const call = (id: string, name: string, args: Record<string, unknown>): ChatResponse => ({
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('无人值守的多步任务', () => {
  it('需要确认的一步按没人在场拒绝，模型收到原因后继续，回合正常结束', async () => {
    const { app } = hostedApp({});
    apps.push(app);
    await registerHubs(app);
    await app.plugin(memoryInMemoryPlugin);
    const home = mkdtempSync(join(tmpdir(), 'aalis-unattended-'));
    homes.push(home);
    const { state } = provideHostPaths(app, home);
    const host = app.bind({ provide, events, hooks, tools, agent, approvals });
    host.provide(storage, memoryStorage(new Map()));

    const recorder: ChatModelRequest[] = [];
    const responses = [
      call('call-1', DEPLOY, { command: 'deploy --prod' }),
      call('call-2', NOTES, { text: '部署需要 owner 在场批准' }),
      { content: '部署需要你批准，已把步骤记进笔记。' },
    ];
    await app.plugin(createMockLLMPlugin({ responses, recorder }));
    await app.plugin(toolsPlugin, {});
    await app.plugin(authorityPlugin, {});
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(agentPlugin, { systemPrompt: 'test', maxToolIterations: 5 });
    await app.plugins.idle();
    for (const definition of [toolsPlugin, authorityPlugin, sessionServerPlugin, agentPlugin]) {
      expect(app.plugins.getPlugin(definition.name)?.state, `${definition.name} 未激活`).toBe('active');
    }

    const runs: string[] = [];
    const probe = (name: string, confirm?: 'session') =>
      host.tools.register({
        confirm,
        definition: {
          type: 'function',
          function: { name, description: '探针', parameters: { type: 'object', properties: {} } },
        },
        handler: async () => {
          runs.push(name);
          return `${name} 完成`;
        },
      });
    probe(DEPLOY, 'session');
    probe(NOTES);

    const outcomes: string[] = [];
    host.hooks.middleware('agent:turn:after', async (data, next) => {
      outcomes.push(data.outcome);
      await next();
    });
    const replies: string[] = [];
    host.events.on('outbound:message', msg => void replies.push(msg.content));

    await host.agent.require().handleMessage({
      content: '把服务部署上线，再记一下步骤',
      sessionId: 'cli-default',
      platform: 'cli',
      userId: 'console',
    });

    expect(runs, '需要确认的一步不得执行，后面一步照常执行').toEqual([NOTES]);
    const toolResults = recorder[1]?.messages.filter(m => m.role === 'tool').map(m => String(m.content)) ?? [];
    expect(toolResults.join('\n')).toContain('没人在场');
    expect(recorder).toHaveLength(3);
    expect(outcomes).toEqual(['replied']);
    expect(replies).toContain('部署需要你批准，已把步骤记进笔记。');
    expect(host.approvals.require().list(), '没有留下未结的审批').toEqual([]);

    const read = () =>
      readFileSync(join(state, 'audit', 'approvals.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    await vi.waitFor(() => expect(read()).toHaveLength(2));
    expect(read()).toMatchObject([
      { type: 'request', tool: DEPLOY, origin: { kind: 'owner', platform: 'cli', userId: 'console' } },
      { type: 'decision', state: 'expired', source: 'absent' },
    ]);
  });
});
