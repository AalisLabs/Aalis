import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import sessionTools from '../../packages/plugin-tool-session/src/index.js';
import { type Message, WellKnownKinds } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 读会话历史给模型（session-history 服务，session_get_history 与 onebot_get_session_history 都经它）：事件标记
// （CONTROL_KINDS，如压缩分隔线、指令的回复）不是对话内容，不交给模型；按条数读与按时间区间读都一样。按条数读时多读一段
// 再去掉它们，取最后 limit 条；还是没凑满、又确实略去了记录时，结果写明略去了几条。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:10000:group:20001';
const marker = (timestamp: number): Message => ({
  role: 'system',
  kind: WellKnownKinds.EventMarker,
  content: '指令列表',
  metadata: { source: 'command' },
  timestamp,
});
const STORED: Message[] = [
  { role: 'user', content: '/help', timestamp: 1 },
  marker(2),
  { role: 'assistant', content: '在', timestamp: 3 },
];

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 存档里是 stored（按时间升序），按条数读取最后 limit 条；返回 session_get_history 的结果 */
async function readHistory(args: Record<string, unknown>, stored = STORED) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide.use(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(memory, {
    getHistory: async (_sessionId: string, limit: number) => stored.slice(-limit),
    getMessagesBySessionRange: async () => stored,
  } as never);
  await app.plugin(sessionTools, { scope: 'current' });
  await app.start();
  const handler = handlers.get('session_get_history');
  if (!handler) throw new Error('session_get_history 未注册');
  return JSON.parse(
    (await handler({ session_id: SESSION, ...args }, { sessionId: SESSION, platform: 'onebot' })) as string,
  );
}

const said = (result: { messages: { role: string; content: string }[] }) =>
  result.messages.map(message => [message.role, message.content]);

describe('session-history：事件标记不交给模型', () => {
  it.each([
    ['按条数', {}],
    ['按时间区间', { since: 0 }],
  ])('%s读：只有提问与回复', async (_label, args) => {
    expect(said(await readHistory(args))).toEqual([
      ['user', '/help'],
      ['assistant', '在'],
    ]);
  });

  it('按条数读：最近 limit 条里有事件标记时多读一段，凑满 limit 条对话', async () => {
    const stored: Message[] = [
      { role: 'user', content: '早', timestamp: 1 },
      { role: 'assistant', content: '早上好', timestamp: 2 },
      { role: 'user', content: '/help', timestamp: 3 },
      marker(4),
      { role: 'assistant', content: '在', timestamp: 5 },
    ];
    const result = await readHistory({ limit: 3 }, stored);
    expect(said(result)).toEqual([
      ['assistant', '早上好'],
      ['user', '/help'],
      ['assistant', '在'],
    ]);
    expect(result).toMatchObject({ count: 3, limit: 3 });
    expect(result).not.toHaveProperty('omittedNonConversation');
  });

  it('按条数读：多读也凑不满、又略去了事件标记时，结果写明略去的条数；没略去的不写', async () => {
    const stored: Message[] = [{ role: 'user', content: '/help', timestamp: 1 }, marker(2), marker(3)];
    expect(await readHistory({ limit: 5 }, stored)).toMatchObject({ count: 1, omittedNonConversation: 2 });
    expect(await readHistory({ limit: 5 }, stored.slice(0, 1))).not.toHaveProperty('omittedNonConversation');
  });
});
