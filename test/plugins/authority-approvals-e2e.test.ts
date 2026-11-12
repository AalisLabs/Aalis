import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Approval, type ApprovalSurface, approvals } from '../../packages/api-approval/src/index.js';
import { authority, originTurnOf } from '../../packages/api-authority/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallRequest, tools } from '../../packages/api-tools/src/index.js';
import { markTriggered } from '../../packages/api-trigger/src/index.js';
import { type App, definePlugin, optional, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { type FromTurn, type IncomingMessage, selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { recordRoom } from '../fixtures/rooms.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 需要确认的工具调用 → 执行守卫 → owner 审批，整条接线：真实的工具注册表、权限插件与会话服务，
// 一个 WebUI 审批面上有一条在场的 owner 连接。探针工具人人有权调用、声明需要确认，
// 所以每一行只看这一轮的触发者：这一轮里有 owner 的话（人亲手发起，含它的续做与派出的子任务）就出卡，不论在哪个会话；
// 其余直接拒、不推给任何面，模型收到对应的话。上下文按 agent 工具循环的填法构造。房间经原生入站收录。
// ════════════════════════════════════════════════════════════

const OWNER = { platform: 'webui', userId: 'console' };
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const MEMBER_QQ = { platform: 'onebot', userId: '30001' };
const MINE = 'session-mine';
const ROOM = 'onebot:10000:group:20001';
const OWNER_DM = `onebot:10000:private:${OWNER_QQ.userId}`;
const MEMBER_DM = `onebot:10000:private:${MEMBER_QQ.userId}`;
const PROBE = 'zz_confirm_probe';

/** 审批服务回给模型的话（见 plugin-session-server 的 approvals.ts） */
const INELIGIBLE = '这一轮里没有 owner 的话，要 owner 确认的操作不能执行';

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const surfacePlugin = (out: { surface?: ApprovalSurface }) =>
  definePlugin({
    name: '@test/webui-surface',
    uses: { approvals: optional(approvals) },
    apply: ({ approvals }) => {
      out.surface = approvals.use.registerSurface('webui');
    },
  });

interface Setup {
  /** 不登记会话服务（没有审批服务） */
  withoutApprovals?: boolean;
  appConfig?: Record<string, unknown>;
  confirm?: 'session' | 'always';
  risk?: 'sensitive';
}

async function setup({ withoutApprovals = false, appConfig = {}, confirm = 'session', risk }: Setup = {}) {
  const { app } = hostedApp({ owners: [OWNER_QQ], ...appConfig });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  const home = mkdtempSync(join(tmpdir(), 'aalis-guard-approvals-'));
  homes.push(home);
  const { state } = provideHostPaths(app, home);
  const host = app.bind({ provide, events, tools, sessionManager, sessionProtocol, authority });
  host.provide.use(storage, memoryStorage(new Map()));
  await app.plugin(toolsPlugin, {});
  await app.plugin(authorityPlugin, {});
  const out: { surface?: ApprovalSurface } = {};
  const expected = [toolsPlugin.name, authorityPlugin.name];
  if (!withoutApprovals) {
    await app.plugin(sessionManagerPlugin, {});
    await app.plugin(sessionServerPlugin, {});
    await app.plugin(surfacePlugin(out));
    expected.push(sessionServerPlugin.name, '@test/webui-surface');
  }
  await app.plugins.idle();
  for (const name of expected) {
    const s = app.plugins.getPlugin(name)?.state;
    if (s !== 'active') throw new Error(`${name} 未激活（state=${s}）`);
  }

  /** 探针每次执行收到的参数 */
  const received: Array<Record<string, unknown>> = [];
  host.tools.use.register({
    confirm,
    ...(risk ? { risk } : {}),
    // 卡上的事实按声明的展示种类取：探针把 command 声明成命令
    display: { kind: 'command', fields: { command: 'command' } },
    definition: {
      type: 'function',
      function: {
        name: PROBE,
        description: '探针',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
    handler: async args => {
      received.push(args);
      return 'ran';
    },
  });

  let conn: ReturnType<typeof client> | undefined;
  if (!withoutApprovals) {
    const sm = host.sessionManager.use;
    // owner 自己的会话：与 WebUI 新建的一样带创建来源
    await sm.ensureSession(MINE, { name: '我的' }, { createdFrom: 'webui' });
    for (const id of [ROOM, OWNER_DM, MEMBER_DM]) await recordRoom(host.events.use, id);
    if (!out.surface) throw new Error('审批面没登记上');
    conn = client(host.sessionProtocol.use, { identity: OWNER, surface: out.surface });
    await conn.init();
    await conn.call('presence/update', { active: true });
  }

  let seq = 0;
  /** 按 agent 工具循环的填法调一次探针：带回合与调用 id */
  const call = (
    ctx: Omit<ToolCallRequest, 'turnId' | 'callId'>,
    signal?: AbortSignal,
    args: Record<string, unknown> = { command: 'rm -rf build' },
  ) => {
    seq++;
    const full: ToolCallRequest = { ...ctx, turnId: `turn-${seq}`, callId: `call-${seq}`, signal };
    return { ctx: full, result: host.tools.use.execute(PROBE, args, full) };
  };
  const pushed = (): Approval[] => conn?.notifications('approval/requested').map(p => p.approval) ?? [];
  /** 等第 n 张卡推到 WebUI */
  const card = async (n = 1) => {
    await vi.waitFor(() => expect(pushed()).toHaveLength(n));
    return pushed()[n - 1];
  };
  const answer = (approval: Approval, decision: 'approve' | 'deny', note?: string) =>
    conn?.call('approval/respond', { approvalId: approval.id, decision, contentHash: approval.contentHash, note });
  return {
    app,
    host,
    call,
    pushed,
    card,
    answer,
    received,
    runs: () => received.length,
    auditFile: join(state, 'audit', 'approvals.jsonl'),
  };
}

type Ctx = Omit<ToolCallRequest, 'turnId' | 'callId'>;

/** 发起它的那一轮：人亲手发来的 */
const handTurn = (who: { platform: string; userId: string }): FromTurn => ({
  platform: who.platform,
  userId: who.userId,
  participants: [who],
});

/** 子任务那一轮：按 plugin-subtask 的任务消息与 agent 的填法，发言者记作父会话，授权身份取派它的那一轮的参与者 */
const subtask = (sessionId: string, parent: string, from: FromTurn): Ctx => ({
  sessionId,
  platform: from.platform,
  userId: `parent:${parent}`,
  participants: from.participants,
  inbound: { source: 'subtask', fromTurn: from },
});

/** 定时任务那一轮：授权身份是创建者 owner */
const SCHEDULED: FromTurn = { platform: 'webui', participants: [OWNER], source: 'scheduler' };

/** 续做那一轮：按 agent 的填法，工具眼里是发起它的人在调，授权身份取发起它的那一轮的参与者 */
const resumed = (sessionId: string, from: FromTurn): Ctx => ({
  sessionId,
  platform: from.platform,
  userId: from.userId,
  participants: from.participants,
  inbound: { source: 'bg:bg_x_1', fromTurn: from },
});

describe('能产生审批的回合：这一轮里有 owner 的话，不论在哪个会话', () => {
  const rows: Array<[string, Ctx, { platform: string; userId: string }]> = [
    ['owner 在 WebUI 亲手发起', { sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} }, OWNER],
    [
      'owner 在自己的 QQ 私聊亲手发起（推到 WebUI）',
      { sessionId: OWNER_DM, ...OWNER_QQ, participants: [OWNER_QQ], inbound: {} },
      OWNER_QQ,
    ],
    ['owner 在群里亲手发起', { sessionId: ROOM, ...OWNER_QQ, participants: [OWNER_QQ], inbound: {} }, OWNER_QQ],
    ['owner 从 WebUI 往群里插话发起', { sessionId: ROOM, ...OWNER, participants: [OWNER], inbound: {} }, OWNER],
    ['owner 会话里后台任务结束后的续做', resumed(MINE, handTurn(OWNER)), OWNER],
    ['owner 在群里转到后台的调用，结束后的续做', resumed(ROOM, handTurn(OWNER_QQ)), OWNER_QQ],
  ];

  it.each(rows)('%s：出卡，参与者是她，批准后执行，卡上带着回合与调用 id', async (_label, ctx, who) => {
    const s = await setup();
    const { ctx: full, result } = s.call(ctx);
    const approval = await s.card();
    expect(approval).toMatchObject({ sessionId: ctx.sessionId, turnId: full.turnId, callId: full.callId, tool: PROBE });
    expect(approval.origin).toEqual({ kind: 'hand', participants: [who] });
    expect(approval.facts.command).toBe('rm -rf build');
    expect(s.runs(), '批准之前不得执行').toBe(0);
    await s.answer(approval, 'approve');
    expect((await result).content).toBe('ran');
    expect(s.runs()).toBe(1);
  });

  it('批准后执行的参数与卡上的事实逐字一致（含 ESC 与 U+202E），也与发起调用时的参数一致', async () => {
    const s = await setup();
    const args = { command: 'cat notes\u202Etxt.sh \u001b[2K; rm -rf ./build' };
    const { result } = s.call({ sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} }, undefined, {
      ...args,
    });
    const approval = await s.card();
    await s.answer(approval, 'approve');
    expect((await result).content).toBe('ran');
    expect(s.received).toEqual([args]);
    expect(s.received[0].command).toBe(approval.facts.command);
  });

  it.each([
    ['owner 的会话', { sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} }],
    ['owner 自己的 QQ 私聊', { sessionId: OWNER_DM, ...OWNER_QQ, participants: [OWNER_QQ], inbound: {} }],
    ['群里', { sessionId: ROOM, ...OWNER_QQ, participants: [OWNER_QQ], inbound: {} }],
  ])('owner 拒绝（%s）：不执行，模型收到拒绝与说明，不指名应答人', async (_label, ctx) => {
    const s = await setup();
    const { result } = s.call(ctx);
    await s.answer(await s.card(), 'deny', '先别删，备份一下');
    const out = (await result).content;
    expect(s.runs()).toBe(0);
    expect(out).toContain('被拒绝了，说明：「先别删，备份一下」。');
    expect(out).not.toContain('owner');
  });

  it('owner 派的子任务：推给 WebUI，挂在子会话上，类别随派它的那一轮、带来源链；批准即执行，拒绝附说明时模型拿到说明', async () => {
    const s = await setup();
    const child = (await s.host.sessionManager.use.createChildSession(MINE, { name: '整理资料' })).id;
    const ctx = subtask(child, MINE, handTurn(OWNER));
    const first = s.call(ctx);
    const approval = await s.card();
    expect(approval).toMatchObject({ sessionId: child, chain: [{ id: child, title: '整理资料' }] });
    expect(approval.origin).toEqual({ kind: 'hand', participants: [OWNER] });
    await s.answer(approval, 'approve');
    expect((await first.result).content).toBe('ran');

    const second = s.call(ctx);
    await s.answer(await s.card(2), 'deny', '先别删');
    expect((await second.result).content).toContain('被拒绝了，说明：「先别删」');
    expect(s.runs()).toBe(1);
  });

  it('等待中回合中止：审批撤销，不执行', async () => {
    const s = await setup();
    const turn = new AbortController();
    const { result } = s.call({ sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} }, turn.signal);
    await s.card();
    turn.abort();
    expect((await result).content).toContain('发起它的回合已结束');
    expect(s.runs()).toBe(0);
  });
});

describe('不能产生审批的回合：不推给任何面，模型收到对应的话', () => {
  const rows: Array<[string, Ctx, string]> = [
    ['群成员在群里发起', { sessionId: ROOM, ...MEMBER_QQ, participants: [MEMBER_QQ], inbound: {} }, INELIGIBLE],
    [
      'owner 建的定时任务（创建者回填成授权身份）',
      { sessionId: MINE, platform: 'webui', participants: [OWNER], inbound: { source: 'scheduler' } },
      INELIGIBLE,
    ],
    ['群成员那一轮派的子任务', subtask(`${ROOM}::abcd1234`, ROOM, handTurn(MEMBER_QQ)), INELIGIBLE],
    ['owner 建的定时任务那一轮派的子任务', subtask(`${MINE}::abcd1234`, MINE, SCHEDULED), INELIGIBLE],
    [
      '没带发起它的那一轮的子任务（编排的工具节点、mcp-server 派的）',
      {
        sessionId: `${MINE}::abcd1234`,
        platform: 'webui',
        userId: `parent:${MINE}`,
        participants: [OWNER],
        inbound: { source: 'subtask' },
      },
      INELIGIBLE,
    ],
  ];

  it.each(rows)('%s', async (_label, ctx, text) => {
    const s = await setup();
    const out = (await s.call(ctx).result).content;
    expect(s.pushed(), '不得推给任何审批面').toEqual([]);
    expect(s.runs()).toBe(0);
    expect(out).toContain(text);
  });

  it.each<[string, Ctx]>([
    [
      'owner 建的定时任务',
      { sessionId: MINE, platform: 'webui', participants: [OWNER], inbound: { source: 'scheduler' } },
    ],
    ['定时任务那一轮派的子任务', subtask(`${MINE}::abcd1234`, MINE, SCHEDULED)],
  ])('自主回合被拒记进审计（%s）：请求与决定成对，类别为 autonomous', async (_label, ctx) => {
    const s = await setup();
    await s.call(ctx).result;
    await vi.waitFor(() => expect(readFileSync(s.auditFile, 'utf8').trim().split('\n')).toHaveLength(2));
    const [request, decision] = readFileSync(s.auditFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(request).toMatchObject({ type: 'request', origin: { kind: 'autonomous' }, tool: PROBE });
    expect(decision).toMatchObject({ type: 'decision', id: request.id, state: 'denied', source: 'ineligible' });
  });
});

describe('群里没点名、被频率触发挑中的话按说话的人算', () => {
  /** 群里一句没点名的话，触发器挑中放行，agent 按它拼这一轮 */
  const interjection = (who: { platform: string; userId: string }): Ctx => {
    const message: IncomingMessage = { content: '<闲聊>', sessionId: ROOM, ...who, sessionType: 'group' };
    markTriggered(message, false);
    return originTurnOf([message]);
  };

  it('owner 的一句：WebUI 的接入收到审批，参与者是她，批准即执行', async () => {
    const s = await setup();
    const { result } = s.call(interjection(OWNER_QQ));
    const approval = await s.card();
    expect(approval.origin).toEqual({ kind: 'hand', participants: [OWNER_QQ] });
    await s.answer(approval, 'approve');
    expect((await result).content).toBe('ran');
  });

  it('1 级群友的一句：按他的等级裁决，需要确认的被拒，拿到这一轮里没有 owner 的话那句', async () => {
    const s = await setup({ risk: 'sensitive' });
    const zero = (await s.call(interjection(MEMBER_QQ)).result).content;
    expect(zero, '0 级：等级不够').toContain('权限不足');
    s.host.authority.use.setUserLevel(MEMBER_QQ, 1);
    const one = (await s.call(interjection(MEMBER_QQ)).result).content;
    expect(one).toContain(INELIGIBLE);
    expect(s.pushed()).toEqual([]);
    expect(s.runs()).toBe(0);
  });
});

describe('确认的豁免与缺席', () => {
  it('审批服务不在：立即拒并说明原因', async () => {
    const s = await setup({ withoutApprovals: true });
    const out = (await s.call({ sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} }).result).content;
    expect(s.runs()).toBe(0);
    expect(out).toContain('审批服务不在');
  });

  const OFF = { confirmOverrides: { [`tool:${PROBE}`]: 'off' } };
  const WAIVE = { restrictedPolicy: { allow: [`tool:${PROBE}`] } };

  it('confirmOverrides 关掉确认只对 owner：群成员在群里照旧要审批，被拒、不执行，审计记插件的声明', async () => {
    const s = await setup({ appConfig: OFF });
    const out = (await s.call({ sessionId: ROOM, ...MEMBER_QQ, participants: [MEMBER_QQ], inbound: {} }).result)
      .content;
    expect(s.runs()).toBe(0);
    expect(s.pushed()).toEqual([]);
    expect(out).toContain(INELIGIBLE);
    await vi.waitFor(() => expect(readFileSync(s.auditFile, 'utf8').trim().split('\n')).toHaveLength(2));
    const [request] = readFileSync(s.auditFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(request.rule).toBe(`tool:${PROBE} 声明 confirm=session`);
  });

  it('confirmOverrides 关掉确认：owner 派的子任务照常执行，不出卡', async () => {
    const s = await setup({ appConfig: OFF });
    const subtask = {
      sessionId: `${MINE}::abcd1234`,
      platform: 'webui',
      userId: `parent:${MINE}`,
      participants: [OWNER],
      inbound: { source: 'subtask' },
    };
    expect((await s.call(subtask).result).content).toBe('ran');
    expect(s.pushed()).toEqual([]);
  });

  const notOwner: Array<[string, Ctx, string]> = [
    [
      '对端不是 owner 的私聊里对方发起的',
      { sessionId: MEMBER_DM, ...MEMBER_QQ, participants: [MEMBER_QQ], inbound: {} },
      INELIGIBLE,
    ],
    [
      '匿名编排的工具节点',
      { sessionId: 'workflow::daily', platform: 'workflow', participants: [selfInitiatedActor('workflow')] },
      INELIGIBLE,
    ],
  ];
  it.each(notOwner)('restrictedPolicy 白名单只对 owner：别人的回合照旧拒（%s）', async (_label, ctx, text) => {
    const s = await setup({ appConfig: WAIVE });
    const out = (await s.call(ctx).result).content;
    expect(s.runs()).toBe(0);
    expect(s.pushed()).toEqual([]);
    expect(out).toContain(text);
  });

  it.each([
    ['confirmOverrides 设为 off', OFF],
    ['restrictedPolicy 白名单', WAIVE],
  ])('物理发言者是 owner、授权身份没有账号的一轮（%s）：照旧不免，不执行', async (_label, appConfig) => {
    const s = await setup({ appConfig });
    const ctx = { sessionId: MINE, ...OWNER, participants: [selfInitiatedActor('webui')], inbound: {} };
    expect((await s.call(ctx).result).content).toContain(INELIGIBLE);
    expect(s.runs()).toBe(0);
    expect(s.pushed()).toEqual([]);
  });

  it('restrictedPolicy 白名单免 owner 的 session 档确认；always 档照常出卡', async () => {
    const session = await setup({ appConfig: WAIVE });
    expect((await session.call({ sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} }).result).content).toBe(
      'ran',
    );
    expect(session.pushed()).toEqual([]);

    const always = await setup({ appConfig: WAIVE, confirm: 'always' });
    const { result } = always.call({ sessionId: MINE, ...OWNER, participants: [OWNER], inbound: {} });
    await always.answer(await always.card(), 'approve');
    expect((await result).content).toBe('ran');
  });
});
