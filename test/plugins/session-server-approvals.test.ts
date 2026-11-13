import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Approval,
  type ApprovalAttendance,
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalSurface,
  approvals,
  type OriginKind,
} from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { events } from '../../packages/api-events/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, type Logger, optional, provide } from '../../packages/core/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
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
/** 会话协议里写成说话人的 owner：结算的应答人 */
const OWNER_SPEAKER = { ...OWNER, owner: true };
/** owner 在 QQ 上的账号：配置里的 owner */
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const MEMBER = { platform: 'onebot', userId: '30001' };
/** 机器人账号 */
const SELF = '10000';
const ROOM = `onebot:${SELF}:group:20001`;
/** 同一个群，经另一个机器人账号 */
const ROOM_OTHER_BOT = 'onebot:10001:group:20001';
/** owner 与机器人的 QQ 私聊：会话列表里归在房间 */
const OWNER_DM = `onebot:${SELF}:private:99999`;

const WAIT_MS = 300_000;
const PRESENCE_MS = 10 * 60_000;
/** 在场的面全部消失之后的重连宽限 */
const GRACE_MS = 30_000;

/** 发起回合的类别与参与者：这一轮只有 who 一个人 */
const originOf = (kind: OriginKind, who: { platform: string; userId: string }) => ({ kind, participants: [who] });

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
  const app = new App({ logLevel: 'error', logger });
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
  await app.plugin(
    adapterPlugin('onebot-a', {
      platform: 'onebot',
      canHandle: id => id.startsWith(`onebot:${SELF}:`) || id.startsWith('onebot:10001:'),
    }),
  );
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
        origin: originOf('hand', OWNER),
        tool: 'exec',
        args: { command: 'ls' },
        rule: 'tool:exec 声明需确认',
        canAnswer: who => isOwner(who.platform, who.userId),
        ownerOnly: true,
        ...over,
      },
      signal,
    );
    void promise.then(outcome => {
      box.outcome = outcome;
    });
    return Object.assign(box, { promise });
  };
  /** 让排着的微任务执行完毕（不推进时钟） */
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
  /** 开一轮一直不结束，end 收尾；tool 发这一轮的工具调用事件 */
  const openTurn = (sessionId: string) => {
    const turnId = `turn-${++turnSeq}`;
    const message = { content: '<提问>', sessionId, ...OWNER };
    const release = deferred();
    const ended = host.hooks.use.run(
      'agent:turn:before',
      { turnId, sessionId: message.sessionId, inputs: [{ message }] },
      () => release.promise,
    );
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

describe('谁能产生审批：这一轮里有 owner 的话（人亲手发起，含它的续做与派出的子任务）', () => {
  const cases: Array<[string, OriginKind, typeof OWNER, 'card' | 'ineligible']> = [
    ['owner 亲手发起', 'hand', OWNER, 'card'],
    ['owner 在 QQ 上亲手发起', 'hand', OWNER_QQ, 'card'],
    ['群成员亲手发起', 'hand', MEMBER, 'ineligible'],
    // 哪些回合归 autonomous（定时任务回填了 owner 的授权身份、它触发的编排、它们派的子任务等）在 authority-origin.test.ts 里测
    ['自主回合', 'autonomous', OWNER, 'ineligible'],
  ];

  it.each(cases)('%s', async (_case, kind, who, expected) => {
    const { mine, connect, request, flush, service } = await setup();
    const c = await connect();
    const r = request(mine, { origin: originOf(kind, who) });
    await flush();
    if (expected === 'card') {
      expect(pushed(c)).toHaveLength(1);
      expect(pushed(c)[0].origin).toEqual(originOf(kind, who));
      expect(r.outcome).toBeUndefined();
      return;
    }
    // 立即结算，不推给任何面，也不出现在列表里
    expect(r.outcome).toMatchObject({ approved: false, source: expected });
    expect(pushed(c)).toEqual([]);
    expect(service().list()).toEqual([]);
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

  it('推给它、还没结的卡让它一直算在场：推出之后不再上报活动（如终端不按键），最近一次活动满 10 分钟之后在场重算也不进宽限，卡等满 300 秒', async () => {
    const { mine, connect, request } = await setup();
    await connect();
    await vi.advanceTimersByTimeAsync(PRESENCE_MS - 60_000);
    const r = request(mine);
    await vi.advanceTimersByTimeAsync(61_000);
    // 别的连接接入又断开：在场按此刻重算一次，此刻已过了最近一次活动起的 10 分钟（不压在边界上）
    const other = await connect();
    other.conn.close();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WAIT_MS - 61_000 - GRACE_MS - 1);
    expect(r.outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(r.outcome).toMatchObject({ approved: false, source: 'timeout' });
  });

  it('推着的卡让它在场时，别的会话发起的同样推给它；都结了回到最近一次活动起 10 分钟', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    request(mine);
    await flush();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const later = request(ROOM, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    expect(later.outcome).toBeUndefined();
    expect(pushed(c).map(a => a.sessionId)).toEqual([mine, ROOM]);
    for (const approval of pushed(c)) await approve(c, approval);
    await flush();
    const after = request(mine);
    await flush();
    expect(after.outcome).toMatchObject({ approved: false, source: 'absent' });
  });

  it('上报离开后，推给它还没结的卡对它算没收到：不再因它算在场，变为在场时补推同一张，结算照旧通知它', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const r = request(mine);
    await flush();
    await c.call('presence/update', { active: false });
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(r.outcome).toBeUndefined();
    await c.call('presence/update', { active: true });
    const [first, again] = pushed(c);
    // 补推的是同一张：客户端按 id 收，不重复
    expect(again).toEqual(first);
    await approve(c, again);
    await flush();
    expect(r.outcome).toMatchObject({ approved: true });
    expect(c.notifications('approval/settled')).toEqual([
      { approvalId: first.id, state: 'approved', source: 'answer', at: Date.now(), by: OWNER_SPEAKER },
    ]);
  });

  it('报某一张没送到：只这一张对它算没收到、不因它在场，宽限过后按没人在场结；推给它的别的卡照旧；变为在场时只补推这一张', async () => {
    const { mine, surfaces, request, flush } = await setup();
    const got: Approval[] = [];
    const attendance = surfaces.webui.attend(OWNER, { requested: a => void got.push(a), settled() {} });
    attendance.presence(true);
    const a = request(mine);
    const b = request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    const [first, second] = got;
    attendance.undelivered(second.id);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    attendance.presence(true);
    expect(got.map(approval => approval.id)).toEqual([first.id, second.id, second.id]);
    attendance.undelivered(second.id);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(b.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(a.outcome).toBeUndefined();
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
    expect(r.outcome, '还有在场的连接时断开一条不开始宽限').toBeUndefined();
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
    const fresh = request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
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

describe('限定机器人账号的接入', () => {
  it('只算、只收、只能应答参与者里有它、且经这个机器人账号的审批：WebUI 发起的、往群里插话的、经别的账号的都不归它', async () => {
    const { host, mine, surfaces, connect, request, flush } = await setup();
    await recordRoom(host.events.use, ROOM_OTHER_BOT, '读书会');
    const got: Approval[] = [];
    const dm = surfaces.webui.attend(OWNER_QQ, { requested: a => void got.push(a), settled() {} }, { selfId: SELF });
    dm.presence(true);
    const fromWebui = request(mine);
    const intoRoom = request(ROOM, { callId: 'from-webui' });
    const otherBot = request(ROOM_OTHER_BOT, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    for (const r of [fromWebui, intoRoom, otherBot])
      expect(r.outcome).toMatchObject({ approved: false, source: 'absent' });

    // 她经这个账号发起的，群里与私聊里一样
    request(ROOM, { origin: originOf('hand', OWNER_QQ) });
    request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    expect(got.map(a => a.sessionId)).toEqual([ROOM, OWNER_DM]);

    // 有别的面在场时，不归它的照常推给那边；它再报在场，补推也只补归它的
    const c = await connect();
    request(mine);
    await flush();
    dm.presence(true);
    expect(pushed(c).map(a => a.sessionId)).toEqual([ROOM, OWNER_DM, mine]);
    expect(got.map(a => a.sessionId)).toEqual([ROOM, OWNER_DM]);
    const [web] = pushed(c).filter(a => a.sessionId === mine);
    const answer = { approvalId: web.id, decision: 'approve' as const, contentHash: web.contentHash };
    expect(dm.respond(answer)).toMatchObject({ ok: false, refusal: 'not-found' });
  });

  it('宽限按会话算：别的会话在宽限里，不让本会话没有覆盖的下一张推出，它当场按不在场结算', async () => {
    const { mine, surfaces, service, connect, request, flush } = await setup();
    const c = await connect();
    const waiting = request(mine);
    await flush();
    await c.call('presence/update', { active: false });
    // 私聊的接入在结算回调里上报离开
    const dm: { attendance?: ApprovalAttendance } = {};
    dm.attendance = surfaces.webui.attend(
      OWNER_QQ,
      { requested() {}, settled: () => dm.attendance?.presence(false) },
      { selfId: SELF },
    );
    dm.attendance.presence(true);
    const origin = originOf('hand', OWNER_QQ);
    const first = request(OWNER_DM, { origin, callId: 'call-1' });
    const second = request(OWNER_DM, { origin, callId: 'call-2' });
    await flush();
    const [approval] = service().list({ sessionId: OWNER_DM });
    dm.attendance.respond({ approvalId: approval.id, decision: 'approve', contentHash: approval.contentHash });
    await flush();
    expect(first.outcome).toMatchObject({ approved: true });
    expect(second.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(service().list({ sessionId: OWNER_DM })).toEqual([]);
    expect(waiting.outcome, 'mine 的宽限照旧').toBeUndefined();
  });

  it('宽限按会话起算：两个会话先后没了覆盖，各自从没了覆盖那一刻等满 30 秒', async () => {
    const { mine, surfaces, request, flush } = await setup();
    const sink = { requested() {}, settled() {} };
    const web = surfaces.webui.attend(OWNER, sink);
    web.presence(true);
    const dm = surfaces.webui.attend(OWNER_QQ, sink, { selfId: SELF });
    dm.presence(true);
    const early = request(mine);
    const late = request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    web.presence(false);
    await vi.advanceTimersByTimeAsync(10_000);
    dm.presence(false);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 10_000);
    expect(early.outcome).toMatchObject({ approved: false, source: 'absent' });
    expect(late.outcome, 'DM 晚 10 秒没了覆盖，还在它自己的宽限里').toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(late.outcome).toMatchObject({ approved: false, source: 'absent' });
  });

  it('应答已经结了的审批回 approval-settled，不论接入覆盖不覆盖它', async () => {
    const { mine, surfaces, connect, request, flush } = await setup();
    const c = await connect();
    const dm = surfaces.webui.attend(OWNER_QQ, { requested() {}, settled() {} }, { selfId: SELF });
    dm.presence(true);
    const r = request(mine);
    await flush();
    const [approval] = pushed(c);
    await approve(c, approval);
    await flush();
    expect(r.outcome).toMatchObject({ approved: true });
    const answer = { approvalId: approval.id, decision: 'approve' as const, contentHash: approval.contentHash };
    expect(dm.respond(answer)).toMatchObject({ ok: false, refusal: 'approval-settled' });
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
    expect(r.outcome).toEqual({ approvalId: approval.id, approved: true, by: OWNER });
    const late = await b.fail('approval/respond', {
      approvalId: approval.id,
      decision: 'deny',
      contentHash: approval.contentHash,
    });
    expect(late.data?.code).toBe('approval-settled');
    for (const c of [a, b]) {
      expect(c.notifications('approval/settled')).toEqual([
        { approvalId: approval.id, state: 'approved', source: 'answer', at: Date.now(), by: OWNER_SPEAKER },
      ]);
    }
  });

  it('核验：哈希不符、id 不是本服务签发的、应答人不能批这一张，都被拒且审批照旧等待', async () => {
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

  it('owner 拒绝并附说明：回给模型的话写明被拒绝与说明', async () => {
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
    expect(r.outcome).toMatchObject({ approved: false, source: 'answer' });
    const message = r.outcome?.approved === false ? r.outcome.message : '';
    expect(message).toContain('被拒绝了，说明：「先备份再删」。');
    expect(c.notifications('approval/settled')).toEqual([
      { approvalId: approval.id, state: 'denied', source: 'answer', at: Date.now(), by: OWNER_SPEAKER },
    ]);
  });
});

describe('排队与频率上限', () => {
  it('同一会话的并行两次调用同一时刻只出一张卡；后一张在前一张结算后推出，等待与审批对象的到期时刻都从推出时算起', async () => {
    const { mine, connect, request, flush, service } = await setup();
    const c = await connect();
    const first = request(mine, { callId: 'call-1' });
    const second = request(mine, { callId: 'call-2' });
    await flush();
    expect(pushed(c).map(a => a.callId)).toEqual(['call-1']);
    expect(pushed(c)[0].expiresAt).toBe(Date.now() + WAIT_MS);
    expect(service().list()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(WAIT_MS - 1_000);
    await approve(c, pushed(c)[0]);
    await flush();
    expect(first.outcome).toMatchObject({ approved: true });
    expect(pushed(c)[1]).toMatchObject({ callId: 'call-2', expiresAt: Date.now() + WAIT_MS });
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

  it('排着、没推出就结算的（回合中止）不占额度：子会话里排着的退还给它的会话树', async () => {
    const { sm, mine, connect, request, flush } = await setup();
    const c = await connect();
    const child = (await sm.createChildSession(mine)).id;
    const turn = new AbortController();
    for (let i = 0; i < 10; i++) request(child, {}, turn.signal);
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
    request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
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
    request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    expect(pushed(c)).toHaveLength(11);

    await vi.advanceTimersByTimeAsync(PRESENCE_MS);
    await c.call('presence/update', { active: true });
    request(mine);
    await flush();
    expect(pushed(c)).toHaveLength(12);
  });

  it('参与者审批与只有 owner 能批的各占一份额度：参与者审批用满 10 张，第 11 张参与者审批拒，只有 owner 能批的照常推出', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect();
    const participant = { origin: { kind: 'hand' as const, participants: [OWNER, MEMBER] }, ownerOnly: false };
    for (let i = 0; i < 10; i++) {
      request(mine, participant);
      await flush();
      await approve(c, pushed(c)[i]);
      await flush();
    }
    const over = request(mine, participant);
    await flush();
    expect(over.outcome).toMatchObject({ approved: false, source: 'rate-limit' });
    const owner = request(mine);
    await flush();
    expect(owner.outcome).toBeUndefined();
    expect(pushed(c)).toHaveLength(11);
  });
});

describe('子会话里的审批：按会话树', () => {
  it('推出的审批对象带来源链：根会话以下到所在会话的各级子会话的 id 与标题（没取名的是默认名，WebUI 收到渲染好的文字）；根会话的没有；审计的请求行带同一份', async () => {
    const { sm, connect, request, flush, audit } = await setup();
    const c = await connect();
    const named = await sm.createChildSession(ROOM, { name: '整理资料' });
    const grand = await sm.createChildSession(named.id, { name: '细分' });
    const unnamed = await sm.createChildSession(ROOM);
    const origin = originOf('hand', OWNER_QQ);
    for (const sessionId of [ROOM, named.id, grand.id, unnamed.id]) request(sessionId, { origin });
    await flush();
    const bySession = new Map(pushed(c).map(approval => [approval.sessionId, approval]));
    expect(bySession.get(ROOM)).not.toHaveProperty('chain');
    expect(bySession.get(named.id)?.chain).toEqual([{ id: named.id, title: '整理资料' }]);
    expect(bySession.get(grand.id)?.chain).toEqual([
      { id: named.id, title: '整理资料' },
      { id: grand.id, title: '细分' },
    ]);
    const [fallback] = bySession.get(unnamed.id)?.chain ?? [];
    expect(fallback.id).toBe(unnamed.id);
    expect(fallback.title).toMatch(/^子任务 \S/);

    const lines = await audit(4);
    const requested = (sessionId: string) =>
      lines.find(line => line.type === 'request' && line.sessionId === sessionId);
    expect(requested(named.id)?.chain).toEqual([{ id: named.id, title: '整理资料' }]);
    expect(requested(ROOM)).not.toHaveProperty('chain');
  });

  it('限定机器人账号的接入按根会话的账号认：子会话里只有 owner 能批的推到根会话经这个账号的私聊接入，另一个账号的根会话下的不推', async () => {
    const { host, sm, surfaces, request, flush } = await setup();
    await recordRoom(host.events.use, ROOM_OTHER_BOT, '读书会');
    const dm: Approval[] = [];
    surfaces.webui.attend(OWNER_QQ, { requested: a => void dm.push(a), settled() {} }, { selfId: SELF }).presence(true);
    const child = (await sm.createChildSession(ROOM)).id;
    const otherBotChild = (await sm.createChildSession(ROOM_OTHER_BOT)).id;
    request(child, { origin: originOf('hand', OWNER_QQ), callId: 'same-bot' });
    request(otherBotChild, { origin: originOf('hand', OWNER_QQ), callId: 'other-bot' });
    await flush();
    expect(dm.map(a => a.callId)).toEqual(['same-bot']);
  });

  it('队列按会话：根会话与它的子会话同时各请求一张，两张都推出，不互相排队', async () => {
    const { sm, connect, request, flush } = await setup();
    const c = await connect();
    const child = (await sm.createChildSession(ROOM)).id;
    const origin = originOf('hand', OWNER_QQ);
    request(ROOM, { origin });
    request(child, { origin });
    await flush();
    expect(pushed(c).map(a => a.sessionId)).toEqual([ROOM, child]);
  });

  it('频率上限按根会话：根会话连同各级子会话 10 分钟内合计 10 张，第 11 张不论发在哪一级都拒并写明会话树；别的会话照常，窗口过去之后照常', async () => {
    const { sm, connect, request, flush } = await setup();
    const c = await connect();
    const first = (await sm.createChildSession(ROOM)).id;
    const second = (await sm.createChildSession(ROOM)).id;
    const origin = originOf('hand', OWNER_QQ);
    const spread = [ROOM, ROOM, ROOM, ROOM, first, first, first, second, second, second];
    for (const [i, sessionId] of spread.entries()) {
      const r = request(sessionId, { origin });
      await flush();
      await approve(c, pushed(c)[i]);
      await flush();
      expect(r.outcome).toMatchObject({ approved: true });
    }
    for (const sessionId of [ROOM, first]) {
      const over = request(sessionId, { origin });
      await flush();
      expect(over.outcome).toMatchObject({ approved: false, source: 'rate-limit' });
      expect(over.outcome?.approved === false && over.outcome.message).toContain('会话树');
    }
    request(OWNER_DM, { origin });
    await flush();
    expect(pushed(c).at(-1)?.sessionId).toBe(OWNER_DM);

    await vi.advanceTimersByTimeAsync(PRESENCE_MS);
    await c.call('presence/update', { active: true });
    const later = request(second, { origin });
    await flush();
    expect(later.outcome).toBeUndefined();
    expect(pushed(c).at(-1)?.sessionId).toBe(second);
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
    // 同一会话已有一张卡在等：中止了的请求也不排在它后面空等
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
    const other = request(OWNER_DM, { origin: originOf('hand', OWNER_QQ), turnId: 'another-turn' });
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
  it('写明被什么拦下、能不能再申请，不论在哪个会话发起；只有不能产生审批的那句点到 owner，其余不指名应答人', async () => {
    const { mine, connect, request, flush } = await setup();
    const c = await connect({ active: false });
    const message = (r: { outcome?: ApprovalOutcome }) => (r.outcome?.approved === false ? r.outcome.message : '');
    const absent = request(mine);
    const roomAbsent = request(ROOM, { origin: originOf('hand', OWNER_QQ) });
    const ineligible = request(ROOM, { origin: originOf('hand', MEMBER) });
    const ended = new AbortController();
    ended.abort();
    const roomEnded = request(ROOM, { origin: originOf('hand', OWNER_QQ) }, ended.signal);
    await flush();
    expect(message(absent)).toBe(
      '需要批准的操作没有执行。原因：没人在场，没有人能批准。能否再申请：有能批的人在场时可以再申请；不要换别的办法绕过，先说明需要批准什么。',
    );
    expect(message(roomAbsent)).toBe(message(absent));
    expect(message(ineligible)).toBe(
      '需要批准的操作没有执行。原因：这一轮里没有 owner 的话，要 owner 确认的操作不能执行。能否再申请：不能；不要换别的办法绕过。',
    );
    expect(message(roomEnded)).toMatch(/原因：发起它的回合已结束.*能否再申请：/);
    for (const r of [absent, roomAbsent, roomEnded]) expect(message(r)).not.toContain('owner');

    await c.call('presence/update', { active: true });
    const denied = request(ROOM, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    const [approval] = pushed(c);
    await c.call('approval/respond', {
      approvalId: approval.id,
      decision: 'deny',
      contentHash: approval.contentHash,
      note: '先备份再删',
    });
    await flush();
    expect(message(denied)).toMatch(/被拒绝了，说明：「先备份再删」。能否再申请：/);
    expect(message(denied)).not.toContain('owner');
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

  it('声明了改文件的工具（file_edit、file_write、file_append）按声明的两侧生成 diff，内容像密钥、改的是 .env 也照给；没声明的不生成', async () => {
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
      await facts('file_write', { path: 'workspace:/c.ts', content: 'const key = "sk-abcdefghijklmnopqrstuvwx";' }),
    ).toEqual({ diff: { path: 'workspace:/c.ts', patch: '+const key = "sk-abcdefghijklmnopqrstuvwx";' }, params: {} });
    expect(await facts('file_append', { path: 'workspace:/proj/.env.local', content: 'DEBUG=1' })).toEqual({
      diff: { path: 'workspace:/proj/.env.local', patch: '+DEBUG=1' },
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
    const ineligible = request(mine, { origin: originOf('autonomous', OWNER) });
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
      origin: originOf('hand', OWNER),
      tool: 'exec',
      facts: { command: 'ls', params: {} },
      rule: 'tool:exec 声明需确认',
    });
    expect(request1.contentHash).toBe(pushed(c)[0].contentHash);
    expect(decision1).toMatchObject({
      type: 'decision',
      state: 'approved',
      source: 'answer',
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
    request(mine, { origin: originOf('autonomous', OWNER), tool: 'file_write' });
    request(mine);
    await flush();
    await approve(c, pushed(c)[0]);
    request(mine);
    await flush();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(infos.filter(message => message.startsWith('审批'))).toEqual([
      `审批结算：会话 ${mine}，工具 file_write，拒绝（这一轮里没有 owner 的话，要 owner 确认的操作不能执行）`,
      `审批结算：会话 ${mine}，工具 exec，批准（有人应答）`,
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
    await app.plugins.idle();
    // 登记跟着提供者重挂，idle() 放行时已接上：不认识的 id 回 not-found
    expect(attendance.respond({ approvalId: 'x', decision: 'approve', contentHash: 'h' })).toMatchObject({
      refusal: 'not-found',
    });
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
    request(OWNER_DM, { origin: originOf('hand', OWNER_QQ) });
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

  it('子会话里有未结的审批：各级父会话同样标「需要我处理」，排在「我的」区最前；房间的组按房间连同它的子会话计；都批掉之后两处都回落', async () => {
    const { sm, mine, connect, request, flush } = await setup();
    const c = await connect();
    const mineChild = (await sm.createChildSession(mine, { name: '子任务' })).id;
    const roomChild = (await sm.createChildSession(ROOM, { name: '房间的子任务' })).id;
    await vi.advanceTimersByTimeAsync(1);
    const newer = (await sm.createSession({ name: '更新的' }, { createdFrom: 'webui' })).id;
    await c.call('sessions/watch', {});
    request(mineChild);
    request(roomChild, { origin: originOf('hand', OWNER_QQ) });
    await flush();
    const page = await c.list();
    expect(page.sessions.map(s => s.id).slice(0, 2)).toEqual([mine, newer]);
    expect(Object.fromEntries(page.sessions.map(s => [s.id, s.attention]))).toEqual({
      [mine]: true,
      [newer]: false,
      [OWNER_DM]: false,
      [ROOM]: true,
    });
    expect(page.groups.map(group => group.attention)).toEqual([1]);
    /** 最近一次推送的 mine 的摘要标没标需要我处理 */
    const pushedAttention = () =>
      c
        .notifications('sessions/changed')
        .flatMap(n => n.upserts)
        .findLast(s => s.id === mine)?.attention;
    expect(pushedAttention()).toBe(true);
    const children = await c.list({ parentId: mine });
    expect(children.sessions.map(s => [s.id, s.attention])).toEqual([[mineChild, true]]);

    for (const approval of pushed(c)) await approve(c, approval);
    await flush();
    expect((await c.summary(mine)).attention).toBe(false);
    expect((await c.summary(ROOM)).attention).toBe(false);
    expect((await c.list()).groups.map(group => group.attention)).toEqual([0]);
    expect(pushedAttention()).toBe(false);
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
    const settlement = { state: 'denied', source: 'answer', at: Date.now(), by: OWNER_SPEAKER };
    expect(card(watcher.timeline(mine, sub)), '结算时工具卡带上结算再推一次').toMatchObject({
      status: 'denied',
      approvalId: approval.id,
      settlement,
    });
    // 结算随工具结果落库：agent 跑工具结果的钩子时，会话服务写进这次结果的元数据
    const after = {
      name: 'exec',
      result: '{"error":"需要批准的操作没有执行"}',
      toolCallContext: { sessionId: mine, participants: [OWNER], turnId: turn.turnId, callId: 'call-1' },
      metadata: {} as Record<string, unknown>,
    };
    await host.hooks.use.run('agent:tool:after', after);
    expect(after.metadata).toEqual({ approval: { id: approval.id, ...settlement } });
    await turn.tool('end', 'call-1', { command: 'ls' }, '{"error":"需要批准的操作没有执行"}');
    expect(card(watcher.timeline(mine, sub))).toMatchObject({ status: 'denied', approvalId: approval.id, settlement });
    const again = await watcher.subscribe(mine);
    expect(again.snapshot.approvals).toEqual([]);
    await turn.end();
  });

  it.each([
    ['没人在场', 'hand', 'expired', 'absent'],
    ['发起者不能产生审批', 'autonomous', 'denied', 'ineligible'],
    ['超过频率上限', 'hand', 'denied', 'rate-limit'],
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
    const r = request(mine, { turnId: turn.turnId, callId: 'call-1', origin: originOf(kind, OWNER) });
    await flush();
    expect(r.outcome).toMatchObject({ approved: false, source });
    const said = r.outcome?.approved === false ? r.outcome.message : '';
    expect(said.includes('owner'), '只有不能产生审批的那句点到 owner').toBe(source === 'ineligible');
    const approvalId = r.outcome?.approvalId;
    const settlement = { state, source, at: Date.now() };
    const card = () => c.timeline(mine, sub).find(item => item.itemId === 'call-1');
    expect(card()).toMatchObject({ status: 'denied', approvalId, settlement });

    const denial = '{"error":"需要批准的操作没有执行"}';
    const after = {
      name: 'exec',
      result: denial,
      toolCallContext: { sessionId: mine, participants: [OWNER], turnId: turn.turnId, callId: 'call-1' },
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
      settlement: { state: 'approved', source: 'answer', at: Date.now(), by: OWNER_SPEAKER },
    });
    await turn.end();
  });

  it('事件：推出时发 approval:created，结算时发 approval:settled（带结局）；没推出就结算的不发', async () => {
    const { host, mine, connect, request, flush } = await setup();
    const c = await connect();
    const seen: Array<[string, string]> = [];
    host.events.use.on('approval:created', approval => void seen.push(['created', approval.state]));
    host.events.use.on('approval:settled', approval => void seen.push(['settled', approval.state]));
    request(mine, { origin: originOf('autonomous', OWNER) });
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
