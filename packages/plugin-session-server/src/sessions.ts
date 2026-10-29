// ════════════════════════════════════════════════════════════
// 会话列表与会话的增删改：摘要、分区与分组、排序与分页、搜索、按组取与归档区；建、改名、归档与恢复、删除与批量；
// 会话设置（行、层、写入与写过的各处，转给会话设置的管理面，层表取自 api-session-settings）；已读。会话本身都在
// session-manager 里，这里只做投影与转发。
// 「需要我处理」由未结的审批驱动；房间按接管的适配器实例分组，组名取实例的显示名。
// 摘要里有几项按会话树算：需要我处理、在跑的后台工作数与 token 合计含各级子会话，子会话另带各级父会话；聊天窗口与场所取
// 根会话的。
// ════════════════════════════════════════════════════════════

import { saveFailureText } from '@aalis/api-host-config';
import { type PlatformAdapter, resolvePlatformBySession } from '@aalis/api-platform';
import {
  isUnfiled,
  placeLabel,
  type SessionInfo,
  type SessionManagerService,
  sessionLabel,
} from '@aalis/api-session-manager';
import {
  type RoomGroup,
  RPC_ERROR_CODES,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionPeer,
  type SessionSummary,
} from '@aalis/api-session-protocol';
import {
  isSessionSettingsError,
  SESSION_LAYERS,
  SETTINGS_ABSENT,
  type SessionSettingsAdmin,
  type SessionSettingsLayer,
} from '@aalis/api-session-settings';
import type { Logger, PluginManagerService, ServiceSelection } from '@aalis/core';
import { asText, type TextRef, textOf } from '@aalis/schema-i18n';
import { failure, type MethodHandlers, ProtocolError } from './connection.js';
import type { SeenStore } from './seen.js';
import { t } from './texts.js';

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
  /** 会话设置的管理面：session/config/* 与建子会话时写下的那一层都经它；不在时这些方法回 unsupported */
  settings: ServiceSelection<SessionSettingsAdmin>;
  /** 组名：适配器实例的显示名 */
  plugins: Pick<PluginManagerService, 'getPlugin'>;
  logger: Logger;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 写过的一处：一层，或某个会话 */
type Override = SessionMethodResult<'session/config/overrides'>['items'][number]['entries'][number];

/** 层表：名字与称呼，按先后 */
const LAYER_ORDER = SESSION_LAYERS.map(({ name, label }) => ({ name, label }));

/** 会话设置拒绝的读写（没登记的项、不合字段的值、不适用于这一处的项、不合法的层）是参数错误，别的照常上抛 */
async function checked<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isSessionSettingsError(err)) throw new ProtocolError(RPC_ERROR_CODES.invalidParams, textOf(err));
    throw err;
  }
}

/** 写进宿主文档的几层落盘失败时回包另带的那一句 */
const unsaved = ({ saveError }: { saveError?: unknown }) =>
  saveError === undefined ? {} : { unsaved: saveFailureText(saveError, 'reload') };

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
    if (!session) throw failure('not-found', t('noSession', { id }));
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

  /** 会话树里的一级：id 与标题（没取标题的是会话名或默认名），会话摘要的 ancestors 与审批的来源链同一写法 */
  const labelOf = (info: SessionInfo) => ({ id: info.id, title: info.title || sessionLabel(info) });

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

  /**
   * 会话的场所：键与类别取 placeOf，显示名取场所记录（没取名的是默认名，窗口还没有记录时是场所键）。根会话是空记录时没有：
   * 会话设置对它不取场所层
   */
  function placeOf(info: SessionInfo): SessionSummary['place'] {
    if (isUnfiled(rootOf(info))) return undefined;
    const place = sm.placeOf(info.id);
    const record = sm.getPlace(place.key);
    return { ...place, name: record ? placeLabel(record) : place.key };
  }

  /** tasks 是各会话在跑的后台任务数，一批摘要共用一份 */
  function summarize(info: SessionInfo, tasks: ReadonlyMap<string, number> = deps.runningTasks()): SessionSummary {
    const root = rootOf(info);
    const room = root.kind === 'room';
    const chat = root.originPlatform === undefined ? undefined : root.originChat;
    const seenAt = seen.get(info.id);
    const below = descendantsOf(info);
    const tokens = tokensOf([info, ...below]);
    const ancestors = ancestorsOf(info).map(labelOf);
    const reason = info.status === 'error' ? info.lastTurn?.error : undefined;
    const place = placeOf(info);
    return {
      id: info.id,
      title: info.title || sessionLabel(info),
      parentId: info.parentId,
      childCount: info.children.length,
      kind: info.kind,
      section: sectionOfRoot(root),
      platform: root.originPlatform,
      instance: info.originInstance,
      account: root.originChat?.selfId,
      ...(chat ? { chat: { type: chat.type, multiParty: chat.multiParty } } : {}),
      ...(place ? { place } : {}),
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      lastReplyAt: info.lastReplyAt,
      running: deps.isRunning(info.id),
      error: info.status === 'error',
      unread: !room && info.lastReplyAt !== undefined && (seenAt === undefined || info.lastReplyAt > seenAt),
      attention: [info, ...below].some(each => deps.hasApproval(each.id)),
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
  function instanceLabel(instance: string): string | TextRef {
    const definition = deps.plugins.getPlugin(instance)?.definition;
    if (!definition) return instance;
    const name = asText(definition.displayName) ?? definition.name;
    return instance === definition.name
      ? name
      : t('instanceLabel', { name, instance: instance.slice(definition.name.length + 1) });
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
      if ([info, ...descendantsOf(info)].some(each => deps.hasApproval(each.id))) group.attention++;
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
      throw new ProtocolError(RPC_ERROR_CODES.invalidParams, t('badCursor', { cursor: params.cursor }));
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
   * 会话按哪个入口平台选平台档（只对没有出生平台的会话起作用）：子会话按根会话取，接管根会话 id 的平台适配器，没有时取这条
   * 连接的平台。房间与它的子会话钉死出生平台，不看入口
   */
  async function entryPlatform(session: SessionInfo, peer: SessionPeer): Promise<string | undefined> {
    const root = rootOf(session);
    if (root.originPlatform) return undefined;
    const adapter = await resolvePlatformBySession(deps.platform, root.id, deps.logger);
    return adapter?.use.platform ?? peer.identity.platform;
  }

  /** 会话设置的管理面；不在时回 unsupported */
  const admin = (): SessionSettingsAdmin => {
    if (!deps.settings.present) throw failure('unsupported', SETTINGS_ABSENT);
    return deps.settings.use;
  };

  /** 会话的各行，另带平台档按哪个平台取 */
  async function sessionRows(sessionId: string, peer: SessionPeer): Promise<SessionMethodResult<'session/config/get'>> {
    const settings = admin();
    const session = requireSession(sessionId);
    const at = { platform: await entryPlatform(session, peer) };
    const platform = rootOf(session).originPlatform ?? at.platform;
    return { items: settings.rows({ sessionId, at }), ...(platform === undefined ? {} : { platform }) };
  }

  const layerRows = (layer: SessionSettingsLayer) => checked(() => ({ items: admin().rows({ layer }) }));

  /** 一个实例写过的各处按项分组；会话带标题，子会话另带父会话 */
  function overrides(plugin: string): SessionMethodResult<'session/config/overrides'> {
    const titled = (info: SessionInfo) => ({ sessionId: info.id, title: info.title || sessionLabel(info) });
    const items = new Map<string, Override[]>();
    for (const { key, value, at } of admin().placements(plugin)) {
      let target: Override['target'];
      if ('layer' in at) target = { layer: at.layer };
      else {
        const info = sm.getSession(at.sessionId);
        if (!info) continue;
        const parent = parentOf(info);
        target = { ...titled(info), ...(parent ? { parent: titled(parent) } : {}) };
      }
      items.set(key, [...(items.get(key) ?? []), { target, value }]);
    }
    return { items: [...items].map(([key, entries]) => ({ key, entries })) };
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
    | 'session/config/overrides'
    | 'session/markSeen'
  > = {
    'sessions/list': list,
    'sessions/watch': (_params, conn) => {
      conn.watching = true;
      return {};
    },
    'session/create': async ({ name, parentId }, conn) => {
      const parent = parentId === undefined ? undefined : requireSession(parentId);
      // 子会话建立时写下父会话此刻每一项适用于子会话的生效值（并进 metadata，建档时一次写下）；会话设置不在时不建
      const metadata = parent
        ? admin().childMetadata(parent.id, { platform: await entryPlatform(parent, conn.peer) })
        : undefined;
      // 根会话的创建来源取这条连接所在审批面的登记名（传输层登记得到），不取连接自报的；子会话不带，按根会话取
      const session = await sm.createSession(
        { name, parentId, status: 'waiting', ...(metadata ? { metadata } : {}) },
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
      const failed: SessionMethodResult<'session/batch'>['failed'] = [];
      // 只有开始前就不存在的算失败：删父会话时一并删掉的子会话不算
      const present = ids.filter(id => sm.getSession(id) !== undefined);
      for (const id of ids) if (!present.includes(id)) failed.push({ sessionId: id, message: t('noSession', { id }) });
      for (const id of present) {
        try {
          await (op === 'archive' ? archive(id) : sm.deleteSession(id));
        } catch (err) {
          failed.push({ sessionId: id, message: textOf(err) });
        }
      }
      return { failed };
    },
    'session/config/get': ({ sessionId }, conn) => sessionRows(sessionId, conn.peer),
    'session/config/update': async ({ sessionId, plugin, key, value }, conn) => {
      requireSession(sessionId);
      const written = await checked(() => admin().update({ sessionId }, { plugin, key, value }));
      return { ...(await sessionRows(sessionId, conn.peer)), ...unsaved(written) };
    },
    'session/config/layers': () => ({ layers: admin().layers(), order: LAYER_ORDER }),
    'session/config/layer/get': ({ layer }) => layerRows(layer),
    'session/config/layer/update': async ({ layer, plugin, key, value }) => {
      const written = await checked(() => admin().update({ layer }, { plugin, key, value }));
      return { ...(await layerRows(layer)), ...unsaved(written) };
    },
    'session/config/overrides': ({ plugin }) => overrides(plugin),
    'session/markSeen': async ({ sessionId }) => {
      requireSession(sessionId);
      await seen.mark(sessionId, Date.now());
      deps.changed(sessionId);
      return {};
    },
  };

  return { handlers, summarize, groups, requireSession, sectionOf, ancestorsOf, descendantsOf, labelOf };
}
