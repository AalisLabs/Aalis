import { storage } from '@aalis/api-storage';
import { tools } from '@aalis/api-tools';
import { webuiServer } from '@aalis/api-webui';
import { App, type BoundOf, events, LogHub, provide, services } from '@aalis/core';
import type { LogEntry } from '@aalis/schema-log';
import { describe, expect, it, vi } from 'vitest';
import { type CronEngine, cronEngine } from '../../packages/api-cron-engine/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin, { type SchedulerService, scheduler } from '../../packages/plugin-scheduler/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { resolveText, toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { memoryStorage } from '../fixtures/memory-storage.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';
import { toolRequest } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// 计划任务页：新建与编辑是带输入的动作（编辑是行动作，按这一行预填），暂停与恢复按行状态显示。
// 新建的调度方式与 scheduler_create_job 工具路径同一套判据：
//   • 只填「X 秒后执行一次」→ 换算成 runAt = now + N 秒；
//   • 勾「暂停」→ 任务落地即 paused；一次性任务不能暂停；四种调度方式恰好填一个。
// 「立即执行」找不到任务回错误（以前裸布尔值 false 也被当成功）。任务增删、执行与启停都推 invalidate。
// 真插件 + webui-server 的真实登记表，动作经闸门调用。
// ════════════════════════════════════════════════════════════

/** 调度表里的一行（scheduler 服务自己的投影类型） */
type JobView = ReturnType<SchedulerService['getJobs']>[number];
const uses = { provide, services, events };

interface Harness {
  app: App;
  host: BoundOf<typeof uses>;
  pages: PageHost;
  /** 新建任务（经闸门，输入按声明的字段校验） */
  create(input: Record<string, unknown>): ReturnType<PageHost['act']>;
  /** 调 scheduler_create_job（确认放行），回解析后的回执 */
  createByTool(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  jobs(): JobView[];
  svc(): SchedulerService | undefined;
  /** 内存 storage 里的文件：看落盘结果 */
  files: Map<string, string>;
  warns: string[];
}

async function withScheduler(
  fn: (h: Harness) => Promise<void>,
  options: {
    /** 预置到持久化文件里的「存量」内容（JSON 序列化后写入；不是数组即读不懂的坏文件） */
    persisted?: unknown;
    /** 配置文件里的静态任务 */
    jobs?: unknown[];
    persistPath?: string;
    /** 换掉真的 cron-engine（第三方提供者） */
    cronEngine?: CronEngine;
  } = {},
) {
  const hub = new LogHub();
  const warns: string[] = [];
  const off = hub.onEntry((e: LogEntry) => {
    if (e.level === 'warn') warns.push(e.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  const host = app.bind(uses);
  const store = memoryStorage();
  if (options.persisted) store.files.set('data:/scheduler-jobs.json', JSON.stringify(options.persisted));
  host.provide.use(storage, store.service as never);
  const pages = pageHost();
  host.provide.use(webuiServer, pages.service);
  await app.plugins.register(toolsPlugin, {});
  if (options.cronEngine) host.provide.use(cronEngine, options.cronEngine);
  else await app.plugins.register(cronEnginePlugin, {});
  await app.plugins.register(schedulerPlugin, {
    jobs: options.jobs ?? [],
    ...(options.persistPath ? { persistPath: options.persistPath } : {}),
  });
  await app.plugins.idle();

  const svc = () => host.services.use.get(scheduler);
  try {
    await fn({
      app,
      host,
      pages,
      create: input => pages.act('scheduler', 'createJob', { input }),
      async createByTool(args) {
        const toolSvc = host.services.use.get(tools);
        if (!toolSvc) throw new Error('tools 服务未注册');
        toolSvc.setExecutionGuard(async () => ({ ok: true }));
        const res = await toolSvc.execute(
          'scheduler_create_job',
          args,
          toolRequest({
            sessionId: 'internal',
            platform: 'internal',
          }),
        );
        return JSON.parse(res.content) as Record<string, unknown>;
      },
      jobs: () => svc()?.getJobs() ?? [],
      svc,
      files: store.files,
      warns,
    });
  } finally {
    await app.stop().catch(() => {});
    pages.dispose();
    off();
  }
}

const base = { name: 'j', sessionId: 'internal', platform: 'internal', content: 'x', enabled: true };
const saved = (name = 'j') => ({
  status: 200,
  body: { message: expect.objectContaining({ source: `已保存任务 ${name}` }) },
});
const refused = (status: number, error: string | RegExp) => ({
  status,
  body: { error: typeof error === 'string' ? error : expect.stringMatching(error) },
});

describe('计划任务页的登记', () => {
  it('过登记门槛；表格每行带显示列、预填编辑用的原值与按行状态显示动作的布尔字段', async () => {
    await withScheduler(async ({ pages, create }) => {
      expect(pages.logs).toEqual([]);
      expect(toSource(pages.view('scheduler'))).toMatchObject({
        title: '计划任务',
        placement: 'plugin',
        icon: 'clock',
      });
      expect(await create({ ...base, interval: 60 })).toEqual(saved());
      const [row] = await pages.data<Array<Record<string, unknown>>>('scheduler', 'jobs');
      expect(toSource(row)).toMatchObject({
        name: 'j',
        schedule: '每 60 秒',
        status: { text: '就绪' },
        interval: 60,
        sessionId: 'internal',
        platform: 'internal',
        content: 'x',
        enabled: true,
        paused: false,
        pausable: true,
        editable: true,
        runCount: 0,
      });
      expect(typeof row.nextRun).toBe('number');
    });
  });

  it('暂停、禁用与配置文件里的任务：状态弱化，暂停只对就绪的周期任务出现，配置文件里的任务不能编辑', async () => {
    await withScheduler(
      async ({ pages, create }) => {
        await create({ ...base, interval: 60, paused: true });
        await create({ ...base, name: 'once', runAt: new Date(Date.now() + 3_600_000).toISOString() });
        const rows = await pages.data<Array<Record<string, unknown>>>('scheduler', 'jobs');
        const byName = new Map(rows.map(row => [row.name, row]));
        expect(toSource(byName.get('j'))).toMatchObject({
          status: { text: '暂停', state: 'inactive' },
          paused: true,
          pausable: false,
        });
        expect(byName.get('once'), '一次性任务不能暂停').toMatchObject({ pausable: false, editable: true });
        expect(byName.get('static'), '配置文件里的任务只能在配置里改').toMatchObject({ editable: false });
      },
      {
        jobs: [{ name: 'static', interval: 60, sessionId: 'internal', platform: 'internal', content: 'x' }],
      },
    );
  });

  it('停用后页面撤回', async () => {
    await withScheduler(async ({ app, pages }) => {
      expect(pages.pages().map(page => page.key)).toEqual(['scheduler']);
      await app.plugins.unload(schedulerPlugin.name);
      expect(pages.pages()).toEqual([]);
    });
  });
});

describe('新建', () => {
  it('只填 delaySeconds 即为合法调度方式，换算成 runAt = now + N 秒', async () => {
    await withScheduler(async ({ create, jobs }) => {
      const before = Date.now();
      expect(await create({ ...base, delaySeconds: 600 })).toEqual(saved());
      const at = Date.parse(jobs().find(j => j.name === 'j')?.runAt as string);
      expect(at).toBeGreaterThanOrEqual(before + 600_000);
      expect(at).toBeLessThanOrEqual(Date.now() + 600_000);
    });
  });

  it('勾「暂停」→ 任务落地即 paused；不勾照常就绪', async () => {
    await withScheduler(async ({ create, jobs }) => {
      expect(await create({ ...base, interval: 60, paused: true })).toEqual(saved());
      expect(await create({ ...base, name: 'k', interval: 60 })).toEqual(saved('k'));
      expect(jobs().find(j => j.name === 'j')).toMatchObject({ enabled: true, paused: true });
      expect(jobs().find(j => j.name === 'k')?.paused).toBe(false);
    });
  });

  it('调度方式恰好填一个：同时填两个或一个都不填都报错，不落地任务', async () => {
    await withScheduler(async ({ create, jobs }) => {
      expect(
        toSource(await create({ ...base, runAt: new Date(Date.now() + 3_600_000).toISOString(), delaySeconds: 600 })),
      ).toEqual(refused(500, /互斥/));
      expect(toSource(await create({ ...base, cron: '@daily', interval: 60 }))).toEqual(refused(500, /互斥/));
      expect(toSource(await create(base))).toEqual(refused(500, /必须填写其中之一/));
      expect(jobs()).toHaveLength(0);
    });
  });

  it('暂停 + delaySeconds → 报错（一次性任务被暂停会永久卡住，无可用语义）', async () => {
    await withScheduler(async ({ create, jobs }) => {
      expect(toSource(await create({ ...base, delaySeconds: 600, paused: true }))).toEqual(
        refused(500, /没有可用语义/),
      );
      expect(jobs()).toHaveLength(0);
    });
  });

  it('cron 无效：页上新建与 scheduler_create_job 都当场拒收，任务不入表、不落盘；页上的报错按读者语言', async () => {
    await withScheduler(async ({ create, createByTool, jobs, files, pages }) => {
      const reply = await create({ ...base, cron: 'every five minutes' });
      expect(reply.status).toBe(500);
      const { error } = reply.body as { error: never };
      expect(resolveText(error, ['en'])).toBe(
        'Invalid cron expression (needs 5 fields or an alias): every five minutes',
      );
      expect(resolveText(error, ['zh-CN'])).toBe('非法 cron 表达式（需 5 字段或别名）：every five minutes');
      expect(await createByTool({ name: 'k', cron: '61 * * * *', content: 'x' })).toEqual({
        error: 'cron 第 1 字段非法（解析为空）："61"',
      });
      expect(jobs()).toEqual([]);
      expect(files.has('data:/scheduler-jobs.json')).toBe(false);
      expect(pages.notices(), '拒收的输入不该再发「没有排上」').toEqual([]);
    });
  });

  it('cron 无效：第三方 cron 引擎交的原因是字符串时，页上新建与 scheduler_create_job 照样报出原因', async () => {
    const thirdParty: CronEngine = {
      subscribe: () => () => {},
      validate: () => ({ ok: false, text: '第三方引擎不认这个表达式' }),
      nextFireTime: () => null,
    };
    await withScheduler(
      async ({ create, createByTool, jobs }) => {
        expect(toSource(await create({ ...base, cron: 'zz' }))).toEqual(refused(500, '第三方引擎不认这个表达式'));
        expect(await createByTool({ name: 'k', cron: 'zz', content: 'x' })).toEqual({
          error: '第三方引擎不认这个表达式',
        });
        expect(jobs()).toEqual([]);
      },
      { cronEngine: thirdParty },
    );
  });

  it('cron 无效：别的插件经 scheduler 服务 addJob、setJob 同样当场拒收', async () => {
    await withScheduler(async ({ svc, jobs, files, pages }) => {
      const service = svc();
      if (!service) throw new Error('scheduler 服务未提供');
      const job = { ...base, cron: 'every five minutes' };
      const reason = '非法 cron 表达式（需 5 字段或别名）：every five minutes';
      expect(() => service.addJob(job)).toThrow(reason);
      expect(() => service.setJob(job)).toThrow(reason);
      expect(jobs()).toEqual([]);
      expect(files.has('data:/scheduler-jobs.json')).toBe(false);
      expect(pages.notices(), '拒收的输入不该再发「没有排上」').toEqual([]);
    });
  });

  it('同名任务已存在：新建被拒，改它要用「编辑」', async () => {
    await withScheduler(async ({ create, jobs }) => {
      await create({ ...base, interval: 60 });
      expect(toSource(await create({ ...base, interval: 120 }))).toEqual(
        refused(500, '已有同名任务 j，改它用「编辑」'),
      );
      expect(jobs().find(j => j.name === 'j')?.interval).toBe(60);
    });
  });

  it('持久化文件读不懂而拒写：保存回执注明仅本次运行生效（文字对象，按读者语言），与 scheduler_create_job 同一附注', async () => {
    await withScheduler(
      async ({ create, createByTool, jobs }) => {
        const note = '仅本次运行生效，未写入 data:/scheduler-jobs.json：它读不出来，处理办法见「需要处理」里的提示';
        const reply = await create({ ...base, interval: 60 });
        expect(reply.status).toBe(200);
        const { message } = reply.body as { message: never };
        expect(toSource(message)).toBe(`已保存任务 j；${note}`);
        expect(resolveText(message, ['en'])).toBe(
          'Saved task j; only effective for this run, not written to data:/scheduler-jobs.json: ' +
            'it could not be read; see Needs attention for how to fix it',
        );
        expect(await createByTool({ name: 'k', interval: 60, content: 'x' })).toEqual({
          ok: true,
          message: `任务 "k" 已创建 (每 60s 重复)，目标会话: internal (internal)；${note}`,
        });
        expect(
          jobs().find(j => j.name === 'j'),
          '拒写不拒收：任务照常在内存里生效',
        ).toBeTruthy();
      },
      { persisted: {} },
    );
  });
});

describe('编辑', () => {
  it('按行改：任务名取这一行，改调度与内容', async () => {
    await withScheduler(async ({ pages, create, jobs }) => {
      await create({ ...base, interval: 60 });
      expect(
        await pages.act('scheduler', 'editJob', {
          rowKey: 'j',
          input: { cron: '@daily', sessionId: 'internal', platform: 'internal', content: 'y' },
        }),
      ).toEqual(saved());
      expect(jobs()).toMatchObject([{ name: 'j', cron: '@daily', content: 'y' }]);
      expect(jobs()[0].interval).toBeUndefined();
    });
  });

  it('改成无效的 cron：拒收，任务保持原样', async () => {
    await withScheduler(async ({ pages, create, jobs }) => {
      await create({ ...base, cron: '@daily' });
      expect(
        toSource(
          await pages.act('scheduler', 'editJob', {
            rowKey: 'j',
            input: { cron: '@every soon', sessionId: 'internal', platform: 'internal', content: 'y' },
          }),
        ),
      ).toEqual(refused(500, '无法识别的 @every 表达式：@every soon'));
      expect(jobs()).toMatchObject([{ name: 'j', cron: '@daily', content: 'x' }]);
    });
  });

  it('任务已不在（一次性任务到点执行完自删、或刚被删掉）：回错误，不借编辑把它重建出来', async () => {
    await withScheduler(async ({ pages, jobs }) => {
      expect(
        toSource(
          await pages.act('scheduler', 'editJob', {
            rowKey: 'ghost',
            input: { interval: 60, sessionId: 'internal', platform: 'internal', content: 'y' },
          }),
        ),
      ).toEqual(refused(500, '任务 ghost 不存在'));
      expect(jobs()).toEqual([]);
    });
  });

  it('配置文件里的任务改不了：回错误，任务不变', async () => {
    await withScheduler(
      async ({ pages, jobs }) => {
        const reply = await pages.act('scheduler', 'editJob', {
          rowKey: 'static',
          input: { interval: 120, sessionId: 'internal', content: 'y' },
        });
        expect(reply.status).toBe(500);
        expect(toSource((reply.body as { error: string }).error)).toContain('来自配置文件');
        expect(jobs().find(j => j.name === 'static')?.interval).toBe(60);
      },
      {
        jobs: [{ name: 'static', interval: 60, sessionId: 'internal', platform: 'internal', content: 'x' }],
      },
    );
  });
});

describe('行上的动作', () => {
  it('立即执行：找不到任务回错误，不当成功；找得到就执行一次，开始与结束各推一次 invalidate', async () => {
    await withScheduler(async ({ pages, create, jobs }) => {
      expect(toSource(await pages.act('scheduler', 'triggerJob', { rowKey: 'none' }))).toEqual(
        refused(500, '任务 none 不存在'),
      );
      await create({ ...base, interval: 3600 });
      const before = pages.invalidations.length;
      expect(toSource(await pages.act('scheduler', 'triggerJob', { rowKey: 'j' }))).toEqual({
        status: 200,
        body: { message: '已执行 j' },
      });
      expect(jobs().find(j => j.name === 'j')?.runCount).toBe(1);
      const page = { instance: '@aalis/plugin-scheduler', pageKey: 'scheduler' };
      expect(pages.invalidations.slice(before), '执行中与执行完都要让表格重取').toEqual([page, page]);
    });
  });

  it('立即执行：这一轮还没执行完时回错误，不说已执行；那一轮照常完成', async () => {
    await withScheduler(async ({ host, pages, create, jobs }) => {
      let release!: () => void;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      host.events.use.on('scheduler:job:start', () => held);
      await create({ ...base, interval: 3600 });
      const first = pages.act('scheduler', 'triggerJob', { rowKey: 'j' });
      await vi.waitFor(() => expect(jobs().find(j => j.name === 'j')?.running).toBe(true));
      expect(toSource(await pages.act('scheduler', 'triggerJob', { rowKey: 'j' }))).toEqual(
        refused(500, '任务 j 正在执行，这次没有再触发'),
      );
      release();
      expect(toSource(await first)).toEqual({ status: 200, body: { message: '已执行 j' } });
      expect(jobs().find(j => j.name === 'j')?.runCount).toBe(1);
    });
  });

  it('暂停与恢复：一次性任务不能暂停，回错误；周期任务照常', async () => {
    await withScheduler(async ({ pages, create, jobs }) => {
      await create({ ...base, name: 'once', runAt: new Date(Date.now() + 3_600_000).toISOString() });
      expect(toSource(await pages.act('scheduler', 'pauseJob', { rowKey: 'once' }))).toEqual(
        refused(500, '任务不存在，或是一次性任务（不能暂停，只能删除重建）'),
      );
      expect(jobs().find(j => j.name === 'once')?.paused).toBe(false);
      await create({ ...base, interval: 60 });
      expect(toSource(await pages.act('scheduler', 'pauseJob', { rowKey: 'j' }))).toEqual({
        status: 200,
        body: { message: '已暂停 j' },
      });
      expect(jobs().find(j => j.name === 'j')?.paused).toBe(true);
      expect(toSource(await pages.act('scheduler', 'resumeJob', { rowKey: 'j' }))).toEqual({
        status: 200,
        body: { message: '已恢复 j' },
      });
      expect(jobs().find(j => j.name === 'j')?.paused).toBe(false);
    });
  });

  it('删除：任务撤出调度表并推 invalidate；不存在的回错误', async () => {
    await withScheduler(async ({ pages, create, jobs }) => {
      await create({ ...base, interval: 60 });
      const before = pages.invalidations.length;
      expect(toSource(await pages.act('scheduler', 'removeJob', { rowKey: 'j' }))).toEqual({
        status: 200,
        body: { message: '已删除 j' },
      });
      expect(jobs()).toEqual([]);
      expect(pages.invalidations.length).toBeGreaterThan(before);
      expect(toSource(await pages.act('scheduler', 'removeJob', { rowKey: 'j' }))).toEqual(
        refused(500, '任务 j 不存在'),
      );
    });
  });
});

describe('激活中的页面', () => {
  it('持久化文件读完之前页面不登记；读完后表格同时有配置文件与持久化文件里的任务', async () => {
    const app = new App({ name: 'T', logLevel: 'warn' });
    const host = app.bind(uses);
    const store = memoryStorage({
      'data:/scheduler-jobs.json': JSON.stringify([
        {
          name: 'saved',
          interval: 60,
          sessionId: 'internal',
          platform: 'internal',
          actorPlatform: 'webui',
          actorUserId: 'console',
          content: 'x',
        },
      ]),
    });
    let reading!: () => void;
    const started = new Promise<void>(resolve => {
      reading = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    host.provide.use(storage, {
      ...store.service,
      async readFile(uri: string) {
        reading();
        await held;
        return store.service.readFile(uri);
      },
    } as never);
    const pages = pageHost();
    host.provide.use(webuiServer, pages.service);
    try {
      await app.plugins.register(toolsPlugin, {});
      await app.plugins.register(cronEnginePlugin, {});
      await app.plugins.register(schedulerPlugin, {
        jobs: [{ name: 'static', interval: 60, sessionId: 'internal', platform: 'internal', content: 'x' }],
      });
      await started;
      expect(pages.pages(), '页面在它用到的调度表就绪前登记，取数与动作会撞上未初始化的服务').toEqual([]);
      release();
      await app.plugins.idle();
      const rows = await pages.data<Array<{ name: string }>>('scheduler', 'jobs');
      expect(rows.map(row => row.name).sort()).toEqual(['saved', 'static']);
    } finally {
      release();
      await app.stop().catch(() => {});
      pages.dispose();
    }
  });
});

describe('存量持久化任务', () => {
  it('「一次性 + paused」启动时告警并按未暂停处理（否则永久卡在队列里）', async () => {
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
      {
        persisted: [
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
      },
    );
  });

  it('周期任务的 paused 照常保留（反向锚，避免上一条恒假）', async () => {
    await withScheduler(
      async ({ jobs }) => {
        expect(jobs().find(j => j.name === 'stale-cron')?.paused, '周期任务的暂停是有效语义，不该被清掉').toBe(true);
      },
      {
        persisted: [
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
      },
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
      {
        persisted: [
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
      },
    );
  });
});

// 用户看不见的故障发提示（「需要处理」）：持久化任务文件读不出来时里面的任务全没加载、新改动也不落盘；
// cron 订阅不上的任务永远不会运行（页上与工具新建时已当场拒收，这里只剩配置文件与存量文件里的任务）。
// 任务重排成功或删掉时撤回它的提示
describe('读不出来与没排上的提示', () => {
  const instance = '@aalis/plugin-scheduler';
  const stored = (name: string, cron: string) => ({
    name,
    cron,
    enabled: true,
    sessionId: 'internal',
    platform: 'internal',
    actorPlatform: 'webui',
    actorUserId: 'console',
    content: 'x',
  });

  it('持久化任务文件内容不对：发 error 提示，写明修好文件与原因', async () => {
    await withScheduler(
      async ({ pages }) => {
        expect(toSource(pages.notices())).toEqual([
          {
            instance,
            id: 'jobs-load',
            level: 'error',
            title: '计划任务文件 data:/scheduler-jobs.json 读不出来，里面的任务没有加载',
            detail:
              '修好这个文件后重载本插件：内容要是任务数组；不要里面的任务就把它移走再重载。' +
              '修好之前新建与改动的任务只在本次运行生效。原因：持久化任务文件不是数组（得到 object）',
          },
        ]);
      },
      { persisted: { jobs: [] } },
    );
  });

  it('持久化任务文件读不到（根名写错、存储插件不在）：提示写去查 persistPath 与存储插件，不让修文件', async () => {
    await withScheduler(
      async ({ pages }) => {
        expect(toSource(pages.notices())).toEqual([
          {
            instance,
            id: 'jobs-load',
            level: 'error',
            title: '计划任务文件 dat:/scheduler-jobs.json 读不出来，里面的任务没有加载',
            detail:
              '确认本地存储插件在运行、配置项 persistPath 的根名写对、这个文件能读取，然后重载本插件。' +
              '修好之前新建与改动的任务只在本次运行生效。原因：未知存储根: dat（已注册根: data）',
          },
        ]);
      },
      { persistPath: 'dat:/scheduler-jobs.json' },
    );
  });

  it('存量文件里的任务 cron 无效：发提示去计划任务页改；改对后撤回，删掉也撤回', async () => {
    await withScheduler(
      async ({ pages }) => {
        expect(toSource(pages.notices())).toEqual([
          {
            instance,
            id: 'unscheduled:bad',
            level: 'error',
            title: '计划任务「bad」没有排上，不会运行',
            detail: expect.stringMatching(/^在计划任务页编辑这个任务，改正它的 cron 后保存。原因：\S/),
            open: { page: 'scheduler' },
          },
          expect.objectContaining({ id: 'unscheduled:worse' }),
        ]);

        await pages.act('scheduler', 'editJob', {
          rowKey: 'bad',
          input: { cron: '@daily', sessionId: 'internal', platform: 'internal', content: 'x' },
        });
        expect(pages.notices().map(n => n.id)).toEqual(['unscheduled:worse']);
        await pages.act('scheduler', 'removeJob', { rowKey: 'worse' });
        expect(pages.notices()).toEqual([]);
      },
      { persisted: [stored('bad', 'every five minutes'), stored('worse', 'nope')] },
    );
  });

  it('配置文件里的任务 cron 无效：提示去配置里改', async () => {
    await withScheduler(
      async ({ pages }) => {
        expect(toSource(pages.notices())).toEqual([
          {
            instance,
            id: 'unscheduled:static',
            level: 'error',
            title: '计划任务「static」没有排上，不会运行',
            detail: expect.stringMatching(/^在配置文件里改正这个任务的 cron 或 timeZone，保存后生效。原因：\S/),
            open: 'config',
          },
        ]);
      },
      { jobs: [{ name: 'static', cron: 'nope', sessionId: 'internal', platform: 'internal', content: 'x' }] },
    );
  });

  // 时区无效时估算下次执行（nextFireTime）同步抛错：曾从激活里冒出去，整个插件起不来、提示也发不出
  it('配置文件里的任务 timeZone 无效：插件照常激活、发提示，停用的同类任务可恢复，其余任务照常', async () => {
    const job = {
      cron: '0 9 * * *',
      timeZone: 'Mars/Olympus',
      sessionId: 'internal',
      platform: 'internal',
      content: 'x',
    };
    await withScheduler(
      async ({ app, pages, jobs }) => {
        expect(app.plugins.getStatus().find(p => p.name === instance)?.state).toBe('active');
        expect(toSource(pages.notices())).toEqual([
          {
            instance,
            id: 'unscheduled:tz',
            level: 'error',
            title: '计划任务「tz」没有排上，不会运行',
            detail: '在配置文件里改正这个任务的 cron 或 timeZone，保存后生效。原因：非法时区：Mars/Olympus',
            open: 'config',
          },
        ]);
        expect(jobs().map(j => j.name)).toEqual(['tz', 'tz-off', 'every']);
        expect(toSource(await pages.act('scheduler', 'resumeJob', { rowKey: 'tz-off' }))).toEqual({
          status: 200,
          body: { message: '已恢复 tz-off' },
        });
      },
      {
        jobs: [
          { ...job, name: 'tz' },
          { ...job, name: 'tz-off', enabled: false },
          { name: 'every', interval: 60, sessionId: 'internal', platform: 'internal', content: 'x' },
        ],
      },
    );
  });
});

// 固定间隔交给 setInterval：延时超过 2^31-1 毫秒（约 24.8 天）时 Node 按 1 毫秒处理，「每 30 天」的任务每毫秒触发一次、
// 每次在目标会话里排一轮；不到 5 秒的（如 0.001）同样占满调度，所有入口与上限同一处拒收。假时钟同样按 1 毫秒处理，只假
// setInterval（间隔通道都是它），推进 50 毫秒数开始执行的次数
describe('固定间隔的上下限', () => {
  const MONTH = 30 * 24 * 3600;
  const reason = (value: string) => `间隔须大于 0 且不超过 2,147,483 秒（约 24.8 天）：${value}`;

  /** 假 setInterval 下跑一组用例，回调拿到的 started 记下每次开始执行的任务名 */
  async function withFakeIntervals(
    fn: (h: Harness, started: string[]) => Promise<void>,
    options?: Parameters<typeof withScheduler>[1],
  ) {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await withScheduler(async h => {
        const started: string[] = [];
        h.host.events.use.on('scheduler:job:start', name => {
          started.push(name);
        });
        await fn(h, started);
      }, options);
    } finally {
      vi.useRealTimers();
    }
  }

  it('经服务新建与修改、计划任务页与 scheduler_create_job：不是大于 0 的数或超过上限（含 @every）当场拒收，不入表、不落盘；上限本身照收', async () => {
    await withFakeIntervals(async ({ svc, create, createByTool, jobs, files, pages }, started) => {
      const service = svc();
      if (!service) throw new Error('scheduler 服务未提供');
      const job = { ...base, interval: MONTH };
      expect(() => service.addJob(job)).toThrow(reason('2592000'));
      expect(() => service.setJob(job)).toThrow(reason('2592000'));
      expect(() => service.addJob({ ...base, cron: '@every 720h' })).toThrow(reason('@every 720h'));
      for (const interval of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => service.addJob({ ...base, interval }), String(interval)).toThrow(reason(String(interval)));
      }
      expect(toSource(await create({ ...base, interval: MONTH }))).toEqual(refused(500, reason('2592000')));
      expect(await createByTool({ name: 'k', interval: MONTH, content: 'x' })).toEqual({ error: reason('2592000') });
      expect(await createByTool({ name: 'k', cron: '@every 720h', content: 'x' })).toEqual({
        error: reason('@every 720h'),
      });
      expect(jobs()).toEqual([]);
      expect(files.has('data:/scheduler-jobs.json')).toBe(false);
      expect(pages.notices(), '拒收的输入不该再发「没有排上」').toEqual([]);

      service.addJob({ ...base, name: 'max', interval: 2147483 });
      await vi.advanceTimersByTimeAsync(50);
      expect(started, '溢出的话 50 毫秒里会执行 50 次').toEqual([]);
      expect(jobs().map(j => j.name)).toEqual(['max']);
    });
  });

  it('不到 5 秒的间隔（含 @every）：经服务新建与修改、计划任务页与 scheduler_create_job 一律拒收，配置文件与存量文件里的不排、发提示；5 秒照收', async () => {
    const tooShort = '固定间隔不能小于 5 秒（防高频任务耗尽资源）';
    const task = { sessionId: 'internal', platform: 'internal', content: 'x' };
    await withFakeIntervals(
      async ({ svc, create, createByTool, jobs, files, pages }, started) => {
        const service = svc();
        if (!service) throw new Error('scheduler 服务未提供');
        expect(() => service.addJob({ ...base, interval: 0.001 })).toThrow(tooShort);
        expect(() => service.setJob({ ...base, interval: 4.9 })).toThrow(tooShort);
        expect(() => service.addJob({ ...base, cron: '@every 1s' })).toThrow(tooShort);
        expect(toSource(await create({ ...base, interval: 1 }))).toEqual(refused(500, tooShort));
        expect(await createByTool({ name: 'tiny', interval: 0.001, content: 'x' })).toEqual({ error: tooShort });
        expect(await createByTool({ name: 'tiny', cron: '@every 4s', content: 'x' })).toEqual({ error: tooShort });
        expect(JSON.parse(files.get('data:/scheduler-jobs.json') ?? '[]').map((j: { name: string }) => j.name)).toEqual(
          ['stored'],
        );
        expect(toSource(pages.notices()).map(n => [n.id, n.detail])).toEqual([
          ['unscheduled:static', `在配置文件里改正这个任务的 cron 或 timeZone，保存后生效。原因：${tooShort}`],
          ['unscheduled:static-every', `在配置文件里改正这个任务的 cron 或 timeZone，保存后生效。原因：${tooShort}`],
          ['unscheduled:stored', `在计划任务页编辑这个任务，改正它的 cron 后保存。原因：${tooShort}`],
        ]);
        expect(jobs().map(j => [j.name, j.nextRun])).toEqual([
          ['static', 0],
          ['static-every', 0],
          ['stored', 0],
        ]);
        await vi.advanceTimersByTimeAsync(50);
        expect(started, '每毫秒触发的话 50 毫秒里会执行 50 次').toEqual([]);

        service.addJob({ ...base, name: 'five', interval: 5 });
        expect(jobs().map(j => j.name)).toContain('five');
      },
      {
        jobs: [
          { ...task, name: 'static', interval: 0.001 },
          { ...task, name: 'static-every', cron: '@every 1s' },
        ],
        persisted: [
          { ...task, name: 'stored', interval: 1, enabled: true, actorPlatform: 'webui', actorUserId: 'console' },
        ],
      },
    );
  });

  it('配置文件与存量文件里超过上限的间隔（含 @every）：插件照常激活，任务列着但不排、发「没有排上」提示，下次执行不显示', async () => {
    const task = { sessionId: 'internal', platform: 'internal', content: 'x' };
    await withFakeIntervals(
      async ({ app, pages, jobs }, started) => {
        expect(app.plugins.getStatus().find(p => p.name === '@aalis/plugin-scheduler')?.state).toBe('active');
        expect(toSource(pages.notices())).toEqual([
          {
            instance: '@aalis/plugin-scheduler',
            id: 'unscheduled:static',
            level: 'error',
            title: '计划任务「static」没有排上，不会运行',
            detail: `在配置文件里改正这个任务的 cron 或 timeZone，保存后生效。原因：${reason('2592000')}`,
            open: 'config',
          },
          expect.objectContaining({ id: 'unscheduled:static-every' }),
          {
            instance: '@aalis/plugin-scheduler',
            id: 'unscheduled:stored',
            level: 'error',
            title: '计划任务「stored」没有排上，不会运行',
            detail: `在计划任务页编辑这个任务，改正它的 cron 后保存。原因：${reason('2592000')}`,
            open: { page: 'scheduler' },
          },
        ]);
        expect(jobs().map(j => [j.name, j.nextRun])).toEqual([
          ['static', 0],
          ['static-every', 0],
          ['stored', 0],
        ]);
        await vi.advanceTimersByTimeAsync(50);
        expect(started).toEqual([]);
      },
      {
        jobs: [
          { ...task, name: 'static', interval: MONTH },
          { ...task, name: 'static-every', cron: '@every 720h' },
        ],
        persisted: [
          { ...task, name: 'stored', interval: MONTH, enabled: true, actorPlatform: 'webui', actorUserId: 'console' },
        ],
      },
    );
  });
});

describe('计划任务给人看的出口按读者的语言', () => {
  /** cron-engine 拒收时区的配置任务，与一个能立即执行的固定间隔任务 */
  const jobs = [
    {
      name: 'tz',
      cron: '0 9 * * *',
      timeZone: 'Mars/Olympus',
      sessionId: 'internal',
      platform: 'internal',
      content: 'x',
    },
    { name: 'every', interval: 60, sessionId: 'internal', platform: 'internal', content: 'x' },
  ];
  const CASES = {
    en: [
      'Scheduled task "tz" could not be scheduled and will not run',
      "Fix this task's cron or timeZone in the configuration file; it takes effect once saved. Reason: Invalid time zone: Mars/Olympus",
      'Ran every',
      'Succeeded',
      'One of cron, fixed interval, one-time run at and run once after X seconds must be filled in',
    ],
    'zh-CN': [
      '计划任务「tz」没有排上，不会运行',
      '在配置文件里改正这个任务的 cron 或 timeZone，保存后生效。原因：非法时区：Mars/Olympus',
      '已执行 every',
      '成功',
      'cron、固定间隔、一次性运行时间、X 秒后执行必须填写其中之一',
    ],
  };

  it.each(
    Object.entries(CASES),
  )('%s：任务排不上的提示，立即执行的回执与「最近结果」，保存缺调度方式的报错', async (language, expected) => {
    await withScheduler(
      async ({ pages, create }) => {
        const [notice] = pages.notices();
        const ran = await pages.act('scheduler', 'triggerJob', { rowKey: 'every' });
        const rows = await pages.data<Array<{ name: string; lastResult: string }>>('scheduler', 'jobs');
        const missing = await create({ name: 'zz-none', sessionId: 'internal', content: 'x' });
        expect([
          renderIn(notice.title, language),
          renderIn(notice.detail, language),
          renderIn((ran.body as { message: string }).message, language),
          renderIn(rows.find(row => row.name === 'every')?.lastResult, language),
          renderIn((missing.body as { error: string }).error, language),
        ]).toEqual(expected);
      },
      { jobs },
    );
  });
});
