// ════════════════════════════════════════════════════════════
// 会话列表与会话的增删改：摘要、分区与分组、排序与分页、搜索、按组取与归档区；建、改名、归档与恢复、删除与批量；
// 会话设置的各行（会话与各层）；已读。会话本身都在 session-manager 里，这里只做投影与转发。
// 「需要我处理」由未结的审批驱动；房间按接管的适配器实例分组，组名取实例的显示名。
// ════════════════════════════════════════════════════════════

import { type PlatformAdapter, resolvePlatformBySession } from '@aalis/api-platform';
import {
  isSessionConfigError,
  type RegisteredSessionSetting,
  type SessionConfig,
  type SessionConfigPatch,
  type SessionInfo,
  type SessionKind,
  type SessionManagerService,
} from '@aalis/api-session-manager';
import {
  type RoomGroup,
  RPC_ERROR_CODES,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionPeer,
  type SessionSummary,
  type SettingRow,
} from '@aalis/api-session-protocol';
import type { Logger, PluginManagerService, ServiceRef } from '@aalis/core';
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
  /** 摘要因会话表之外的原因变了（已读），推给 watch 的连接 */
  changed(sessionId: string): void;
  platform: ServiceRef<PlatformAdapter>;
  /** 组名：适配器实例的显示名 */
  plugins: Pick<PluginManagerService, 'getPlugin'>;
  logger: Logger;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const KIND_NAMES: Record<SessionKind, string> = { owner: '我的会话', room: '房间', task: '子任务' };

/** 输入框旁的快捷切换最多放几项：多出的 composer 退到 common */
const COMPOSER_LIMIT = 2;
const PROMINENCE_RANK = { composer: 0, common: 1, advanced: 2 } as const;

/** 显眼程度在前，同一显眼程度按 order，没给 order 的按登记的先后排在后面（排序是稳定的） */
const byProminence = (a: RegisteredSessionSetting, b: RegisteredSessionSetting) =>
  PROMINENCE_RANK[a.prominence] - PROMINENCE_RANK[b.prominence] ||
  (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY);

/** 写设置被拒（没登记的键、不合字段的值、不合法的层）是参数错误，别的照常上抛 */
async function writing(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (isSessionConfigError(err)) throw new ProtocolError(RPC_ERROR_CODES.invalidParams, (err as Error).message);
    throw err;
  }
}

/**
 * 搜索：名称、标题、id 包含查询串（不分大小写），或查询串是「平台:群号」——
 * 平台是会话 id 第一段、群号是最后一段（onebot:20001 命中 onebot:<账号>:group:20001）
 */
function matches(info: SessionInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if ([info.title, info.name, info.id].some(v => v?.toLowerCase().includes(q))) return true;
  const [platform, target, ...rest] = q.split(':');
  const segments = info.id.toLowerCase().split(':');
  return rest.length === 0 && target !== undefined && segments[0] === platform && segments.at(-1) === target;
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

  /** 会话所在的区：按根会话的种类，子会话归在根会话的区里 */
  const sectionOfRoot = (root: SessionInfo) => (root.kind === 'room' ? 'rooms' : 'owner');
  const sectionOf = (info: SessionInfo) => sectionOfRoot(rootOf(info));

  function summarize(info: SessionInfo): SessionSummary {
    const root = rootOf(info);
    const room = root.kind === 'room';
    const seenAt = seen.get(info.id);
    return {
      id: info.id,
      title: info.title || info.name,
      parentId: info.parentId,
      childCount: info.children.length,
      kind: info.kind,
      section: sectionOfRoot(root),
      platform: info.originPlatform,
      instance: info.originInstance,
      // 房间 id 是「平台:账号:类型:对象」，第二段是机器人账号
      account: room ? root.id.split(':')[1] : undefined,
      audience: info.audience,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      lastReplyAt: info.lastReplyAt,
      running: deps.isRunning(info.id),
      error: info.status === 'error',
      unread: !room && info.lastReplyAt !== undefined && (seenAt === undefined || info.lastReplyAt > seenAt),
      attention: deps.hasApproval(info.id),
      archived: info.status === 'archived',
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
      group.accounts.add(info.id.split(':')[1]);
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
   * 子会话按最后活动。缺省不含已归档的，archived 为真时只列已归档的；instance、platform 只列一组房间。
   */
  function list(params: SessionMethodParams<'sessions/list'>): SessionMethodResult<'sessions/list'> {
    if (params.cursor !== undefined && !/^\d+$/.test(params.cursor)) {
      throw new ProtocolError(RPC_ERROR_CODES.invalidParams, `cursor 无效：${params.cursor}`);
    }
    const parent = params.parentId === undefined ? undefined : requireSession(params.parentId);
    const archived = params.archived ?? false;
    let rows = (parent ? sm.getChildren(parent.id) : sm.listSessions({ parentId: null })).filter(
      info => (info.status === 'archived') === archived,
    );
    const { instance, platform } = params;
    if (instance !== undefined) rows = rows.filter(info => info.originInstance === instance);
    if (platform !== undefined) {
      rows = rows.filter(info => info.originPlatform === platform && info.originInstance === undefined);
    }
    if (params.query) rows = rows.filter(info => matches(info, params.query ?? ''));
    let summaries = rows.map(summarize);
    if (!parent && params.section) summaries = summaries.filter(s => s.section === params.section);
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
   * 都没有时取这条连接的平台。房间钉死出生平台，不看入口。
   */
  async function entryPlatform(session: SessionInfo, peer: SessionPeer): Promise<string | undefined> {
    if (session.originPlatform) return undefined;
    const recorded = session.metadata?.platform;
    if (typeof recorded === 'string' && recorded) return recorded;
    const adapter = await resolvePlatformBySession(deps.platform, session.id, deps.logger);
    return adapter?.instance.platform ?? peer.identity.platform;
  }

  /**
   * 设置项的各行：只列 applies 选中的项，排好显眼程度与先后，composer 多出的退到 common。own 是这一层自己的值，
   * effective 与 sources 是解析到这一层为止（含这一层）的生效值与来源
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
      })),
    };
  }

  /** 一个会话的各行：只列适用于它的种类的项，本层是会话自己的覆盖 */
  async function sessionRows(
    session: SessionInfo,
    peer: SessionPeer,
  ): Promise<SessionMethodResult<'session/config/get'>> {
    const platform = await entryPlatform(session, peer);
    const inheritance = sm.resolveInheritance(session.id, platform);
    const own = sm.getOwnConfig(session.id);
    const sources: Record<string, SettingRow['source']> = { ...inheritance.sources };
    for (const key of Object.keys(own)) sources[key] = 'session';
    return rows(setting => setting.appliesTo.includes(session.kind), own, { ...inheritance.values, ...own }, sources);
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

  /** 一层的各行：受众条目只列适用于房间的项，全局默认与平台档列全部 */
  function layerRows(layer: SessionMethodParams<'session/config/layer/get'>['layer']) {
    const { values, sources } = sm.resolveLayer(layer);
    const applies =
      layer.scope === 'audience'
        ? (setting: RegisteredSessionSetting) => setting.appliesTo.includes('room')
        : () => true;
    return rows(applies, sm.getLayer(layer), values, sources);
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
      const session = await sm.createSession({ name, parentId, config, createdBy: 'user', status: 'waiting' });
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
      await writing(() => sm.updateSession(sessionId, { config: patch as SessionConfigPatch }));
      return sessionRows(requireSession(sessionId), conn.peer);
    },
    'session/config/layers': () => ({ layers: sm.listLayers() }),
    'session/config/layer/get': ({ layer }) => layerRows(layer),
    'session/config/layer/update': async ({ layer, patch }) => {
      if (layer.scope === 'audience') assertApplies('room', patch);
      await writing(() => sm.updateLayer(layer, patch as SessionConfigPatch));
      return layerRows(layer);
    },
    'session/markSeen': async ({ sessionId }) => {
      requireSession(sessionId);
      await seen.mark(sessionId, Date.now());
      deps.changed(sessionId);
      return {};
    },
  };

  return { handlers, summarize, groups, requireSession, sectionOf };
}
