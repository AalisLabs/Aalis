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
