import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, lifecycle, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { StepModel, stepModelPlugin } from '../fixtures/step-llm.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 删除会话时停掉这个会话在跑的回合：会话管理先发 session:deleted、再清数据，agent 在这个事件里停下这个会话在跑的一轮、放掉
// 排着的，并等它收尾，所以清数据一定在回合停下之后。被停的一轮不落库、不外发；别的会话的回合照常跑完。删除期间经网关到的
// 同一会话的消息等删除做完再往下走，是新的一代：照常处理，存档不被这次删除清掉。
// ════════════════════════════════════════════════════════════

/** 流出第一块后停住，直到 release 或请求被中止（与真实服务商一样响应中止信号） */
function heldModel(started: () => void) {
  let release!: () => void;
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  const plugin = definePlugin({
    name: 'zz-held-llm',
    provides: [llm],
    uses: { provide, lifecycle },
    apply(caps) {
      const handle: LLMModel = {
        id: 'held',
        providerId: caps.lifecycle.use.id,
        contextLength: 8192,
        maxOutputTokens: 1024,
        capabilities: ['chat', 'streaming'],
        async chat() {
          return { content: 'ok' };
        },
        async *chatStream(request) {
          yield { contentDelta: `回复 ${request.messages.length}` };
          started();
          await new Promise<void>((resolve, reject) => {
            void released.then(resolve);
            request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
          yield { done: true };
        },
      };
      caps.provide.use(llm, handle, { entryId: `${caps.lifecycle.use.id}/held` });
    },
  });
  return { plugin, release: () => release() };
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

describe('删除会话时停掉它在跑的回合', () => {
  it('删除等这个会话的回合停下再清数据；被停的一轮不落库、不外发，别的会话的回合照常跑完', async () => {
    let inflight = 0;
    let wake!: () => void;
    const bothStarted = new Promise<void>(resolve => {
      wake = resolve;
    });
    const held = heldModel(() => {
      if (++inflight === 2) wake();
    });
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(held.plugin);
    await app.plugin(memoryInMemoryPlugin);
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugin(sessionManagerPlugin);
    await app.plugin(agentPlugin, { systemPrompt: 'test' });
    await app.plugins.idle();
    for (const name of [sessionManagerPlugin.name, agentPlugin.name]) {
      expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
    }
    const host = app.bind({ agent: agentService, events, memory, sessionManager });
    const sm = host.sessionManager.use;
    const doomed = await sm.createSession({ name: '要删的' });
    const kept = await sm.createSession({ name: '留下的' });
    const sent: string[] = [];
    host.events.use.on('outbound:message', message => void sent.push(message.sessionId));

    const ask = (sessionId: string) =>
      host.agent.use.handleMessage({ content: '在吗', sessionId, platform: 'webui', userId: 'u1' });
    let doomedSettled = false;
    const doomedTurn = ask(doomed.id).finally(() => {
      doomedSettled = true;
    });
    const keptTurn = ask(kept.id);
    await bothStarted;

    await sm.deleteSession(doomed.id);
    expect(doomedSettled, '删除要等这个会话的回合收尾').toBe(true);
    held.release();
    await Promise.all([doomedTurn, keptTurn]);

    expect(sent, '被停的一轮不外发，别的会话照常').toEqual([kept.id]);
    const history = await host.memory.use.getHistory(doomed.id, Infinity);
    expect(
      history.filter(message => message.role === 'assistant'),
      '被停的一轮不落库',
    ).toEqual([]);
    expect((await host.memory.use.getHistory(kept.id, Infinity)).some(m => m.role === 'assistant')).toBe(true);
  });

  it('删除期间经网关到的同一房间的消息是新的一代：等删除做完（停下旧的一轮、清完数据）再处理，房间按它重新建档，照常回复，存档不被这次删除清掉', async () => {
    const model = new StepModel((_request, n) => ({ content: `回${n}` }));
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    for (const plugin of [
      stepModelPlugin(model),
      memoryInMemoryPlugin,
      sessionManagerPlugin,
      gatewayPlugin,
      agentPlugin,
    ]) {
      await app.plugin(plugin, {});
    }
    await app.plugin(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    for (const name of [sessionManagerPlugin.name, gatewayPlugin.name, agentPlugin.name]) {
      expect(app.plugins.getPlugin(name)?.state, `${name} 未激活`).toBe('active');
    }
    const host = app.bind({ events, hooks, gateway, memory, sessionManager });
    const sm = host.sessionManager.use;
    // onebot 的群：第一条原生入站经网关时由会话管理建档，删掉之后同一个群再来的消息重新建档
    const id = 'onebot:10000:group:20001';
    const outcomes: string[][] = [];
    // 删除停下旧的一轮之后、它落定之前（删除还没清数据）挂住：新的一条在这时到达
    const stopped = deferred();
    const gate = deferred();
    host.hooks.use.middleware('agent:turn:after', async (data, next) => {
      outcomes.push([data.inputs.map(input => input.message.content).join('+'), data.outcome]);
      if (data.outcome === 'aborted') {
        stopped.resolve();
        await gate.promise;
      }
      await next();
    });
    const ingress = (content: string) =>
      host.gateway.use.ingressMessage({
        content,
        sessionId: id,
        platform: 'onebot',
        userId: '30001',
        sessionType: 'group',
        selfId: '10000',
        groupId: '20001',
      });

    const held = model.hold(1);
    const a = ingress('<甲>');
    await held.entered;
    const first = sm.getSession(id);
    expect(first?.originChat?.multiParty, '第一条入站把这个群建了档').toBe(true);
    const deleting = sm.deleteSession(id);
    await stopped.promise;
    const b = ingress('<乙>');
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await Promise.all([a, b, deleting]);

    expect(outcomes).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
    ]);
    const second = sm.getSession(id);
    expect(second, '删除做完之后按新的一条重新建档').not.toBe(first);
    expect(second).toMatchObject({ kind: 'room', originPlatform: 'onebot', originChat: { multiParty: true } });
    const history = await host.memory.use.getHistory(id, Infinity);
    expect(history.map(m => [m.role, m.content])).toEqual([
      ['user', expect.stringContaining('<乙>')],
      ['assistant', '回2'],
    ]);
  });
});
