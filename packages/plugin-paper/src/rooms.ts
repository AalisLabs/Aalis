// ============================================================
// 房间与资格：房间用哪块白纸、谁能发起、远端条件是否成立
//
// - 房间白纸：会话配置 paperEnabled 为 true 才开；写了 paperName 用同名的具名白纸，否则每个房间一块。
// - 资格：交任务与取消只受理真人在房间会话本身里当面发起的回合（ctx.inbound 存在且 source 缺省、
//   有效授权身份的 userId 非空）；查状态与发成品只要求房间会话本身与入站回合。
// - 远端条件：提供者按白纸写的实例 id 精确取（不用 current，不回落到别的提供者），出网不超过白纸上限，
//   不违反同账号隔离，账本读取正常，白纸没有停开，提供者实例没有未读的账本外代理告警。
// - 共用：一块具名白纸被哪些房间共用（WebUI 白纸页与诊断项用），长期代理的对话与工作区对它们都可见。
// ============================================================

import {
  type EgressReport,
  egressWithin,
  type RemoteAgentEntry,
  type RemoteAgentProvider,
  resolveRemoteAgent,
} from '@aalis/api-remote-agent';
import type { SessionConfig, SessionManagerService } from '@aalis/api-session-manager';
import type { ToolCallContext } from '@aalis/api-tools';
import type { ServiceRef } from '@aalis/core';
import type { PaperConfig, PaperSpec } from './config.js';
import type { LedgerStore, PaperLedger } from './ledger.js';
import { describe } from './util.js';

export interface RoomPaper {
  /** n:<名> 或 r:<房间会话 id 的 sha256 前 12 位> */
  paperId: string;
  spec: PaperSpec;
  /** 房间的生效会话配置 */
  room: Omit<SessionConfig, 'sessionDefaults'>;
}

/** 房间白纸的 id：房间会话 id 的 SHA-256 前 12 位十六进制 */
async function roomPaperId(sessionId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionId)));
  return `r:${Buffer.from(digest).toString('hex').slice(0, 12)}`;
}

/** 房间用哪块白纸；不开时给出原因 */
export async function resolveRoomPaper(
  sm: SessionManagerService,
  cfg: PaperConfig,
  sessionId: string,
  platform: string | undefined,
): Promise<RoomPaper | { unavailable: string }> {
  const room = sm.resolveConfig(sessionId, platform);
  if (room.paperEnabled !== true) return { unavailable: '本房间没有开启白纸' };
  const name = typeof room.paperName === 'string' ? room.paperName.trim() : '';
  if (!name) return { paperId: await roomPaperId(sessionId), spec: cfg.defaults, room };
  const spec = cfg.papers.get(name);
  if (!spec) return { unavailable: `本房间写的白纸「${name}」不存在（白纸插件配置的 papers 里没有这个名字）` };
  return { paperId: `n:${name}`, spec, room };
}

/** 白纸在页面与诊断里的称呼：具名白纸用名字，房间白纸用 id */
export function paperLabel(paperId: string): string {
  return paperId.startsWith('n:') ? paperId.slice(2) : `房间白纸 ${paperId}`;
}

/**
 * 共用一块白纸的房间：会话自身配置写了这个白纸名的房间会话、写了它的平台档（这个平台的所有房间），以及账本里
 * 还没结束、或在上次清空之后才结束的任务所在的房间（它们的原文还在代理的对话与工作区里；清空时白纸上没有在跑
 * 的任务，之前结束的随代理一起删了）。房间白纸只有账本里的那个房间。
 * labels 是显示用的称呼（房间会话 id，平台档写成「平台档 X 的全部房间」）；shared：多于一个房间，或有平台档。
 */
export function sharingRooms(
  sm: SessionManagerService,
  ledger: PaperLedger,
  paperId: string,
): { labels: string[]; shared: boolean } {
  const rooms = new Set<string>();
  const platforms: string[] = [];
  if (paperId.startsWith('n:')) {
    const name = paperId.slice(2);
    const names = (config: SessionConfig) => typeof config.paperName === 'string' && config.paperName.trim() === name;
    for (const session of sm.listSessions()) if (!session.parentId && names(session.config)) rooms.add(session.id);
    for (const [platform, profile] of Object.entries(sm.getPlatformProfiles())) {
      if (names(profile)) platforms.push(platform);
    }
  }
  const since = ledger.papers[paperId]?.lastClearedAt ?? 0;
  for (const task of Object.values(ledger.tasks)) {
    if (task.paperId === paperId && (task.endedAt === undefined || task.endedAt > since)) rooms.add(task.room);
  }
  return {
    labels: [...rooms, ...platforms.map(p => `平台档 ${p} 的全部房间`)],
    shared: rooms.size > 1 || platforms.length > 0,
  };
}

/** 白纸停开，或它的提供者实例有未读的账本外代理告警时，给出原因（受理时回给她，出队时不出） */
export function pausedReason(ledger: PaperLedger, paperId: string, type: string): string | undefined {
  const halted = ledger.papers[paperId]?.halted;
  if (halted) return `这块白纸已停开（${halted.detail}），等 owner 在 WebUI 恢复`;
  if (ledger.alerts.some(a => a.kind === 'unknown-agent' && !a.acknowledged && a.providerType === type)) {
    return `远端代理「${type}」的账号下有账本外的代理，等 owner 在 WebUI 核实并标为已读`;
  }
  return undefined;
}

/** 有效授权身份：actor 缺省时就是会话语义的 (platform, userId) */
export function effectiveActor(ctx: ToolCallContext): { platform: string; userId: string } {
  return ctx.actor ?? { platform: ctx.platform ?? '', userId: ctx.userId ?? '' };
}

/** 账本、预留与按人计数里的发起者键 */
export function actorKey(actor: { platform: string; userId: string }): string {
  return `${actor.platform}:${actor.userId}`;
}

/**
 * 资格。initiate（交任务、取消）：房间会话本身、入站回合、真人消息、发起人非空；
 * use（查状态、发成品）：房间会话本身、入站回合。不满足时返回原因。
 */
export function checkEligibility(
  sm: SessionManagerService,
  ctx: ToolCallContext,
  kind: 'initiate' | 'use',
): string | undefined {
  if (sm.getSession(ctx.sessionId)?.parentId) return '子会话不能用白纸，只有房间会话本身能用';
  if (!ctx.inbound) return '白纸工具只能在由消息驱动的对话回合里用';
  if (kind === 'use') return undefined;
  if (ctx.inbound.source !== undefined) {
    return `只有真人当面发起的回合能交任务或取消任务，这一回合来自「${ctx.inbound.source}」`;
  }
  if (!effectiveActor(ctx).userId) return '这一回合没有发起人，不能交任务或取消任务';
  return undefined;
}

/**
 * 同账号隔离：声明 transcriptIsolation 为 shared 的提供者，同一远端账号下的代理能互读对话，
 * 所以同一 accountKey 下最多一块具名白纸。账号按 ready() 报告的 accountKey 计（隔离边界是账号，
 * 不是插件实例）；取不到 accountKey 的实例按冲突算：它可能与任何一块在同一账号下，
 * 这时所有这类具名白纸都不开。每次都直接调 ready()：成功结果由提供者自己缓存。
 */
export class Isolation {
  constructor(
    private readonly remote: ServiceRef<RemoteAgentProvider>,
    private readonly papers: ReadonlyMap<string, PaperSpec>,
  ) {}

  async #accountKey(entry: RemoteAgentEntry, signal: AbortSignal): Promise<string | undefined> {
    try {
      const { accountKey } = await entry.instance.ready(signal);
      return accountKey || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 引用 shared 提供者的具名白纸各自能不能开：blocked 为白纸名到原因；
   * collisions 是确认同账号的几块白纸，unknown 是取不到账号标识的提供者实例及引用它的白纸。
   */
  async report(signal: AbortSignal): Promise<{
    blocked: Map<string, string>;
    collisions: string[][];
    unknown: Array<{ type: string; papers: string[] }>;
  }> {
    const byType = new Map<string, string[]>();
    for (const [name, spec] of this.papers) {
      const entry = resolveRemoteAgent(this.remote, spec.remoteAgentType);
      if (entry?.instance.transcriptIsolation !== 'shared') continue;
      byType.set(entry.contextId, [...(byType.get(entry.contextId) ?? []), name]);
    }
    const byAccount = new Map<string, string[]>();
    const unknown: Array<{ type: string; papers: string[] }> = [];
    await Promise.all(
      [...byType].map(async ([type, names]) => {
        const entry = resolveRemoteAgent(this.remote, type);
        const key = entry && (await this.#accountKey(entry, signal));
        if (key === undefined) unknown.push({ type, papers: names });
        else byAccount.set(key, [...(byAccount.get(key) ?? []), ...names]);
      }),
    );
    const blocked = new Map<string, string>();
    for (const { type, papers } of unknown) {
      for (const name of papers) blocked.set(name, `取不到提供者「${type}」的远端账号标识，按与其他白纸同账号处理`);
    }
    const collisions = [...byAccount.values()].filter(names => names.length > 1);
    for (const names of byAccount.values()) {
      for (const name of names) {
        if (names.length > 1) {
          blocked.set(name, `白纸 ${names.join('、')} 用的提供者在同一远端账号下（同账号的代理能互读对话）`);
        } else if (unknown.length > 0) {
          const types = unknown.map(u => `「${u.type}」`).join('、');
          blocked.set(name, `取不到提供者${types}的远端账号标识，按与本白纸同账号处理`);
        }
      }
    }
    return { blocked, collisions, unknown };
  }
}

/**
 * 远端条件。成立时返回解析到的提供者，否则返回原因；任何一条不满足都不换用别的提供者。
 */
export async function checkRemote(deps: {
  paper: RoomPaper;
  remote: ServiceRef<RemoteAgentProvider>;
  ledger: LedgerStore;
  isolation: Isolation;
  signal: AbortSignal;
}): Promise<{ provider: RemoteAgentEntry } | { unavailable: string }> {
  const { paper, remote, ledger } = deps;
  const { spec } = paper;
  if (ledger.failure) return { unavailable: '白纸账本读取失败，远端任务暂停，等 owner 处理' };
  const type = spec.remoteAgentType;
  if (!type) return { unavailable: '这块白纸没有配置远端代理类型' };
  const allowed = Array.isArray(paper.room.remoteAgentTypes) ? paper.room.remoteAgentTypes : [];
  if (!allowed.includes(type)) return { unavailable: `本房间没有允许这块白纸的远端代理类型「${type}」` };
  const provider = resolveRemoteAgent(remote, type);
  if (!provider) return { unavailable: `远端代理「${type}」不在场` };
  let egress: EgressReport;
  try {
    egress = await provider.instance.egress(deps.signal);
  } catch (err) {
    deps.signal.throwIfAborted();
    return { unavailable: `取不到远端代理「${type}」的出网方式：${describe(err)}` };
  }
  if (!egressWithin(egress, spec.remoteAgentEgress)) {
    return {
      unavailable: `远端代理「${type}」的出网方式（${egress.mode}）超过这块白纸的上限（${spec.remoteAgentEgress}）`,
    };
  }
  if (provider.instance.transcriptIsolation === 'shared') {
    if (!spec.name) {
      return {
        unavailable: `远端代理「${type}」的同账号代理能互读对话，只能给具名白纸用；本房间没有写白纸名`,
      };
    }
    const blocked = (await deps.isolation.report(deps.signal)).blocked.get(spec.name);
    if (blocked) return { unavailable: blocked };
  }
  const paused = pausedReason(ledger.data, paper.paperId, type);
  return paused ? { unavailable: paused } : { provider };
}
