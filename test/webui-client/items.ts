import type {
  BackgroundTask,
  SessionItem,
  SessionMethodResult,
  SessionSummary,
  SettingRow,
} from '../../packages/api-session-protocol/src/index.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import { summary } from './harness.js';

// 会话工作台用例的条目、快照、设置行与后台任务，以及服务端推送的写法

type Item<K extends SessionItem['kind']> = Extract<SessionItem, { kind: K }>;
export type Approval = SessionMethodResult<'session/subscribe'>['approvals'][number];

export const EPOCH = 'epoch-1';
export const AT = new Date(2026, 9, 3, 10, 32).getTime();

export const userMessage = (itemId: string, text: string, fields: Partial<Item<'user-message'>> = {}) =>
  ({
    kind: 'user-message',
    itemId,
    at: AT,
    text,
    attachments: [],
    speaker: { platform: 'webui', userId: 'console', owner: true },
    ...fields,
  }) satisfies Item<'user-message'>;

export const agentMessage = (itemId: string, text: string, fields: Partial<Item<'agent-message'>> = {}) =>
  ({
    kind: 'agent-message',
    itemId,
    turnId: 't1',
    at: AT,
    text,
    attachments: [],
    ...fields,
  }) satisfies Item<'agent-message'>;

export const reasoning = (itemId: string, text: string, fields: Partial<Item<'reasoning'>> = {}) =>
  ({ kind: 'reasoning', itemId, turnId: 't1', at: AT, text, ...fields }) satisfies Item<'reasoning'>;

export const toolCall = (itemId: string, name: string, fields: Partial<Item<'tool-call'>> = {}) =>
  ({
    kind: 'tool-call',
    itemId,
    turnId: 't1',
    at: AT,
    name,
    args: {},
    status: 'completed',
    ...fields,
  }) satisfies Item<'tool-call'>;

export const notice = (itemId: string, text: string, fields: Partial<Item<'notice'>> = {}) =>
  ({ kind: 'notice', itemId, at: AT, topic: 'note', text, attachments: [], ...fields }) satisfies Item<'notice'>;

export const turn = (turnId: string, fields: Partial<Item<'turn'>> = {}) =>
  ({
    kind: 'turn',
    itemId: turnId,
    turnId,
    at: AT,
    by: { platform: 'webui', userId: 'console', owner: true },
    ...fields,
  }) satisfies Item<'turn'>;

export const usage = (fields: Partial<Item<'usage'>> = {}) =>
  ({
    kind: 'usage',
    itemId: 'usage',
    at: AT,
    contextWindow: 100_000,
    maxTokens: 4_000,
    tokenBudget: 90_000,
    used: 42_000,
    usageRatio: 0.42,
    parts: [],
    ...fields,
  }) satisfies Item<'usage'>;

export const plan = (entries: Item<'plan'>['entries']) =>
  ({ kind: 'plan', itemId: 'plan', at: AT, entries }) satisfies Item<'plan'>;

export const approval = (id: string, fields: Partial<Approval> = {}): Approval => ({
  id,
  sessionId: 's1',
  turnId: 't1',
  callId: 'c1',
  origin: { kind: 'owner', platform: 'webui', userId: 'console' },
  target: 'tool',
  tool: 'exec',
  facts: { params: {} },
  options: ['approve', 'deny'],
  contentHash: `hash-${id}`,
  state: 'pending',
  ...fields,
});

/** 订阅的快照：会话 s1（「我的」区），条目按给的顺序 */
export function snapshot(
  items: SessionItem[],
  fields: { session?: Partial<SessionSummary>; approvals?: Approval[]; before?: string } = {},
): SessionMethodResult<'session/subscribe'> {
  return {
    epoch: EPOCH,
    seq: 1,
    session: summary('s1', { title: '整理周报', ...fields.session }),
    items,
    approvals: fields.approvals ?? [],
    ...(fields.before === undefined ? {} : { before: fields.before }),
  };
}

let seq = 100;

/** 服务端推一个条目或增量（seq 递增，接在快照之后） */
export function push(phase: 'started' | 'completed', item: SessionItem, sessionId = 's1'): void {
  FakeWebSocket.at('/session').notify(`item/${phase}`, { sessionId, epoch: EPOCH, seq: ++seq, item });
}

export function pushDelta(itemId: string, text: string, sessionId = 's1'): void {
  FakeWebSocket.at('/session').notify('item/delta', { sessionId, epoch: EPOCH, seq: ++seq, itemId, text });
}

export const row = (key: string, fields: Partial<SettingRow> = {}): SettingRow => ({
  key,
  field: { type: 'string', label: key },
  plugin: '@aalis/demo',
  prominence: 'common',
  ...fields,
});

/** 会话 s1 里转了后台的一次工具调用：在跑，从 AT 开始，工具卡的 itemId 是 call-<id> */
export const backgroundTask = (id: string, fields: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id,
  sessionId: 's1',
  kind: 'tool-call',
  label: 'exec',
  call: { tool: 'exec', turnId: 't1', callId: `call-${id}` },
  status: 'running',
  startedAt: AT,
  ...fields,
});

/** 服务端推后台任务的增量 */
export function pushTasks(upserts: BackgroundTask[], removes: string[] = []): void {
  FakeWebSocket.at('/session').notify('background/changed', { upserts, removes });
}
