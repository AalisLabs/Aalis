// ============================================================
// 房间与资格：房间用哪块白纸、谁能发起、远端条件是否成立
//
// - 房间白纸：本插件的按会话字段 paperEnabled 为 true 才开；写了 paperName 用同名的具名白纸，否则每个窗口（场所）一块。
// - 资格：交任务与取消只受理真人在房间会话本身里当面发起的回合（ctx.inbound 存在且 source 缺省、
//   有效授权身份的 userId 非空）；查状态与发成品只要求房间会话本身与入站回合。
// - 远端条件：提供者按白纸写的实例 id 精确取（不用默认选中的那一家，不回落到别的提供者），出网不超过白纸上限，
//   不违反同账号隔离，账本读取正常，白纸没有停开，提供者实例没有未读的账本外代理告警。
// - 共用：一块具名白纸被哪些房间共用（WebUI 白纸页与诊断项用），长期代理的对话与工作区对它们都可见。
// - 房间的开关与上限是本插件的六个按会话字段（config.ts），只对房间适用，只能设到场所为止（按窗口设，换会话不丢），
//   建子会话时不写进子会话（子会话本来就不适用）。
// ============================================================

import { type EgressReport, egressWithin, type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import { placePaperId, type SessionInfo, type SessionManagerService } from '@aalis/api-session-manager';
import { layerLabel, type SessionFieldReader, type SessionSettingsLayer } from '@aalis/api-session-settings';
import { actingIdentity, type ToolCallContext } from '@aalis/api-tools';
import type { Logger, ProviderEntry, ServiceSelection } from '@aalis/core';
import type { SessionFieldsOf } from '@aalis/schema-config';
import { sameText, type TextRef, textOf, toSource } from '@aalis/schema-i18n';
import type { configSchema, PaperConfig, PaperSpec } from './config.js';
import type { LedgerStore, PaperLedger } from './ledger.js';
import { t } from './texts.js';
import { category } from './util.js';

/** 本插件按会话字段的读取器 */
export type PaperFields = SessionFieldReader<typeof configSchema>;

/** 一个房间的六项生效值 */
export type RoomSettings = SessionFieldsOf<typeof configSchema>;

export interface RoomPaper {
  /** n:<名>，或场所的白纸 id（api-session-manager 的 placePaperId） */
  paperId: string;
  spec: PaperSpec;
  /** 房间的六项生效值 */
  room: RoomSettings;
}

/**
 * 房间用哪块白纸；不开时给出原因（房间面板显示它，交给模型与写进任务的失败原因时取原文）。不写名字的用房间所在场所的
 * 那一块：同一个窗口里几个机器人账号的会话共用
 */
export function resolveRoomPaper(
  sm: SessionManagerService,
  fields: PaperFields,
  cfg: PaperConfig,
  sessionId: string,
  platform: string | undefined,
): RoomPaper | { unavailable: TextRef } {
  const room = fields.get(sessionId, { platform });
  if (room.paperEnabled !== true) return { unavailable: t('roomPaperOff') };
  const name = room.paperName.trim();
  if (!name) return { paperId: placePaperId(sm.placeOf(sessionId).key), spec: cfg.defaults, room };
  const broken = cfg.brokenPapers.get(name);
  if (broken) return { unavailable: t('paperBroken', { name, problem: broken }) };
  const spec = cfg.papers.get(name);
  if (!spec) return { unavailable: t('paperMissing', { name }) };
  return { paperId: `n:${name}`, spec, room };
}

/** 白纸在页面与诊断里的称呼：具名白纸用名字，房间白纸用 id（交给发布服务的分组名取原文） */
export function paperLabel(paperId: string): string | TextRef {
  return paperId.startsWith('n:') ? paperId.slice(2) : t('roomPaperLabel', { id: paperId });
}

/**
 * 已登记的 IM 房间与各自的白纸名。白纸设置只能设到场所为止，生效值只来自覆盖一类房间的三层与所在窗口的场所（哪一层都没设时
 * 是空名字，配不上具名白纸），不用再按来源筛
 */
function imRoomPapers(sm: SessionManagerService, fields: PaperFields): Array<{ session: SessionInfo; name: string }> {
  return sm
    .listSessions()
    .filter(session => session.kind === 'room')
    .map(session => ({ session, name: fields.get(session.id).paperName }));
}

/**
 * 覆盖一类房间的层：全局（插件配置）覆盖全部房间，平台档覆盖这个平台的全部房间，平台类型档覆盖这个平台这种类型的全部房间
 * （都包括还没登记的）
 */
type ProfileLayer = Exclude<SessionSettingsLayer, { scope: 'place' }>;

/** 写了某一项的全局层、平台档与平台类型档，各带这一层的值 */
export function layersWith<K extends 'paperName' | 'remoteAgentTypes'>(
  fields: PaperFields,
  key: K,
): Array<{ layer: ProfileLayer; value: RoomSettings[K] }> {
  const found: Array<{ layer: ProfileLayer; value: RoomSettings[K] }> = [];
  for (const { layer, values } of fields.layers()) {
    if (layer.scope === 'place') continue;
    const value = values[key];
    if (value !== undefined) found.push({ layer, value: value as RoomSettings[K] });
  }
  return found;
}

/** 覆盖一类房间的一层的称呼：层表里的称呼加选的是哪一份，如「全局（插件配置）」「平台类型档 onebot · group」 */
export function layerName(layer: ProfileLayer): TextRef {
  const label = layerLabel(layer.scope);
  if (layer.scope === 'platform') return t('profilePlatform', { layer: label, platform: layer.platform });
  if (layer.scope === 'platformType') {
    return t('profilePlatformType', { layer: label, platform: layer.platform, type: layer.type });
  }
  return label;
}

/**
 * 一层覆盖的全部房间的称呼，如「全局（插件配置）的全部房间」「平台档 onebot 的全部房间」「平台类型档 onebot · group 的全部
 * 房间」（以平台名或类型名收尾的称呼与汉字隔一个空格）
 */
const allRoomsOf = (layer: ProfileLayer) =>
  t(layer.scope === 'global' ? 'allRoomsGlobal' : 'allRoomsNamed', { layer: layerName(layer) });

/**
 * 共用一块白纸的房间：已登记的 IM 房间里，从全局层、平台档、平台类型档或所在窗口的场所取到了这个白纸名的；写了它的全局层、
 * 平台档与平台类型档（覆盖一类房间，包括还没登记的）；以及账本里还没结束、或在上次清空之后才结束的任务所在的
 * 房间（它们的原文还在代理的对话与工作区里；清空时白纸上没有在跑的任务，之前结束的随代理一起删了）。不写名字的白纸只有账本里的
 * 房间。labels 是显示用的称呼（房间会话 id；覆盖一类房间的层写成「全局（插件配置）的全部房间」「平台档 X 的全部房间」
 * 「平台类型档 X · T 的全部房间」）；shared：多于一个房间，或有覆盖一类房间的层写了它。
 */
export function sharingRooms(
  sm: SessionManagerService,
  fields: PaperFields,
  ledger: PaperLedger,
  paperId: string,
): { labels: Array<string | TextRef>; shared: boolean } {
  const rooms = new Set<string>();
  // 每一层只出现一次，称呼不会重复
  const profiles: TextRef[] = [];
  if (paperId.startsWith('n:')) {
    const name = paperId.slice(2);
    const names = (value: string | undefined) => value?.trim() === name;
    for (const { layer, value } of layersWith(fields, 'paperName')) {
      if (names(value)) profiles.push(allRoomsOf(layer));
    }
    for (const { session, name: paper } of imRoomPapers(sm, fields)) if (names(paper)) rooms.add(session.id);
  }
  const since = ledger.papers[paperId]?.lastClearedAt ?? 0;
  for (const task of Object.values(ledger.tasks)) {
    if (task.paperId === paperId && (task.endedAt === undefined || task.endedAt > since)) rooms.add(task.room);
  }
  return { labels: [...rooms, ...profiles], shared: rooms.size > 1 || profiles.length > 0 };
}

/** 白纸停开，或它的提供者实例有未读的账本外代理告警时，给出原因（受理时回给她，取原文；出队时不出） */
export function pausedReason(ledger: PaperLedger, paperId: string, type: string): TextRef | undefined {
  const halted = ledger.papers[paperId]?.halted;
  if (halted) return t('pausedHalted', { detail: halted.detail });
  if (ledger.alerts.some(a => a.kind === 'unknown-agent' && !a.acknowledged && a.providerType === type)) {
    return t('pausedUnknownAgent', { type });
  }
  return undefined;
}

/** 账本、预留与按人计数里的发起者键 */
export function actorKey(actor: { platform: string; userId: string }): string {
  return `${actor.platform}:${actor.userId}`;
}

/**
 * 资格。initiate（交任务、取消）：房间会话本身、入站回合、真人消息、有单一的发起人（这次调用只有一位有账号的参与者）；
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
  if (!actingIdentity(ctx).userId) return '这一轮没有单一的发起人，不能交任务或取消任务';
  return undefined;
}

/**
 * 同账号隔离：声明 transcriptIsolation 为 shared 的提供者，同一远端账号下的代理能互读对话，
 * 所以同一 accountKey 下最多一块具名白纸。账号按 ready() 报告的 accountKey 计（隔离边界是账号，
 * 不是插件实例）；取不到 accountKey 的实例按冲突算：它可能与任何一块在同一账号下，
 * 这时所有这类具名白纸都不开。每次都直接调 ready()：成功结果由提供者自己缓存。
 * 取不到时分开给出两样：拒绝理由（会写进任务与完成通知，也交给模型）只用宿主撰写的类别；提供者报错的原文
 * （按契约已去掉凭据与查询串，但可能有远端说明与本机网络细节）只进 warn 与诊断项。同一实例同一类别只记一次 warn
 * （原文每次可能不同，如带请求号）。
 */
export class Isolation {
  /** 提供者实例 id → 上次记 warn 的类别；取到 accountKey 后清掉 */
  readonly #warned = new Map<string, TextRef>();

  constructor(
    private readonly remote: ServiceSelection<RemoteAgentProvider>,
    private readonly papers: ReadonlyMap<string, PaperSpec>,
    private readonly logger: Logger,
  ) {}

  async #accountKey(
    entry: ProviderEntry<RemoteAgentProvider>,
    signal: AbortSignal,
  ): Promise<{ key: string } | { category: TextRef; detail: string | TextRef }> {
    let failure: { category: TextRef; detail: string | TextRef };
    try {
      const { accountKey } = await entry.use.ready(signal);
      if (accountKey) {
        this.#warned.delete(entry.id);
        return { key: accountKey };
      }
      failure = { category: t('accountKeyEmpty'), detail: t('accountKeyEmptyDetail') };
    } catch (err) {
      failure = { category: category(err), detail: textOf(err) };
    }
    const warned = this.#warned.get(entry.id);
    if (!warned || !sameText(warned, failure.category)) {
      this.#warned.set(entry.id, failure.category);
      this.logger.warn(`取不到提供者「${entry.id}」的远端账号标识，按冲突处理：${toSource(failure.detail)}`);
    }
    return failure;
  }

  /**
   * 引用 shared 提供者的具名白纸各自能不能开：blocked 为白纸名到原因（只含类别）；collisions 是确认同账号的
   * 几块白纸，unknown 是取不到账号标识的提供者实例、引用它的白纸、类别与提供者报错的原文（只给诊断项）。
   */
  async report(signal: AbortSignal): Promise<{
    blocked: Map<string, TextRef>;
    collisions: string[][];
    unknown: Array<{ type: string; papers: string[]; category: TextRef; detail: string | TextRef }>;
  }> {
    const byType = new Map<string, { entry: ProviderEntry<RemoteAgentProvider>; names: string[] }>();
    for (const [name, spec] of this.papers) {
      const entry = resolveRemoteAgent(this.remote, spec.remoteAgentType);
      if (entry?.use.transcriptIsolation !== 'shared') continue;
      const group = byType.get(entry.id) ?? { entry, names: [] };
      group.names.push(name);
      byType.set(entry.id, group);
    }
    const byAccount = new Map<string, string[]>();
    const unknown: Array<{ type: string; papers: string[]; category: TextRef; detail: string | TextRef }> = [];
    await Promise.all(
      [...byType].map(async ([type, { entry, names }]) => {
        const result = await this.#accountKey(entry, signal);
        if ('key' in result) byAccount.set(result.key, [...(byAccount.get(result.key) ?? []), ...names]);
        else unknown.push({ type, papers: names, ...result });
      }),
    );
    const blocked = new Map<string, TextRef>();
    for (const { type, papers, category } of unknown) {
      for (const name of papers) blocked.set(name, t('blockedUnknown', { type, category }));
    }
    const collisions = [...byAccount.values()].filter(names => names.length > 1);
    for (const names of byAccount.values()) {
      for (const name of names) {
        if (names.length > 1) {
          blocked.set(name, t('blockedCollision', { papers: names }));
        } else if (unknown.length > 0) {
          const causes = unknown.map(u => t('accountIdOf', { type: u.type, category: u.category }));
          blocked.set(name, t('blockedOthersUnknown', { causes }));
        }
      }
    }
    return { blocked, collisions, unknown };
  }
}

/**
 * 远端条件。成立时返回解析到的提供者，否则返回原因（交给模型与写进任务的失败原因时取原文，出网方式与上限照原值写）；任何一条
 * 不满足都不换用别的提供者。
 */
export async function checkRemote(deps: {
  paper: RoomPaper;
  remote: ServiceSelection<RemoteAgentProvider>;
  ledger: LedgerStore;
  isolation: Isolation;
  signal: AbortSignal;
}): Promise<{ provider: ProviderEntry<RemoteAgentProvider> } | { unavailable: TextRef }> {
  const { paper, remote, ledger } = deps;
  const { spec } = paper;
  if (ledger.failure) return { unavailable: t('ledgerDownPaused') };
  const type = spec.remoteAgentType;
  if (!type) return { unavailable: t('noRemoteType') };
  if (!paper.room.remoteAgentTypes.includes(type)) return { unavailable: t('roomDisallowsType', { type }) };
  const provider = resolveRemoteAgent(remote, type);
  if (!provider) return { unavailable: t('remoteAbsent', { type }) };
  let egress: EgressReport;
  try {
    egress = await provider.use.egress(deps.signal);
  } catch (err) {
    deps.signal.throwIfAborted();
    return { unavailable: t('egressUnreadable', { type, category: category(err) }) };
  }
  if (!egressWithin(egress, spec.remoteAgentEgress)) {
    return { unavailable: t('egressExceeds', { type, mode: egress.mode, ceiling: spec.remoteAgentEgress }) };
  }
  if (provider.use.transcriptIsolation === 'shared') {
    if (!spec.name) return { unavailable: t('sharedNeedsName', { type }) };
    const blocked = (await deps.isolation.report(deps.signal)).blocked.get(spec.name);
    if (blocked) return { unavailable: blocked };
  }
  const paused = pausedReason(ledger.data, paper.paperId, type);
  return paused ? { unavailable: paused } : { provider };
}
