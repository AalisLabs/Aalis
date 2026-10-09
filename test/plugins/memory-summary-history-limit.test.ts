import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { endTurn, fakeSummaryLLM } from '../fixtures/memory-summary.js';

// ════════════════════════════════════════════════════════════
// 条数线是 agent 登记的会话设置项 historyLimit：回合结束时的会话条数（这一轮最后一次调用里来自会话历史的条数，结局为
// replied 时加上之后落库的最终回复）到了它，摘要插件就在后台全量压缩，与用量到线同一条流程、同一套按轮数的失败退避。
// 0 或哪一层都没设时不按条数压缩。下面的用量都远不到压缩线（窗口与裁剪预算 1000，用量 10）。
// ════════════════════════════════════════════════════════════

const settle = () => new Promise<void>(r => setTimeout(r, 20));
/** 用量远不到压缩线，只有会话条数 */
const counted = (historyMessages: number) => ({ used: 10, compressible: 10, historyMessages });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(summaryLLM = fakeSummaryLLM()) {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, memory, sessionManager });
  await app.plugin(memoryInMemory);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  host.provide(llm, summaryLLM.model);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugin(memorySummary);
  await app.plugins.idle();
  for (const plugin of [agentPlugin, memorySummary]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
  }
  const statuses: string[] = [];
  host.events.on('session:compressing', info => void statuses.push(`${info.sessionId}:${info.status}`));
  const sm = host.sessionManager.require();
  const say = (sessionId: string) => host.memory.require().saveMessage(sessionId, { role: 'user', content: '在吗' });
  return { host, sm, summaryLLM, statuses, say };
}

describe('plugin-memory-summary: 条数线', () => {
  it('回合结束时的会话条数含落库的最终回复：结局为 replied 时最后一次调用的条数加一，静默的一轮不加', async () => {
    const { host, sm, statuses, say } = await setup();
    const owner = await sm.createSession({ name: '本机会话', config: { historyLimit: 5 } });
    await say(owner.id);

    await endTurn(host, owner.id, counted(4), { outcome: 'silent' });
    await settle();
    expect(statuses).toEqual([]);

    await endTurn(host, owner.id, counted(4), { outcome: 'replied' });
    await expect.poll(() => statuses).toEqual([`${owner.id}:start`, `${owner.id}:done`]);
  });

  it('条数线为 0 或哪一层都没设：会话条数再多也不按条数压缩', async () => {
    const { host, sm, summaryLLM, say } = await setup();
    const unset = await sm.createSession({ name: '没设' });
    const zero = await sm.createSession({ name: '设为 0', config: { historyLimit: 0 } });
    for (const session of [unset, zero]) {
      await say(session.id);
      await endTurn(host, session.id, counted(600));
    }
    await settle();
    expect(summaryLLM.requests).toHaveLength(0);
  });

  it('条数到线而没压成：与用量到线同一套按轮数的退避，隔一轮再试并压成', async () => {
    let fail = true;
    const summaryLLM = fakeSummaryLLM({
      reply: () => {
        if (fail) throw new Error('fake timeout');
        return 'NEW-SUMMARY';
      },
    });
    const { host, sm, statuses, say } = await setup(summaryLLM);
    const owner = await sm.createSession({ name: '本机会话', config: { historyLimit: 5 } });
    await say(owner.id);

    await endTurn(host, owner.id, counted(5));
    await expect.poll(() => statuses).toEqual([`${owner.id}:start`, `${owner.id}:error`]);

    fail = false;
    await endTurn(host, owner.id, counted(6));
    await settle();
    expect(summaryLLM.requests).toHaveLength(1);

    await endTurn(host, owner.id, counted(7));
    await expect.poll(() => statuses.slice(2)).toEqual([`${owner.id}:start`, `${owner.id}:done`]);
    expect((await host.memory.require().getMetadata('summary', owner.id))?.summary).toBe('NEW-SUMMARY');
  });
});
