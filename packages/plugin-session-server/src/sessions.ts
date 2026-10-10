// ════════════════════════════════════════════════════════════
// 会话列表与会话的增删改：摘要、分区与分组、排序与分页、搜索、按组取与归档区；建、改名、归档与恢复、删除与批量；
// 会话设置的各行（会话与各层，层表取自 api-session-manager）；已读。会话本身都在 session-manager 里，这里只做投影与转发。
// 「需要我处理」由未结的审批驱动；房间按接管的适配器实例分组，组名取实例的显示名。
// 摘要里有几项按会话树算：在跑的后台工作数与 token 合计含各级子会话，子会话另带各级父会话；聊天窗口与场所取根会话的。
// ════════════════════════════════════════════════════════════

import { type PlatformAdapter, resolvePlatformBySession } from '@aalis/api-platform';
import {
  isSessionConfigError,
  type RegisteredSessionSetting,
  SESSION_LAYERS,
  type SessionConfig,
  type SessionConfigPatch,
  type SessionInfo,
  type SessionKind,
  type SessionManagerService,
  type SessionPlace,
} from '@aalis/api-session-manager';
import {
  type RoomGroup,
  RPC_ERROR_CODES,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionPeer,
  type SessionSummary,
  type SettingLayer,
  type SettingRow,
} from '@aalis/api-session-protocol';
import type { Logger, PluginManagerService, ServiceSelection } from '@aalis/core';
import { failure, type MethodHandlers, ProtocolError } from './connection.js';
import type { SeenStore } from './seen.js';

/** 列表一页的默认条数 */
const PAGE_SIZE = 50;

interface SessionDeps {
  sm: SessionManagerService;
  seen: SeenStore;
  /** 这个会话有没有回合在跑 */
  isRunning(sessionId: string): boolean;
  /** 这个会话有没有推出、还没结的审批 */
  hasApproval(sessionId: string): boolean;
  /** 各会话在跑的后台任务数：要遍历登记表，一批摘要取一次 */
  runningTasks(): ReadonlyMap<string, number>;
  /** 摘要因会话表之外的原因变了（已读），推给 watch 的连接 */
  changed(sessionId: string): void;
  platform: ServiceSelection<PlatformAdapter>;
  /** 组名：适配器实例的显示名 */
  plugins: Pick<PluginManagerService, 'getPlugin'>;
  logger: Logger;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const KIND_NAMES: Record<SessionKind, string> = { owner: '我的会话', room: '房间', task: '子任务' };
/** 场所按它的类别列与收设置项：窗口按房间，工作区按 owner 的会话 */
const PLACE_KINDS: Record<SessionPlace['kind'], SessionKind> = { window: 'room', workspace: 'owner' };
/** 层表：名字与称呼，按先后 */
const LAYER_ORDER = SESSION_LAYERS.map(({ name, label }) => ({ name, label }));

/** 输入框旁的快捷切换最多放几项：多出的 composer 退到 common */
const COMPOSER_LIMIT = 2;
const PROMINENCE_RANK = { composer: 0, common: 1, advanced: 2 } as const;

/** 显眼程度在前，同一显眼程度按 order，没给 order 的按登记的先后排在后面（排序是稳定的） */
const byProminence = (a: RegisteredSessionSetting, b: RegisteredSessionSetting) =>
  PROMINENCE_RANK[a.prominence] - PROMINENCE_RANK[b.prominence] ||
  (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);

/** 会话管理拒绝的读写（没登记的键、不合字段的值、只能设到场所为止的项、不合法的层）是参数错误，别的照常上抛 */
async function checked<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isSessionConfigError(err)) throw new ProtocolError(RPC_ERROR_CODES.invalidParams, (err as Error).message);
    throw err;
  }
}

/**
 * 搜索：名称、标题、id 包含查询串（不分大小写），或查询串是「平台:目标」——出生平台与聊天窗口的目标
 * （群号或对端账号），如 onebot:20001 命中 QQ 群 20001
 */
function matches(info: SessionInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if ([info.title, info.name, info.id].some(v => v?.toLowerCase().includes(q))) return true;
  const at = q.indexOf(':');
  return (
    at > 0 &&
    info.originPlatform?.toLowerCase() === q.slice(0, at) &&
    info.originChat?.targetId.toLowerCase() === q.slice(at + 1)
  );
}

export function createSessions(deps: SessionDeps) {
  const { sm, seen } = deps;

  const requireSession = (id: string): SessionInfo => {
    const session = sm.getSession(id);
    if (!session) throw failure('not-found', `会话不存在：${id}`);
    return session;
  };

  const parentOf = (info: SessionInfo) => (info.parentId ? sm.getSession(info.parentId) : undefined);

  const rootOf = (info: SessionInfo) => {
    let root = info;
    for (let parent = parentOf(root); parent; parent = parentOf(root)) root = parent;
    return root;
  };

  /** 各级父会话，根会话在前 */
  const ancestorsOf = (info: SessionInfo): SessionInfo[] => {
    const parent = parentOf(info);
    return parent ? [...ancestorsOf(parent), parent] : [];
  };

  /** 各级子会话 */
  const descendantsOf = (info: SessionInfo): SessionInfo[] =>
    info.children.flatMap(id => {
      const child = sm.getSession(id);
      return child ? [child, ...descendantsOf(child)] : [];
    });

  /** 会话所在的区：按根会话的种类，子会话归在根会话的区里 */
  const sectionOfRoot = (root: SessionInfo) => (root.kind === 'room' ? 'rooms' : 'owner');
  const sectionOf = (info: SessionInfo) => sectionOfRoot(rootOf(info));

  /** 本会话与各级子会话的 token 合计；都还没有时没有 */
  function tokensOf(tree: SessionInfo[]): SessionSummary['tokens'] {
    const counted = tree.flatMap(info => (info.tokens ? [info.tokens] : []));
    if (counted.length === 0) return undefined;
    return counted.reduce((sum, t) => ({ input: sum.input + t.input, output: sum.output + t.output }));
  }

  /** 会话的场所：键与类别取 placeOf，显示名取场所记录（窗口还没有记录时是场所键） */
  function placeOf(info: SessionInfo): SessionSummary['place'] {
    const place = sm.placeOf(info.id);
    return { ...place, name: sm.getPlace(place.key)?.name ?? place.key };
  }

  /** tasks 是各会话在跑的后台任务数，一批摘要共用一份 */
  function summarize(info: SessionInfo, tasks: ReadonlyMap<string, number> = deps.runningTasks()): SessionSummary {
    const root = rootOf(info);
    const room = root.kind === 'room';
    const chat = root.originPlatform === undefined ? undefined : root.originChat;
    const seenAt = seen.get(info.id);
    const below = descendantsOf(info);
    const tokens = tokensOf([info, ...below]);
    const ancestors = ancestorsOf(info).map(parent => ({ id: parent.id, title: parent.title || parent.name }));
    const reason = info.status === 'error' ? info.lastTurn?.error : undefined;
    return {
      id: info.id,
      title: info.title || info.name,
      parentId: info.parentId,
      childCount: info.children.length,
      kind: info.kind,
      section: sectionOfRoot(root),
      platform: root.originPlatform,
      instance: info.originInstance,
      account: root.originChat?.selfId,
      ...(chat ? { chat: { type: chat.type, multiParty: chat.multiParty } } : {}),
      place: placeOf(info),
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      lastReplyAt: info.lastReplyAt,
      running: deps.isRunning(info.id),
      error: info.status === 'error',
      unread: !room && info.lastReplyAt !== undefined && (seenAt === undefined || info.lastReplyAt > seenAt),
      attention: deps.hasApproval(info.id),
      archived: info.status === 'archived',
      background:
        (tasks.get(info.id) ?? 0) + below.filter(child => deps.isRunning(child.id) || tasks.has(child.id)).length,
      ...(tokens ? { tokens } : {}),
      ...(info.lastTurn ? { lastTurn: { outcome: info.lastTurn.outcome, endedAt: info.lastTurn.endedAt } } : {}),
      ...(reason === undefined ? {} : { reason }),
      ...(ancestors.length > 0 ? { ancestors } : {}),
    };
  }

  /** 适配器实例的显示名：插件的显示名（没有时用包名），非默认实例另带实例名；插件已不在的用实例 id */
  function instanceLabel(instance: string): string {
    const definition = deps.plugins.getPlugin(instance)?.definition;
    if (!definition) return instance;
    const name = definition.displayName ?? definition.name;
    return instance === definition.name ? name : `${name}（${instance.slice(definition.name.length + 1)}）`;
  }

  /** 没归档的房间按接管的适配器实例分组；还没记下实例的按平台成一组，排在同平台各实例之后 */
  function groups(): RoomGroup[] {
    type Group = Omit<RoomGroup, 'accounts'> & { accounts: Set<string> };
    const byKey = new Map<string, Group>();
    for (const info of sm.listSessions({ parentId: null })) {
      const platform = info.originPlatform;
      if (!platform || info.status === 'archived') continue;
      const key = JSON.stringify([platform, info.originInstance]);
      const group = byKey.get(key) ?? {
        platform,
        instance: info.originInstance,
        label: info.originInstance === undefined ? platform : instanceLabel(info.originInstance),
        rooms: 0,
        accounts: new Set(),
        attention: 0,
      };
      group.rooms++;
      if (info.originChat?.selfId !== undefined) group.accounts.add(info.originChat.selfId);
      if (deps.hasApproval(info.id)) group.attention++;
      byKey.set(key, group);
    }
    return [...byKey.values()]
      .map(({ accounts, ...group }) => ({ ...group, accounts: accounts.size }))
      .sort(
        (a, b) =>
          compare(a.platform, b.platform) ||
          Number(a.instance === undefined) - Number(b.instance === undefined) ||
          compare(a.instance ?? '', b.instance ?? ''),
      );
  }

  /**
   * 根会话：「我的」区在前，需要我处理、出错、完成未读、运行中依次靠前，其余按最后活动；房间在后，按最后活动。
   * 子会话按最后活动。缺省不含已归档的，archived 为真时只列已归档的；background 只列有后台工作的，归档与否都列；
   * instance、platform 只列一组房间。
   */
  function list(params: SessionMethodParams<'sessions/list'>): SessionMethodResult<'sessions/list'> {
    if (params.cursor !== undefined && !/^\d+$/.test(params.cursor)) {
      throw new ProtocolError(RPC_ERROR_CODES.invalidParams, `cursor 无效：${params.cursor}`);
    }
    const parent = params.parentId === undefined ? undefined : requireSession(params.parentId);
    const archived = params.archived ?? false;
    let rows = (parent ? sm.getChildren(parent.id) : sm.listSessions({ parentId: null })).filter(
      info => params.background || (info.status === 'archived') === archived,
    );
    const { instance, platform } = params;
    if (instance !== undefined) rows = rows.filter(info => info.originInstance === instance);
    if (platform !== undefined) {
      rows = rows.filter(info => info.originPlatform === platform && info.originInstance === undefined);
    }
    if (params.query) rows = rows.filter(info => matches(info, params.query ?? ''));
    const tasks = deps.runningTasks();
    let summaries = rows.map(info => summarize(info, tasks));
    if (!parent && params.section) summaries = summaries.filter(s => s.section === params.section);
    if (params.background) summaries = summaries.filter(s => s.background > 0);
    const rank = (s: SessionSummary) =>
      parent ? 0 : s.section === 'rooms' ? 5 : s.attention ? 0 : s.error ? 1 : s.unread ? 2 : s.running ? 3 : 4;
    summaries.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);

    const offset = Number(params.cursor ?? 0);
    const end = offset + (params.limit ?? PAGE_SIZE);
    return {
      sessions: summaries.slice(offset, end),
      nextCursor: end < summaries.length ? String(end) : undefined,
      groups: groups(),
    };
  }

  /** 归档会话连同子会话 */
  async function archive(id: string): Promise<void> {
    const session = sm.getSession(id);
    if (!session) return;
    for (const child of session.children) await archive(child);
    if (session.status !== 'archived') await sm.updateSession(id, { status: 'archived' });
  }

  /** 恢复归档的会话连同子会话：回到最后一轮收尾后的状态（completed） */
  async function unarchive(id: string): Promise<void> {
    const session = sm.getSession(id);
    if (!session) return;
    if (session.status === 'archived') await sm.updateSession(id, { status: 'completed' });
    for (const child of session.children) await unarchive(child);
  }

  /**
   * owner 自己的会话按哪个入口平台选档：会话记下的平台（子任务建档时写入）、接管会话 id 的平台适配器，
   * 都没有时取这条连接的平台。房间与它的子会话钉死出生平台，不看入口。
   */
  async function entryPlatform(session: SessionInfo, peer: SessionPeer): Promise<string | undefined> {
    if (rootOf(session).originPlatform) return undefined;
    const recorded = session.metadata?.platform;
    if (typeof recorded === 'string' && recorded) return recorded;
    const adapter = await resolvePlatformBySession(deps.platform, session.id, deps.logger);
    return adapter?.use.platform ?? peer.identity.platform;
  }

  /**
   * 设置项的各行：只列 applies 选中的项，排好显眼程度与先后，composer 多出的退到 common。own 是这一层自己的值，
   * effective 与 sources 是解析到这一层为止（含这一层）的生效值与来源。生效值出自全局默认或哪一层都没设的行另带服务此刻实际
   * 用的那一个（只有全局默认层由服务偏好承担的项有）
   */
  function rows(
    applies: (setting: RegisteredSessionSetting) => boolean,
    own: SessionConfig,
    effective: SessionConfig,
    sources: Record<string, SettingRow['source']>,
  ): SessionMethodResult<'session/config/get'> {
    let composers = 0;
    const settings = sm
      .listSettings()
      .filter(applies)
      .sort(byProminence)
      .map(setting =>
        setting.prominence === 'composer' && ++composers > COMPOSER_LIMIT
          ? { ...setting, prominence: 'common' as const }
          : setting,
      )
      .sort(byProminence);
    const ownValues = own as Record<string, unknown>;
    const effectiveValues = effective as Record<string, unknown>;
    const resolved = sm.resolvedDefaults() as Record<string, unknown>;
    return {
      items: settings.map(({ key, field, plugin, prominence, dependsOn, unset }) => ({
        key,
        field,
        plugin,
        prominence,
        dependsOn,
        unset,
        value: ownValues[key],
        effective: effectiveValues[key],
        source: sources[key],
        resolved: sources[key] === undefined || sources[key] === 'defaults' ? resolved[key] : undefined,
      })),
    };
  }

  /** 一个会话的各行：只列适用于它的种类的项，只能设到场所为止的不列；本层是会话自己的覆盖 */
  async function sessionRows(
    session: SessionInfo,
    peer: SessionPeer,
  ): Promise<SessionMethodResult<'session/config/get'>> {
    const platform = await entryPlatform(session, peer);
    const inheritance = sm.resolveInheritance(session.id, platform);
    const own = sm.getOwnConfig(session.id);
    const sources: Record<string, SettingRow['source']> = { ...inheritance.sources };
    for (const key of Object.keys(own)) sources[key] = 'session';
    return rows(
      setting => setting.appliesTo.includes(session.kind) && !setting.narrowest,
      own,
      { ...inheritance.values, ...own },
      sources,
    );
  }

  /**
   * 写入只收适用于这个种类的项：不适用的写进去照样参与解析，界面却列不出来、恢复不了继承。null 照常放行，
   * 好让已经写进去的清得掉；没登记的键由会话管理拒绝
   */
  function assertApplies(kind: SessionKind, patch: Record<string, unknown>): void {
    const settings = sm.listSettings();
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) continue;
      const setting = settings.find(s => s.key === key);
      if (setting && !setting.appliesTo.includes(kind)) {
        throw new ProtocolError(RPC_ERROR_CODES.invalidParams, `会话设置项 ${key} 不适用于${KIND_NAMES[kind]}`);
      }
    }
  }

  /**
   * 一层按哪种会话列与收设置项：场所按它的类别；全局默认、平台档与平台类型档不限（owner 的 IM 私聊带平台类型，场所却是
   * 工作区，两类项都可能落到它）。没有记录的场所键由会话管理拒绝
   */
  function layerKind(layer: SettingLayer): SessionKind | undefined {
    if (layer.scope !== 'place') return undefined;
    const place = sm.getPlace(layer.key);
    return place && PLACE_KINDS[place.kind];
  }

  /** 一层的各行：只列这一层适用的项，各带解析到这一层为止的生效值与来源 */
  function layerRows(layer: SettingLayer) {
    const kind = layerKind(layer);
    return checked(() => {
      const { values, sources } = sm.resolveLayer(layer);
      return rows(
        setting => kind === undefined || setting.appliesTo.includes(kind),
        sm.getLayer(layer),
        values,
        sources,
      );
    });
  }

  const handlers: Pick<
    MethodHandlers,
    | 'sessions/list'
    | 'sessions/watch'
    | 'session/create'
    | 'session/rename'
    | 'session/archive'
    | 'session/unarchive'
    | 'session/delete'
    | 'session/batch'
    | 'session/config/get'
    | 'session/config/update'
    | 'session/config/layers'
    | 'session/config/layer/get'
    | 'session/config/layer/update'
    | 'session/markSeen'
  > = {
    'sessions/list': list,
    'sessions/watch': (_params, conn) => {
      conn.watching = true;
      return {};
    },
    'session/create': async ({ name, parentId }, conn) => {
      const parent = parentId === undefined ? undefined : requireSession(parentId);
      // 根会话不复制各层，配置经继承链实时生效；子会话复制父会话的生效配置（继承链不经父会话自己的配置）
      const config = parent ? sm.childConfig(parent.id, await entryPlatform(parent, conn.peer)) : {};
      // 根会话的创建来源取这条连接所在审批面的登记名（传输层登记得到），不取连接自报的；子会话不带，按根会话取
      const session = await sm.createSession(
        { name, parentId, config, status: 'waiting' },
        parent ? undefined : { createdFrom: conn.peer.surface.name },
      );
      return { session: summarize(session) };
    },
    'session/rename': async ({ sessionId, title }) => {
      requireSession(sessionId);
      await sm.updateSessionTitle(sessionId, title);
      return {};
    },
    'session/archive': async ({ sessionId }) => {
      await archive(requireSession(sessionId).id);
      return {};
    },
    'session/unarchive': async ({ sessionId }) => {
      await unarchive(requireSession(sessionId).id);
      return {};
    },
    'session/delete': async ({ sessionId }) => {
      requireSession(sessionId);
      await sm.deleteSession(sessionId);
      return {};
    },
    'session/batch': async ({ op, ids }) => {
      const failed: Array<{ sessionId: string; message: string }> = [];
      // 只有开始前就不存在的算失败：删父会话时一并删掉的子会话不算
      const present = ids.filter(id => sm.getSession(id) !== undefined);
      for (const id of ids) if (!present.includes(id)) failed.push({ sessionId: id, message: `会话不存在：${id}` });
      for (const id of present) {
        try {
          await (op === 'archive' ? archive(id) : sm.deleteSession(id));
        } catch (err) {
          failed.push({ sessionId: id, message: err instanceof Error ? err.message : String(err) });
        }
      }
      return { failed };
    },
    'session/config/get': ({ sessionId }, conn) => sessionRows(requireSession(sessionId), conn.peer),
    'session/config/update': async ({ sessionId, patch }, conn) => {
      assertApplies(requireSession(sessionId).kind, patch);
      await checked(() => sm.updateSession(sessionId, { config: patch as SessionConfigPatch }));
      return sessionRows(requireSession(sessionId), conn.peer);
    },
    'session/config/layers': () => ({ layers: sm.listLayers(), order: LAYER_ORDER }),
    'session/config/layer/get': ({ layer }) => layerRows(layer),
    'session/config/layer/update': async ({ layer, patch }) => {
      const kind = layerKind(layer);
      if (kind) assertApplies(kind, patch);
      await checked(() => sm.updateLayer(layer, patch as SessionConfigPatch));
      return layerRows(layer);
    },
    'session/markSeen': async ({ sessionId }) => {
      requireSession(sessionId);
      await seen.mark(sessionId, Date.now());
      deps.changed(sessionId);
      return {};
    },
  };

  return { handlers, summarize, groups, requireSession, sectionOf, ancestorsOf, descendantsOf };
}
