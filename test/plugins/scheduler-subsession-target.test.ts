import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, provide, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin, { scheduler } from '../../packages/plugin-scheduler/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-storage.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 在子会话里建定时任务要写明目标：子会话没有窗口，不传 sessionId 时默认的目标就是调用所在的子会话，子会话删掉后任务
// 静默丢失。按会话记录的 parentId 认子会话，与 onebot 群工具在子会话里要求显式给群号同一规则；根会话照旧默认当前会话。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot() {
  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, services, sessionManager });
  host.provide.use(storage, memoryStorage().service as never);
  host.provide.use(processService, {} as never);
  host.provide.use(memory, fakeMemory() as never);
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.register(cronEnginePlugin, {});
  await app.plugin(sessionManagerPlugin);
  await app.plugins.register(schedulerPlugin, { jobs: [] });
  await app.plugins.idle();
  const toolSvc = host.services.use.get(tools);
  if (!toolSvc) throw new Error('tools 服务未注册');
  toolSvc.setExecutionGuard(async () => null);
  return {
    sm: host.sessionManager.use,
    jobs: () => host.services.use.get(scheduler)?.getJobs() ?? [],
    /** 在 sessionId 所在的回合里调 scheduler_create_job（确认放行），回解析后的回执 */
    async create(sessionId: string, args: Record<string, unknown>) {
      const res = await toolSvc.execute(
        'scheduler_create_job',
        { delaySeconds: 600, content: '<提醒内容>', ...args },
        { sessionId, platform: 'onebot', userId: `parent:${ROOM}` },
      );
      return JSON.parse(res.content) as Record<string, unknown>;
    },
  };
}

describe('子会话里建定时任务要写明目标', () => {
  it('子会话里不传 sessionId（或只给空白）报错、不建任务；根会话照旧默认当前会话', async () => {
    const t = await boot();
    const child = await t.sm.createChildSession(ROOM);

    expect(await t.create(child.id, { name: 'in-child' })).toEqual({ error: expect.stringContaining('sessionId') });
    expect(await t.create(child.id, { name: 'blank', sessionId: '  ' })).toEqual({
      error: expect.stringContaining('sessionId'),
    });
    expect(t.jobs()).toEqual([]);

    expect(await t.create(ROOM, { name: 'in-room' })).toMatchObject({ ok: true });
    expect(t.jobs()).toEqual([expect.objectContaining({ name: 'in-room', sessionId: ROOM, platform: 'onebot' })]);
  });

  it('子会话里写明目标照常建，发往写明的会话', async () => {
    const t = await boot();
    const child = await t.sm.createChildSession(ROOM);

    expect(await t.create(child.id, { name: 'to-room', sessionId: ROOM })).toMatchObject({ ok: true });
    expect(t.jobs()).toEqual([expect.objectContaining({ name: 'to-room', sessionId: ROOM })]);
  });
});
