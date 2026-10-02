import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '../../packages/api-session-manager/src/index.js';
import {
  ErrorFrameSchema,
  NotificationFrameSchema,
  RequestFrameSchema,
  ResultFrameSchema,
  SESSION_PROTOCOL_VERSION,
  type SessionItem,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionNotification,
  type SessionNotificationParams,
  type SessionSummary,
  sessionMethods,
  sessionNotifications,
} from '../../packages/api-session-protocol/src/index.js';

// ════════════════════════════════════════════════════════════
// 会话协议的 schema 往返：每种帧、每个方法的参数与结果、每种通知与条目，合法样例经 JSON 往返后原样通过，
// 非法样例被拒。样例表按方法与通知名列全，协议加了方法而样例没跟上时，类型检查与「样例齐全」一条都会挂。
// ════════════════════════════════════════════════════════════

const summary: SessionSummary = {
  id: 'onebot:10000:group:20001',
  title: '读书会',
  childCount: 1,
  kind: 'room',
  section: 'rooms',
  platform: 'onebot',
  instance: '@aalis/plugin-adapter-onebot:a',
  account: '10000',
  audience: 'group',
  createdAt: 1,
  updatedAt: 2,
  lastReplyAt: 2,
  running: false,
  error: false,
  unread: false,
  archived: false,
  paper: true,
};

const configView: SessionMethodResult<'session/config/get'> = {
  config: { persona: 'aalis', sessionDefaults: { think: true } },
  effective: { persona: 'aalis', enabledToolGroups: ['*'] },
  inheritance: {
    platform: 'webui',
    values: { enabledToolGroups: ['*'] },
    sources: { enabledToolGroups: 'platform' },
  },
  options: {
    personas: ['aalis'],
    models: [{ provider: '@aalis/plugin-llm-openai:main', model: 'gpt-4o', capabilities: ['chat'] }],
    toolGroups: [{ name: 'system', label: '系统工具' }],
  },
};

type Pair<T> = { valid: T; invalid: unknown };
type MethodSamples = {
  [M in SessionMethod]: { params: Pair<SessionMethodParams<M>>; result: Pair<SessionMethodResult<M>> };
};

const methodSamples: MethodSamples = {
  initialize: {
    params: {
      valid: { protocolVersion: SESSION_PROTOCOL_VERSION, client: { name: 'webui', version: '0.1.0' } },
      invalid: { protocolVersion: 'v1', client: { name: 'webui', version: '0.1.0' } },
    },
    result: {
      valid: {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        experimental: true,
        server: { name: '@aalis/plugin-session-server' },
        identity: { platform: 'webui', userId: 'console' },
        surface: 'webui',
      },
      invalid: { protocolVersion: SESSION_PROTOCOL_VERSION, experimental: false, server: {}, surface: 'webui' },
    },
  },
  'sessions/list': {
    params: {
      valid: { section: 'rooms', query: '读书', cursor: '50', limit: 50 },
      invalid: { section: 'mine', limit: 0 },
    },
    result: {
      valid: {
        sessions: [summary],
        nextCursor: '50',
        groups: [{ platform: 'onebot', instance: '@aalis/plugin-adapter-onebot:a', rooms: 1, accounts: 1 }],
      },
      invalid: { sessions: [{ ...summary, running: 'yes' }], groups: [] },
    },
  },
  'sessions/watch': {
    params: { valid: {}, invalid: null },
    result: { valid: {}, invalid: null },
  },
  'session/create': {
    params: { valid: { name: '新会话', parentId: 'session-1' }, invalid: { name: '' } },
    result: { valid: { session: { ...summary, id: 'session-2' } }, invalid: { session: { id: 'session-2' } } },
  },
  'session/rename': {
    params: { valid: { sessionId: 'session-1', title: '周报' }, invalid: { sessionId: 'session-1', title: '' } },
    result: { valid: {}, invalid: null },
  },
  'session/archive': {
    params: { valid: { sessionId: 'session-1' }, invalid: {} },
    result: { valid: {}, invalid: [] },
  },
  'session/delete': {
    params: { valid: { sessionId: 'session-1' }, invalid: { sessionId: 1 } },
    result: { valid: {}, invalid: 'ok' },
  },
  'session/batch': {
    params: {
      valid: { op: 'archive', ids: ['session-1', 'session-2'] },
      invalid: { op: 'rename', ids: ['session-1'] },
    },
    result: {
      valid: { failed: [{ sessionId: 'session-3', message: '会话不存在' }] },
      invalid: { failed: [{ sessionId: 'session-3' }] },
    },
  },
  'session/config/get': {
    params: { valid: { sessionId: 'session-1' }, invalid: { id: 'session-1' } },
    result: {
      valid: configView,
      invalid: { ...configView, inheritance: { ...configView.inheritance, sources: { persona: 'session' } } },
    },
  },
  'session/config/update': {
    params: {
      valid: { sessionId: 'session-1', patch: { persona: null, llm: { provider: 'p', model: 'm' }, think: false } },
      invalid: { sessionId: 'session-1', patch: { memoryRecallScope: 'everyone' } },
    },
    result: { valid: configView, invalid: { ...configView, options: undefined } },
  },
  'session/markSeen': {
    params: { valid: { sessionId: 'session-1' }, invalid: { sessionId: null } },
    result: { valid: {}, invalid: undefined },
  },
  'session/subscribe': {
    params: { valid: { sessionId: 'session-1' }, invalid: {} },
    result: {
      valid: {
        epoch: 'e1',
        seq: 3,
        session: summary,
        items: [
          {
            kind: 'agent-message',
            itemId: 'i1',
            turnId: 't1',
            at: 1,
            text: '正在写',
            attachments: [],
          },
        ],
        before: 'c1',
      },
      invalid: { epoch: 'e1', seq: -1, session: summary, items: [] },
    },
  },
  'session/unsubscribe': {
    params: { valid: { sessionId: 'session-1' }, invalid: { sessionId: ['session-1'] } },
    result: { valid: {}, invalid: 0 },
  },
  'session/history': {
    params: {
      valid: { sessionId: 'session-1', before: 'c1', limit: 20 },
      invalid: { sessionId: 'session-1', limit: -1 },
    },
    result: {
      valid: { items: [{ kind: 'reasoning', itemId: 'i2', at: 1, text: '想一想' }], before: 'c0' },
      invalid: { items: [{ kind: 'thought', itemId: 'i2', at: 1, text: '想一想' }] },
    },
  },
  'turn/send': {
    params: {
      valid: {
        sessionId: 'session-1',
        content: '',
        attachments: [{ kind: 'image', data: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'a.png' }],
      },
      invalid: { sessionId: 'session-1', content: '' },
    },
    result: { valid: {}, invalid: null },
  },
  'turn/continue': {
    params: { valid: { sessionId: 'session-1' }, invalid: {} },
    result: { valid: {}, invalid: null },
  },
  'turn/abort': {
    params: { valid: { sessionId: 'session-1', turnId: 't1' }, invalid: { turnId: 't1' } },
    result: { valid: {}, invalid: null },
  },
  'session/compress': {
    params: { valid: { sessionId: 'session-1' }, invalid: {} },
    result: { valid: {}, invalid: null },
  },
  'turn/rewind': {
    params: {
      valid: { sessionId: 'session-1', turnId: 't1', scope: 'code-and-chat' },
      invalid: { sessionId: 'session-1', turnId: 't1', scope: 'chat' },
    },
    result: {
      valid: {
        ok: true,
        restored: ['workspace:/a.txt'],
        deleted: [],
        errors: [],
        alsoChangedBy: [{ uri: 'workspace:/a.txt', turnIds: ['t2'] }],
        deletedMessages: 2,
        chatDeleted: true,
      },
      invalid: { ok: true, restored: [], deleted: [], errors: [] },
    },
  },
  'plan/clear': {
    params: { valid: { sessionId: 'session-1' }, invalid: {} },
    result: { valid: {}, invalid: null },
  },
};

/** 每种条目一个合法样例 */
const items: SessionItem[] = [
  {
    kind: 'user-message',
    itemId: 'u1',
    turnId: 't1',
    at: 1,
    text: '帮我看看',
    attachments: [
      { kind: 'image', src: '/api/media?uri=data%3A%2Fa.png' },
      // 存档只记了文件名的上传：没有可下载的来源
      { kind: 'file', name: 'notes.txt' },
    ],
    speaker: { platform: 'onebot', userId: '30001', nickname: '小明', owner: false },
  },
  {
    kind: 'agent-message',
    itemId: 'a1',
    turnId: 't1',
    at: 2,
    text: '',
    attachments: [{ kind: 'file', src: 'h-opaque', name: 'report.pdf' }],
    model: { provider: '@aalis/plugin-llm-openai:main', model: 'gpt-4o' },
    undelivered: { reason: '静默' },
  },
  { kind: 'reasoning', itemId: 'r1', turnId: 't1', at: 3, text: '先读文件' },
  {
    kind: 'tool-call',
    itemId: 'c1',
    turnId: 't1',
    at: 4,
    name: 'exec',
    args: { command: 'ls' },
    status: 'completed',
    output: 'a.txt\n',
    result: '{"exitCode":0}',
    durationMs: 12,
  },
  {
    kind: 'notice',
    itemId: 'n1',
    turnId: 't1',
    at: 5,
    topic: 'tool-limit',
    text: '工具调用达到上限',
    attachments: [],
    canContinue: true,
  },
  { kind: 'plan', itemId: 'p1', at: 6, entries: [{ id: 1, title: '读文件', status: 'in-progress' }] },
  {
    kind: 'usage',
    itemId: 'g1',
    turnId: 't1',
    at: 7,
    contextWindow: 128000,
    maxTokens: 8000,
    tokenBudget: 120000,
    used: 3000,
    usageRatio: 0.025,
    breakdown: { system: 100, history: 2900 },
    injectors: { skills: 40 },
  },
  {
    kind: 'turn',
    itemId: 'turn:t1',
    turnId: 't1',
    at: 8,
    by: { platform: 'webui', userId: 'console', owner: true },
    outcome: 'replied',
  },
];

/** 每种条目一个非法样例：种类不认识、缺必填字段、取值越界 */
const invalidItems: unknown[] = [
  { kind: 'user-message', itemId: 'u1', at: 1, text: 'x', attachments: [] },
  { kind: 'agent-message', itemId: 'a1', at: 2, text: 'x', attachments: [{ kind: 'pdf', src: 'h' }] },
  { kind: 'reasoning', itemId: 'r1', at: 3 },
  { kind: 'tool-call', itemId: 'c1', at: 4, name: 'exec', args: {}, status: 'pending' },
  { kind: 'notice', itemId: 'n1', at: 5, text: 'x', attachments: [] },
  { kind: 'plan', itemId: 'p1', at: 6, entries: [{ id: 1, title: 'x', status: 'done' }] },
  { kind: 'usage', itemId: 'g1', at: 7, used: 1 },
  { kind: 'turn', itemId: 'turn:t1', at: 8, by: { platform: 'webui', owner: true }, outcome: 'replied' },
  { kind: 'diff', itemId: 'd1', at: 9 },
];

type NotificationSamples = { [N in SessionNotification]: Pair<SessionNotificationParams<N>> };

const notificationSamples: NotificationSamples = {
  'sessions/changed': {
    valid: { upserts: [summary], removes: ['session-9'], groups: [] },
    invalid: { upserts: [], removes: [1], groups: [] },
  },
  'item/started': {
    valid: { sessionId: 'session-1', epoch: 'e1', seq: 4, item: items[3] },
    invalid: { sessionId: 'session-1', epoch: 'e1', seq: 4 },
  },
  'item/delta': {
    valid: { sessionId: 'session-1', epoch: 'e1', seq: 5, itemId: 'c1', text: 'b.txt\n' },
    invalid: { sessionId: 'session-1', epoch: 'e1', seq: 5.5, itemId: 'c1', text: 'b' },
  },
  'item/completed': {
    valid: { sessionId: 'session-1', epoch: 'e1', seq: 6, item: items[1] },
    invalid: { sessionId: 'session-1', epoch: 1, seq: 6, item: items[1] },
  },
  'session/resync': {
    valid: { sessionId: 'session-1', epoch: 'e1', seq: 7 },
    invalid: { sessionId: 'session-1', epoch: 'e1' },
  },
};

/**
 * 协议里会话配置的各项与 api-session-manager 的 SessionConfig 一一对应、类型相同。
 * 任一边加了、删了或改了一项而另一边没跟上，这里的类型检查就挂（test/ 的类型检查是门禁的一部分）。
 */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const configInSync: Same<Required<SessionMethodResult<'session/config/get'>['config']>, Required<SessionConfig>> = true;

/** 经 JSON 往返后用 schema 解析：结果与原样例相等 */
function roundTrip(schema: { parse(value: unknown): unknown }, value: unknown): unknown {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

describe('会话协议 schema 往返', () => {
  it('会话配置的各项与 SessionConfig 一一对应（类型检查守）', () => {
    expect(configInSync).toBe(true);
  });

  it('样例表覆盖全部方法与通知', () => {
    expect(Object.keys(methodSamples).sort()).toEqual(Object.keys(sessionMethods).sort());
    expect(Object.keys(notificationSamples).sort()).toEqual(Object.keys(sessionNotifications).sort());
  });

  it('JSON-RPC 帧：请求、结果、错误、通知的合法样例往返一致，残缺的被拒', () => {
    const request = { jsonrpc: '2.0', id: 1, method: 'sessions/list', params: { section: 'owner' } };
    const bare = { jsonrpc: '2.0', id: 'a', method: 'sessions/watch' };
    const result = { jsonrpc: '2.0', id: 1, result: { sessions: [], groups: [] } };
    const error = {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: '会话不存在', data: { code: 'not-found' } },
    };
    const parseError = { jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是 JSON' } };
    const notification = {
      jsonrpc: '2.0',
      method: 'sessions/changed',
      params: { upserts: [], removes: [], groups: [] },
    };

    expect(roundTrip(RequestFrameSchema, request)).toEqual(request);
    expect(roundTrip(RequestFrameSchema, bare)).toEqual(bare);
    expect(roundTrip(ResultFrameSchema, result)).toEqual(result);
    expect(roundTrip(ErrorFrameSchema, error)).toEqual(error);
    expect(roundTrip(ErrorFrameSchema, parseError)).toEqual(parseError);
    expect(roundTrip(NotificationFrameSchema, notification)).toEqual(notification);

    expect(RequestFrameSchema.safeParse({ ...request, jsonrpc: '1.0' }).success).toBe(false);
    expect(RequestFrameSchema.safeParse({ jsonrpc: '2.0', method: 'sessions/list' }).success).toBe(false);
    expect(RequestFrameSchema.safeParse({ ...request, params: ['owner'] }).success).toBe(false);
    expect(ResultFrameSchema.safeParse({ jsonrpc: '2.0', id: 1 }).success).toBe(false);
    expect(ErrorFrameSchema.safeParse({ ...error, error: { ...error.error, data: { code: 'gone' } } }).success).toBe(
      false,
    );
    expect(NotificationFrameSchema.safeParse({ jsonrpc: '2.0', params: {} }).success).toBe(false);
  });

  it.each(Object.keys(methodSamples) as SessionMethod[])('%s：参数与结果往返一致，非法样例被拒', method => {
    const { params, result } = methodSamples[method];
    const schema = sessionMethods[method];
    expect(roundTrip(schema.params, params.valid)).toEqual(params.valid);
    expect(schema.params.safeParse(params.invalid).success).toBe(false);
    expect(roundTrip(schema.result, result.valid)).toEqual(result.valid);
    expect(schema.result.safeParse(result.invalid).success).toBe(false);
  });

  it.each(Object.keys(notificationSamples) as SessionNotification[])('%s：参数往返一致，非法样例被拒', name => {
    const { valid, invalid } = notificationSamples[name];
    expect(roundTrip(sessionNotifications[name], valid)).toEqual(valid);
    expect(sessionNotifications[name].safeParse(invalid).success).toBe(false);
  });

  it('条目：每一种都往返一致，缺字段、取值越界与不认识的种类被拒', () => {
    const schema = sessionNotifications['item/completed'];
    for (const item of items) {
      const params = { sessionId: 'session-1', epoch: 'e1', seq: 1, item };
      expect(roundTrip(schema, params)).toEqual(params);
    }
    expect(new Set(items.map(item => item.kind)).size).toBe(items.length);
    for (const item of invalidItems) {
      expect(
        schema.safeParse({ sessionId: 'session-1', epoch: 'e1', seq: 1, item }).success,
        JSON.stringify(item),
      ).toBe(false);
    }
  });

  it('只有附件、没有文字的消息合法；文字与附件都没有的被拒', () => {
    const send = sessionMethods['turn/send'].params;
    expect(send.safeParse({ sessionId: 's', content: '你好' }).success).toBe(true);
    expect(
      send.safeParse({ sessionId: 's', content: '', attachments: [{ kind: 'file', data: 'data:;base64,AA' }] }).success,
    ).toBe(true);
    expect(send.safeParse({ sessionId: 's', content: '', attachments: [] }).success).toBe(false);
    expect(send.safeParse({ sessionId: 's', content: ' \n ' }).success, '只有空白算没写文字').toBe(false);
  });
});
