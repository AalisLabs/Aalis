import { afterEach, describe, expect, it } from 'vitest';
import {
  book,
  canStart,
  dayKey,
  daySpend,
  paperBudgetUsage,
  reserveFor,
} from '../../packages/plugin-paper/src/budget.js';
import type { PaperLedger, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import { emptyLedger, human, PILOT_ROOM, ROOM, startPaperHub, stopPaperHubs } from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的每日上限：全局、白纸、房间与按人金额均可不填，不填即不增加该层限制；
// 显式 0 禁开新任务，写坏按 0 拒绝。已花费加上所有进行中的预留加本次预留不能超过已设上限。
// 每人每天件数另行可选；每天按 budgetTimeZone 的 0 点换日。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const DAY = '2026-09-27';
const ROOM_KEY = ROOM;
const USER = 'onebot:30001';

/** 当天某房间、某人已花费若干（美分）并受理若干件 */
function spent(ledger: PaperLedger, opts: { global?: number; room?: number; user?: number; tasks?: number }) {
  ledger.spend[DAY] = {
    global: opts.global ?? opts.room ?? 0,
    rooms: { [ROOM_KEY]: opts.room ?? 0 },
    users: { [USER]: { cents: opts.user ?? 0, tasks: opts.tasks ?? 0 } },
  };
  return ledger;
}

const limits = (over: Partial<Parameters<typeof canStart>[5]> = {}) => ({
  globalCents: 10_000,
  roomCents: 500,
  userCents: undefined,
  userTasks: undefined,
  ...over,
});

describe('dayKey：按指定时区的日历日换日', () => {
  it('Asia/Shanghai 在北京时间 0 点换日', () => {
    expect(dayKey(Date.parse('2026-09-27T15:59:59.999Z'), 'Asia/Shanghai')).toBe('2026-09-27');
    expect(dayKey(Date.parse('2026-09-27T16:00:00.000Z'), 'Asia/Shanghai')).toBe('2026-09-28');
  });

  it('同一时刻在别的时区落在各自的日历日', () => {
    const now = Date.parse('2026-09-27T16:30:00Z');
    expect(dayKey(now, 'UTC')).toBe('2026-09-27');
    expect(dayKey(now, 'America/Los_Angeles')).toBe('2026-09-27');
    expect(dayKey(now, 'Asia/Shanghai')).toBe('2026-09-28');
  });

  it('不给时区时取宿主进程的本地时区', () => {
    const now = Date.parse('2026-09-27T16:30:00Z');
    expect(dayKey(now)).toBe(dayKey(now, Intl.DateTimeFormat().resolvedOptions().timeZone));
  });

  it('跨零点后前一天的花费与件数不再计入', () => {
    const ledger = spent(emptyLedger(), { room: 500, tasks: 1 });
    const tomorrow = dayKey(Date.parse('2026-09-27T16:00:00Z'), 'Asia/Shanghai');
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userTasks: 1 }), 50).ok).toBe(false);
    expect(canStart(ledger, tomorrow, 'n:zz-paper', ROOM_KEY, USER, limits({ userTasks: 1 }), 50)).toEqual({
      ok: true,
    });
  });
});

describe('canStart：各层金额上限可选', () => {
  it('房间金额未填时不额外限制，显式 0 拒绝', () => {
    const res = canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ roomCents: undefined }), 50);
    expect(res).toEqual({ ok: true });
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ roomCents: null }), 50)).toEqual({
      ok: true,
    });
    const denied = canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ roomCents: 0 }), 50);
    expect(denied.ok).toBe(false);
    expect(denied.ok ? '' : denied.reason).toMatch(/本房间/);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '500'])('安全：按房间金额写成 %s 时按 0 拒绝', value => {
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ roomCents: value }), 50).ok).toBe(false);
  });

  it('四层金额都未填时允许；任意单项显式 0 都阻断', () => {
    const blank = limits({ globalCents: undefined, paperCents: undefined, roomCents: undefined, userCents: undefined });
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, blank, 50)).toEqual({ ok: true });
    expect(
      canStart(
        emptyLedger(),
        DAY,
        'n:zz-paper',
        ROOM_KEY,
        USER,
        limits({ globalCents: null, paperCents: null, roomCents: null, userCents: null }),
        50,
      ),
    ).toEqual({ ok: true });
    for (const field of ['globalCents', 'paperCents', 'roomCents', 'userCents'] as const) {
      expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, { ...blank, [field]: 0 }, 50).ok).toBe(false);
    }
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '100'])('全局金额写坏为 %s 时按 0 拒绝', value => {
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ globalCents: value }), 50).ok).toBe(
      false,
    );
  });

  it('全局与白纸上限叠加，任一层先满都拒绝', () => {
    const ledger = emptyLedger();
    ledger.spend[DAY] = { global: 100, papers: { 'n:zz-paper': 70, 'n:other': 30 }, rooms: {}, users: {} };
    expect(
      canStart(
        ledger,
        DAY,
        'n:zz-paper',
        ROOM_KEY,
        USER,
        limits({ globalCents: 150, paperCents: 100, roomCents: undefined }),
        30,
      ),
    ).toEqual({ ok: true });
    expect(
      canStart(
        ledger,
        DAY,
        'n:zz-paper',
        ROOM_KEY,
        USER,
        limits({ globalCents: 150, paperCents: 99, roomCents: undefined }),
        30,
      ).ok,
    ).toBe(false);
    expect(
      canStart(
        ledger,
        DAY,
        'n:zz-paper',
        ROOM_KEY,
        USER,
        limits({ globalCents: 129, paperCents: 100, roomCents: undefined }),
        30,
      ).ok,
    ).toBe(false);
  });

  it('安全：按房间金额超出被拒；刚好用满可以', () => {
    expect(canStart(spent(emptyLedger(), { room: 450 }), DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 50)).toEqual({
      ok: true,
    });
    const res = canStart(spent(emptyLedger(), { room: 451 }), DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/本房间/);
  });

  it('安全：全局金额超出被拒；全局显式为 0 时一律不开', () => {
    const res = canStart(spent(emptyLedger(), { global: 9_990 }), DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/全局/);
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ globalCents: 0 }), 50).ok).toBe(false);
  });

  it('安全：已花费加进行中的预留加本次预留超限时被拒', () => {
    const ledger = spent(emptyLedger(), { room: 100 });
    ledger.reserves['t-00000001'] = { cents: 360, day: DAY, room: ROOM_KEY, user: 'onebot:30002' };
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 40)).toEqual({ ok: true });
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 41).ok).toBe(false);
    // 别的房间的预留不占本房间的额度，但占全局
    ledger.reserves['t-00000002'] = { cents: 9_600, day: DAY, room: 'onebot:10000:group:20009', user: USER };
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ globalCents: 100_000 }), 40)).toEqual({
      ok: true,
    });
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 40).ok).toBe(false);
  });
});

describe('canStart：按人两项可选', () => {
  it('安全：按人两项缺失时不按人限制，只受按房间与全局约束', () => {
    const ledger = spent(emptyLedger(), { room: 0, global: 0, user: 100_000, tasks: 999 });
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits(), 50)).toEqual({ ok: true });
  });

  it('安全：设了按人金额时超出被拒', () => {
    const ledger = spent(emptyLedger(), { user: 80 });
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userCents: 130 }), 50)).toEqual({ ok: true });
    const res = canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userCents: 129 }), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/你今天/);
  });

  it('安全：设了按人件数时按当天已受理的件数算', () => {
    const ledger = spent(emptyLedger(), { tasks: 2 });
    expect(canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userTasks: 3 }), 50)).toEqual({ ok: true });
    const res = canStart(ledger, DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userTasks: 2 }), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/件/);
  });

  it.each([-1, Number.NaN, '3'])('按人项写成 %s 时按 0 拒绝', value => {
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userCents: value }), 50).ok).toBe(false);
    expect(canStart(emptyLedger(), DAY, 'n:zz-paper', ROOM_KEY, USER, limits({ userTasks: value }), 50).ok).toBe(false);
  });
});

describe('每白纸每日金额：共享纸、旧账与费用归属', () => {
  const PAPER_A = 'n:paper-a';
  const PAPER_B = 'n:paper-b';
  const otherRoom = 'onebot:private:other';
  const task = (id: string, paperId: string, room = ROOM_KEY): TaskRecord => ({
    id,
    paperId,
    room,
    platform: 'onebot',
    initiator: { platform: 'onebot', userId: '30001' },
    name: 'x',
    text: 'x',
    state: 'done',
    createdAt: 1,
    artifacts: [],
    delivered: false,
  });

  it('同一白纸跨房间共享纸额度，不同白纸独立，但全局仍合计阻断', () => {
    const ledger = emptyLedger();
    ledger.spend[DAY] = { global: 90, papers: { [PAPER_A]: 90 }, rooms: {}, users: {} };
    const perPaper = limits({ globalCents: 1000, roomCents: 1000, paperCents: 100 });
    expect(canStart(ledger, DAY, PAPER_A, otherRoom, USER, perPaper, 10)).toEqual({ ok: true });
    expect(canStart(ledger, DAY, PAPER_A, otherRoom, USER, perPaper, 11).ok).toBe(false);
    expect(canStart(ledger, DAY, PAPER_B, otherRoom, USER, perPaper, 11)).toEqual({ ok: true });
    expect(
      canStart(
        ledger,
        DAY,
        PAPER_B,
        otherRoom,
        USER,
        limits({ globalCents: 100, roomCents: 1000, paperCents: 100 }),
        11,
      ).ok,
    ).toBe(false);
  });

  it('纸额度未设不额外限制，0 或坏值拒绝', () => {
    const ledger = emptyLedger();
    expect(canStart(ledger, DAY, PAPER_A, ROOM_KEY, USER, limits(), 50)).toEqual({ ok: true });
    for (const paperCents of [0, -1, Number.NaN, '100']) {
      expect(canStart(ledger, DAY, PAPER_A, ROOM_KEY, USER, limits({ paperCents }), 50).ok).toBe(false);
    }
  });

  it('旧预留按任务归纸，无法归属的预留每纸保守计入且跨日保留', () => {
    const ledger = emptyLedger();
    ledger.tasks['t-00000001'] = task('t-00000001', PAPER_A);
    ledger.reserves['t-00000001'] = { cents: 30, day: '2026-09-26', room: ROOM_KEY, user: USER };
    ledger.reserves['t-00000002'] = { cents: 20, day: '2026-09-26', room: otherRoom, user: USER };
    ledger.reserves['t-00000003'] = { cents: 40, day: '2026-09-26', room: otherRoom, user: USER, paperId: PAPER_B };
    expect(paperBudgetUsage(ledger, DAY, PAPER_A)).toEqual({ spentCents: 0, unattributedCents: 0, reservedCents: 50 });
    expect(paperBudgetUsage(ledger, DAY, PAPER_B)).toEqual({ spentCents: 0, unattributedCents: 0, reservedCents: 60 });
    expect(
      canStart(ledger, DAY, PAPER_A, otherRoom, USER, limits({ globalCents: 1000, roomCents: 1000, paperCents: 50 }), 1)
        .ok,
    ).toBe(false);
  });

  it('旧日账未归属额保守计入每纸，新增费用归纸且不丢旧额', () => {
    const ledger = emptyLedger();
    ledger.spend[DAY] = { global: 80, rooms: {}, users: {} };
    ledger.tasks['t-00000001'] = task('t-00000001', PAPER_A);
    ledger.agents.agent = {
      providerType: 'cursor',
      paperId: PAPER_A,
      name: 'x',
      state: 'active',
      createdAt: 1,
      costCents: 0,
    };
    ledger.runs.run = { agentId: 'agent', taskId: 't-00000001', cost: { state: 'pending' } };
    book(ledger, DAY, 'run', 20);
    expect(ledger.spend[DAY]).toMatchObject({ global: 100, papers: { [PAPER_A]: 20 } });
    expect(paperBudgetUsage(ledger, DAY, PAPER_A)).toEqual({ spentCents: 20, unattributedCents: 80, reservedCents: 0 });
    expect(
      canStart(ledger, DAY, PAPER_A, ROOM_KEY, USER, limits({ globalCents: 1000, roomCents: 1000, paperCents: 100 }), 1)
        .ok,
    ).toBe(false);
  });

  it('普通、账本外与估算轮次都按任务优先、否则代理归纸', () => {
    const ledger = emptyLedger();
    ledger.agents.agent = {
      providerType: 'cursor',
      paperId: PAPER_B,
      name: 'x',
      state: 'active',
      createdAt: 1,
      costCents: 0,
    };
    ledger.tasks['t-00000001'] = task('t-00000001', PAPER_A);
    ledger.runs.normal = { agentId: 'agent', taskId: 't-00000001', cost: { state: 'pending' } };
    ledger.runs.unknown = { agentId: 'agent', cost: { state: 'pending' } };
    ledger.runs.estimated = { agentId: 'agent', cost: { state: 'pending' } };
    book(ledger, DAY, 'normal', 11);
    book(ledger, DAY, 'unknown', 13);
    book(ledger, DAY, 'estimated', 17, true);
    expect(daySpend(ledger, DAY).papers).toEqual({ [PAPER_A]: 11, [PAPER_B]: 30 });
    expect(daySpend(ledger, DAY).global).toBe(41);
    expect(ledger.runs.estimated.cost).toMatchObject({ state: 'booked', cents: 17, estimated: true });
    expect(ledger.spend[DAY].rooms[ROOM_KEY]).toBe(11);
  });
});

describe('reserveFor：这块白纸最近 5 轮已记账费用的均值', () => {
  const task = (id: string, paperId: string, endedAt: number, costCents?: number): TaskRecord => ({
    id,
    paperId,
    room: ROOM,
    platform: 'onebot',
    initiator: { platform: 'onebot', userId: '30001' },
    name: 'x',
    text: 'x',
    state: 'done',
    createdAt: endedAt - 1,
    endedAt,
    costCents,
    artifacts: [],
    delivered: false,
  });

  it('没有历史时用默认预留额', () => {
    expect(reserveFor(emptyLedger(), 'n:zz-paper', 50)).toBe(50);
  });

  it('取最近 5 件已记账的均值，别的白纸与未记账的不算', () => {
    const ledger = emptyLedger();
    [1000, 10, 20, 30, 40, 50].forEach((cost, i) => {
      ledger.tasks[`t-0000000${i}`] = task(`t-0000000${i}`, 'n:zz-paper', 100 + i, cost);
    });
    ledger.tasks['t-000000aa'] = task('t-000000aa', 'n:zz-paper', 999);
    ledger.tasks['t-000000bb'] = task('t-000000bb', 'n:zz-other', 999, 5000);
    expect(reserveFor(ledger, 'n:zz-paper', 50)).toBe(30);
  });

  it('均值为 0（免费的轮次）时至少预留 1 美分，用满的额度不会被 0 预留穿过', () => {
    const ledger = emptyLedger();
    ledger.tasks['t-00000001'] = task('t-00000001', 'n:zz-paper', 100, 0);
    expect(reserveFor(ledger, 'n:zz-paper', 50)).toBe(1);
  });
});

describe('paper_task 按上限受理', () => {
  it('房间金额未填时 paper_task 可受理，显式 0 时拒绝', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentRoomDailyCents: undefined } } });
    const res = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(res.ok).toBe(true);
    const blocked = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentRoomDailyCents: 0 } } });
    const denied = await blocked.call('paper_task', { text: '做个网页', name: '网页' });
    expect(denied.ok).toBe(false);
    expect(String(denied.error)).toMatch(/本房间/);
  });

  it('受理即记预留与当天件数；owner 在群里同样计入，额度用满后被拒', async () => {
    const owner = human('10001');
    const hub = await startPaperHub({
      config: {
        globalDailyCents: 1000,
        reserveDefaultCents: 50,
        papers: [{ name: 'zz-paper', remoteAgentType: 'zz-remote-a' }],
      },
      rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentRoomDailyCents: 100 } },
    });
    const first = await hub.call('paper_task', { text: '一', name: '一' }, owner);
    const second = await hub.call('paper_task', { text: '二', name: '二' }, owner);
    expect(first.ok && second.ok).toBe(true);
    const ledger = hub.ledger();
    expect(Object.values(ledger.reserves)).toEqual([
      expect.objectContaining({ cents: 50, room: ROOM, user: 'onebot:10001' }),
      expect.objectContaining({ cents: 50, room: ROOM, user: 'onebot:10001' }),
    ]);
    const today = Object.values(ledger.spend)[0];
    expect(today.users['onebot:10001'].tasks).toBe(2);

    const third = await hub.call('paper_task', { text: '三', name: '三' }, owner);
    expect(third.ok).toBe(false);
    expect(String(third.error)).toMatch(/本房间/);
  });
});
