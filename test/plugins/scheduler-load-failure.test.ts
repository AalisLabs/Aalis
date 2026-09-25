import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, services } from '../../packages/core/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin, { type SchedulerService, scheduler } from '../../packages/plugin-scheduler/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// 动态任务整表落盘：激活时那次读若不是「文件不存在」而是别的失败（storage 不在场时网关抛
// 「未知存储根」、文件损坏），曾经一律当成空表，之后第一次增删改把整表写回，原有动态任务全丢。
// 契约：只有文件不存在算全新；其它失败本次运行拒写，原文件一字不动。
// 真 storage-local 多根（workspace 在前、data 在后），任务文件落在 data 根。
// ════════════════════════════════════════════════════════════

const JOBS = 'scheduler-jobs.json';
const job = (name: string) => ({
  name,
  interval: 3600,
  content: 'x',
  sessionId: 'internal',
  platform: 'internal',
  enabled: true,
  actorPlatform: 'onebot',
  actorUserId: '10001',
});
/** 被拒的写不会有任何可等的信号：给一次本地落盘足够的时间再读 */
const settle = () => new Promise(r => setTimeout(r, 150));

describe('scheduler 动态任务：加载失败后拒绝整表回写', () => {
  let base: string;
  let app: App;

  const registerStorage = () =>
    app.plugin(storageLocalPlugin, {
      roots: ['workspace', 'data'].map(name => ({
        name,
        path: join(base, name),
        label: name,
        kind: name,
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      })),
    });
  const registerScheduler = async () => {
    await app.plugin(toolsPlugin, {});
    await app.plugin(cronEnginePlugin, {});
    await app.plugin(schedulerPlugin, { jobs: [] });
    await app.plugins.idle();
  };
  const svcOf = (): SchedulerService => {
    const svc = app.bind({ services }).services.get(scheduler);
    if (!svc) throw new Error('scheduler 服务未注册');
    return svc;
  };
  const jobsFile = join('data', JOBS);
  const readJobs = () => readFileSync(join(base, jobsFile), 'utf-8');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aalis-sched-load-'));
    mkdirSync(join(base, 'data'), { recursive: true });
    mkdirSync(join(base, 'workspace'), { recursive: true });
    app = new App({ name: 'T', logLevel: 'error' });
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('激活时 storage 不在场（未知存储根）：storage 随后上线，addJob 不冲掉原有动态任务', async () => {
    const seeded = JSON.stringify([job('zz-old-1'), job('zz-old-2')], null, 2);
    writeFileSync(join(base, jobsFile), seeded);

    await registerScheduler();
    await registerStorage();
    await app.plugins.idle();
    svcOf().addJob(job('zz-new'));
    await settle();

    expect(readJobs(), '读失败被当成空表，整表回写冲掉了原有任务').toBe(seeded);
  });

  it('任务文件损坏（解析失败）：addJob 不覆盖原文件', async () => {
    const broken = '[{"name":"zz-old-1","interval":3600';
    writeFileSync(join(base, jobsFile), broken);

    await registerStorage();
    await registerScheduler();
    svcOf().addJob(job('zz-new'));
    await settle();

    expect(readJobs()).toBe(broken);
  });

  it.each([
    '{}',
    'null',
    '{"jobs":[{"name":"zz-old-1"}]}',
    '"x"',
  ])('合法 JSON 但不是数组（%s）：addJob 不覆盖原文件', async seeded => {
    writeFileSync(join(base, jobsFile), seeded);

    await registerStorage();
    await registerScheduler();
    svcOf().addJob(job('zz-new'));
    await settle();

    expect(readJobs()).toBe(seeded);
  });

  it('任务文件不存在：按全新照常落盘', async () => {
    await registerStorage();
    await registerScheduler();
    svcOf().addJob(job('zz-new'));

    await expect
      .poll(() => {
        try {
          return (JSON.parse(readJobs()) as Array<{ name: string }>).map(j => j.name);
        } catch {
          return [];
        }
      })
      .toEqual(['zz-new']);
  });

  it('任务文件正常：读回后 addJob 与原有任务一并落盘', async () => {
    writeFileSync(join(base, jobsFile), JSON.stringify([job('zz-old-1')]));

    await registerStorage();
    await registerScheduler();
    svcOf().addJob(job('zz-new'));

    await expect
      .poll(() => (JSON.parse(readJobs()) as Array<{ name: string }>).map(j => j.name).sort())
      .toEqual(['zz-new', 'zz-old-1']);
  });
});
