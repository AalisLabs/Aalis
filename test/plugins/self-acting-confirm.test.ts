import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApprovalRequest, approvals } from '../../packages/api-approval/src/index.js';
import { authority, type UserIdentity } from '../../packages/api-authority/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionSettings } from '../../packages/api-session-settings/src/index.js';
import { backgroundTasks, tools as toolsService } from '../../packages/api-tools/src/index.js';
import { type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { type App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import schedulerPlugin, { type SchedulerService, scheduler } from '../../packages/plugin-scheduler/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import subtaskPlugin from '../../packages/plugin-subtask/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 替 owner 在后台继续做、存下来以后自己生效、或替人去别的会话做事的工具统一「2 级加确认」（risk 'dangerous'）：子任务的建、
// 追问、改设置、删，编排的定义、跑、删，定时任务的建、停、启、删，停后台任务。只看不改的（查与等子任务、列编排、看运行记录、
// 看定时任务）定 2 级、不确认。别人单独发起的拒绝：等级不够，或够了也没人能批；有 owner 在的一轮出卡给 owner 批；参与者都是
// owner 的回合里，这一项在免确认白名单（restrictedPolicy）里就免，不在白名单、又没有审批服务时照旧拒绝。
// 真工具注册表、权限插件、子任务、定时任务与编排插件；会话管理、会话设置与网关用替身，记下子任务插件经它们做的事。缺省不装
// 审批服务，要审批的调用一律被拒、不生效；要出卡的用例另装审批替身：记下请求，一律由 OWNER 批准。
// ════════════════════════════════════════════════════════════

const OWNER = { platform: 'onebot', userId: '99999' };
const MEMBER = { platform: 'onebot', userId: '30001' };
/** 调用所在的会话与它的直接子任务 */
const PARENT = 'onebot:parent';
const CHILD = 'onebot:parent::child';
const WF = 'zz-wf';
const YAML = `id: ${WF}
trigger:
  type: manual
nodes:
  - id: noop
    type: tool
    tool: scheduler_list_jobs
`;
/** 要 2 级加确认的工具与一次合法调用的参数（background_stop 的任务 id 由用例补上） */
const DANGEROUS: Array<[string, Record<string, unknown>]> = [
  ['create_subtask', { task: '<任务>' }],
  ['send_to_subtask', { subtask_id: CHILD, message: '<追问>' }],
  ['set_subtask_setting', { subtask_id: CHILD, key: 'persona', value: '<人设>' }],
  ['delete_subtask', { subtask_id: CHILD }],
  ['scheduler_create_job', { name: 'zz-job', content: '提醒', interval: 3600 }],
  ['scheduler_pause_job', { name: 'zz-job' }],
  ['scheduler_resume_job', { name: 'zz-job' }],
  ['scheduler_remove_job', { name: 'zz-job' }],
  ['workflow_define', { yaml: YAML }],
  ['workflow_run', { id: WF }],
  ['workflow_remove', { id: WF }],
  ['background_stop', {}],
];
/** 只看不改的：2 级、不确认 */
const READ_ONLY: Array<[string, Record<string, unknown>]> = [
  ['check_subtask', { subtask_ids: [CHILD] }],
  ['wait_subtasks', { subtask_ids: ['<不存在>'] }],
  ['workflow_list', {}],
  ['workflow_get_runs', {}],
  ['scheduler_list_jobs', {}],
];
/** owner 的长期授权（免确认白名单）里放上全部要确认的这些 */
const ALL_DANGEROUS = DANGEROUS.map(([name]) => `tool:${name}`);
const NEEDS_APPROVAL = '需要批准';

let base: string;
let apps: App[];

/** 审批替身：把每个审批请求记进 requests，一律由 OWNER 批准 */
const approvalsDouble = (requests: ApprovalRequest[]) =>
  definePlugin({
    name: 'zz-approvals',
    provides: [approvals],
    uses: { provide },
    apply({ provide }) {
      provide.use(approvals, {
        async request(req) {
          requests.push(req);
          return { approvalId: `zz-${requests.length}`, approved: true, by: OWNER };
        },
        list: () => [],
        attachSurface: () => {
          throw new Error('替身不接审批面');
        },
      });
    },
  });

async function boot(allow: string[], opts: { approvals?: ApprovalRequest[] } = {}) {
  const { app } = hostedApp({ owners: [OWNER], restrictedPolicy: { allow } });
  apps.push(app);
  await registerHubs(app);
  provideHostPaths(app, base);
  const host = app.bind({ tools: toolsService, backgroundTasks, services, provide, authority });
  /** 子任务插件经替身做的事，按先后 */
  const did: string[] = [];
  let childAlive = true;
  host.provide.use(sessionManager, {
    getSession: (id: string) => (id === CHILD && childAlive ? { id, parentId: PARENT, status: 'active' } : undefined),
    listSessions: () => [],
    createChildSession: async () => {
      did.push('create');
      return { id: CHILD };
    },
    updateSession: async () => {},
    deleteSession: async (id: string) => {
      did.push(`delete ${id}`);
      childAlive = false;
    },
  } as never);
  host.provide.use(sessionSettings, {
    register: () => () => {},
    chain: () => ({ parts: [] }),
    childMetadata: () => ({}),
    setAs: async (who: UserIdentity, sessionId: string, key: string) => {
      did.push(`set ${sessionId} ${key} as ${who.userId}`);
      return { ok: true, text: 'ok' };
    },
  } as never);
  host.provide.use(gateway, {
    ingressMessage: async (message: { sessionId: string }) => {
      did.push(`ask ${message.sessionId}`);
    },
    dispatchOutbound: async () => {},
  } as never);
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
  if (opts.approvals) await app.plugin(approvalsDouble(opts.approvals), {});
  await app.plugin(authorityPlugin, {});
  await app.plugin(schedulerPlugin, {});
  await app.plugin(workflowPlugin, {});
  await app.plugin(subtaskPlugin, {});
  await app.plugins.idle();
  for (const p of [toolsPlugin, authorityPlugin, schedulerPlugin, workflowPlugin, subtaskPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  // 可转后台的探针：转到后台后一直跑，直到被停
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: 'zz_slow', description: '探针', parameters: { type: 'object', properties: {} } },
    },
    background: {},
    handler: (_args, ctx) =>
      new Promise(resolve => ctx.signal?.addEventListener('abort', () => resolve('stopped'), { once: true })),
  });
  let seq = 0;
  /** 在 PARENT 里调一个工具（参与者缺省即这一个人），结果按 JSON 读；回的是一句话（改子任务设置的回执）时放在 text 里 */
  const call = async (name: string, args: Record<string, unknown>, who: UserIdentity, participants = [who]) => {
    seq++;
    const { content } = await host.tools.use.execute(name, args, {
      sessionId: PARENT,
      ...who,
      participants,
      inbound: {},
      turnId: `zz-turn-${seq}`,
      callId: `zz-call-${seq}`,
    });
    return (content.startsWith('{') ? JSON.parse(content) : { text: content }) as Record<string, unknown>;
  };
  /** 某人在 PARENT 里发起一个后台任务，回任务 id */
  const startTask = async (who: UserIdentity) => {
    const { taskId } = await call('zz_slow', { runInBackground: true }, who);
    expect(taskId).toEqual(expect.any(String));
    return taskId as string;
  };
  const running = (taskId: string) =>
    host.backgroundTasks.use.list().find(task => task.id === taskId)?.status === 'running';
  const jobs = () => (host.services.use.get(scheduler) as SchedulerService).getJobs();
  const wf = () => host.services.use.get(workflow) as WorkflowService;
  const setLevel = (who: UserIdentity, level: number) => host.authority.use.setUserLevel(who, level);
  return { call, startTask, running, jobs, wf, setLevel, did };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/**
 * who 单独调一次 name，被拒、原因含 reason，什么都没做：之前已有的编排 WF（没有节点）与 owner 发起的后台任务原样不动，替身没被
 * 调用，没有定时任务与运行
 */
async function expectRefused(
  s: Booted,
  name: string,
  args: Record<string, unknown>,
  who: UserIdentity,
  reason: string,
) {
  await s.wf().defineWorkflow({ id: WF, trigger: { type: 'manual' }, nodes: [] });
  const taskId = await s.startTask(OWNER);
  const result = await s.call(name, name === 'background_stop' ? { taskId } : args, who);
  expect(String(result.error)).toContain(reason);
  expect(s.did).toEqual([]);
  expect(s.jobs()).toEqual([]);
  expect(s.wf().listRuns()).toEqual([]);
  expect(s.wf().getWorkflow(WF)?.nodes).toEqual([]);
  expect(s.running(taskId)).toBe(true);
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

describe('参与者都是 owner 的回合', () => {
  it('这些工具都在免确认白名单里：不要审批，照常生效', async () => {
    const s = await boot(ALL_DANGEROUS);
    expect((await s.call('create_subtask', { task: '<任务>' }, OWNER)).subtaskId).toBe(CHILD);
    await s.call('send_to_subtask', { subtask_id: CHILD, message: '<追问>' }, OWNER);
    await s.call('set_subtask_setting', { subtask_id: CHILD, key: 'persona', value: '<人设>' }, OWNER);
    expect((await s.call('delete_subtask', { subtask_id: CHILD }, OWNER)).deleted).toBe(true);
    expect(s.did).toEqual(['create', `ask ${CHILD}`, `set ${CHILD} persona as ${OWNER.userId}`, `delete ${CHILD}`]);

    await s.call('scheduler_create_job', { name: 'zz-job', content: '提醒', interval: 3600 }, OWNER);
    expect(s.jobs().map(j => ({ name: j.name, paused: j.paused }))).toEqual([{ name: 'zz-job', paused: false }]);
    await s.call('scheduler_pause_job', { name: 'zz-job' }, OWNER);
    expect(s.jobs()[0].paused).toBe(true);
    await s.call('scheduler_resume_job', { name: 'zz-job' }, OWNER);
    expect(s.jobs()[0].paused).toBe(false);
    await s.call('scheduler_remove_job', { name: 'zz-job' }, OWNER);
    expect(s.jobs()).toEqual([]);

    await s.call('workflow_define', { yaml: YAML }, OWNER);
    expect((await s.call('workflow_run', { id: WF }, OWNER)).status, '编排里的步骤按定义者（owner）跑').toBe('success');
    expect((await s.call('workflow_remove', { id: WF }, OWNER)).ok).toBe(true);
    expect(s.wf().getWorkflow(WF)).toBeUndefined();

    const taskId = await s.startTask(OWNER);
    expect(await s.call('background_stop', { taskId }, OWNER)).toMatchObject({ taskId, status: 'stopped' });
  });

  it.each(DANGEROUS)('不在白名单、没有审批服务：%s 照旧要确认，被拒、不生效', async (name, args) => {
    await expectRefused(await boot([]), name, args, OWNER, NEEDS_APPROVAL);
  });
});

describe('别人单独发起的', () => {
  it.each(
    DANGEROUS.filter(([name]) => name === 'create_subtask' || name === 'workflow_run'),
  )('1 级群友调 %s：等级不够，被拒、不生效', async (name, args) => {
    const s = await boot([]);
    s.setLevel(MEMBER, 1);
    await expectRefused(s, name, args, MEMBER, `"tool:${name}" 需等级 2`);
  });

  it.each(
    DANGEROUS,
  )('2 级群友调 %s：等级够了也没人能批，被拒、不生效；免确认白名单只对 owner 的回合生效', async (name, args) => {
    const s = await boot(ALL_DANGEROUS);
    s.setLevel(MEMBER, 2);
    await expectRefused(s, name, args, MEMBER, NEEDS_APPROVAL);
  });

  it('自己发起的后台任务也无法停止：停后台任务不另判发起者，与别的 2 级加确认的工具同一规则', async () => {
    const s = await boot([]);
    s.setLevel(MEMBER, 2);
    const taskId = await s.startTask(MEMBER);
    expect(String((await s.call('background_stop', { taskId }, MEMBER)).error)).toContain(NEEDS_APPROVAL);
    expect(s.running(taskId)).toBe(true);
  });
});

describe('有 owner 在的一轮', () => {
  it('出卡给 owner 批（只有 owner 能批），批过的按 owner 执行', async () => {
    const requests: ApprovalRequest[] = [];
    const s = await boot([], { approvals: requests });
    s.setLevel(MEMBER, 2);
    const both = [OWNER, MEMBER];
    await s.call('create_subtask', { task: '<任务>' }, MEMBER, both);
    await s.call('set_subtask_setting', { subtask_id: CHILD, key: 'persona', value: '<人设>' }, MEMBER, both);
    expect(requests.map(({ tool, ownerOnly }) => ({ tool, ownerOnly }))).toEqual([
      { tool: 'create_subtask', ownerOnly: true },
      { tool: 'set_subtask_setting', ownerOnly: true },
    ]);
    expect(s.did).toEqual(['create', `set ${CHILD} persona as ${OWNER.userId}`]);
  });
});

describe('只看不改的：2 级、不确认', () => {
  it.each(READ_ONLY)('%s：1 级被拒，2 级群友单独调照常', async (name, args) => {
    const s = await boot([]);
    s.setLevel(MEMBER, 1);
    expect(String((await s.call(name, args, MEMBER)).error)).toContain(`"tool:${name}" 需等级 2`);
    s.setLevel(MEMBER, 2);
    expect((await s.call(name, args, MEMBER)).error).toBeUndefined();
  });
});
