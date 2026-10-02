import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Approval, type ApprovalSurface, approvals } from '../../packages/api-approval/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, optional, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { client } from '../fixtures/session-client.js';

// ════════════════════════════════════════════════════════════
// 需要确认的工具调用 → 执行守卫 → owner 审批，整条接线：真实的工具注册表、权限插件与会话服务，
// 一个 WebUI 审批面上有一条在场的 owner 连接。探针工具人人有权调用、声明需要确认，
// 所以每一行只看发起回合的类别：只有 owner 本人与 owner 链的延续出卡，其余直接拒、不推给任何面，
// 模型收到对应的话。上下文按 agent 工具循环的填法构造。
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
const INELIGIBLE = '这一轮不是 owner 亲手发起的，不能产生审批';
const SUBTASK = '子任务里需要确认的操作不会转给 owner，请在发起它的会话里执行';
const ROOM_DENIAL = '需要批准的操作在这里不能执行。';

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
      out.surface = approvals.registerSurface('webui');
    },
  });

interface Setup {
  /** 不登记会话服务（没有审批服务） */
  withoutApprovals?: boolean;
  appConfig?: Record<string, unknown>;
  confirm?: 'session' | 'always';
}

async function setup({ withoutApprovals = false, appConfig = {}, confirm = 'session' }: Setup = {}) {
  const { app } = hostedApp({ owners: [OWNER_QQ], ...appConfig });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  const home = mkdtempSync(join(tmpdir(), 'aalis-guard-approvals-'));
  homes.push(home);
  const { state } = provideHostPaths(app, home);
  const host = app.bind({ provide, tools, sessionManager, sessionProtocol });
  host.provide(storage, memoryStorage(new Map()));
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
  host.tools.register({
    confirm,
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
    const sm = host.sessionManager.require();
    await sm.ensureSession(MINE, { name: '我的' });
    for (const id of [ROOM, OWNER_DM, MEMBER_DM]) await sm.ensureSession(id, { name: id });
    if (!out.surface) throw new Error('审批面没登记上');
    conn = client(host.sessionProtocol.require(), { identity: OWNER, surface: out.surface });
    await conn.init();
    await conn.call('presence/update', { active: true });
  }

  let seq = 0;
  /** 按 agent 工具循环的填法调一次探针：带回合与调用 id */
  const call = (
    ctx: Omit<ToolCallContext, 'turnId' | 'callId'>,
    signal?: AbortSignal,
    args: Record<string, unknown> = { command: 'rm -rf build' },
  ) => {
    seq++;
    const full: ToolCallContext = { ...ctx, turnId: `turn-${seq}`, callId: `call-${seq}`, signal };
    return { ctx: full, result: host.tools.require().execute(PROBE, args, full) };
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
    call,
    pushed,
    card,
    answer,
    received,
    runs: () => received.length,
    auditFile: join(state, 'audit', 'approvals.jsonl'),
  };
}

type Ctx = Omit<ToolCallContext, 'turnId' | 'callId'>;

describe('能产生审批的回合：owner 本人与 owner 链的延续', () => {
  const rows: Array<[string, Ctx]> = [
    ['owner 在 WebUI 亲手发起', { sessionId: MINE, ...OWNER, inbound: {} }],
    ['owner 在自己的 QQ 私聊亲手发起（推到 WebUI）', { sessionId: OWNER_DM, ...OWNER_QQ, inbound: {} }],
    [
      'owner 会话里后台命令结束后的续做',
      { sessionId: MINE, ...OWNER, actor: OWNER, inbound: { source: 'exec-bg:proc_1', callerUserId: 'console' } },
    ],
  ];

  it.each(rows)('%s：出卡，批准后执行，卡上带着回合与调用 id', async (_label, ctx) => {
    const s = await setup();
    const { ctx: full, result } = s.call(ctx);
    const approval = await s.card();
    expect(approval).toMatchObject({ sessionId: ctx.sessionId, turnId: full.turnId, callId: full.callId, tool: PROBE });
    expect(approval.facts.command).toBe('rm -rf build');
    expect(s.runs(), '批准之前不得执行').toBe(0);
    await s.answer(approval, 'approve');
    expect((await result).content).toBe('ran');
    expect(s.runs()).toBe(1);
  });

  it('批准后执行的参数与卡上的事实逐字一致（含 ESC 与 U+202E），也与发起调用时的参数一致', async () => {
    const s = await setup();
    const args = { command: 'cat notes\u202Etxt.sh \u001b[2K; rm -rf ./build' };
    const { result } = s.call({ sessionId: MINE, ...OWNER, inbound: {} }, undefined, { ...args });
    const approval = await s.card();
    await s.answer(approval, 'approve');
    expect((await result).content).toBe('ran');
    expect(s.received).toEqual([args]);
    expect(s.received[0].command).toBe(approval.facts.command);
  });

  it.each([
    ['owner 的会话', { sessionId: MINE, ...OWNER, inbound: {} }],
    ['owner 自己的 QQ 私聊', { sessionId: OWNER_DM, ...OWNER_QQ, inbound: {} }],
  ])('owner 拒绝（%s）：不执行，模型收到拒绝与说明', async (_label, ctx) => {
    const s = await setup();
    const { result } = s.call(ctx);
    await s.answer(await s.card(), 'deny', '先别删，备份一下');
    const out = (await result).content;
    expect(s.runs()).toBe(0);
    expect(out).toContain('owner 拒绝了');
    expect(out).toContain('先别删，备份一下');
  });

  it('等待中回合中止：审批撤销，不执行', async () => {
    const s = await setup();
    const turn = new AbortController();
    const { result } = s.call({ sessionId: MINE, ...OWNER, inbound: {} }, turn.signal);
    await s.card();
    turn.abort();
    expect((await result).content).toContain('发起它的回合已结束');
    expect(s.runs()).toBe(0);
  });
});

describe('不能产生审批的回合：不推给任何面，模型收到对应的话', () => {
  const rows: Array<[string, Ctx, string]> = [
    [
      'owner 建的定时任务（创建者回填成授权身份）',
      { sessionId: MINE, platform: 'webui', actor: OWNER, inbound: { source: 'scheduler' } },
      INELIGIBLE,
    ],
    [
      '定时任务触发的编排：agent 节点的一轮',
      { sessionId: MINE, platform: 'webui', actor: OWNER, inbound: { source: 'workflow:daily:summarize' } },
      INELIGIBLE,
    ],
    ['编排的工具节点', { sessionId: 'workflow::daily', platform: 'workflow', actor: OWNER }, INELIGIBLE],
    [
      '频率触发记成自发的一轮（owner 恰好是最后发言者）',
      { sessionId: MINE, ...OWNER, actor: selfInitiatedActor('webui'), inbound: {} },
      INELIGIBLE,
    ],
    ['群成员在群房间里', { sessionId: ROOM, ...MEMBER_QQ, inbound: {} }, ROOM_DENIAL],
    ['owner 在群房间里亲手发起', { sessionId: ROOM, ...OWNER_QQ, inbound: {} }, ROOM_DENIAL],
    ['owner 在 WebUI 驱动群房间', { sessionId: ROOM, ...OWNER, inbound: {} }, ROOM_DENIAL],
    ['对端不是 owner 的私聊', { sessionId: MEMBER_DM, ...MEMBER_QQ, inbound: {} }, ROOM_DENIAL],
    [
      '子任务回合',
      {
        sessionId: `${MINE}::abcd1234`,
        platform: 'webui',
        userId: `parent:${MINE}`,
        actor: OWNER,
        inbound: { source: 'subtask' },
      },
      SUBTASK,
    ],
  ];

  it.each(rows)('%s', async (_label, ctx, text) => {
    const s = await setup();
    const out = (await s.call(ctx).result).content;
    expect(s.pushed(), '不得推给任何审批面').toEqual([]);
    expect(s.runs()).toBe(0);
    expect(out).toContain(text);
  });

  it('自主回合被拒记进审计：请求与决定成对，类别为 autonomous', async () => {
    const s = await setup();
    await s.call({ sessionId: MINE, platform: 'webui', actor: OWNER, inbound: { source: 'scheduler' } }).result;
    await vi.waitFor(() => expect(readFileSync(s.auditFile, 'utf8').trim().split('\n')).toHaveLength(2));
    const [request, decision] = readFileSync(s.auditFile, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(request).toMatchObject({ type: 'request', origin: { kind: 'autonomous' }, tool: PROBE });
    expect(decision).toMatchObject({ type: 'decision', id: request.id, state: 'denied', source: 'ineligible' });
  });
});

describe('确认的豁免与缺席', () => {
  it('审批服务不在：立即拒并说明原因', async () => {
    const s = await setup({ withoutApprovals: true });
    const out = (await s.call({ sessionId: MINE, ...OWNER, inbound: {} }).result).content;
    expect(s.runs()).toBe(0);
    expect(out).toContain('审批服务不在');
  });

  it('confirmOverrides 关掉确认：不出卡，群成员照常执行', async () => {
    const s = await setup({ appConfig: { confirmOverrides: { [`tool:${PROBE}`]: 'off' } } });
    expect((await s.call({ sessionId: ROOM, ...MEMBER_QQ, inbound: {} }).result).content).toBe('ran');
    expect(s.pushed()).toEqual([]);
  });

  it('restrictedPolicy 白名单免 session 档确认；always 档照常出卡', async () => {
    const appConfig = { restrictedPolicy: { allow: [`tool:${PROBE}`] } };
    const session = await setup({ appConfig });
    expect((await session.call({ sessionId: MINE, ...OWNER, inbound: {} }).result).content).toBe('ran');
    expect(session.pushed()).toEqual([]);

    const always = await setup({ appConfig, confirm: 'always' });
    const { result } = always.call({ sessionId: MINE, ...OWNER, inbound: {} });
    await always.answer(await always.card(), 'approve');
    expect((await result).content).toBe('ran');
  });
});
