import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { type ApprovalSurface, approvals } from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { type CheckpointService, checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type Audience, type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { type SessionSetting, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type SessionItem, sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, events, type Logger, provide, services } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import {
  createSessionServer,
  failure,
  type MethodHandlers,
  type RequestContext,
  type ServerConnection,
} from '../../packages/plugin-session-server/src/connection.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import { defineTexts, TextError, type TextRef } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { recordRoom } from '../fixtures/rooms.js';
import { client, type Frame } from '../fixtures/session-client.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { settingsPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 会话协议的出口按连接的读者渲染文字对象：读者是 initialize 给的语言链（规范化过）与时区，链为空（没给、空列表、全不合法）
// 时 i18n 按全局默认层；i18n 是真的 plugin-i18n，缺席时一律原文，渲染出错时这一帧按原文发出。夹具在结果（sessions/list
// 的分组名，取适配器的显示名）、连接级推送（sessions/changed 的分组名）、会话推送（用量条目的分项名）与错误帧（检查点
// 抛出的 TextError）里交出文字对象；工具调用的参数、审批的逐字参数、用户消息正文、设置项的取值与字段的默认值是原样数据，里面伪造的文字对象不被换掉。
// 会话设置一路：设置项的标签与没设时的说明（登记方的字典）、层名（api-session-manager 的字典）、写入被拒的原因，以及没取名的
// 会话与场所的默认名（存储里不再有生成的名字，读者经 sessionLabel 与 placeLabel 取）。
// ════════════════════════════════════════════════════════════

const NS = '@zz/session-server-i18n';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: {
    adapter: 'QQ 机器人',
    part: '历史消息',
    down: '检查点服务掉线',
    locked: '文件被占用',
    gone: '会话 {id} 不在了',
    at: '{t, time, short}',
    title: '任务',
    tone: '语气',
    toneUnset: '按人设',
  } as const,
  locales: {
    en: {
      adapter: 'QQ bot',
      part: 'History',
      down: 'Checkpoint service down',
      locked: 'The file is in use',
      gone: 'Session {id} is gone',
      at: '{t, time, short}',
      title: 'Jobs',
      tone: 'Tone',
      toneUnset: 'As the persona says',
    },
  },
});

/** 形如文字对象的原样数据：真被渲染了，英文读者会看到 Jobs */
const FORGED = { i18n: NS, key: 'title', source: '伪造' };

/** 默认实例 qq 接管的房间，与可复用适配器的实例 qq-pool:work 接管的房间 */
const ROOM = 'onebot:10000:group:1';
const POOL_ROOM = 'onebot:40000:group:2';
const OWNER = { platform: 'webui', userId: 'console' };

/** 字符串映射的设置项（键不在 SessionConfig 里）：形如文字对象的取值（三个键都是字符串）也是合法的映射 */
const ENV: SessionSetting = {
  key: 'env' as never,
  field: { type: 'map', label: '环境变量', default: FORGED },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'advanced',
};

/** 标签与没设时的说明是文字对象的设置项，只适用于房间 */
const TONE: SessionSetting = {
  key: 'tone' as never,
  field: { type: 'string', label: t('tone') },
  appliesTo: ['room'],
  prominence: 'common',
  unset: t('toneUnset'),
};

/** validate 会抛错的设置项：全局默认层里存着它的值时，读这一层不能抛 */
const BROKEN: SessionSetting = {
  key: 'broken' as never,
  field: { type: 'string', label: '坏校验' },
  appliesTo: ['owner', 'room', 'task'],
  prominence: 'advanced',
  validate: () => {
    throw new Error('<校验器坏了>');
  },
};

const ENGLISH = { result: ['QQ bot', 'QQ bot (work)'], notify: ['QQ bot', 'QQ bot (work)'], session: ['History'] };
const CHINESE = {
  result: ['QQ 机器人', 'QQ 机器人（work）'],
  notify: ['QQ 机器人', 'QQ 机器人（work）'],
  session: ['历史消息'],
};

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 显示名是文字对象的 OneBot 适配器，接管 id 以 prefix 开头的房间 */
const adapterPlugin = (name: string, prefix: string, reusable = false) =>
  definePlugin({
    name,
    displayName: t('adapter'),
    reusable,
    provides: [platform],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(platform, {
        platform: 'onebot',
        canHandle: (id: string) => id.startsWith(prefix),
        getConnections: () => [],
        sendMessage: async () => {},
      } as never);
    },
  });

/** 用量事件：分项名交文字对象 */
const usage = (label: TextRef): TokenUsageEvent => ({
  sessionId: ROOM,
  platform: 'onebot',
  contextWindow: 1000,
  maxTokens: 100,
  tokenBudget: 900,
  used: 10,
  usageRatio: 0.01,
  trimmed: false,
  untrimmedHistory: 10,
  historyMessages: 1,
  breakdown: {
    system: 0,
    persona: 0,
    memorySummary: 0,
    memoryVector: 0,
    skills: 0,
    platform: 0,
    subtask: 0,
    systemOther: 0,
    history: 10,
    toolResults: 0,
    toolDefs: 0,
    reservedForReply: 100,
  },
  parts: [{ label, tokens: 10 }],
});

/**
 * 会话服务连同会话管理与两个适配器实例（各接管一个房间），审批面由一个测试插件登记；记忆、存储、owner 判定与检查点是替身，
 * 检查点的回滚抛 TextError。defaults 是宿主配置文档里会话设置的全局默认层。withI18n 为假时没有 i18n 服务。render 是 i18n
 * 服务 render 的探针
 */
async function setup({ withI18n = true, defaults }: { withI18n?: boolean; defaults?: Record<string, unknown> } = {}) {
  const { app } = hostedApp(defaults ? { sessionConfig: { defaults } } : {}, { logger: silent });
  apps.push(app);
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-i18n-'));
  homes.push(home);
  provideHostPaths(app, home);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, services, sessionManager, sessionProtocol, approvals });
  const mem = fakeMemory();
  host.provide.use(memory, mem as never);
  host.provide.use(storage, memoryStorage(new Map()));
  host.provide.use(authority, {
    isOwner: (p: string, u?: string) => p === OWNER.platform && u === OWNER.userId,
  } as never);
  host.provide.use(checkpoint, {
    rollback: async () => {
      throw new TextError(t('down'));
    },
    rollbackWithChat: async () => ({
      ok: false,
      restored: [],
      deleted: [],
      errors: [{ uri: 'workspace:/a.txt', reason: t('locked') }],
      alsoChangedBy: [],
      deletedMessages: 0,
      chatDeleted: true,
    }),
  } satisfies Pick<CheckpointService, 'rollback' | 'rollbackWithChat'> as never);
  await app.plugin(adapterPlugin('qq', 'onebot:10000:'));
  await app.plugin(adapterPlugin('qq-pool', 'onebot:40000:', true), {}, 'qq-pool:work');
  await app.plugin(sessionManagerPlugin, {});
  await app.plugin(sessionServerPlugin, {});
  const surfaces: Record<string, ApprovalSurface> = {};
  const surfacePlugin = definePlugin({
    name: '@zz/session-i18n-surface',
    uses: { approvals },
    apply: ({ approvals }) => {
      surfaces.webui = approvals.use.registerSurface('webui');
    },
  });
  await app.plugin(surfacePlugin);
  const settings = settingsPlugin('@zz/session-i18n-settings', [ENV, TONE, BROKEN]);
  await app.plugin(settings);
  if (withI18n) await app.plugin(i18nPlugin);
  await app.plugins.idle();
  for (const name of [
    sessionServerPlugin.name,
    surfacePlugin.name,
    settings.name,
    ...(withI18n ? [i18nPlugin.name] : []),
  ]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  await recordRoom(host.events.use, ROOM, '读书会');
  await recordRoom(host.events.use, POOL_ROOM, '群二');
  const connect = async (reader: { languages?: string[]; timeZone?: string } = {}) => {
    const c = client(host.sessionProtocol.use, { identity: OWNER, surface: surfaces.webui as ApprovalSurface });
    await c.init(reader);
    return c;
  };
  const render = withI18n ? vi.spyOn(host.services.use.get(i18n) as I18nService, 'render') : undefined;
  return { app, host, mem, connect, render };
}

type Host = Awaited<ReturnType<typeof setup>>['host'];
type Client = ReturnType<typeof client>;

const usageLabels = (c: Client) =>
  c.notifications('item/completed').flatMap(({ item }) => (item.kind === 'usage' ? item.parts.map(p => p.label) : []));

/**
 * 三处文字各自到了每条连接手里的样子：sessions/list 的分组名（结果）、sessions/changed 的分组名（连接级推送，收录一个新房间
 * 引出）、用量条目的分项名（会话推送）
 */
async function observe(host: Host, conns: Client[]) {
  for (const c of conns) {
    await c.call('sessions/watch', {});
    await c.subscribe(ROOM);
  }
  await recordRoom(host.events.use, 'onebot:10000:group:3', '群三');
  await host.events.use.emit('token:usage', usage(t('part')));
  return Promise.all(
    conns.map(async c => ({
      result: (await c.list()).groups.map(group => group.label),
      notify: c
        .notifications('sessions/changed')
        .at(-1)
        ?.groups.map(group => group.label),
      session: usageLabels(c),
    })),
  );
}

/** 收到过的某种推送的原始参数（不过 schema：原样数据里伪造的对象过不了文字字段的校验） */
const pushed = (c: Client, method: string) =>
  c.frames.filter((frame: Frame) => frame.method === method).map(frame => frame.params as Record<string, unknown>);

describe('会话协议按连接的读者渲染', () => {
  it('结果、连接级推送与会话推送里的文字对象：en 拿英文，zh-CN 拿原文，不带语言的按全局默认层', async () => {
    const { host, connect, render } = await setup();
    const conns = [
      await connect({ languages: ['en'] }),
      await connect({ languages: ['zh_CN', 'bad tag!'] }),
      await connect(),
    ];
    expect(await observe(host, conns)).toEqual([ENGLISH, CHINESE, ENGLISH]);
    // 交给 i18n 的读者是握手时规范化过的语言链；不带语言的链为空，i18n 按全局默认层，哪一层都没设时按 en
    const audiences = render?.mock.calls.map(([, audience]) => audience);
    expect(audiences).toContainEqual({ languages: ['zh-CN'] });
    expect(audiences).toContainEqual({ languages: [] });
  });

  it.each([
    ['zh-CN', CHINESE],
    ['en', ENGLISH],
  ])('不带语言、带空列表、带全是不合法标签的连接跟随全局默认层（设为 %s）', async (language, expected) => {
    const { host, connect } = await setup({ defaults: { language: [language] } });
    const conns = [await connect(), await connect({ languages: [] }), await connect({ languages: ['bad tag!', '*'] })];
    expect(await observe(host, conns)).toEqual([expected, expected, expected]);
  });

  it('设置项的 validate 抛错、全局默认层里存着它的值：不带语言的连接照常收到推送，按全局默认层渲染', async () => {
    const { host, connect } = await setup({ defaults: { broken: 'x' } });
    expect(await observe(host, [await connect()])).toEqual([ENGLISH]);
  });

  it('i18n 出错时不抛，每条连接告警一次：渲染出错的这一帧按原文发出，取语言链出错的这一帧单独渲染；同一次推送里排在后面的连接照常收到', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    const real = app.bind({ i18n }).i18n.use;
    // 语言链首项为 xx 的读者 render 抛错，为 yy 的 chainOf 抛错（只有一次推送发给多条连接时才取语言链，取不到时这一帧不与别的
    // 连接共用，照样交给 render：yy 不是有文字可用的语言，按 en）
    const head = (audience: Audience) => ('languages' in audience ? audience.languages[0] : undefined);
    const flaky: I18nService = {
      languages: () => real.languages(),
      chainOf: audience => {
        if (head(audience) === 'yy') throw new Error('<chainOf 坏了>');
        return real.chainOf(audience);
      },
      render: (value, audience, opts) => {
        if (head(audience) === 'xx') throw new Error('<render 坏了>');
        return real.render(value, audience, opts);
      },
    };
    const warn = vi.fn();
    const handlers = {
      'session/archive': ({ sessionId }: { sessionId: string }) => {
        throw failure('not-found', t('gone', { id: sessionId }));
      },
      'session/subscribe': ({ sessionId }: { sessionId: string }, conn: ServerConnection, request: RequestContext) => {
        request.afterReply(conn.subscribe(sessionId).release);
        return {};
      },
    } as unknown as MethodHandlers;
    const server = createSessionServer(
      handlers,
      () => ({ features: { send: false, rewind: false, compress: false }, appName: 'T' }),
      { ...silent, warn },
      { present: true, use: flaky },
    );
    const conns = await Promise.all(
      ['xx', 'yy', 'en'].map(async language => {
        const c = client({ connect: server.connect, resolveFile: () => undefined });
        await c.init({ languages: [language] });
        await c.raw({ jsonrpc: '2.0', id: 'sub', method: 'session/subscribe', params: { sessionId: 's1' } });
        return c;
      }),
    );
    const failed = await Promise.all(
      conns.map(async c => (await c.fail('session/archive', { sessionId: 's1' })).message),
    );
    const group = { platform: 'onebot', label: t('adapter'), rooms: 0, accounts: 0, attention: 0 };
    server.notify(
      'sessions/changed',
      () => ({ upserts: [], removes: [], groups: [group] }),
      () => true,
    );
    const item: SessionItem = { kind: 'notice', itemId: 'n1', at: 0, topic: 'zz', text: t('part'), attachments: [] };
    server.notifySession('s1', 'item/completed', { sessionId: 's1', epoch: 'e', seq: 1, item });

    expect(failed).toEqual(['会话 s1 不在了', 'Session s1 is gone', 'Session s1 is gone']);
    expect(conns.map(c => c.notifications('sessions/changed').map(({ groups }) => groups[0]?.label))).toEqual([
      ['QQ 机器人'],
      ['QQ bot'],
      ['QQ bot'],
    ]);
    expect(
      conns.map(c => c.notifications('item/completed').map(({ item }) => item.kind === 'notice' && item.text)),
    ).toEqual([['历史消息'], ['History'], ['History']]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('i18n 缺席时一律原文', async () => {
    const { host, connect } = await setup({ withI18n: false });
    const conns = [await connect({ languages: ['en'] }), await connect({ languages: ['zh-CN'] }), await connect()];
    expect(await observe(host, conns)).toEqual([CHINESE, CHINESE, CHINESE]);
  });

  it.each([
    [true, ['Checkpoint service down', '检查点服务掉线']],
    [false, ['检查点服务掉线', '检查点服务掉线']],
  ])('回合出错的原因（lastTurn.error，会话列表的 reason）：en 与 zh-CN 读者（i18n 在场：%s）', async (withI18n, expected) => {
    const { host, connect } = await setup({ withI18n });
    const { id: sessionId } = await host.sessionManager.use.createSession({ name: '<会话>' });
    const message: IncomingMessage = { content: '<提问>', sessionId, platform: 'webui' };
    const turnId = 'zz-turn';
    await host.hooks.use.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      await host.hooks.use.run('agent:turn:after', {
        message,
        reply: '',
        outcome: 'error',
        error: t('down'),
        sessionId,
        turnId,
        metadata: {},
      });
    });
    const conns = [await connect({ languages: ['en'] }), await connect({ languages: ['zh-CN'] })];
    await vi.waitFor(async () =>
      expect(await Promise.all(conns.map(async c => (await c.summary(sessionId)).reason))).toEqual(expected),
    );
  });

  it('同一帧推给几种读者：各自正确，同一条语言链只渲染一次（连接级推送与会话推送都是）', async () => {
    const { host, connect, render } = await setup();
    // 不带语言的连接按全局默认层，没设时与 en 是同一条链
    const conns = [await connect({ languages: ['en'] }), await connect(), await connect({ languages: ['zh-CN'] })];
    for (const c of conns) await c.subscribe(ROOM);
    render?.mockClear();
    await host.events.use.emit('session:config:changed');
    expect(conns.map(c => pushed(c, 'session/config/changed'))).toEqual([[{}], [{}], [{}]]);
    expect(render?.mock.calls).toHaveLength(2);
    render?.mockClear();
    await host.events.use.emit('token:usage', usage(t('part')));
    expect(conns.map(usageLabels)).toEqual([['History'], ['History'], ['历史消息']]);
    expect(render?.mock.calls).toHaveLength(2);
  });

  it.each([
    true,
    false,
  ])('时区随读者：同一语言不同时区各渲染各的，只给时区不给语言的同样（i18n 在场：%s）', async withI18n => {
    const { host, connect } = await setup({ withI18n, defaults: { language: ['zh-CN'] } });
    const conns = [
      await connect({ languages: ['zh-CN'], timeZone: 'UTC' }),
      await connect({ languages: ['zh-CN'], timeZone: 'Asia/Tokyo' }),
      await connect({ timeZone: 'UTC' }),
      await connect({ timeZone: 'Asia/Tokyo' }),
    ];
    for (const c of conns) await c.subscribe(ROOM);
    await host.events.use.emit('token:usage', usage(t('at', { t: 0 })));
    expect(conns.map(usageLabels)).toEqual([['00:00'], ['09:00'], ['00:00'], ['09:00']]);
  });

  it('错误帧：TextError 按连接的读者渲染进 error.message', async () => {
    const { connect } = await setup();
    const rewind = async (reader: { languages?: string[] }) =>
      (await (await connect(reader)).fail('turn/rewind', { sessionId: ROOM, turnId: 't1', scope: 'code' })).message;
    expect([await rewind({ languages: ['en'] }), await rewind({ languages: ['zh-CN'] }), await rewind({})]).toEqual([
      'Checkpoint service down',
      '检查点服务掉线',
      'Checkpoint service down',
    ]);
  });

  it('回滚结果里没回滚成的原因是文字对象：按连接的读者渲染', async () => {
    const { connect } = await setup();
    const reasons = async (reader: { languages?: string[] }) => {
      const result = await (await connect(reader)).call('turn/rewind', {
        sessionId: ROOM,
        turnId: 't1',
        scope: 'code-and-chat',
      });
      return result.errors.map(e => e.reason);
    };
    expect([await reasons({ languages: ['en'] }), await reasons({ languages: ['zh-CN'] })]).toEqual([
      ['The file is in use'],
      ['文件被占用'],
    ]);
  });

  it('业务错误的原因可以是文字对象（failure 收 TextRef），同样按连接的读者渲染', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    const handlers = {
      'session/archive': ({ sessionId }: { sessionId: string }) => {
        throw failure('not-found', t('gone', { id: sessionId }));
      },
    } as unknown as MethodHandlers;
    const server = createSessionServer(
      handlers,
      () => ({ features: { send: false, rewind: false, compress: false }, appName: 'T' }),
      silent,
      app.bind({ i18n }).i18n,
    );
    const archive = async (languages: string[]) => {
      const c = client({ connect: server.connect, resolveFile: () => undefined });
      await c.init({ languages });
      return c.fail('session/archive', { sessionId: 's1' });
    };
    expect(await archive(['en'])).toMatchObject({ message: 'Session s1 is gone', data: { code: 'not-found' } });
    expect(await archive(['zh-CN'])).toMatchObject({ message: '会话 s1 不在了', data: { code: 'not-found' } });
  });

  it('原样数据里伪造的文字对象不被换掉：工具调用的参数、审批的逐字参数（快照与推送），用户消息正文（推送）', async () => {
    const { host, connect } = await setup();
    const watcher = await connect({ languages: ['en'] });
    await watcher.call('presence/update', { active: true });
    await watcher.subscribe(ROOM);
    void host.approvals.use.request({
      sessionId: ROOM,
      origin: { kind: 'owner', ...OWNER },
      tool: 'exec',
      args: { x: FORGED },
      rule: 'test',
    });
    const late = await connect({ languages: ['en'] });
    let snapshot: Awaited<ReturnType<Client['subscribe']>>['snapshot'] | undefined;
    const message = { content: '<提问>', sessionId: ROOM, platform: 'onebot', userId: '30001' };
    await host.hooks.use.run('agent:input:before', { message, turnId: 'turn-1', metadata: {} }, async () => {
      await host.events.use.emit('tool:execute', {
        sessionId: ROOM,
        turnId: 'turn-1',
        callId: 'c1',
        toolName: 'exec',
        args: { x: FORGED },
        phase: 'start',
      });
      snapshot = (await late.subscribe(ROOM)).snapshot;
    });
    await host.events.use.emit('inbound:message:archived', {
      sessionId: ROOM,
      incoming: message,
      archivedMessage: { role: 'user', content: FORGED as unknown as string, timestamp: 1 },
    });

    const items = pushed(watcher, 'item/started')
      .concat(pushed(watcher, 'item/completed'))
      .map(params => params.item as Record<string, unknown>);
    expect(items.find(item => item.kind === 'tool-call')?.args).toEqual({ x: FORGED });
    expect(items.find(item => item.kind === 'user-message')?.text).toEqual(FORGED);
    const [requested] = pushed(watcher, 'approval/requested');
    expect((requested?.approval as { facts: unknown }).facts).toEqual({ params: { x: FORGED } });
    expect(snapshot?.items.find(item => item.kind === 'tool-call')).toMatchObject({ args: { x: FORGED } });
    expect(snapshot?.approvals.map(approval => approval.facts)).toEqual([{ params: { x: FORGED } }]);
  });

  it('设置项一行里的取值与字段的默认值不渲染：形如文字对象的映射原样读回', async () => {
    const { connect } = await setup();
    const c = await connect({ languages: ['en'] });
    const { items } = await c.call('session/config/update', { sessionId: ROOM, patch: { env: FORGED } });
    expect(items.find(row => row.key === 'env')).toMatchObject({
      field: { label: '环境变量', default: FORGED },
      value: FORGED,
      effective: FORGED,
    });
  });
});

describe('会话设置与默认名按连接的读者渲染', () => {
  it('设置项的标签、没设时的说明与层名：en 拿英文，zh-CN 拿原文', async () => {
    const { connect } = await setup();
    const view = async (languages: string[]) => {
      const c = await connect({ languages });
      const row = (await c.call('session/config/get', { sessionId: ROOM })).items.find(r => r.key === 'tone');
      const { order } = await c.call('session/config/layers', {});
      return { label: row?.field.label, unset: row?.unset, layers: order.map(layer => layer.label) };
    };
    expect(await view(['en'])).toEqual({
      label: 'Tone',
      unset: 'As the persona says',
      layers: [
        'Global default',
        'Platform profile',
        'Platform-type profile',
        'Place',
        'Parent session',
        'This session',
      ],
    });
    expect(await view(['zh-CN'])).toEqual({
      label: '语气',
      unset: '按人设',
      layers: ['全局默认', '平台档', '平台类型档', '场所', '父会话', '本会话'],
    });
  });

  it('写入被拒的原因：取值无效、不适用于这种会话，按连接的读者渲染', async () => {
    const { connect } = await setup();
    const refusals = async (languages: string[]) => {
      const c = await connect({ languages });
      const { session } = await c.call('session/create', { name: '<我的>' });
      return [
        (await c.fail('session/config/update', { sessionId: ROOM, patch: { env: 'x' } })).message,
        (await c.fail('session/config/update', { sessionId: session.id, patch: { tone: '<轻快>' } })).message,
      ];
    };
    expect(await refusals(['en'])).toEqual([
      'Invalid value for session setting env: expected an object (map), got string',
      'Session setting tone does not apply to my sessions',
    ]);
    expect(await refusals(['zh-CN'])).toEqual([
      '会话设置项 env 的值无效：期望对象（映射），得到 string',
      '会话设置项 tone 不适用于我的会话',
    ]);
  });

  it('没取名的会话与场所：存储里没有生成的名字；en 拿英文默认名，zh-CN 拿原文', async () => {
    const { app, host, mem, connect } = await setup();
    const at = (language: string, time: number, dateStyle?: 'short') =>
      new Intl.DateTimeFormat(language, { dateStyle, timeStyle: 'short', timeZone: 'UTC' }).format(time);
    const en = await connect({ languages: ['en'], timeZone: 'UTC' });
    const { session } = await en.call('session/create', {});
    const { session: child } = await en.call('session/create', { parentId: session.id });
    expect([session.title, session.place.name, child.title, child.ancestors?.[0]?.title]).toEqual([
      `Session ${at('en', session.createdAt, 'short')}`,
      'Default workspace',
      `Subtask ${at('en', child.createdAt)}`,
      `Session ${at('en', session.createdAt, 'short')}`,
    ]);

    const zh = await connect({ languages: ['zh-CN'], timeZone: 'UTC' });
    const root = (await zh.list()).sessions.find(s => s.id === session.id);
    const [sub] = (await zh.list({ parentId: session.id })).sessions;
    expect([root?.title, root?.place.name, sub?.title]).toEqual([
      `会话 ${at('zh-CN', session.createdAt, 'short')}`,
      '默认工作区',
      `子任务 ${at('zh-CN', child.createdAt)}`,
    ]);

    // 按 id 建档（终端配置的会话、/session.set）同样不起名
    const byId = await host.sessionManager.use.ensureSession('cli:zz');
    await app.stop();
    for (const id of [session.id, child.id, byId.id]) expect(mem.meta.get(id)?.name, id).toBeUndefined();
  });
});
