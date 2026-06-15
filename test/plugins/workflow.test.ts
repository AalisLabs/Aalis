import { describe, expect, it, vi } from 'vitest';
import type { Context, Logger } from '../../packages/core/src/index.js';
import { runDag, validateGraph } from '../../packages/plugin-workflow/src/engine.js';
import type { WorkflowDef } from '../../packages/plugin-workflow-api/src/index.js';

const noopLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => noopLogger(),
  }) as unknown as Logger;

const fakeCtx = (toolFn?: (name: string, args: unknown) => Promise<string> | string): Context => {
  const tools = toolFn
    ? {
        async execute(name: string, args: unknown) {
          return await toolFn(name, args);
        },
      }
    : undefined;
  return {
    getService(name: string) {
      return name === 'tools' ? tools : undefined;
    },
    emit: vi.fn(async () => {}),
  } as unknown as Context;
};

interface AgentReply {
  reply: string;
  outcome?: 'replied' | 'silent' | 'aborted' | 'error';
}

/**
 * 模拟一个会响应 inbound:message 的 ctx：emit('inbound:message') 时按 replyFor 决定回复，
 * 若有回复则同步触发已注册的 'agent:turn:after' 中间件（仿 agent 跑完一轮）。
 * replyFor 返回 null 表示"无 agent 应答"（用于触发超时路径）。
 */
const agentCtx = (
  replyFor: (sessionId: string, content: string) => AgentReply | null,
  emitted: Array<{ sessionId: string; content: string; platform?: string }> = [],
): Context => {
  const handlers: Array<(data: unknown, next: () => Promise<void>) => Promise<void>> = [];
  return {
    getService: () => undefined,
    middleware(hook: string, handler: (data: unknown, next: () => Promise<void>) => Promise<void>) {
      if (hook !== 'agent:turn:after') return () => {};
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    async emit(event: string, msg: { sessionId: string; content: string; platform?: string }) {
      if (event !== 'inbound:message') return;
      emitted.push({ sessionId: msg.sessionId, content: msg.content, platform: msg.platform });
      const r = replyFor(msg.sessionId, msg.content);
      if (!r) return;
      const data = {
        message: msg,
        reply: r.reply,
        outcome: r.outcome ?? 'replied',
        sessionId: msg.sessionId,
        metadata: {},
      };
      for (const h of [...handlers]) await h(data, async () => {});
    },
  } as unknown as Context;
};

describe('workflow validateGraph', () => {
  it('接受合法 DAG', () => {
    const def: WorkflowDef = {
      id: 'w1',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'wait', seconds: 0 },
        { id: 'b', type: 'wait', seconds: 0, deps: ['a'] },
      ],
    };
    expect(validateGraph(def)).toBeNull();
  });

  it('拒绝重复 id', () => {
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'wait', seconds: 0 },
        { id: 'a', type: 'wait', seconds: 0 },
      ],
    };
    expect(validateGraph(def)).toMatch(/重复/);
  });

  it('拒绝未知 dep', () => {
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', type: 'wait', seconds: 0, deps: ['x'] }],
    };
    expect(validateGraph(def)).toMatch(/未知 dep/);
  });

  it('检测自引用', () => {
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', type: 'wait', seconds: 0, deps: ['a'] }],
    };
    expect(validateGraph(def)).toMatch(/自引用/);
  });

  it('检测环', () => {
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'wait', seconds: 0, deps: ['b'] },
        { id: 'b', type: 'wait', seconds: 0, deps: ['a'] },
      ],
    };
    expect(validateGraph(def)).toMatch(/环/);
  });

  it('按类型校验必填字段（定义期就报清晰错，而非运行期 cryptic）', () => {
    const wrap = (node: unknown): WorkflowDef => ({
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [node as WorkflowDef['nodes'][number]],
    });
    expect(validateGraph(wrap({ id: 'a', type: 'agent' }))).toMatch(/instruction/);
    expect(validateGraph(wrap({ id: 'a', type: 'tool' }))).toMatch(/tool/);
    expect(validateGraph(wrap({ id: 'a', type: 'send-message', sessionId: 's' }))).toMatch(/content/);
    expect(validateGraph(wrap({ id: 'a', type: 'send-message', content: 'x' }))).toMatch(/sessionId/);
    expect(validateGraph(wrap({ id: 'a', type: 'wait' }))).toMatch(/seconds/);
    expect(validateGraph(wrap({ id: 'a', type: 'mystery' }))).toMatch(/类型未知/);
    // 合法 agent 节点通过
    expect(validateGraph(wrap({ id: 'a', type: 'agent', instruction: '干活' }))).toBeNull();
  });
});

describe('workflow runDag', () => {
  it('按 deps 顺序执行 tool 节点 + 模板插值', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const ctx = fakeCtx(async (name, args) => {
      calls.push({ name, args });
      if (name === 't1') return 'hello';
      if (name === 't2') return `got:${(args as { msg: string }).msg}`;
      return '';
    });
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'tool', tool: 't1', args: {}, out: 'a_out' },
        {
          id: 'b',
          type: 'tool',
          tool: 't2',
          args: { msg: '{{outputs.a_out}}' },
          deps: ['a'],
        },
      ],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'r1',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('success');
    expect(calls).toEqual([
      { name: 't1', args: {} },
      { name: 't2', args: { msg: 'hello' } },
    ]);
    expect(res.outputs.a_out).toBe('hello');
  });

  it('节点失败后下游被 skipped', async () => {
    const ctx = fakeCtx(async name => {
      if (name === 'fail') throw new Error('boom');
      return 'ok';
    });
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'tool', tool: 'fail', args: {} },
        { id: 'b', type: 'tool', tool: 'ok', args: {}, deps: ['a'] },
      ],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'r2',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/boom/);
    expect(res.nodes.find(n => n.id === 'a')?.status).toBe('failed');
    expect(res.nodes.find(n => n.id === 'b')?.status).toBe('skipped');
  });

  it('并行执行同一层节点', async () => {
    let active = 0;
    let peak = 0;
    const ctx = fakeCtx(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      return 'x';
    });
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'tool', tool: 't', args: {} },
        { id: 'b', type: 'tool', tool: 't', args: {} },
        { id: 'c', type: 'tool', tool: 't', args: {} },
      ],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'r3',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('success');
    expect(peak).toBeGreaterThanOrEqual(2);
  });
});

describe('workflow agent 节点', () => {
  it('派发→等回复→out 入 outputs，下游 agent 经 deps 接收上游结果（编排管道）', async () => {
    const emitted: Array<{ sessionId: string; content: string }> = [];
    const ctx = agentCtx((_sid, content) => {
      if (content.includes('请分解')) return { reply: '子任务结果X' };
      if (content.includes('子任务结果X')) return { reply: '聚合完成' };
      return { reply: '?' };
    }, emitted);
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', type: 'agent', instruction: '请分解任务', out: 'aOut' },
        { id: 'b', type: 'agent', instruction: '基于上游：{{outputs.aOut}}', deps: ['a'], out: 'bOut' },
      ],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'rA',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('success');
    expect(res.outputs.aOut).toBe('子任务结果X');
    expect(res.outputs.bOut).toBe('聚合完成');
    // 下游 b 的指令应已插值上游结果
    expect(emitted[1].content).toContain('子任务结果X');
    // 省略 sessionId → 一次性隔离子会话 workflow:agent:<runId>:<nodeId>
    expect(emitted[0].sessionId).toBe('workflow:agent:rA:a');
    expect(emitted[1].sessionId).toBe('workflow:agent:rA:b');
  });

  it('显式 sessionId/platform + vars 插值', async () => {
    const emitted: Array<{ sessionId: string; content: string; platform?: string }> = [];
    const ctx = agentCtx(() => ({ reply: 'ok' }), emitted);
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [
        {
          id: 'a',
          type: 'agent',
          instruction: '通知 {{vars.who}}',
          sessionId: 'onebot:{{vars.who}}',
          platform: 'onebot',
        },
      ],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'rS',
      triggerSource: 'test',
      vars: { who: '群A' },
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('success');
    expect(emitted[0].content).toBe('通知 群A');
    expect(emitted[0].sessionId).toBe('onebot:群A');
    expect(emitted[0].platform).toBe('onebot');
  });

  it('超时（无 agent 应答）→ 节点失败', async () => {
    const ctx = agentCtx(() => null);
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', type: 'agent', instruction: 'x', timeoutSeconds: 0.05 }],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'rT',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/超时/);
  });

  it('outcome=error → 节点失败', async () => {
    const ctx = agentCtx(() => ({ reply: '', outcome: 'error' }));
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', type: 'agent', instruction: 'x' }],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'rE',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/outcome=error/);
  });

  it('outcome=silent → 成功且输出空串（agent 选择不回复是合法结果）', async () => {
    const ctx = agentCtx(() => ({ reply: '', outcome: 'silent' }));
    const def: WorkflowDef = {
      id: 'w',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', type: 'agent', instruction: 'x', out: 'r' }],
    };
    const res = await runDag({
      ctx,
      logger: noopLogger(),
      def,
      runId: 'rSilent',
      triggerSource: 'test',
      vars: {},
      toolCallContext: {} as never,
      cancelToken: { cancelled: false },
    });
    expect(res.status).toBe('success');
    expect(res.outputs.r).toBe('');
  });
});
