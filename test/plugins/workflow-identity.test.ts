import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserIdentity } from '../../packages/api-authority/src/index.js';
import { tools as toolsService } from '../../packages/api-tools/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type WorkflowDef, type WorkflowService, workflow } from '../../packages/api-workflow/src/index.js';
import { type App, events, provide, services } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import cronEnginePlugin from '../../packages/plugin-cron-engine/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import workflowPlugin from '../../packages/plugin-workflow/src/index.js';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 编排的运行身份取定义者与调用者里不是 owner 的一方。定义者由本插件自己的入口记下（workflow_define 取调用者的授权身份，
// 工作流页取登录的 owner），经服务的 defineWorkflow 定义的没有定义者；覆盖即换成覆盖者，记在运行历史文件的账本里、连同
// 定义文件文本的哈希；定时与事件触发以定义者作调用者，工作流页「立即运行」的调用者是登录的 owner。手写的、文件被改过的、
// 账本读不出的没有定义者，按匿名。
// 权限服务不在时判不出 owner，调用者与定义者不是同一身份的按匿名。
// 真 storage-local、真工具注册表与权限插件：zz_whoami 记下每次执行时的授权身份；zz_confirm 声明需要确认，确认覆盖设为
// off（只对 owner 免），没有审批服务，不免的一律拒。
// ════════════════════════════════════════════════════════════

const OWNER = { platform: 'onebot', userId: '99999' };
const MEMBER = { platform: 'onebot', userId: '30001' };
const CONSOLE = { platform: 'webui', userId: 'console' };
const ID = 'zz-wf';

const yamlOf = (trigger: string) => `id: ${ID}
trigger:
${trigger}
nodes:
  - id: who
    type: tool
    tool: zz_whoami
  - id: act
    type: tool
    tool: zz_confirm
    deps: [who]
`;
const MANUAL = yamlOf('  type: manual');
const ON_PING = yamlOf('  type: event\n  event: zz:ping');

let base: string;
let apps: App[];
let hosts: PageHost[];
/** 每次执行 zz_whoami 时的运行身份（工具调用上下文的唯一参与者，undefined 即匿名） */
let actors: Array<UserIdentity | undefined>;
/** zz_confirm 真正执行的次数 */
let confirmed: number;

const defFile = () => join(base, 'workspace', 'workflows', `${ID}.yaml`);
// data:/ 是内置根，按家目录布局在 state/ 下
const runsFile = () => join(base, 'state', 'workflow-runs.json');

async function boot() {
  const { app } = hostedApp({
    owners: [OWNER],
    confirmOverrides: { 'tool:zz_confirm': 'off' },
    // 成员不另登记等级也能定义与调起编排
    authorityOverrides: { 'tool:workflow_define': 0, 'tool:workflow_run': 0 },
  });
  apps.push(app);
  await registerHubs(app);
  const pages = pageHost();
  hosts.push(pages);
  app.bind({ provide }).provide.use(webuiServer, pages.service);
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
  const host = app.bind({ tools: toolsService, events, services });
  const probe = (name: string) => ({
    type: 'function' as const,
    function: { name, description: '探针', parameters: { type: 'object' as const, properties: {} } },
  });
  host.tools.use.register({
    definition: probe('zz_whoami'),
    handler: async (_args, ctx) => {
      const [runner, ...more] = ctx.participants;
      if (more.length > 0) throw new Error('编排的工具调用只有一位参与者');
      actors.push(runner.userId ? runner : undefined);
      return 'ok';
    },
  });
  host.tools.use.register({
    confirm: 'session',
    definition: probe('zz_confirm'),
    handler: async () => {
      confirmed++;
      return 'ok';
    },
  });
  await app.plugin(workflowPlugin, {});
  await app.plugins.idle();
  for (const p of [storageLocalPlugin, toolsPlugin, cronEnginePlugin, authorityPlugin, workflowPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  const svc = host.services.use.get(workflow) as WorkflowService;
  /** 以某人的身份调一个工具（参与者缺省即物理发言者），结果按 JSON 读 */
  const tool = async (
    name: string,
    args: Record<string, unknown>,
    who: UserIdentity,
    participants: UserIdentity[] = [who],
  ) => JSON.parse((await host.tools.use.execute(name, args, { sessionId: 'internal', ...who, participants })).content);
  /** 调工作流页的一个动作：不是 200 就失败 */
  const act = async (action: string, body: Record<string, unknown>) => {
    const reply = await pages.act('workflows', action, body);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  };
  return { app, svc, tool, act, events: host.events.use };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aalis-wf-identity-'));
  mkdirSync(join(base, 'state'), { recursive: true });
  mkdirSync(join(base, 'workspace', 'workflows'), { recursive: true });
  apps = [];
  hosts = [];
  actors = [];
  confirmed = 0;
});

afterEach(async () => {
  for (const app of apps) await app.stop();
  for (const pages of hosts) pages.dispose();
  rmSync(base, { recursive: true, force: true });
});

describe('编排的运行身份：定义者与调用者里不是 owner 的一方', () => {
  it('成员覆盖 owner 的编排后，owner 经 workflow_run 调起：按成员执行，确认覆盖的 off 不免', async () => {
    const s = await boot();
    expect((await s.tool('workflow_define', { yaml: MANUAL }, OWNER)).ok).toBe(true);
    await s.tool('workflow_run', { id: ID }, OWNER);
    expect(actors, '对照：owner 定义、owner 调起按 owner 执行').toEqual([OWNER]);
    expect(confirmed).toBe(1);

    expect((await s.tool('workflow_define', { yaml: MANUAL }, MEMBER)).ok).toBe(true);
    await s.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([OWNER, MEMBER]);
    expect(confirmed, '成员的回合不免确认').toBe(1);
  });

  it('成员调起 owner 定义的编排按成员执行，不传调用者的按匿名：借不到定义者的身份', async () => {
    const s = await boot();
    await s.tool('workflow_define', { yaml: MANUAL }, OWNER);
    await s.tool('workflow_run', { id: ID }, MEMBER);
    await s.svc.runWorkflow(ID);
    expect(actors).toEqual([MEMBER, undefined]);
    expect(confirmed).toBe(0);
  });

  it('几个人的一轮调起：没有单一的调用者，按匿名执行', async () => {
    const s = await boot();
    await s.tool('workflow_define', { yaml: MANUAL }, OWNER);
    await s.tool('workflow_run', { id: ID }, OWNER, [OWNER, MEMBER]);
    expect(actors).toEqual([undefined]);
    expect(confirmed).toBe(0);
  });

  it('经服务的 defineWorkflow 覆盖：没有定义者，账本里原来的定义者也清掉，重启后照旧按匿名', async () => {
    const first = await boot();
    await first.tool('workflow_define', { yaml: MANUAL }, OWNER);
    // 原样覆盖：写进文件的文本与哈希都不变，只有清了账重启后才认不回 owner
    await first.svc.defineWorkflow(first.svc.getWorkflow(ID) as WorkflowDef);
    await first.tool('workflow_run', { id: ID }, OWNER);
    await first.app.stop();

    const second = await boot();
    await second.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([undefined, undefined]);
    expect(confirmed).toBe(0);
  });

  it('定义者取授权身份、不取物理发言者：物理发言者是 owner 的自发回合定义的，没有定义者', async () => {
    const s = await boot();
    await s.tool('workflow_define', { yaml: MANUAL }, OWNER, [selfInitiatedActor('onebot')]);
    await s.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([undefined]);
  });

  it.each([
    ['workflow_define 定义、事件触发', 'tool', 'event', OWNER],
    ['工作流页定义、trigger:fired 触发', 'page', 'fired', CONSOLE],
  ] as const)('owner 定义的编排由触发器触发（%s）：按定义者执行，确认覆盖的 off 生效', async (_label, via, fire, definer) => {
    const s = await boot();
    if (via === 'tool') await s.tool('workflow_define', { yaml: ON_PING }, OWNER);
    else await s.act('defineWorkflow', { input: { yaml: ON_PING } });
    // 事件触发器订阅的是不在事件表里的自定义事件
    if (fire === 'event') await (s.events as unknown as { emit(event: string): Promise<void> }).emit('zz:ping');
    else await s.events.emit('trigger:fired', { source: 'zz-test', type: 'event', workflowId: ID });
    await expect.poll(() => s.svc.listRuns(1)[0]?.status).toBe('success');
    expect(actors).toEqual([definer]);
    expect(confirmed).toBe(1);
  });

  it('工作流页「立即运行」按定义者执行，停用再启用不换定义者', async () => {
    const s = await boot();
    await s.tool('workflow_define', { yaml: MANUAL }, OWNER);
    await s.act('disableWorkflow', { rowKey: ID });
    await s.act('enableWorkflow', { rowKey: ID });
    await s.act('runWorkflow', { rowKey: ID });
    expect(actors).toEqual([OWNER]);
    expect(confirmed).toBe(1);
  });

  it('权限服务不在时判不出 owner：「立即运行」成员定义的编排按匿名', async () => {
    const s = await boot();
    await s.tool('workflow_define', { yaml: MANUAL }, MEMBER);
    expect(await s.app.plugins.disable(authorityPlugin.name)).toBe(true);
    await s.act('runWorkflow', { rowKey: ID });
    expect(actors).toEqual([undefined]);
  });

  it('权限服务不在时，同一身份定义又调起的编排按这个身份执行', async () => {
    const s = await boot();
    await s.tool('workflow_define', { yaml: MANUAL }, MEMBER);
    expect(await s.app.plugins.disable(authorityPlugin.name)).toBe(true);
    await s.svc.runWorkflow(ID, {}, 'manual', MEMBER);
    expect(actors).toEqual([MEMBER]);
  });
});

describe('定义者账本', () => {
  it('定义者不写进定义文件；文件没被改过的，重启后照旧按定义者', async () => {
    const first = await boot();
    await first.tool('workflow_define', { yaml: MANUAL }, MEMBER);
    expect(readFileSync(defFile(), 'utf8')).not.toMatch(/30001/);
    await first.app.stop();

    const second = await boot();
    await second.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([MEMBER]);
    expect(confirmed).toBe(0);
  });

  it.each([
    ['定义文件在磁盘上被改过', () => writeFileSync(defFile(), `${readFileSync(defFile(), 'utf8')}# 改过\n`)],
    ['运行历史文件读不出', () => writeFileSync(runsFile(), '{')],
  ])('%s：重启后按匿名，owner 调起也一样', async (_label, tamper) => {
    const first = await boot();
    await first.tool('workflow_define', { yaml: MANUAL }, OWNER);
    await first.app.stop();
    tamper();

    const second = await boot();
    await second.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([undefined]);
    expect(confirmed).toBe(0);
  });

  it('手写进工作区的定义按匿名，文件里写的 definedBy 不认', async () => {
    writeFileSync(defFile(), `${MANUAL}definedBy:\n  platform: onebot\n  userId: '99999'\n`);
    const s = await boot();
    await s.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([undefined]);
    expect(confirmed).toBe(0);
  });

  it.each(['经 workflow_remove 删除', '手删文件后重启一次'])('定义没了（%s）再手写同样的文本：按匿名', async how => {
    const first = await boot();
    await first.tool('workflow_define', { yaml: MANUAL }, OWNER);
    const text = readFileSync(defFile(), 'utf8');
    if (how === '经 workflow_remove 删除') {
      expect((await first.tool('workflow_remove', { id: ID }, OWNER)).ok).toBe(true);
      await first.app.stop();
    } else {
      await first.app.stop();
      rmSync(defFile());
      await (await boot()).app.stop();
    }
    writeFileSync(defFile(), text);

    const last = await boot();
    await last.tool('workflow_run', { id: ID }, OWNER);
    expect(actors).toEqual([undefined]);
  });
});
