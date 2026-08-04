import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import * as cronEngineModule from '../../packages/plugin-cron-engine/src/index.js';
import * as schedulerModule from '../../packages/plugin-scheduler/src/index.js';
import * as toolsModule from '../../packages/plugin-tools/src/index.js';

// ════════════════════════════════════════════════════════════
// scheduler 触发时的代理身份：owner 只能来自显式来源，绝不能由「字段缺失」推断
//
// 守的是一条**提权链**，三段都实测可达过：
//   1. 触发路径把空 actor 补成 `{ platform:'webui', userId:'console' }`
//   2. 而 `webui:console` 是 authority 的 owner 快速通道（isOwner）
//   3. isOwner 直接返回 ∞ 等级
// 于是「创建者匿名」被静默升成 owner。AI 建任务时 actor 取自 `callCtx.userId`，
// 而它在 `ToolCallContext` 契约上是可选的——匿名入站下就是 undefined，必然命中。
// 叠加 `source:'scheduler'` 命中 commands 的 TRUSTED_SYSTEM_SOURCES（附带 skipConfirm），
// 后果是：一次匿名触发产出的任务，此后每次触发都以 owner 身份执行任意指令与工具。
//
// 持久化会把洞重新打开：`saveDynamicJobs` 的 JSON.stringify **直接丢掉 undefined 键**，
// 于是匿名任务在盘上与「升级前的老任务」同形，重启后一并被补成 owner。故三条路径都要钉。
//
// 反向那条同样要钉：静态 YAML 任务缺省**应当**是 owner——能写配置文件的人本就是 owner，
// 把它一起降权是另一种错（会让现有定时任务静默失效）。
// ════════════════════════════════════════════════════════════

type Actor = { platform: string; userId: string } | undefined;

/**
 * 只够 scheduler 读写持久化文件的 storage —— **不是通用 fixture**，别拿去别处用。
 *
 * 必需而非锦上添花：没有它，`loadDynamicJobs` 的 `readFile` 必抛并被内层 catch 吞成 `[]`，
 * 那条分支在整个测试集里一次都不会执行。实测过：把它的 actor 缺省从 undefined 退回
 * `webui/console`（即持久化往返把匿名任务变回 owner 的那条腿），全量 903 个用例零转红。
 */
function memoryStorage(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
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

/** 起一个装了 scheduler 的实例，触发指定任务，返回它发出的 inbound:message 上的 actor。 */
async function actorOfTriggeredJob(
  schedulerConfig: Record<string, unknown>,
  setup?: (svc: SchedulerLike) => void,
  jobName = 'j',
  storageSeed?: Record<string, string>,
): Promise<{ actor: Actor; emitted: boolean }> {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('storage', memoryStorage(storageSeed).service as never);
  await app.ctx.useModule(toolsModule as never, {});
  await app.ctx.useModule(cronEngineModule as never, {});
  await app.ctx.useModule(schedulerModule as never, schedulerConfig);
  await app.plugins.idle();

  let actor: Actor;
  let emitted = false;
  app.ctx.on('inbound:message', (msg: { actor?: { platform: string; userId: string } }) => {
    emitted = true;
    actor = msg.actor;
  });

  const svc = app.ctx.getService<SchedulerLike>('scheduler');
  expect(svc, 'scheduler 服务未注册').toBeDefined();
  setup?.(svc as SchedulerLike);
  await (svc as SchedulerLike).triggerJob(jobName);
  await app.stop();
  return { actor, emitted };
}

interface SchedulerLike {
  addJob(job: Record<string, unknown>): void;
  triggerJob(name: string): Promise<boolean>;
}

const baseJob = { name: 'j', interval: 3600, content: 'x', sessionId: 'internal', platform: 'internal', enabled: true };

describe('scheduler 代理身份不得由缺省推断出 owner', () => {
  it('AI/动态建任务时创建者匿名 → 触发时保持匿名，不得回填 webui:console', async () => {
    // 复现 AI 建任务的形状：actor 取自 callCtx，匿名调用下两个字段都是 undefined。
    const { actor, emitted } = await actorOfTriggeredJob({ jobs: [] }, svc =>
      svc.addJob({ ...baseJob, actorPlatform: undefined, actorUserId: undefined }),
    );
    expect(emitted, '任务未触发，本用例没测到东西').toBe(true);
    expect(
      actor,
      `匿名创建者被回填成 ${JSON.stringify(actor)}；若为 webui:console 即 owner 快速通道，构成提权`,
    ).toBeUndefined();
  });

  it('动态建任务时创建者是具体身份 → 原样透传（权限跟创建者走）', async () => {
    const { actor } = await actorOfTriggeredJob({ jobs: [] }, svc =>
      svc.addJob({ ...baseJob, actorPlatform: 'onebot', actorUserId: '10001' }),
    );
    expect(actor).toEqual({ platform: 'onebot', userId: '10001' });
  });

  it('静态 YAML 任务省略 actor → 仍是 owner（能写配置文件的人本就是 owner）', async () => {
    const { actor } = await actorOfTriggeredJob({
      jobs: [{ name: 'j', interval: 3600, content: 'x' }],
    });
    expect(actor).toEqual({ platform: 'webui', userId: 'console' });
  });

  it('静态 YAML 任务显式写了 actor → 用其值（可降权）', async () => {
    const { actor } = await actorOfTriggeredJob({
      jobs: [{ name: 'j', interval: 3600, content: 'x', actorPlatform: 'onebot', actorUserId: '10001' }],
    });
    expect(actor).toEqual({ platform: 'onebot', userId: '10001' });
  });

  it('持久化里缺 actor 的任务（含匿名任务往返后的形态）→ 载回来仍是匿名，不得补 owner', async () => {
    // 这是第三条腿，且它**独立承重**：`saveDynamicJobs` 的 JSON.stringify 会直接丢掉
    // undefined 键，所以「AI 以匿名身份建的任务」在盘上与「升级前没有 actor 字段的老任务」
    // 完全同形。只堵触发路径不够——重启一次洞就重新打开。
    const persisted = JSON.stringify([
      { name: 'j', interval: 3600, content: 'x', sessionId: 'internal', platform: 'internal', enabled: true },
    ]);
    const { actor, emitted } = await actorOfTriggeredJob({ jobs: [] }, undefined, 'j', {
      'data:/scheduler-jobs.json': persisted,
    });
    expect(emitted, '持久化任务没被载入，本用例没测到东西').toBe(true);
    expect(actor, `创建者未知的持久化任务被补成 ${JSON.stringify(actor)}；未知不等于 owner`).toBeUndefined();
  });
});
