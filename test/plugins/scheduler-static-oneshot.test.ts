import { afterEach, describe, expect, it } from 'vitest';
import { cronEngine } from '../../packages/api-cron-engine/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import schedulerPlugin from '../../packages/plugin-scheduler/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-storage.js';

// ════════════════════════════════════════════════════════════
// 配置里的一次性任务按闹钟做：响过就关。执行前把「任务名 + runAt」记进持久化文件，之后每次激活（宿主重启、重载本插件、
// storage 重启）见到记录就不再执行；过点而没有记录的（如停机时错过）补一次；配置里改了 runAt 算新的一次。
// 记录读不出时无从判断执行过没有，本次运行不安排。
// 真插件 + 由插件提供的内存 storage（停用、启用它时 scheduler 随之停下、重新激活）+ 假 cron-engine（runAt 不经 cron）。
// ════════════════════════════════════════════════════════════

const JOBS = 'data:/scheduler-jobs.json';
const PAST = '2026-01-01T00:00:00.000Z';
const PAST_2 = '2026-02-01T00:00:00.000Z';

const cronEngineStub = {
  subscribe: () => () => {},
  validate: () => ({ ok: true }),
  nextFireTime: () => null,
};

const oneShot = (runAt: string) => ({ name: 'once', runAt, content: 'x', sessionId: 'internal', platform: 'internal' });

/** 过期的一次性任务排 0ms 定时器：激活落定后等一个更晚的定时器，该执行的都已执行 */
const settle = () => new Promise(r => setTimeout(r, 20));

let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

/** 启动一个实例：storage 是 mem（换实例时文件留着），配置里放 jobs；返回执行过的任务名（按次）。激活落定即返回 */
async function boot(mem: ReturnType<typeof memoryStorage>, jobs: unknown[]) {
  app = new App({ name: 'T', logLevel: 'error' });
  provideEvents(app);
  const host = app.bind({ provide, events });
  host.provide.use(cronEngine, cronEngineStub as never);
  await app.plugins.register(
    definePlugin({
      name: 'zz-storage',
      provides: [storage],
      uses: { provide },
      apply(caps) {
        caps.provide.use(storage, mem.service as never);
      },
    }),
    {},
  );
  const started: string[] = [];
  host.events.use.on('scheduler:job:start', name => {
    started.push(name);
  });
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.register(schedulerPlugin, { jobs });
  await app.plugins.idle();
  return { app, started };
}

/** 同 boot，等到过期的一次性任务执行过再返回 */
async function start(mem: ReturnType<typeof memoryStorage>, jobs: unknown[]) {
  const booted = await boot(mem, jobs);
  await settle();
  return booted;
}

describe('scheduler 配置里的一次性任务', () => {
  it('过点而没执行过的补一次，执行前记下「任务名 + runAt」', async () => {
    const mem = memoryStorage();
    const { started } = await start(mem, [oneShot(PAST)]);
    expect(started).toEqual(['once']);
    expect(JSON.parse(mem.files.get(JOBS) ?? 'null')).toEqual({ jobs: [], onceFired: { once: PAST } });
  });

  it('激活后紧接着重载本插件：过期的只执行一次，旧实例拆卸之后不再执行', async () => {
    const mem = memoryStorage();
    const { app, started } = await boot(mem, [oneShot(PAST)]);
    await app.plugins.bounce(schedulerPlugin.name);
    await app.plugins.idle();
    await settle();
    expect(started).toEqual(['once']);
    expect(JSON.parse(mem.files.get(JOBS) ?? 'null')).toEqual({ jobs: [], onceFired: { once: PAST } });
  });

  it('执行过的 storage 重启后不再执行', async () => {
    const { app, started } = await start(memoryStorage(), [oneShot(PAST)]);
    expect(started).toEqual(['once']);
    await app.plugins.disable('zz-storage');
    await app.plugins.idle();
    expect(app.plugins.getPlugin(schedulerPlugin.name)?.state, '前置：scheduler 随 storage 停下').not.toBe('active');
    await app.plugins.enable('zz-storage');
    await app.plugins.idle();
    await settle();
    expect(app.plugins.getPlugin(schedulerPlugin.name)?.state).toBe('active');
    expect(started).toEqual(['once']);
  });

  it('执行过的宿主重启后不再执行', async () => {
    const mem = memoryStorage();
    const first = await start(mem, [oneShot(PAST)]);
    expect(first.started).toEqual(['once']);
    await first.app.stop();
    const second = await start(mem, [oneShot(PAST)]);
    expect(second.started).toEqual([]);
  });

  it('配置里改了 runAt 算新的一次：再执行一次，之后同样不重复', async () => {
    const { app, started } = await start(memoryStorage(), [oneShot(PAST)]);
    expect(started).toEqual(['once']);
    await app.plugins.updateConfig(schedulerPlugin.name, { jobs: [oneShot(PAST_2)] });
    await app.plugins.idle();
    await settle();
    expect(started).toEqual(['once', 'once']);
    await app.plugins.bounce(schedulerPlugin.name);
    await app.plugins.idle();
    await settle();
    expect(started).toEqual(['once', 'once']);
  });

  it('持久化文件读不出：无从判断执行过没有，本次运行不安排，文件不动', async () => {
    const broken = '{"jobs": [';
    const mem = memoryStorage({ [JOBS]: broken });
    const { started } = await start(mem, [oneShot(PAST)]);
    expect(started).toEqual([]);
    expect(mem.files.get(JOBS)).toBe(broken);
  });
});
