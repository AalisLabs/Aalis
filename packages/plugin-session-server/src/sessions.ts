// ════════════════════════════════════════════════════════════
// 会话列表与会话的增删改：摘要、分区与分组、排序与分页、搜索；建、改名、归档、删除与批量；
// 会话配置的生效值与继承来源；已读。会话本身都在 session-manager 里，这里只做投影与转发。
// 「需要我处理」由未结的审批驱动。
// ════════════════════════════════════════════════════════════

import { type LLMModel, listLLMModels } from '@aalis/api-llm';
import type { PersonaService } from '@aalis/api-persona';
import { type PlatformAdapter, resolvePlatformBySession } from '@aalis/api-platform';
import {
  omitRoomOnlyKeys,
  type SessionConfig,
  type SessionInfo,
  type SessionManagerService,
  sessionListSection,
} from '@aalis/api-session-manager';
import {
  type RoomGroup,
  RPC_ERROR_CODES,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionPeer,
  type SessionSummary,
} from '@aalis/api-session-protocol';
import type { ToolService } from '@aalis/api-tools';
import type { Logger, ServiceRef } from '@aalis/core';
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
  persona: ServiceRef<PersonaService>;
  llm: ServiceRef<LLMModel>;
  tools: ServiceRef<ToolService>;
  logger: Logger;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 存档里清掉的项读回来可能是 null（经 BSON 落盘），与没有同义 */
function withoutNulls(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[key] = typeof v === 'object' && !Array.isArray(v) ? withoutNulls(v) : v;
  }
  return out;
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

  /** 会话所在的区：子会话归在根会话的区里 */
  const sectionOf = (info: SessionInfo) => sessionListSection(rootOf(info));

  function summarize(info: SessionInfo): SessionSummary {
    const root = rootOf(info);
    const section = sessionListSection(root);
    const room = section === 'rooms';
    const seenAt = seen.get(info.id);
    return {
      id: info.id,
      title: info.title || info.name,
      parentId: info.parentId,
      childCount: info.children.length,
      kind: info.kind,
      section,
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
      paper: room ? sm.resolveConfig(info.id).paperEnabled === true : undefined,
    };
  }

  /** 房间按接管的适配器实例分组；还没记下实例的按平台成一组，排在同平台各实例之后 */
  function groups(): RoomGroup[] {
    type Group = { platform: string; instance?: string; rooms: number; accounts: Set<string>; attention: number };
    const byKey = new Map<string, Group>();
    for (const info of sm.listSessions({ parentId: null })) {
      const platform = info.originPlatform;
      if (!platform) continue;
      const key = JSON.stringify([platform, info.originInstance]);
      const group = byKey.get(key) ?? {
        platform,
        instance: info.originInstance,
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
   * 子会话按最后活动。
   */
  function list(params: SessionMethodParams<'sessions/list'>): SessionMethodResult<'sessions/list'> {
    if (params.cursor !== undefined && !/^\d+$/.test(params.cursor)) {
      throw new ProtocolError(RPC_ERROR_CODES.invalidParams, `cursor 无效：${params.cursor}`);
    }
    const parent = params.parentId === undefined ? undefined : requireSession(params.parentId);
    let rows = parent ? sm.getChildren(parent.id) : sm.listSessions({ parentId: null });
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

  async function configView(
    session: SessionInfo,
    peer: SessionPeer,
  ): Promise<SessionMethodResult<'session/config/get'>> {
    const platform = await entryPlatform(session, peer);
    return {
      config: withoutNulls(session.config),
      effective: sm.resolveConfig(session.id, platform),
      inheritance: sm.resolveInheritance(session.id, platform),
      options: {
        personas: (await deps.persona.current?.listModels?.()) ?? [],
        models: listLLMModels(deps.llm, { caps: ['chat'] }).map(({ instance }) => ({
          provider: instance.providerId,
          model: instance.id,
          capabilities: [...instance.capabilities],
        })),
        toolGroups: deps.tools.current?.getGroups().map(({ name, label }) => ({ name, label })) ?? [],
      },
    };
  }

  const handlers: Pick<
    MethodHandlers,
    | 'sessions/list'
    | 'sessions/watch'
    | 'session/create'
    | 'session/rename'
    | 'session/archive'
    | 'session/delete'
    | 'session/batch'
    | 'session/config/get'
    | 'session/config/update'
    | 'session/markSeen'
  > = {
    'sessions/list': list,
    'sessions/watch': (_params, conn) => {
      conn.watching = true;
      return {};
    },
    'session/create': async ({ name, parentId }, conn) => {
      const parent = parentId === undefined ? undefined : requireSession(parentId);
      // 根会话不复制平台档，配置经继承链实时生效；子会话复制父会话的生效配置（继承链不经父会话自己的配置）
      const config = parent
        ? omitRoomOnlyKeys(sm.resolveConfig(parent.id, await entryPlatform(parent, conn.peer)))
        : {};
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
    'session/config/get': ({ sessionId }, conn) => configView(requireSession(sessionId), conn.peer),
    'session/config/update': async ({ sessionId, patch }, conn) => {
      requireSession(sessionId);
      // null 表示删掉这一项、恢复继承；updateSession 合并配置，值为 undefined 的项在解析时不生效
      const config = Object.fromEntries(
        Object.entries(patch).map(([key, value]) => [key, value ?? undefined]),
      ) as Partial<SessionConfig>;
      return configView(await sm.updateSession(sessionId, { config }), conn.peer);
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
