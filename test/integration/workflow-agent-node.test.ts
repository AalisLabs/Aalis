import { afterEach, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { gateway, INBOUND_PHASE } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type WorkflowDef, workflow } from '../../packages/api-workflow/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { runDag } from '../../packages/plugin-workflow/src/engine.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 编排的 agent 节点经网关送达（真的网关、流控与 agent，模型是能阻塞某一次调用的替身）：节点的指令在目标会话里排在在跑的一轮之后
// 单独成一轮，节点按自己的异步上下文认出它开的那一轮，不认同一会话里别的回合；同一编排两次运行的同名节点各认各的。指向调用这次
// 运行的会话（那一轮在等这次运行）、指令在网关相位被吞或被放掉没开轮时立即失败，不等满节点超时。
// ════════════════════════════════════════════════════════════

const WORKFLOW = 'zz-flow';
const ANONYMOUS_RUN = toolRequest({ sessionId: `workflow::${WORKFLOW}`, platform: 'workflow' });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 只有一个 agent 节点的编排，指令发往 sessionId */
const nodeTo = (sessionId: string, timeoutSeconds = 60): WorkflowDef => ({
  id: WORKFLOW,
  trigger: { type: 'manual' },
  nodes: [{ id: 'a', type: 'agent', instruction: '<指令>', sessionId, platform: 'webui', timeoutSeconds, out: 'r' }],
});

/** 让排着的微任务与 I/O 回调执行完毕 */
const settle = () => new Promise(resolve => setImmediate(resolve));

async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const model = new StepModel((_request, n) => ({ content: `回${n}` }));
  for (const plugin of [stepModelPlugin(model), toolsPlugin, memoryInMemoryPlugin, gatewayPlugin, agentPlugin]) {
    await app.plugin(plugin, {});
  }
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  app.bind({ provide }).provide.use(storage, memoryStorage(new Map()));
  await app.plugin(flowControlPlugin, {});
  await app.plugins.idle();
  for (const plugin of [gatewayPlugin, agentPlugin, flowControlPlugin]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, plugin.name).toBe('active');
  }
  const host = app.bind({ tools, events, hooks, gateway, agent, flowControl });
  const run = (def: WorkflowDef, runId: string, callerSessionId?: string) =>
    runDag({
      tools: host.tools,
      events: host.events.use,
      hooks: host.hooks.use,
      gateway: host.gateway,
      logger: app.logger,
      def,
      runId,
      vars: {},
      toolCallContext: ANONYMOUS_RUN,
      callerSessionId,
      signal: new AbortController().signal,
    });
  const human = (sessionId: string) =>
    host.agent.use.handleMessage({ content: '<真人>', sessionId, platform: 'webui', userId: 'console' });
  return { app, host, model, run, human };
}

describe('编排的 agent 节点经网关送达', () => {
  it('指向一个有真人回合在跑的会话：排在它之后，捕获的是节点自己那一轮', async () => {
    const s = await boot();
    const first = s.model.hold(1);
    const second = s.model.hold(2);
    const human = s.human('zz-busy');
    await first.entered;
    const running = s.run(nodeTo('zz-busy'), 'r1');
    await settle();
    first.release();
    await human;
    await second.entered;
    second.release();
    const result = await running;
    expect(result.status).toBe('success');
    expect(result.outputs.r).toBe('回2');
  });

  it('同一编排两次运行的同名节点各认各的', async () => {
    const s = await boot();
    const results = await Promise.all([s.run(nodeTo('zz-twice'), 'r1'), s.run(nodeTo('zz-twice'), 'r2')]);
    expect(results.map(r => r.status)).toEqual(['success', 'success']);
    expect(results.map(r => r.outputs.r).sort()).toEqual(['回1', '回2']);
  });

  it('指向发起这次运行的会话：立即失败，不送达', async () => {
    const s = await boot();
    const result = await s.run(nodeTo('zz-caller'), 'r1', 'zz-caller');
    expect(result.status).toBe('failed');
    expect(toSource(result.error)).toContain('发起这次运行的会话');
    expect(s.model.requests).toEqual([]);
  });

  it('经 workflow_run 调用、agent 节点指向调用者所在的会话：立即失败，不送达', async () => {
    const s = await boot();
    await s.app.plugin(cronEnginePlugin, {});
    await s.app.plugin(workflowPlugin, {});
    await s.app.plugins.idle();
    const { tools: registry, workflow: service } = s.app.bind({ tools, workflow });
    await service.use.defineWorkflow(nodeTo('zz-caller'), { persist: false });
    // 没装权限插件：放行这一次调用（只看接线，不看权限）
    registry.use.setExecutionGuard(async () => ({ ok: true }));
    const ctx = toolRequest({ sessionId: 'zz-caller', platform: 'webui', userId: 'console' });
    const out = JSON.parse((await registry.use.execute('workflow_run', { id: WORKFLOW }, ctx)).content);
    expect(out.status).toBe('failed');
    expect(out.nodes[0].error).toContain('发起这次运行的会话');
    expect(s.model.requests).toEqual([]);
  });

  it('指令在网关相位被吞：立即失败，不等满节点超时', async () => {
    const s = await boot();
    s.host.hooks.use.middleware(INBOUND_PHASE.FLOW, async (data, next) => {
      if (data.message.source?.startsWith('workflow:')) return;
      await next();
    });
    const started = Date.now();
    const result = await s.run(nodeTo('zz-swallowed', 5), 'r1');
    expect(result.status).toBe('failed');
    expect(toSource(result.error)).toContain('没开轮');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('排着的指令被禁言放掉：立即失败，不等满节点超时', async () => {
    const s = await boot();
    const first = s.model.hold(1);
    const human = s.human('zz-muted');
    await first.entered;
    const started = Date.now();
    const running = s.run(nodeTo('zz-muted', 5), 'r1');
    await settle();
    s.host.flowControl.use.setMuted('zz-muted', 60, 'webui');
    await human;
    const result = await running;
    expect(result.status).toBe('failed');
    expect(toSource(result.error)).toContain('没开轮');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
