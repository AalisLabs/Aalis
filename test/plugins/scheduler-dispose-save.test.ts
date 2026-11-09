import { afterEach, expect, it } from 'vitest';
import { cronEngine } from '../../packages/api-cron-engine/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import schedulerPlugin, { scheduler } from '../../packages/plugin-scheduler/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { memoryStorage } from '../fixtures/memory-storage.js';

// ════════════════════════════════════════════════════════════
// 动态任务的增删改排队下发整表写盘、不等它落定。拆卸若也不等，重启时新实例读文件读在旧实例那次写之前：
// 刚建的任务不在新实例里，不再调度；新实例下一次写盘按它的内存整表重写，那次改动从文件里也没了。
// 清理段之后拿着旧服务对象新建与修改的，不再收下：在旧实例上挂的定时器与 cron 订阅清理不再撤，照常触发，
// 还按旧实例的内存整表写盘，盖掉新实例的文件。
// 真插件 + 写盘慢一拍的内存 storage + 假 cron-engine。
// ════════════════════════════════════════════════════════════

const WRITE_MS = 50;

const cronEngineStub = {
  subscribe: () => () => {},
  validate: () => ({ ok: true }),
  nextFireTime: () => null,
};

let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const job = (name: string) => ({
  name,
  content: 'x',
  sessionId: 'internal',
  platform: 'internal',
  enabled: true,
  actorPlatform: 'onebot',
  actorUserId: '10001',
});

/** 启动一个实例：真 tools 与 scheduler、内存 storage（slowWrites 时每次写盘慢 WRITE_MS）、假 cron-engine */
async function start(slowWrites = false) {
  app = new App({ name: 'T', logLevel: 'error' });
  const mem = memoryStorage();
  const service = slowWrites
    ? {
        ...mem.service,
        async writeFile(uri: string, data: string | Buffer) {
          await new Promise(r => setTimeout(r, WRITE_MS));
          await mem.service.writeFile(uri, data);
        },
      }
    : mem.service;
  const host = app.bind({ provide, services, events });
  host.provide.use(storage, service as never);
  host.provide.use(cronEngine, cronEngineStub as never);
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.register(schedulerPlugin, { jobs: [] });
  await app.plugins.idle();
  const svcOf = () => {
    const svc = host.services.use.get(scheduler);
    if (!svc) throw new Error('scheduler 服务未注册');
    return svc;
  };
  return { app, host, mem, svcOf };
}

it('scheduler 重启：重启前刚建的动态任务在新实例里照常存在', async () => {
  const s = await start(true);
  s.svcOf().addJob({ ...job('zz-new'), interval: 3600 });
  await s.app.plugins.bounce(schedulerPlugin.name);
  await s.app.plugins.idle();

  expect(
    s
      .svcOf()
      .getJobs()
      .map(j => j.name),
  ).toEqual(['zz-new']);
});

it('scheduler 重启之后拿着旧服务对象新建与修改：拒收，旧实例不挂定时器、不写盘', async () => {
  const s = await start();
  const old = s.svcOf();
  await s.app.plugins.bounce(schedulerPlugin.name);
  await s.app.plugins.idle();
  s.svcOf().addJob({ ...job('zz-kept'), interval: 3600 });
  await expect.poll(() => s.mem.files.get('data:/scheduler-jobs.json') ?? '').toContain('zz-kept');
  const saved = s.mem.files.get('data:/scheduler-jobs.json');
  const started: string[] = [];
  s.host.events.use.on('scheduler:job:start', name => {
    started.push(name);
  });

  // 已过期的一次性任务：收下的话旧实例下一轮定时器就执行
  const late = { ...job('zz-late'), runAt: new Date(Date.now() - 1000).toISOString() };
  expect(() => old.addJob(late)).toThrow('计划任务服务已关闭，任务 zz-late 没有收下');
  expect(() => old.setJob(late)).toThrow('计划任务服务已关闭，任务 zz-late 没有收下');
  await new Promise(r => setTimeout(r, 20));

  expect(started, '旧实例执行了拒收的任务').toEqual([]);
  expect(s.mem.files.get('data:/scheduler-jobs.json'), '旧实例按它的内存整表写了盘').toBe(saved);
  expect(
    s
      .svcOf()
      .getJobs()
      .map(j => j.name),
  ).toEqual(['zz-kept']);
});
