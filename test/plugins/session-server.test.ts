import { afterEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { persona } from '../../packages/api-persona/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  ErrorFrameSchema,
  RPC_ERROR_CODES,
  SESSION_PROTOCOL_VERSION,
  sessionProtocol,
} from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { MockLLMService } from '../fixtures/mock-llm.js';
import { memoryStorage } from '../fixtures/paper.js';
import { CLIENT, client, type Frame } from '../fixtures/session-client.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 会话服务（plugin-session-server）的前一半：握手；会话列表的分区、分组、状态、排序、搜索与分页；
// watch 的增量推送；建、改名、归档、删除与批量；会话配置的生效值与继承来源；「我的」区的已读。
// 全部经 sessionProtocol.connect 直接收发帧，不走网络；收到的每个结果与通知都先过协议 schema。
// ════════════════════════════════════════════════════════════

const SEEN_URI = 'pluginData:/session-server/seen.json';
const MAJOR = Number(SESSION_PROTOCOL_VERSION.split('.')[0]);

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
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

/** 时钟只假 Date：会话的创建、改动与开口时间取 Date.now()，定时器照常走 */
function clock(at: number): void {
  vi.setSystemTime(at);
}

/**
 * stored：会话表里预置的记录；files：插件数据（已读记录）；profiles：session-manager 的平台档；
 * unreadable：这些 URI 存在但读不出来（权限错，不是不存在）
 */
async function setup({
  stored = {},
  files = new Map<string, string | Uint8Array>(),
  profiles = [],
  unreadable = [],
  unwritable = false,
}: {
  stored?: Record<string, Record<string, unknown>>;
  files?: Map<string, string | Uint8Array>;
  profiles?: Record<string, unknown>[];
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
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, sessionManager, sessionProtocol });
  host.provide(memory, fakeMemory(stored) as never);
  const disk = memoryStorage(files);
  const readFile = disk.readFile.bind(disk);
  disk.readFile = (async (uri: string, encoding?: BufferEncoding) => {
    if (unreadable.includes(uri)) throw Object.assign(new Error(`EACCES: ${uri}`), { code: 'EACCES' });
    return readFile(uri, encoding);
  }) as typeof disk.readFile;
  if (unwritable) disk.writeFile = async () => Promise.reject(new Error('ENOSPC: 磁盘已满'));
  host.provide(storage, disk);
  host.provide(persona, { listModels: async () => ['aalis', 'aalis-webui'] } as never);
  host.provide(llm, new MockLLMService());
  host.provide(tools, { getGroups: () => [{ name: 'system', label: '系统工具', pluginName: 'x' }] } as never);
  await app.plugin(adapterPlugin('onebot-a', { platform: 'onebot', canHandle: id => /^onebot:1000[01]:/.test(id) }));
  await app.plugin(adapterPlugin('onebot-b', { platform: 'onebot', canHandle: id => id.startsWith('onebot:20000:') }));
  await app.plugin(adapterPlugin('cli', { platform: 'cli', canHandle: id => id === 'cli-default' }));
  await app.plugin(sessionManagerPlugin, { platformProfiles: profiles });
  await app.plugin(sessionServerPlugin, {});
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, sessionServerPlugin.name]) {
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

  return { app, host, sm, files, warns, turn, server: () => host.sessionProtocol.require() };
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
    });
    expect(c.disconnects).toEqual([]);
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
    expect(own).toMatchObject({ title: '周报', kind: 'room', audience: 'owner' });
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
    const { server, sm } = await setup({
      profiles: [{ platform: 'onebot', audience: 'group', paperEnabled: true }],
    });
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
    expect(rooms.sessions.map(s => [s.id, s.instance, s.paper])).toEqual([
      ['onebot:30000:group:4', undefined, true],
      ['onebot:10001:group:2', 'onebot-a', true],
      ['onebot:20000:private:3', 'onebot-b', false],
      ['onebot:10000:private:5', 'onebot-a', false],
      ['onebot:10000:group:1', 'onebot-a', true],
    ]);
    const groups = [
      { platform: 'onebot', instance: 'onebot-a', rooms: 3, accounts: 2 },
      { platform: 'onebot', instance: 'onebot-b', rooms: 1, accounts: 1 },
      { platform: 'onebot', rooms: 1, accounts: 1 },
    ];
    expect(rooms.groups).toEqual(groups);
    const searched = await c.list({ query: 'group:2' });
    expect(searched.sessions.map(s => s.id)).toEqual(['onebot:10001:group:2']);
    expect(searched.groups).toEqual(groups);
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
    expect(changes().at(-1)?.groups).toEqual([{ platform: 'onebot', instance: 'onebot-a', rooms: 1, accounts: 1 }]);

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
  it('create：根会话不复制平台档，按继承链生效；子会话复制父会话的生效配置，房间专属键除外', async () => {
    const { server, sm } = await setup({ profiles: [{ platform: 'webui', persona: 'aalis-webui' }] });
    const c = client(server());
    await c.init();

    const { session: root } = await c.call('session/create', {});
    expect(root.title).toMatch(/^会话 /);
    expect(sm.getSession(root.id)).toMatchObject({ status: 'waiting', createdBy: 'user' });
    expect(sm.getSession(root.id)?.config).toEqual({});
    const view = await c.call('session/config/get', { sessionId: root.id });
    expect(view.effective.persona).toBe('aalis-webui');
    expect(view.inheritance.sources.persona).toBe('platform');

    await sm.updateSession(root.id, { config: { think: true, paperEnabled: true } });
    const { session: child } = await c.call('session/create', { name: '子', parentId: root.id });
    expect(child).toMatchObject({ title: '子', parentId: root.id, kind: 'task' });
    expect(sm.getSession(child.id)?.config).toEqual({ persona: 'aalis-webui', think: true });

    expect((await c.fail('session/create', { parentId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('rename、archive（连同子会话）与 delete；会话不存在回 not-found', async () => {
    const { server, sm } = await setup();
    const root = await sm.createSession({ name: '根' });
    const child = await sm.createChildSession(root.id, { name: '子' });
    const c = client(server());
    await c.init();

    await c.call('session/rename', { sessionId: root.id, title: '新名字' });
    expect((await c.summary(root.id)).title).toBe('新名字');

    await c.call('session/archive', { sessionId: root.id });
    expect(sm.getSession(root.id)?.status).toBe('archived');
    expect(sm.getSession(child.id)?.status).toBe('archived');
    expect((await c.summary(root.id)).archived).toBe(true);

    await c.call('session/delete', { sessionId: root.id });
    expect(sm.getSession(root.id)).toBeUndefined();
    expect(sm.getSession(child.id)).toBeUndefined();

    for (const method of ['session/rename', 'session/archive', 'session/delete']) {
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

describe('会话配置', () => {
  it('config/get：生效值、继承来源与可选项一次给出；房间按出生平台与受众选档，owner 面会话按连接的入口平台', async () => {
    const { server, sm } = await setup({
      profiles: [
        { platform: 'webui', persona: 'aalis-webui' },
        { platform: 'cli', persona: 'aalis-cli' },
        { platform: 'onebot', enabledToolGroups: ['onebot'] },
        { platform: 'onebot', audience: 'group', paperEnabled: true },
      ],
      stored: {
        'session-old': {
          id: 'session-old',
          name: '旧',
          children: [],
          status: 'completed',
          config: { persona: null, think: true },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    await sm.ensureSession('onebot:10000:group:1', { name: '群' });
    const c = client(server());
    await c.init();

    const old = await c.call('session/config/get', { sessionId: 'session-old' });
    expect(old.config).toEqual({ think: true });
    expect(old.effective).toEqual({ persona: 'aalis-webui', think: true });
    expect(old.inheritance).toMatchObject({ platform: 'webui', sources: { persona: 'platform' } });
    expect(old.options).toEqual({
      personas: ['aalis', 'aalis-webui'],
      models: [
        {
          provider: '@aalis/test-fixture-mock-llm',
          model: 'mock-model',
          capabilities: ['chat', 'tool_calling', 'streaming'],
        },
      ],
      toolGroups: [{ name: 'system', label: '系统工具' }],
    });

    const room = await c.call('session/config/get', { sessionId: 'onebot:10000:group:1' });
    expect(room.inheritance).toMatchObject({
      platform: 'onebot',
      audience: 'group',
      sources: { enabledToolGroups: 'platform', paperEnabled: 'audience' },
    });
    expect(room.effective).toMatchObject({ enabledToolGroups: ['onebot'], paperEnabled: true });

    const cli = client(server(), { identity: { platform: 'cli', userId: 'console' }, surface: 'cli' });
    await cli.init();
    expect((await cli.call('session/config/get', { sessionId: 'session-old' })).effective.persona).toBe('aalis-cli');

    // 入口平台先看会话记下的平台，再看接管会话 id 的适配器，最后才取连接的平台
    const recorded = await sm.createSession({ name: '子任务建的', metadata: { platform: 'cli' } });
    expect((await c.call('session/config/get', { sessionId: recorded.id })).inheritance.platform).toBe('cli');
    await sm.ensureSession('cli-default');
    expect((await c.call('session/config/get', { sessionId: 'cli-default' })).effective.persona).toBe('aalis-cli');
    expect((await c.fail('session/config/get', { sessionId: 'session-nope' })).data?.code).toBe('not-found');
  });

  it('config/update：null 恢复继承，其余写成会话自己的覆盖，回最新的生效值与来源；类型不对回参数错误', async () => {
    const { server, sm } = await setup({ profiles: [{ platform: 'webui', persona: 'aalis-webui' }] });
    const s = await sm.createSession({ name: 'S' });
    const c = client(server());
    await c.init();

    const set = await c.call('session/config/update', {
      sessionId: s.id,
      patch: { persona: 'aalis', memoryRecallScope: 'session' },
    });
    expect(set.config).toEqual({ persona: 'aalis', memoryRecallScope: 'session' });
    expect(set.effective.persona).toBe('aalis');

    const reset = await c.call('session/config/update', { sessionId: s.id, patch: { persona: null } });
    expect(reset.config).toEqual({ memoryRecallScope: 'session' });
    // 会话档案里不留 null：删掉的项与没写过同样是 undefined
    expect(sm.getSession(s.id)?.config).toEqual({ memoryRecallScope: 'session' });
    expect(reset.effective.persona).toBe('aalis-webui');
    expect(sm.resolveConfig(s.id, 'webui').persona).toBe('aalis-webui');

    expect((await c.fail('session/config/update', { sessionId: s.id, patch: { think: 'yes' } })).code).toBe(
      RPC_ERROR_CODES.invalidParams,
    );
    expect((await c.fail('session/config/update', { sessionId: 'session-nope', patch: {} })).data?.code).toBe(
      'not-found',
    );
  });
});
