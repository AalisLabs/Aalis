import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { type App, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin, { type SchedulerService, scheduler } from '../../packages/plugin-scheduler/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 存下来以后自己生效的操作（定时任务的建、删、停、启，编排的定义）与别的要确认的操作同一规则：confirm 'session'。
// 参与者都是 owner 的回合里，这一项在免确认白名单（restrictedPolicy）里就免；不在白名单、又没有审批服务时照旧拒绝。
// 真工具注册表、权限插件、定时任务与编排插件；不装审批服务，要审批的调用一律被拒、不生效。
// ════════════════════════════════════════════════════════════

const OWNER = { platform: 'onebot', userId: '99999' };
const SELF_ACTING = [
  'tool:scheduler_create_job',
  'tool:scheduler_pause_job',
  'tool:scheduler_resume_job',
  'tool:scheduler_remove_job',
  'tool:workflow_define',
];
const YAML = `id: zz-wf
trigger:
  type: manual
nodes:
  - id: noop
    type: tool
    tool: scheduler_list_jobs
`;

let base: string;
let apps: App[];

async function boot(allow: string[]) {
  const { app } = hostedApp({ owners: [OWNER], restrictedPolicy: { allow } });
  apps.push(app);
  await registerHubs(app);
  provideHostPaths(app, base);
  await app.plugin(storageLocalPlugin, {
    roots: [
      {
        name: 'workspace',
        path: join(base, 'workspace'),
        label: 'workspace',
        kind: 'workspace',
        browsable: true,
        readable: true,
        writable: true,
        deletable: true,
      },
    ],
  });
  await app.plugin(toolsPlugin, {});
  await app.plugin(cronEnginePlugin, {});
  await app.plugin(authorityPlugin, {});
  await app.plugin(schedulerPlugin, {});
  await app.plugin(workflowPlugin, {});
  await app.plugins.idle();
  const host = app.bind({ tools: toolsService, services });
  const call = (name: string, args: Record<string, unknown>) =>
    host.tools.use.execute(name, args, { sessionId: 'internal', ...OWNER, participants: [OWNER] });
  const jobs = () => (host.services.use.get(scheduler) as SchedulerService).getJobs();
  const defined = () => (host.services.use.get(workflow) as WorkflowService).getWorkflow('zz-wf');
  return { call, jobs, defined };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aalis-self-acting-'));
  mkdirSync(join(base, 'state'), { recursive: true });
  mkdirSync(join(base, 'workspace', 'workflows'), { recursive: true });
  apps = [];
});

afterEach(async () => {
  for (const app of apps) await app.stop();
  rmSync(base, { recursive: true, force: true });
});

describe('存下来以后自己生效的操作与别的要确认的操作同一规则', () => {
  it('参与者都是 owner、这一项在免确认白名单里：不要审批，照常生效', async () => {
    const s = await boot(SELF_ACTING);
    await s.call('scheduler_create_job', { name: 'zz-job', content: '提醒', interval: 3600 });
    expect(s.jobs().map(j => ({ name: j.name, paused: j.paused }))).toEqual([{ name: 'zz-job', paused: false }]);
    await s.call('scheduler_pause_job', { name: 'zz-job' });
    expect(s.jobs()[0].paused).toBe(true);
    await s.call('scheduler_resume_job', { name: 'zz-job' });
    expect(s.jobs()[0].paused).toBe(false);
    await s.call('scheduler_remove_job', { name: 'zz-job' });
    expect(s.jobs()).toEqual([]);
    await s.call('workflow_define', { yaml: YAML });
    expect(s.defined()).toBeDefined();
  });

  it('不在白名单、没有审批服务：照旧要确认，被拒、不生效', async () => {
    const s = await boot([]);
    await s.call('scheduler_create_job', { name: 'zz-job', content: '提醒', interval: 3600 });
    expect(s.jobs()).toEqual([]);
    await s.call('workflow_define', { yaml: YAML });
    expect(s.defined()).toBeUndefined();
  });
});
