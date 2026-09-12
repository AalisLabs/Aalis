import { App, type LogEntry, LogHub } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import * as cronEngineModule from '../../packages/plugin-cron-engine/src/index.js';
import * as schedulerModule from '../../packages/plugin-scheduler/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// WebUI「计划任务」表单的两个字段曾是假开关：schema 声明了 delaySeconds 与 paused，
// upsertJob 却只读 cron / interval / runAt / enabled ——
//   • 只填「X 秒后执行一次」→ 被判成「没填调度方式」直接报错；
//   • 勾「创建后立即暂停」→ 任务照常跑。
// 转换必须与 scheduler_create_job 工具路径同一份（delay>0 → runAt=now+N 秒）。
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

interface JobView {
  name: string;
  runAt?: string;
  paused: boolean;
  enabled: boolean;
  runCount: number;
}

type UpsertResult = { ok: boolean; error?: string };

async function withScheduler(
  fn: (app: App, upsert: (args: Record<string, unknown>) => Promise<UpsertResult>, warns: string[]) => Promise<void>,
  /** 预置到持久化文件里的「存量」动态任务（模拟老版本写下的 JSON） */
  persisted?: unknown[],
) {
  const hub = new LogHub();
  const warns: string[] = [];
  const off = hub.onEntry((e: LogEntry) => {
    if (e.level === 'warn') warns.push(e.message);
  });
  const app = new App({ config: { name: 'T', logLevel: 'warn', plugins: {} }, logHub: hub });
  const store = memoryStorage();
  if (persisted) store.files.set('data:/scheduler-jobs.json', JSON.stringify(persisted));
  app.ctx.provide('storage', store.service as never);
  await app.ctx.useModule(toolsModule as never, {});
  await app.ctx.useModule(cronEngineModule as never, {});
  await app.ctx.useModule(schedulerModule as never, { jobs: [] });
  await app.plugins.idle();
  const actions = (
    schedulerModule as unknown as {
      actions: Record<
        string,
        (ctx: unknown, args: Record<string, unknown>, caller?: { platform: string; userId: string }) => Promise<unknown>
      >;
    }
  ).actions;
  const upsert = (args: Record<string, unknown>) =>
    actions.upsertJob(app.ctx, args, { platform: 'webui', userId: 'console' }) as Promise<UpsertResult>;
  try {
    await fn(app, upsert, warns);
  } finally {
    await app.stop().catch(() => {});
    off();
  }
}

const base = { name: 'j', sessionId: 'internal', platform: 'internal', content: 'x', enabled: true };

describe('WebUI 计划任务表单 upsertJob', () => {
  it('只填 delaySeconds 即为合法调度方式，换算成 runAt = now + N 秒', async () => {
    await withScheduler(async (app, upsert) => {
      const before = Date.now();
      const res = await upsert({ ...base, delaySeconds: 600 });
      expect(res, `delaySeconds 被丢弃：${res.error ?? ''}`).toEqual({ ok: true });
      const jobs = app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? [];
      const job = jobs.find(j => j.name === 'j');
      expect(job?.runAt, 'delaySeconds 未换算成 runAt').toBeTruthy();
      const at = Date.parse(job?.runAt as string);
      expect(at).toBeGreaterThanOrEqual(before + 600_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 600_000);
    });
  });

  it('勾「创建后立即暂停」→ 任务落地即 paused', async () => {
    await withScheduler(async (app, upsert) => {
      const res = await upsert({ ...base, interval: 60, paused: true });
      expect(res).toEqual({ ok: true });
      const job = (app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? []).find(
        j => j.name === 'j',
      );
      expect(job?.enabled, '启用位不该被暂停牵连').toBe(true);
      expect(job?.paused, '勾了「创建后立即暂停」却照常运行').toBe(true);
    });
  });

  it('不勾暂停则照常就绪（反向锚，避免上一条恒真）', async () => {
    await withScheduler(async (app, upsert) => {
      await upsert({ ...base, interval: 60 });
      const job = (app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? []).find(
        j => j.name === 'j',
      );
      expect(job?.paused).toBe(false);
    });
  });

  it('runAt 与 delaySeconds 同时填写 → 明确报错，不静默取其一', async () => {
    await withScheduler(async (_app, upsert) => {
      const res = await upsert({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString(), delaySeconds: 600 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/互斥/);
    });
  });

  it('cron 与 interval 同时填写 → 互斥报错（不再静默双挂周期任务）', async () => {
    await withScheduler(async (app, upsert) => {
      const res = await upsert({ ...base, cron: '@daily', interval: 60 });
      expect(res.ok, 'cron+interval 被静默接受').toBe(false);
      expect(res.error).toMatch(/互斥/);
      expect(
        app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? [],
        '报错后不该落地任何任务',
      ).toHaveLength(0);
    });
  });

  it('勾暂停 + delaySeconds → 报错（一次性任务被暂停会永久卡住，无可用语义）', async () => {
    await withScheduler(async (app, upsert) => {
      const res = await upsert({ ...base, delaySeconds: 600, paused: true });
      expect(res.ok, '暂停的一次性任务被接受，将永久卡在队列里').toBe(false);
      expect(res.error).toMatch(/没有可用语义/);
      expect(app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? []).toHaveLength(0);
    });
  });

  it('一次性任务不能暂停：pauseJob 拒绝并返回 false（否则永久卡在队列里）', async () => {
    await withScheduler(async (app, upsert) => {
      expect(await upsert({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString() })).toEqual({ ok: true });
      const svc = app.ctx.getService<{ getJobs(): JobView[]; pauseJob(name: string): boolean }>('scheduler');
      expect(svc?.pauseJob('j'), '一次性任务被暂停，到点定时器直接跳过且不重排').toBe(false);
      const job = (svc?.getJobs() ?? []).find(j => j.name === 'j');
      expect(job?.paused, '拒绝后不该留下暂停态').toBe(false);
    });
  });

  it('周期任务照常可暂停（反向锚，避免上一条恒假）', async () => {
    await withScheduler(async (app, upsert) => {
      expect(await upsert({ ...base, interval: 60 })).toEqual({ ok: true });
      const svc = app.ctx.getService<{ getJobs(): JobView[]; pauseJob(name: string): boolean }>('scheduler');
      expect(svc?.pauseJob('j')).toBe(true);
      expect((svc?.getJobs() ?? []).find(j => j.name === 'j')?.paused).toBe(true);
    });
  });

  it('存量持久化里的「一次性 + paused」启动时告警并按未暂停处理（否则永久卡在队列里）', async () => {
    await withScheduler(
      async (app, _upsert, warns) => {
        const job = (app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? []).find(
          j => j.name === 'stale',
        );
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
      async app => {
        const job = (app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? []).find(
          j => j.name === 'stale-cron',
        );
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
      async app => {
        // 过期分支走 setImmediate，让出两轮宏任务等它跑完
        await new Promise(r => setImmediate(r));
        await new Promise(r => setImmediate(r));
        const job = (app.ctx.getService<{ getJobs(): JobView[] }>('scheduler')?.getJobs() ?? []).find(
          j => j.name === 'due-paused',
        );
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
    await withScheduler(async (_app, upsert) => {
      const res = await upsert({ ...base });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/必须填写其中之一/);
    });
  });

  it('scheduler 服务未就绪时，三个开关 action 如实报「未就绪」而非「任务不存在」', async () => {
    // 服务没起来时 svc?.xxx 求值为 undefined，会被落到「任务不存在」分支——
    // 那是把环境故障说成用户输入错误，与 upsertJob 同形才对
    const ctx = { getService: () => undefined };
    const actions = (
      schedulerModule as unknown as {
        actions: Record<string, (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>>;
      }
    ).actions;
    for (const method of ['pauseJob', 'resumeJob', 'removeJob']) {
      expect(await actions[method](ctx, { name: 'j' }), `${method} 把「服务未就绪」说成了别的`).toEqual({
        ok: false,
        error: 'scheduler 服务未就绪',
      });
    }
  });
});
