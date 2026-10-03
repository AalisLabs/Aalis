import { afterEach, describe, expect, it, vi } from 'vitest';
import { cronEngine } from '../../packages/api-cron-engine/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import schedulerPlugin, { scheduler } from '../../packages/plugin-scheduler/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { memoryStorage } from '../fixtures/memory-storage.js';
import { pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 一次性任务的远期 runAt：setTimeout 的 delay 超过 2^31-1ms（约 24.8 天）会溢出成立即触发，
// 「一个月后提醒我」变成「现在就提醒」并随即删除任务。分段重排后到点前一次都不能执行。
// 真插件 + 假 storage + 假 cron-engine（runAt 任务不经 cron），假时钟推进月级时间。
// ════════════════════════════════════════════════════════════

const DAY = 86_400_000;

const cronEngineStub = {
  subscribe: () => () => {},
  validate: () => ({ ok: true }),
  nextFireTime: () => null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler 一次性任务的远期 runAt', () => {
  it('runAt = +30 天：推进 25 天不执行，到点执行一次并删除', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ provide, services, events });
    host.provide(storage, memoryStorage().service as never);
    host.provide(cronEngine, cronEngineStub as never);
    // 计划任务页的「新建」经 webui-server 的真实登记表调用
    const pages = pageHost();
    host.provide(webuiServer, pages.service);
    await app.plugins.register(toolsPlugin, {});
    await app.plugins.register(schedulerPlugin, { jobs: [] });
    await app.plugins.idle();

    const started: string[] = [];
    host.events.on('scheduler:job:start', name => {
      started.push(name);
    });
    const jobs = () => host.services.get(scheduler)?.getJobs() ?? [];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const runAt = new Date(Date.now() + 30 * DAY).toISOString();
      const res = await pages.act('scheduler', 'createJob', {
        input: { name: 'far', sessionId: 'internal', platform: 'internal', content: 'x', enabled: true, runAt },
      });
      expect(res).toEqual({ status: 200, body: { message: '已保存任务 far' } });

      // 25 天已越过 setTimeout 上限：溢出写法在这里早就执行并删掉任务了
      await vi.advanceTimersByTimeAsync(25 * DAY);
      expect(started, '未到 runAt 不得执行').toEqual([]);
      expect(
        jobs().some(j => j.name === 'far'),
        '未到点任务不得被删除',
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(5 * DAY + 1000);
      expect(started).toEqual(['far']);
      expect(
        jobs().some(j => j.name === 'far'),
        '一次性任务执行后自动删除',
      ).toBe(false);
    } finally {
      vi.useRealTimers();
      await app.stop().catch(() => {});
      pages.dispose();
    }
  });
});
