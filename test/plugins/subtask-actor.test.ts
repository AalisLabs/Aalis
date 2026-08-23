import type { Context } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { describe, expect, it } from 'vitest';
import { apply } from '../../packages/plugin-subtask/src/index.js';

// ════════════════════════════════════════════════════════════
// create_subtask 的授权身份透传（schema-message actor 契约）。
//
// 子任务消息的 userId 是归档用的物理来源标记（`parent:<id>`，authority 查不到，
// 等价匿名）；授权身份走 actor——子任务工具以创建者的权限等级执行。
// 不变量与 delegate_to_session 同：有身份透传 / 匿名不发明 / 只认 callCtx snapshot。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

function setup(): { handlers: Map<string, Handler>; emitted: Array<{ event: string; payload: IncomingMessage }> } {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: IncomingMessage }> = [];
  const fakeTools = {
    register: (tool: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => {},
  };
  const fakeSessionManager = {
    getSession: () => undefined,
    resolveConfig: () => ({}),
    createChildSession: async () => ({ id: 'child-session-1' }),
  };
  const logger = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    child: () => logger,
  };
  const ctx = {
    id: '@aalis/plugin-subtask',
    logger,
    getService: (name: string) => {
      if (name === 'tools') return fakeTools;
      if (name === 'session-manager') return fakeSessionManager;
      return undefined;
    },
    whenService: (name: string, cb: (svc: unknown) => void) => {
      if (name === 'tools') cb(fakeTools);
      return () => {};
    },
    emit: async (event: string, payload: IncomingMessage) => {
      emitted.push({ event, payload });
    },
    onDispose: () => {},
    provide: () => {},
    on: () => () => {},
    contribute: () => () => {},
    middleware: () => () => {},
    runHook: async () => {},
  } as unknown as Context;
  apply(ctx, {});
  return { handlers, emitted };
}

describe('create_subtask actor 透传', () => {
  it('有身份的创建者：actor 回填，userId 仍为 parent 标记（物理来源与授权身份分离）', async () => {
    const { handlers, emitted } = setup();
    const handler = handlers.get('create_subtask');
    expect(handler, 'create_subtask 未注册').toBeDefined();

    const res = JSON.parse(
      await handler!({ task: '做一件事' }, { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a' }),
    );
    expect(res.subtaskId).toBe('child-session-1');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe('inbound:message');
    expect(emitted[0].payload.userId).toBe('parent:parent-1');
    expect(emitted[0].payload.actor).toEqual({ platform: 'onebot', userId: 'user-a' });
  });

  it('匿名创建者：不发明身份，actor 缺省', async () => {
    const { handlers, emitted } = setup();
    const handler = handlers.get('create_subtask')!;

    await handler({ task: '做一件事' }, { sessionId: 'parent-1' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload.actor).toBeUndefined();
  });
});
