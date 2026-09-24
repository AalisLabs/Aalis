import { describe, expect, it } from 'vitest';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// create_subtask 的授权身份透传（schema-message actor 契约）。
//
// 子任务消息的 userId 是归档用的物理来源标记（`parent:<id>`，authority 查不到，
// 等价匿名）；授权身份走 actor——子任务工具以创建者的权限等级执行。
// 不变量与 delegate_to_session 同：有身份透传 / 匿名不发明 / 只认 callCtx snapshot。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

async function setup(): Promise<{
  app: App;
  handlers: Map<string, Handler>;
  inbound: IncomingMessage[];
}> {
  const app = new App({ name: 'T', logLevel: 'error' });
  const host = app.bind({ provide, services, events });
  const handlers = new Map<string, Handler>();
  host.provide(tools, {
    register(tool: { definition: { function: { name: string } }; handler: Handler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(sessionManager, {
    // parent-1 无 parentId（非嵌套）；child-session-1 供 send_to_subtask 的归属校验
    getSession: (id: string) => (id === 'child-session-1' ? { id, parentId: 'parent-1', status: 'active' } : undefined),
    resolveConfig: () => ({}),
    createChildSession: async () => ({ id: 'child-session-1' }),
    updateSession: async () => {},
  } as never);

  // 派发走的是 inbound:message 通道：只订阅这一个事件，收到即证明通道正确
  const inbound: IncomingMessage[] = [];
  host.events.on('inbound:message', message => {
    inbound.push(message);
  });

  await app.plugins.register(subtask, {});
  await app.plugins.idle();
  return { app, handlers, inbound };
}

describe('create_subtask actor 透传', () => {
  it('有身份的创建者：actor 回填，userId 仍为 parent 标记（物理来源与授权身份分离）', async () => {
    const { app, handlers, inbound } = await setup();
    const handler = handlers.get('create_subtask');
    expect(handler, 'create_subtask 未注册').toBeDefined();

    const res = JSON.parse(
      await handler!({ task: '做一件事' }, { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a' }),
    );
    expect(res.subtaskId).toBe('child-session-1');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].userId).toBe('parent:parent-1');
    expect(inbound[0].actor).toEqual({ platform: 'onebot', userId: 'user-a' });
    await app.stop();
  });

  it('匿名创建者：不发明身份，actor 缺省', async () => {
    const { app, handlers, inbound } = await setup();
    const handler = handlers.get('create_subtask')!;

    await handler({ task: '做一件事' }, { sessionId: 'parent-1' });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].actor).toBeUndefined();
    await app.stop();
  });

  it('链式：callCtx.actor 优先于物理身份', async () => {
    const { app, handlers, inbound } = await setup();
    const handler = handlers.get('create_subtask')!;

    await handler(
      { task: '做一件事' },
      { sessionId: 'parent-1', platform: 'onebot', userId: 'phys', actor: { platform: 'webui', userId: 'console' } },
    );
    expect(inbound[0].actor).toEqual({ platform: 'webui', userId: 'console' });
    await app.stop();
  });

  it('send_to_subtask 同约束：追问轮不掉权（与创建轮同源透传）', async () => {
    const { app, handlers, inbound } = await setup();
    const handler = handlers.get('send_to_subtask');
    expect(handler, 'send_to_subtask 未注册').toBeDefined();

    await handler!(
      { subtask_id: 'child-session-1', message: '继续' },
      { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a' },
    );
    expect(inbound).toHaveLength(1);
    expect(inbound[0].actor).toEqual({ platform: 'onebot', userId: 'user-a' });
    expect(inbound[0].userId).toBe('parent:parent-1');
    await app.stop();
  });
});
