import { afterEach, describe, expect, it } from 'vitest';
import { canStart, dayKey, reserveFor } from '../../packages/plugin-paper/src/budget.js';
import type { PaperLedger, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import { emptyLedger, human, PILOT_ROOM, ROOM, startPaperHub, stopPaperHubs } from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的每日上限（U10a）：按房间金额、全局金额两项必有，按人金额与按人件数可选。
// 已花费加上所有进行中的预留加本次预留，不能超过任何一项上限。按房间金额缺失或写坏按 0（拒）；
// 按人两项缺失即不按人限制，写了但不是有限非负数按 0。每天按 budgetTimeZone 的 0 点换日。
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

const limits = (over: Partial<Parameters<typeof canStart>[4]> = {}) => ({
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
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits({ userTasks: 1 }), 50).ok).toBe(false);
    expect(canStart(ledger, tomorrow, ROOM_KEY, USER, limits({ userTasks: 1 }), 50)).toEqual({ ok: true });
  });
});

describe('canStart：按房间与全局两项必有', () => {
  it('安全：按房间金额缺失时按 0 拒绝', () => {
    const res = canStart(emptyLedger(), DAY, ROOM_KEY, USER, limits({ roomCents: undefined }), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/remoteAgentRoomDailyCents/);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '500', null])('安全：按房间金额写成 %s 时按 0 拒绝', value => {
    expect(canStart(emptyLedger(), DAY, ROOM_KEY, USER, limits({ roomCents: value }), 50).ok).toBe(false);
  });

  it('安全：按房间金额超出被拒；刚好用满可以', () => {
    expect(canStart(spent(emptyLedger(), { room: 450 }), DAY, ROOM_KEY, USER, limits(), 50)).toEqual({ ok: true });
    const res = canStart(spent(emptyLedger(), { room: 451 }), DAY, ROOM_KEY, USER, limits(), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/本房间/);
  });

  it('安全：全局金额超出被拒；全局为 0 时一律不开', () => {
    const res = canStart(spent(emptyLedger(), { global: 9_990 }), DAY, ROOM_KEY, USER, limits(), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/全局/);
    expect(canStart(emptyLedger(), DAY, ROOM_KEY, USER, limits({ globalCents: 0 }), 50).ok).toBe(false);
  });

  it('安全：已花费加进行中的预留加本次预留超限时被拒', () => {
    const ledger = spent(emptyLedger(), { room: 100 });
    ledger.reserves['t-00000001'] = { cents: 360, day: DAY, room: ROOM_KEY, user: 'onebot:30002' };
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits(), 40)).toEqual({ ok: true });
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits(), 41).ok).toBe(false);
    // 别的房间的预留不占本房间的额度，但占全局
    ledger.reserves['t-00000002'] = { cents: 9_600, day: DAY, room: 'onebot:10000:group:20009', user: USER };
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits({ globalCents: 100_000 }), 40)).toEqual({ ok: true });
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits(), 40).ok).toBe(false);
  });
});

describe('canStart：按人两项可选', () => {
  it('安全：按人两项缺失时不按人限制，只受按房间与全局约束', () => {
    const ledger = spent(emptyLedger(), { room: 0, global: 0, user: 100_000, tasks: 999 });
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits(), 50)).toEqual({ ok: true });
  });

  it('安全：设了按人金额时超出被拒', () => {
    const ledger = spent(emptyLedger(), { user: 80 });
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits({ userCents: 130 }), 50)).toEqual({ ok: true });
    const res = canStart(ledger, DAY, ROOM_KEY, USER, limits({ userCents: 129 }), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/你今天/);
  });

  it('安全：设了按人件数时按当天已受理的件数算', () => {
    const ledger = spent(emptyLedger(), { tasks: 2 });
    expect(canStart(ledger, DAY, ROOM_KEY, USER, limits({ userTasks: 3 }), 50)).toEqual({ ok: true });
    const res = canStart(ledger, DAY, ROOM_KEY, USER, limits({ userTasks: 2 }), 50);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.reason).toMatch(/件/);
  });

  it.each([-1, Number.NaN, '3'])('按人项写成 %s 时按 0 拒绝', value => {
    expect(canStart(emptyLedger(), DAY, ROOM_KEY, USER, limits({ userCents: value }), 50).ok).toBe(false);
    expect(canStart(emptyLedger(), DAY, ROOM_KEY, USER, limits({ userTasks: value }), 50).ok).toBe(false);
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
    notified: true,
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
  it('安全：房间没写按房间金额时 paper_task 被拒', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentRoomDailyCents: undefined } } });
    const res = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/remoteAgentRoomDailyCents/);
    expect(hub.outbound).toEqual([]);
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
