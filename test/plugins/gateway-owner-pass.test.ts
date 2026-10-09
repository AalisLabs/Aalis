import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { flowControl } from '../../packages/api-flow-control/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, events, type LogEntry, LogHub, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import flowControlPlugin from '../../packages/plugin-flow-control/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import layaPlugin from '../../packages/plugin-trigger-laya/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 结构性放行：房间类别为 owner-only 的会话（项目会话、默认工作区的 WebUI 会话、owner 的 IM 私聊，含子会话），
// 网关跳过 inbound:trigger 与 inbound:flow，指令相位之后直接派发。
//
// 经真实插件（gateway + session-manager + flow-control + 触发插件）走入站相位链；规则版（trigger-policy）与
// Laya 版各一遍，作用域在四种配置下同时下发给触发插件与流控。agent 是记录型假件，每条都回复（回复经网关出站，
// 流控按作用域记冷却与限速）；authority 只给 owner 谓词；Laya 的侧车是本地假服务，判定恒为不开口；memory 是内存替身。
// 触发插件配成未点名的消息一律不开口、带禁言关键词，流控配成回复后冷却并限速一次：走了相位的消息会被吞。
// ════════════════════════════════════════════════════════════

const SELF = '10000';
const OWNER = '90001';
const MEMBER = '30001';
const GROUP = `onebot:${SELF}:group:20001`;
const OWNER_DM = `onebot:${SELF}:private:${OWNER}`;
const OTHER_DM = `onebot:${SELF}:private:${MEMBER}`;
const MUTE_WORD = '闭嘴';
const SCOPES = [['*:group'], ['*'], ['webui:*'], ['*:private']];
const TRIGGERS = ['policy', 'laya'] as const;
type TriggerKind = (typeof TRIGGERS)[number];

type Sender = (sessionId: string, content: string) => IncomingMessage;

/** owner 在 WebUI 里发的消息：连接的身份，不带会话类型 */
const fromWebui: Sender = (sessionId, content) => ({ content, sessionId, platform: 'webui', userId: 'owner' });

/** owner 在 OneBot 私聊里发的消息 */
const fromOwnerDm: Sender = (sessionId, content) => ({
  content,
  sessionId,
  platform: 'onebot',
  sessionType: 'private',
  selfId: SELF,
  userId: OWNER,
  nickname: '主人',
});

const fromGroup = (content: string): IncomingMessage => ({
  content,
  sessionId: GROUP,
  platform: 'onebot',
  sessionType: 'group',
  selfId: SELF,
  groupId: '20001',
  userId: MEMBER,
  nickname: '群友',
});

const fromOtherDm = (content: string): IncomingMessage => ({
  content,
  sessionId: OTHER_DM,
  platform: 'onebot',
  sessionType: 'private',
  selfId: SELF,
  userId: MEMBER,
  nickname: '网友',
});

/** 定时任务的注入：带 source，平台为 internal */
const scheduled = (sessionId: string, content: string): IncomingMessage => ({
  content,
  sessionId,
  platform: 'internal',
  source: 'scheduler',
});

const booted: App[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const app of booted.splice(0)) await app.stop();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>(r => s.close(() => r()));
  }
});

/** 假侧车：每次打分都回不开口，记下请求次数 */
async function startSidecar(): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logit: -3, threshold: 0, version: 'v-test' }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: () => requests };
}

/** 刷掉经入站事件进来、不等待的相位链（setImmediate 不在假时钟内） */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>(r => setImmediate(r));
}

interface SetupOptions {
  trigger: TriggerKind;
  scopes: string[];
  /** 不装 authority：owner 谓词恒为否 */
  noAuthority?: boolean;
  /** 不装会话管理 */
  noSessionManager?: boolean;
  /** 会话表里预置的 IM 房间，缺省为群、owner 的私聊与别人的私聊 */
  rooms?: string[];
  /** trigger-policy 的额外配置 */
  policy?: Record<string, unknown>;
}

async function setup(opts: SetupOptions) {
  const logHub = new LogHub();
  const logs: LogEntry[] = [];
  logHub.onEntry(e => logs.push(e));
  const app = new App({ name: 'T', logLevel: 'debug', logHub });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, gateway, flowControl, sessionManager });

  const received: IncomingMessage[] = [];
  const replied: string[] = [];
  host.events.on('outbound:message', m => {
    if (m.source === 'agent' && m.sessionId) replied.push(m.sessionId);
  });
  host.provide(agent, {
    async handleMessage(msg: IncomingMessage) {
      received.push(msg);
      await host.gateway
        .require()
        .dispatchOutbound({ content: '好的', sessionId: msg.sessionId, platform: msg.platform, source: 'agent' });
    },
  } as never);
  const rooms = opts.rooms ?? [GROUP, OWNER_DM, OTHER_DM];
  host.provide(memory, {
    ...fakeMemory(Object.fromEntries(rooms.map(id => [id, storedRoom(id)]))),
    getFullHistory: async () => [],
  } as never);
  if (!opts.noAuthority) {
    host.provide(authority, {
      isOwner: (platform: string, userId?: string) => platform === 'onebot' && userId === OWNER,
    } as never);
  }

  const sidecar = opts.trigger === 'laya' ? await startSidecar() : undefined;
  const plugins: Array<[PluginDefinition, Record<string, unknown>]> = [[gatewayPlugin, {}]];
  if (!opts.noSessionManager) plugins.push([sessionManagerPlugin, {}]);
  plugins.push([
    flowControlPlugin,
    { scopes: opts.scopes, cooldownSeconds: 600, rateLimitWindow: 600, rateLimitMaxReplies: 1 },
  ]);
  plugins.push(
    sidecar
      ? [layaPlugin, { endpoint: sidecar.url, scopes: opts.scopes, muteKeywords: MUTE_WORD, muteTimeSeconds: 600 }]
      : [
          triggerPolicyPlugin,
          {
            scopes: opts.scopes,
            intervalMode: 'fixed',
            fixedInterval: 100,
            muteKeywords: MUTE_WORD,
            muteTimeSeconds: 600,
            ...opts.policy,
          },
        ],
  );
  for (const [def, config] of plugins) await app.plugins.register(def, config);
  await app.plugins.idle();
  // 激活闸：依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  for (const [def] of plugins) {
    const state = app.plugins.getPlugin(def.name)?.state;
    if (state !== 'active') throw new Error(`${def.name} 未激活（state=${state}）`);
  }
  await app.start();

  return {
    received,
    sm: () => host.sessionManager.require(),
    flow: () => host.flowControl.require(),
    /** 真人入站经网关：等整条相位链跑完 */
    send: (msg: IncomingMessage) => host.gateway.require().ingressMessage(msg),
    /** 平台适配器的投递：发入站事件，会话管理在同一个事件上收录房间 */
    emit: async (msg: IncomingMessage) => {
      await host.events.emit('inbound:message', msg);
      await flush();
    },
    dispatched: (sid: string) => received.filter(m => m.sessionId === sid).map(m => m.content),
    replies: (sid: string) => replied.filter(id => id === sid).length,
    /** 触发插件对这个会话的判定日志（两个插件同一格式） */
    judged: (sid: string) => logs.filter(e => e.message.includes(`判定 | session=${sid} |`)),
    idles: () => received.filter(m => m.source === 'idle-trigger').map(m => m.sessionId),
    sidecarRequests: () => sidecar?.requests() ?? 0,
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** WebUI 新建的会话（带 work 的是项目会话：建在以绑定目录登记的项目工作区里） */
async function webuiSession(h: Harness, work?: { root: string }): Promise<string> {
  const workspace = work && h.sm().addWorkspace(work.root).workspace.id;
  return (await h.sm().createSession({ name: '<会话>' }, { createdFrom: 'webui', workspace, work })).id;
}

const childOf = async (h: Harness, parentId: string) => (await h.sm().createChildSession(parentId)).id;
const PROJECT = { root: '/zz-slice2-project' };

/** owner 自己的会话：名字、建出它并返回 id、往里发消息的入口 */
const OWNER_KINDS: Array<[string, (h: Harness) => Promise<string>, Sender]> = [
  ['项目会话', h => webuiSession(h, PROJECT), fromWebui],
  ['默认工作区的 WebUI 会话', h => webuiSession(h), fromWebui],
  ['owner 的 IM 私聊', async () => OWNER_DM, fromOwnerDm],
  ['项目会话的子会话', async h => childOf(h, await webuiSession(h, PROJECT)), fromWebui],
  ['WebUI 会话的子会话', async h => childOf(h, await webuiSession(h)), fromWebui],
  ['owner 私聊的子会话', h => childOf(h, OWNER_DM), fromOwnerDm],
];

describe.each(TRIGGERS)('结构性放行（%s）', trigger => {
  describe.each(SCOPES)('作用域 %s', scope => {
    it.each(
      OWNER_KINDS,
    )('%s：不进判定、不因禁言关键词设禁言、不被禁言吞、不受冷却与限速，回复照常发出', async (_, create, from) => {
      const h = await setup({ trigger, scopes: [scope] });
      const sid = await create(h);
      // 未点名的、回复后冷却与限速期内的、禁言关键词、禁言期内的
      await h.send(from(sid, '随便聊聊'));
      await h.send(from(sid, '再聊一句'));
      await h.send(from(sid, MUTE_WORD));
      expect(h.flow().isMuted(sid)).toBe(false);
      h.flow().setMuted(sid, 600, from(sid, '').platform);
      await h.send(from(sid, '禁言期间'));
      expect(h.dispatched(sid)).toEqual(['随便聊聊', '再聊一句', MUTE_WORD, '禁言期间']);
      expect(h.received.map(m => m.triggerType)).toEqual([undefined, undefined, undefined, undefined]);
      expect(h.replies(sid)).toBe(4);
      expect(h.judged(sid)).toEqual([]);
      expect(h.sidecarRequests()).toBe(0);
    });
  });

  // 禁言吞噬不看作用域：一种作用域就够
  it('群房间、别人的私聊、owner 从 WebUI 往群里插话与 internal 会话照常走全部相位：禁言期的消息被吞', async () => {
    const h = await setup({ trigger, scopes: ['*'] });
    const internal = await h.sm().ensureSession('session-zz-legacy');
    for (const [sid, platform] of [
      [GROUP, 'onebot'],
      [OTHER_DM, 'onebot'],
      [internal.id, 'internal'],
    ]) {
      h.flow().setMuted(sid, 600, platform);
    }
    await h.send(fromGroup('有人吗'));
    await h.send(fromWebui(GROUP, '插一句'));
    await h.send(fromOtherDm('在吗'));
    await h.send(scheduled(internal.id, '<提醒>'));
    expect(h.received).toEqual([]);
  });

  it('对照：作用域为 * 时群房间、别人的私聊与 owner 往群里的插话照常判定，未点名的被吞', async () => {
    const h = await setup({ trigger, scopes: ['*'] });
    await h.send(fromGroup('有人吗'));
    await h.send(fromWebui(GROUP, '插一句'));
    await h.send(fromOtherDm('在吗'));
    expect(h.received).toEqual([]);
    expect(h.judged(GROUP)).toHaveLength(2);
    expect(h.judged(OTHER_DM)).toHaveLength(1);
    if (trigger === 'laya') expect(h.sidecarRequests()).toBe(3);
  });

  it('owner 第一次私聊（会话表里还没有这个房间）：会话管理在同一个入站事件上收录后即放行', async () => {
    const h = await setup({ trigger, scopes: ['*'], rooms: [GROUP] });
    h.flow().setMuted(OWNER_DM, 600, 'onebot');
    await h.emit(fromOwnerDm(OWNER_DM, '在吗'));
    expect(h.sm().getSession(OWNER_DM)?.originChat).toMatchObject({ multiParty: false, targetId: OWNER });
    expect(h.dispatched(OWNER_DM)).toEqual(['在吗']);
  });

  it('不装 authority：owner 的 IM 私聊照常走全部相位，WebUI 会话照样放行', async () => {
    const h = await setup({ trigger, scopes: ['*'], noAuthority: true });
    const plain = await h.sm().createSession({ name: '<聊天>' }, { createdFrom: 'webui' });
    h.flow().setMuted(OWNER_DM, 600, 'onebot');
    h.flow().setMuted(plain.id, 600, 'webui');
    await h.send(fromOwnerDm(OWNER_DM, '在吗'));
    await h.send(fromWebui(plain.id, '在吗'));
    expect(h.dispatched(OWNER_DM)).toEqual([]);
    expect(h.dispatched(plain.id)).toEqual(['在吗']);
  });

  it('没有会话服务：判不出房间类别，全部照常走', async () => {
    const h = await setup({ trigger, scopes: ['*'], noSessionManager: true });
    h.flow().setMuted(OWNER_DM, 600, 'onebot');
    h.flow().setMuted('session-zz-webui', 600, 'webui');
    await h.send(fromOwnerDm(OWNER_DM, '在吗'));
    await h.send(fromWebui('session-zz-webui', '在吗'));
    expect(h.received).toEqual([]);
  });
});

describe('结构性放行：trigger-policy 的状态表', () => {
  it('owner 的会话不进状态表，不排闲置话题；群房间照常排', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const h = await setup({
      trigger: 'policy',
      scopes: ['*'],
      policy: {
        idleTriggerScope: 'session',
        idleTriggerMinutes: 1,
        idleTriggerStyle: 'fixed',
        idleTriggerJitter: false,
      },
    });
    const plain = await h.sm().createSession({ name: '<聊天>' }, { createdFrom: 'webui' });
    await h.send(fromWebui(plain.id, '在吗'));
    await h.send(fromOwnerDm(OWNER_DM, '在吗'));
    await h.send(fromGroup('有人吗'));
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(h.idles()).toEqual([GROUP]);
  });
});
