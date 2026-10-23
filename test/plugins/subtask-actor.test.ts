import { describe, expect, it } from 'vitest';
import { originTurnOf } from '../../packages/api-authority/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import type { FromTurn, IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type RequestDraft, toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 子任务消息（派发与追问）的身份。userId 是归档用的物理来源标记（`parent:<id>`，authority 查不到，等价匿名）。
// - 调用在入站回合里：带着派它的那一轮（fromTurn：平台、发言者、参与者、来源与那一轮自己的 fromTurn），不带 actor；
//   子任务那一轮的授权身份取它的参与者，权限服务按它判子任务这一轮的主体。
// - 调用不在入站回合里（编排的工具节点、mcp-server）：不带 fromTurn，授权身份照旧走 actor。
// 不变量：有身份透传 / 匿名不发明 / 只认 callCtx snapshot。
// ════════════════════════════════════════════════════════════

/** 工具的处理函数：上下文没写参与者的按一条消息的口径补上（toolContext） */
type Handler = (args: Record<string, unknown>, callCtx: RequestDraft) => Promise<string>;

async function setup(): Promise<{
  app: App;
  handlers: Map<string, Handler>;
  inbound: IncomingMessage[];
}> {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, services, events });
  const handlers = new Map<string, Handler>();
  host.provide.use(tools, {
    register(tool: { definition: { function: { name: string } }; handler: RegisteredTool['handler'] }) {
      handlers.set(tool.definition.function.name, async (args, ctx) =>
        String(await tool.handler(args, toolContext(ctx))),
      );
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(sessionManager, {
    // parent-1 无 parentId（非嵌套）；child-session-1 供 send_to_subtask 的归属校验
    getSession: (id: string) => (id === 'child-session-1' ? { id, parentId: 'parent-1', status: 'active' } : undefined),
    listSessions: () => [],
    createChildSession: async () => ({ id: 'child-session-1' }),
    updateSession: async () => {},
  } as never);
  // 会话设置的替身：父会话没有各层的值，子会话不写下什么
  host.provide.use(sessionSettings, {
    register: () => () => {},
    chain: () => ({ parts: [] }),
    childMetadata: () => ({}),
  } as never);

  // 派发走 inbound:message 事件，追问经网关送达：两个出口收到的都记下
  const inbound: IncomingMessage[] = [];
  host.events.use.on('inbound:message', message => {
    inbound.push(message);
  });
  host.provide.use(gateway, {
    ingressMessage: async (message: IncomingMessage) => void inbound.push(message),
  } as never);

  await app.plugins.register(subtask, {});
  await app.plugins.idle();
  return { app, handlers, inbound };
}

describe('子任务消息是内部注入', () => {
  it("安全：派发与追问都带 source 'subtask'：指令的意图确认不认它们，真人判据也不把子任务回合当成真人当面发起", async () => {
    const { app, handlers, inbound } = await setup();
    await handlers.get('create_subtask')!(
      { task: '做一件事' },
      { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a' },
    );
    await handlers.get('send_to_subtask')!(
      { subtask_id: 'child-session-1', message: '继续' },
      { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a' },
    );
    expect(inbound.map(m => m.source)).toEqual(['subtask', 'subtask']);
    await app.stop();
  });
});

describe('入站回合里派出的：带着派它的那一轮', () => {
  const OWNER = { platform: 'webui', userId: 'console' };
  /** owner 亲手那一轮 */
  const HAND: FromTurn = { platform: 'webui', userId: 'console', participants: [OWNER] };

  it('人亲手那一轮派的：fromTurn 是那一轮的事实，不带 actor；子任务那一轮的授权身份取它的参与者', async () => {
    const { app, handlers, inbound } = await setup();
    await handlers.get('create_subtask')!(
      { task: '做一件事' },
      { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a', inbound: { messageId: 'm1' } },
    );
    expect(inbound).toHaveLength(1);
    expect(inbound[0].fromTurn).toEqual({
      platform: 'onebot',
      userId: 'user-a',
      participants: [{ platform: 'onebot', userId: 'user-a' }],
    });
    expect(inbound[0].actor).toBeUndefined();
    expect(inbound[0].userId).toBe('parent:parent-1');
    expect(originTurnOf([inbound[0]])).toMatchObject({
      userId: 'parent:parent-1',
      participants: [{ platform: 'onebot', userId: 'user-a' }],
      inbound: { source: 'subtask', fromTurn: inbound[0].fromTurn },
    });
    await app.stop();
  });

  it('续做那一轮派的：来源与那一轮自己的 fromTurn 一并带上，参与者是那一轮的授权身份', async () => {
    const { app, handlers, inbound } = await setup();
    await handlers.get('create_subtask')!(
      { task: '做一件事' },
      {
        sessionId: 'parent-1',
        platform: 'webui',
        userId: 'console',
        participants: [OWNER],
        inbound: { source: 'bg:bg_x_1', fromTurn: HAND },
      },
    );
    expect(inbound[0].fromTurn).toEqual({
      platform: 'webui',
      userId: 'console',
      participants: [OWNER],
      source: 'bg:bg_x_1',
      fromTurn: HAND,
    });
    expect(inbound[0].actor).toBeUndefined();
    await app.stop();
  });

  it('没有人的那一轮派的：参与者无主体，不发明身份', async () => {
    const { app, handlers, inbound } = await setup();
    await handlers.get('create_subtask')!(
      { task: '做一件事' },
      { sessionId: 'parent-1', platform: 'webui', inbound: { source: 'idle-trigger' } },
    );
    expect(inbound[0].fromTurn).toEqual({
      platform: 'webui',
      participants: [{ platform: 'webui', userId: '' }],
      source: 'idle-trigger',
    });
    expect(inbound[0].actor).toBeUndefined();
    await app.stop();
  });

  it('几个人的一轮派的：fromTurn 带着这次调用的参与者（批过的是批的人）', async () => {
    const { app, handlers, inbound } = await setup();
    const MEMBER = { platform: 'onebot', userId: '30001' };
    await handlers.get('create_subtask')!(
      { task: '做一件事' },
      { sessionId: 'parent-1', platform: 'onebot', participants: [OWNER, MEMBER], inbound: {} },
    );
    expect(inbound[0].fromTurn).toEqual({ platform: 'onebot', participants: [OWNER, MEMBER] });
    expect(inbound[0].actor).toBeUndefined();
    await app.stop();
  });

  it('send_to_subtask 同样：追问带着发出它的那一轮', async () => {
    const { app, handlers, inbound } = await setup();
    await handlers.get('send_to_subtask')!(
      { subtask_id: 'child-session-1', message: '继续' },
      { sessionId: 'parent-1', platform: 'onebot', userId: 'user-a', inbound: {} },
    );
    expect(inbound).toHaveLength(1);
    expect(inbound[0].fromTurn).toEqual({
      platform: 'onebot',
      userId: 'user-a',
      participants: [{ platform: 'onebot', userId: 'user-a' }],
    });
    expect(inbound[0].actor).toBeUndefined();
    expect(inbound[0].userId).toBe('parent:parent-1');
    await app.stop();
  });
});

describe('不在入站回合里派出的（编排的工具节点、mcp-server）：不带 fromTurn，授权身份走 actor（唯一的参与者）', () => {
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
    expect(inbound[0].fromTurn).toBeUndefined();
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

  it('链式：参与者（授权身份）优先于物理身份', async () => {
    const { app, handlers, inbound } = await setup();
    const handler = handlers.get('create_subtask')!;

    await handler(
      { task: '做一件事' },
      {
        sessionId: 'parent-1',
        platform: 'onebot',
        userId: 'phys',
        participants: [{ platform: 'webui', userId: 'console' }],
      },
    );
    expect(inbound[0].actor).toEqual({ platform: 'webui', userId: 'console' });
    await app.stop();
  });

  it('几个参与者：没有单一的授权身份，actor 缺省', async () => {
    const { app, handlers, inbound } = await setup();
    await handlers.get('create_subtask')!(
      { task: '做一件事' },
      {
        sessionId: 'parent-1',
        platform: 'workflow',
        participants: [
          { platform: 'onebot', userId: '30001' },
          { platform: 'onebot', userId: '30002' },
        ],
      },
    );
    expect(inbound[0].actor).toBeUndefined();
    expect(inbound[0].fromTurn).toBeUndefined();
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
