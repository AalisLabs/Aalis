import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import {
  audienceIncludes,
  gateway,
  INBOUND_PHASE,
  type InboundPhaseData,
  REPLY_AUDIENCE_FIELD,
} from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { SessionTypeDecl } from '../../packages/api-platform/src/index.js';
import { type App, definePlugin, provide } from '../../packages/core/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { storedRoom } from '../fixtures/rooms.js';
import { ONEBOT_TYPES, startSettings } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 回复策略的生效范围（audience）与按会话的参数：三个回复策略插件（trigger-policy、trigger-laya、flow-control）的「生效范围」
// 是 api-gateway 导出的同一个字段，取值不生效、多方房间（默认）、一对一房间、全部房间；冷却、阈值等参数可按会话设，每条消息
// 按会话现读。聊天窗口的多方与否由网关按这个平台的类型声明算一次（data.chat），带 source 的内部注入不给，插件对它们照旧取会话
// 记下的窗口。owner 从 WebUI 往房间里插话时触发插件与流控都直接放行。
// 经真实的网关、会话管理、会话设置与回复策略插件走入站相位链；agent 是记录型假件，回复由用例显式发出。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const GROUP = `onebot:${SELF}:group:20001`;
const CHANNEL = `onebot:${SELF}:channel:40001:50001`;
const PRIVATE = `onebot:${SELF}:private:30001`;
const POLICY = triggerPolicyPlugin.name;
const FLOW = flowControlPlugin.name;

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

const fromGroup = (content: string, sessionId = GROUP, groupId = '20001'): IncomingMessage => ({
  content,
  sessionId,
  platform: 'onebot',
  sessionType: 'group',
  selfId: SELF,
  groupId,
  userId: '30002',
});
const fromChannel = (content: string): IncomingMessage => ({
  content,
  sessionId: CHANNEL,
  platform: 'onebot',
  sessionType: 'channel',
  selfId: SELF,
  groupId: '40001:50001',
  userId: '30002',
});
const fromPrivate = (content: string): IncomingMessage => ({
  content,
  sessionId: PRIVATE,
  platform: 'onebot',
  sessionType: 'private',
  selfId: SELF,
  userId: '30001',
});

/** agent 替身：记下抵达派发的消息 */
function recordingAgent(received: IncomingMessage[]) {
  return definePlugin({
    name: 'zz-agent',
    provides: [agent],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(agent, {
        handleMessage: async (message: IncomingMessage) => void received.push(message),
      } as never);
    },
  });
}

/** 在指令相位记下网关给的 data.chat（每条入站一项） */
function chatProbe(seen: Array<InboundPhaseData['chat']>) {
  return definePlugin({
    name: 'zz-chat-probe',
    uses: { hooks },
    apply: ({ hooks }) => {
      hooks.use.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
        seen.push(data.chat && { ...data.chat });
        await next();
      });
    },
  });
}

/**
 * 网关、会话管理、会话设置、两个回复策略插件（trigger-policy 与 flow-control）与 agent 替身；doc 是宿主配置文档，
 * types 是 onebot 适配器声明的类型（null 不装平台适配器）。入站经网关的 ingressMessage，等整条相位链跑完
 */
async function setup({
  doc = {},
  types = ONEBOT_TYPES,
  extra = [],
  rooms = [],
}: {
  doc?: Parameters<typeof startSettings>[0]['doc'];
  types?: SessionTypeDecl[] | null;
  extra?: Parameters<typeof startSettings>[0]['plugins'];
  /** 会话表里预置的已收录房间 */
  rooms?: string[];
} = {}) {
  const received: IncomingMessage[] = [];
  const started = await startSettings({
    doc,
    stored: Object.fromEntries(rooms.map(id => [id, storedRoom(id)])),
    adapters: types ? [{ platform: 'onebot', sessionTypes: types, canHandle: async () => true }] : [],
    first: [gatewayPlugin, recordingAgent(received)],
    plugins: [flowControlPlugin, triggerPolicyPlugin, ...extra],
  });
  apps.push(started.app);
  const host = started.app.bind({ gateway, flowControl });
  return {
    ...started,
    received,
    contents: () => received.map(m => m.content),
    send: (message: IncomingMessage) => host.gateway.use.ingressMessage(message),
    reply: (sessionId: string, platform = 'onebot') =>
      host.gateway.use.dispatchOutbound({ content: '<回复>', sessionId, platform, source: 'agent' }),
    flow: () => host.flowControl.use,
  };
}

/** 未点名的一律不开口（计数要到 100 条）：走了触发判定的消息会被吞 */
const NEVER = { intervalMode: 'fixed', fixedInterval: 100 };

describe('api-gateway：生效范围', () => {
  it('四个取值：不生效、多方房间、一对一房间、全部房间；默认只管多方房间', () => {
    const cases: Array<[string, boolean, boolean]> = [
      ['off', false, false],
      ['multiParty', true, false],
      ['oneToOne', false, true],
      ['all', true, true],
    ];
    for (const [audience, multi, single] of cases) {
      expect([audienceIncludes(audience, true), audienceIncludes(audience, false)], audience).toEqual([multi, single]);
    }
    expect(REPLY_AUDIENCE_FIELD.type).toBe('select');
    expect(REPLY_AUDIENCE_FIELD.default).toBe('multiParty');
    expect(REPLY_AUDIENCE_FIELD.options.map(option => option.value)).toEqual(['off', 'multiParty', 'oneToOne', 'all']);
    expect(toSource(REPLY_AUDIENCE_FIELD.label)).toBe('生效范围');
  });
});

describe('网关算聊天窗口', () => {
  it('没有 source 的入站带 data.chat（按这个平台的类型声明），带 source 的不带', async () => {
    const seen: Array<InboundPhaseData['chat']> = [];
    const { send } = await setup({ extra: [chatProbe(seen)] });
    await send(fromChannel('<频道>'));
    await send(fromPrivate('<私聊>'));
    await send({ ...fromGroup('<定时提醒>'), source: 'scheduler' });
    expect(seen).toEqual([
      { platform: 'onebot', type: 'channel', multiParty: true, undeclared: false, targetId: '40001:50001' },
      { platform: 'onebot', type: 'private', multiParty: false, undeclared: false, targetId: '30001' },
      undefined,
    ]);
  });

  it('平台服务缺席：类型名是 private 或不带类型名的按一对一，别的类型名按多方；网关不逐条告警', async () => {
    const seen: Array<InboundPhaseData['chat']> = [];
    const { send, warns } = await setup({ types: null, extra: [chatProbe(seen)] });
    const before = warns.length;
    await send(fromPrivate('<私聊>'));
    await send({ ...fromPrivate('<不带类型名>'), sessionType: undefined });
    for (let i = 0; i < 3; i++) await send(fromGroup(`<群 ${i}>`));
    expect(seen.map(chat => chat?.multiParty)).toEqual([false, false, true, true, true]);
    expect(warns.slice(before).filter(w => w.includes('plugin-gateway'))).toEqual([]);
  });
});

describe('生效范围', () => {
  it('默认只管多方房间：群与频道按触发判定（频道开箱受管），私聊直接放行', async () => {
    const { send, contents } = await setup({ doc: { plugins: { [POLICY]: NEVER } } });
    await send(fromGroup('<群>'));
    await send(fromChannel('<频道>'));
    await send(fromPrivate('<私聊>'));
    expect(contents()).toEqual(['<私聊>']);
  });

  it.each<[string, string[]]>([
    ['off', ['<群>', '<私聊>']],
    ['oneToOne', ['<群>']],
    ['all', []],
  ])('全局设成 %s：只按范围内的房间判定', async (audience, passed) => {
    const { send, contents } = await setup({ doc: { plugins: { [POLICY]: { ...NEVER, audience } } } });
    await send(fromGroup('<群>'));
    await send(fromPrivate('<私聊>'));
    expect(contents()).toEqual(passed);
  });

  it('owner 从 WebUI 往群里插话：触发插件直接放行，不判定', async () => {
    const { send, contents } = await setup({
      doc: { plugins: { [POLICY]: { ...NEVER, audience: 'all' } } },
      rooms: [GROUP],
    });
    await send({ content: '<插话>', sessionId: GROUP, platform: 'webui', userId: 'console' });
    await send(fromGroup('<群友>'));
    expect(contents()).toEqual(['<插话>']);
  });

  it.each<[string, string, (content: string) => IncomingMessage]>([
    ['群', GROUP, content => fromGroup(content)],
    ['私聊', PRIVATE, fromPrivate],
  ])('owner 从 WebUI 往%s里插话：流控直接放行，刚回复后的冷却与限速不吞它；房间里的消息照旧受冷却', async (_, room, native) => {
    const { send, reply, contents } = await setup({
      doc: {
        plugins: {
          [POLICY]: { audience: 'all', intervalMode: 'fixed', fixedInterval: 1 },
          [FLOW]: { audience: 'all', cooldownSeconds: 600, rateLimitWindow: 600, rateLimitMaxReplies: 1 },
        },
      },
      rooms: [room],
    });
    await send(native('<房间 1>'));
    await reply(room);
    await send({ content: '<插话>', sessionId: room, platform: 'webui', userId: 'console' });
    await send(native('<冷却中>'));
    expect(contents()).toEqual(['<房间 1>', '<插话>']);
  });
});

describe('按会话的参数', () => {
  it('平台类型档 onebot · private 设的冷却与生效范围对 onebot 的私聊生效，群不受影响', async () => {
    const { send, reply, contents } = await setup({
      doc: {
        plugins: {
          [POLICY]: { audience: 'all', intervalMode: 'fixed', fixedInterval: 1 },
          [FLOW]: { cooldownSeconds: 0 },
        },
        sessionConfig: {
          platformTypes: { onebot: { private: { [FLOW]: { audience: 'all', cooldownSeconds: 600 } } } },
        },
      },
    });
    await send(fromPrivate('<私聊 1>'));
    await reply(PRIVATE);
    await send(fromPrivate('<冷却中的私聊>'));
    await send(fromGroup('<群 1>'));
    await reply(GROUP);
    await send(fromGroup('<群 2>'));
    expect(contents()).toEqual(['<私聊 1>', '<群 1>', '<群 2>']);
  });

  it('新群的第一条消息就取到平台档：触发判定与冷却都按 onebot 平台档设的', async () => {
    const { send, reply, contents } = await setup({
      doc: {
        sessionConfig: {
          platforms: {
            onebot: { [POLICY]: { intervalMode: 'fixed', fixedInterval: 1 }, [FLOW]: { cooldownSeconds: 600 } },
          },
        },
      },
    });
    await send(fromGroup('<新群第一条>'));
    await reply(GROUP);
    await send(fromGroup('<冷却中>'));
    expect(contents()).toEqual(['<新群第一条>']);
  });

  it('带 source 的内部注入按会话记下的窗口判：私聊设成一对一房间后，定时提醒受限速；出站按同一口径记账', async () => {
    const { send, reply, contents, flow } = await setup({
      doc: { plugins: { [FLOW]: { audience: 'oneToOne', rateLimitWindow: 60, rateLimitMaxReplies: 1 } } },
      rooms: [PRIVATE],
    });
    const scheduled = (content: string): IncomingMessage => ({
      content,
      sessionId: PRIVATE,
      platform: 'internal',
      source: 'scheduler',
    });
    await send(scheduled('<提醒 1>'));
    await reply(PRIVATE, 'internal');
    expect(flow().isRateLimited(PRIVATE)).toBe(true);
    await send(scheduled('<提醒 2>'));
    expect(contents()).toEqual(['<提醒 1>']);
  });

  it('频道里未点名的放行回合回填无主体授权身份；一对一类型不叫 private 的平台上，私聊里的不回填', async () => {
    const { send, received } = await setup({
      types: [
        { name: 'room', multiParty: true },
        { name: 'dm', multiParty: false },
      ],
      doc: { plugins: { [POLICY]: { audience: 'all', intervalMode: 'fixed', fixedInterval: 1 } } },
    });
    await send({ ...fromGroup('<多方>'), sessionType: 'room' });
    await send({ ...fromPrivate('<一对一>'), sessionType: 'dm' });
    expect(received.map(m => [m.triggerType, m.actor])).toEqual([
      ['interval', { platform: 'onebot', userId: '' }],
      ['interval', undefined],
    ]);
  });
});

describe('闲置调度', () => {
  const idles = (received: IncomingMessage[]) => received.filter(m => m.source === 'idle-trigger').length;

  it('全局把闲置范围从关闭改成跨会话选举：不重载插件，随即开始排 tick', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const idle = { idleTriggerStrategy: 'fixed', idleTriggerMinutes: 5 };
    const { app, send, admin, received } = await setup({ doc: { plugins: { [POLICY]: { ...NEVER, ...idle } } } });
    await app.start();
    await send(fromGroup('<群>'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(idles(received)).toBe(0);
    await admin.update({ layer: { scope: 'global' } }, { plugin: POLICY, key: 'idleTriggerScope', value: 'platform' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(idles(received)).toBe(1);
  });

  it('全局的闲置参数改了以后，下一个 tick 起按新值', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const idle = { idleTriggerScope: 'platform', idleTriggerStrategy: 'fixed', idleTriggerMinutes: 60 };
    const { app, send, admin, received } = await setup({ doc: { plugins: { [POLICY]: { ...NEVER, ...idle } } } });
    await app.start();
    await send(fromGroup('<群>'));
    await admin.update({ layer: { scope: 'global' } }, { plugin: POLICY, key: 'idleTriggerMinutes', value: 5 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(idles(received), '原来排好的 tick 照旧到点').toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(idles(received), '之后按新的 5 分钟').toBe(2);
  });
});
