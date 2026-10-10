import { afterEach, describe, expect, it } from 'vitest';
import { authority } from '../../packages/api-authority/src/index.js';
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
import { seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 条数线是 agent 登记的会话设置项 historyLimit：回合结束时的会话条数（这一轮最后一次调用里来自会话历史的条数，结局为
// replied 时加上之后落库的最终回复）到了它，摘要插件就在后台全量压缩，与用量到线同一条流程、同一套按轮数的失败退避。
// 0 或哪一层都没设时不按条数压缩。条数线与压缩线同一套层：全局默认、平台档、平台类型档、场所与单个会话。
// 下面的用量都远不到压缩线（窗口与裁剪预算 1000，用量 10）。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:1';
/** 同一个群里另一个机器人账号的会话 */
const ROOM_B = 'onebot:20000:group:1';
const WINDOW = 'onebot:group:1';
/** 别人的私聊 */
const OTHER_DM = 'onebot:10000:private:30001';
/** owner 的 IM 私聊：场所是默认工作区 */
const OWNER_DM = 'onebot:10000:private:99999';

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
  await app.plugins.idle();
  // 房间收录过（预置进会话表）：选平台档与平台类型档读会话记下的出生平台与聊天窗口
  await seedRooms(host.memory.use, { [ROOM]: '群', [ROOM_B]: '群', [OTHER_DM]: '别人', [OWNER_DM]: 'owner' });
  host.provide.use(authority, {
    isOwner: (platform: string, userId?: string) => platform === 'onebot' && userId === '99999',
  } as never);
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  host.provide.use(llm, summaryLLM.model);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugin(memorySummary);
  await app.plugins.idle();
  for (const plugin of [agentPlugin, memorySummary]) {
    expect(app.plugins.getPlugin(plugin.name)?.state, `${plugin.name} 未激活`).toBe('active');
  }
  const statuses: string[] = [];
  host.events.use.on('session:compressing', info => void statuses.push(`${info.sessionId}:${info.status}`));
  const sm = host.sessionManager.use;
  const say = (sessionId: string) => host.memory.use.saveMessage(sessionId, { role: 'user', content: '在吗' });
  /** 每个会话说一句、再以这些条数结束一轮，返回至今压成过的会话（排好序） */
  const turns = async (sessionIds: string[], historyMessages: number) => {
    for (const id of sessionIds) {
      await say(id);
      await endTurn(host, id, counted(historyMessages), { platform: id.startsWith('onebot:') ? 'onebot' : 'webui' });
    }
    await settle();
    return statuses
      .filter(s => s.endsWith(':done'))
      .map(s => s.slice(0, -':done'.length))
      .sort();
  };
  return { host, sm, summaryLLM, statuses, say, turns };
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
    expect((await host.memory.use.getMetadata('summary', owner.id))?.summary).toBe('NEW-SUMMARY');
  });

  it('平台类型档：群的条数线给群里各个机器人账号的会话与群的子会话，别人的私聊与 WebUI 会话不受影响', async () => {
    const { sm, turns } = await setup();
    await sm.updateLayer({ scope: 'type', platform: 'onebot', type: 'group' }, { historyLimit: 5 });
    const child = await sm.createChildSession(ROOM, { name: '群里派出的子任务' });
    const owner = await sm.createSession({ name: '本机会话' });

    expect(await turns([ROOM, ROOM_B, child.id, OTHER_DM, owner.id], 5)).toEqual([ROOM, ROOM_B, child.id].sort());
  });

  it('场所压过平台类型档：窗口场所的值给这个群的会话；默认工作区的值压过 owner 的 IM 私聊上的类型档', async () => {
    const { sm, turns } = await setup();
    await sm.updateLayer({ scope: 'type', platform: 'onebot', type: 'group' }, { historyLimit: 5 });
    await sm.updateLayer({ scope: 'type', platform: 'onebot', type: 'private' }, { historyLimit: 5 });
    await sm.updateLayer({ scope: 'place', key: WINDOW }, { historyLimit: 50 });
    await sm.updateLayer({ scope: 'place', key: 'workspace:default' }, { historyLimit: 50 });

    expect(await turns([ROOM, ROOM_B, OWNER_DM, OTHER_DM], 5), '只有别人的私聊按类型档的 5 压').toEqual([OTHER_DM]);
    expect(await turns([ROOM, OWNER_DM], 50)).toEqual([OTHER_DM, ROOM, OWNER_DM].sort());
  });
});
