import { storage } from '@aalis/api-storage';
import { type WebuiActionHandler, webuiServer } from '@aalis/api-webui';
import { App, LogHub, provide, services } from '@aalis/core';
import type { LogEntry } from '@aalis/schema-log';
import { describe, expect, it } from 'vitest';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin, { type SchedulerService, scheduler } from '../../packages/plugin-scheduler/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// WebUI「计划任务」表单的两个字段曾是假开关：schema 声明了 delaySeconds 与 paused，
// upsertJob 却只读 cron / interval / runAt / enabled ——
//   • 只填「X 秒后执行一次」→ 被判成「没填调度方式」直接报错；
//   • 勾「创建后立即暂停」→ 任务照常跑。
// 转换必须与 scheduler_create_job 工具路径同一份（delay>0 → runAt=now+N 秒）。
//
// 页面动作是 apply 里的闭包，经 webui 登记；测试装上真插件、用桩 webui 截下登记表按名调用。
// ════════════════════════════════════════════════════════════

/** 只够 scheduler 读写持久化文件的 storage（非通用 fixture）。 */
function memoryStorage() {
  const files = new Map<string, string>();
  return {
    files,
    service: {
      listRoots: () => [
        {
          name: 'data',
          label: 'data(内存)',
          kind: 'data',
          browsable: true,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
      async readFile(uri: string) {
        const v = files.get(uri);
        if (v === undefined) throw new Error(`ENOENT: ${uri}`);
        return v;
      },
      async writeFile(uri: string, data: string | Buffer) {
        files.set(uri, typeof data === 'string' ? data : data.toString('utf-8'));
      },
    },
  };
}

/** 调度表里的一行（scheduler 服务自己的投影类型，测试不再手抄一份） */
type JobView = ReturnType<SchedulerService['getJobs']>[number];

type UpsertResult = { ok: boolean; error?: string };

interface Harness {
  app: App;
  /** 按名调用 upsertJob 页面动作（caller = 权限闸放行后的 owner 快照） */
  upsert(args: Record<string, unknown>): Promise<UpsertResult>;
  /** 当前调度表快照 */
  jobs(): JobView[];
  svc(): SchedulerService | undefined;
  /** 桩 webui 截下的动作登记表 */
  actions: Map<string, WebuiActionHandler>;
  warns: string[];
}

async function withScheduler(
  fn: (h: Harness) => Promise<void>,
  /** 预置到持久化文件里的「存量」动态任务（模拟老版本写下的 JSON） */
  persisted?: unknown[],
) {
  const hub = new LogHub();
  const warns: string[] = [];
  const off = hub.onEntry((e: LogEntry) => {
    if (e.level === 'warn') warns.push(e.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  const host = app.bind({ provide, services });
  const store = memoryStorage();
  if (persisted) store.files.set('data:/scheduler-jobs.json', JSON.stringify(persisted));
  host.provide(storage, store.service as never);
  const actions = new Map<string, WebuiActionHandler>();
  host.provide(webuiServer, {
    registerPage: () => () => {},
    registerAction(method: string, handler: WebuiActionHandler) {
      actions.set(method, handler);
      return () => void actions.delete(method);
    },
  } as never);
  await app.plugins.register(toolsPlugin, {});
  await app.plugins.register(cronEnginePlugin, {});
  await app.plugins.register(schedulerPlugin, { jobs: [] });
  await app.plugins.idle();

  const svc = () => host.services.get(scheduler);
  const harness: Harness = {
    app,
    async upsert(args) {
      const handler = actions.get('upsertJob');
      // 动作缺席（没登记上去）在此直接抛错——管理面整体消失这条回归不会被静默吞掉
      if (!handler) throw new Error('页面动作 "upsertJob" 未登记 —— 管理面缺失');
      return (await handler(args, { platform: 'webui', userId: 'console' })) as UpsertResult;
    },
    jobs: () => svc()?.getJobs() ?? [],
    svc,
    actions,
    warns,
  };
  try {
    await fn(harness);
  } finally {
    await app.stop().catch(() => {});
    off();
  }
}

const base = { name: 'j', sessionId: 'internal', platform: 'internal', content: 'x', enabled: true };

describe('WebUI 计划任务表单 upsertJob', () => {
  it('只填 delaySeconds 即为合法调度方式，换算成 runAt = now + N 秒', async () => {
    await withScheduler(async ({ upsert, jobs }) => {
      const before = Date.now();
      const res = await upsert({ ...base, delaySeconds: 600 });
      expect(res, `delaySeconds 被丢弃：${res.error ?? ''}`).toEqual({ ok: true });
      const job = jobs().find(j => j.name === 'j');
      expect(job?.runAt, 'delaySeconds 未换算成 runAt').toBeTruthy();
      const at = Date.parse(job?.runAt as string);
      expect(at).toBeGreaterThanOrEqual(before + 600_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 600_000);
    });
  });

  it('勾「创建后立即暂停」→ 任务落地即 paused', async () => {
    await withScheduler(async ({ upsert, jobs }) => {
      const res = await upsert({ ...base, interval: 60, paused: true });
      expect(res).toEqual({ ok: true });
      const job = jobs().find(j => j.name === 'j');
      expect(job?.enabled, '启用位不该被暂停牵连').toBe(true);
      expect(job?.paused, '勾了「创建后立即暂停」却照常运行').toBe(true);
    });
  });

  it('不勾暂停则照常就绪（反向锚，避免上一条恒真）', async () => {
    await withScheduler(async ({ upsert, jobs }) => {
      await upsert({ ...base, interval: 60 });
      expect(jobs().find(j => j.name === 'j')?.paused).toBe(false);
    });
  });

  it('runAt 与 delaySeconds 同时填写 → 明确报错，不静默取其一', async () => {
    await withScheduler(async ({ upsert }) => {
      const res = await upsert({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString(), delaySeconds: 600 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/互斥/);
    });
  });

  it('cron 与 interval 同时填写 → 互斥报错（不再静默双挂周期任务）', async () => {
    await withScheduler(async ({ upsert, jobs }) => {
      const res = await upsert({ ...base, cron: '@daily', interval: 60 });
      expect(res.ok, 'cron+interval 被静默接受').toBe(false);
      expect(res.error).toMatch(/互斥/);
      expect(jobs(), '报错后不该落地任何任务').toHaveLength(0);
    });
  });

  it('勾暂停 + delaySeconds → 报错（一次性任务被暂停会永久卡住，无可用语义）', async () => {
    await withScheduler(async ({ upsert, jobs }) => {
      const res = await upsert({ ...base, delaySeconds: 600, paused: true });
      expect(res.ok, '暂停的一次性任务被接受，将永久卡在队列里').toBe(false);
      expect(res.error).toMatch(/没有可用语义/);
      expect(jobs()).toHaveLength(0);
    });
  });

  it('一次性任务不能暂停：pauseJob 拒绝并返回 false（否则永久卡在队列里）', async () => {
    await withScheduler(async ({ upsert, jobs, svc }) => {
      expect(await upsert({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString() })).toEqual({ ok: true });
      expect(svc()?.pauseJob('j'), '一次性任务被暂停，到点定时器直接跳过且不重排').toBe(false);
      expect(jobs().find(j => j.name === 'j')?.paused, '拒绝后不该留下暂停态').toBe(false);
    });
  });

  it('周期任务照常可暂停（反向锚，避免上一条恒假）', async () => {
    await withScheduler(async ({ upsert, jobs, svc }) => {
      expect(await upsert({ ...base, interval: 60 })).toEqual({ ok: true });
      expect(svc()?.pauseJob('j')).toBe(true);
      expect(jobs().find(j => j.name === 'j')?.paused).toBe(true);
    });
  });

  it('存量持久化里的「一次性 + paused」启动时告警并按未暂停处理（否则永久卡在队列里）', async () => {
    await withScheduler(
      async ({ jobs, warns }) => {
        const job = jobs().find(j => j.name === 'stale');
        expect(job, '存量任务应照常加载').toBeTruthy();
        expect(job?.paused, '存量的暂停态一次性任务被原样收下，到点跳过且不重排 = 永久卡住').toBe(false);
        expect(
          warns.filter(w => w.includes('一次性任务却带 paused')),
          '按未暂停处理必须出声',
        ).toHaveLength(1);
      },
      [
        {
          name: 'stale',
          runAt: new Date(Date.now() + 3_600_000).toISOString(),
          paused: true,
          enabled: true,
          sessionId: 'internal',
          platform: 'internal',
          actorPlatform: 'webui',
          actorUserId: 'console',
          content: 'x',
        },
      ],
    );
  });

  it('存量周期任务的 paused 照常保留（反向锚，避免上一条恒假）', async () => {
    await withScheduler(
      async ({ jobs }) => {
        const job = jobs().find(j => j.name === 'stale-cron');
        expect(job?.paused, '周期任务的暂停是有效语义，不该被清掉').toBe(true);
      },
      [
        {
          name: 'stale-cron',
          interval: 60,
          paused: true,
          enabled: true,
          sessionId: 'internal',
          platform: 'internal',
          actorPlatform: 'webui',
          actorUserId: 'console',
          content: 'x',
        },
      ],
    );
  });

  it('已过期的 runAt 暂停时不立刻补跑：过期分支与未到点分支同一判据', async () => {
    await withScheduler(
      async ({ jobs }) => {
        // 过期分支走 setImmediate，让出两轮宏任务等它跑完
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        const job = jobs().find(j => j.name === 'due-paused');
        expect(job?.paused, '带 cron 的任务可以暂停，暂停态应保留').toBe(true);
        expect(job?.runCount, '过期分支没看 paused，暂停的任务启动即被补跑一次').toBe(0);
      },
      [
        {
          name: 'due-paused',
          cron: '0 0 * * *',
          runAt: new Date(Date.now() - 3_600_000).toISOString(),
          paused: true,
          enabled: true,
          sessionId: 'internal',
          platform: 'internal',
          actorPlatform: 'webui',
          actorUserId: 'console',
          content: 'x',
        },
      ],
    );
  });

  it('四个调度字段全空仍然报错', async () => {
    await withScheduler(async ({ upsert }) => {
      const res = await upsert({ ...base });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/必须填写其中之一/);
    });
  });

  it('动作与调度表同生共死：插件卸下后动作一并从登记表撤回', async () => {
    // 动作是 apply 里的闭包，直接操作本次激活的调度表，不再有「动作在、服务不在」的中间态
    // ——旧实现正是在那个中间态里把环境故障（服务未就绪）说成用户输入错误（任务不存在）。
    // 该中间态的消失由此条守住：卸下插件后登记必须一并撤回，否则残留的处理函数会继续
    // 操作一张没人维护的调度表。
    await withScheduler(async ({ app, actions }) => {
      const methods = ['upsertJob', 'pauseJob', 'resumeJob', 'removeJob'];
      expect(
        methods.filter(m => actions.has(m)),
        '前置：动作没登记上，本用例没测到东西',
      ).toEqual(methods);
      await app.plugins.unload(schedulerPlugin.name);
      expect(
        methods.filter(m => actions.has(m)),
        '插件已卸下，动作却还留在登记表里',
      ).toEqual([]);
    });
  });
});
