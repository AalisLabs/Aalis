import type { IncomingMessage } from '@aalis/schema-message';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, events, hooks, provide } from '../../packages/core/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';

// ════════════════════════════════════════════════════════════
// delegate_to_session 的防雪崩：深度随消息走，不按会话计时。
//
// 定下的语义：委派消息驱动的那一个回合内禁止再委派；回合结束即解除；
// 真人消息的回合不受影响。故：
//   1. 被委派回合内 delegate 被拒；
//   2. agent:turn:after 之后同一会话可以 delegate；
//   3. 同会话下一条真人消息（不带 proactiveDepth）立即解锁；
//   4. 没有任何时间窗——被委派回合里等再久也照样被拒（原 10 分钟 TTL 已不存在）；
//   5. 登记点在 agent:input:before，是所有投递路径的汇合处——inbound:message 事件与
//      gateway.ingressMessage() 直投都要过它，因此两条路都上锁。
// ════════════════════════════════════════════════════════════

type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

interface Harness {
  handler: Handler;
  /** 经 inbound:message 事件投递（伪 gateway 监听后转内部处理路径） */
  emitInbound: (msg: Partial<IncomingMessage> & { sessionId: string }) => Promise<void>;
  /** 直接调 gateway.ingressMessage() 投递——不过事件总线 */
  ingress: (msg: Partial<IncomingMessage> & { sessionId: string }) => Promise<void>;
  runTurnAfter: (sessionId: string) => Promise<void>;
  emitted: IncomingMessage[];
}

const booted: App[] = [];

const makeIncoming = (msg: Partial<IncomingMessage> & { sessionId: string }): IncomingMessage => ({
  content: '任务正文',
  platform: 'onebot',
  ...msg,
});

async function setup(): Promise<Harness> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  booted.push(app);
  const host = app.bind({ provide, events, hooks });

  const handlers = new Map<string, Handler>();
  host.provide(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      const name = tool.definition.function.name;
      handlers.set(name, tool.handler as unknown as Handler);
      return () => void handlers.delete(name);
    },
    registerGroup: () => () => {},
  } as never);

  // 伪 gateway + agent：ingressMessage 与 inbound:message 监听共用同一条内部处理路径，
  // 该路径以 agent:input:before 钩子开场——与 plugin-gateway / plugin-agent 同构。
  const processInbound = async (message: IncomingMessage): Promise<void> => {
    await host.hooks.run('agent:input:before', { message, metadata: {} });
  };

  const emitted: IncomingMessage[] = [];
  host.events.on('inbound:message', async message => {
    emitted.push(message);
    await processInbound(message);
  });

  await app.plugins.register(sessionTools, {});
  await app.plugins.idle();

  const handler = handlers.get('delegate_to_session');
  if (!handler) throw new Error('delegate_to_session 未注册');
  return {
    handler,
    emitted,
    emitInbound: async msg => {
      await host.events.emit('inbound:message', makeIncoming(msg));
    },
    ingress: async msg => {
      await processInbound(makeIncoming(msg));
    },
    runTurnAfter: async sessionId => {
      await host.hooks.run('agent:turn:after', {
        message: makeIncoming({ sessionId }),
        reply: '',
        outcome: 'replied',
        sessionId,
        metadata: {},
      });
    },
  };
}

const delegate = (h: Harness, fromSession: string, target: string) =>
  h
    .handler(
      { target_session_id: target, task: '去做某事', wait_for_result: false },
      { sessionId: fromSession, platform: 'onebot', userId: 'user-a' },
    )
    .then(r => JSON.parse(r) as { delegated?: boolean; error?: string });

afterEach(async () => {
  vi.useRealTimers();
  for (const app of booted.splice(0)) await app.stop();
});

describe('delegate_to_session 回合深度防雪崩', () => {
  it('委派注入的 IncomingMessage 带 proactiveDepth=1', async () => {
    const h = await setup();
    await delegate(h, 'src-a', 'onebot:1:group:100');
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].proactiveDepth).toBe(1);
  });

  it('被委派回合内：delegate 被拒', async () => {
    const h = await setup();
    await h.emitInbound({ sessionId: 'onebot:1:group:101', proactiveDepth: 1, triggerType: 'proactive' });
    const res = await delegate(h, 'onebot:1:group:101', 'onebot:1:group:999');
    expect(res.error).toBe('本回合由委派消息驱动，不能再委派');
    expect(res.delegated).toBeUndefined();
  });

  it('回合结束（agent:turn:after）即解除', async () => {
    const h = await setup();
    const sid = 'onebot:1:group:102';
    await h.emitInbound({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).error).toBe('本回合由委派消息驱动，不能再委派');
    await h.runTurnAfter(sid);
    expect((await delegate(h, sid, 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('同会话下一条真人消息的回合不受影响（哪怕没等到 turn:after）', async () => {
    const h = await setup();
    const sid = 'onebot:1:group:103';
    await h.emitInbound({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).error).toBe('本回合由委派消息驱动，不能再委派');
    await h.emitInbound({ sessionId: sid, triggerType: 'immediate' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('经 gateway.ingressMessage 投递的委派消息同样上锁', async () => {
    const h = await setup();
    const sid = 'onebot:1:group:107';
    await h.ingress({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).error).toBe('本回合由委派消息驱动，不能再委派');
    await h.runTurnAfter(sid);
    expect((await delegate(h, sid, 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('其他会话的委派回合不影响本会话', async () => {
    const h = await setup();
    await h.emitInbound({ sessionId: 'onebot:1:group:104', proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, 'onebot:1:group:105', 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('没有时间窗：委派回合里过 11 分钟仍被拒（原 10 分钟 TTL 已不存在）', async () => {
    const h = await setup();
    const sid = 'onebot:1:group:106';
    vi.useFakeTimers();
    await h.emitInbound({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const res = await delegate(h, sid, 'onebot:1:group:999');
    expect(res.error).toBe('本回合由委派消息驱动，不能再委派');
  });
});
