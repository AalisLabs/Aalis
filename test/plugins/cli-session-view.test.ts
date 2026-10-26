import { describe, expect, it, vi } from 'vitest';
import type { SessionPeer, SessionProtocolService } from '../../packages/api-session-protocol/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { SessionView, type TimelineItem } from '../../packages/plugin-cli/src/session-view.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 终端的会话视图（plugin-cli 的 session-view.ts）与会话服务之间的帧规则：请求按 id 配对；订阅的回应到达的那一拍就写上快照的
// 位置（会话服务回应之后紧接着同步补发取快照期间攒着的推送）；推送的 epoch 变了、收到 session/resync 都重新订阅，seq 不大于
// 快照的丢掉；取后台任务列表期间到的增量取完补上，连接断开时后台任务清空；握手出错时告警、关掉这条连接，不再订阅。她的回复
// 由不由条目画，等到没有在途的订阅再答。
// 会话服务是假的：按方法回应，推送由用例发
// ════════════════════════════════════════════════════════════

const SESSION = 'cli-default';
/** 让出事件循环两拍 */
const settle = () => new Promise<void>(r => setImmediate(() => setImmediate(r)));
const EPOCH = 'e1';

type Reply = (params: Record<string, unknown>) => unknown;

/** 一个回合还没收尾的快照：回合条目与她的一段正文 */
const said = (itemId: string, text: string): TimelineItem => ({
  kind: 'agent-message',
  itemId,
  turnId: 't1',
  at: 0,
  text,
  attachments: [],
});
const openTurn: TimelineItem = { kind: 'turn', itemId: 't1', turnId: 't1', at: 0 };

/**
 * 假会话服务：replies 覆盖各方法的回应（抛错的回内部错误）；afterSubscribe 里的推送在订阅的回应发出之后同一拍补发，与真的会话服务
 * 一样。push 推一帧，disconnect 由服务端断开这条连接
 */
function fakeService(replies: Record<string, Reply> = {}) {
  const requests: string[] = [];
  const afterSubscribe: Array<{ method: string; params: unknown }> = [];
  let send: (frame: Record<string, unknown>) => void = () => {};
  let disconnect: (reason: string) => void = () => {};
  let closed = false;
  const handlers: Record<string, Reply> = {
    initialize: () => ({}),
    'background/watch': () => ({}),
    'background/list': () => ({ tasks: [] }),
    'session/subscribe': () => ({ epoch: EPOCH, seq: 0, items: [openTurn] }),
    ...replies,
  };
  const service = {
    connect(peer: SessionPeer, out: (frame: string) => void) {
      send = frame => out(JSON.stringify({ jsonrpc: '2.0', ...frame }));
      disconnect = peer.disconnect;
      return {
        async receive(raw: string) {
          const { id, method, params } = JSON.parse(raw) as {
            id: number;
            method: string;
            params: Record<string, unknown>;
          };
          requests.push(method);
          try {
            send({ id, result: await handlers[method](params) });
          } catch (err) {
            send({ id, error: { code: -32603, message: String(err) } });
            return;
          }
          if (method === 'session/subscribe') for (const frame of afterSubscribe.splice(0)) send(frame);
        },
        close: () => {
          closed = true;
        },
      };
    },
    resolveFile: () => undefined,
  } as unknown as SessionProtocolService;
  return {
    service,
    requests,
    afterSubscribe,
    push: (method: string, params: Record<string, unknown>) => send({ method, params }),
    disconnect: () => disconnect('<断开>'),
    closed: () => closed,
  };
}

/** 接上假会话服务的会话视图，sink 记下交给聊天区的条目与增量 */
function attach(fake: ReturnType<typeof fakeService>) {
  const items: TimelineItem[] = [];
  const deltas: Array<[string, string]> = [];
  const warn = vi.fn();
  const logger = { debug() {}, info() {}, warn, error() {}, child: () => logger } as unknown as Logger;
  const view = new SessionView(
    SESSION,
    { identity: { platform: 'cli', userId: 'console' }, surface: {} as SessionPeer['surface'] },
    { item: item => void items.push(item), delta: (itemId, text) => void deltas.push([itemId, text]), tasks() {} },
    logger,
  );
  view.attach(fake.service);
  return { view, items, deltas, warn };
}

const pushed = (seq: number, item: TimelineItem, epoch = EPOCH) => ({ sessionId: SESSION, epoch, seq, item });
const subscribes = (fake: ReturnType<typeof fakeService>) =>
  fake.requests.filter(m => m === 'session/subscribe').length;

describe('终端的会话视图：帧的规则', () => {
  it('订阅的回应之后同一拍补发的推送照样交给聊天区', async () => {
    const fake = fakeService();
    fake.afterSubscribe.push({ method: 'item/started', params: pushed(1, said('a1', '<补发>')) });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    expect(v.items.map(item => item.itemId)).toEqual(['t1', 'a1']);
  });

  it('seq 不大于快照的与已经交过的推送丢掉', async () => {
    const fake = fakeService({ 'session/subscribe': () => ({ epoch: EPOCH, seq: 5, items: [] }) });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    fake.push('item/started', pushed(5, said('a1', '<快照里有>')));
    fake.push('item/started', pushed(6, said('a2', '<新的>')));
    fake.push('item/started', pushed(6, said('a3', '<重复>')));
    expect(v.items.map(item => item.itemId)).toEqual(['a2']);
  });

  it('推送的 epoch 变了：这一帧不交，重新订阅，之后按新快照的位置接', async () => {
    let epoch = EPOCH;
    const fake = fakeService({ 'session/subscribe': () => ({ epoch, seq: 3, items: [] }) });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    epoch = 'e2';
    fake.push('item/started', pushed(1, said('a1', '<换了 epoch>'), 'e2'));
    expect(subscribes(fake)).toBe(2);
    await v.view.ensureSubscribed();
    fake.push('item/started', pushed(4, said('a2', '<新快照之后>'), 'e2'));
    expect(v.items.map(item => item.itemId)).toEqual(['a2']);
  });

  it('收到 session/resync：重新订阅', async () => {
    const fake = fakeService();
    const v = attach(fake);
    await v.view.ensureSubscribed();
    fake.push('session/resync', { sessionId: SESSION, epoch: EPOCH, seq: 1 });
    expect(subscribes(fake)).toBe(2);
  });

  it('流式增量：订上之后的接在条目后面', async () => {
    const fake = fakeService();
    const v = attach(fake);
    await v.view.ensureSubscribed();
    fake.push('item/delta', { sessionId: SESSION, epoch: EPOCH, seq: 1, itemId: 'a1', text: '<增量>' });
    expect(v.deltas).toEqual([['a1', '<增量>']]);
  });

  it('重新订阅在途时她的回复由不由条目画，等订阅落定再答', async () => {
    const gate = deferred<void>();
    const fake = fakeService({
      'session/subscribe': async () => {
        if (subscribes(fake) > 1) await gate.promise;
        return { epoch: EPOCH, seq: 0, items: [] };
      },
    });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    fake.push('session/resync', { sessionId: SESSION, epoch: EPOCH, seq: 1 });
    let drawn: boolean | undefined;
    void v.view.drawsReplies().then(answer => {
      drawn = answer;
    });
    await settle();
    expect(drawn).toBeUndefined();
    gate.resolve();
    await vi.waitFor(() => expect(drawn).toBe(true));
  });

  it('重新订阅的回应之后同一拍又来 session/resync：等到没有在途的订阅再答', async () => {
    const gates = [deferred<void>(), deferred<void>()];
    const fake = fakeService({
      'session/subscribe': async () => {
        const n = subscribes(fake);
        if (n > 1) await gates[n - 2].promise;
        return { epoch: EPOCH, seq: 0, items: [] };
      },
    });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    // 取第二份快照期间历史又变了：会话服务攒着的 resync 在回应之后同一拍补发
    fake.afterSubscribe.push({ method: 'session/resync', params: { sessionId: SESSION, epoch: EPOCH, seq: 1 } });
    fake.push('session/resync', { sessionId: SESSION, epoch: EPOCH, seq: 1 });
    let drawn: boolean | undefined;
    void v.view.drawsReplies().then(answer => {
      drawn = answer;
    });
    gates[0].resolve();
    await vi.waitFor(() => expect(subscribes(fake)).toBe(3));
    await settle();
    expect(drawn).toBeUndefined();
    gates[1].resolve();
    await vi.waitFor(() => expect(drawn).toBe(true));
  });
});

describe('终端的会话视图：后台任务与连接', () => {
  const running = (id: string) => ({ id, status: 'running' });

  it('取后台任务列表期间到的增量，取完之后补上', async () => {
    const gate = deferred<void>();
    const fake = fakeService({
      'background/list': async () => {
        await gate.promise;
        return { tasks: [] };
      },
    });
    const v = attach(fake);
    await vi.waitFor(() => expect(fake.requests).toContain('background/list'));
    fake.push('background/changed', { upserts: [running('task-1')], removes: [] });
    gate.resolve();
    await v.view.ensureSubscribed();
    expect(v.view.taskRunning('task-1')).toBe(true);
  });

  it('服务端断开这条连接：后台任务清空，不再订着', async () => {
    const fake = fakeService({ 'background/list': () => ({ tasks: [running('task-1')] }) });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    expect(v.view.taskRunning('task-1')).toBe(true);
    fake.disconnect();
    expect(v.view.taskRunning('task-1')).toBe(false);
    expect(await v.view.drawsReplies()).toBe(false);
  });

  it('握手出错（取后台任务列表回了内部错误）：告警一次，关掉这条连接，不再订阅', async () => {
    const fake = fakeService({
      'background/list': () => {
        throw new Error('<登记表坏了>');
      },
    });
    const v = attach(fake);
    await v.view.ensureSubscribed();
    expect(v.warn).toHaveBeenCalledTimes(1);
    expect(fake.closed()).toBe(true);
    expect(fake.requests).not.toContain('session/subscribe');
    expect(await v.view.drawsReplies()).toBe(false);
  });
});
