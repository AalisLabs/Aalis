import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { type AalisConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { type SessionSetting, sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  ErrorFrameSchema,
  RPC_ERROR_CODES,
  SESSION_PROTOCOL_VERSION,
  sessionProtocol,
} from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/paper.js';
import { CLIENT, client, DETACHED_SURFACE, type Frame } from '../fixtures/session-client.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { ITERATIONS, MODEL, PAPER_NAME, PERSONA, settingsPlugin, TOOL_GROUPS } from '../fixtures/session-settings.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 会话服务（plugin-session-server）的前一半：握手；会话列表的分区、分组、状态、排序、搜索与分页；
// watch 的增量推送；建、改名、归档、删除与批量；会话设置的各行与各层；「我的」区的已读。
// 全部经 sessionProtocol.connect 直接收发帧，不走网络；收到的每个结果与通知都先过协议 schema。
// ════════════════════════════════════════════════════════════

const SEEN_URI = 'pluginData:/session-server/seen.json';
const MAJOR = Number(SESSION_PROTOCOL_VERSION.split('.')[0]);

const apps: App[] = [];
/** 每个 App 一个临时家目录：会话服务的审批审计写在它下面 */
const homes: string[] = [];
/** 像 runtime 一样在根上提供 host-paths，家目录是新建的临时目录 */
function provideHome(app: App): void {
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-server-'));
  homes.push(home);
  provideHostPaths(app, home);
}
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Outcome = HookContextMap['agent:turn:after']['outcome'];

/** 以插件实例提供一个平台适配器：解析结果里的实例 id 就是插件名 */
const adapterPlugin = (name: string, adapter: Partial<PlatformAdapter>) =>
  definePlugin({
    name,
    provides: [platform],
    uses: { provide },
    apply: ({ provide }) => {
      provide(platform, { getConnections: () => [], sendMessage: async () => {}, ...adapter } as never);
    },
  });

const ALL = ['owner', 'room', 'task'] as const;
const MODEL_FIRST: SessionSetting = { ...MODEL, order: 0 };
/** 可选项依赖模型：行上带 dependsOn */
const THINK: SessionSetting = {
  key: 'think',
  field: { type: 'select', label: '深度思考', dynamicOptions: 'llm-thinking' },
  appliesTo: ALL,
  prominence: 'composer',
  order: 1,
  dependsOn: 'llm',
  validate: value => (typeof value === 'string' && value !== '' ? undefined : '要是档位 id'),
};
/** 第三个 composer：同一组最多两项，它退到 common */
const EXTRA: SessionSetting = {
  key: 'systemPromptExtra',
  field: { type: 'textarea', label: '额外提示' },
  appliesTo: ALL,
  prominence: 'composer',
  order: 5,
};
/** 只对 owner 的会话 */
const JSON_RENDERING: SessionSetting = {
  key: 'clientSideJsonRendering',
  field: { type: 'boolean', label: '客户端渲染 JSON' },
  appliesTo: ['owner'],
  prominence: 'advanced',
};
/** 代替拥有这些设置项的插件 */
const SETTING_PLUGINS = [
  settingsPlugin('agent-settings', [MODEL_FIRST, THINK, ITERATIONS]),
  settingsPlugin('persona-settings', [PERSONA, EXTRA, JSON_RENDERING]),
  settingsPlugin('tools-settings', [TOOL_GROUPS]),
  settingsPlugin('paper-settings', [PAPER_NAME]),
];

/** 时钟只假 Date：会话的创建、改动与开口时间取 Date.now()，定时器照常走 */
function clock(at: number): void {
  vi.setSystemTime(at);
}

/**
 * stored：会话表里预置的记录；files：插件数据（已读记录）；layers：宿主配置文档里会话设置的各层；
 * unreadable：这些 URI 存在但读不出来（权限错，不是不存在）
 */
async function setup({
  stored = {},
  files = new Map<string, string | Uint8Array>(),
  layers,
  unreadable = [],
  unwritable = false,
}: {
  stored?: Record<string, Record<string, unknown>>;
  files?: Map<string, string | Uint8Array>;
  layers?: AalisConfig['sessionConfig'];
  unreadable?: string[];
  unwritable?: boolean;
} = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock(1_000);
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const { app } = hostedApp(layers ? { sessionConfig: layers } : {}, { logger });
  apps.push(app);
  provideHome(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, sessionManager, sessionProtocol, hostConfig });
  host.provide(memory, fakeMemory(stored) as never);
  const disk = memoryStorage(files);
  const readFile = disk.readFile.bind(disk);
  disk.readFile = (async (uri: string, encoding?: BufferEncoding) => {
    if (unreadable.includes(uri)) throw Object.assign(new Error(`EACCES: ${uri}`), { code: 'EACCES' });
    return readFile(uri, encoding);
  }) as typeof disk.readFile;
  if (unwritable) disk.writeFile = async () => Promise.reject(new Error('ENOSPC: 磁盘已满'));
  host.provide(storage, disk);
  await app.plugin(adapterPlugin('onebot-a', { platform: 'onebot', canHandle: id => /^onebot:1000[01]:/.test(id) }));
  await app.plugin(adapterPlugin('onebot-b', { platform: 'onebot', canHandle: id => id.startsWith('onebot:20000:') }));
  await app.plugin(adapterPlugin('cli', { platform: 'cli', canHandle: id => id === 'cli-default' }));
  await app.plugin(sessionManagerPlugin);
  for (const plugin of SETTING_PLUGINS) await app.plugin(plugin);
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, sessionServerPlugin.name, ...SETTING_PLUGINS.map(p => p.name)]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  const sm = host.sessionManager.require();

  let turns = 0;
  const messageOf = (sessionId: string): IncomingMessage => ({
    content: '<占位>',
    sessionId,
    platform: sessionId.startsWith('onebot:') ? 'onebot' : 'webui',
  });
  /** 按 agent 的顺序跑一轮：agent:input:before 的默认动作里跑完回合，最后发 agent:turn:after */
  const turn = async (sessionId: string, outcome: Outcome = 'replied', during?: () => Promise<void>) => {
    const message = messageOf(sessionId);
    const turnId = `t${++turns}`;
    await host.hooks.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      await during?.();
      await host.hooks.run('agent:turn:after', {
        message,
        reply: outcome === 'replied' ? '<回复>' : '',
        outcome,
        sessionId,
        turnId,
        metadata: {},
      });
    });
  };

  const doc = () => host.hostConfig.require().get('sessionConfig');
  return { app, host, sm, files, warns, turn, doc, server: () => host.sessionProtocol.require() };
}

describe('握手', () => {
  it('回协议版本、实验标记、服务名，以及传输层给的身份与审批面', async () => {
    const { server } = await setup();
    const c = client(server());
    expect(await c.init()).toEqual({
      protocolVersion: SESSION_PROTOCOL_VERSION,
      experimental: true,
      server: { name: '@aalis/plugin-session-server' },
      identity: { platform: 'webui', userId: 'console' },
      surface: 'webui',
      features: { send: false, rewind: false, compress: false },
      appName: 'T',
    });
    expect(c.disconnects).toEqual([]);
  });

  it('应用名取宿主配置的 name，每次握手现读：改名之后新连接拿到新名字，不用重启', async () => {
    const { server, host } = await setup();
    host.hostConfig.require().set('name', '<新名字>');
    expect((await client(server()).init()).appName).toBe('<新名字>');
  });

  it('没有宿主配置时应用名是 Aalis', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    provideHome(app);
    await registerHubs(app);
    const host = app.bind({ provide, sessionProtocol });
    host.provide(memory, fakeMemory({}) as never);
    host.provide(storage, memoryStorage(new Map()));
    await app.plugin(sessionManagerPlugin);
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();
    expect((await client(host.sessionProtocol.require()).init()).appName).toBe('Aalis');
  });

  it('主版本不同：回 unsupported 并断开，原因写明两边的版本，之后的帧不再处理；只差次版本照常握手', async () => {
    const { server } = await setup();
    const c = client(server());
    const err = await c.fail('initialize', { protocolVersion: `${MAJOR + 1}.0`, client: CLIENT });
    expect(err.data?.code).toBe('unsupported');
    expect(c.disconnects).toHaveLength(1);
    expect(c.disconnects[0]).toContain(`${MAJOR + 1}.0`);
    expect(c.disconnects[0]).toContain(SESSION_PROTOCOL_VERSION);
    expect(await c.raw({ jsonrpc: '2.0', id: 99, method: 'sessions/list' })).toEqual([]);

    const d = client(server());
    expect((await d.call('initialize', { protocolVersion: `${MAJOR}.99`, client: CLIENT })).protocolVersion).toBe(
      SESSION_PROTOCOL_VERSION,
    );
    expect(d.disconnects).toEqual([]);
  });

  it('握手之前别的请求被拒，握手不能重复', async () => {
    const { server } = await setup();
    const c = client(server());
    expect((await c.fail('sessions/list', {})).code).toBe(RPC_ERROR_CODES.invalidRequest);
    await c.init();
    expect((await c.fail('initialize', { protocolVersion: SESSION_PROTOCOL_VERSION, client: CLIENT })).code).toBe(
      RPC_ERROR_CODES.invalidRequest,
    );
    expect((await c.list()).sessions).toEqual([]);
  });

  it('坏帧：不是 JSON、不是 JSON-RPC 请求、方法不认识、参数不合，各回对应的错误码', async () => {
    const { server } = await setup();
    const c = client(server());
    await c.init();
    const errorOf = (frames: Frame[]) => {
      expect(frames).toHaveLength(1);
      return ErrorFrameSchema.parse(frames[0]);
    };
    expect(errorOf(await c.raw('{oops'))).toMatchObject({ id: null, error: { code: RPC_ERROR_CODES.parseError } });
    expect(errorOf(await c.raw({ jsonrpc: '2.0', method: 'sessions/list' }))).toMatchObject({
      id: null,
      error: { code: RPC_ERROR_CODES.invalidRequest },
    });
    expect(errorOf(await c.raw({ jsonrpc: '2.0', id: 'x', method: 'sessions/explode' }))).toMatchObject({
      id: 'x',
      error: { code: RPC_ERROR_CODES.methodNotFound },
    });
    expect(
      errorOf(await c.raw({ jsonrpc: '2.0', id: 8, method: 'sessions/list', params: { limit: 0 } })),
    ).toMatchObject({ id: 8, error: { code: RPC_ERROR_CODES.invalidParams } });
  });
});

describe('会话列表', () => {
  it('两区：我的会话在前、房间在后，section 只取一区；房间行带平台、实例、账号与受众', async () => {
    const { server, sm } = await setup();
    const mine = await sm.createSession({ name: '周报' });
    clock(2_000);
    await sm.ensureSession('onebot:10000:group:20001', { name: '读书会' });
    clock(3_000);
    await sm.ensureSession('onebot:20000:private:30001', { name: '小明' });
    const c = client(server());
    await c.init();

    const all = await c.list();
    expect(all.sessions.map(s => [s.id, s.section])).toEqual([
      [mine.id, 'owner'],
      ['onebot:20000:private:30001', 'rooms'],
      ['onebot:10000:group:20001', 'rooms'],
    ]);
    expect((await c.list({ section: 'owner' })).sessions.map(s => s.id)).toEqual([mine.id]);
    expect((await c.list({ section: 'rooms' })).sessions.map(s => s.id)).toEqual([
      'onebot:20000:private:30001',
      'onebot:10000:group:20001',
    ]);
    expect(all.sessions.find(s => s.id === 'onebot:10000:group:20001')).toMatchObject({
      title: '读书会',
      kind: 'room',
      platform: 'onebot',
      instance: 'onebot-a',
      account: '10000',
      audience: 'group',
    });
    const own = all.sessions.find(s => s.id === mine.id);
    expect(own).toMatchObject({ title: '周报', kind: 'owner', audience: 'owner' });
    expect(own?.instance).toBeUndefined();
    expect(own?.account).toBeUndefined();
  });

  it('「我的」区：出错、完成未读、运行中依次排在前面，其余按最后活动从新到旧；房间不记未读', async () => {
    const { server, sm, turn } = await setup();
    const ids: Record<string, string> = {};
    for (const [i, name] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      clock(1_000 + i);
      ids[name] = (await sm.createSession({ name })).id;
    }
    await sm.ensureSession('onebot:10000:group:1', { name: '群' });
    clock(5_000);
    await turn(ids.D, 'replied');
    await turn(ids.B, 'error');
    await turn('onebot:10000:group:1', 'replied');
    const held = deferred();
    const running = turn(ids.C, 'replied', () => held.promise);
    const c = client(server());
    await c.init();
    await vi.waitFor(async () => expect((await c.summary(ids.C)).running).toBe(true));

    const owner = (await c.list({ section: 'owner' })).sessions;
    expect(owner.map(s => s.title)).toEqual(['B', 'D', 'C', 'E', 'A']);
    expect(owner.map(s => [s.title, s.error, s.unread, s.running])).toEqual([
      ['B', true, false, false],
      ['D', false, true, false],
      ['C', false, false, true],
      ['E', false, false, false],
      ['A', false, false, false],
    ]);
    const room = await c.summary('onebot:10000:group:1');
    expect(room).toMatchObject({ unread: false, lastReplyAt: 5_000 });

    held.resolve();
    await running;
    expect((await c.summary(ids.C)).running).toBe(false);
  });

  it('房间按最后活动排；按接管的适配器实例分组，组里有房间数与账号数，没记下实例的按平台成一组；组不受搜索影响', async () => {
    const { server, sm } = await setup();
    for (const [at, id] of [
      [1_000, 'onebot:10000:group:1'],
      [1_500, 'onebot:10000:private:5'],
      [2_000, 'onebot:20000:private:3'],
      [3_000, 'onebot:10001:group:2'],
      [4_000, 'onebot:30000:group:4'],
    ] as const) {
      clock(at);
      await sm.ensureSession(id, { name: id });
    }
    const c = client(server());
    await c.init();

    const rooms = await c.list({ section: 'rooms' });
    expect(rooms.sessions.map(s => [s.id, s.instance])).toEqual([
      ['onebot:30000:group:4', undefined],
      ['onebot:10001:group:2', 'onebot-a'],
      ['onebot:20000:private:3', 'onebot-b'],
      ['onebot:10000:private:5', 'onebot-a'],
      ['onebot:10000:group:1', 'onebot-a'],
    ]);
    const groups = [
      { platform: 'onebot', instance: 'onebot-a', label: 'onebot-a', rooms: 3, accounts: 2, attention: 0 },
      { platform: 'onebot', instance: 'onebot-b', label: 'onebot-b', rooms: 1, accounts: 1, attention: 0 },
      { platform: 'onebot', label: 'onebot', rooms: 1, accounts: 1, attention: 0 },
    ];
    expect(rooms.groups).toEqual(groups);
    const searched = await c.list({ query: 'group:2' });
    expect(searched.sessions.map(s => s.id)).toEqual(['onebot:10001:group:2']);
    expect(searched.groups).toEqual(groups);
  });

  it('一组房间：instance 只列这个实例接管的，platform 只列这个平台还没记下实例的；已归档的房间不进分组；组名是实例的显示名', async () => {
    const { app, server, sm } = await setup();
    const reusable = definePlugin({
      name: 'qq-adapter',
      displayName: 'QQ 机器人',
      reusable: true,
      provides: [platform],
      uses: { provide },
      apply: ({ provide }) => {
        provide(platform, {
          platform: 'onebot',
          canHandle: (id: string) => id.startsWith('onebot:40000:'),
          getConnections: () => [],
          sendMessage: async () => {},
        } as never);
      },
    });
    await app.plugin(reusable, {}, 'qq-adapter:work');
    await app.plugins.idle();
    for (const id of ['onebot:10000:group:1', 'onebot:10000:group:2', 'onebot:40000:group:3', 'onebot:30000:group:4']) {
      await sm.ensureSession(id, { name: id });
    }
    await sm.updateSession('onebot:10000:group:2', { status: 'archived' });
    const c = client(server());
    await c.init();
    const ids = async (params: Parameters<typeof c.list>[0]) => (await c.list(params)).sessions.map(s => s.id);

    expect(await ids({ instance: 'onebot-a' })).toEqual(['onebot:10000:group:1']);
    expect(await ids({ instance: 'onebot-a', archived: true })).toEqual(['onebot:10000:group:2']);
    expect(await ids({ instance: 'qq-adapter:work' })).toEqual(['onebot:40000:group:3']);
    expect(await ids({ platform: 'onebot' })).toEqual(['onebot:30000:group:4']);
    expect((await c.fail('sessions/list', { instance: 'onebot-a', platform: 'onebot' })).code).toBe(
      RPC_ERROR_CODES.invalidParams,
    );
    expect((await c.list()).groups).toEqual([
      { platform: 'onebot', instance: 'onebot-a', label: 'onebot-a', rooms: 1, accounts: 1, attention: 0 },
      {
        platform: 'onebot',
        instance: 'qq-adapter:work',
        label: 'QQ 机器人（work）',
        rooms: 1,
        accounts: 1,
        attention: 0,
      },
      { platform: 'onebot', label: 'onebot', rooms: 1, accounts: 1, attention: 0 },
    ]);
  });

  it('搜索：名称、标题、id 与「平台:群号」都能命中，不分大小写', async () => {
    const { server, sm } = await setup();
    const weekly = await sm.createSession({ name: '会话 1' });
    await sm.updateSessionTitle(weekly.id, 'Weekly Report');
    await sm.ensureSession('onebot:10000:group:20001', { name: '读书会' });
    await sm.ensureSession('onebot:10000:group:20002', { name: '跑团' });
    const c = client(server());
    await c.init();
    const ids = async (query: string) => (await c.list({ query })).sessions.map(s => s.id);

    expect(await ids('weekly')).toEqual([weekly.id]);
    expect(await ids('会话 1')).toEqual([weekly.id]);
    expect(await ids('读书')).toEqual(['onebot:10000:group:20001']);
    expect(await ids('20002')).toEqual(['onebot:10000:group:20002']);
    expect(await ids('ONEBOT:20001')).toEqual(['onebot:10000:group:20001']);
    expect(await ids('qq:20001')).toEqual([]);
  });

  it('分页：nextCursor 接着上一页取，最后一页没有；坏的 cursor 回参数错误', async () => {
    const { server, sm } = await setup();
    for (let i = 0; i < 5; i++) {
      clock(1_000 + i);
      await sm.createSession({ name: `S${i}` });
    }
    const c = client(server());
    await c.init();
    const titles: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await c.list({ limit: 2, cursor });
      titles.push(...page.sessions.map(s => s.title));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(titles).toEqual(['S4', 'S3', 'S2', 'S1', 'S0']);
    expect((await c.fail('sessions/list', { cursor: 'abc' })).code).toBe(RPC_ERROR_CODES.invalidParams);
  });

  it('parentId 列出直接子会话，子会话归在根会话的区里、不进根列表；父会话不存在回 not-found', async () => {
    const { server, sm } = await setup();
    const root = await sm.createSession({ name: '根' });
    const child = await sm.createChildSession(root.id, { name: '子' });
    const grandchild = await sm.createChildSession(child.id, { name: '孙' });
    await sm.ensureSession('onebot:10000:group:1', { name: '群' });
    const roomChild = await sm.createChildSession('onebot:10000:group:1', { name: '群里的子任务' });
    const c = client(server());
    await c.init();

    expect((await c.list()).sessions.map(s => s.id)).not.toContain(child.id);
    expect((await c.summary(root.id)).childCount).toBe(1);
    const children = (await c.list({ parentId: root.id })).sessions;
    expect(children.map(s => [s.id, s.kind, s.section, s.parentId, s.childCount])).toEqual([
      [child.id, 'task', 'owner', root.id, 1],
    ]);
    expect((await c.list({ parentId: child.id })).sessions.map(s => [s.id, s.section])).toEqual([
      [grandchild.id, 'owner'],
    ]);
    expect((await c.list({ parentId: 'onebot:10000:group:1' })).sessions.map(s => [s.id, s.section])).toEqual([
      [roomChild.id, 'rooms'],
    ]);
    expect((await c.fail('sessions/list', { parentId: 'session-nope' })).data?.code).toBe('not-found');
  });
});

describe('watch 增量', () => {
  it('建档、改名、子会话增删与删除各推一条增量，带最新的分组；没 watch 的连接收不到，连接关闭后不再推送', async () => {
    const { server, sm } = await setup();
    const watcher = client(server());
    const quiet = client(server());
    await watcher.init();
    await quiet.init();
    await watcher.call('sessions/watch', {});
    const changes = () => watcher.notifications('sessions/changed');

    const { session } = await watcher.call('session/create', { name: '新会话' });
    expect(
      changes()
        .at(-1)
        ?.upserts.map(s => s.id),
    ).toEqual([session.id]);

    await watcher.call('session/rename', { sessionId: session.id, title: '改过的名字' });
    expect(
      changes()
        .at(-1)
        ?.upserts.map(s => s.title),
    ).toEqual(['改过的名字']);

    const { session: child } = await watcher.call('session/create', { name: '子', parentId: session.id });
    const afterChild = changes().flatMap(n => n.upserts);
    expect(afterChild.find(s => s.id === child.id)?.parentId).toBe(session.id);
    expect(afterChild.filter(s => s.id === session.id).at(-1)?.childCount).toBe(1);

    await watcher.call('session/delete', { sessionId: child.id });
    expect(changes().some(n => n.removes.includes(child.id))).toBe(true);
    expect(
      changes()
        .flatMap(n => n.upserts)
        .filter(s => s.id === session.id)
        .at(-1)?.childCount,
    ).toBe(0);

    await sm.ensureSession('onebot:10000:group:1', { name: '群' });
    expect(changes().at(-1)?.groups).toEqual([
      { platform: 'onebot', instance: 'onebot-a', label: 'onebot-a', rooms: 1, accounts: 1, attention: 0 },
    ]);

    await watcher.call('session/delete', { sessionId: session.id });
    expect(changes().at(-1)).toMatchObject({ upserts: [], removes: [session.id] });
    expect(quiet.notifications('sessions/changed')).toEqual([]);

    watcher.conn.close();
    const seen = watcher.frames.length;
    await sm.createSession({ name: '关闭之后' });
    expect(watcher.frames.length).toBe(seen);
  });

  it('回合开始与结束推送运行状态', async () => {
    const { server, sm, turn } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    await c.call('sessions/watch', {});
    const states = () =>
      c
        .notifications('sessions/changed')
        .flatMap(n => n.upserts)
        .filter(u => u.id === s.id)
        .map(u => u.running);

    const held = deferred();
    const running = turn(s.id, 'replied', () => held.promise);
    await vi.waitFor(() => expect(states()).toContain(true));
    held.resolve();
    await running;
    expect(states().at(-1)).toBe(false);
  });
});

describe('已读', () => {
  it('markSeen 之后不再未读：别的连接看到同一结果，watch 的连接收到推送；她再开口又变成未读', async () => {
    const { server, sm, turn } = await setup();
    const s = await sm.createSession({ name: 'S' });
    clock(2_000);
    await turn(s.id, 'replied');
    const a = client(server());
    const b = client(server());
    await a.init();
    await b.init();
    await b.call('sessions/watch', {});
    expect((await a.summary(s.id)).unread).toBe(true);

    clock(3_000);
    await a.call('session/markSeen', { sessionId: s.id });
    expect((await a.summary(s.id)).unread).toBe(false);
    expect((await b.summary(s.id)).unread).toBe(false);
    expect(
      b
        .notifications('sessions/changed')
        .flatMap(n => n.upserts)
        .at(-1),
    ).toMatchObject({
      id: s.id,
      unread: false,
    });

    clock(4_000);
    await turn(s.id, 'replied');
    expect((await b.summary(s.id)).unread).toBe(true);
    expect((await a.fail('session/markSeen', { sessionId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('已读时间落在插件数据里：会话服务重启后仍然已读；重启时断开旧连接；删掉的会话不再留已读记录', async () => {
    const { app, server, sm, turn, files } = await setup();
    const s = await sm.createSession({ name: 'S' });
    const other = await sm.createSession({ name: 'T' });
    await turn(s.id, 'replied');
    await turn(other.id, 'replied');
    const c = client(server());
    await c.init();
    clock(2_000);
    await c.call('session/markSeen', { sessionId: s.id });
    await c.call('session/markSeen', { sessionId: other.id });
    expect(JSON.parse(String(files.get(SEEN_URI)))).toEqual({ seen: { [s.id]: 2_000, [other.id]: 2_000 } });

    await app.plugins.bounce(sessionServerPlugin.name);
    await app.plugins.idle();
    expect(c.disconnects).toHaveLength(1);
    const d = client(server());
    await d.init();
    expect((await d.summary(s.id)).unread).toBe(false);

    await d.call('session/delete', { sessionId: other.id });
    await vi.waitFor(() => expect(JSON.parse(String(files.get(SEEN_URI)))).toEqual({ seen: { [s.id]: 2_000 } }));
  });
});

describe('已读记录的读取', () => {
  it('内容读不懂：告警后从空起步，下次记已读时覆盖成合法的记录', async () => {
    const files = new Map<string, string | Uint8Array>([[SEEN_URI, '{oops']]);
    const { server, sm, warns } = await setup({ files });
    expect(warns.some(w => w.includes(SEEN_URI))).toBe(true);
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    await c.call('session/markSeen', { sessionId: s.id });
    expect(JSON.parse(String(files.get(SEEN_URI)))).toEqual({ seen: { [s.id]: 1_000 } });
  });

  it('落盘失败：markSeen 回 internalError，不当成功', async () => {
    const { server, sm, warns } = await setup({ unwritable: true });
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const err = await c.fail('session/markSeen', { sessionId: s.id });
    expect(err).toMatchObject({ code: RPC_ERROR_CODES.internalError, message: expect.stringContaining('ENOSPC') });
    expect(warns.some(w => w.includes('session/markSeen'))).toBe(true);
  });

  it('读不出来（不是文件不存在）：会话服务不启动，原有记录不被空表覆盖', async () => {
    const files = new Map<string, string | Uint8Array>([[SEEN_URI, '{"seen":{"session-1":5}}']]);
    await expect(setup({ files, unreadable: [SEEN_URI] })).rejects.toThrow(/plugin-session-server 未激活/);
    expect(files.get(SEEN_URI)).toBe('{"seen":{"session-1":5}}');
  });
});

describe('建、改名、归档、删除与批量', () => {
  it('create：根会话不复制各层，按继承链生效；子会话复制父会话的生效配置，只经继承链实时解析的项除外', async () => {
    const { server, sm } = await setup({
      layers: { defaults: { paperName: '<白纸名>' }, platforms: { webui: { persona: 'aalis-webui' } } },
    });
    const c = client(server());
    await c.init();

    const { session: root } = await c.call('session/create', {});
    expect(root.title).toMatch(/^会话 /);
    expect(sm.getSession(root.id)).toMatchObject({ status: 'waiting', createdBy: 'user' });
    expect(sm.getSession(root.id)?.config).toEqual({});
    const persona = (await c.call('session/config/get', { sessionId: root.id })).items.find(r => r.key === 'persona');
    expect([persona?.effective, persona?.source]).toEqual(['aalis-webui', 'platform']);

    await sm.updateSession(root.id, { config: { think: 'high' } });
    const { session: child } = await c.call('session/create', { name: '子', parentId: root.id });
    expect(child).toMatchObject({ title: '子', parentId: root.id, kind: 'task' });
    expect(sm.getSession(child.id)?.config).toEqual({ persona: 'aalis-webui', think: 'high' });

    expect((await c.fail('session/create', { parentId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('rename、archive 与 unarchive（都连同子会话）、delete；已归档的只在 archived 的列表里；会话不存在回 not-found', async () => {
    const { server, sm } = await setup();
    const root = await sm.createSession({ name: '根' });
    const child = await sm.createChildSession(root.id, { name: '子' });
    const other = await sm.createSession({ name: '别的' });
    const c = client(server());
    await c.init();

    await c.call('session/rename', { sessionId: root.id, title: '新名字' });
    expect((await c.summary(root.id)).title).toBe('新名字');

    await c.call('session/archive', { sessionId: root.id });
    expect(sm.getSession(root.id)?.status).toBe('archived');
    expect(sm.getSession(child.id)?.status).toBe('archived');
    expect((await c.list()).sessions.map(s => s.id)).toEqual([other.id]);
    const archived = (await c.list({ archived: true })).sessions;
    expect(archived.map(s => [s.id, s.archived])).toEqual([[root.id, true]]);
    expect((await c.list({ parentId: root.id, archived: true })).sessions.map(s => s.id)).toEqual([child.id]);

    await c.call('session/unarchive', { sessionId: root.id });
    expect([root, child].map(s => sm.getSession(s.id)?.status)).toEqual(['completed', 'completed']);
    expect((await c.summary(root.id)).archived).toBe(false);
    expect((await c.list({ archived: true })).sessions).toEqual([]);
    const before = sm.getSession(other.id)?.status;
    await c.call('session/unarchive', { sessionId: other.id });
    expect(sm.getSession(other.id)?.status, '没归档的不动').toBe(before);

    await c.call('session/delete', { sessionId: root.id });
    expect(sm.getSession(root.id)).toBeUndefined();
    expect(sm.getSession(child.id)).toBeUndefined();

    for (const method of ['session/rename', 'session/archive', 'session/unarchive', 'session/delete']) {
      const err = await c.fail(method, { sessionId: root.id, title: 'x' });
      expect(err.data?.code, method).toBe('not-found');
    }
  });

  it('batch：逐个执行，开始前就不存在的与执行出错的列进 failed，其余照常；删父会话时一并删掉的子会话不算失败', async () => {
    const { server, sm, host } = await setup();
    const a = await sm.createSession({ name: 'A' });
    const b = await sm.createSession({ name: 'B' });
    const bChild = await sm.createChildSession(b.id, { name: 'B 的子会话' });
    const c = client(server());
    await c.init();

    const archived = await c.call('session/batch', { op: 'archive', ids: [a.id, b.id, 'session-nope'] });
    expect(archived.failed).toEqual([{ sessionId: 'session-nope', message: expect.any(String) }]);
    expect([a, b, bChild].map(s => sm.getSession(s.id)?.status)).toEqual(['archived', 'archived', 'archived']);

    // A 的清理出错：列进 failed，后面的 B 与它的子会话照常删除
    host.hooks.middleware('memory:clear', async (data, next) => {
      if (data.sessionId === a.id) throw new Error('清理失败');
      await next();
    });
    const deleted = await c.call('session/batch', { op: 'delete', ids: [a.id, b.id, bChild.id] });
    expect(deleted.failed).toEqual([{ sessionId: a.id, message: '清理失败' }]);
    expect([b, bChild].map(s => sm.getSession(s.id))).toEqual([undefined, undefined]);
  });
});

describe('会话设置', () => {
  const LAYERS = {
    defaults: { persona: 'aalis' },
    platforms: {
      webui: { persona: 'aalis-webui' },
      cli: { persona: 'aalis-cli' },
      onebot: { enabledToolGroups: ['onebot'] },
    },
    audiences: { onebot: { group: { paperName: '<群白纸>' } } },
  };
  type Rows = Array<{ key: string; value?: unknown; effective?: unknown; source?: string }>;
  /** 每行的键、本层的值、生效值与来源 */
  const values = (rows: Rows) => rows.map(r => [r.key, r.value, r.effective, r.source]);

  it('config/get：只列适用于这种会话的项，composer、common 在前，composer 最多两项；每行带字段、所属插件、本会话的值、生效值与来源', async () => {
    const { server, sm } = await setup({
      layers: LAYERS,
      stored: {
        'session-old': {
          id: 'session-old',
          name: '旧',
          children: [],
          status: 'completed',
          config: { persona: null, think: 'high', memoryRecallScope: 'session' },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    await sm.ensureSession('onebot:10000:group:1', { name: '群' });
    const c = client(server());
    await c.init();

    const old = await c.call('session/config/get', { sessionId: 'session-old' });
    expect(old.items.map(r => [r.key, r.prominence, r.plugin])).toEqual([
      ['llm', 'composer', 'agent-settings'],
      ['think', 'composer', 'agent-settings'],
      ['systemPromptExtra', 'common', 'persona-settings'],
      ['persona', 'common', 'persona-settings'],
      ['enabledToolGroups', 'common', 'tools-settings'],
      ['maxToolIterations', 'advanced', 'agent-settings'],
      ['clientSideJsonRendering', 'advanced', 'persona-settings'],
    ]);
    expect(old.items[0].field).toEqual(MODEL_FIRST.field);
    expect(old.items.filter(r => r.dependsOn !== undefined).map(r => [r.key, r.dependsOn])).toEqual([['think', 'llm']]);
    expect(values(old.items)).toEqual([
      ['llm', undefined, undefined, undefined],
      ['think', 'high', 'high', 'session'],
      ['systemPromptExtra', undefined, undefined, undefined],
      ['persona', undefined, 'aalis-webui', 'platform'],
      ['enabledToolGroups', undefined, undefined, undefined],
      ['maxToolIterations', undefined, undefined, undefined],
      ['clientSideJsonRendering', undefined, undefined, undefined],
    ]);

    const room = await c.call('session/config/get', { sessionId: 'onebot:10000:group:1' });
    expect(values(room.items)).toEqual([
      ['llm', undefined, undefined, undefined],
      ['think', undefined, undefined, undefined],
      ['systemPromptExtra', undefined, undefined, undefined],
      ['persona', undefined, 'aalis', 'defaults'],
      ['enabledToolGroups', undefined, ['onebot'], 'platform'],
      ['maxToolIterations', undefined, undefined, undefined],
      ['paperName', undefined, '<群白纸>', 'audience'],
    ]);

    // owner 的会话按连接的入口平台选档：先看会话记下的平台，再看接管会话 id 的适配器，最后才取连接的平台
    const persona = async (conn: ReturnType<typeof client>, sessionId: string) =>
      (await conn.call('session/config/get', { sessionId })).items.find(r => r.key === 'persona')?.effective;
    const cli = client(server(), {
      identity: { platform: 'cli', userId: 'console' },
      surface: { ...DETACHED_SURFACE, name: 'cli' },
    });
    await cli.init();
    expect(await persona(cli, 'session-old')).toBe('aalis-cli');
    const recorded = await sm.createSession({ name: '子任务建的', metadata: { platform: 'cli' } });
    expect(await persona(c, recorded.id)).toBe('aalis-cli');
    await sm.ensureSession('cli-default');
    expect(await persona(c, 'cli-default')).toBe('aalis-cli');
    expect((await c.fail('session/config/get', { sessionId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('config/update：按键写成本会话的覆盖，null 恢复继承，回最新的行；没登记的键与不合字段的值回参数错误、什么都不改', async () => {
    const { server, sm } = await setup({ layers: LAYERS });
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const pick = (rows: Rows, ...keys: string[]) => values(rows.filter(r => keys.includes(r.key)));

    const set = await c.call('session/config/update', { sessionId: s.id, patch: { persona: '<人设>', think: 'off' } });
    expect(pick(set.items, 'persona', 'think')).toEqual([
      ['think', 'off', 'off', 'session'],
      ['persona', '<人设>', '<人设>', 'session'],
    ]);

    const reset = await c.call('session/config/update', { sessionId: s.id, patch: { persona: null } });
    expect(pick(reset.items, 'persona')).toEqual([['persona', undefined, 'aalis-webui', 'platform']]);
    expect(sm.getSession(s.id)?.config).toEqual({ think: 'off' });

    for (const patch of [
      { think: 1 },
      { bogus: 1 },
      { persona: '<另一个>', maxToolIterations: 0 },
      { llm: 'x' },
      { llm: { provider: 1, model: {} } },
    ]) {
      const err = await c.fail('session/config/update', { sessionId: s.id, patch });
      expect(err.code, JSON.stringify(patch)).toBe(RPC_ERROR_CODES.invalidParams);
    }
    expect(sm.getSession(s.id)?.config).toEqual({ think: 'off' });
    expect((await c.fail('session/config/update', { sessionId: 'session-nope', patch: {} })).data?.code).toBe(
      'not-found',
    );
  });

  it('写入只收适用于这个种类的项（受众条目按房间）：不适用的回参数错误、什么都不改；null 照常删掉旧值', async () => {
    const { server, sm, doc } = await setup({ layers: LAYERS });
    const s = await sm.createSession({ name: 'S' });
    await sm.ensureSession('session-legacy', { config: { paperName: '<旧数据>' } });
    const c = client(server());
    await c.init();
    const group = { scope: 'audience', platform: 'onebot', audience: 'group' } as const;

    const err = await c.fail('session/config/update', { sessionId: s.id, patch: { paperName: '<白纸>' } });
    expect(err.code).toBe(RPC_ERROR_CODES.invalidParams);
    expect(sm.getSession(s.id)?.config).toEqual({});
    const layerErr = await c.fail('session/config/layer/update', {
      layer: group,
      patch: { clientSideJsonRendering: true },
    });
    expect(layerErr.code).toBe(RPC_ERROR_CODES.invalidParams);
    expect(doc()?.audiences).toEqual(LAYERS.audiences);

    await c.call('session/config/update', { sessionId: 'session-legacy', patch: { paperName: null } });
    expect(sm.getSession('session-legacy')?.config).toEqual({});
  });

  it('按层读写：layers 列出可以设的各层；一层的行与会话的同形，受众条目只列适用于房间的项；改动写进宿主配置文档', async () => {
    const { server, doc } = await setup({ layers: LAYERS });
    const c = client(server());
    await c.init();
    const group = { scope: 'audience', platform: 'onebot', audience: 'group' } as const;
    const onebot = { scope: 'platform', platform: 'onebot' } as const;

    expect((await c.call('session/config/layers', {})).layers).toEqual([
      { scope: 'defaults' },
      { scope: 'platform', platform: 'cli' },
      onebot,
      group,
      { scope: 'platform', platform: 'webui' },
    ]);
    const defaults = await c.call('session/config/layer/get', { layer: { scope: 'defaults' } });
    expect(defaults.items.map(r => r.key)).toContain('clientSideJsonRendering');
    const rows = (await c.call('session/config/layer/get', { layer: group })).items;
    expect(rows.map(r => r.key)).not.toContain('clientSideJsonRendering');
    expect(values(rows).filter(([, , effective]) => effective !== undefined)).toEqual([
      ['persona', undefined, 'aalis', 'defaults'],
      ['enabledToolGroups', undefined, ['onebot'], 'platform'],
      ['paperName', '<群白纸>', '<群白纸>', 'audience'],
    ]);

    const updated = await c.call('session/config/layer/update', { layer: onebot, patch: { persona: '<群人设>' } });
    expect(values(updated.items).find(([key]) => key === 'persona')).toEqual([
      'persona',
      '<群人设>',
      '<群人设>',
      'platform',
    ]);
    expect(doc()?.platforms?.onebot).toEqual({ enabledToolGroups: ['onebot'], persona: '<群人设>' });

    for (const params of [
      { layer: onebot, patch: { bogus: 1 } },
      { layer: onebot, patch: { think: 1 } },
      { layer: { scope: 'platform', platform: '' }, patch: { persona: '<人设>' } },
      { layer: { scope: 'audience', platform: 'onebot', audience: 'owner' }, patch: { persona: '<人设>' } },
    ]) {
      const err = await c.fail('session/config/layer/update', params);
      expect(err.code, JSON.stringify(params)).toBe(RPC_ERROR_CODES.invalidParams);
    }
    expect(doc()?.platforms?.onebot).toEqual({ enabledToolGroups: ['onebot'], persona: '<群人设>' });
  });

  it('插件启停推 session/config/changed：每条连接都收到；停用后它的项不再出现、值还在，重新启用后恢复', async () => {
    const { app, server, sm } = await setup();
    const room = 'onebot:10000:group:1';
    await sm.ensureSession(room, { config: { paperName: '<自己的白纸>' } });
    const a = client(server());
    const b = client(server());
    await a.init();
    await b.init();
    const paperRow = async () =>
      (await a.call('session/config/get', { sessionId: room })).items.find(r => r.key === 'paperName');

    await app.plugins.disable('paper-settings');
    expect(a.notifications('session/config/changed')).toHaveLength(1);
    expect(b.notifications('session/config/changed')).toHaveLength(1);
    expect(await paperRow()).toBeUndefined();
    expect(sm.getSession(room)?.config).toEqual({ paperName: '<自己的白纸>' });

    await app.plugins.enable('paper-settings');
    expect(b.notifications('session/config/changed')).toHaveLength(2);
    expect(await paperRow()).toMatchObject({ value: '<自己的白纸>', source: 'session' });
  });
});
