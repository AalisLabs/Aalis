// ============================================================
// 房间与资格：房间用哪块白纸、谁能发起、远端条件是否成立
//
// - 房间白纸：会话配置 paperEnabled 为 true 才开；写了 paperName 用同名的具名白纸，否则每个窗口（场所）一块。
// - 资格：交任务与取消只受理真人在房间会话本身里当面发起的回合（ctx.inbound 存在且 source 缺省、
//   有效授权身份的 userId 非空）；查状态与发成品只要求房间会话本身与入站回合。
// - 远端条件：提供者按白纸写的实例 id 精确取（不用 current，不回落到别的提供者），出网不超过白纸上限，
//   不违反同账号隔离，账本读取正常，白纸没有停开，提供者实例没有未读的账本外代理告警。
// - 共用：一块具名白纸被哪些房间共用（WebUI 白纸页与诊断项用），长期代理的对话与工作区对它们都可见。
// - 房间的开关与上限是本插件登记的会话设置项（ROOM_SETTINGS），只对房间适用，只能设到场所为止（按窗口设，换会话不丢），
//   不随建子会话复制。
// ============================================================

import {
  type EgressReport,
  egressWithin,
  type RemoteAgentEntry,
  type RemoteAgentProvider,
  resolveRemoteAgent,
} from '@aalis/api-remote-agent';
import {
  type InheritanceSource,
  placePaperId,
  SESSION_LAYERS,
  type SessionConfig,
  type SessionConfigLayer,
  type SessionInfo,
  type SessionInheritance,
  type SessionManagerService,
  type SessionSetting,
} from '@aalis/api-session-manager';
import type { ToolCallContext } from '@aalis/api-tools';
import type { Logger, ServiceRef } from '@aalis/core';
import type { PaperConfig, PaperSpec } from './config.js';
import type { LedgerStore, PaperLedger } from './ledger.js';
import { category, describe } from './util.js';

declare module '@aalis/api-session-manager' {
  interface SessionConfig {
    /** 本房间开启白纸（默认关） */
    paperEnabled?: boolean;
    /** 白纸名；不写则每个房间各一块，属性取白纸插件配置的 defaults */
    paperName?: string;
    /** 允许的远端代理类型（远端代理插件实例 id）；空或缺省即关 */
    remoteAgentTypes?: string[];
    /**
     * 每人每天金额上限（美分）；缺省不增加这一层限制，0 禁止新远端任务。写坏了的原值照样交出（字段标了
     * onInvalid: 'error'），预算按 0 处理
     */
    remoteAgentUserDailyCents?: unknown;
    /** 每人每天件数上限；缺省不按人限制 */
    remoteAgentUserDailyTasks?: number;
    /** 本房间每天金额上限（美分）；缺省、0 与写坏了的处理同每人每天金额 */
    remoteAgentRoomDailyCents?: unknown;
  }
}

/**
 * 房间专用的一项：只对房间适用，只能设到场所为止（按窗口设，换会话不丢），只经继承链实时解析（建子会话不复制，免得子会话
 * 凭冻结的值开远端任务）；unset 是没设时的含义
 */
const roomSetting = (
  order: number,
  key: SessionSetting['key'],
  field: SessionSetting['field'],
  unset?: string,
): SessionSetting => ({
  key,
  field,
  appliesTo: ['room'],
  narrowest: 'place',
  prominence: 'advanced',
  order,
  liveOnly: true,
  unset,
});

/** 本插件登记的会话设置项：房间的白纸开关与远端代理的类型、上限 */
export const ROOM_SETTINGS: SessionSetting[] = [
  roomSetting(0, 'paperEnabled', { type: 'boolean', label: '开启白纸', description: '这个房间开启白纸（默认关）' }),
  roomSetting(
    1,
    'paperName',
    {
      type: 'string',
      label: '白纸名',
      description: '留空则每个窗口各一块白纸，属性取白纸插件配置的 defaults；几个窗口写同一个名字就共用一块',
    },
    '每个窗口各一块',
  ),
  roomSetting(
    2,
    'remoteAgentTypes',
    {
      type: 'multiselect',
      label: '远端代理类型',
      allowCustom: true,
      description: '允许的远端代理插件实例 id；空即关',
    },
    '不允许',
  ),
  roomSetting(
    3,
    'remoteAgentUserDailyCents',
    {
      type: 'number',
      label: '每人每天金额上限（美分）',
      min: 0,
      onInvalid: 'error',
      description: '留空不增加每人金额限制，0 禁止新远端任务；写坏了按 0',
    },
    '不另加限制',
  ),
  roomSetting(
    4,
    'remoteAgentUserDailyTasks',
    {
      type: 'number',
      label: '每人每天件数上限',
      min: 0,
      description: '留空即不按人限制',
    },
    '不按人限制',
  ),
  roomSetting(
    5,
    'remoteAgentRoomDailyCents',
    {
      type: 'number',
      label: '每房间每天金额上限（美分）',
      min: 0,
      onInvalid: 'error',
      description: '留空不增加房间金额限制，0 禁止新远端任务；写坏了按 0',
    },
    '不另加限制',
  ),
];

export interface RoomPaper {
  /** n:<名>，或场所的白纸 id（api-session-manager 的 placePaperId） */
  paperId: string;
  spec: PaperSpec;
  /** 房间的生效会话配置 */
  room: SessionConfig;
}

/** 房间用哪块白纸；不开时给出原因。不写名字的用房间所在场所的那一块：同一个窗口里几个机器人账号的会话共用 */
export function resolveRoomPaper(
  sm: SessionManagerService,
  cfg: PaperConfig,
  sessionId: string,
  platform: string | undefined,
): RoomPaper | { unavailable: string } {
  const room = sm.resolveConfig(sessionId, platform);
  if (room.paperEnabled !== true) return { unavailable: '本房间没有开启白纸' };
  const name = room.paperName?.trim() ?? '';
  if (!name) return { paperId: placePaperId(sm.placeOf(sessionId).key), spec: cfg.defaults, room };
  const broken = cfg.brokenPapers.get(name);
  if (broken) return { unavailable: `白纸「${name}」的配置有误（${broken}），改对之前不能用` };
  const spec = cfg.papers.get(name);
  if (!spec) return { unavailable: `本房间写的白纸「${name}」不存在（白纸插件配置的 papers 里没有这个名字）` };
  return { paperId: `n:${name}`, spec, room };
}

/** 白纸在页面与诊断里的称呼：具名白纸用名字，房间白纸用 id */
export function paperLabel(paperId: string): string {
  return paperId.startsWith('n:') ? paperId.slice(2) : `房间白纸 ${paperId}`;
}

/** 已登记的 IM 房间与各自的继承链：某个键落到了哪些房间、来自哪一层，对房间逐个看 */
function imRoomInheritance(
  sm: SessionManagerService,
): Array<{ session: SessionInfo; inheritance: SessionInheritance }> {
  return sm
    .listSessions()
    .filter(session => session.kind === 'room')
    .map(session => ({ session, inheritance: sm.resolveInheritance(session.id) }));
}

/** 覆盖一类房间的层：平台档覆盖这个平台的全部房间，平台类型档覆盖这个平台这种类型的全部房间（包括还没登记的） */
type ProfileLayer = Extract<SessionConfigLayer, { scope: 'platform' | 'type' }>;

/** 房间的白纸设置继承自这几层时算进共用：覆盖一类房间的两档与房间所在的窗口 */
const SHARING_SOURCES: ReadonlySet<InheritanceSource> = new Set(['platform', 'type', 'place']);

/** 写了某个设置项的平台档与平台类型档，各带这一层的值 */
export function layersWith<K extends 'paperName' | 'remoteAgentTypes'>(
  sm: SessionManagerService,
  key: K,
): Array<{ layer: ProfileLayer; value: NonNullable<SessionConfig[K]> }> {
  const found: Array<{ layer: ProfileLayer; value: NonNullable<SessionConfig[K]> }> = [];
  for (const layer of sm.listLayers()) {
    if (layer.scope !== 'platform' && layer.scope !== 'type') continue;
    const value = sm.getLayer(layer)[key];
    if (value !== undefined) found.push({ layer, value });
  }
  return found;
}

/** 平台档与平台类型档的称呼：层表里的称呼加平台（与类型名），如「平台档 onebot」「平台类型档 onebot · group」 */
export function profileName(layer: ProfileLayer): string {
  const label = SESSION_LAYERS.find(({ name }) => name === layer.scope)?.label;
  return layer.scope === 'type' ? `${label} ${layer.platform} · ${layer.type}` : `${label} ${layer.platform}`;
}

/**
 * 共用一块白纸的房间：已登记的 IM 房间里，从平台档、平台类型档或所在窗口的场所继承了这个白纸名的；写了它的平台档与平台
 * 类型档（覆盖一类房间，包括还没登记的）；以及账本里还没结束、或在上次清空之后才结束的任务所在的房间（它们的原文还在代理的
 * 对话与工作区里；清空时白纸上没有在跑的任务，之前结束的随代理一起删了）。不写名字的白纸只有账本里的房间。
 * labels 是显示用的称呼（房间会话 id，两档写成「平台档 X 的全部房间」「平台类型档 X · T 的全部房间」）；
 * shared：多于一个房间，或有平台档、平台类型档写了它。
 */
export function sharingRooms(
  sm: SessionManagerService,
  ledger: PaperLedger,
  paperId: string,
): { labels: string[]; shared: boolean } {
  const rooms = new Set<string>();
  const profiles = new Set<string>();
  if (paperId.startsWith('n:')) {
    const name = paperId.slice(2);
    const names = (value: string | undefined) => value?.trim() === name;
    for (const { layer, value } of layersWith(sm, 'paperName')) {
      if (names(value)) profiles.add(`${profileName(layer)} 的全部房间`);
    }
    for (const { session, inheritance } of imRoomInheritance(sm)) {
      const source = inheritance.sources.paperName;
      if (source && SHARING_SOURCES.has(source) && names(inheritance.values.paperName)) rooms.add(session.id);
    }
  }
  const since = ledger.papers[paperId]?.lastClearedAt ?? 0;
  for (const task of Object.values(ledger.tasks)) {
    if (task.paperId === paperId && (task.endedAt === undefined || task.endedAt > since)) rooms.add(task.room);
  }
  return { labels: [...rooms, ...profiles], shared: rooms.size > 1 || profiles.size > 0 };
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
 * 取不到时分开给出两样：拒绝理由（会写进任务与完成通知，也交给模型）只用宿主撰写的类别；提供者报错的原文
 * （按契约已去掉凭据与查询串，但可能有远端说明与本机网络细节）只进 warn 与诊断项。同一实例同一类别只记一次 warn
 * （原文每次可能不同，如带请求号）。
 */
export class Isolation {
  /** 提供者实例 id → 上次记 warn 的类别；取到 accountKey 后清掉 */
  readonly #warned = new Map<string, string>();

  constructor(
    private readonly remote: ServiceRef<RemoteAgentProvider>,
    private readonly papers: ReadonlyMap<string, PaperSpec>,
    private readonly logger: Logger,
  ) {}

  async #accountKey(
    entry: RemoteAgentEntry,
    signal: AbortSignal,
  ): Promise<{ key: string } | { category: string; detail: string }> {
    let failure: { category: string; detail: string };
    try {
      const { accountKey } = await entry.instance.ready(signal);
      if (accountKey) {
        this.#warned.delete(entry.contextId);
        return { key: accountKey };
      }
      failure = { category: '账号标识为空', detail: 'ready() 报告的 accountKey 为空' };
    } catch (err) {
      failure = { category: category(err), detail: describe(err) };
    }
    if (this.#warned.get(entry.contextId) !== failure.category) {
      this.#warned.set(entry.contextId, failure.category);
      this.logger.warn(`取不到提供者「${entry.contextId}」的远端账号标识，按冲突处理：${failure.detail}`);
    }
    return failure;
  }

  /**
   * 引用 shared 提供者的具名白纸各自能不能开：blocked 为白纸名到原因（只含类别）；collisions 是确认同账号的
   * 几块白纸，unknown 是取不到账号标识的提供者实例、引用它的白纸、类别与提供者报错的原文（只给诊断项）。
   */
  async report(signal: AbortSignal): Promise<{
    blocked: Map<string, string>;
    collisions: string[][];
    unknown: Array<{ type: string; papers: string[]; category: string; detail: string }>;
  }> {
    const byType = new Map<string, { entry: RemoteAgentEntry; names: string[] }>();
    for (const [name, spec] of this.papers) {
      const entry = resolveRemoteAgent(this.remote, spec.remoteAgentType);
      if (entry?.instance.transcriptIsolation !== 'shared') continue;
      const group = byType.get(entry.contextId) ?? { entry, names: [] };
      group.names.push(name);
      byType.set(entry.contextId, group);
    }
    const byAccount = new Map<string, string[]>();
    const unknown: Array<{ type: string; papers: string[]; category: string; detail: string }> = [];
    await Promise.all(
      [...byType].map(async ([type, { entry, names }]) => {
        const result = await this.#accountKey(entry, signal);
        if ('key' in result) byAccount.set(result.key, [...(byAccount.get(result.key) ?? []), ...names]);
        else unknown.push({ type, papers: names, ...result });
      }),
    );
    const blocked = new Map<string, string>();
    for (const { type, papers, category } of unknown) {
      for (const name of papers) {
        blocked.set(name, `取不到提供者「${type}」的远端账号标识（${category}），按与其他白纸同账号处理`);
      }
    }
    const collisions = [...byAccount.values()].filter(names => names.length > 1);
    for (const names of byAccount.values()) {
      for (const name of names) {
        if (names.length > 1) {
          blocked.set(name, `白纸 ${names.join('、')} 用的提供者在同一远端账号下（同账号的代理能互读对话）`);
        } else if (unknown.length > 0) {
          const causes = unknown.map(u => `「${u.type}」的远端账号标识（${u.category}）`).join('、');
          blocked.set(name, `取不到提供者${causes}，按与本白纸同账号处理`);
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
    return { unavailable: `取不到远端代理「${type}」的出网方式（${category(err)}）` };
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
