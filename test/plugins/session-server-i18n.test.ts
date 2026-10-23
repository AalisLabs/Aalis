import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenUsageEvent } from '../../packages/api-agent/src/index.js';
import { type ApprovalSurface, approvals } from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import { type CheckpointService, checkpoint } from '../../packages/api-checkpoint/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  SESSION_PROTOCOL_VERSION,
  type SessionItem,
  sessionProtocol,
} from '../../packages/api-session-protocol/src/index.js';
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
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { defineConfig } from '../../packages/schema-config/src/index.js';
import { defineTexts, TextError, type TextRef } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { i18nSection, setHostLanguage } from '../fixtures/host-language.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { expectProcessTimeZoneDistinct } from '../fixtures/process-time-zone.js';
import { recordRoom } from '../fixtures/rooms.js';
import { client, type Frame } from '../fixtures/session-client.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { ALL, fieldsPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 会话协议的出口按全局默认层的语言渲染文字对象（读者是 owner 自己，握手不带语言与时区，时间按服务进程的时区）；i18n 是
// 真的 plugin-i18n，缺席时一律原文，渲染出错时这一帧按原文发出。夹具在结果（sessions/list
// 的分组名，取适配器的显示名）、连接级推送（sessions/changed 的分组名）、会话推送（用量条目的分项名）与错误帧（检查点
// 抛出的 TextError）里交出文字对象；工具调用的参数、审批的逐字参数、用户消息正文、设置项的取值与字段的默认值是原样数据，里面伪造的文字对象不被换掉。
// 会话设置一路：设置项的标签与没设时的说明（声明字段的插件的字典）、层名（api-session-settings 的字典）、写入被拒的原因，以及
// 没取名的会话与场所的默认名（存储里不再有生成的名字，读者经 sessionLabel 与 placeLabel 取）。
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

/**
 * 设置项：env 是字符串映射（形如文字对象的取值也是合法的映射）；tone 的标签与没设时的说明是文字对象，只适用于房间；broken 的
 * validate 会抛错，全局层里存着它的值时读这一层不能抛
 */
const SCHEMA = defineConfig({
  env: { type: 'map', label: '环境变量', default: FORGED, session: { appliesTo: ALL, prominence: 'advanced' } },
  tone: {
    type: 'string',
    label: t('tone'),
    session: { appliesTo: ['room'], prominence: 'common', unset: t('toneUnset') },
  },
  broken: {
    type: 'string',
    label: '坏校验',
    validate: () => {
      throw new Error('<校验器坏了>');
    },
    session: { appliesTo: ALL, prominence: 'advanced', unset: '<没设>' },
  },
});

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
  historyLimit: 0,
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
 * 会话服务连同会话管理、会话设置与两个适配器实例（各接管一个房间），审批面由一个测试插件登记；记忆、存储、owner 判定与检查点
 * 是替身，检查点的回滚抛 TextError。language 是全局语言（plugin-i18n 的配置段），setLanguage 改它；plugins 另写这些实例的
 * 配置段。withI18n 为假时没有 i18n 服务。render 是 i18n 服务 render 的探针
 */
async function setup({
  withI18n = true,
  language,
  plugins = {},
}: {
  withI18n?: boolean;
  language?: string[];
  plugins?: Record<string, Record<string, unknown>>;
} = {}) {
  const doc = { plugins: { ...(language ? i18nSection(language).plugins : {}), ...plugins } };
  const { app, store } = hostedApp(doc, { logger: silent });
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
  await registerFromDoc(app, store, sessionSettingsPlugin);
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
  const settings = fieldsPlugin('@zz/session-i18n-settings', SCHEMA).definition;
  await registerFromDoc(app, store, settings);
  if (withI18n) await registerFromDoc(app, store, i18nPlugin);
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
  /** 一条还没握手的连接 */
  const open = () => client(host.sessionProtocol.use, { identity: OWNER, surface: surfaces.webui as ApprovalSurface });
  const connect = async () => {
    const c = open();
    await c.init();
    return c;
  };
  /** 改全局语言 */
  const setLanguage = async (next: string[]) => setHostLanguage(app, next);
  const render = withI18n ? vi.spyOn(host.services.use.get(i18n) as I18nService, 'render') : undefined;
  return { app, host, mem, open, connect, setLanguage, render };
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

/** 时间戳 0 按服务进程的时区写成的时刻 */
const processTime = (language: string) => new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(0);

describe('会话协议按全局默认层的语言渲染', () => {
  it('握手里多带的语言与时区（旧客户端）不认：连接之后全局默认层从 zh-CN 改成 en，之后的结果与推送按 en，时间按服务进程的时区', async () => {
    expectProcessTimeZoneDistinct();
    const { host, open, setLanguage } = await setup({ language: ['zh-CN'] });
    const c = open();
    const legacy = { languages: ['zh-CN'], timeZone: 'Asia/Tokyo' };
    await c.call('initialize', {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      client: { name: 'zz-old', version: '0' },
      ...legacy,
    });
    await c.subscribe(ROOM);
    expect((await c.list()).groups.map(group => group.label)).toEqual(CHINESE.result);
    await setLanguage(['en']);
    await host.events.use.emit('token:usage', usage(t('part')));
    await host.events.use.emit('token:usage', usage(t('at', { t: 0 })));
    expect((await c.list()).groups.map(group => group.label)).toEqual(ENGLISH.result);
    expect(usageLabels(c)).toEqual(['History', processTime('en')]);
  });

  it.each([
    ['zh-CN', CHINESE],
    ['en', ENGLISH],
  ])('结果、连接级推送与会话推送里的文字对象按全局默认层的语言（设为 %s）', async (language, expected) => {
    const { host, connect } = await setup({ language: [language] });
    expect(await observe(host, [await connect()])).toEqual([expected]);
  });

  it('设置项的 validate 抛错、全局层（插件配置）里存着它的值：连接照常收到推送，按全局语言渲染（没设语言时按 en）', async () => {
    const { host, connect } = await setup({ plugins: { '@zz/session-i18n-settings': { broken: 'x' } } });
    expect(await observe(host, [await connect()])).toEqual([ENGLISH]);
  });

  it('i18n 的 render 抛错时不抛，只告警一次：出帧按原文发出，各连接照常收到；不再抛错之后照常渲染', async () => {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    const real = app.bind({ i18n }).i18n.use;
    let broken = true;
    const flaky: I18nService = {
      languages: () => real.languages(),
      chainOf: audience => real.chainOf(audience),
      render: (value, audience, opts) => {
        if (broken) throw new Error('<render 坏了>');
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
      () => ({ features: { send: false, rewind: false, compress: false, settings: false }, appName: 'T' }),
      { ...silent, warn },
      { present: true, use: flaky },
      () => false,
    );
    const conns = await Promise.all(
      [0, 1].map(async () => {
        const c = client({ connect: server.connect, resolveFile: () => undefined });
        await c.init();
        await c.raw({ jsonrpc: '2.0', id: 'sub', method: 'session/subscribe', params: { sessionId: 's1' } });
        return c;
      }),
    );
    const archive = (c: Client) => c.fail('session/archive', { sessionId: 's1' });
    const failed = await Promise.all(conns.map(async c => (await archive(c)).message));
    const group = { platform: 'onebot', label: t('adapter'), rooms: 0, accounts: 0, attention: 0 };
    server.notify(
      'sessions/changed',
      () => ({ upserts: [], removes: [], groups: [group] }),
      () => true,
    );
    const item: SessionItem = { kind: 'notice', itemId: 'n1', at: 0, topic: 'zz', text: t('part'), attachments: [] };
    server.notifySession('s1', 'item/completed', { sessionId: 's1', epoch: 'e', seq: 1, item });

    expect(failed).toEqual(['会话 s1 不在了', '会话 s1 不在了']);
    expect(conns.map(c => c.notifications('sessions/changed').map(({ groups }) => groups[0]?.label))).toEqual([
      ['QQ 机器人'],
      ['QQ 机器人'],
    ]);
    expect(
      conns.map(c => c.notifications('item/completed').map(({ item }) => item.kind === 'notice' && item.text)),
    ).toEqual([['历史消息'], ['历史消息']]);
    expect(warn).toHaveBeenCalledTimes(1);
    broken = false;
    expect((await archive(conns[0] as Client)).message).toBe('Session s1 is gone');
  });

  it('i18n 缺席时一律原文', async () => {
    const { host, connect } = await setup({ withI18n: false, language: ['en'] });
    expect(await observe(host, [await connect()])).toEqual([CHINESE]);
  });

  it.each([
    [true, 'Checkpoint service down'],
    [false, '检查点服务掉线'],
  ])('回合出错的原因（lastTurn.error，会话列表的 reason）按全局默认层的语言（i18n 在场：%s）', async (withI18n, expected) => {
    const { host, connect } = await setup({ withI18n, language: ['en'] });
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
    const c = await connect();
    await vi.waitFor(async () => expect((await c.summary(sessionId)).reason).toBe(expected));
  });

  it('一次推送只渲染一次，各连接共用（连接级推送与会话推送都是）', async () => {
    const { host, connect, render } = await setup();
    const conns = [await connect(), await connect(), await connect()];
    for (const c of conns) await c.subscribe(ROOM);
    render?.mockClear();
    await host.events.use.emit('session-settings:changed');
    expect(conns.map(c => pushed(c, 'session/config/changed'))).toEqual([[{}], [{}], [{}]]);
    expect(render?.mock.calls).toHaveLength(1);
    render?.mockClear();
    await host.events.use.emit('token:usage', usage(t('part')));
    expect(conns.map(usageLabels)).toEqual([['History'], ['History'], ['History']]);
    expect(render?.mock.calls).toHaveLength(1);
  });

  it('错误帧：TextError 按全局默认层的语言渲染进 error.message', async () => {
    const { connect, setLanguage } = await setup({ language: ['en'] });
    const c = await connect();
    const rewind = async () => (await c.fail('turn/rewind', { sessionId: ROOM, turnId: 't1', scope: 'code' })).message;
    expect(await rewind()).toBe('Checkpoint service down');
    await setLanguage(['zh-CN']);
    expect(await rewind()).toBe('检查点服务掉线');
  });

  it('回滚结果里没回滚成的原因是文字对象：按全局默认层的语言渲染', async () => {
    const { connect, setLanguage } = await setup({ language: ['en'] });
    const c = await connect();
    const reasons = async () => {
      const result = await c.call('turn/rewind', { sessionId: ROOM, turnId: 't1', scope: 'code-and-chat' });
      return result.errors.map(e => e.reason);
    };
    expect(await reasons()).toEqual(['The file is in use']);
    await setLanguage(['zh-CN']);
    expect(await reasons()).toEqual(['文件被占用']);
  });

  it('业务错误的原因可以是文字对象（failure 收 TextRef），同样按全局默认层的语言渲染', async () => {
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
      () => ({ features: { send: false, rewind: false, compress: false, settings: false }, appName: 'T' }),
      silent,
      app.bind({ i18n }).i18n,
      () => false,
    );
    const c = client({ connect: server.connect, resolveFile: () => undefined });
    await c.init();
    // 没有会话管理：全局默认层取不到，按 en
    expect(await c.fail('session/archive', { sessionId: 's1' })).toMatchObject({
      message: 'Session s1 is gone',
      data: { code: 'not-found' },
    });
  });

  it('原样数据里伪造的文字对象不被换掉：工具调用的参数、审批的逐字参数（快照与推送），用户消息正文（推送）', async () => {
    const { host, connect } = await setup({ language: ['en'] });
    const watcher = await connect();
    await watcher.call('presence/update', { active: true });
    await watcher.subscribe(ROOM);
    void host.approvals.use.request({
      sessionId: ROOM,
      origin: { kind: 'hand', participants: [OWNER] },
      tool: 'exec',
      args: { x: FORGED },
      rule: 'test',
      canAnswer: () => true,
      ownerOnly: true,
    });
    const late = await connect();
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
    const { connect } = await setup({ language: ['en'] });
    const c = await connect();
    const { items } = await c.call('session/config/update', {
      sessionId: ROOM,
      plugin: '@zz/session-i18n-settings',
      key: 'env',
      value: FORGED,
    });
    expect(items.find(row => row.key === 'env')).toMatchObject({
      field: { label: '环境变量', default: FORGED },
      value: FORGED,
      effective: FORGED,
    });
  });
});

describe('会话设置与默认名按全局语言渲染', () => {
  it('设置项的标签、没设时的说明与层名：en 拿英文，zh-CN 拿原文', async () => {
    const { connect, setLanguage } = await setup({ language: ['en'] });
    const c = await connect();
    const view = async () => {
      const row = (await c.call('session/config/get', { sessionId: ROOM })).items.find(r => r.key === 'tone');
      const { order } = await c.call('session/config/layers', {});
      return { label: row?.field.label, unset: row?.field.session.unset, layers: order.map(layer => layer.label) };
    };
    expect(await view()).toEqual({
      label: 'Tone',
      unset: 'As the persona says',
      layers: ['Global (plugin config)', 'Platform profile', 'Platform-type profile', 'Place', 'This session'],
    });
    await setLanguage(['zh-CN']);
    expect(await view()).toEqual({
      label: '语气',
      unset: '按人设',
      layers: ['全局（插件配置）', '平台档', '平台类型档', '场所', '本会话'],
    });
  });

  it('写入被拒的原因：取值无效、不适用于这种会话，按全局语言渲染', async () => {
    const { connect, setLanguage } = await setup({ language: ['en'] });
    const c = await connect();
    const { session } = await c.call('session/create', { name: '<我的>' });
    const plugin = '@zz/session-i18n-settings';
    const refusals = async () => [
      (await c.fail('session/config/update', { sessionId: ROOM, plugin, key: 'env', value: 'x' })).message,
      (await c.fail('session/config/update', { sessionId: session.id, plugin, key: 'tone', value: '<轻快>' })).message,
    ];
    expect(await refusals()).toEqual([
      'Invalid value for env: expected an object (map), got string',
      'tone does not apply to owner sessions',
    ]);
    await setLanguage(['zh-CN']);
    expect(await refusals()).toEqual(['env 的值不合法：期望对象（映射），得到 string', 'tone 不适用于owner 的会话']);
  });

  it('没取名的会话与场所：存储里没有生成的名字；en 拿英文默认名，zh-CN 拿原文，时间按服务进程的时区', async () => {
    const { app, host, mem, connect, setLanguage } = await setup({ language: ['en'] });
    const at = (language: string, time: number, dateStyle?: 'short') =>
      new Intl.DateTimeFormat(language, { dateStyle, timeStyle: 'short' }).format(time);
    const c = await connect();
    const { session } = await c.call('session/create', {});
    const { session: child } = await c.call('session/create', { parentId: session.id });
    expectProcessTimeZoneDistinct(session.createdAt);
    expect([session.title, session.place?.name, child.title, child.ancestors?.[0]?.title]).toEqual([
      `Session ${at('en', session.createdAt, 'short')}`,
      'Default workspace',
      `Subtask ${at('en', child.createdAt)}`,
      `Session ${at('en', session.createdAt, 'short')}`,
    ]);

    await setLanguage(['zh-CN']);
    const root = (await c.list()).sessions.find(s => s.id === session.id);
    const [sub] = (await c.list({ parentId: session.id })).sessions;
    expect([root?.title, root?.place?.name, sub?.title]).toEqual([
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
