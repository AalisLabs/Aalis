import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
import { checkpoint, type RollbackWithChatResult } from '../../packages/api-checkpoint/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type TodoItem, todoList } from '../../packages/api-todo-list/src/index.js';
import { type ToolCallContext, type ToolDisplay, tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import {
  type IncomingMessage,
  type Message,
  type OutboundDeliveryResult,
  type OutgoingMessage,
  type StreamChunkMessage,
  WellKnownKinds,
} from '../../packages/schema-message/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { memoryStorage } from '../fixtures/paper.js';
import { client } from '../fixtures/session-client.js';
import { declareToolSystemDisplays } from '../fixtures/tool-display.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 会话服务（plugin-session-server）的后一半：订阅与快照、条目推送、历史、回合控制。
// 前几组用合成事件驱动回合（与 agent 发事件的顺序一致），能在任意时刻插进订阅；
// 最后一组接真的 agent 与网关，核回合 id 与工具调用 id 一路贯通。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
/** 每个 App 一个临时家目录：会话服务的审批审计写在它下面 */
const homes: string[] = [];
/** 像 runtime 一样在根上提供 host-paths，家目录是新建的临时目录 */
function provideHome(app: App): void {
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-server-'));
  homes.push(home);
  provideHostPaths(app, home);
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Outcome = HookContextMap['agent:turn:after']['outcome'];

const ROOM = 'onebot:10000:group:1';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const adapterPlugin = (name: string, adapter: Partial<PlatformAdapter>) =>
  definePlugin({
    name,
    provides: [platform],
    uses: { provide },
    apply: ({ provide }) => {
      provide(platform, { getConnections: () => [], sendMessage: async () => {}, ...adapter } as never);
    },
  });

/**
 * 会话服务连同会话管理、消息归档与内存记忆。checkpoint、待办、agent 与 authority 是替身：
 * 记下调用，按用例给结果。slowHistory 为真时读历史要等 releaseHistory 放行。
 */
async function setup({ slowHistory = false }: { slowHistory?: boolean } = {}) {
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  apps.push(app);
  provideHome(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugins.idle();
  const host = app.bind({
    provide,
    events,
    hooks,
    sessionManager,
    sessionProtocol,
    messageArchive,
    memory,
    compression,
  });
  host.provide(storage, memoryStorage(new Map()));

  const rewinds: Array<[string, string, string]> = [];
  host.provide(checkpoint, {
    async rollback(sessionId: string, turnId: string) {
      rewinds.push(['code', sessionId, turnId]);
      return { ok: true, restored: ['workspace:/a.txt'], deleted: [], errors: [], alsoChangedBy: [] };
    },
    /** 这一组用例里 turn-exec 那一轮执行过命令 */
    execUsed: async (_sessionId: string, turnId: string) => turnId === 'turn-exec',
    async rollbackWithChat(sessionId: string, turnId: string): Promise<RollbackWithChatResult> {
      rewinds.push(['code-and-chat', sessionId, turnId]);
      await host.events.emit('history:changed', { sessionId });
      return {
        ok: true,
        restored: [],
        deleted: ['workspace:/b.txt'],
        errors: [],
        alsoChangedBy: [{ uri: 'workspace:/b.txt', turnIds: ['other'] }],
        deletedMessages: 3,
        chatDeleted: true,
      };
    },
  } as never);

  const plans = new Map<string, TodoItem[]>();
  host.provide(todoList, {
    get: async (sessionId: string) => plans.get(sessionId) ?? [],
    async clear(sessionId: string) {
      plans.delete(sessionId);
      await host.events.emit('todo:updated', sessionId, []);
    },
  });
  host.provide(authority, { isOwner: (p: string, u?: string) => p === 'webui' && u === 'console' } as never);

  if (slowHistory) {
    const mem = host.memory.require();
    const read = mem.getFullHistory?.bind(mem);
    if (!read) throw new Error('内存记忆应有 getFullHistory');
    mem.getFullHistory = async (sessionId, limit) => {
      await gate.promise;
      return read(sessionId, limit);
    };
  }
  const gate = deferred();

  await app.plugin(adapterPlugin('onebot-a', { platform: 'onebot', canHandle: id => id.startsWith('onebot:10000:') }));
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  if (app.plugins.getPlugin(sessionServerPlugin.name)?.state !== 'active') throw new Error('会话服务未激活');
  const sm = host.sessionManager.require();
  const archive = host.messageArchive.require();

  let turns = 0;
  /**
   * 开一轮：agent:input:before 的默认动作一直挂着，用例经 inside 把动作放进这一轮的异步上下文里执行，
   * finish 发 agent:turn:after 收尾；finish('blocked') 是被下游拦下的一轮，不发 turn:after。
   */
  const openTurn = (sessionId: string, from: Partial<IncomingMessage> = {}) => {
    const turnId = `turn-${++turns}`;
    const room = sessionId.startsWith('onebot:');
    const message: IncomingMessage = {
      content: '<提问>',
      sessionId,
      platform: room ? 'onebot' : 'webui',
      userId: room ? '424242' : 'console',
      ...from,
    };
    const jobs: Array<{ run: () => unknown; done: ReturnType<typeof deferred<void>> }> = [];
    let wake = deferred();
    let finished: { outcome: Outcome | 'blocked' } | undefined;
    const ended = host.hooks.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      for (;;) {
        for (let job = jobs.shift(); job; job = jobs.shift()) {
          try {
            await job.run();
            job.done.resolve(undefined);
          } catch (err) {
            job.done.reject(err);
          }
        }
        if (finished) break;
        await wake.promise;
        wake = deferred();
      }
      const { outcome } = finished;
      if (outcome !== 'blocked') {
        await host.hooks.run('agent:turn:after', { message, reply: '', outcome, sessionId, turnId, metadata: {} });
      }
    });
    const inside = (run: () => unknown) => {
      const done = deferred();
      jobs.push({ run, done });
      wake.resolve();
      return done.promise;
    };
    const stream = (chunk: Omit<StreamChunkMessage, 'sessionId' | 'turnId' | 'platform'>) =>
      inside(() => host.events.emit('outbound:stream', { sessionId, turnId, platform: message.platform, ...chunk }));
    const tool = (
      phase: 'start' | 'end',
      callId: string,
      name: string,
      args: Record<string, unknown>,
      result?: string,
    ) =>
      inside(() =>
        host.events.emit('tool:execute', {
          sessionId,
          turnId,
          callId,
          platform: message.platform,
          toolName: name,
          args,
          phase,
          result,
        }),
      );
    return {
      turnId,
      message,
      inside,
      /** agent 在回合开头归档这条提问 */
      ask: () => inside(() => archive.archiveIncoming(message)),
      text: (contentDelta: string) => stream({ contentDelta }),
      think: (reasoningDelta: string) => stream({ reasoningDelta }),
      streamDone: (toolLimitReached = false) => stream({ done: true, toolLimitReached }),
      /** 模型正在生成第 index 个工具调用的参数，已生成 chars 个字 */
      generating: (callId: string, name: string, index = 0, chars = 0) =>
        stream({ toolCallProgress: { index, name, charsAccumulated: chars, callId } }),
      toolStart: (callId: string, name: string, args: Record<string, unknown> = {}) =>
        tool('start', callId, name, args),
      toolEnd: (callId: string, name: string, result: string, args: Record<string, unknown> = {}) =>
        tool('end', callId, name, args, result),
      /**
       * 工具返回：agent 先跑 agent:tool:after（工具上下文带回合的中止信号），再发结束事件；返回随结果落库的元数据
       */
      toolReturns: async (
        callId: string,
        name: string,
        result: string,
        args: Record<string, unknown> = {},
        signal?: AbortSignal,
      ) => {
        const data = {
          name,
          result,
          toolCallContext: { sessionId, turnId, callId, signal },
          metadata: {} as Record<string, unknown>,
        };
        await inside(() => host.hooks.run('agent:tool:after', data));
        await tool('end', callId, name, args, result);
        return data.metadata;
      },
      toolOutput: (callId: string, text: string) =>
        inside(() => host.events.emit('tool:output', { sessionId, turnId, callId, text })),
      /** 一次定稿校验（persona 等在这里决定要不要重试） */
      replyCheck: () => inside(() => host.hooks.run('agent:reply:before', { content: '', sessionId, attempt: 0 })),
      reply: (content: string, extra: Partial<OutgoingMessage> = {}) => {
        const out: OutgoingMessage = { content, sessionId, platform: message.platform, source: 'agent', ...extra };
        return inside(() => host.events.emit('outbound:message', out)).then(() => out);
      },
      /** 把消息写进存档（模拟 agent 落库），带这一轮的 turnId */
      save: (msg: Message) =>
        inside(() => archive.saveMessage(sessionId, { ...msg, metadata: { ...msg.metadata, turnId } })),
      finish: async (outcome: Outcome | 'blocked' = 'replied') => {
        finished = { outcome };
        wake.resolve();
        await ended;
      },
    };
  };

  return {
    app,
    host,
    sm,
    archive,
    plans,
    rewinds,
    openTurn,
    releaseHistory: () => gate.resolve(),
    server: () => host.sessionProtocol.require(),
  };
}

/** 条目里与比对有关的部分：去掉 id、时间与回合 id */
function shape(item: SessionItem): Record<string, unknown> {
  const { itemId: _id, at: _at, turnId: _turn, ...rest } = item;
  return rest;
}

describe('订阅与快照', () => {
  it('快照：已结束回合的历史加在途回合已产出的条目；之后的推送接上，不重不漏', async () => {
    const { server, sm, openTurn } = await setup();
    const s = await sm.createSession({ name: 'S' });

    const earlier = openTurn(s.id, { content: '第一问' });
    await earlier.ask();
    await earlier.text('第一答');
    await earlier.replyCheck();
    await earlier.save({ role: 'assistant', content: '第一答', segments: [{ type: 'text', content: '第一答' }] });
    await earlier.reply('第一答');
    await earlier.finish('replied');

    const t = openTurn(s.id, { content: '第二问' });
    await t.ask();
    await t.think('想一想');
    await t.text('我来查');
    await t.toolStart('call-1', 'exec', { command: 'ls' });
    await t.toolOutput('call-1', 'a.txt\n');
    await t.save({
      role: 'assistant',
      content: '我来查',
      toolCalls: [{ id: 'm1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } }],
    });

    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    expect(sub.snapshot.epoch).toEqual(expect.any(String));
    expect(sub.snapshot.session.id).toBe(s.id);
    // 在途回合落了库的工具调用组不进历史，由在途条目给出
    expect(sub.snapshot.items.map(shape)).toEqual([
      expect.objectContaining({ kind: 'user-message', text: '第一问' }),
      { kind: 'agent-message', text: '第一答', attachments: [] },
      expect.objectContaining({ kind: 'user-message', text: '第二问' }),
      { kind: 'turn', by: expect.objectContaining({ platform: 'webui', userId: 'console', owner: true }) },
      { kind: 'reasoning', text: '想一想' },
      { kind: 'agent-message', text: '我来查', attachments: [] },
      { kind: 'tool-call', name: 'exec', args: { command: 'ls' }, status: 'running', output: 'a.txt\n' },
    ]);

    await t.toolOutput('call-1', 'b.txt\n');
    await t.toolEnd('call-1', 'exec', '{"exitCode":0}', { command: 'ls' });
    // 工具结束之后管道里才到的输出不再接到卡片上：结果已经是正本
    await t.toolOutput('call-1', '迟到的输出');
    expect(
      c
        .notifications('item/delta')
        .filter(d => d.itemId === 'call-1')
        .map(d => d.text),
      '订阅之后的输出按增量推',
    ).toEqual(['b.txt\n']);
    await t.text('查好了');
    await t.replyCheck();
    await t.reply('查好了', { modelInfo: { provider: 'p', model: 'm' } });
    await t.finish('replied');

    const items = c.timeline(s.id, sub);
    expect(new Set(items.map(i => i.itemId)).size, 'itemId 不重复').toBe(items.length);
    expect(items.slice(3).map(shape)).toEqual([
      expect.objectContaining({ kind: 'turn', outcome: 'replied' }),
      { kind: 'reasoning', text: '想一想' },
      { kind: 'agent-message', text: '我来查', attachments: [] },
      {
        kind: 'tool-call',
        name: 'exec',
        args: { command: 'ls' },
        status: 'completed',
        output: 'a.txt\nb.txt\n',
        result: '{"exitCode":0}',
        durationMs: expect.any(Number),
      },
      { kind: 'agent-message', text: '查好了', attachments: [], model: { provider: 'p', model: 'm' } },
    ]);
    expect(items.find(i => i.kind === 'tool-call')?.itemId, 'tool-call 的 itemId 就是 callId').toBe('call-1');
    expect(items.slice(3).every(i => i.turnId === t.turnId)).toBe(true);
  });

  it('读历史期间发生的事：订阅回应之前不推这个会话的条目；之后补上，与历史重叠的按 itemId 合并', async () => {
    const { server, sm, openTurn, archive, releaseHistory } = await setup({ slowHistory: true });
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    // 订阅之前已经在跑的一轮（定时任务那条 lane）
    const running = openTurn(s.id, { source: 'scheduler', userId: undefined });
    await running.text('一半');
    // 订阅在这里拿到快照的 seq，读历史卡在闸口
    const subscribing = c.subscribe(s.id);

    // 读历史卡住的时候：在跑的那轮接着说，一条消息落库，另一轮从头跑完
    await running.text('，另一半');
    await archive.archiveIncoming({ content: '插话', sessionId: s.id, platform: 'webui', userId: 'console' });
    const t = openTurn(s.id, { content: '提问' });
    await t.ask();
    await t.text('回答');
    await t.replyCheck();
    await t.save({ role: 'assistant', content: '回答', segments: [{ type: 'text', content: '回答' }] });
    await t.reply('回答');
    await t.finish('replied');

    releaseHistory();
    const sub = await subscribing;
    // 快照里在跑那轮的正文取在订阅那一刻，读历史期间的增量随后接上，不重复
    const midway = c.timeline(s.id, sub).find(i => i.kind === 'agent-message' && i.turnId === running.turnId);
    expect(midway).toMatchObject({ text: '一半，另一半' });
    await running.replyCheck();
    await running.reply('一半，另一半');
    await running.finish('replied');
    const items = c.timeline(s.id, sub);
    expect(new Set(items.map(i => i.itemId)).size, 'itemId 不重复').toBe(items.length);
    expect(items.map(i => [i.kind, 'text' in i ? i.text : i.turnId])).toEqual([
      ['user-message', '插话'],
      ['user-message', '提问'],
      ['turn', running.turnId],
      ['agent-message', '一半，另一半'],
      ['turn', t.turnId],
      ['agent-message', '回答'],
    ]);
  });

  it('两条连接订阅同一会话：先后订阅，之后收到同样的推送，时间线一致', async () => {
    const { server, sm, openTurn } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const a = client(server());
    const b = client(server());
    await a.init();
    await b.init();
    const subA = await a.subscribe(s.id);

    const t = openTurn(s.id);
    await t.ask();
    await t.text('一二');
    const subB = await b.subscribe(s.id);
    await t.text('三四');
    await t.toolStart('call-x', 'probe');
    await t.toolEnd('call-x', 'probe', 'ok');
    await t.replyCheck();
    await t.reply('三四');
    await t.finish('replied');

    const pushesAfterB = (frames: typeof a.frames) =>
      frames.filter(f => f.method?.startsWith('item/') && (f.params as { seq: number }).seq > subB.snapshot.seq);
    expect(pushesAfterB(a.frames)).toEqual(pushesAfterB(b.frames));
    expect(pushesAfterB(a.frames).length).toBeGreaterThan(0);
    expect(b.timeline(s.id, subB)).toEqual(a.timeline(s.id, subA));
  });

  it('epoch 每次启动换一个：会话服务重启后旧连接断开，新快照与之后的推送带新的 epoch', async () => {
    const { app, server, sm, openTurn } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const a = client(server());
    await a.init();
    const first = await a.subscribe(s.id);

    await app.plugins.bounce(sessionServerPlugin.name);
    await app.plugins.idle();
    expect(a.disconnects).toHaveLength(1);

    const b = client(server());
    await b.init();
    const second = await b.subscribe(s.id);
    expect(second.snapshot.epoch).not.toBe(first.snapshot.epoch);
    const t = openTurn(s.id);
    await t.text('x');
    await t.finish('silent');
    const pushes = b.notifications('item/completed');
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every(p => p.epoch === second.snapshot.epoch)).toBe(true);
  });

  it('一条连接订阅多个会话，各推各的；退订之后不再推送；订阅不存在的会话回 not-found', async () => {
    const { server, sm, openTurn } = await setup();
    const x = await sm.createSession({ name: 'X' });
    const y = await sm.createSession({ name: 'Y' });
    const c = client(server());
    await c.init();
    await c.subscribe(x.id);
    await c.subscribe(y.id);

    const tx = openTurn(x.id);
    await tx.text('给 X');
    await tx.finish('silent');
    const ty = openTurn(y.id);
    await ty.text('给 Y');
    await ty.finish('silent');
    const sessionsOf = () => new Set(c.notifications('item/completed').map(p => p.sessionId));
    expect(sessionsOf()).toEqual(new Set([x.id, y.id]));

    await c.call('session/unsubscribe', { sessionId: x.id });
    const seen = c.frames.length;
    const again = openTurn(x.id);
    await again.text('退订之后');
    await again.finish('silent');
    expect(c.frames.slice(seen).filter(f => f.method?.startsWith('item/'))).toEqual([]);
    expect((await c.fail('session/subscribe', { sessionId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('同一连接对同一会话连发两次订阅，先发的那次读历史失败：不撤掉后一次的订阅', async () => {
    const { server, sm, host } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const mem = host.memory.require();
    const read = mem.getFullHistory?.bind(mem);
    if (!read) throw new Error('内存记忆应有 getFullHistory');
    const gate = deferred();
    let reads = 0;
    mem.getFullHistory = async (sessionId, limit) => {
      if (++reads > 1) return read(sessionId, limit);
      await gate.promise;
      throw new Error('记忆后端正在换人');
    };
    const c = client(server());
    await c.init();
    const subscribe = (id: string) =>
      c.raw({ jsonrpc: '2.0', id, method: 'session/subscribe', params: { sessionId: s.id } });
    const first = subscribe('first');
    await subscribe('second');
    gate.resolve();
    await first;
    expect(c.frames.find(f => f.id === 'first')).toHaveProperty('error');
    expect(c.frames.find(f => f.id === 'second')).toHaveProperty('result');
    await host.events.emit('history:changed', { sessionId: s.id });
    expect(c.notifications('session/resync').map(p => p.sessionId)).toEqual([s.id]);
  });

  it('/clear 清掉消息历史：订阅这些会话的连接收到 session/resync；只清别的类型、会话已删除时不推', async () => {
    const { server, sm, host } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const t = await sm.createSession({ name: 'T' });
    const c = client(server());
    await c.init();
    await c.subscribe(s.id);
    await c.subscribe(t.id);
    const resynced = () => c.notifications('session/resync').map(p => p.sessionId);
    const clear = (data: Omit<HookContextMap['memory:clear'], 'results'>) =>
      host.hooks.run('memory:clear', { ...data, results: [] });

    await clear({ scope: 'session', sessionId: s.id, types: ['vector'] });
    expect(resynced(), '没清消息历史').toEqual([]);
    await clear({ scope: 'session', sessionId: s.id });
    expect(resynced()).toEqual([s.id]);
    await clear({ scope: 'all', types: ['context'] });
    expect(resynced().slice(1).sort()).toEqual([s.id, t.id].sort());
    // 删除会话也经 memory:clear 清它的数据：会话已不在，删除由会话列表的增量告知
    await sm.deleteSession(t.id);
    expect(resynced()).toHaveLength(3);
  });

  it('历史被改写（连对话一起回滚）：订阅这个会话的连接收到 session/resync', async () => {
    const { server, sm, host } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const other = await sm.createSession({ name: 'T' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    await host.events.emit('history:changed', { sessionId: other.id });
    await host.events.emit('history:changed', { sessionId: s.id });
    expect(c.notifications('session/resync')).toEqual([
      { sessionId: s.id, epoch: sub.snapshot.epoch, seq: expect.any(Number) },
    ]);
  });
});

describe('条目', () => {
  it('turn：开始带发起方，结束带结局；被下游拦下、没有结局的一轮按 silent 收尾', async () => {
    const { server, sm, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(ROOM);
    const t = openTurn(ROOM, { nickname: '小明' });
    await t.finish('blocked');
    expect(c.timeline(ROOM, sub).map(shape)).toEqual([
      {
        kind: 'turn',
        by: { platform: 'onebot', userId: '424242', nickname: '小明', owner: false },
        outcome: 'silent',
      },
    ]);
  });

  it('房间里没发出去的标「未发出」：重试丢掉的那版、静默结束的、平台没收下的；owner 自己的会话不标', async () => {
    const { server, sm, host, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const mine = await sm.createSession({ name: '我的' });
    host.events.on('outbound:message', msg => {
      if (msg.sessionId === ROOM && !msg.delivery)
        msg.delivery = Promise.resolve({ ok: false, error: '发送失败：群已解散' });
    });
    const c = client(server());
    await c.init();
    const room = await c.subscribe(ROOM);
    const own = await c.subscribe(mine.id);

    const retried = openTurn(ROOM);
    await retried.text('第一版');
    await retried.replyCheck();
    await retried.text('第二版');
    await retried.replyCheck();
    await retried.reply('第二版');
    await retried.finish('replied');

    const quiet = openTurn(ROOM);
    await quiet.text('想说又没说');
    await quiet.replyCheck();
    await quiet.finish('silent');

    await vi.waitFor(() => {
      const messages = c.timeline(ROOM, room).filter(i => i.kind === 'agent-message');
      expect(messages.map(m => [m.text, m.kind === 'agent-message' && m.undelivered?.reason])).toEqual([
        ['第一版', expect.stringContaining('重试')],
        ['第二版', expect.stringContaining('群已解散')],
        ['想说又没说', expect.stringContaining('静默')],
      ]);
    });

    const ownTurn = openTurn(mine.id);
    await ownTurn.text('只给自己看');
    await ownTurn.replyCheck();
    await ownTurn.finish('silent');
    const ownMessages = c.timeline(mine.id, own).filter(i => i.kind === 'agent-message');
    expect(ownMessages).toHaveLength(1);
    expect(ownMessages[0]).not.toHaveProperty('undelivered');
  });

  it('房间里工具调用之前说的话没有发进群，标「未发出」；之后的回复照常；重新订阅后历史里同样标出', async () => {
    const { server, sm, host, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const mine = await sm.createSession({ name: '我的' });
    host.events.on('outbound:message', msg => {
      if (msg.sessionId === ROOM && !msg.delivery) msg.delivery = Promise.resolve({ ok: true });
    });
    const c = client(server());
    await c.init();
    const room = await c.subscribe(ROOM);
    const own = await c.subscribe(mine.id);

    const replied = openTurn(ROOM);
    await replied.ask();
    await replied.text('我先查一下');
    await replied.toolStart('call-a', 'probe');
    await replied.toolEnd('call-a', 'probe', 'ok');
    await replied.text('查好了');
    await replied.replyCheck();
    await replied.save({
      role: 'assistant',
      content: '查好了',
      segments: [
        { type: 'text', content: '我先查一下' },
        { type: 'tool_call', name: 'probe', args: {}, result: 'ok', callId: 'call-a' },
        { type: 'text', content: '查好了' },
      ],
    });
    await replied.reply('查好了');
    await replied.finish('replied');

    const quiet = openTurn(ROOM);
    await quiet.ask();
    await quiet.text('我再看看');
    await quiet.toolStart('call-b', 'probe');
    await quiet.toolEnd('call-b', 'probe', 'ok');
    await quiet.save({
      role: 'assistant',
      content: '我再看看',
      toolCalls: [{ id: 'm-b', type: 'function', function: { name: 'probe', arguments: '{}' } }],
    });
    await quiet.save({ role: 'tool', content: 'ok', toolCallId: 'm-b', metadata: { callId: 'call-b' } });
    await quiet.finish('silent');

    const said = (items: SessionItem[]) =>
      items.flatMap(i => (i.kind === 'agent-message' ? [[i.text, i.undelivered?.reason]] : []));
    const expected = [
      ['我先查一下', expect.stringContaining('调用工具之前')],
      ['查好了', undefined],
      ['我再看看', expect.stringContaining('调用工具之前')],
    ];
    expect(said(c.timeline(ROOM, room))).toEqual(expected);
    const fresh = client(server());
    await fresh.init();
    const { snapshot } = await fresh.subscribe(ROOM);
    expect(
      snapshot.items.some(i => i.kind === 'turn'),
      '两轮都已收尾，快照全部出自历史',
    ).toBe(false);
    expect(said(snapshot.items)).toEqual(expected);

    const ownTurn = openTurn(mine.id);
    await ownTurn.text('我先查一下');
    await ownTurn.toolStart('call-c', 'probe');
    await ownTurn.finish('silent');
    expect(said(c.timeline(mine.id, own))).toEqual([['我先查一下', undefined]]);
  });

  it('回合结束之后、送达结果到达之前订阅的连接：迟到的结果落在快照里的同一条回复上，不多出一条', async () => {
    const { server, sm, host, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const settle = deferred<OutboundDeliveryResult>();
    host.events.on('outbound:message', msg => {
      if (msg.sessionId === ROOM && !msg.delivery) msg.delivery = settle.promise;
    });
    const t = openTurn(ROOM);
    await t.ask();
    await t.text('晚到的回执');
    await t.replyCheck();
    await t.save({ role: 'assistant', content: '晚到的回执', segments: [{ type: 'text', content: '晚到的回执' }] });
    await t.reply('晚到的回执');
    await t.finish('replied');

    const c = client(server());
    await c.init();
    const sub = await c.subscribe(ROOM);
    settle.resolve({ ok: false, error: '群已解散' });
    const replies = (items: SessionItem[]) =>
      items.flatMap(i => (i.kind === 'agent-message' ? [[i.text, i.undelivered?.reason]] : []));
    await vi.waitFor(() =>
      expect(replies(c.timeline(ROOM, sub))).toEqual([['晚到的回执', expect.stringContaining('群已解散')]]),
    );
    // 送达结果到了之后这一轮不再留着：之后的订阅从存档归并，送达结果只在实时推送里
    const late = client(server());
    await late.init();
    expect(replies((await late.subscribe(ROOM)).snapshot.items)).toEqual([['晚到的回执', undefined]]);
  });

  it('平台的送达结果以拒绝结算：回复标「发送出错」，经工具发出的不标，都不留未处理的拒绝', async () => {
    const { server, sm, host, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const deliveries: Array<ReturnType<typeof deferred<OutboundDeliveryResult>>> = [];
    host.events.on('outbound:message', msg => {
      if (msg.sessionId !== ROOM || msg.delivery) return;
      const pending = deferred<OutboundDeliveryResult>();
      deliveries.push(pending);
      msg.delivery = pending.promise;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = client(server());
      await c.init();
      const sub = await c.subscribe(ROOM);
      const t = openTurn(ROOM);
      await t.toolStart('call-x', 'send_attachment');
      await t.inside(() =>
        host.events.emit('outbound:message', {
          content: '',
          sessionId: ROOM,
          platform: 'onebot',
          source: 'agent',
          callId: 'call-x',
          attachments: [{ kind: 'image', data: 'data:/a.png' }],
        }),
      );
      await t.toolEnd('call-x', 'send_attachment', '{"ok":true}');
      await t.text('发好了');
      await t.replyCheck();
      await t.reply('发好了');
      await t.finish('replied');
      for (const pending of deliveries) pending.reject(new Error('适配器内部出错'));
      await vi.waitFor(() =>
        expect(c.timeline(ROOM, sub).flatMap(i => (i.kind === 'agent-message' ? [i.undelivered?.reason] : []))).toEqual(
          [expect.stringContaining('适配器内部出错')],
        ),
      );
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(c.timeline(ROOM, sub).find(i => i.kind === 'tool-call')).not.toHaveProperty('sentToRoom');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('房间里经工具发出、平台收下的消息：工具卡标「已发到群」并写进工具结果的元数据；没收下的不标', async () => {
    const { server, sm, host, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    host.events.on('outbound:message', msg => {
      if (msg.sessionId !== ROOM || msg.delivery) return;
      msg.delivery = Promise.resolve(msg.callId === 'call-ok' ? { ok: true } : { ok: false, error: '上传失败' });
    });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(ROOM);
    const t = openTurn(ROOM);
    const metadata: Array<Record<string, unknown>> = [];
    for (const callId of ['call-ok', 'call-bad']) {
      await t.toolStart(callId, 'send_attachment');
      const out: OutgoingMessage = {
        content: '',
        sessionId: ROOM,
        platform: 'onebot',
        source: 'agent',
        callId,
        attachments: [{ kind: 'image', data: 'data:/a.png' }],
      };
      await t.inside(async () => {
        await host.events.emit('outbound:message', out);
        await out.delivery;
      });
      // 工具结果落库前，会话服务把平台收下了的写进这次结果的元数据，刷新后历史据此还原
      const after = {
        name: 'send_attachment',
        result: '{"ok":true}',
        toolCallContext: { sessionId: ROOM, turnId: t.turnId, callId },
        metadata: {} as Record<string, unknown>,
      };
      await t.inside(() => host.hooks.run('agent:tool:after', after));
      metadata.push(after.metadata);
      await t.toolEnd(callId, 'send_attachment', '{"ok":true}');
    }
    await t.finish('replied');
    expect(metadata).toEqual([{ sentToRoom: true }, {}]);
    await vi.waitFor(() => {
      const calls = c.timeline(ROOM, sub).filter(i => i.kind === 'tool-call');
      expect(calls.map(i => [i.itemId, i.kind === 'tool-call' && i.sentToRoom])).toEqual([
        ['call-ok', true],
        ['call-bad', undefined],
      ]);
    });
  });

  it('工具卡带按工具定义上声明的展示种类解析好的展示：命令与工作目录、路径与两侧逐字取自参数；没声明的不给，历史里同样解析', async () => {
    const { app, server, sm, archive, openTurn } = await setup();
    await app.plugin(toolsPlugin, {});
    await app.plugins.idle();
    declareToolSystemDisplays(app.bind({ tools }).tools);
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    const t = openTurn(s.id);
    await t.toolStart('c1', 'exec', { command: 'ls -a', cwd: 'workspace:/', timeout: 5 });
    await t.toolStart('c2', 'exec', { command: 'pwd' });
    await t.toolStart('c3', 'file_edit', { path: 'workspace:/a.md', oldText: '旧', newText: '新' });
    await t.toolStart('c4', 'file_write', { path: 'workspace:/b.md', content: '全文' });
    await t.toolStart('c5', 'probe', { command: 'ls' });
    // 声明的必填字段（命令、路径）不是字符串：解析不出，走通用卡
    await t.toolStart('c6', 'exec', { command: ['ls'] });
    await t.finish('silent');
    expect(c.timeline(s.id, sub).flatMap(i => (i.kind === 'tool-call' ? [[i.itemId, i.display]] : []))).toEqual([
      ['c1', { kind: 'command', command: 'ls -a', cwd: 'workspace:/' }],
      ['c2', { kind: 'command', command: 'pwd' }],
      ['c3', { kind: 'file-change', path: 'workspace:/a.md', removed: '旧', added: '新' }],
      ['c4', { kind: 'file-change', path: 'workspace:/b.md', added: '全文' }],
      ['c5', undefined],
      ['c6', undefined],
    ]);
    // 历史里的工具卡按同一份声明解析
    await archive.saveMessage(s.id, {
      role: 'assistant',
      content: '好',
      timestamp: 9,
      segments: [
        { type: 'tool_call', name: 'exec', args: { command: 'pwd' }, result: '/', callId: 'h1' },
        { type: 'text', content: '好' },
      ],
    });
    const history = await c.call('session/history', { sessionId: s.id });
    expect(history.items.find(i => i.itemId === 'h1')).toMatchObject({ display: { kind: 'command', command: 'pwd' } });
  });

  it('模型生成参数期间工具卡已出现：只有工具名，状态 generating；开始执行时同一张卡转为 running；生成了却没执行的在回合结束时以失败收尾', async () => {
    const { server, sm, openTurn } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    const t = openTurn(s.id);
    await t.text('我来写');
    // 名字还没生成出来时不出卡；同一个调用的后续进度不再推
    await t.generating('c1', '', 0, 0);
    await t.generating('c1', 'file_write', 0, 10);
    await t.generating('c1', 'file_write', 0, 400);
    await t.generating('c2', 'exec', 1, 5);
    const startedCards = () =>
      c
        .notifications('item/started')
        .map(p => p.item)
        .filter(i => i.kind === 'tool-call')
        .map(i => [i.itemId, i.status, i.name, i.args]);
    expect(startedCards()).toEqual([
      ['c1', 'generating', 'file_write', {}],
      ['c2', 'generating', 'exec', {}],
    ]);
    const other = client(server());
    await other.init();
    const cards = (await other.subscribe(s.id)).snapshot.items.filter(i => i.kind === 'tool-call');
    expect(
      cards.map(i => [i.itemId, i.status]),
      '快照里同样有生成中的卡',
    ).toEqual([
      ['c1', 'generating'],
      ['c2', 'generating'],
    ]);

    await t.toolStart('c1', 'file_write', { path: 'workspace:/a.md', content: '全文' });
    expect(startedCards().at(-1)).toEqual([
      'c1',
      'running',
      'file_write',
      { path: 'workspace:/a.md', content: '全文' },
    ]);
    await t.toolEnd('c1', 'file_write', '{"ok":true}', { path: 'workspace:/a.md', content: '全文' });
    await t.finish('silent');
    const items = c.timeline(s.id, sub);
    expect(items.filter(i => i.kind === 'tool-call').map(i => [i.itemId, i.status, i.result])).toEqual([
      ['c1', 'completed', '{"ok":true}'],
      ['c2', 'failed', '没有执行'],
    ]);
    expect(
      items.map(i => i.kind),
      '卡片排在生成它之前说的话后面',
    ).toEqual(['turn', 'agent-message', 'tool-call', 'tool-call']);
  });

  it('房间里达到工具调用上限：生成了、没执行的调用之前说的话就是回复，不标「未发出」', async () => {
    const { server, sm, host, openTurn } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    host.events.on('outbound:message', msg => {
      if (msg.sessionId === ROOM && !msg.delivery) msg.delivery = Promise.resolve({ ok: true });
    });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(ROOM);
    const t = openTurn(ROOM);
    await t.text('先说到这');
    await t.generating('c9', 'exec');
    await t.streamDone(true);
    await t.replyCheck();
    await t.reply('先说到这');
    await t.finish('replied');
    const said = c.timeline(ROOM, sub).filter(i => i.kind === 'agent-message');
    expect(said.map(i => [i.text, i.undelivered])).toEqual([['先说到这', undefined]]);
  });

  it('工具结果带 error 的记为失败；达到工具调用上限的一轮收尾时给一条可以继续的 notice', async () => {
    const { server, sm, openTurn } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    const t = openTurn(s.id);
    await t.toolStart('call-e', 'file_read', { path: 'x' });
    await t.toolEnd('call-e', 'file_read', '{"error":"没有这个文件"}', { path: 'x' });
    await t.streamDone(true);
    await t.finish('silent');
    const items = c.timeline(s.id, sub);
    expect(items.find(i => i.kind === 'tool-call')).toMatchObject({
      status: 'failed',
      result: '{"error":"没有这个文件"}',
    });
    expect(items.find(i => i.kind === 'notice')).toMatchObject({ topic: 'tool-limit', canContinue: true });
  });

  it('命令的退出码按声明从结果里取：不为 0 的记为失败、展示带上退出码，为 0 的完成；结果不是 JSON、没声明取退出码的不看；历史里同样', async () => {
    const { app, server, sm, archive, openTurn } = await setup();
    await app.plugin(toolsPlugin, {});
    await app.plugins.idle();
    const bound = app.bind({ tools }).tools;
    declareToolSystemDisplays(bound);
    bound.register({
      definition: {
        type: 'function',
        function: { name: 'zz_cmd_no_exit', description: 'zz', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => '',
      display: { kind: 'command', fields: { command: 'command' } },
    });
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    const calls: Array<[string, string, string]> = [
      ['c1', 'exec', '{"exitCode":0,"stdout":"ok","stderr":""}'],
      ['c2', 'exec', '{"exitCode":3,"stdout":"","stderr":"坏了"}'],
      ['c3', 'exec', '不是 JSON'],
      // 声明了命令展示、没声明从结果里取退出码的工具：结果里同名的键不算
      ['c4', 'zz_cmd_no_exit', '{"exitCode":3}'],
    ];
    const t = openTurn(s.id);
    const recorded: Array<Record<string, unknown>> = [];
    for (const [callId, name, result] of calls) {
      await t.toolStart(callId, name, { command: 'make' });
      recorded.push(await t.toolReturns(callId, name, result, { command: 'make' }));
    }
    await t.finish('silent');
    // 取到的退出码随结果落库
    expect(recorded).toEqual([{ exitCode: 0 }, { exitCode: 3 }, {}, {}]);
    const expected = [
      ['c1', 'completed', { kind: 'command', command: 'make', exitCode: 0 }],
      ['c2', 'failed', { kind: 'command', command: 'make', exitCode: 3 }],
      ['c3', 'completed', { kind: 'command', command: 'make' }],
      ['c4', 'completed', { kind: 'command', command: 'make' }],
    ];
    const cards = (items: SessionItem[]) =>
      items.flatMap(i => (i.kind === 'tool-call' ? [[i.itemId, i.status, i.display]] : []));
    expect(cards(c.timeline(s.id, sub))).toEqual(expected);

    // 存档里没记下退出码的（结果落库时会话服务没在跑）从结果里取
    await archive.saveMessage(s.id, {
      role: 'assistant',
      content: '好',
      timestamp: 9,
      segments: [
        ...calls.map(([callId, name, result]) => ({
          type: 'tool_call' as const,
          name,
          args: { command: 'make' },
          result,
          callId,
        })),
        { type: 'text', content: '好' },
      ],
    });
    const history = await c.call('session/history', { sessionId: s.id });
    expect(cards(history.items)).toEqual(expected);
  });

  it('回合被停止：停止时还没结束的调用落成 aborted，不管之后返回了什么，并写进工具结果的元数据；生成了没执行的同样；停止之前结束的照旧', async () => {
    const { app, server, sm, openTurn } = await setup();
    await app.plugin(toolsPlugin, {});
    await app.plugins.idle();
    declareToolSystemDisplays(app.bind({ tools }).tools);
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    const t = openTurn(s.id);
    const turn = new AbortController();
    const returns = (callId: string, name: string, result: string) =>
      t.toolReturns(callId, name, result, { command: 'make' }, turn.signal);
    await t.toolStart('c1', 'exec', { command: 'make' });
    const settled = await returns('c1', 'exec', '{"exitCode":0}');
    await t.toolStart('c2', 'exec', { command: 'make' });
    await t.toolStart('c3', 'probe', { command: 'make' });
    await t.generating('c4', 'exec', 2);
    turn.abort();
    const killed = await returns('c2', 'exec', '{"aborted":true,"message":"命令已中止","exitCode":-1}');
    const finished = await returns('c3', 'probe', '{"ok":true}');
    await t.finish('aborted');
    expect([settled, killed, finished]).toEqual([{ exitCode: 0 }, { aborted: true, exitCode: -1 }, { aborted: true }]);
    expect(
      c.timeline(s.id, sub).flatMap(i => (i.kind === 'tool-call' ? [[i.itemId, i.status, i.result]] : [])),
    ).toEqual([
      ['c1', 'completed', '{"exitCode":0}'],
      ['c2', 'aborted', '{"aborted":true,"message":"命令已中止","exitCode":-1}'],
      ['c3', 'aborted', '{"ok":true}'],
      ['c4', 'aborted', '没有执行'],
    ]);
  });

  it('入站与她发出的附件按存档推送：用户消息带说话人，宿主通知是 notice，发出的图片是只有附件的消息', async () => {
    const { server, sm, host, archive } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(ROOM);
    await archive.archiveIncoming({
      content: '大家好',
      sessionId: ROOM,
      platform: 'onebot',
      userId: '7',
      nickname: '阿七',
    });
    await archive.archiveIncoming({
      content: '白纸任务完成',
      sessionId: ROOM,
      platform: 'onebot',
      source: 'paper:1',
      hostNotice: { kind: 'paper-task', id: 'n1' },
    });
    await archive.saveMessage(ROOM, {
      role: 'assistant',
      kind: 'outbound-image',
      content: '[图片: 一只猫 | ref:data:/cat.png]',
      timestamp: Date.now(),
    });
    // 她的普通回复不经这条路推（在回合里推）
    await host.events.emit('assistant:message:archived', {
      sessionId: ROOM,
      message: { role: 'assistant', content: '不该推', timestamp: Date.now() },
    });
    expect(c.timeline(ROOM, sub).map(shape)).toEqual([
      {
        kind: 'user-message',
        text: '[阿七(7)]: 大家好',
        attachments: [],
        speaker: { platform: 'onebot', userId: '7', nickname: '阿七', owner: false },
      },
      { kind: 'notice', topic: 'paper-task', text: '白纸任务完成', attachments: [] },
      { kind: 'agent-message', text: '', attachments: [{ kind: 'image', src: 'data:/cat.png' }] },
    ]);
    const fresh = client(server());
    await fresh.init();
    const snap = await fresh.subscribe(ROOM);
    expect(snap.snapshot.items, '实时推送与快照里的历史是同一批条目').toEqual(c.timeline(ROOM, sub));
  });

  it('plan：待办整份替换；快照带当前计划；plan/clear 清空并推空计划', async () => {
    const { server, sm, host, plans } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    const items: TodoItem[] = [{ id: 1, title: '写用例', status: 'in-progress' }];
    plans.set(s.id, items);
    await host.events.emit('todo:updated', s.id, items);
    expect(c.timeline(s.id, sub).map(shape)).toEqual([{ kind: 'plan', entries: items }]);

    const late = client(server());
    await late.init();
    expect((await late.subscribe(s.id)).snapshot.items.map(shape)).toEqual([{ kind: 'plan', entries: items }]);

    await c.call('plan/clear', { sessionId: s.id });
    expect(c.timeline(s.id, sub).map(shape)).toEqual([{ kind: 'plan', entries: [] }]);
    expect(plans.has(s.id)).toBe(false);
  });

  it('usage：推最新的用量，分项照 token:usage 原样放进条目；快照带上；没有用量的会话订阅后请求一次', async () => {
    const { server, sm, host } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const requests: Array<{ sessionId: string; platform?: string }> = [];
    host.events.on('token:request', req => void requests.push(req));
    const c = client(server());
    await c.init();
    await c.subscribe(s.id);
    await vi.waitFor(() => expect(requests).toEqual([{ sessionId: s.id, platform: 'webui' }]));

    const usage = {
      sessionId: s.id,
      turnId: 'turn-u',
      platform: 'webui',
      contextWindow: 1000,
      maxTokens: 100,
      tokenBudget: 800,
      used: 200,
      usageRatio: 0.25,
      breakdown: {
        system: 1,
        persona: 2,
        memorySummary: 0,
        memoryVector: 0,
        skills: 0,
        platform: 0,
        subtask: 0,
        systemOther: 5,
        injectors: { notes: 5 },
        history: 100,
        toolResults: 0,
        toolDefs: 92,
        reservedForReply: 0,
      },
      parts: [
        { label: '历史消息', tokens: 100 },
        { label: '工具定义', tokens: 92 },
        { label: '人设', tokens: 2 },
        { label: '其余系统提示', tokens: 5, injectors: { notes: 5 } },
      ],
    };
    await host.events.emit('token:usage', usage);
    const usageOf = async () => {
      const late = client(server());
      await late.init();
      return (await late.subscribe(s.id)).snapshot.items.find(i => i.kind === 'usage');
    };
    const item = await usageOf();
    expect(item).toMatchObject({ turnId: 'turn-u', used: 200, parts: usage.parts });
    expect(item).not.toHaveProperty('breakdown');
    expect(item, '没有压缩服务就没有压缩线').not.toHaveProperty('compressAt');
    expect(requests, '有用量就不再请求').toHaveLength(1);

    // 压缩线取压缩服务给的自动压缩使用率，取快照与推送的那一刻现取；不自动压缩（0）时没有
    const never = host.provide(compression, { autoThreshold: 0, compress: async () => {} });
    expect(await usageOf()).not.toHaveProperty('compressAt');
    never();
    host.provide(compression, { autoThreshold: 0.7, compress: async () => {} });
    expect(await usageOf()).toMatchObject({ compressAt: 0.7 });
    const c2 = client(server());
    await c2.init();
    const sub = await c2.subscribe(s.id);
    await host.events.emit('token:usage', { ...usage, used: 300 });
    expect(c2.timeline(s.id, sub).find(i => i.kind === 'usage')).toMatchObject({ used: 300, compressAt: 0.7 });
  });

  it('房间的用量按出生平台算：订阅之后、手动压缩之后请求用量都不填平台', async () => {
    const { server, sm, host } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    host.provide(compression, { autoThreshold: 0.7, compress: async () => {} });
    const requests: Array<{ sessionId: string; platform?: string }> = [];
    host.events.on('token:request', req => void requests.push(req));
    const c = client(server());
    await c.init();
    await c.subscribe(ROOM);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await c.call('session/compress', { sessionId: ROOM });
    expect(requests).toStrictEqual([{ sessionId: ROOM }, { sessionId: ROOM }]);
  });

  it('压缩：notice 从开始推到结束；session/compress 调压缩服务，压完才回、再请求一次用量；没压成回错误，不再请求用量', async () => {
    const { server, sm, host } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const calls: unknown[] = [];
    let failure: string | undefined;
    host.provide(compression, {
      autoThreshold: 0.7,
      async compress(sessionId, reason) {
        calls.push([sessionId, reason]);
        await host.events.emit('session:compressing', { sessionId, status: 'start' });
        await host.events.emit('session:compressing', { sessionId, status: failure ? 'error' : 'done' });
        if (failure) throw new Error(failure);
      },
    });
    const requests: unknown[] = [];
    const c = client(server());
    await c.init();
    const sub = await c.subscribe(s.id);
    host.events.on('token:request', req => void requests.push(req));
    await c.call('session/compress', { sessionId: s.id });
    expect(calls).toEqual([[s.id, 'manual']]);
    expect(requests).toEqual([{ sessionId: s.id, platform: 'webui' }]);
    const notices = c.timeline(s.id, sub).filter(i => i.kind === 'notice');
    expect(notices.map(shape)).toEqual([{ kind: 'notice', topic: 'compress', text: '对话已压缩', attachments: [] }]);
    expect(c.notifications('item/started').map(p => p.item.kind)).toContain('notice');

    failure = '摘要模型不在';
    expect((await c.fail('session/compress', { sessionId: s.id })).message).toContain('摘要模型不在');
    expect(requests).toHaveLength(1);
    expect(
      c
        .timeline(s.id, sub)
        .filter(i => i.kind === 'notice')
        .map(i => 'text' in i && i.text),
    ).toEqual(['对话已压缩', '压缩失败']);
  });
});

describe('历史', () => {
  it('session/history 由存档归并：before 往前翻页，一轮的工具调用组不拆在两页；会话不存在回 not-found', async () => {
    const { server, sm, archive } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const save = (m: Message) => archive.saveMessage(s.id, m);
    for (let i = 0; i < 3; i++) {
      await save({
        role: 'user',
        content: `问 ${i}`,
        timestamp: 10 * i + 1,
        metadata: { platform: 'webui', userId: 'console' },
      });
      await save({
        role: 'assistant',
        content: null,
        timestamp: 10 * i + 2,
        toolCalls: [{ id: `c${i}`, type: 'function', function: { name: 'probe', arguments: '{}' } }],
      });
      await save({ role: 'tool', content: `结果 ${i}`, toolCallId: `c${i}`, timestamp: 10 * i + 3 });
      await save({ role: 'assistant', content: `答 ${i}`, timestamp: 10 * i + 4 });
    }
    const c = client(server());
    await c.init();
    const whole = await c.call('session/history', { sessionId: s.id });
    expect(whole.before).toBeUndefined();
    const pages: SessionItem[][] = [];
    let before: string | undefined;
    do {
      const page = await c.call('session/history', { sessionId: s.id, limit: 3, before });
      pages.unshift(page.items);
      before = page.before;
    } while (before !== undefined);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flat()).toEqual(whole.items);
    expect(whole.items.map(i => [i.kind, 'text' in i ? i.text : 'name' in i ? i.name : ''])).toEqual(
      [0, 1, 2].flatMap(i => [
        ['user-message', `问 ${i}`],
        ['tool-call', 'probe'],
        ['agent-message', `答 ${i}`],
      ]),
    );
    expect((await c.fail('session/history', { sessionId: 'session-nope' })).data?.code).toBe('not-found');
    expect(
      (await c.fail('session/history', { sessionId: s.id, before: 'x' })).data?.code,
      '游标指向的消息不在存档里',
    ).toBe('not-found');
  });

  it('重试的各版正文各成一条：房间里最后一版是回复，之前的标「未发出」；owner 自己的会话不标', async () => {
    const { server, sm, archive } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const mine = await sm.createSession({ name: '我的' });
    for (const sessionId of [ROOM, mine.id]) {
      await archive.saveMessage(sessionId, {
        role: 'assistant',
        content: '第二版',
        timestamp: 5,
        metadata: { turnId: `t-${sessionId}` },
        segments: [
          { type: 'reasoning_text', content: '想一想' },
          { type: 'text', content: '第一版' },
          { type: 'text', content: '第二版' },
        ],
      });
    }
    const c = client(server());
    await c.init();
    const said = (items: SessionItem[]) =>
      items.flatMap(i => (i.kind === 'agent-message' ? [[i.text, i.undelivered?.reason]] : []));
    expect(said((await c.call('session/history', { sessionId: ROOM })).items)).toEqual([
      ['第一版', expect.stringContaining('重试')],
      ['第二版', undefined],
    ]);
    expect(said((await c.call('session/history', { sessionId: mine.id })).items)).toEqual([
      ['第一版', undefined],
      ['第二版', undefined],
    ]);
  });

  it('相邻两轮之间没有提问：各归各的回合，前一轮按旧格式落库的工具调用不被后一轮的时间线盖掉', async () => {
    const { server, sm, archive } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const save = (m: Message) => archive.saveMessage(s.id, m);
    await save({
      role: 'assistant',
      content: '先看看',
      timestamp: 1,
      metadata: { turnId: 't1' },
      toolCalls: [{ id: 'm1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
    });
    await save({
      role: 'tool',
      content: 'ok',
      toolCallId: 'm1',
      timestamp: 2,
      metadata: { turnId: 't1', callId: 'c1' },
    });
    await save({
      role: 'assistant',
      content: '好了',
      timestamp: 3,
      metadata: { turnId: 't2' },
      segments: [
        { type: 'tool_call', name: 'probe', args: {}, result: 'ok', callId: 'c2' },
        { type: 'text', content: '好了' },
      ],
    });
    const c = client(server());
    await c.init();
    const { items } = await c.call('session/history', { sessionId: s.id });
    expect(items.map(i => [i.kind, i.turnId, i.itemId])).toEqual([
      ['agent-message', 't1', expect.any(String)],
      ['tool-call', 't1', 'c1'],
      ['tool-call', 't2', 'c2'],
      ['agent-message', 't2', expect.any(String)],
    ]);
  });

  it('刷新后仍在：平台没收下的回复按投递失败记录标出，已发到群与审批的结局按工具结果的元数据还原', async () => {
    const { server, sm, archive } = await setup();
    await sm.ensureSession(ROOM, { name: '群' });
    const save = (m: Message) => archive.saveMessage(ROOM, m);
    const settlement = { state: 'expired', source: 'absent', at: 7 } as const;
    await save({
      role: 'assistant',
      content: null,
      timestamp: 1,
      metadata: { turnId: 't1' },
      toolCalls: [
        { id: 'm1', type: 'function', function: { name: 'send_attachment', arguments: '{}' } },
        { id: 'm2', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } },
      ],
    });
    await save({
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'm1',
      timestamp: 2,
      metadata: { turnId: 't1', callId: 'c1', sentToRoom: true },
    });
    await save({
      role: 'tool',
      content: '{"error":"需要 owner 批准的操作没有执行"}',
      toolCallId: 'm2',
      timestamp: 3,
      metadata: { turnId: 't1', callId: 'c2', approval: { id: 'ap-1', ...settlement } },
    });
    await save({
      role: 'assistant',
      content: '发好了',
      timestamp: 4,
      metadata: { turnId: 't1' },
      segments: [
        { type: 'tool_call', name: 'send_attachment', args: {}, result: '{"ok":true}', callId: 'c1' },
        { type: 'tool_call', name: 'exec', args: { command: 'ls' }, result: '{"error":"x"}', callId: 'c2' },
        { type: 'text', content: '发好了' },
      ],
    });
    await save({
      role: 'system',
      kind: WellKnownKinds.OutboundDeliveryFailed,
      content: '[投递回报] 没送达',
      timestamp: 5,
      metadata: { turnId: 't1', error: '群已解散' },
    });
    // 经工具发出的失败（带 callId）不算到这一轮的回复上，记在后面也一样
    await save({
      role: 'system',
      kind: WellKnownKinds.OutboundDeliveryFailed,
      content: '[投递回报] 没送达',
      timestamp: 6,
      metadata: { turnId: 't1', callId: 'c1', error: '上传失败' },
    });
    const c = client(server());
    await c.init();
    const { items } = await c.call('session/history', { sessionId: ROOM });
    expect(items.map(shape)).toEqual([
      expect.objectContaining({ kind: 'tool-call', name: 'send_attachment', status: 'completed', sentToRoom: true }),
      expect.objectContaining({ kind: 'tool-call', name: 'exec', status: 'denied', approvalId: 'ap-1', settlement }),
      {
        kind: 'agent-message',
        text: '发好了',
        attachments: [],
        undelivered: { reason: '没有发出：平台没收下（群已解散）' },
      },
    ]);
  });

  it('历史里元数据记着停止时还没结束的调用落成 aborted；没有结果的调用（重启或中断）同样，不算失败', async () => {
    const { server, sm, archive } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const save = (m: Message) => archive.saveMessage(s.id, m);
    await save({
      role: 'assistant',
      content: null,
      timestamp: 1,
      metadata: { turnId: 't1' },
      toolCalls: [
        { id: 'm1', type: 'function', function: { name: 'exec', arguments: '{"command":"make"}' } },
        { id: 'm2', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } },
        { id: 'm3', type: 'function', function: { name: 'exec', arguments: '{"command":"pwd"}' } },
        { id: 'm4', type: 'function', function: { name: 'exec', arguments: '{"command":"rm"}' } },
      ],
    });
    await save({
      role: 'tool',
      content: '{"aborted":true,"exitCode":-1}',
      toolCallId: 'm1',
      timestamp: 2,
      metadata: { turnId: 't1', callId: 'c1', aborted: true },
    });
    await save({
      role: 'tool',
      content: '{"exitCode":0}',
      toolCallId: 'm2',
      timestamp: 3,
      metadata: { turnId: 't1', callId: 'c2' },
    });
    // 等着批准时被停下：审批随之撤销，停止在前，按停止算
    await save({
      role: 'tool',
      content: '{"error":"需要 owner 批准的操作没有执行"}',
      toolCallId: 'm4',
      timestamp: 4,
      metadata: {
        turnId: 't1',
        callId: 'c4',
        aborted: true,
        approval: { id: 'ap-1', state: 'cancelled', source: 'turn-ended', at: 3 },
      },
    });
    const c = client(server());
    await c.init();
    const { items } = await c.call('session/history', { sessionId: s.id });
    expect(items.flatMap(i => (i.kind === 'tool-call' ? [[i.args.command, i.status]] : []))).toEqual([
      ['make', 'aborted'],
      ['ls', 'completed'],
      ['pwd', 'aborted'],
      ['rm', 'aborted'],
    ]);
  });
});

describe('回合控制', () => {
  it('turn/send 以连接的身份发入站消息；只有附件、没写文字的照常发出；会话不存在回 not-found', async () => {
    const { server, sm, host } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const inbound: IncomingMessage[] = [];
    host.events.on('inbound:message', msg => void inbound.push(msg));
    const c = client(server());
    await c.init();
    await c.call('turn/send', { sessionId: s.id, content: '  你好  ' });
    const image = { kind: 'image' as const, data: 'data:image/png;base64,AAAA', name: 'a.png' };
    await c.call('turn/send', { sessionId: s.id, content: '', attachments: [image] });
    await c.call('turn/continue', { sessionId: s.id });
    await vi.waitFor(() => expect(inbound).toHaveLength(3));
    expect(inbound[0]).toEqual({ content: '你好', sessionId: s.id, platform: 'webui', userId: 'console' });
    expect(inbound[1]).toEqual({
      content: '',
      sessionId: s.id,
      platform: 'webui',
      userId: 'console',
      attachments: [image],
    });
    expect(inbound[2]).toMatchObject({ sessionId: s.id, platform: 'webui', userId: 'console' });
    expect(inbound[2]?.content).toContain('继续');
    expect((await c.fail('turn/send', { sessionId: 'session-nope', content: 'x' })).data?.code).toBe('not-found');
    expect((await c.fail('turn/send', { sessionId: s.id, content: '' })).code).toBe(-32602);
  });

  it('turn/rewind 接住两种回滚并原样回结果；没有检查点服务回 unsupported', async () => {
    const { server, sm, rewinds } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const code = await c.call('turn/rewind', { sessionId: s.id, turnId: 't-1', scope: 'code' });
    expect(code).toEqual({ ok: true, restored: ['workspace:/a.txt'], deleted: [], errors: [], alsoChangedBy: [] });
    const chat = await c.call('turn/rewind', { sessionId: s.id, turnId: 't-2', scope: 'code-and-chat' });
    expect(chat).toMatchObject({ deletedMessages: 3, chatDeleted: true, alsoChangedBy: [{ turnIds: ['other'] }] });
    expect(rewinds).toEqual([
      ['code', s.id, 't-1'],
      ['code-and-chat', s.id, 't-2'],
    ]);
  });

  it('turn/checkpoint 回这一轮有没有执行过命令（命令的效果回滚撤不回）；会话不存在回 not-found', async () => {
    const { server, sm } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    expect(await c.call('turn/checkpoint', { sessionId: s.id, turnId: 'turn-exec' })).toEqual({ execUsed: true });
    expect(await c.call('turn/checkpoint', { sessionId: s.id, turnId: 'turn-edit' })).toEqual({ execUsed: false });
    expect((await c.fail('turn/checkpoint', { sessionId: 'session-nope', turnId: 't' })).data?.code).toBe('not-found');
  });

  it('没有 agent、检查点、待办服务时，对应的方法回 unsupported', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    provideHome(app);
    await registerHubs(app);
    await app.plugin(memoryInMemoryPlugin);
    await app.plugins.idle();
    const host = app.bind({ provide, sessionManager, sessionProtocol });
    host.provide(storage, memoryStorage(new Map()));
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();
    const s = await host.sessionManager.require().createSession({ name: 'S' });
    const c = client(host.sessionProtocol.require());
    await c.init();
    for (const [method, params] of [
      ['turn/abort', { sessionId: s.id }],
      ['turn/rewind', { sessionId: s.id, turnId: 't', scope: 'code' }],
      ['turn/checkpoint', { sessionId: s.id, turnId: 't' }],
      ['session/compress', { sessionId: s.id }],
      ['plan/clear', { sessionId: s.id }],
    ] as const) {
      expect((await c.fail(method, params)).data?.code, method).toBe('unsupported');
    }
  });

  it('功能位：握手回发送、回滚、压缩三项，各看对话、检查点、压缩服务在不在；服务上下线时推 features/changed', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    provideHome(app);
    await registerHubs(app);
    await app.plugin(memoryInMemoryPlugin);
    await app.plugins.idle();
    const host = app.bind({ provide, sessionProtocol });
    host.provide(storage, memoryStorage(new Map()));
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();
    const c = client(host.sessionProtocol.require());
    const hello = await c.init();
    expect(hello.features).toEqual({ send: false, rewind: false, compress: false });

    const pushed = () => c.notifications('features/changed').map(p => p.features);
    const offCheckpoint = host.provide(checkpoint, {} as never);
    await vi.waitFor(() => expect(pushed()).toEqual([{ send: false, rewind: true, compress: false }]));
    const offCompression = host.provide(compression, { autoThreshold: 0, compress: async () => {} });
    await vi.waitFor(() => expect(pushed().at(-1)).toEqual({ send: false, rewind: true, compress: true }));
    offCheckpoint();
    await vi.waitFor(() => expect(pushed().at(-1)).toEqual({ send: false, rewind: false, compress: true }));
    offCompression();
    await vi.waitFor(() => expect(pushed().at(-1)).toEqual({ send: false, rewind: false, compress: false }));
    // 已有检查点时再来一个提供者、又撤掉：功能位没变，不推
    const first = host.provide(checkpoint, {} as never);
    await vi.waitFor(() => expect(pushed()).toHaveLength(5));
    const second = host.provide(checkpoint, {} as never);
    second();
    first();
    await vi.waitFor(() => expect(pushed().at(-1)).toEqual({ send: false, rewind: false, compress: false }));
    expect(pushed()).toEqual([
      { send: false, rewind: true, compress: false },
      { send: false, rewind: true, compress: true },
      { send: false, rewind: false, compress: true },
      { send: false, rewind: false, compress: false },
      { send: false, rewind: true, compress: false },
      { send: false, rewind: false, compress: false },
    ]);

    const later = client(host.sessionProtocol.require());
    host.provide(compression, { autoThreshold: 0, compress: async () => {} });
    expect((await later.init()).features, '握手给的是当前的功能位').toEqual({
      send: false,
      rewind: false,
      compress: true,
    });
  });
});

// ════════════════════════════════════════════════════════════
// 接真的 agent 与网关
// ════════════════════════════════════════════════════════════

const PROBE = 'zz_timeline_probe';
const callProbe: ChatResponse = {
  content: '先查一下',
  toolCalls: [{ id: 'model-id', type: 'function', function: { name: PROBE, arguments: '{"q":1}' } }],
};

async function startAgent(
  responses: ChatResponse[],
  probe: (ctx: ToolCallContext) => Promise<string>,
  display?: ToolDisplay,
) {
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  apps.push(app);
  provideHome(app);
  await registerHubs(app);
  await app.plugin(createMockLLMPlugin({ responses }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  const host = app.bind({ provide, tools, sessionManager, sessionProtocol, hooks });
  host.provide(storage, memoryStorage(new Map()));
  host.tools.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: (_args, ctx) => probe(ctx),
    display,
  });
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  for (const name of [agentPlugin.name, gatewayPlugin.name, sessionServerPlugin.name]) {
    expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
  }
  const inputs: IncomingMessage[] = [];
  host.hooks.middleware('agent:input:before', async (data, next) => {
    inputs.push(data.message);
    await next();
  });
  const sm = host.sessionManager.require();
  const s = await sm.createSession({ name: 'S' });
  // 有标题就不在第一条消息时调模型起标题，预设的模型回复只给 agent 用
  await sm.updateSessionTitle(s.id, 'S');
  const c = client(host.sessionProtocol.require());
  expect((await c.init()).features.send, '有对话服务就能发送').toBe(true);
  const sub = await c.subscribe(s.id);
  const turnItems = () => c.timeline(s.id, sub).filter(i => i.kind === 'turn');
  return { host, s, c, sub, inputs, turnItems };
}

describe('接 agent 与网关', () => {
  it('turn/send 进 agent：回合 id 贯通各条目，tool-call 的 itemId 就是工具上下文的 callId；结束后新快照的历史与实时条目一致，回复带的模型与这一轮的 token 也一致', async () => {
    const ctxs: ToolCallContext[] = [];
    const { host, s, c, sub, turnItems } = await startAgent(
      [
        { ...callProbe, usage: { promptTokens: 1200, completionTokens: 30, totalTokens: 1230 } },
        { content: '查好了', usage: { promptTokens: 1500, completionTokens: 40, totalTokens: 1540 } },
      ],
      async ctx => {
        ctxs.push(ctx);
        return '{"found":true}';
      },
    );
    await c.call('turn/send', { sessionId: s.id, content: '帮我查' });
    await vi.waitFor(() => expect(turnItems().at(-1)).toMatchObject({ outcome: 'replied' }));

    const live = c.timeline(s.id, sub);
    const turnId = turnItems()[0]?.turnId;
    expect(turnId).toEqual(expect.any(String));
    expect(ctxs.map(ctx => ctx.turnId)).toEqual([turnId]);
    const call = live.find(i => i.kind === 'tool-call');
    expect(call?.itemId).toBe(ctxs[0]?.callId);
    // 模型生成参数时卡片已出现，用的就是执行时的 callId：开始执行时同一张卡转为 running
    expect(
      c
        .notifications('item/started')
        .flatMap(p => (p.item.kind === 'tool-call' ? [[p.item.itemId, p.item.status]] : [])),
    ).toEqual([
      [ctxs[0]?.callId, 'generating'],
      [ctxs[0]?.callId, 'running'],
    ]);
    expect(live.filter(i => i.kind !== 'user-message' && i.kind !== 'usage').every(i => i.turnId === turnId)).toBe(
      true,
    );

    // 回合结束后新订阅：历史由存档归并，内容与实时条目一致，条目带同一个回合 id
    const fresh = client(host.sessionProtocol.require());
    await fresh.init();
    const history = (await fresh.subscribe(s.id)).snapshot.items;
    const content = (items: SessionItem[]): Array<Record<string, unknown>> =>
      items.flatMap(
        (i): Array<Record<string, unknown>> =>
          i.kind === 'tool-call'
            ? [{ kind: i.kind, name: i.name, args: i.args, status: i.status, result: i.result }]
            : i.kind === 'agent-message' || i.kind === 'reasoning' || i.kind === 'user-message'
              ? [{ kind: i.kind, text: i.text, ...(i.kind === 'agent-message' ? { model: i.model } : {}) }]
              : [],
      );
    expect(content(history)).toEqual(content(live));
    expect(history.find(i => i.kind === 'tool-call')?.itemId, '历史里的工具卡同样以 callId 为 id').toBe(
      ctxs[0]?.callId,
    );
    expect(content(live)).toEqual([
      { kind: 'user-message', text: '帮我查' },
      { kind: 'agent-message', text: '先查一下', model: undefined },
      { kind: 'tool-call', name: PROBE, args: { q: 1 }, status: 'completed', result: '{"found":true}' },
      {
        kind: 'agent-message',
        text: '查好了',
        // 输入取这一轮最后一次调用的上下文，输出是这一轮各次调用的合计
        model: {
          provider: '@aalis/test-fixture-mock-llm',
          model: 'mock-model',
          promptTokens: 1500,
          completionTokens: 70,
        },
      },
    ]);
    expect(history.filter(i => i.kind !== 'user-message').every(i => i.turnId === turnId)).toBe(true);
  });

  it('没回复就收尾的一轮（只按工具调用组落库）：历史里的工具卡同样以 callId 为 id', async () => {
    const ctxs: ToolCallContext[] = [];
    const { host, s, c, turnItems } = await startAgent([callProbe, { content: '' }], async ctx => {
      ctxs.push(ctx);
      return 'ok';
    });
    await c.call('turn/send', { sessionId: s.id, content: '查一下就好' });
    await vi.waitFor(() => expect(turnItems().at(-1)).toMatchObject({ outcome: 'silent' }));
    const fresh = client(host.sessionProtocol.require());
    await fresh.init();
    const calls = (await fresh.subscribe(s.id)).snapshot.items.filter(i => i.kind === 'tool-call');
    expect(calls.map(i => i.itemId)).toEqual([ctxs[0]?.callId]);
  });

  it('只有附件、没写文字的消息照常进 agent', async () => {
    const { s, c, inputs, turnItems } = await startAgent([{ content: '看到了' }], async () => 'ok');
    const image = { kind: 'image' as const, data: 'data:image/png;base64,AAAA', name: 'a.png' };
    await c.call('turn/send', { sessionId: s.id, content: '', attachments: [image] });
    await vi.waitFor(() => expect(turnItems().at(-1)).toMatchObject({ outcome: 'replied' }));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      content: '',
      attachments: [expect.objectContaining({ kind: 'image', name: 'a.png' })],
    });
  });

  it('turn/abort：turnId 对不上回 expected-turn-mismatch，这一轮照常；对得上的停下这一轮', async () => {
    const entered = deferred();
    const release = deferred();
    const { s, c, sub, turnItems } = await startAgent([callProbe, { content: '完成' }], async () => {
      entered.resolve();
      await release.promise;
      return 'ok';
    });
    await c.call('turn/send', { sessionId: s.id, content: '跑一个慢的' });
    await entered.promise;
    const turnId = turnItems()[0]?.turnId as string;
    expect((await c.fail('turn/abort', { sessionId: s.id, turnId: 'not-this-turn' })).data?.code).toBe(
      'expected-turn-mismatch',
    );
    expect(turnItems().at(-1)).not.toHaveProperty('outcome');
    await c.call('turn/abort', { sessionId: s.id, turnId });
    release.resolve();
    await vi.waitFor(() => expect(turnItems().at(-1)).toMatchObject({ turnId, outcome: 'aborted' }));
    expect(c.timeline(s.id, sub).filter(i => i.kind === 'turn')).toHaveLength(1);
    await c.call('turn/abort', { sessionId: s.id });
  });

  it('命令的结果过长被 agent 截断：退出码取自截断之前的结果，工具卡照样记为失败、带退出码；刷新后历史里同样', async () => {
    const runTests: ChatResponse = {
      content: '跑一下测试',
      toolCalls: [{ id: 'model-id', type: 'function', function: { name: PROBE, arguments: '{"command":"npm test"}' } }],
    };
    const { host, s, c, sub, turnItems } = await startAgent(
      [runTests, { content: '测试没过' }],
      async () => JSON.stringify({ exitCode: 1, stdout: 'x'.repeat(10_000), stderr: '' }),
      { kind: 'command', fields: { command: 'command' }, result: { exitCode: 'exitCode' } },
    );
    await c.call('turn/send', { sessionId: s.id, content: '跑测试' });
    await vi.waitFor(() => expect(turnItems().at(-1)).toMatchObject({ outcome: 'replied' }));
    const card = (items: SessionItem[]) => items.find(i => i.kind === 'tool-call');
    const expected = {
      status: 'failed',
      display: { kind: 'command', command: 'npm test', exitCode: 1 },
      result: expect.stringContaining('[工具输出已截断'),
    };
    expect(card(c.timeline(s.id, sub))).toMatchObject(expected);
    const fresh = client(host.sessionProtocol.require());
    await fresh.init();
    expect(card((await fresh.subscribe(s.id)).snapshot.items)).toMatchObject(expected);
  });

  it('停止键停下的一轮：停止时在途的工具调用落成 aborted，工具之后照常返回也不改；刷新后历史里同样', async () => {
    const entered = deferred();
    const release = deferred();
    const { host, s, c, sub, turnItems } = await startAgent([callProbe, { content: '完成' }], async () => {
      entered.resolve();
      await release.promise;
      return '{"ok":true}';
    });
    await c.call('turn/send', { sessionId: s.id, content: '跑一个慢的' });
    await entered.promise;
    await c.call('turn/abort', { sessionId: s.id });
    release.resolve();
    await vi.waitFor(() => expect(turnItems().at(-1)).toMatchObject({ outcome: 'aborted' }));
    const card = (items: SessionItem[]) => items.find(i => i.kind === 'tool-call');
    expect(card(c.timeline(s.id, sub))).toMatchObject({ status: 'aborted', result: '{"ok":true}' });
    const fresh = client(host.sessionProtocol.require());
    await fresh.init();
    expect(card((await fresh.subscribe(s.id)).snapshot.items)).toMatchObject({ status: 'aborted' });
  });
});
