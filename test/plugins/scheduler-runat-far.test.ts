import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../packages/core/src/index.js';
import * as schedulerModule from '../../packages/plugin-scheduler/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// 一次性任务的远期 runAt：setTimeout 的 delay 超过 2^31-1ms（约 24.8 天）会溢出成立即触发，
// 「一个月后提醒我」变成「现在就提醒」并随即删除任务。分段重排后到点前一次都不能执行。
// 真插件 + 假 storage + 假 cron-engine（runAt 任务不经 cron），假时钟推进月级时间。
// ════════════════════════════════════════════════════════════

const DAY = 86_400_000;

function memoryStorage() {
  const files = new Map<string, string>();
  return {
    listRoots: () => [
      { name: 'data', label: 'data', kind: 'data', browsable: true, readable: true, writable: true, deletable: true },
    ],
    async readFile(uri: string) {
      const v = files.get(uri);
      if (v === undefined) throw new Error(`ENOENT: ${uri}`);
      return v;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, typeof data === 'string' ? data : data.toString('utf-8'));
    },
  };
}

const cronEngineStub = {
  subscribe: () => () => {},
  validate: () => ({ ok: true }),
  nextFireTime: () => null,
};

interface JobView {
  name: string;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler 一次性任务的远期 runAt', () => {
  it('runAt = +30 天：推进 25 天不执行，到点执行一次并删除', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('storage', memoryStorage() as never);
    app.ctx.provide('cron-engine', cronEngineStub as never);
    await app.ctx.useModule(toolsModule as never, {});
    await app.ctx.useModule(schedulerModule as never, { jobs: [] });
    await app.plugins.idle();

    const started: string[] = [];
    app.ctx.on(
      'scheduler:job:start' as never,
      ((name: string) => {
        started.push(name);
      }) as never,
    );
    const jobs = () => app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? [];
    const actions = (
      schedulerModule as unknown as {
        actions: Record<string, (ctx: unknown, args: Record<string, unknown>, caller?: unknown) => Promise<unknown>>;
      }
    ).actions;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const runAt = new Date(Date.now() + 30 * DAY).toISOString();
      const res = await actions.upsertJob(
        app.ctx,
        { name: 'far', sessionId: 'internal', platform: 'internal', content: 'x', enabled: true, runAt },
        { platform: 'webui', userId: 'console' },
      );
      expect(res).toEqual({ ok: true });

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
    }
  });
});
