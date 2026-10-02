import type { SessionItem, SessionSummary } from '@aalis/api-session-protocol';
import { useCallback, useEffect, useState } from 'react';
import { type Approval, useSessionClient } from '../connection';

// 一个打开着的会话：订阅取快照，之后按推送更新条目（同一 itemId 覆盖，增量接在正文或输出后面），摘要随 sessions/changed
// 更新。计划与用量每个会话一条、整份替换，不进时间线。重新订阅（重连、epoch 变了、resync）时快照整份取代，
// 之前翻出的更早历史一并丢掉。更早的历史按游标翻页，接在前面

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;
export type TimelineItem = Exclude<SessionItem, { kind: 'plan' | 'usage' }>;
export type UsageItem = Item<'usage'>;
export type PlanItem = Item<'plan'>;

interface LiveSession {
  summary?: SessionSummary;
  items: TimelineItem[];
  /** started 之后还没 completed 的条目：正在输出的正文与思考、进行中的通知 */
  streaming: ReadonlySet<string>;
  usage?: UsageItem;
  plan?: PlanItem;
  /** 快照里这个会话已推给审批面、还没结算的审批 */
  approvals: ReadonlyMap<string, Approval>;
  /** 更早一页历史的游标；没有更早的了就没有 */
  before?: string;
  error?: Error;
  /** 会话被删掉了 */
  removed: boolean;
}

const EMPTY: LiveSession = { items: [], streaming: new Set(), approvals: new Map(), removed: false };

/** 条目归位：计划与用量另放，其余同一 itemId 原地覆盖、新的接在后面 */
function place(state: LiveSession, item: SessionItem): LiveSession {
  if (item.kind === 'usage') return { ...state, usage: item };
  if (item.kind === 'plan') return { ...state, plan: item };
  const index = state.items.findIndex(existing => existing.itemId === item.itemId);
  const items = index < 0 ? [...state.items, item] : state.items.with(index, item);
  return { ...state, items };
}

function appendDelta(state: LiveSession, itemId: string, text: string): LiveSession {
  const index = state.items.findIndex(item => item.itemId === itemId);
  const item = state.items[index];
  if (!item) return state;
  const next =
    item.kind === 'tool-call'
      ? { ...item, output: (item.output ?? '') + text }
      : item.kind === 'agent-message' || item.kind === 'reasoning'
        ? { ...item, text: item.text + text }
        : item;
  return { ...state, items: state.items.with(index, next) };
}

export function useLiveSession(sessionId: string) {
  const client = useSessionClient();
  const [state, setState] = useState<LiveSession>(EMPTY);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt > 0) setState(current => ({ ...current, error: undefined }));
    const unsubscribe = client.subscribe(sessionId, {
      snapshot: snapshot =>
        setState(current =>
          snapshot.items.reduce(place, {
            ...EMPTY,
            summary: snapshot.session,
            approvals: new Map(snapshot.approvals.map(approval => [approval.id, approval])),
            before: snapshot.before,
            removed: current.removed,
          }),
        ),
      item: (item, phase) =>
        setState(current => {
          const next = place(current, item);
          const streaming = new Set(current.streaming);
          if (phase === 'started') streaming.add(item.itemId);
          else streaming.delete(item.itemId);
          return { ...next, streaming };
        }),
      delta: (itemId, text) => setState(current => appendDelta(current, itemId, text)),
      failed: error => setState(current => ({ ...current, error })),
    });
    const offChanged = client.on('sessions/changed', change => {
      const summary = change.upserts.find(s => s.id === sessionId);
      const removed = change.removes.includes(sessionId);
      if (summary || removed) setState(current => ({ ...current, summary: summary ?? current.summary, removed }));
    });
    return () => {
      unsubscribe();
      offChanged();
    };
  }, [client, sessionId, attempt]);

  /** 取更早的一页接在前面；快照换过了（游标不同）就丢掉这一页 */
  const loadEarlier = useCallback(async () => {
    const { before } = state;
    if (before === undefined) return;
    const page = await client.request('session/history', { sessionId, before });
    setState(current => {
      if (current.before !== before) return current;
      const known = new Set(current.items.map(item => item.itemId));
      const earlier = page.items.filter(
        (item): item is TimelineItem => item.kind !== 'plan' && item.kind !== 'usage' && !known.has(item.itemId),
      );
      return { ...current, items: [...earlier, ...current.items], before: page.before };
    });
  }, [client, sessionId, state]);

  return { ...state, loadEarlier, retry: () => setAttempt(n => n + 1) };
}
