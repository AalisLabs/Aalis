import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { type Approval, type ApprovalSurface, approvals } from '../../packages/api-approval/src/index.js';
import { INBOUND_PHASE } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import chatApprovalPlugin from '../../packages/plugin-chat-approval/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import type {
  IncomingMessage,
  OutboundDeliveryResult,
  OutgoingMessage,
} from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { seedRooms } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// 聊天审批：owner 与她的 IM 私聊作审批面，每个（owner 的 IM 身份，机器人账号）一份接入。她经这个账号亲手说话（私聊或群里）
// 即在场，她经这个账号发起的审批推到她与这个账号的私聊，卡上写来源；她在私聊里引用那条审批消息回复「同意」或「拒绝 原因」
// 即结，回复不交给 agent。真实的网关、会话管理、权限与会话服务，一个记录出站的假平台适配器（每条出站回一个平台消息 id，
// 可选声明会话类型、改写投递结果），agent 是记录收到什么的假件，另有一个覆盖全部会话的审批面代表 WebUI 与终端。房间预置进
// 会话表（来源字段与 OneBot 的声明相同）。工具调用按 agent 工具循环的填法构造，探针工具人人可用、声明需要确认。
// 假 agent 不按 latest-wins 中止在跑的回合：「交给 agent，审批照旧等」只说明本插件不截下、不结算它；今天的 agent 收到
// 这样的消息会中止在等审批的那一轮，审批随之撤销（见插件文档「应答」一节）。
// ════════════════════════════════════════════════════════════

/** 机器人账号甲与乙 */
const SELF = '10000';
const SELF_B = '10001';
const OWNER_QQ = { platform: 'onebot', userId: '99999' };
const OWNER_DM = `onebot:${SELF}:private:${OWNER_QQ.userId}`;
/** 她与账号乙的私聊 */
const OWNER_DM_B = `onebot:${SELF_B}:private:${OWNER_QQ.userId}`;
const GROUP_ID = '20001';
const GROUP = `onebot:${SELF}:group:${GROUP_ID}`;
/** 同一个群，经账号乙 */
const GROUP_B = `onebot:${SELF_B}:group:${GROUP_ID}`;
/** 群号恰好是 owner 的 QQ 号的群：会话 id 里的目标与 owner 私聊的相同 */
const OWNER_NUMBER_GROUP = `onebot:${SELF}:group:${OWNER_QQ.userId}`;
/** 机器人账号自己 */
const BOT = { platform: 'onebot', userId: SELF };
const MEMBER_ID = '30001';
const PROBE = 'zz_confirm_probe';
const WAIT_MS = 300_000;
/** 覆盖审批的在场都失效之后的重连宽限 */
const GRACE_MS = 30_000;
const MINUTE = 60_000;

/** 审批服务回给模型的话（见 plugin-session-server 的 approvals.ts） */
const ABSENT = '没人在场';
/** 本插件的话（字典原文） */
const REQUEST = '需要你批准';
const ALREADY_SETTLED = '这张已经处理过';
const ANSWER_ELSEWHERE = '这条审批无法在这里应答';

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 让经入站事件进来、不等待的相位链跑完（setImmediate 不在假时钟内） */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** 群消息上的字段：会话 id 按 OneBot 的写法拆出机器人账号与群号 */
function group(sessionId = GROUP): Partial<IncomingMessage> {
  const [, selfId, , groupId] = sessionId.split(':');
  return { sessionId, sessionType: 'group', selfId, groupId };
}

/**
 * declared 为假时适配器不声明会话类型：私聊的一对一是推断出来的。deliver 给出平台对一条出站（带它的平台消息 id）的
 * 投递结果；owners 是配置里的 owner；rooms 是预置进会话表的房间（会话 id → 名字）；swallowGroup 为真时触发相位吞掉
 * 群消息（如没点名、没被挑中的群聊）
 */
async function setup({
  declared = true,
  deliver = id => ({ ok: true, messageIds: [id] }),
  owners = [OWNER_QQ],
  rooms = { [OWNER_DM]: 'owner', [GROUP]: '读书会', [OWNER_NUMBER_GROUP]: '群' },
  swallowGroup = false,
}: {
  declared?: boolean;
  deliver?: (id: string) => OutboundDeliveryResult | Promise<OutboundDeliveryResult>;
  owners?: Array<{ platform: string; userId: string }>;
  rooms?: Record<string, string>;
  swallowGroup?: boolean;
} = {}) {
  const { app } = hostedApp({ owners });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-chat-approval-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, tools, memory });
  host.provide.use(storage, memoryStorage(new Map()));
  // 房间要在会话管理读表之前预置进记忆后端
  await app.plugin(memoryInMemoryPlugin);
  await app.plugins.idle();
  await seedRooms(host.memory.use, rooms);

  /** 平台收下的出站，各带平台给的消息 id */
  const outbound: Array<{ message: OutgoingMessage; id: string }> = [];
  const adapterPlugin = definePlugin({
    name: '@test/chat-adapter',
    provides: [platform],
    uses: { provide, events },
    apply: ({ provide, events }) => {
      provide.use(platform, {
        adapterName: 'chat',
        platform: 'onebot',
        ...(declared
          ? {
              sessionTypes: [
                { name: 'group', multiParty: true },
                { name: 'private', multiParty: false },
              ],
            }
          : {}),
        getConnections: () => [],
        sendMessage: async () => {},
        canHandle: id => id.startsWith('onebot:'),
      });
      events.use.on('outbound:message', message => {
        if (message.delivery || !message.sessionId.startsWith('onebot:')) return;
        const id = `m${outbound.length + 1}`;
        outbound.push({ message, id });
        message.delivery = Promise.resolve(deliver(id));
      });
    },
  });
  /** agent 收到的入站 */
  const received: IncomingMessage[] = [];
  const agentPlugin = definePlugin({
    name: '@test/agent',
    provides: [agent],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(agent, {
        handleMessage: async (message: IncomingMessage) => {
          received.push(message);
        },
      } as never);
    },
  });
  const triggerPlugin = definePlugin({
    name: '@test/trigger',
    uses: { hooks },
    apply: ({ hooks }) => {
      hooks.use.middleware(INBOUND_PHASE.TRIGGER, async (data, next) => {
        if (swallowGroup && data.message.sessionType === 'group') return;
        await next();
      });
    },
  });
  const surfaces: Record<string, ApprovalSurface> = {};
  const otherSurfacePlugin = definePlugin({
    name: '@test/other-surface',
    uses: { approvals },
    apply: ({ approvals }) => {
      surfaces.other = approvals.use.registerSurface('other');
    },
  });
  const plugins = [
    toolsPlugin,
    authorityPlugin,
    sessionManagerPlugin,
    sessionServerPlugin,
    gatewayPlugin,
    adapterPlugin,
    agentPlugin,
    triggerPlugin,
    otherSurfacePlugin,
    chatApprovalPlugin,
  ];
  await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
  await app.plugins.idle();
  for (const { name } of plugins) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }

  let runs = 0;
  host.tools.use.register({
    confirm: 'session',
    display: { kind: 'command', fields: { command: 'command' } },
    definition: {
      type: 'function',
      function: {
        name: PROBE,
        description: '探针',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
    handler: async () => {
      runs++;
      return 'ran';
    },
  });

  let seq = 0;
  /** owner 在 QQ 上经账号甲发一条（缺省在私聊，经网关的整条入站链）；over 改写消息上的字段 */
  const say = async (content: string, over: Partial<IncomingMessage> = {}) => {
    const message: IncomingMessage = {
      content,
      sessionId: OWNER_DM,
      platform: OWNER_QQ.platform,
      sessionType: 'private',
      selfId: SELF,
      userId: OWNER_QQ.userId,
      messageId: `in-${++seq}`,
      ...over,
    };
    await host.events.use.emit('inbound:message', message);
    await settle();
    return message;
  };
  /** 引用平台消息 quoted 回复 */
  const reply = (content: string, quoted: string, over: Partial<IncomingMessage> = {}) =>
    say(content, { replyTo: { messageId: quoted }, ...over });
  /** 这一轮调探针：who 在 sessionId 里亲手发起（缺省是 owner 在私聊里）；box 在调用结束时拿到结果 */
  const call = (args: Record<string, unknown> = { command: 'rm -rf build' }, who = OWNER_QQ, sessionId = OWNER_DM) => {
    seq++;
    const ctx: ToolCallContext = {
      sessionId,
      ...who,
      inbound: {},
      turnId: `turn-${seq}`,
      callId: `call-${seq}`,
    };
    const box: { content?: string } = {};
    const result = host.tools.use.execute(PROBE, args, ctx).then(r => {
      box.content = r.content;
      return r.content;
    });
    return Object.assign(box, { result });
  };
  /** 推到私聊的审批消息 */
  const requests = () => outbound.filter(({ message }) => message.content.includes(REQUEST));
  /** 等第 n 条审批消息推到私聊 */
  const requested = async (n = 1) => {
    await vi.waitFor(() => expect(requests()).toHaveLength(n));
    return requests()[n - 1];
  };
  /** 推到私聊的、含 text 的消息正文 */
  const lines = (text: string) => outbound.map(({ message }) => message.content).filter(c => c.includes(text));
  /** owner 在另一个审批面上接入的客户端，覆盖全部会话；got 是推给它的审批 */
  const elsewhere = () => {
    const got: Approval[] = [];
    const attendance = surfaces.other.attend(OWNER_QQ, {
      requested: approval => void got.push(approval),
      settled() {},
    });
    return Object.assign(attendance, { got });
  };
  return { app, say, reply, call, requested, requests, lines, elsewhere, outbound, received, runs: () => runs };
}

/** 收集 run 期间逃逸成进程级未处理拒绝的错误 */
async function escapedDuring(run: () => Promise<void>): Promise<string[]> {
  const escaped: string[] = [];
  const onEscape = (err: unknown) => void escaped.push(String(err));
  process.on('unhandledRejection', onEscape);
  try {
    await run();
    await settle();
  } finally {
    process.off('unhandledRejection', onEscape);
  }
  return escaped;
}

describe('推送', () => {
  it('owner 私聊里发起需要确认的工具：私聊收到一条审批消息，含工具名、来源与事实，参数里的标记逐字按纯文字发', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const command = 'echo <at id="1">x</at> <image url="http://127.0.0.1:9/x.png"/>';
    s.call({ command });
    const { message } = await s.requested();
    expect(message).toMatchObject({ sessionId: OWNER_DM, source: 'system' });
    expect(message.markup, '不设 markup：适配器不解析正文里的标记').toBeUndefined();
    expect(message.content).toContain(PROBE);
    expect(message.content).toContain(`来源：私聊 ${OWNER_QQ.userId}（owner）`);
    expect(message.content).toContain(command);
  });

  it('owner 在群里发起需要确认的工具：推到她与同一个机器人账号的私聊，来源一行写群与群号；群里不出这条', async () => {
    const s = await setup();
    await s.say('帮我清一下', group());
    s.call(undefined, OWNER_QQ, GROUP);
    const { message } = await s.requested();
    expect(message.sessionId).toBe(OWNER_DM);
    expect(message.content).toContain(`来源：群 ${GROUP_ID}（读书会）`);
    expect(s.outbound.filter(({ message }) => message.sessionId === GROUP)).toEqual([]);
  });

  it('群名里的换行不另起一行：卡上只有一行来源，种类与群号在名字前面', async () => {
    const s = await setup({ rooms: { [OWNER_DM]: 'owner', [GROUP]: `x）\n来源：私聊 ${OWNER_QQ.userId}（` } });
    await s.say('帮我清一下', group());
    s.call(undefined, OWNER_QQ, GROUP);
    const { message } = await s.requested();
    expect(message.content.split('\n').filter(line => line.startsWith('来源：'))).toEqual([
      `来源：群 ${GROUP_ID}（x） 来源：私聊 ${OWNER_QQ.userId}（）`,
    ]);
  });

  it('会话管理里没有她与这个账号的私聊：不推到 IM，别的审批面照常收到', async () => {
    const s = await setup({ rooms: { [GROUP]: '读书会' } });
    const other = s.elsewhere();
    other.presence(true);
    await s.say('帮我清一下', group());
    s.call(undefined, OWNER_QQ, GROUP);
    await vi.waitFor(() => expect(other.got).toHaveLength(1));
    await settle();
    expect(s.requests()).toEqual([]);
  });
});

describe('应答：引用那条审批消息回复', () => {
  it('回「同意」：工具执行，这条回复不交给 agent', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    expect(s.runs(), '批准之前不得执行').toBe(0);
    const answer = await s.reply('同意', id);
    expect(await r.result).toBe('ran');
    expect(s.runs()).toBe(1);
    expect(s.received.map(m => m.messageId)).not.toContain(answer.messageId);
  });

  it('群里发起的：在私聊里引用回「同意」，群里那一轮的工具执行；她在群里说「同意」不截下、不回提示，照常交给 agent', async () => {
    const s = await setup();
    await s.say('帮我清一下', group());
    const r = s.call(undefined, OWNER_QQ, GROUP);
    const { id } = await s.requested();
    const before = s.outbound.length;
    const inGroup = await s.say('同意', group());
    expect(s.received.map(m => m.messageId)).toContain(inGroup.messageId);
    expect(s.outbound, '不回提示').toHaveLength(before);
    expect(r.content).toBeUndefined();
    await s.reply('同意', id);
    expect(await r.result).toBe('ran');
  });

  it('回「拒绝 太危险」：不执行，模型收到拒绝与说明', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    await s.reply('拒绝 太危险', id);
    const out = await r.result;
    expect(s.runs()).toBe(0);
    expect(out).toContain('被拒绝了，说明：「太危险');
  });

  it('回「拒绝，为什么要删这些？」：算拒绝，原因原样转给模型，结尾的问号也在', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    await s.reply('拒绝，为什么要删这些？', id);
    await vi.waitFor(() => expect(r.content).toContain('被拒绝了，说明：「为什么要删这些？」。'));
    expect(s.runs()).toBe(0);
  });

  it('回 300 字的拒绝原因：照样算拒绝，原因整段转给模型', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    const reason = '先别删'.repeat(100);
    await s.reply(`拒绝 ${reason}`, id);
    await vi.waitFor(() => expect(r.content).toContain(`被拒绝了，说明：「${reason}」。`));
    expect(s.runs()).toBe(0);
  });

  it.each([
    '同意。',
    '  同意！',
    '同意？',
    'Approve.',
  ])('首尾的空白与标点不论、英文不分大小写：「%s」也算批准', async text => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    await s.reply(text, id);
    expect(await r.result).toBe('ran');
  });

  it('A 结算后紧接推出 B：引用 A 的回复不批 B，回「这张已经处理过」；引用 B 的才批 B', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const a = s.call();
    const first = await s.requested();
    await s.reply('同意', first.id);
    expect(await a.result).toBe('ran');
    const b = s.call();
    const second = await s.requested(2);
    await s.reply('同意', first.id);
    expect(s.lines(ALREADY_SETTLED)).toHaveLength(1);
    expect(b.content).toBeUndefined();
    expect(s.runs()).toBe(1);
    await s.reply('同意', second.id);
    expect(await b.result).toBe('ran');
  });

  it('同一个入站消息 id 重复到达：只应答一次，重复的静默吞掉', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    await s.reply('同意', id, { messageId: 'in-dup' });
    expect(await r.result).toBe('ran');
    const before = s.outbound.length;
    await s.reply('同意', id, { messageId: 'in-dup' });
    expect(s.outbound, '重复的不回任何话').toHaveLength(before);
    expect(s.received.map(m => m.messageId)).not.toContain('in-dup');
  });

  it.each([
    '同意',
    '拒绝 太危险',
    '拒绝了他的邀请',
    '等一下，我先看看',
  ])('有审批在等时没引用审批消息的「%s」：不截下、不回提示，照常交给这一轮，审批照旧等', async text => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    await s.requested();
    const before = s.outbound.length;
    const said = await s.say(text);
    expect(s.received.map(m => m.messageId)).toContain(said.messageId);
    expect(s.outbound, '不回提示').toHaveLength(before);
    expect(r.content).toBeUndefined();
    expect(s.runs()).toBe(0);
  });

  it('引用审批消息、很长的一串空白后跟一个字：不是应答，不卡住入站', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    s.call();
    const { id } = await s.requested();
    const started = performance.now();
    const long = await s.reply(`a${' '.repeat(100_000)}x`, id);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(s.received.map(m => m.messageId)).toContain(long.messageId);
  });

  it.each([
    '同意吗？',
    'denylist',
    '同意不了',
    '同意之前先说明一下',
    '先别批',
  ])('引用审批消息、但不是应答词的「%s」：不批，照常交给这一轮，审批照旧等', async text => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    const before = s.outbound.length;
    const said = await s.reply(text, id);
    expect(s.received.map(m => m.messageId)).toContain(said.messageId);
    expect(s.outbound, '不回提示').toHaveLength(before);
    expect(r.content).toBeUndefined();
    expect(s.runs()).toBe(0);
  });

  it('送达了但平台没给消息 id：私聊里补一句这里无法应答；之后引用它回「同意」认不出引用，照常交给这一轮、不回提示，审批照旧等', async () => {
    const s = await setup({ deliver: () => ({ ok: true }) });
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    await vi.waitFor(() => expect(s.lines(ANSWER_ELSEWHERE)).toHaveLength(1));
    const before = s.outbound.length;
    const answer = await s.reply('同意', id);
    expect(s.outbound, '不回提示').toHaveLength(before);
    expect(r.content).toBeUndefined();
    expect(s.received.map(m => m.messageId)).toContain(answer.messageId);
  });

  it('带 source 的注入引用审批消息回「同意」：不是 owner 亲手发的，不批', async () => {
    const s = await setup();
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    await s.reply('同意', id, { source: 'system' });
    expect(r.content).toBeUndefined();
    expect(s.runs()).toBe(0);
  });

  it('一对一窗口的对端不是发言者（机器人账号登记成了 owner，实现端上报了它自己发的消息）：引用审批消息的「同意」不认', async () => {
    const s = await setup({ owners: [OWNER_QQ, BOT] });
    await s.say('帮我清一下');
    const r = s.call();
    const { id } = await s.requested();
    const echoed = await s.reply('同意', id, BOT);
    expect(r.content).toBeUndefined();
    expect(s.runs()).toBe(0);
    expect(s.received.map(m => m.messageId)).toContain(echoed.messageId);
  });

  it('群号恰好是 owner 的 QQ 号的群不是她的私聊：群里发起的推到她的私聊、不推进群里；在群里引用审批消息回「同意」不批，照常交给 agent', async () => {
    const s = await setup();
    const inGroup = group(OWNER_NUMBER_GROUP);
    await s.say('帮我清一下', inGroup);
    const r = s.call(undefined, OWNER_QQ, OWNER_NUMBER_GROUP);
    const { id, message } = await s.requested();
    expect(message.sessionId).toBe(OWNER_DM);
    expect(s.outbound.filter(({ message }) => message.sessionId === OWNER_NUMBER_GROUP)).toEqual([]);
    const quoted = await s.reply('同意', id, inGroup);
    expect(r.content).toBeUndefined();
    expect(s.runs()).toBe(0);
    expect(s.received.map(m => m.messageId)).toContain(quoted.messageId);
  });
});

describe('接入与在场', () => {
  it('她只在群里亲手说过话、没点名被触发器吞掉的也算：私聊这一面在场；带 source 的注入与别人的话不算', async () => {
    const s = await setup({ swallowGroup: true });
    await s.say('别人说的', { ...group(), userId: MEMBER_ID });
    await s.say('定时任务的提醒', { ...group(), source: 'scheduler' });
    const before = s.call(undefined, OWNER_QQ, GROUP);
    expect(await before.result).toContain(ABSENT);

    const chat = await s.say('随口一句', group());
    expect(
      s.received.map(m => m.messageId),
      '这句被触发相位吞掉了',
    ).not.toContain(chat.messageId);
    s.call(undefined, OWNER_QQ, GROUP);
    const { message } = await s.requested();
    expect(message.sessionId).toBe(OWNER_DM);
  });

  it('她第一次经账号乙在群里说话、会话管理里有她与乙的私聊：建接入、定下那个私聊，经乙发起的推到那里', async () => {
    const s = await setup({ rooms: { [OWNER_DM]: 'owner', [OWNER_DM_B]: 'owner', [GROUP_B]: '读书会' } });
    await s.say('帮我清一下', group(GROUP_B));
    s.call(undefined, OWNER_QQ, GROUP_B);
    const { message } = await s.requested();
    expect(message.sessionId).toBe(OWNER_DM_B);
  });

  it('只与账号甲有私聊时经乙说话不建接入，经乙发起的不推到甲；之后她私聊乙，第一条消息（与建档同一拍）即建', async () => {
    const s = await setup({ rooms: { [OWNER_DM]: 'owner', [GROUP_B]: '读书会' } });
    await s.say('帮我清一下', group(GROUP_B));
    const before = s.call(undefined, OWNER_QQ, GROUP_B);
    expect(await before.result).toContain(ABSENT);
    expect(s.requests()).toEqual([]);

    await s.say('在吗', { sessionId: OWNER_DM_B, selfId: SELF_B });
    s.call(undefined, OWNER_QQ, GROUP_B);
    const { message } = await s.requested();
    expect(message.sessionId).toBe(OWNER_DM_B);
  });

  it('会话管理的入站监听排在聊天审批之后（会话管理后启用）：她第一次私聊这个账号，第一条消息照样建接入、上报在场', async () => {
    const { app } = hostedApp({ owners: [OWNER_QQ] });
    apps.push(app);
    await registerHubs(app);
    await app.plugin(memoryInMemoryPlugin);
    await app.plugins.idle();
    const adapterPlugin = definePlugin({
      name: '@test/chat-adapter',
      provides: [platform],
      uses: { provide },
      apply: ({ provide }) => {
        provide.use(platform, {
          adapterName: 'chat',
          platform: 'onebot',
          sessionTypes: [
            { name: 'group', multiParty: true },
            { name: 'private', multiParty: false },
          ],
          getConnections: () => [],
          sendMessage: async () => {},
          canHandle: id => id.startsWith('onebot:'),
        });
      },
    });
    // 审批服务是只记接入的替身：会话服务的审批要用会话管理，用它聊天审批就排不到会话管理前面
    const attended: Array<{ who: unknown; scope: unknown; presence: boolean[] }> = [];
    const approvalsPlugin = definePlugin({
      name: '@test/approvals',
      provides: [approvals],
      uses: { provide },
      apply: ({ provide }) => {
        provide.use(approvals, {
          request: () => new Promise(() => {}),
          list: () => [],
          attachSurface: () => ({
            attend: (who, _sink, scope) => {
              const entry = { who, scope, presence: [] as boolean[] };
              attended.push(entry);
              return {
                presence: active => void entry.presence.push(active),
                respond: () => ({ ok: true }),
                leave() {},
              };
            },
            detach() {},
          }),
        });
      },
    });
    const plugins = [authorityPlugin, gatewayPlugin, adapterPlugin, approvalsPlugin, chatApprovalPlugin];
    await app.pluginAll(plugins.map(definition => ({ definition, config: {} })));
    await app.plugins.idle();
    await app.plugin(sessionManagerPlugin, {});
    await app.plugins.idle();
    for (const { name } of [...plugins, sessionManagerPlugin]) {
      expect(app.plugins.getPlugin(name)?.state, name).toBe('active');
    }
    await app.bind({ events }).events.use.emit('inbound:message', {
      content: '在吗',
      sessionId: OWNER_DM,
      platform: OWNER_QQ.platform,
      sessionType: 'private',
      selfId: SELF,
      userId: OWNER_QQ.userId,
      messageId: 'in-1',
    });
    await settle();
    expect(attended).toEqual([{ who: OWNER_QQ, scope: { selfId: SELF }, presence: [true] }]);
  });

  it('WebUI 与终端的 owner 身份发的消息不建 IM 接入、不算在场；从 WebUI 往她的私聊插话发起的也不推到私聊', async () => {
    const s = await setup();
    const fromHost = { sessionType: undefined, selfId: undefined, userId: 'console' };
    await s.say('从网页插一句', { ...fromHost, platform: 'webui' });
    await s.say('从终端插一句', { ...fromHost, platform: 'cli' });
    const fromWebui = s.call(undefined, { platform: 'webui', userId: 'console' });
    expect(await fromWebui.result).toContain(ABSENT);

    await s.say('我在');
    const again = s.call(undefined, { platform: 'webui', userId: 'console' });
    expect(await again.result).toContain(ABSENT);
    expect(s.requests()).toEqual([]);
    s.call();
    await s.requested();
  });

  it('适配器没声明会话类型、一对一是推断出来的：不建接入，按不在场拒', async () => {
    const s = await setup({ declared: false });
    await s.say('帮我清一下');
    const r = s.call();
    expect(await r.result).toContain(ABSENT);
    expect(s.requests()).toEqual([]);
  });

  it('在这里引用回审批也算亲手发言：第 9 分钟批了 A，第 16 分钟的 B 照常推到私聊', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await s.say('帮我清一下');
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const first = s.call();
    const { id } = await s.requested();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    await s.reply('同意', id);
    expect(await first.result).toBe('ran');
    await vi.advanceTimersByTimeAsync(7 * MINUTE);
    s.call();
    await s.requested(2);
  });

  it('等满时限：私聊收到一行过期', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await s.say('帮我清一下');
    const r = s.call();
    await s.requested();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(await r.result).toContain('300 秒');
    await vi.waitFor(() => expect(s.lines('已过期')).toHaveLength(1));
    expect(s.lines('已过期')[0]).toContain(PROBE);
  });

  it('末行的剩余分钟数按审批的到期时刻算：推出两分半之后才补推到私聊的写 3 分钟', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const other = s.elsewhere();
    other.presence(true);
    s.call();
    await vi.waitFor(() => expect(other.got).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2.5 * MINUTE);
    await s.say('我在');
    const { message } = await s.requested();
    expect(message.content).toContain('3 分钟内不回按过期');
  });

  it('墙钟已过到期时刻、等待的计时器还没到：补推的末行写 1 分钟，不写负数', async () => {
    const s = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const other = s.elsewhere();
    other.presence(true);
    s.call();
    await vi.waitFor(() => expect(other.got).toHaveLength(1));
    vi.setSystemTime(Date.now() + 6 * MINUTE);
    await s.say('我在');
    const { message } = await s.requested();
    expect(message.content).toContain('；1 分钟内不回按过期');
  });
});

describe('没送达', () => {
  it('审批消息没送达：owner 在这里看不到它，不白等，宽限之后按不在场结', async () => {
    const s = await setup({ deliver: () => ({ ok: false, error: '发送失败' }) });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await s.say('帮我清一下');
    const r = s.call();
    await s.requested();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await vi.waitFor(() => expect(r.content).toEqual(expect.stringContaining(ABSENT)));
  });

  it('没送达之后她在宽限内再说话：这张补推到私聊、送达，引用它照常应答', async () => {
    let fail = true;
    const s = await setup({
      deliver: id => (fail ? { ok: false, error: '发送失败' } : { ok: true, messageIds: [id] }),
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await s.say('帮我清一下');
    const r = s.call();
    await s.requested();
    await settle();
    fail = false;
    await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
    await s.say('我在');
    const { id } = await s.requested(2);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(r.content).toBeUndefined();
    await s.reply('同意', id);
    expect(await r.result).toBe('ran');
  });

  it('一张送达、一张没送达，她再说话：只补推没送达的那张，送达过的不再发', async () => {
    const s = await setup({
      deliver: id => (id === 'm2' ? { ok: false, error: '发送失败' } : { ok: true, messageIds: [id] }),
    });
    await s.say('帮我清一下');
    s.call({ command: 'rm -rf a' });
    await s.requested();
    s.call({ command: 'rm -rf b' }, OWNER_QQ, GROUP);
    await s.requested(2);
    await settle();
    await s.say('我在');
    await s.requested(3);
    await settle();
    const contents = s.requests().map(({ message }) => message.content);
    expect(contents.filter(c => c.includes('rm -rf a'))).toHaveLength(1);
    expect(contents.filter(c => c.includes('rm -rf b'))).toHaveLength(2);
  });

  it('过期那一行只发给送达过的：没送达的这张等满时限过期，私聊里不发', async () => {
    const s = await setup({ deliver: () => ({ ok: false, error: '发送失败' }) });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const other = s.elsewhere();
    other.presence(true);
    await s.say('帮我清一下');
    const r = s.call();
    await s.requested();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(await r.result).toContain('300 秒');
    await settle();
    expect(s.lines('已过期')).toEqual([]);
  });

  it('迟到的投递失败只为还在等的那张上报离开：已经在别处结了的 A 回执失败，不清掉随后送达的 B 的在场', async () => {
    let failFirst = () => {};
    const s = await setup({
      deliver: id =>
        id === 'm1'
          ? new Promise(resolve => {
              failFirst = () => resolve({ ok: false, error: '发送失败' });
            })
          : { ok: true, messageIds: [id] },
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await s.say('帮我清一下');
    const other = s.elsewhere();
    other.presence(true);
    const first = s.call();
    await s.requested();
    const [approval] = other.got;
    other.respond({ approvalId: approval.id, decision: 'approve', contentHash: approval.contentHash });
    expect(await first.result).toBe('ran');
    const second = s.call();
    await s.requested(2);
    await settle();
    other.leave();
    failFirst();
    await settle();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(second.content).toBeUndefined();
  });
});

describe('发不出去与停用', () => {
  /** 审批消息的回执先扣着：放行时回送达、不带消息 id（插件随后会补一句这里无法应答） */
  async function held() {
    const release: Array<() => void> = [];
    const s = await setup({ deliver: () => new Promise(resolve => release.push(() => resolve({ ok: true }))) });
    await s.say('帮我清一下');
    s.call();
    await s.requested();
    return {
      s,
      release: () => {
        for (const deliver of release.splice(0)) deliver();
      },
    };
  }

  it('推送等回执时停用网关：没有未处理的拒绝，之后不再往私聊发消息', async () => {
    const { s, release } = await held();
    const before = s.outbound.length;
    const escaped = await escapedDuring(async () => {
      await s.app.plugins.disable('@aalis/plugin-gateway');
      release();
    });
    expect(escaped).toEqual([]);
    expect(s.outbound).toHaveLength(before);
  });

  it('推送等回执时停用聊天审批：没有未处理的拒绝，之后不再往私聊发消息', async () => {
    const { s, release } = await held();
    const before = s.outbound.length;
    const escaped = await escapedDuring(async () => {
      await s.app.plugins.disable('@aalis/plugin-chat-approval');
      release();
    });
    expect(escaped).toEqual([]);
    expect(s.outbound).toHaveLength(before);
  });

  it('适配器的回执 reject：没有未处理的拒绝，按没送达处理，宽限之后按不在场结', async () => {
    const s = await setup({ deliver: () => Promise.reject(new Error('适配器出错')) });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await s.say('帮我清一下');
    const r = s.call();
    const escaped = await escapedDuring(async () => {
      await s.requested();
    });
    expect(escaped).toEqual([]);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    await vi.waitFor(() => expect(r.content).toEqual(expect.stringContaining(ABSENT)));
  });
});
