// ============================================================
// 每日上限：按房间金额与全局金额两项必有，按人金额与按人件数可选
//
// 受理与开轮前都要「已花费 + 所有进行中的预留 + 本次预留」不超过每一项上限。每天按 budgetTimeZone
// 的 0 点换日（缺省宿主进程的本地时区），换日后当天的花费与件数从零算；预留不分日，进行中的都算。
// ============================================================

import type { DaySpend, PaperLedger } from './ledger.js';

/** 预留额取这块白纸最近几轮的均值 */
const RESERVE_SAMPLE = 5;

/** 本地日历日 YYYY-MM-DD；timeZone 缺省取宿主进程的本地时区 */
export function dayKey(now: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

interface BudgetLimits {
  /** 全局每天金额（插件配置，已规整） */
  globalCents: number;
  /** 本房间每天金额（会话配置原值）：缺失或写坏按 0 */
  roomCents: unknown;
  /** 每人每天金额（会话配置原值）：缺失即不按人限制，写坏按 0 */
  userCents: unknown;
  /** 每人每天件数（会话配置原值）：缺失即不按人限制，写坏按 0 */
  userTasks: unknown;
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalAmount(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : amount(value);
}

const NO_SPEND: DaySpend = { global: 0, rooms: {}, users: {} };

/**
 * 能否再开一件（受理时与出队开轮前各判一次）。reserveCents 是本次要预留的额度（{@link reserveFor}）。
 * 按人件数按当天已受理的件数算，不含本件。
 */
export function canStart(
  ledger: PaperLedger,
  day: string,
  room: string,
  user: string,
  limits: BudgetLimits,
  reserveCents: number,
): { ok: true } | { ok: false; reason: string } {
  const today = ledger.spend[day] ?? NO_SPEND;
  const reserves = Object.values(ledger.reserves);
  const reserved = (pick: (r: (typeof reserves)[number]) => boolean) =>
    reserves.filter(pick).reduce((sum, r) => sum + r.cents, 0);
  const deny = (reason: string) => ({ ok: false as const, reason });

  const global = today.global + reserved(() => true);
  if (global + reserveCents > limits.globalCents) {
    return deny(
      limits.globalCents <= 0
        ? '全局每天金额上限为 0，远端任务不开'
        : `今天全局的远端任务额度不够（已用加预留 ${global} 美分，本件预留 ${reserveCents}，上限 ${limits.globalCents}）`,
    );
  }

  const roomLimit = amount(limits.roomCents);
  const roomUsed = (today.rooms[room] ?? 0) + reserved(r => r.room === room);
  if (roomUsed + reserveCents > roomLimit) {
    return deny(
      roomLimit <= 0
        ? '本房间的每天金额上限（remoteAgentRoomDailyCents）没有设或为 0，远端任务不开'
        : `本房间今天的额度不够（已用加预留 ${roomUsed} 美分，本件预留 ${reserveCents}，上限 ${roomLimit}）`,
    );
  }

  const mine = today.users[user] ?? { cents: 0, tasks: 0 };
  const userLimit = optionalAmount(limits.userCents);
  if (userLimit !== undefined) {
    const userUsed = mine.cents + reserved(r => r.user === user);
    if (userUsed + reserveCents > userLimit) {
      return deny(`你今天的额度不够（已用加预留 ${userUsed} 美分，本件预留 ${reserveCents}，上限 ${userLimit}）`);
    }
  }
  const taskLimit = optionalAmount(limits.userTasks);
  if (taskLimit !== undefined && mine.tasks + 1 > taskLimit) {
    return deny(`你今天已经交了 ${mine.tasks} 件，每人每天上限 ${taskLimit} 件`);
  }
  return { ok: true };
}

/**
 * 本件的预留额：这块白纸最近 {@link RESERVE_SAMPLE} 件已入账任务的费用均值，没有就用默认。
 * 至少 1 美分：免费的轮次会让均值为 0，0 预留在额度刚好用满时也能通过。
 */
export function reserveFor(ledger: PaperLedger, paperId: string, defaultCents: number): number {
  const booked = Object.values(ledger.tasks)
    .filter(t => t.paperId === paperId && typeof t.costCents === 'number' && Number.isFinite(t.costCents))
    .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt))
    .slice(-RESERVE_SAMPLE);
  if (booked.length === 0) return defaultCents;
  const mean = booked.reduce((sum, t) => sum + (t.costCents ?? 0), 0) / booked.length;
  return Math.max(1, Math.ceil(mean));
}

/** 当天的花费表（没有就建） */
export function daySpend(ledger: PaperLedger, day: string): DaySpend {
  ledger.spend[day] ??= { global: 0, rooms: {}, users: {} };
  return ledger.spend[day];
}

/** 释放一件任务的预留 */
export function release(ledger: PaperLedger, taskId: string): void {
  delete ledger.reserves[taskId];
}
