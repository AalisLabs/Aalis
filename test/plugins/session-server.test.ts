import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { type AalisConfig, ConfigSaveRefusedError, saveFailureText } from '../../packages/api-host-config/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  ErrorFrameSchema,
  RPC_ERROR_CODES,
  SESSION_PROTOCOL_VERSION,
  type SessionMethod,
  sessionProtocol,
} from '../../packages/api-session-protocol/src/index.js';
import { SESSION_LAYERS } from '../../packages/api-session-settings/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type App, definePlugin, type Logger, provide, services } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import sessionSettingsPlugin from '../../packages/plugin-session-settings/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { hostedApp, registerFromDoc } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { memoryStorage } from '../fixtures/memory-files.js';
import { recordRoom } from '../fixtures/rooms.js';
import { CLIENT, client, DETACHED_SURFACE, type Frame } from '../fixtures/session-client.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { fieldsPlugin, ONEBOT_TYPES, OTHER_SCHEMA, SCHEMA } from '../fixtures/session-settings.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 会话服务（plugin-session-server）的前一半：握手；会话列表的分区、分组、状态、排序、搜索与分页，摘要的聊天窗口与场所；
// watch 的增量推送；建、改名、归档、删除与批量；会话设置的各行与各层（层表、场所、只能设到场所为止的项、全局默认层由
// 服务偏好承担的「模型」）；「我的」区的已读。
// 全部经 sessionProtocol.connect 直接收发帧，不走网络；收到的每个结果与通知都先过协议 schema。
// ════════════════════════════════════════════════════════════

const SEEN_URI = 'pluginData:/session-server/seen.json';
const [MAJOR, MINOR] = SESSION_PROTOCOL_VERSION.split('.');

const apps: App[] = [];
/** 每个 App 一个临时数据目录：会话服务的审批审计写在它下面 */
const homes: string[] = [];
/** 像 runtime 一样在根上提供 host-paths，数据目录是新建的临时目录 */
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
      provide.use(platform, { getConnections: () => [], sendMessage: async () => {}, ...adapter } as never);
    },
  });

/** 此刻实际在用的模型：没设模型时行上带它（声明字段的插件交给会话设置的 actual） */
const NOW_MODEL = { provider: 'zz-llm', model: 'm1' };
/** 代替声明这些字段的插件：一个声明各种项，另一个与它有同名的项（scope） */
const AGENT = () => fieldsPlugin('zz-agent', SCHEMA, { llm: () => ({ value: NOW_MODEL, label: '<此刻的模型>' }) });
const OTHER = () => fieldsPlugin('zz-other', OTHER_SCHEMA);

/** 时钟只假 Date：会话的创建、改动与开口时间取 Date.now()，定时器照常走 */
function clock(at: number): void {
  vi.setSystemTime(at);
}

/**
 * stored：会话表里预置的记录；files：插件数据（已读记录）；doc：宿主配置文档（插件配置与 sessionConfig）；
 * unreadable：这些 URI 存在但读不出来（权限错，不是不存在）；save：宿主配置的落盘；settings 为 false 时不装会话设置插件
 */
async function setup({
  stored = {},
  files = new Map<string, string | Uint8Array>(),
  doc = {},
  unreadable = [],
  unwritable = false,
  save,
  settings = true,
}: {
  stored?: Record<string, Record<string, unknown>>;
  files?: Map<string, string | Uint8Array>;
  doc?: Partial<AalisConfig>;
  unreadable?: string[];
  unwritable?: boolean;
  save?: (config: AalisConfig) => Promise<void>;
  settings?: boolean;
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
  const { app, store } = hostedApp(doc, { logger, provider: save ? { save } : undefined });
  apps.push(app);
  provideHome(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, services, sessionManager, sessionProtocol });
  host.provide.use(memory, fakeMemory(stored) as never);
  const disk = memoryStorage(files);
  const readFile = disk.readFile.bind(disk);
  disk.readFile = (async (uri: string, encoding?: BufferEncoding) => {
    if (unreadable.includes(uri)) throw Object.assign(new Error(`EACCES: ${uri}`), { code: 'EACCES' });
    return readFile(uri, encoding);
  }) as typeof disk.readFile;
  if (unwritable) disk.writeFile = async () => Promise.reject(new Error('ENOSPC: 磁盘已满'));
  host.provide.use(storage, disk);
  const onebot = { platform: 'onebot', sessionTypes: ONEBOT_TYPES };
  await app.plugin(adapterPlugin('onebot-a', { ...onebot, canHandle: id => /^onebot:1000[01]:/.test(id) }));
  await app.plugin(adapterPlugin('onebot-b', { ...onebot, canHandle: id => id.startsWith('onebot:20000:') }));
  await app.plugin(adapterPlugin('cli', { platform: 'cli', canHandle: id => id === 'cli-default' }));
  await app.plugin(sessionManagerPlugin);
  const fields = [AGENT(), OTHER()];
  const plugins = [...(settings ? [sessionSettingsPlugin] : []), ...fields.map(field => field.definition)];
  for (const plugin of plugins) await registerFromDoc(app, store, plugin);
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, sessionServerPlugin.name, ...plugins.map(p => p.name)]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  const sm = host.sessionManager.use;

  let turns = 0;
  const messageOf = (sessionId: string): IncomingMessage => ({
    content: '<占位>',
    sessionId,
    platform: sessionId.startsWith('onebot:') ? 'onebot' : 'webui',
  });
  /** 按 agent 的顺序跑一轮：agent:turn:before 的默认动作里执行完回合，最后发 agent:turn:after */
  const turn = async (sessionId: string, outcome: Outcome = 'replied', during?: () => Promise<void>) => {
    const message = messageOf(sessionId);
    const turnId = `t${++turns}`;
    await host.hooks.use.run(
      'agent:turn:before',
      { turnId, sessionId: message.sessionId, inputs: [{ message }] },
      async () => {
        await during?.();
        await host.hooks.use.run('agent:turn:after', {
          inputs: [{ message }],
          reply: outcome === 'replied' ? '<回复>' : '',
          outcome,
          sessionId,
          turnId,
        });
      },
    );
  };

  return { app, host, store, sm, files, warns, turn, server: () => host.sessionProtocol.use };
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
      features: { send: false, rewind: false, compress: false, settings: true },
    });
    expect(c.disconnects).toEqual([]);
  });

  it('0.x 的协议号比前两段：前两段不同回 unsupported 并断开，原因写明两边的版本，之后的帧不再处理；只差第三段照常握手', async () => {
    const { server } = await setup();
    const c = client(server());
    const newer = `${MAJOR}.${Number(MINOR) + 1}.0`;
    const err = await c.fail('initialize', { protocolVersion: newer, client: CLIENT });
    expect(err.data?.code).toBe('unsupported');
    expect(c.disconnects).toHaveLength(1);
    expect(c.disconnects[0]).toContain(newer);
    expect(c.disconnects[0]).toContain(SESSION_PROTOCOL_VERSION);
    expect(await c.raw({ jsonrpc: '2.0', id: 99, method: 'sessions/list' })).toEqual([]);

    const d = client(server());
    const patch = `${MAJOR}.${MINOR}.99`;
    expect((await d.call('initialize', { protocolVersion: patch, client: CLIENT })).protocolVersion).toBe(
      SESSION_PROTOCOL_VERSION,
    );
    expect(d.disconnects).toEqual([]);
  });

  it('0.20 的 WebUI 与终端报 1.0：握手被拒，回的是写明两边版本的 unsupported，不是参数不合', async () => {
    const { server } = await setup();
    const c = client(server());
    expect((await c.fail('initialize', { protocolVersion: '1.0', client: CLIENT })).data?.code).toBe('unsupported');
    expect(c.disconnects).toHaveLength(1);
    expect(c.disconnects[0]).toContain('1.0');
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
  it('两区：我的会话在前、房间在后，section 只取一区；房间行带平台、实例、账号与聊天窗口，每个会话带场所', async () => {
    const { host, server, sm } = await setup();
    const mine = await sm.createSession({ name: '周报' }, { createdFrom: 'webui' });
    clock(2_000);
    await recordRoom(host.events.use, 'onebot:10000:group:20001', '读书会');
    clock(3_000);
    await recordRoom(host.events.use, 'onebot:20000:private:30001', '小明');
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
      chat: { type: 'group', multiParty: true },
      place: { key: 'onebot:group:20001', kind: 'window', name: '读书会' },
    });
    expect(all.sessions.find(s => s.id === 'onebot:20000:private:30001')).toMatchObject({
      chat: { type: 'private', multiParty: false },
      place: { key: 'onebot:private:30001', kind: 'window', name: '小明' },
    });
    const own = all.sessions.find(s => s.id === mine.id);
    expect(own).toMatchObject({
      title: '周报',
      kind: 'owner',
      place: { key: 'workspace:default', kind: 'workspace', name: '默认工作区' },
    });
    expect(own?.instance).toBeUndefined();
    expect(own?.account).toBeUndefined();
    expect(own?.chat).toBeUndefined();
  });

  it('「我的」区：出错、完成未读、运行中依次排在前面，其余按最后活动从新到旧；房间不记未读', async () => {
    const { host, server, sm, turn } = await setup();
    const ids: Record<string, string> = {};
    for (const [i, name] of ['A', 'B', 'C', 'D', 'E'].entries()) {
      clock(1_000 + i);
      ids[name] = (await sm.createSession({ name })).id;
    }
    await recordRoom(host.events.use, 'onebot:10000:group:1', '群');
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
    const { host, server } = await setup();
    for (const [at, id] of [
      [1_000, 'onebot:10000:group:1'],
      [1_500, 'onebot:10000:private:5'],
      [2_000, 'onebot:20000:private:3'],
      [3_000, 'onebot:10001:group:2'],
      [4_000, 'onebot:30000:group:4'],
    ] as const) {
      clock(at);
      await recordRoom(host.events.use, id, id);
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
    const { app, host, server, sm } = await setup();
    const reusable = definePlugin({
      name: 'qq-adapter',
      displayName: 'QQ 机器人',
      reusable: true,
      provides: [platform],
      uses: { provide },
      apply: ({ provide }) => {
        provide.use(platform, {
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
      await recordRoom(host.events.use, id, id);
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
    const { host, server, sm } = await setup();
    const weekly = await sm.createSession({ name: '会话 1' });
    await sm.updateSessionTitle(weekly.id, 'Weekly Report');
    await recordRoom(host.events.use, 'onebot:10000:group:20001', '读书会');
    await recordRoom(host.events.use, 'onebot:10000:group:20002', '跑团');
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
    const { host, server, sm } = await setup();
    const root = await sm.createSession({ name: '根' }, { createdFrom: 'webui' });
    const child = await sm.createChildSession(root.id, { name: '子' });
    const grandchild = await sm.createChildSession(child.id, { name: '孙' });
    await recordRoom(host.events.use, 'onebot:10000:group:1', '群');
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
    // 没收录的根会话（按 id 兜底建出的空记录）没有场所层，摘要里不给场所；它的子会话同样没有
    const unfiled = await sm.ensureSession('zz-unfiled');
    const underUnfiled = await sm.createChildSession(unfiled.id, { name: '空记录下的子会话' });
    expect((await c.summary(unfiled.id)).place).toBeUndefined();
    const [unfiledChild] = (await c.list({ parentId: unfiled.id })).sessions;
    expect(unfiledChild).toMatchObject({ id: underUnfiled.id });
    expect(unfiledChild.place).toBeUndefined();
    // 子会话的场所与聊天窗口取根会话的
    const [deep] = (await c.list({ parentId: child.id })).sessions;
    expect(deep).toMatchObject({ place: { key: 'workspace:default', kind: 'workspace' } });
    expect(deep.chat).toBeUndefined();
    const [inRoom] = (await c.list({ parentId: 'onebot:10000:group:1' })).sessions;
    expect(inRoom).toMatchObject({
      chat: { type: 'group', multiParty: true },
      place: { key: 'onebot:group:1', kind: 'window', name: '群' },
    });
    expect((await c.fail('sessions/list', { parentId: 'session-nope' })).data?.code).toBe('not-found');
  });
});

describe('watch 增量', () => {
  it('建档、改名、子会话增删与删除各推一条增量，带最新的分组；没 watch 的连接收不到，连接关闭后不再推送', async () => {
    const { host, server, sm } = await setup();
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

    await recordRoom(host.events.use, 'onebot:10000:group:1', '群');
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
  it('create：根会话不写设置；子会话建出来就带着父会话此刻每一项适用于子会话的生效值（写在它自己那一层），之后父会话再改不影响它', async () => {
    const { server, sm } = await setup({
      doc: { sessionConfig: { platforms: { webui: { 'zz-agent': { persona: '<WebUI 人设>' } } } } },
    });
    const c = client(server());
    await c.init();

    const { session: root } = await c.call('session/create', {});
    expect(root.title).toMatch(/^会话 /);
    expect(sm.getSession(root.id)).toMatchObject({ status: 'waiting', createdFrom: 'webui' });
    expect(sm.getSession(root.id)?.metadata).toBeUndefined();
    await c.call('session/config/update', { sessionId: root.id, plugin: 'zz-agent', key: 'iterations', value: 9 });

    const { session: child } = await c.call('session/create', { name: '子', parentId: root.id });
    expect(child).toMatchObject({ title: '子', parentId: root.id, kind: 'task' });
    const row = async (key: string) =>
      (await c.call('session/config/get', { sessionId: child.id })).items.find(r => r.key === key);
    // 入口平台按根会话取（连接的平台 webui）：父会话这一刻的平台档人设、本会话层的迭代与此刻在用的模型都写下了
    expect(await row('persona')).toMatchObject({ value: '<WebUI 人设>', source: 'session' });
    expect(await row('iterations')).toMatchObject({ value: 9, source: 'session' });
    expect(await row('llm')).toMatchObject({ value: NOW_MODEL, source: 'session' });
    await c.call('session/config/update', { sessionId: root.id, plugin: 'zz-agent', key: 'iterations', value: 3 });
    expect(await row('iterations')).toMatchObject({ value: 9, source: 'session' });

    expect((await c.fail('session/create', { parentId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('create：会话设置不在时带 parentId 的回 unsupported、不建子会话；根会话照常建', async () => {
    const { server, sm } = await setup({ settings: false });
    const c = client(server());
    await c.init();
    const { session: root } = await c.call('session/create', {});
    expect((await c.fail('session/create', { name: '子', parentId: root.id })).data?.code).toBe('unsupported');
    expect(sm.getChildren(root.id)).toEqual([]);
  });

  it('create 的创建来源取连接所在审批面的登记名，不取连接自报的客户端名与身份里的平台；子会话不带，按根会话取', async () => {
    const { server, sm } = await setup();
    const c = client(server(), { identity: { platform: 'cli', userId: 'console' }, surface: DETACHED_SURFACE });
    await c.call('initialize', { protocolVersion: SESSION_PROTOCOL_VERSION, client: { name: 'cli', version: '0' } });

    const { session } = await c.call('session/create', { name: '<新会话>' });
    const { session: child } = await c.call('session/create', { name: '<子会话>', parentId: session.id });

    expect(sm.getSession(session.id)?.createdFrom).toBe(DETACHED_SURFACE.name);
    expect(sm.getSession(session.id)?.originPlatform).toBeUndefined();
    expect(sm.getSession(child.id)).not.toHaveProperty('createdFrom');
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
    host.hooks.use.middleware('memory:clear', async (data, next) => {
      if (data.sessionId === a.id) throw new Error('清理失败');
      await next();
    });
    const deleted = await c.call('session/batch', { op: 'delete', ids: [a.id, b.id, bChild.id] });
    expect(deleted.failed).toEqual([{ sessionId: a.id, message: '清理失败' }]);
    expect([b, bChild].map(s => sm.getSession(s.id))).toEqual([undefined, undefined]);
  });
});

describe('会话设置', () => {
  const ROOM = 'onebot:10000:group:1';
  const WINDOW = { scope: 'place', key: 'onebot:group:1' } as const;
  const GROUP = { scope: 'platformType', platform: 'onebot', type: 'group' } as const;
  const find = <R extends { plugin: string; key: string }>(rows: R[], key: string, plugin = 'zz-agent') =>
    rows.find(r => r.plugin === plugin && r.key === key);

  it('config/get：一行一项、(plugin, key) 是身份，同名的项各列一行；field 带 session 声明，函数成员不下发；没设的项带此刻实际在用的值', async () => {
    const { server } = await setup();
    const c = client(server());
    await c.init();
    const { session: s } = await c.call('session/create', { name: 'S' });
    const { items } = await c.call('session/config/get', { sessionId: s.id });

    expect(items.filter(r => r.key === 'scope').map(r => r.plugin)).toEqual(['zz-agent', 'zz-other']);
    expect(new Set(items.map(r => `${r.plugin}/${r.key}`)).size).toBe(items.length);
    const model = find(items, 'llm');
    expect(model?.field.session).toMatchObject({ preference: 'llm', unset: '跟随服务偏好' });
    expect(['validate', 'fromText', 'toText'].filter(name => Object.hasOwn(model?.field ?? {}, name))).toEqual([]);
    expect(model).toMatchObject({ actual: { value: NOW_MODEL, label: '<此刻的模型>' } });
    expect(model).not.toHaveProperty('effective');
    expect(find(items, 'persona')).toMatchObject({ effective: 'default', source: 'default' });
    expect(find(items, 'persona')).not.toHaveProperty('actual');
    // 只能设到场所为止与不适用于 owner 会话的项不列
    expect(items.map(r => r.key)).not.toEqual(expect.arrayContaining(['roomNote']));
    expect(items.map(r => r.key)).not.toEqual(expect.arrayContaining(['language']));
    expect((await c.fail('session/config/get', { sessionId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('config/update：写本会话这一层的一项，回写完之后的行；null 恢复继承；不合字段、没登记、不适用的回参数错误，什么都不改', async () => {
    const { server } = await setup();
    const c = client(server());
    await c.init();
    const { session: s } = await c.call('session/create', { name: 'S' });
    const update = (plugin: string, key: string, value: unknown) =>
      c.call('session/config/update', { sessionId: s.id, plugin, key, value });

    const set = await update('zz-agent', 'persona', '<人设>');
    expect(find(set.items, 'persona')).toMatchObject({ value: '<人设>', effective: '<人设>', source: 'session' });
    expect(set).not.toHaveProperty('unsaved');
    const other = await update('zz-other', 'scope', 'current');
    expect([find(other.items, 'scope')?.effective, find(other.items, 'scope', 'zz-other')?.effective]).toEqual([
      'all',
      'current',
    ]);
    const reset = await update('zz-agent', 'persona', null);
    expect(find(reset.items, 'persona')).toMatchObject({ effective: 'default', source: 'default' });

    for (const [plugin, key, value] of [
      ['zz-agent', 'iterations', 0],
      ['zz-agent', 'bogus', 1],
      ['zz-nope', 'persona', 'x'],
      ['zz-agent', 'roomNote', '<备注>'],
      ['zz-agent', 'language', ['en']],
    ] as const) {
      const err = await c.fail('session/config/update', { sessionId: s.id, plugin, key, value });
      expect(err.code, `${plugin}/${key}`).toBe(RPC_ERROR_CODES.invalidParams);
    }
    expect(find((await c.call('session/config/get', { sessionId: s.id })).items, 'iterations')?.source).toBe('default');
    const missing = await c.fail('session/config/update', { sessionId: s.id, plugin: 'zz-agent', key: 'persona' });
    expect(missing.code).toBe(RPC_ERROR_CODES.invalidParams);
    expect(
      (
        await c.fail('session/config/update', {
          sessionId: 'session-nope',
          plugin: 'zz-agent',
          key: 'persona',
          value: 'x',
        })
      ).data?.code,
    ).toBe('not-found');
  });

  it('按层读写：layers 回可以设的各层（只带层与称呼，窗口另带平台与类型名，不带计数）与层表；一层的行解析到这一层为止；写一层回写完之后的行', async () => {
    const { host, server } = await setup({
      doc: { sessionConfig: { platformTypes: { onebot: { group: { 'zz-agent': { think: 'high' } } } } } },
    });
    await recordRoom(host.events.use, ROOM, '群');
    const c = client(server());
    await c.init();

    const { layers, order } = await c.call('session/config/layers', {});
    expect(order).toEqual(SESSION_LAYERS.map(({ name, label }) => ({ name, label: toSource(label) })));
    expect(layers.map(entry => entry.layer)).toEqual(expect.arrayContaining([{ scope: 'global' }, GROUP, WINDOW]));
    for (const entry of layers)
      expect(Object.keys(entry).filter(key => !['layer', 'label', 'platform', 'type'].includes(key))).toEqual([]);
    expect(layers.find(entry => entry.layer.scope === 'place' && entry.layer.key === WINDOW.key)).toMatchObject({
      platform: 'onebot',
      type: 'group',
    });

    const window = (await c.call('session/config/layer/get', { layer: WINDOW })).items;
    expect(find(window, 'think')).toMatchObject({ effective: 'high', source: 'platformType' });
    const written = await c.call('session/config/layer/update', {
      layer: WINDOW,
      plugin: 'zz-agent',
      key: 'roomNote',
      value: '<群备注>',
    });
    expect(find(written.items, 'roomNote')).toMatchObject({ value: '<群备注>', source: 'place' });
    const room = await c.call('session/config/get', { sessionId: ROOM });
    expect(find(room.items, 'think')).toMatchObject({ effective: 'high', source: 'platformType' });
    expect(room.platform, '房间按出生平台取平台档').toBe('onebot');

    for (const params of [
      { layer: { scope: 'platform', platform: '' }, plugin: 'zz-agent', key: 'persona', value: 'x' },
      {
        layer: { scope: 'platformType', platform: 'onebot', type: '*' },
        plugin: 'zz-agent',
        key: 'persona',
        value: 'x',
      },
      { layer: { scope: 'type', type: 'group' }, plugin: 'zz-agent', key: 'persona', value: 'x' },
      { layer: { scope: 'place', key: 'onebot:group:404' }, plugin: 'zz-agent', key: 'persona', value: 'x' },
      { layer: { scope: 'defaults' }, plugin: 'zz-agent', key: 'persona', value: 'x' },
    ]) {
      expect((await c.fail('session/config/layer/update', params)).code, JSON.stringify(params)).toBe(
        RPC_ERROR_CODES.invalidParams,
      );
    }
    expect(
      (await c.fail('session/config/layer/get', { layer: { scope: 'place', key: 'onebot:group:404' } })).code,
    ).toBe(RPC_ERROR_CODES.invalidParams);
  });

  it('写进宿主文档的几层落盘失败：已在运行态生效，回包带 unsaved（与插件详情保存的回执同一句，拒写与其余失败两句不同）', async () => {
    let failure: Error | undefined;
    const { server, store } = await setup({
      save: async () => {
        if (failure) throw failure;
      },
    });
    const c = client(server());
    await c.init();
    const write = (value: string) =>
      c.call('session/config/layer/update', { layer: { scope: 'global' }, plugin: 'zz-agent', key: 'persona', value });

    expect(await write('<存得下>')).not.toHaveProperty('unsaved');
    failure = new ConfigSaveRefusedError('<配置文件有外部修改>');
    const refused = await write('<拒写>');
    expect(refused.unsaved).toBe(toSource(saveFailureText(failure, 'reload')));
    expect(find(refused.items, 'persona')).toMatchObject({ value: '<拒写>', source: 'global' });
    failure = new Error('<磁盘满了>');
    const failed = await write('<写失败>');
    expect(failed.unsaved).toBe(toSource(saveFailureText(failure, 'reload')));
    expect(failed.unsaved).not.toBe(refused.unsaved);
    expect(store.getPluginConfig('zz-agent').persona).toBe('<写失败>');
  });

  it('overrides：一个实例在全局之外写过的各处按项分组，会话带标题，子会话逐个列出、带父会话', async () => {
    const { server, sm } = await setup({
      doc: { sessionConfig: { platforms: { onebot: { 'zz-agent': { iterations: 20 } } } } },
    });
    const root = await sm.createSession({ name: '根' });
    await sm.updateSessionTitle(root.id, '<根会话>');
    const c = client(server());
    await c.init();
    await c.call('session/config/update', { sessionId: root.id, plugin: 'zz-agent', key: 'iterations', value: 40 });
    const { session: child } = await c.call('session/create', { name: '<子会话>', parentId: root.id });

    const { items } = await c.call('session/config/overrides', { plugin: 'zz-agent' });
    const iterations = items.find(item => item.key === 'iterations');
    expect(iterations?.entries).toEqual([
      { target: { layer: { scope: 'platform', platform: 'onebot' } }, value: 20 },
      { target: { sessionId: root.id, title: '<根会话>' }, value: 40 },
      {
        target: { sessionId: child.id, title: '<子会话>', parent: { sessionId: root.id, title: '<根会话>' } },
        value: 40,
      },
    ]);
    expect(new Set(items.map(item => item.key)).size).toBe(items.length);
    expect((await c.call('session/config/overrides', { plugin: 'zz-other' })).items).toEqual(
      expect.arrayContaining([{ key: 'scope', entries: [expect.objectContaining({ value: 'platform' })] }]),
    );
  });

  it('owner 会话按入口平台选平台档：接管会话 id 的适配器，没有时取连接的平台；子会话按根会话取，不读 metadata 里的 platform', async () => {
    const { server, sm } = await setup({
      doc: {
        sessionConfig: {
          platforms: { webui: { 'zz-agent': { persona: '<webui>' } }, cli: { 'zz-agent': { persona: '<cli>' } } },
        },
      },
    });
    const persona = async (conn: ReturnType<typeof client>, sessionId: string) =>
      find((await conn.call('session/config/get', { sessionId })).items, 'persona')?.effective;
    const c = client(server());
    await c.init();
    const cli = client(server(), {
      identity: { platform: 'cli', userId: 'console' },
      surface: { ...DETACHED_SURFACE, name: 'cli' },
    });
    await cli.init();

    const s = await sm.createSession({ name: 'S' });
    expect([await persona(c, s.id), await persona(cli, s.id)]).toEqual(['<webui>', '<cli>']);
    // 回包另带按哪个平台取的平台档，界面的来源文字照它写
    expect((await c.call('session/config/get', { sessionId: s.id })).platform).toBe('webui');
    expect((await cli.call('session/config/get', { sessionId: s.id })).platform).toBe('cli');
    await sm.ensureSession('cli-default');
    expect(await persona(c, 'cli-default')).toBe('<cli>');
    expect((await c.call('session/config/get', { sessionId: 'cli-default' })).platform).toBe('cli');
    const child = await sm.createChildSession(s.id, { name: '子', metadata: { platform: 'cli' } });
    expect(await persona(c, child.id)).toBe('<webui>');
    const underCli = await sm.createChildSession('cli-default', { name: '子' });
    expect(await persona(c, underCli.id)).toBe('<cli>');
  });

  it('会话设置不在：session/config/* 六个方法都回 unsupported', async () => {
    const { server, sm } = await setup({ settings: false });
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();
    const layer = { scope: 'global' } as const;
    for (const [method, params] of [
      ['session/config/get', { sessionId: s.id }],
      ['session/config/update', { sessionId: s.id, plugin: 'zz-agent', key: 'persona', value: 'x' }],
      ['session/config/layers', {}],
      ['session/config/layer/get', { layer }],
      ['session/config/layer/update', { layer, plugin: 'zz-agent', key: 'persona', value: 'x' }],
      ['session/config/overrides', { plugin: 'zz-agent' }],
    ] satisfies Array<[SessionMethod, object]>) {
      expect((await c.fail(method, params)).data?.code, method).toBe('unsupported');
    }
  });

  it('功能位 settings 随会话设置服务上下线：握手带它，停用与启用各推一次 features/changed', async () => {
    const { app, server } = await setup();
    const c = client(server());
    expect((await c.init()).features.settings).toBe(true);
    await app.plugins.disable(sessionSettingsPlugin.name);
    await vi.waitFor(() => expect(c.notifications('features/changed').map(p => p.features.settings)).toEqual([false]));
    await app.plugins.enable(sessionSettingsPlugin.name);
    await vi.waitFor(() =>
      expect(c.notifications('features/changed').map(p => p.features.settings)).toEqual([false, true]),
    );
  });

  it('session-settings:changed 与 host-config:changed 各推一次 session/config/changed，每条连接都收到', async () => {
    const { host, server } = await setup();
    const a = client(server());
    const b = client(server());
    await a.init();
    await b.init();
    await host.events.use.emit('session-settings:changed');
    expect([a, b].map(conn => conn.notifications('session/config/changed'))).toEqual([[{}], [{}]]);
    await host.events.use.emit('host-config:changed', { document: true });
    expect([a, b].map(conn => conn.notifications('session/config/changed'))).toEqual([
      [{}, {}],
      [{}, {}],
    ]);
  });
});
