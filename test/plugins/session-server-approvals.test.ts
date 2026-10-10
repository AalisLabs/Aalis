import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Approval,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalSurface,
  approvals,
  type OriginKind,
} from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, events, type Logger, optional, provide } from '../../packages/core/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { recordRoom } from '../fixtures/rooms.js';
import { client, DETACHED_SURFACE } from '../fixtures/session-client.js';
import { declareToolSystemDisplays } from '../fixtures/tool-display.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 会话服务提供的审批（approvals）：谁能产生审批、在场才问、同会话排队与频率上限、先答先得与两项核验、
// 各种结算（没人在场、等满时限、在场的面消失、回合结束或中止、拆卸）、回给模型的话、成对的审计，
// 以及审批在会话协议上的样子（推送、快照、工具卡、会话列表）。
// 审批面由一个测试插件登记；WebUI 的连接经会话协议上报在场与应答。时钟用假的，不真等。
// ════════════════════════════════════════════════════════════

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const OWNER = { platform: 'webui', userId: 'console' };
/** owner 在 QQ 上的账号：配置里的 owner */
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const MEMBER = { platform: 'onebot', userId: '30001' };
const ROOM = 'onebot:10000:group:20001';
/** owner 与机器人的 QQ 私聊：会话列表里归在房间 */
const OWNER_DM = 'onebot:10000:private:99999';

const WAIT_MS = 300_000;
const PRESENCE_MS = 10 * 60_000;
/** 在场的面全部消失之后的重连宽限 */
const GRACE_MS = 30_000;

const isOwner = (p: string, u?: string) =>
  ((p === 'webui' || p === 'cli') && u === 'console') || (p === OWNER_QQ.platform && u === OWNER_QQ.userId);

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const adapterPlugin = (name: string, adapter: Partial<PlatformAdapter>) =>
  definePlugin({
    name,
    provides: [platform],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(platform, { getConnections: () => [], sendMessage: async () => {}, ...adapter } as never);
    },
  });

/** 登记一个审批面的插件：登记身份是这个插件实例。与 webui-server 一样可选地用 approvals，审批服务停了它照常在 */
const surfacePlugin = (pluginName: string, surfaceName: string, out: Record<string, ApprovalSurface>) =>
  definePlugin({
    name: pluginName,
    uses: { approvals: optional(approvals) },
    apply: ({ approvals }) => {
      out[surfaceName] = approvals.use.registerSurface(surfaceName);
    },
  });

interface AuditLine {
  type: 'request' | 'decision';
  id: string;
  [key: string]: unknown;
}

async function setup() {
  /** 记下的 info 日志 */
  const infos: string[] = [];
  const logger: Logger = { ...silent, info: message => void infos.push(message), child: () => logger };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemoryPlugin);
  await app.plugins.idle();
  const home = mkdtempSync(join(tmpdir(), 'aalis-approvals-'));
  homes.push(home);
  const { state } = provideHostPaths(app, home);
  const host = app.bind({ provide, events, hooks, sessionManager, sessionProtocol, approvals, tools });
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, { isOwner } as never);
  // 卡上的事实按工具定义上声明的展示种类取：登记与系统工具同样声明的空工具
  await app.plugin(toolsPlugin, {});
  await app.plugins.idle();
  declareToolSystemDisplays(host.tools.use);
  await app.plugin(adapterPlugin('onebot-a', { platform: 'onebot', canHandle: id => id.startsWith('onebot:10000:') }));
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  const surfaces: Record<string, ApprovalSurface> = {};
  await app.plugin(surfacePlugin('@test/webui-surface', 'webui', surfaces));
  await app.plugins.idle();
  for (const name of [sessionServerPlugin.name, '@test/webui-surface']) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  const sm = host.sessionManager.use;
  const mine = (await sm.createSession({ name: '我的' }, { createdFrom: 'webui' })).id;
  await recordRoom(host.events.use, ROOM, '读书会');
  await recordRoom(host.events.use, OWNER_DM, 'owner 私聊');

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

  const service = () => host.approvals.use;
  /** 一条 WebUI 连接：握手，active 为真时上报在场 */
  const connect = async ({ identity = OWNER, active = true }: { identity?: typeof OWNER; active?: boolean } = {}) => {
    const c = client(host.sessionProtocol.use, { identity, surface: surfaces.webui });
    await c.init();
    if (active) await c.call('presence/update', { active: true });
    return c;
  };
  const request = (sessionId: string, over: Partial<ApprovalRequest> = {}, signal?: AbortSignal) => {
    const box: { outcome?: ApprovalOutcome } = {};
    const promise = service().request(
      {
        sessionId,
        origin: { kind: 'owner', ...OWNER },
        tool: 'exec',
        args: { command: 'ls' },
        rule: 'tool:exec 声明需确认',
        ...over,
      },
      signal,
    );
    void promise.then(outcome => {
      box.outcome = outcome;
    });
    return Object.assign(box, { promise });
  };
  /** 让排着的微任务跑完（不推进时钟） */
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const auditFile = join(state, 'audit', 'approvals.jsonl');
  /** 换回真时钟，等审计写到 n 条为止，回全部记录 */
  const audit = async (n: number) => {
    vi.useRealTimers();
    const read = () =>
      readFileSync(auditFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as AuditLine);
    await vi.waitFor(() => expect(read()).toHaveLength(n));
    return read();
  };
  let turnSeq = 0;
  /** 开一轮挂着，end 收尾；tool 发这一轮的工具调用事件 */
  const openTurn = (sessionId: string) => {
    const turnId = `turn-${++turnSeq}`;
    const message = { content: '<提问>', sessionId, ...OWNER };
    const release = deferred();
    const ended = host.hooks.use.run('agent:input:before', { message, turnId, metadata: {} }, () => release.promise);
    const tool = (phase: 'start' | 'end', callId: string, args: Record<string, unknown>, result?: string) =>
      host.events.use.emit('tool:execute', {
        sessionId,
        turnId,
        callId,
        platform: OWNER.platform,
        toolName: 'exec',
        args,
        phase,
        result,
      });
    return {
      turnId,
      tool,
      end: async () => {
        release.resolve();
        await ended;
      },
    };
  };
  return { app, host, sm, mine, surfaces, service, connect, request, flush, audit, auditFile, openTurn, infos };
}

/** 收到的审批推送 */
const pushed = (c: ReturnType<typeof client>) => c.notifications('approval/requested').map(p => p.approval);

const approve = (c: ReturnType<typeof client>, approval: Approval, note?: string) =>
  c.call('approval/respond', { approvalId: approval.id, decision: 'approve', contentHash: approval.contentHash, note });

describe('谁能产生审批：只有 owner 本人与 owner 链的延续', () => {
  const cases: Array<[string, OriginKind, typeof OWNER, 'card' | 'ineligible' | 'subtask']> = [
    ['owner 亲手发起', 'owner', OWNER, 'card'],
    ['owner 在 QQ 上亲手发起', 'owner', OWNER_QQ, 'card'],
    ['后台任务完成后的续做', 'owner-chain', OWNER, 'card'],
    ['类别写成 owner、主体却不是 owner', 'owner', MEMBER, 'ineligible'],
    ['类别写成续做、主体却不是 owner', 'owner-chain', MEMBER, 'ineligible'],
    ['子任务回合', 'subtask', OWNER, 'subtask'],
    // 哪些回合归 autonomous（定时任务回填了 owner 的授权身份、它触发的编排等）在 authority-origin.test.ts 里测
    ['自主回合', 'autonomous', OWNER, 'ineligible'],
    ['owner 在 WebUI 里驱动房间', 'room', OWNER, 'ineligible'],
    ['群成员发起', 'other', MEMBER, 'ineligible'],
  ];

  it.each(cases)('%s', async (_case, kind, who, expected) => {
    const { mine, connect, request, flush, service } = await setup();
    const c = await connect();
    const r = request(mine, { origin: { kind, ...who } });
    await flush();
    if (expected === 'card') {
      expect(pushed(c)).toHaveLength(1);
      expect(pushed(c)[0].origin).toEqual({ kind, ...who });
      expect(r.outcome).toBeUndefined();
      return;
    }
    // 立即结算，不推给任何面，也不出现在列表里
    expect(r.outcome).toMatchObject({ approved: false, source: expected });
    expect(pushed(c)).toEqual([]);
    expect(service().list()).toEqual([]);
    if (expected === 'subtask') {
      expect(r.outcome?.approved === false && r.outcome.message).toContain(
        '子任务里需要确认的操作不会转给 owner，请在发起它的会话里执行',
      );
    }
  });
});

describe('在场才问', () => {
  it('没人在场：立即按拒绝结算，调用方马上拿到原因，不推卡', async () => {
    const { mine, connect, request, flush } = await setup();
    // 连着但从没上报过活动，不算在场
    const idle = await connect({ active: false });
    const r = request(mine);
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(r.outcome?.approved === false && r.outcome.message).toContain('没人在场');
    expect(pushed(idle)).toEqual([]);
  });

  it('页面可见但 10 分钟没有键盘或指针活动：不在场；差一点不到 10 分钟仍在场', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    await vi.advanceTimersByTimeAsync(PRESENCE_MS - 1);
    const early = request(mine);
    await flush();
    expect(pushed(c)).toHaveLength(1);
    expect(early.outcome).toBeUndefined();
    await approve(c, pushed(c)[0]);

    await vi.advanceTimersByTimeAsync(1);
    const late = request(mine);
    await flush();
    expect(late.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(pushed(c)).toHaveLength(1);
  });

  it('页面转到后台（上报不在场）之后发起：按没人在场拒绝', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    await c.call('presence/update', { active: false });
    const r = request(mine);
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });
  });

  it('只推给在场的连接；不在场的连接变为在场时补推还没结的审批；结算只推给拿到过它的连接', async () => {
    const { mine, connect, request, flush } = await setup();
    const here = await connect();
    const away = await connect({ active: false });
    const idle = await connect({ active: false });
    request(mine);
    await flush();
    expect(pushed(here)).toHaveLength(1);
    expect(pushed(away)).toEqual([]);
    await away.call('presence/update', { active: true });
    expect(pushed(away)).toEqual(pushed(here));
    await approve(here, pushed(here)[0]);
    for (const c of [here, away]) expect(c.notifications('approval/settled')).toHaveLength(1);
    expect(idle.frames.filter(f => f.method?.startsWith('approval/'))).toEqual([]);
  });

  it('身份不是 owner 的连接：上报活动也不算在场，收不到推送，也撑不住等待中的审批', async () => {
    const { mine, connect, request, flush } = await setup();
    const stranger = await connect({ identity: MEMBER });
    const alone = request(mine);
    await flush();
    expect(alone.outcome).toMatchObject({ approved: false, source: 'absent' });

    const owner = await connect();
    const r = request(mine);
    await flush();
    await stranger.call('presence/update', { active: true });
    expect(pushed(owner)).toHaveLength(1);
    expect(pushed(stranger)).toEqual([]);
    await owner.call('presence/update', { active: false });
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(stranger.notifications('approval/settled')).toEqual([]);
  });

  it('等满 300 秒没人应答：按超时结算，状态 expired，推给拿到过它的连接', async () => {
    const { mine, connect, request } = await setup();
    const c = await connect();
    const r = request(mine);
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcome).toMatchObject({ approved: false, source: 'timeout' });
    expect(r.outcome?.approved === false && r.outcome.message).toContain('300 秒');
    expect(c.notifications('approval/settled')).toEqual([
      { approvalId: pushed(c)[0].id, state: 'expired', source: 'timeout', at: Date.now() },
    ]);
  });

  it('等待中最近一次活动满 10 分钟：从那一刻起等完宽限再结算，不等到 300 秒', async () => {
    const { mine, connect, request } = await setup();
    await connect();
    await vi.advanceTimersByTimeAsync(PRESENCE_MS - 60_000);
    const r = request(mine);
    await vi.advanceTimersByTimeAsync(60_000 + GRACE_MS - 1);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });
  });

  it('审批面的登记撤回（登记它的插件停用）：它的连接都不算在场，等待中的等完宽限后结算', async () => {
    const { app, mine, connect, request, flush } = await setup();
    await connect();
    const r = request(mine);
    await flush();
    const disabled = app.plugins.disable('@test/webui-surface');
    await vi.advanceTimersByTimeAsync(0);
    await disabled;
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });
  });
});

describe('重连宽限：在场的面全部消失之后再等 30 秒', () => {
  it('在场的连接全部断开后 30 秒内重连并重报在场：卡片仍在等并推给新连接，应答照常结算；只断开一条时照常等', async () => {
    const { mine, connect, request, flush } = await setup();
    const a = await connect();
    const b = await connect();
    const r = request(mine);
    await flush();
    a.conn.close();
    b.conn.close();
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(r.outcome).toBeUndefined();
    const back = await connect();
    expect(pushed(back)).toEqual(pushed(a));
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(r.outcome, '恢复在场之后宽限作废，不会到点结算').toBeUndefined();
    const other = await connect();
    other.conn.close();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(r.outcome, '还有在场的连接时断开一条不起宽限').toBeUndefined();
    await approve(back, pushed(back)[0]);
    await flush();
    expect(r.outcome).toMatchObject({ approved: true });
  });

  it('在场的连接全部断开满 30 秒没有恢复：按没人在场结算，推给拿到过它、还连着的连接', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const gone = await connect();
    const r = request(mine);
    await flush();
    await c.call('presence/update', { active: false });
    gone.conn.close();
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(r.outcome?.approved === false && r.outcome.message).toContain('没人在场');
    expect(c.notifications('approval/settled')).toEqual([
      { approvalId: pushed(c)[0].id, state: 'expired', source: 'absent', at: Date.now() },
    ]);
  });

  it('宽限不延长 300 秒总等待：快到时限时全部离开，到 300 秒照常按超时结算', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const r = request(mine);
    await flush();
    await vi.advanceTimersByTimeAsync(WAIT_MS - 10_000);
    await c.call('presence/update', { active: false });
    await vi.advanceTimersByTimeAsync(10_000 - 1);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcome).toMatchObject({ approved: false, source: 'timeout' });
  });

  it('宽限期内发起的新请求：发起时没人在场，仍立即拒绝；等着的那张照旧等', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const waiting = request(mine, { callId: 'call-1' });
    await flush();
    await c.call('presence/update', { active: false });
    const fresh = request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ } });
    await flush();
    expect(fresh.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(waiting.outcome).toBeUndefined();
  });

  it('宽限期内轮到的下一张卡：照常推出、一起等宽限；有面恢复在场就推给它', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const first = request(mine, { callId: 'call-1' });
    const second = request(mine, { callId: 'call-2' });
    await flush();
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1_000);
    await c.call('presence/update', { active: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.outcome).toMatchObject({ approved: false, source: 'timeout' });
    expect(second.outcome, '轮到它时没人在场，但还在宽限内').toBeUndefined();
    await c.call('presence/update', { active: true });
    expect(pushed(c).map(a => a.callId)).toEqual(['call-1', 'call-2']);
    await approve(c, pushed(c)[1]);
    await flush();
    expect(second.outcome).toMatchObject({ approved: true });
  });
});

describe('应答', () => {
  it('先答先得：第一个有效应答结算，后到的回 approval-settled；结算推给拿到过它的连接', async () => {
    const { mine, connect, request, flush } = await setup();
    const a = await connect();
    const b = await connect();
    const r = request(mine);
    await flush();
    const [approval] = pushed(a);
    expect(pushed(b)).toEqual([approval]);
    await approve(a, approval);
    await flush();
    expect(r.outcome).toEqual({ approvalId: approval.id, approved: true });
    const late = await b.fail('approval/respond', {
      approvalId: approval.id,
      decision: 'deny',
      contentHash: approval.contentHash,
    });
    expect(late.data?.code).toBe('approval-settled');
    for (const c of [a, b]) {
      expect(c.notifications('approval/settled')).toEqual([
        { approvalId: approval.id, state: 'approved', source: 'owner', at: Date.now() },
      ]);
    }
  });

  it('核验：哈希不符、id 不是本服务签发的、应答人不是 owner，都被拒且审批照旧等待', async () => {
    const { host, mine, connect, request, flush } = await setup();
    const owner = await connect();
    const stranger = await connect({ identity: MEMBER, active: false });
    const r = request(mine);
    await flush();
    const [approval] = pushed(owner);
    const answer = { approvalId: approval.id, decision: 'approve' as const, contentHash: approval.contentHash };

    expect((await owner.fail('approval/respond', { ...answer, contentHash: '0'.repeat(64) })).data?.code).toBe(
      'hash-mismatch',
    );
    expect((await owner.fail('approval/respond', { ...answer, approvalId: 'forged' })).data?.code).toBe('not-found');
    expect((await stranger.fail('approval/respond', answer)).data?.code).toBe('forbidden');
    // 所在审批面接不上审批服务的连接：回 unsupported
    const detached = client(host.sessionProtocol.use, { identity: OWNER, surface: DETACHED_SURFACE });
    await detached.init();
    expect((await detached.fail('approval/respond', answer)).data?.code).toBe('unsupported');
    await flush();
    expect(r.outcome).toBeUndefined();

    await owner.call('approval/respond', answer);
    await flush();
    expect(r.outcome).toMatchObject({ approved: true });
  });

  it('owner 拒绝并附说明：回给模型的话写明被 owner 拒绝与说明', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const r = request(mine);
    await flush();
    const [approval] = pushed(c);
    await c.call('approval/respond', {
      approvalId: approval.id,
      decision: 'deny',
      contentHash: approval.contentHash,
      note: '先备份再删',
    });
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source: 'owner' });
    const message = r.outcome?.approved === false ? r.outcome.message : '';
    expect(message).toContain('owner 拒绝');
    expect(message).toContain('先备份再删');
    expect(c.notifications('approval/settled')).toEqual([
      { approvalId: approval.id, state: 'denied', source: 'owner', at: Date.now() },
    ]);
  });
});

describe('排队与频率上限', () => {
  it('同一会话的并行两次调用同一时刻只出一张卡；后一张在前一张结算后推出，等待从推出时算起', async () => {
    const { mine, connect, request, flush, service } = await setup();
    const c = await connect();
    const first = request(mine, { callId: 'call-1' });
    const second = request(mine, { callId: 'call-2' });
    await flush();
    expect(pushed(c).map(a => a.callId)).toEqual(['call-1']);
    expect(service().list()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WAIT_MS - 1_000);
    await approve(c, pushed(c)[0]);
    await flush();
    expect(first.outcome).toMatchObject({ approved: true });
    expect(pushed(c)[1].callId).toBe('call-2');
    // 从第一次请求算已过了 300 秒，第二张仍在等；从它推出算满 300 秒才结算
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(second.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(second.outcome).toMatchObject({ approved: false, source: 'timeout' });
  });

  it('没人在场被拒的不计入频率上限', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect({ active: false });
    for (let i = 0; i < 12; i++) request(mine);
    await flush();
    await c.call('presence/update', { active: true });
    request(mine);
    await flush();
    expect(pushed(c)).toHaveLength(1);
  });

  it('排着、没推出就结算的（回合中止）不占额度', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const turn = new AbortController();
    for (let i = 0; i < 10; i++) request(mine, {}, turn.signal);
    await flush();
    expect(pushed(c)).toHaveLength(1);
    turn.abort();
    await flush();
    const next = request(mine);
    await flush();
    expect(next.outcome).toBeUndefined();
    expect(pushed(c)).toHaveLength(2);
  });

  it('不同会话之间并行：各出一张卡', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    request(mine);
    request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ } });
    await flush();
    expect(pushed(c).map(a => a.sessionId)).toEqual([mine, OWNER_DM]);
  });

  it('同一会话 10 分钟内最多 10 张卡：第 11 张直接拒绝并说明；窗口过去之后照常', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    for (let i = 0; i < 10; i++) {
      const r = request(mine);
      await flush();
      await approve(c, pushed(c)[i]);
      await flush();
      expect(r.outcome).toMatchObject({ approved: true });
    }
    const over = request(mine);
    await flush();
    expect(over.outcome).toMatchObject({ approved: false, source: 'rate-limit' });
    expect(over.outcome?.approved === false && over.outcome.message).toContain('上限');
    expect(pushed(c)).toHaveLength(10);
    // 别的会话不受影响
    request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ } });
    await flush();
    expect(pushed(c)).toHaveLength(11);

    await vi.advanceTimersByTimeAsync(PRESENCE_MS);
    await c.call('presence/update', { active: true });
    request(mine);
    await flush();
    expect(pushed(c)).toHaveLength(12);
  });
});

describe('结算', () => {
  it('回合中止：已推出的与还在排队的都按 cancelled 结算', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const abort = new AbortController();
    const shown = request(mine, {}, abort.signal);
    const queued = request(mine, {}, abort.signal);
    await flush();
    abort.abort();
    await flush();
    for (const r of [shown, queued]) expect(r.outcome).toMatchObject({ approved: false, source: 'turn-ended' });
    expect(c.notifications('approval/settled')).toEqual([
      { approvalId: pushed(c)[0].id, state: 'cancelled', source: 'turn-ended', at: Date.now() },
    ]);
    expect(pushed(c)).toHaveLength(1);
  });

  it('已中止的回合发起：不排队、不推卡，直接 cancelled', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    // 同一会话已有一张卡在等：中止了的请求也不排在它后面干等
    request(mine);
    const abort = new AbortController();
    abort.abort();
    const r = request(mine, {}, abort.signal);
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source: 'turn-ended' });
    expect(pushed(c)).toHaveLength(1);
  });

  it('回合结束时还没结的审批按 cancelled 结算', async () => {
    const { mine, connect, request, flush, openTurn } = await setup();
    await connect();
    const turn = openTurn(mine);
    const r = request(mine, { turnId: turn.turnId });
    const other = request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ }, turnId: 'another-turn' });
    await flush();
    await turn.end();
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source: 'turn-ended' });
    expect(other.outcome).toBeUndefined();
  });

  it('审批面的推送回调抛错：只影响它自己；本条照常结算、审计成对，同会话下一张照常推出、等满时限照常结算', async () => {
    const { mine, surfaces, connect, request, flush, audit } = await setup();
    const boom = () => {
      throw new Error('sink boom');
    };
    surfaces.webui.attend(OWNER, { requested: boom, settled: boom }).presence(true);
    const c = await connect();
    const first = request(mine, { callId: 'call-1' });
    const second = request(mine, { callId: 'call-2' });
    await flush();
    expect(pushed(c).map(a => a.callId)).toEqual(['call-1']);
    await approve(c, pushed(c)[0]);
    await flush();
    expect(first.outcome).toMatchObject({ approved: true });
    expect(pushed(c).map(a => a.callId)).toEqual(['call-1', 'call-2']);
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(second.outcome).toMatchObject({ approved: false, source: 'timeout' });
    const lines = await audit(4);
    expect(lines.map(line => line.type)).toEqual(['request', 'request', 'decision', 'decision']);
  });

  it('会话列表的推送出错（传输层发送抛错）：审批照常推出、等满时限照常结算', async () => {
    const { host, mine, connect, request, flush } = await setup();
    const c = await connect();
    const watcher = client(host.sessionProtocol.use, { identity: OWNER, surface: DETACHED_SURFACE });
    await watcher.init();
    await watcher.call('sessions/watch', {});
    watcher.frames.push = () => {
      throw new Error('send boom');
    };
    const r = request(mine);
    await flush();
    expect(pushed(c)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(r.outcome).toMatchObject({ approved: false, source: 'timeout' });
  });

  it('会话服务拆卸：没结的审批按 cancelled 结算并告诉模型；停用完成时审计已经写完', async () => {
    const { app, mine, connect, request, flush, auditFile } = await setup();
    await connect();
    const r = request(mine);
    await flush();
    vi.useRealTimers();
    await app.plugins.disable(sessionServerPlugin.name);
    expect(r.outcome).toMatchObject({ approved: false, source: 'shutdown' });
    expect(r.outcome?.approved === false && r.outcome.message).toContain('审批服务已停止');
    const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean);
    expect(lines.map(line => JSON.parse(line).type)).toEqual(['request', 'decision']);
  });
});

describe('回给模型的话', () => {
  it('owner 与 owner 链的请求写明被什么拦下、能不能再申请，owner 自己的 QQ 私聊也一样；房间里的回合不论什么原因都只有一句通用的拒绝', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect({ active: false });
    const message = (r: { outcome?: ApprovalOutcome }) => (r.outcome?.approved === false ? r.outcome.message : '');
    const absent = request(mine);
    const dmAbsent = request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ } });
    const roomIneligible = request(ROOM, { origin: { kind: 'room', ...OWNER } });
    const ended = new AbortController();
    ended.abort();
    const roomEnded = request(ROOM, { origin: { kind: 'room', ...OWNER_QQ } }, ended.signal);
    await flush();
    expect(message(absent)).toMatch(/原因：.*没人在场.*能否再申请：/);
    expect(message(dmAbsent)).toBe(message(absent));
    expect(message(roomIneligible)).toBe('需要批准的操作在这里不能执行。');
    expect(message(roomEnded)).toBe(message(roomIneligible));

    await c.call('presence/update', { active: true });
    const denied = request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ } });
    await flush();
    const [approval] = pushed(c);
    await c.call('approval/respond', {
      approvalId: approval.id,
      decision: 'deny',
      contentHash: approval.contentHash,
      note: '先备份再删',
    });
    await flush();
    expect(message(denied)).toMatch(/owner 拒绝了，说明：先备份再删.*能否再申请：/);
  });
});

describe('事实与内容哈希', () => {
  it('声明了命令的工具：命令与工作目录按声明逐字取自参数（含 ESC 与 U+202E），其余参数逐字列出', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const command = 'cat notes\u202Etxt.sh \u001b[2K; rm -rf ./build';
    const args = { command, cwd: 'workspace:/proj', timeout: 5000 };
    request(mine, { args });
    await flush();
    const [approval] = pushed(c);
    expect(approval.facts).toEqual({ command, cwd: 'workspace:/proj', params: { timeout: 5000 } });
  });

  it('声明了改文件的工具（file_edit、file_write、file_append）按声明的两侧生成 diff；路径或内容疑似含密钥时只给路径；没声明的不生成', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const facts = async (tool: string, args: Record<string, unknown>) => {
      const before = pushed(c).length;
      request(mine, { tool, args });
      await flush();
      const approval = pushed(c)[before];
      await approve(c, approval);
      await flush();
      return approval.facts;
    };
    expect(await facts('file_edit', { path: 'workspace:/a.md', oldText: '一\n二', newText: '三' })).toEqual({
      diff: { path: 'workspace:/a.md', patch: '-一\n-二\n+三' },
      params: {},
    });
    expect(await facts('file_write', { path: 'workspace:/b.md', content: '新文件\n第二行' })).toEqual({
      diff: { path: 'workspace:/b.md', patch: '+新文件\n+第二行' },
      params: {},
    });
    expect(
      await facts('file_append', { path: 'workspace:/log.md', content: 'token: ghp_abcdefghijklmnopqrstuvwxyz' }),
    ).toEqual({
      diff: { path: 'workspace:/log.md' },
      params: {},
    });
    expect(
      await facts('file_write', { path: 'workspace:/c.ts', content: 'const key = "sk-abcdefghijklmnopqrstuvwx";' }),
    ).toEqual({ diff: { path: 'workspace:/c.ts' }, params: {} });
    expect(
      await facts('file_edit', {
        path: 'workspace:/d.txt',
        oldText: 'x',
        newText: '-----BEGIN OPENSSH PRIVATE KEY-----',
      }),
    ).toEqual({ diff: { path: 'workspace:/d.txt' }, params: {} });
    expect(await facts('file_write', { path: 'workspace:/proj/.env.local', content: 'DEBUG=1' })).toEqual({
      diff: { path: 'workspace:/proj/.env.local' },
      params: {},
    });
    expect(await facts('file_delete', { path: 'workspace:/e.md' })).toEqual({ params: { path: 'workspace:/e.md' } });
  });

  it('没声明展示种类的工具：参数名叫 command、path 也不当命令与路径，全部参数逐字列出', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const args = { command: 'deploy', path: 'workspace:/x', content: '新内容', cwd: 'workspace:/' };
    request(mine, { tool: 'zz_custom', args });
    await flush();
    expect(pushed(c)[0].facts).toEqual({ params: args });
  });

  it('同样的请求内容哈希相同；参数、工具或调用不同哈希就不同', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const hash = async (over: Partial<ApprovalRequest>) => {
      const before = pushed(c).length;
      request(mine, over);
      await flush();
      const approval = pushed(c)[before];
      await approve(c, approval);
      await flush();
      return approval.contentHash;
    };
    const base = await hash({ callId: 'c1' });
    expect(await hash({ callId: 'c1' })).toBe(base);
    expect(await hash({ callId: 'c1', args: { command: 'ls -a' } })).not.toBe(base);
    expect(await hash({ callId: 'c1', tool: 'file_write' })).not.toBe(base);
    expect(await hash({ callId: 'c2' })).not.toBe(base);
  });
});

describe('审计', () => {
  it('每个请求都有成对的决定：应答人、登记身份的审批面、决定来源、命中的规则、等待时长', async () => {
    const { mine, connect, request, flush, audit } = await setup();
    const c = await connect();
    const approved = request(mine, { turnId: 't1', callId: 'c1' });
    await flush();
    await vi.advanceTimersByTimeAsync(1_234);
    await approve(c, pushed(c)[0]);
    const ineligible = request(mine, { origin: { kind: 'autonomous', ...OWNER } });
    await flush();
    await c.call('presence/update', { active: false });
    const absent = request(mine);
    await flush();

    const lines = await audit(6);
    const pair = (id: string) => lines.filter(line => line.id === id);
    const [request1, decision1] = pair(approved.outcome?.approvalId ?? '');
    expect(request1).toMatchObject({
      type: 'request',
      sessionId: mine,
      turnId: 't1',
      callId: 'c1',
      origin: { kind: 'owner', ...OWNER },
      tool: 'exec',
      facts: { command: 'ls', params: {} },
      rule: 'tool:exec 声明需确认',
    });
    expect(request1.contentHash).toBe(pushed(c)[0].contentHash);
    expect(decision1).toMatchObject({
      type: 'decision',
      state: 'approved',
      source: 'owner',
      responder: OWNER,
      surface: { name: 'webui', plugin: '@test/webui-surface' },
      waitedMs: 1_234,
    });
    expect(pair(ineligible.outcome?.approvalId ?? '').map(line => [line.type, line.source])).toEqual([
      ['request', undefined],
      ['decision', 'ineligible'],
    ]);
    const [, decision3] = pair(absent.outcome?.approvalId ?? '');
    expect(decision3).toMatchObject({ source: 'absent', state: 'expired', waitedMs: 0 });
    expect(decision3).not.toHaveProperty('responder');
  });

  it('审批面取登记身份：另一个插件登记的同名审批面在审计里是另一个身份', async () => {
    const { app, host, mine, request, audit } = await setup();
    const other: Record<string, ApprovalSurface> = {};
    vi.useRealTimers();
    await app.plugin(surfacePlugin('@test/other-surface', 'webui', other));
    await app.plugins.idle();
    const c = client(host.sessionProtocol.use, { identity: OWNER, surface: other.webui });
    await c.init();
    await c.call('presence/update', { active: true });
    request(mine);
    await vi.waitFor(() => expect(pushed(c)).toHaveLength(1));
    await approve(c, pushed(c)[0]);
    const lines = await audit(2);
    expect(lines[1]).toMatchObject({ surface: { name: 'webui', plugin: '@test/other-surface' } });
  });
});

describe('日志', () => {
  it('每个审批结算记一行 info：会话、工具、结局与原因；发起时就拒绝的（自主回合）也记', async () => {
    const { mine, connect, request, flush, infos } = await setup();
    const c = await connect();
    request(mine, { origin: { kind: 'autonomous', ...OWNER }, tool: 'file_write' });
    request(mine);
    await flush();
    await approve(c, pushed(c)[0]);
    request(mine);
    await flush();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(infos.filter(message => message.startsWith('审批'))).toEqual([
      `审批结算：会话 ${mine}，工具 file_write，拒绝（这一轮不是 owner 亲手发起的，不能产生审批）`,
      `审批结算：会话 ${mine}，工具 exec，批准（owner 应答）`,
      `审批结算：会话 ${mine}，工具 exec，过期（等了 300 秒没有人应答）`,
    ]);
  });
});

describe('审批面的登记', () => {
  it('进程内的审批面：审批服务不在时应答回 unavailable、上报在场不生效；服务上线后下一次上报接上，服务换了也一样', async () => {
    const { app, mine, surfaces, request } = await setup();
    const got: Approval[] = [];
    const attendance = surfaces.webui.attend(OWNER, { requested: a => void got.push(a), settled() {} });
    vi.useRealTimers();
    await app.plugins.disable(sessionServerPlugin.name);
    attendance.presence(true);
    expect(attendance.respond({ approvalId: 'x', decision: 'approve', contentHash: 'h' })).toMatchObject({
      ok: false,
      refusal: 'unavailable',
    });

    await app.plugins.enable(sessionServerPlugin.name);
    // 登记跟着提供者重挂（通知异步送达）：接上之前的应答仍回 unavailable，接上之后不认识的 id 回 not-found
    await vi.waitFor(() =>
      expect(attendance.respond({ approvalId: 'x', decision: 'approve', contentHash: 'h' })).toMatchObject({
        refusal: 'not-found',
      }),
    );
    attendance.presence(true);
    const r = request(mine);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(attendance.respond({ approvalId: got[0].id, decision: 'approve', contentHash: got[0].contentHash })).toEqual(
      {
        ok: true,
      },
    );
    await vi.waitFor(() => expect(r.outcome).toMatchObject({ approved: true }));
  });
});

describe('会话协议上的审批', () => {
  it('握手回登记的审批面名称', async () => {
    const { connect } = await setup();
    const c = await connect({ active: false });
    expect(c.frames.find(f => f.id === 1)?.result).toMatchObject({ surface: 'webui' });
  });

  it('会话列表：有未结审批的会话标「需要我处理」并排在「我的」区最前；房间的组记需要处理的数', async () => {
    const { sm, mine, connect, request, flush } = await setup();
    const c = await connect();
    await vi.advanceTimersByTimeAsync(1);
    const newer = (await sm.createSession({ name: '更新的' }, { createdFrom: 'webui' })).id;
    await c.call('sessions/watch', {});
    request(mine);
    request(OWNER_DM, { origin: { kind: 'owner', ...OWNER_QQ } });
    await flush();
    const page = await c.list();
    // 需要我处理的排在「我的」区最前，哪怕别的会话更新
    expect(page.sessions.map(s => s.id).slice(0, 2)).toEqual([mine, newer]);
    expect(Object.fromEntries(page.sessions.map(s => [s.id, s.attention]))).toEqual({
      [mine]: true,
      [newer]: false,
      [OWNER_DM]: true,
      [ROOM]: false,
    });
    expect(page.groups).toEqual([
      { platform: 'onebot', instance: 'onebot-a', label: 'onebot-a', rooms: 2, accounts: 1, attention: 1 },
    ]);
    const changed = c.notifications('sessions/changed').flatMap(n => n.upserts);
    expect(changed.filter(s => s.id === mine).at(-1)?.attention).toBe(true);

    for (const approval of pushed(c)) await approve(c, approval);
    await flush();
    expect((await c.summary(mine)).attention).toBe(false);
    expect(
      c
        .notifications('sessions/changed')
        .flatMap(n => n.upserts)
        .filter(s => s.id === mine)
        .at(-1)?.attention,
    ).toBe(false);
  });

  it('快照带这个会话未结的审批；工具卡挂上 approvalId、结算后带上结算（订阅着的连接收到重推），被拒的状态是 denied，结算写进工具结果的元数据', async () => {
    const { host, mine, connect, request, flush, openTurn } = await setup();
    const c = await connect();
    const early = await c.subscribe(mine);
    const turn = openTurn(mine);
    await turn.tool('start', 'call-1', { command: 'ls' });
    request(mine, { turnId: turn.turnId, callId: 'call-1' });
    await flush();
    const [approval] = pushed(c);
    const card = (items: SessionItem[]) => items.find(item => item.itemId === 'call-1');
    expect(card(c.timeline(mine, early))).toMatchObject({ status: 'running', approvalId: approval.id });

    const watcher = await connect({ active: false });
    const sub = await watcher.subscribe(mine);
    expect(sub.snapshot.approvals).toEqual([approval]);
    expect(card(sub.snapshot.items)).toMatchObject({ kind: 'tool-call', status: 'running', approvalId: approval.id });

    await c.call('approval/respond', { approvalId: approval.id, decision: 'deny', contentHash: approval.contentHash });
    await flush();
    const settlement = { state: 'denied', source: 'owner', at: Date.now() };
    expect(card(watcher.timeline(mine, sub)), '结算时工具卡带上结算再推一次').toMatchObject({
      status: 'denied',
      approvalId: approval.id,
      settlement,
    });
    // 结算随工具结果落库：agent 跑工具结果的钩子时，会话服务写进这次结果的元数据
    const after = {
      name: 'exec',
      result: '{"error":"需要 owner 批准的操作没有执行"}',
      toolCallContext: { sessionId: mine, turnId: turn.turnId, callId: 'call-1' },
      metadata: {} as Record<string, unknown>,
    };
    await host.hooks.use.run('agent:tool:after', after);
    expect(after.metadata).toEqual({ approval: { id: approval.id, ...settlement } });
    await turn.tool('end', 'call-1', { command: 'ls' }, '{"error":"需要 owner 批准的操作没有执行"}');
    expect(card(watcher.timeline(mine, sub))).toMatchObject({ status: 'denied', approvalId: approval.id, settlement });
    const again = await watcher.subscribe(mine);
    expect(again.snapshot.approvals).toEqual([]);
    await turn.end();
  });

  it.each([
    ['没人在场', 'owner', 'expired', 'absent'],
    ['发起者不能产生审批', 'autonomous', 'denied', 'ineligible'],
    ['子任务', 'subtask', 'denied', 'subtask'],
    ['超过频率上限', 'owner', 'denied', 'rate-limit'],
  ] as const)('发起时就结算（%s）：工具卡同样是 denied 并带结算，结算写进工具结果的元数据；不推卡、不算需要我处理', async (_case, kind, state, source) => {
    const { host, mine, connect, request, flush, openTurn } = await setup();
    const c = await connect({ active: source !== 'absent' });
    if (source === 'rate-limit') {
      for (let i = 0; i < 10; i++) {
        request(mine);
        await flush();
        await approve(c, pushed(c)[i]);
        await flush();
      }
    }
    const shownBefore = pushed(c).length;
    const sub = await c.subscribe(mine);
    const turn = openTurn(mine);
    await turn.tool('start', 'call-1', { command: 'ls' });
    const r = request(mine, { turnId: turn.turnId, callId: 'call-1', origin: { kind, ...OWNER } });
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source });
    const approvalId = r.outcome?.approvalId;
    const settlement = { state, source, at: Date.now() };
    const card = () => c.timeline(mine, sub).find(item => item.itemId === 'call-1');
    expect(card()).toMatchObject({ status: 'denied', approvalId, settlement });

    const denial = '{"error":"需要 owner 批准的操作没有执行"}';
    const after = {
      name: 'exec',
      result: denial,
      toolCallContext: { sessionId: mine, turnId: turn.turnId, callId: 'call-1' },
      metadata: {} as Record<string, unknown>,
    };
    await host.hooks.use.run('agent:tool:after', after);
    expect(after.metadata).toEqual({ approval: { id: approvalId, ...settlement } });
    await turn.tool('end', 'call-1', { command: 'ls' }, denial);
    expect(card()).toMatchObject({ status: 'denied', approvalId, settlement });
    expect(pushed(c)).toHaveLength(shownBefore);
    expect((await c.summary(mine)).attention).toBe(false);
    await turn.end();
  });

  it('批准的工具卡照常按结果收尾', async () => {
    const { mine, connect, request, flush, openTurn } = await setup();
    const c = await connect();
    const sub = await c.subscribe(mine);
    const turn = openTurn(mine);
    await turn.tool('start', 'call-1', { command: 'ls' });
    request(mine, { turnId: turn.turnId, callId: 'call-1' });
    await flush();
    await approve(c, pushed(c)[0]);
    await flush();
    await turn.tool('end', 'call-1', { command: 'ls' }, 'a.txt');
    expect(c.timeline(mine, sub).find(item => item.itemId === 'call-1')).toMatchObject({
      status: 'completed',
      settlement: { state: 'approved', source: 'owner', at: Date.now() },
    });
    await turn.end();
  });

  it('事件：推出时发 approval:created，结算时发 approval:settled（带结局）；没推出就结算的不发', async () => {
    const { host, mine, connect, request, flush } = await setup();
    const c = await connect();
    const seen: Array<[string, string]> = [];
    host.events.use.on('approval:created', approval => void seen.push(['created', approval.state]));
    host.events.use.on('approval:settled', approval => void seen.push(['settled', approval.state]));
    request(mine, { origin: { kind: 'autonomous', ...OWNER } });
    request(mine);
    await flush();
    await approve(c, pushed(c)[0]);
    await flush();
    expect(seen).toEqual([
      ['created', 'pending'],
      ['settled', 'approved'],
    ]);
  });
});
