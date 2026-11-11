import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnInput } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { ChatResponse } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { type App, events, provide } from '../../packages/core/src/index.js';
import { OneBotV11 } from '../../packages/plugin-adapter-onebot/src/v11.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import {
  type IncomingMessage,
  type Message,
  type OutgoingMessage,
  selfInitiatedActor,
  type TurnRecord,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { sessionTableManager } from '../fixtures/session-table.js';
import { callTool, StepModel, stepModelPlugin } from '../fixtures/step-llm.js';

// ════════════════════════════════════════════════════════════
// /stop（plugin-agent 登记）：停下本会话在跑的一轮，做法同停止键，排着的照常开下一轮。这一轮的参与者（进了这一轮的各条输入
// 按 originTurnOf 算：真人的话是发言者，续做是发起它的那一轮的参与者，定时任务是建它的人）与 owner 能停，不看等级；排队中、
// 待插入的不算，没有账号的不算任何人。同一份实现，终端、QQ 私聊与群里一样。@ 她或引用她的消息发的 /stop（QQ 客户端在开头插一个
// 对她的 @，正文经 OneBot 适配器的解析函数造出）照样是指令，开头 @ 的是别人时不是。
// 经真实的网关、指令与权限插件（owner 是配置里的 QQ 号与本机的 console），模型是能阻塞某一次调用的替身。
// ════════════════════════════════════════════════════════════

const STOPPED = '已停下这一轮';
const IDLE = '没有在跑的一轮';
const DENIED = '只有参与这一轮的人和 owner 能停';
const PROBE = 'zz_stop_probe';

/** 机器人账号 */
const SELF = '10000';
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const A = { platform: 'onebot', userId: '30001' };
const B = { platform: 'onebot', userId: '30002' };
const C = { platform: 'onebot', userId: '30003' };
const GROUP = { sessionId: `onebot:${SELF}:group:20001`, sessionType: 'group', groupId: '20001' };
const CLI = { sessionId: 'cli-default', platform: 'cli', userId: 'console' };
const DM = { sessionId: `onebot:${SELF}:private:${A.userId}`, sessionType: 'private', ...A };

type Where = Pick<IncomingMessage, 'sessionId' | 'platform' | 'userId' | 'sessionType' | 'groupId'>;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const label = (inputs: readonly TurnInput[]) => inputs.map(i => i.message.content).join('+');

/**
 * decide 按这是第几次调用模型作答。给了 rooms 时另登记会话管理的桩，会话表里只有这几个已收录的房间：发送者前缀与停下标记的
 * 称呼按房间类别判
 */
async function boot(
  decide: (n: number) => ChatResponse = n => ({ content: `回${n}` }),
  { rooms }: { rooms?: string[] } = {},
) {
  const { app } = hostedApp({ owners: [OWNER_QQ] });
  apps.push(app);
  await registerHubs(app);
  if (rooms) {
    const table = sessionTableManager(rooms.map(id => storedRoom(id)));
    app.bind({ provide }).provide.use(sessionManager, { ...table, recordInbound: async () => {} });
  }
  const model = new StepModel((_request, n) => decide(n));
  await app.plugin(stepModelPlugin(model));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin);
  await app.plugin(commandsPlugin);
  await app.plugin(authorityPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  for (const p of [gatewayPlugin, commandsPlugin, authorityPlugin, agentPlugin]) {
    expect(app.plugins.getPlugin(p.name)?.state, `${p.name} 未激活`).toBe('active');
  }
  const host = app.bind({ events, hooks, tools, gateway, memory });
  host.tools.use.register({
    definition: {
      type: 'function',
      function: { name: PROBE, description: '探针', parameters: { type: 'object', properties: {} } },
    },
    handler: async () => 'ok',
  });
  const turns: Array<{ turnId: string; inputs: readonly TurnInput[]; outcome?: string }> = [];
  host.hooks.use.middleware('agent:turn:before', async (data, next) => {
    turns.push({ turnId: data.turnId, inputs: data.inputs });
    await next();
  });
  host.hooks.use.middleware('agent:turn:after', async (data, next) => {
    const turn = turns.find(t => t.turnId === data.turnId);
    if (turn) turn.outcome = data.outcome;
    await next();
  });
  const outbound: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', message => void outbound.push(message));
  const waiting = new Map<string, number>();
  host.events.use.on('agent:queue', state => void waiting.set(state.sessionId, state.waiting.length));
  /** 经网关入站一条：等它落定（指令执行完并回了话，或它所在的一轮结束） */
  const say = (where: Where, content: string, extra: Partial<IncomingMessage> = {}) =>
    host.gateway.use.ingressMessage({ content, ...where, ...extra } as IncomingMessage);
  return {
    model,
    say,
    outcomes: () => turns.map(t => [label(t.inputs), t.outcome]),
    /** 指令回到这个会话的话 */
    replies: (sessionId: string) =>
      outbound.filter(m => m.sessionId === sessionId && m.source === 'command').map(m => m.content),
    untilWaiting: (sessionId: string, count: number) => vi.waitFor(() => expect(waiting.get(sessionId)).toBe(count)),
    history: (sessionId: string) => host.memory.use.getHistory(sessionId, 100),
    turnIds: () => turns.map(t => t.turnId),
  };
}

describe.each([
  ['终端会话', CLI],
  ['QQ 私聊', DM],
] as const)('/stop：%s', (_kind, where) => {
  it('停下在跑的一轮，待插入的照常开下一轮；/stop 本身不进这一轮；没有在跑的回那一句', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const a = s.say(where, '<甲>');
    await held.entered;
    const b = s.say(where, '<乙>');
    await s.untilWaiting(where.sessionId, 1);
    await s.say(where, '/stop');
    expect(s.replies(where.sessionId)).toEqual([STOPPED]);
    await Promise.all([a, b]);
    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
    ]);

    await s.say(where, '/stop');
    expect(s.replies(where.sessionId)).toEqual([STOPPED, IDLE]);
  });
});

/**
 * A 的插话开一轮，第一次调用模型时 B 的话到了、还在待插入；这次调用回探针，B 的话插进第二次调用。两次调用都阻塞，返回时停在
 * 第一次（waiting）或第二次（joined）上
 */
async function groupTurn(phase: 'waiting' | 'joined', options?: Parameters<typeof boot>[1]) {
  const s = await boot(n => (n === 1 ? callTool(PROBE) : { content: `回${n}` }), options);
  const first = s.model.hold(1);
  const second = s.model.hold(2);
  const a = s.say({ ...GROUP, ...A }, '<甲>', { triggerType: 'interval' });
  await first.entered;
  const b = s.say({ ...GROUP, ...B }, '<乙>', { triggerType: 'interval' });
  await s.untilWaiting(GROUP.sessionId, 1);
  if (phase === 'joined') {
    first.release();
    await second.entered;
  }
  return {
    s,
    done: async () => {
      first.release();
      second.release();
      await Promise.all([a, b]);
    },
  };
}

describe('/stop 的判据：群里', () => {
  it('不在这一轮里的群友被拒，话还在待插入、没进这一轮的同样被拒；这一轮照常执行完毕', async () => {
    const { s, done } = await groupTurn('waiting');
    await s.say({ ...GROUP, ...C }, '/stop');
    await s.say({ ...GROUP, ...B }, '/stop');
    expect(s.replies(GROUP.sessionId)).toEqual([DENIED, DENIED]);
    await done();
    expect(s.outcomes()).toEqual([['<甲>+<乙>', 'replied']]);
  });

  it.each([
    ['插话开这一轮的群友', { ...GROUP, ...A }],
    ['插进这一轮的群友', { ...GROUP, ...B }],
    ['不在这一轮里的 owner', { ...GROUP, ...OWNER_QQ }],
    ['从 WebUI 往群里说话的 owner', { ...GROUP, platform: 'webui', userId: 'console' }],
  ] as const)('%s能停', async (_who, where) => {
    const { s, done } = await groupTurn('joined');
    await s.say(where, '/stop');
    expect(s.replies(GROUP.sessionId)).toEqual([STOPPED]);
    await done();
    expect(s.outcomes()).toEqual([['<甲>+<乙>', 'aborted']]);
  });
});

describe('/stop 的判据：注入开的一轮', () => {
  it.each([
    [
      '他发起的后台任务的结束通知开的一轮（续做）',
      {
        source: 'bg:bg_x_1',
        hostNotice: { kind: 'background', id: 'bg_x_1' },
        fromTurn: { platform: A.platform, userId: A.userId, participants: [A] },
      },
    ],
    ['他建的定时任务开的一轮', { source: 'scheduler', actor: A }],
  ] as const)('%s：这一轮按他算，他在 QQ 私聊里能停', async (_kind, injected) => {
    const s = await boot();
    const held = s.model.hold(1);
    const turn = s.say({ sessionId: DM.sessionId, platform: A.platform }, '<续>', injected);
    await held.entered;
    await s.say(DM, '/stop');
    expect(s.replies(DM.sessionId)).toEqual([STOPPED]);
    await turn;
    expect(s.outcomes()).toEqual([['<续>', 'aborted']]);
  });

  it.each([
    ['不带 actor', {}],
    ['带无主体的 actor', { actor: selfInitiatedActor('webui') }],
  ])('没有账号的注入发的 /stop 无法停止没有主体的一轮（%s）：这一轮照常回完', async (_kind, actor) => {
    const s = await boot();
    const where = { sessionId: 'zz-stop-internal', platform: 'webui' };
    const injected = { source: 'scheduler', ownerApproved: true, ...actor };
    const held = s.model.hold(1);
    const turn = s.say(where, '<定时>', injected);
    await held.entered;
    await s.say(where, '/stop', injected);
    held.release();
    await turn;
    expect(s.outcomes()).toEqual([['<定时>', 'replied']]);
  });
});

describe('/stop：开头对她的 @ 不算正文', () => {
  type Segment = { type: string; data: Record<string, string> };
  /** 这些消息段经 OneBot 适配器解析出的正文 */
  const parsed = (messageType: 'group' | 'private', message: Segment[]) =>
    new OneBotV11().parseMessageEvent(
      { time: 0, post_type: 'message', message_type: messageType, self_id: Number(SELF), message },
      SELF,
    )?.text ?? '';
  const at = (qq: string): Segment => ({ type: 'at', data: { qq } });
  const stop: Segment = { type: 'text', data: { text: ' /stop' } };
  const IN_GROUP = { ...GROUP, ...A };

  it.each([
    // 引用一条消息回复时，QQ 客户端在正文开头自动插一个对被引用者的 @；引用段不进正文，与 @ 她发的正文相同
    ['群里 @ 她或引用她的消息', IN_GROUP, parsed('group', [at(SELF), stop])],
    ['私聊里引用她的消息', DM, parsed('private', [at(SELF), stop])],
  ] as const)('%s发 /stop：停下在跑的一轮', async (_kind, where, content) => {
    const s = await boot();
    const held = s.model.hold(1);
    const turn = s.say(where, '<甲>');
    await held.entered;
    const command = s.say(where, content);
    await vi.waitFor(() => expect(s.replies(where.sessionId)).toEqual([STOPPED]));
    await Promise.all([turn, command]);
    expect(s.outcomes()).toEqual([['<甲>', 'aborted']]);
  });

  it.each([
    ['群里', IN_GROUP, parsed('group', [at(B.userId), stop])],
    ['私聊', DM, parsed('private', [at(B.userId), stop])],
  ] as const)('%s开头 @ 的是别人：不是指令，当普通消息排在这一轮之后', async (_kind, where, content) => {
    const s = await boot();
    const held = s.model.hold(1);
    const turn = s.say(where, '<甲>');
    await held.entered;
    const other = s.say(where, content);
    await s.untilWaiting(where.sessionId, 1);
    held.release();
    await Promise.all([turn, other]);
    expect(s.replies(where.sessionId)).toEqual([]);
    expect(s.outcomes()).toEqual([
      ['<甲>', 'replied'],
      [content, 'replied'],
    ]);
  });
});

// ════════════════════════════════════════════════════════════
// 停下的一轮给下一轮的模型留一句：这一轮在历史里有输入或工具调用组时，回合记录之前落一条停下标记（role system、kind
// turn-stopped，正文写给模型、写是谁停的），下一轮的请求里它紧跟这一轮的条目；什么也没留下的一轮（空闲开话题还没调工具就被
// 停下）不写。
// ════════════════════════════════════════════════════════════

const TURN_STOPPED = 'turn-stopped';
const isStopped = (m: Message) => m.kind === TURN_STOPPED;
/** 空闲开话题的输入：不落档 */
const IDLE_INPUT = { source: 'idle-trigger', triggerType: 'idle' } as const;
const IN_ROOM = { sessionId: GROUP.sessionId, platform: 'onebot' };

/** 请求里含这个记号的输入之后的那一条 */
function following(messages: readonly Message[], token: string): Message | undefined {
  const at = messages.findIndex(m => m.role === 'user' && String(m.content).includes(token));
  expect(at, `请求里有 ${token}`).toBeGreaterThanOrEqual(0);
  return messages[at + 1];
}

/** 存档里这一轮的各条：输入取记号，工具调用组写 call / result，停下标记与回合记录各写一个词 */
const turnShapes = (history: readonly Message[], turnId: string) =>
  history
    .filter(m => m.metadata?.[WellKnownMetadataKeys.TurnId] === turnId)
    .map(m => {
      const record = m.metadata?.[WellKnownMetadataKeys.TurnRecord] as TurnRecord | undefined;
      if (m.role === 'tool') return 'result';
      if (m.toolCalls?.length) return 'call';
      if (isStopped(m)) return '停下标记';
      if (record) return `结局 ${record.outcome}`;
      return String(m.content).match(/<[^<>\s]+>/)?.[0] ?? String(m.content);
    });

describe('停下的一轮给下一轮的模型留一句', () => {
  it('QQ 私聊里 /stop：下一轮的请求里紧跟这一轮的输入有停下标记，写是谁停的；存档里只有这一轮的一条，排在回合记录之前', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const a = s.say(DM, '<甲>');
    await held.entered;
    await s.say(DM, '/stop');
    await a;
    await s.say(DM, '<乙>');
    expect(s.outcomes()).toEqual([
      ['<甲>', 'aborted'],
      ['<乙>', 'replied'],
    ]);

    expect(following(s.model.requests[1].messages, '<甲>')).toMatchObject({
      role: 'system',
      kind: TURN_STOPPED,
      content: expect.stringMatching(/^\[已停下\].*被 30001 叫停/),
    });
    const history = await s.history(DM.sessionId);
    expect(history.filter(isStopped)).toHaveLength(1);
    expect(turnShapes(history, s.turnIds()[0])).toEqual(['<甲>', '停下标记', '结局 aborted']);
  });

  it('群里插进这一轮的群友 /stop：停下标记写他的账号', async () => {
    const { s, done } = await groupTurn('joined');
    await s.say({ ...GROUP, ...B }, '/stop');
    await done();
    await s.say({ ...GROUP, ...A }, '<丙>', { triggerType: 'interval' });
    expect(following(s.model.requests.at(-1)?.messages ?? [], '<乙>')).toMatchObject({
      kind: TURN_STOPPED,
      content: expect.stringContaining('被 30002 叫停'),
    });
  });

  it('owner 从 WebUI 停群里的一轮：停下标记写他在群所在平台登记的账号', async () => {
    const { s, done } = await groupTurn('joined', { rooms: [GROUP.sessionId] });
    await s.say({ ...GROUP, platform: 'webui', userId: 'console' }, '/stop');
    await done();
    await s.say({ ...GROUP, ...A }, '<丙>', { triggerType: 'interval' });
    expect(following(s.model.requests.at(-1)?.messages ?? [], '<乙>')).toMatchObject({
      kind: TURN_STOPPED,
      content: expect.stringContaining(`被 ${OWNER_QQ.userId} 叫停`),
    });
  });

  it('静默收尾与出错收尾的一轮不写停下标记：输入都归了档，只有被停下的一轮才写', async () => {
    const s = await boot(n => {
      if (n === 2) throw new Error('<模型坏了>');
      return { content: n === 1 ? '' : `回${n}` };
    });
    await s.say(DM, '<甲>');
    await s.say(DM, '<乙>');
    await s.say(DM, '<丙>');
    expect(s.outcomes()).toEqual([
      ['<甲>', 'silent'],
      ['<乙>', 'error'],
      ['<丙>', 'replied'],
    ]);
    expect((await s.history(DM.sessionId)).filter(isStopped)).toEqual([]);
    expect(s.model.requests[2].messages.filter(isStopped)).toEqual([]);
  });

  it('空闲开话题的一轮还没调工具就被停下：这一轮在历史里什么也没留下，不写停下标记，下一轮的请求里也没有', async () => {
    const s = await boot();
    const held = s.model.hold(1);
    const idle = s.say(IN_ROOM, '开个话题', IDLE_INPUT);
    await held.entered;
    await s.say({ ...GROUP, ...OWNER_QQ }, '/stop');
    await idle;
    await s.say({ ...GROUP, ...A }, '<乙>', { triggerType: 'interval' });
    expect(s.outcomes()).toEqual([
      ['开个话题', 'aborted'],
      ['<乙>', 'replied'],
    ]);
    expect((await s.history(GROUP.sessionId)).filter(isStopped)).toEqual([]);
    expect(s.model.requests[1].messages.filter(isStopped)).toEqual([]);
  });

  it('空闲开话题的一轮调过工具之后被停下：工具调用组之后有停下标记', async () => {
    const s = await boot(n => (n === 1 ? callTool(PROBE) : { content: `回${n}` }));
    const held = s.model.hold(2);
    const idle = s.say(IN_ROOM, '开个话题', IDLE_INPUT);
    await held.entered;
    await s.say({ ...GROUP, ...OWNER_QQ }, '/stop');
    await idle;
    expect(s.outcomes()).toEqual([['开个话题', 'aborted']]);
    expect(turnShapes(await s.history(GROUP.sessionId), s.turnIds()[0])).toEqual([
      'call',
      'result',
      '停下标记',
      '结局 aborted',
    ]);
  });
});
