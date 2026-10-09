import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { compression, memory } from '../../packages/api-memory/src/index.js';
import { isSessionConfigError, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import memorySummary from '../../packages/plugin-memory-summary/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { endTurn, fakeSummaryLLM } from '../fixtures/memory-summary.js';
import { seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 自动压缩线是会话设置项 compressAt（摘要插件登记）：占窗口比例，各层都没设时 0.8，0 表示不按用量压缩。
// 全局默认、平台档与单个会话按层覆盖；没有出生平台的会话按入口平台选平台档。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:1';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const { app } = hostedApp();
  apps.push(app);
  await registerHubs(app);
  const summaryLLM = fakeSummaryLLM();
  const host = app.bind({ provide, events, hooks, memory, compression, sessionManager });
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  // 群房间收录过（预置进会话表）：选平台档读会话记下的出生平台
  await seedRooms(host.memory.require(), { [ROOM]: '群' });
  await app.plugin(messageArchive, { debugLogs: false });
  await app.plugin(sessionManagerPlugin);
  host.provide(llm, summaryLLM.model);
  await app.plugin(memorySummary);
  await app.plugins.idle();
  if (app.plugins.getPlugin(memorySummary.name)?.state !== 'active') throw new Error('plugin-memory-summary 未激活');
  const sm = host.sessionManager.require();
  const owner = await sm.createSession({ name: '本机会话' });
  const child = await sm.createChildSession(ROOM, { name: '群里派出的子任务' });
  return { host, sm, owner, child, summaryLLM, compressAt: host.compression.require().compressAt };
}

describe('plugin-memory-summary: 自动压缩线', () => {
  it('登记为高级设置项：0 到 1，默认 0.8，只经继承链实时解析', async () => {
    const { sm } = await setup();
    const setting = sm.listSettings().find(s => s.key === 'compressAt');
    expect(setting).toMatchObject({
      plugin: memorySummary.name,
      field: { type: 'number', min: 0, max: 1, default: 0.8 },
      prominence: 'advanced',
      liveOnly: true,
    });
  });

  it('哪一层都没设时 0.8：本机根会话、群的根会话与子会话相同', async () => {
    const { owner, child, compressAt } = await setup();
    expect([compressAt(owner.id, 'webui'), compressAt(ROOM), compressAt(child.id)]).toEqual([0.8, 0.8, 0.8]);
  });

  it('全局默认、平台档与会话自己的设置按层生效；没有出生平台的会话按入口平台选平台档', async () => {
    const { sm, owner, compressAt } = await setup();
    await sm.updateLayer({ scope: 'defaults' }, { compressAt: 0.5 });
    expect([compressAt(owner.id, 'webui'), compressAt(ROOM)]).toEqual([0.5, 0.5]);

    await sm.updateLayer({ scope: 'platform', platform: 'webui' }, { compressAt: 0.3 });
    await sm.updateLayer({ scope: 'platform', platform: 'onebot' }, { compressAt: 0.06 });
    expect([compressAt(owner.id, 'webui'), compressAt(owner.id, 'cli'), compressAt(ROOM, 'webui')]).toEqual([
      0.3, 0.5, 0.06,
    ]);

    await sm.updateSession(ROOM, { config: { compressAt: 0.1 } });
    expect(compressAt(ROOM)).toBe(0.1);
  });

  it.each([1.5, -0.1])('写 %d 被拒', async value => {
    const { sm, owner } = await setup();
    for (const write of [
      sm.updateLayer({ scope: 'defaults' }, { compressAt: value }),
      sm.updateSession(owner.id, { config: { compressAt: value } }),
    ]) {
      await expect(write).rejects.toSatisfy(isSessionConfigError);
    }
  });

  it('设为 0：压缩线为 undefined，用量到线的回合结束也不压缩；手动压缩照常', async () => {
    const { host, sm, owner, summaryLLM, compressAt } = await setup();
    await sm.updateSession(owner.id, { config: { compressAt: 0 } });
    expect(compressAt(owner.id, 'webui')).toBeUndefined();
    await host.memory.require().saveMessage(owner.id, { role: 'user', content: '在吗' });

    await endTurn(host, owner.id, { used: 990, compressible: 900 });
    await new Promise<void>(r => setTimeout(r, 20));
    expect(summaryLLM.requests).toHaveLength(0);

    await host.compression.require().compress(owner.id, { reason: 'manual' });
    expect(summaryLLM.requests).toHaveLength(1);
  });

  it('回合结束的判定按会话与用量事件上的平台取压缩线', async () => {
    const { host, sm, owner, summaryLLM } = await setup();
    await sm.updateLayer({ scope: 'platform', platform: 'webui' }, { compressAt: 0.3 });
    const other = await sm.createSession({ name: '终端会话' });
    for (const id of [owner.id, other.id])
      await host.memory.require().saveMessage(id, { role: 'user', content: '在吗' });

    // 有效阈值：webui 平台档 0.3 × 1000 = 300；cli 没有平台档，按默认 0.8 为 800
    await endTurn(host, other.id, { used: 400, compressible: 400 }, { platform: 'cli' });
    await new Promise<void>(r => setTimeout(r, 20));
    expect(summaryLLM.requests).toHaveLength(0);

    await endTurn(host, owner.id, { used: 400, compressible: 400 }, { platform: 'webui' });
    await expect.poll(() => summaryLLM.requests.map(r => r.sessionId)).toEqual([owner.id]);
  });
});
