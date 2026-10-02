import type { RoomGroup, SessionNotificationParams, SessionSummary } from '@aalis/api-session-protocol';
import { useEffect, useState } from 'react';
import { useSessionClient } from '../connection';
import { ConnectionLostError } from '../protocol/session-client';
import { inGroup } from '../routes';
import { STATUS_ORDER, statusOf } from './status';

// 一份会话列表：翻页取全，之后按 sessions/changed 的增量即时更新，断线重连后重取。
// 增量里的会话按同一份筛选条件判断进不进这份列表，排序也照服务端的规则在本地重排

/** 列表的范围，就是 sessions/list 的参数：「我的」区、一组房间、已归档的、某个会话的子会话 */
type SessionListQuery =
  | { section: 'owner' }
  | { instance: string }
  | { platform: string }
  | { archived: true }
  | { parentId: string };

const PAGE_LIMIT = 200;
/** 翻页途中来了推送时，排在后面的行可能挪进已经取过的页而漏掉：重取，最多这么多遍 */
const FETCH_ATTEMPTS = 3;

function belongs(query: SessionListQuery, s: SessionSummary): boolean {
  if ('parentId' in query) return s.parentId === query.parentId && !s.archived;
  if (s.parentId !== undefined) return false;
  if ('archived' in query) return s.archived;
  if (s.archived) return false;
  if ('section' in query) return s.section === query.section;
  return inGroup(s, query);
}

/** 「我的」区按状态的先后靠前，没有状态的在后 */
const rank = (s: SessionSummary) => {
  const status = statusOf(s);
  return status === undefined ? STATUS_ORDER.length : STATUS_ORDER.indexOf(status);
};

function sorted(query: SessionListQuery, rows: Iterable<SessionSummary>): SessionSummary[] {
  const byRank = 'section' in query;
  return [...rows].sort((a, b) => (byRank ? rank(a) - rank(b) : 0) || b.updatedAt - a.updatedAt);
}

interface ListState {
  key: string;
  /** 取到以前为 undefined */
  sessions?: SessionSummary[];
  /** 没归档的房间的分组，随每次取数与推送更新 */
  groups: RoomGroup[];
  error?: Error;
}

export function useSessionList(query: SessionListQuery) {
  const client = useSessionClient();
  const scopeKey = JSON.stringify(query);
  const [attempt, setAttempt] = useState(0);
  // 换了范围或重试时，上一次的结果与错误都不再显示
  const key = `${scopeKey}#${attempt}`;
  const [state, setState] = useState<ListState>({ key, groups: [] });

  useEffect(() => {
    const scope = JSON.parse(scopeKey) as SessionListQuery;
    let rows: Map<string, SessionSummary> | undefined;
    let groups: RoomGroup[] = [];
    /** 取数途中收到的增量，取完以后按先后补上 */
    let pending: Array<SessionNotificationParams<'sessions/changed'>> | undefined;
    let generation = 0;
    let disposed = false;

    const publish = (error?: Error) => setState({ key, sessions: rows && sorted(scope, rows.values()), groups, error });

    const apply = (change: SessionNotificationParams<'sessions/changed'>, into: Map<string, SessionSummary>) => {
      for (const s of change.upserts) {
        if (belongs(scope, s)) into.set(s.id, s);
        else into.delete(s.id);
      }
      for (const id of change.removes) into.delete(id);
      groups = change.groups;
    };

    async function load(): Promise<void> {
      const mine = ++generation;
      const stale = () => disposed || mine !== generation;
      for (let round = 1; ; round++) {
        pending = [];
        const fetched = new Map<string, SessionSummary>();
        let pages = 0;
        let cursor: string | undefined;
        try {
          do {
            const page = await client.request('sessions/list', { ...scope, limit: PAGE_LIMIT, cursor });
            if (stale()) return;
            for (const s of page.sessions) fetched.set(s.id, s);
            groups = page.groups;
            cursor = page.nextCursor;
            pages++;
          } while (cursor !== undefined);
        } catch (err) {
          if (stale()) return;
          pending = undefined;
          // 断线时等重连以后重取
          if (!(err instanceof ConnectionLostError)) publish(err as Error);
          return;
        }
        if (pages > 1 && pending.length > 0 && round < FETCH_ATTEMPTS) continue;
        rows = fetched;
        for (const change of pending) apply(change, fetched);
        pending = undefined;
        publish();
        return;
      }
    }

    const offChanged = client.on('sessions/changed', change => {
      if (pending) {
        pending.push(change);
        return;
      }
      // 还没取到过（取数出错了，或还没开始取）：下一次取数会带上最新的，错误照旧留着
      if (!rows) return;
      apply(change, rows);
      publish();
    });
    const offReady = client.onReady(() => void load());
    if (client.state.status === 'open') void load();
    return () => {
      disposed = true;
      offChanged();
      offReady();
    };
  }, [client, scopeKey, key]);

  const current = state.key === key ? state : { key, groups: [] };
  return { ...current, retry: () => setAttempt(n => n + 1) };
}
