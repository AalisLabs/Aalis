import type { Context } from '@aalis/core';
import type { IncomingMessage } from '@aalis/schema-message';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apply } from '../../packages/plugin-tool-session/src/index.js';

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
type HookFn = (data: Record<string, unknown>, next: () => Promise<void>) => Promise<void>;

interface Harness {
  handler: Handler;
  /** 经 inbound:message 事件投递（伪 gateway 监听后转内部处理路径） */
  emitInbound: (msg: Partial<IncomingMessage> & { sessionId: string }) => Promise<void>;
  /** 直接调 gateway.ingressMessage() 投递——不过事件总线 */
  ingress: (msg: Partial<IncomingMessage> & { sessionId: string }) => Promise<void>;
  runTurnAfter: (sessionId: string) => Promise<void>;
  emitted: Array<{ event: string; payload: IncomingMessage }>;
}

function setup(): Harness {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ event: string; payload: IncomingMessage }> = [];
  const listeners = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
  const hooks = new Map<string, HookFn[]>();
  /** 按中间件语义跑一条钩子链（每个中间件自己决定是否 next()）。 */
  const runChain = async (hook: string, data: Record<string, unknown>): Promise<void> => {
    const list = hooks.get(hook) ?? [];
    const dispatch = async (i: number): Promise<void> => {
      const fn = list[i];
      if (!fn) return;
      await fn(data, () => dispatch(i + 1));
    };
    await dispatch(0);
  };
  const fakeTools = {
    register: (tool: { definition: { function: { name: string } }; handler: Handler }) => {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => {},
  };
  const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {}, child: () => logger };
  const ctx = {
    id: '@aalis/plugin-tool-session',
    logger,
    getService: (name: string) => (name === 'tools' ? fakeTools : undefined),
    whenService: (name: string, cb: (svc: unknown) => void) => {
      if (name === 'tools') cb(fakeTools);
      return () => {};
    },
    emit: async (event: string, payload: IncomingMessage) => {
      emitted.push({ event, payload });
      for (const fn of listeners.get(event) ?? []) await fn(payload);
    },
    on: (event: string, fn: (payload: unknown) => void | Promise<void>) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
    middleware: (hook: string, fn: HookFn) => {
      const list = hooks.get(hook) ?? [];
      list.push(fn);
      hooks.set(hook, list);
      return () => {
        hooks.set(
          hook,
          (hooks.get(hook) ?? []).filter(f => f !== fn),
        );
      };
    },
    onDispose: () => {},
    provide: () => {},
    contribute: () => () => {},
    runHook: async () => {},
  } as unknown as Context;
  apply(ctx, {});
  const handler = handlers.get('delegate_to_session');
  if (!handler) throw new Error('delegate_to_session 未注册');
  // 伪 gateway + agent：ingressMessage 与 inbound:message 监听共用同一条内部处理路径，
  // 该路径以 agent:input:before 钩子开场——与 plugin-gateway / plugin-agent 同构。
  const processInbound = async (msg: IncomingMessage): Promise<void> => {
    await runChain('agent:input:before', { message: msg, metadata: {} });
  };
  listeners.set('inbound:message', [
    ...(listeners.get('inbound:message') ?? []),
    payload => processInbound(payload as IncomingMessage),
  ]);
  return {
    handler,
    emitted,
    emitInbound: async msg => {
      await (ctx.emit as unknown as (e: string, p: unknown) => Promise<void>)('inbound:message', msg);
    },
    ingress: async msg => {
      await processInbound(msg as IncomingMessage);
    },
    runTurnAfter: async sessionId => {
      await runChain('agent:turn:after', { sessionId });
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

afterEach(() => {
  vi.useRealTimers();
});

describe('delegate_to_session 回合深度防雪崩', () => {
  it('委派注入的 IncomingMessage 带 proactiveDepth=1', async () => {
    const h = setup();
    await delegate(h, 'src-a', 'onebot:1:group:100');
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0].payload.proactiveDepth).toBe(1);
  });

  it('被委派回合内：delegate 被拒', async () => {
    const h = setup();
    await h.emitInbound({ sessionId: 'onebot:1:group:101', proactiveDepth: 1, triggerType: 'proactive' });
    const res = await delegate(h, 'onebot:1:group:101', 'onebot:1:group:999');
    expect(res.error).toBe('本回合由委派消息驱动，不能再委派');
    expect(res.delegated).toBeUndefined();
  });

  it('回合结束（agent:turn:after）即解除', async () => {
    const h = setup();
    const sid = 'onebot:1:group:102';
    await h.emitInbound({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).error).toBe('本回合由委派消息驱动，不能再委派');
    await h.runTurnAfter(sid);
    expect((await delegate(h, sid, 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('同会话下一条真人消息的回合不受影响（哪怕没等到 turn:after）', async () => {
    const h = setup();
    const sid = 'onebot:1:group:103';
    await h.emitInbound({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).error).toBe('本回合由委派消息驱动，不能再委派');
    await h.emitInbound({ sessionId: sid, triggerType: 'immediate' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('经 gateway.ingressMessage 投递的委派消息同样上锁', async () => {
    const h = setup();
    const sid = 'onebot:1:group:107';
    await h.ingress({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, sid, 'onebot:1:group:999')).error).toBe('本回合由委派消息驱动，不能再委派');
    await h.runTurnAfter(sid);
    expect((await delegate(h, sid, 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('其他会话的委派回合不影响本会话', async () => {
    const h = setup();
    await h.emitInbound({ sessionId: 'onebot:1:group:104', proactiveDepth: 1, triggerType: 'proactive' });
    expect((await delegate(h, 'onebot:1:group:105', 'onebot:1:group:999')).delegated).toBe(true);
  });

  it('没有时间窗：委派回合里过 11 分钟仍被拒（原 10 分钟 TTL 已不存在）', async () => {
    const h = setup();
    const sid = 'onebot:1:group:106';
    vi.useFakeTimers();
    await h.emitInbound({ sessionId: sid, proactiveDepth: 1, triggerType: 'proactive' });
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const res = await delegate(h, sid, 'onebot:1:group:999');
    expect(res.error).toBe('本回合由委派消息驱动，不能再委派');
  });
});
