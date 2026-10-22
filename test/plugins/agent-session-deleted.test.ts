import { afterEach, describe, expect, it } from 'vitest';
import { agent as agentService } from '../../packages/api-agent/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, lifecycle, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 删除会话时停掉这个会话在跑的回合：会话管理先发 session:deleted、再清数据，agent 在这个事件里中止这个会话各 lane 的在飞
// 回合并等它们收尾，所以清数据一定在回合停下之后。被停的一轮不落库、不外发；别的会话的回合照常跑完。
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
});
