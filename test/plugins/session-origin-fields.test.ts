import { afterEach, describe, expect, it } from 'vitest';
import { chatScopeOf } from '../../packages/api-gateway/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import {
  type PlatformAdapter,
  platform,
  resolveSessionType,
  type SessionTypeDecl,
  sessionTypesOf,
} from '../../packages/api-platform/src/index.js';
import {
  type RoomClass,
  roomClass,
  rootSessionOf,
  type SessionInfo,
  type SessionManagerService,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { ONEBOT_TYPES } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 会话的来源字段：出生平台与聊天窗口（平台类型名、多方标记、机器人账号、目标）在 IM 房间建档时按入站消息记下，
// 之后不变，运行时不从会话 id 推；子会话不带，按根会话取。平台类型由适配器声明（类型名加一对一还是多方），
// 不声明的平台整个算一个一对一类型 private，声明里没有的类型名按多方。创建来源只经会话管理的专用参数写，
// 绑定与当前目录只经专用方法写。房间类别只读这些字段：受众里有谁，判不出的一律 internal。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';
const CHANNEL = 'onebot:10000:channel:40001:50001';

/** 另一个平台：类型名自定，结果与 OneBot 相同 */
const FORUM_TYPES: SessionTypeDecl[] = [
  { name: 'thread', multiParty: true },
  { name: 'dm', multiParty: false },
];

const adapter = (name: string, sessionTypes?: SessionTypeDecl[]): PlatformAdapter => ({
  adapterName: name,
  platform: name,
  ...(sessionTypes ? { sessionTypes } : {}),
  getConnections: () => [],
  sendMessage: async () => {},
});

/** 以插件实例提供一个平台适配器 */
const adapterPlugin = (name: string, sessionTypes?: SessionTypeDecl[]) =>
  definePlugin({
    name: `zz-adapter-${name}`,
    provides: [platform],
    uses: { provide },
    apply: ({ provide }) => {
      provide(platform, adapter(name, sessionTypes));
    },
  });

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 会话管理加 onebot、forum 与不声明类型的 plain 三个平台；stored 与 places 预置会话表与场所记录 */
async function setup(
  stored: Record<string, Record<string, unknown>> = {},
  places: Record<string, Record<string, unknown>> = {},
) {
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
  const host = app.bind({ provide, events, sessionManager });
  const mem = fakeMemory(stored, places);
  host.provide(memory, mem as never);
  await app.plugin(adapterPlugin('onebot', ONEBOT_TYPES));
  await app.plugin(adapterPlugin('forum', FORUM_TYPES));
  await app.plugin(adapterPlugin('plain'));
  await app.plugin(sessionManagerPlugin);
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.require();
  const inbound = (msg: Omit<IncomingMessage, 'content'>) =>
    host.events.emit('inbound:message', { content: '<占位>', ...msg });
  return { app, sm, mem, inbound, warns };
}

describe('平台类型的声明', () => {
  it('sessionTypesOf：声明了的原样给出；没写或空列表的平台整个算一个一对一类型 private', () => {
    expect(sessionTypesOf(adapter('onebot', ONEBOT_TYPES))).toEqual(ONEBOT_TYPES);
    expect(sessionTypesOf(adapter('plain'))).toEqual([{ name: 'private', multiParty: false }]);
    expect(sessionTypesOf(adapter('plain', []))).toEqual([{ name: 'private', multiParty: false }]);
  });

  it('resolveSessionType：不带类型名按 private、一对一；声明里有的按声明；声明里没有的按多方并标出', () => {
    expect(resolveSessionType(ONEBOT_TYPES, undefined)).toEqual({
      name: 'private',
      multiParty: false,
      undeclared: false,
    });
    expect(resolveSessionType(ONEBOT_TYPES, 'group')).toEqual({ name: 'group', multiParty: true, undeclared: false });
    expect(resolveSessionType(ONEBOT_TYPES, 'private')).toEqual({
      name: 'private',
      multiParty: false,
      undeclared: false,
    });
    expect(resolveSessionType(FORUM_TYPES, 'dm')).toEqual({ name: 'dm', multiParty: false, undeclared: false });
    expect(resolveSessionType(FORUM_TYPES, 'private'), '声明里没有 private').toEqual({
      name: 'private',
      multiParty: true,
      undeclared: true,
    });
    expect(resolveSessionType(sessionTypesOf(adapter('plain')), 'group')).toEqual({
      name: 'group',
      multiParty: true,
      undeclared: true,
    });
  });

  it('resolveSessionType：声明条目的多方标记不是 false（漏写、写成别的值）按多方', () => {
    const malformed = [{ name: 'group' }, { name: 'room', multiParty: 'no' }] as unknown as SessionTypeDecl[];
    expect(resolveSessionType(malformed, 'group')).toEqual({ name: 'group', multiParty: true, undeclared: false });
    expect(resolveSessionType(malformed, 'room').multiParty).toBe(true);
  });
});

describe('chatScopeOf：入站消息所在的聊天窗口', () => {
  it('OneBot 群：group、多方、目标是群号；私聊：private、一对一、目标是对端；channel：多方', () => {
    expect(
      chatScopeOf({ platform: 'onebot', sessionType: 'group', groupId: '20001', userId: '30001' }, ONEBOT_TYPES),
    ).toEqual({ platform: 'onebot', type: 'group', multiParty: true, undeclared: false, targetId: '20001' });
    expect(chatScopeOf({ platform: 'onebot', sessionType: 'private', userId: '30001' }, ONEBOT_TYPES)).toEqual({
      platform: 'onebot',
      type: 'private',
      multiParty: false,
      undeclared: false,
      targetId: '30001',
    });
    expect(chatScopeOf({ platform: 'onebot', sessionType: 'channel', userId: '30001' }, ONEBOT_TYPES)).toMatchObject({
      type: 'channel',
      multiParty: true,
    });
  });

  it('OneBot 的临时会话：私聊消息上也带群号，目标仍是对端账号', () => {
    expect(
      chatScopeOf({ platform: 'onebot', sessionType: 'private', groupId: '20001', userId: '30001' }, ONEBOT_TYPES),
    ).toMatchObject({ type: 'private', multiParty: false, targetId: '30001' });
  });

  it('消息不带类型名：private、一对一，目标是发送者；取不到目标为空串', () => {
    expect(chatScopeOf({ platform: 'webui', userId: 'console' }, sessionTypesOf(undefined))).toEqual({
      platform: 'webui',
      type: 'private',
      multiParty: false,
      undeclared: false,
      targetId: 'console',
    });
    expect(chatScopeOf({ platform: 'onebot', sessionType: 'group' }, ONEBOT_TYPES).targetId).toBe('');
  });
});

describe('IM 房间建档时记下来源字段', () => {
  it('OneBot 群记 group、多方，私聊记 private、一对一，channel 记多方；机器人账号与目标取自消息', async () => {
    const { sm, inbound } = await setup();

    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', userId: '30009' });
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001', selfId: '10000' });
    await inbound({ sessionId: CHANNEL, platform: 'onebot', sessionType: 'channel', userId: '30002' });

    expect(sm.getSession(GROUP)).toMatchObject({
      originPlatform: 'onebot',
      originChat: { type: 'group', multiParty: true, targetId: '20001' },
    });
    expect(sm.getSession(GROUP)?.originChat?.selfId, '消息上没有机器人账号就不记').toBeUndefined();
    expect(sm.getSession(PRIVATE)).toMatchObject({
      originPlatform: 'onebot',
      originChat: { type: 'private', multiParty: false, selfId: '10000', targetId: '30001' },
    });
    expect(sm.getSession(CHANNEL)?.originChat).toMatchObject({ type: 'channel', multiParty: true });
  });

  it('消息不带类型名记 private、一对一；不声明类型的平台同样记 private、一对一', async () => {
    const { sm, inbound, warns } = await setup();

    await inbound({ sessionId: 'onebot:10000:private:30003', platform: 'onebot', userId: '30003' });
    await inbound({ sessionId: 'plain-room', platform: 'plain', userId: '<对端>' });

    expect(sm.getSession('onebot:10000:private:30003')?.originChat).toEqual({
      type: 'private',
      multiParty: false,
      targetId: '30003',
    });
    expect(sm.getSession('plain-room')).toMatchObject({
      originPlatform: 'plain',
      originChat: { type: 'private', multiParty: false, targetId: '<对端>' },
    });
    expect(warns).toEqual([]);
  });

  it('带了声明里没有的类型名：记多方，每个平台与类型名告警一次', async () => {
    const { sm, inbound, warns } = await setup();

    await inbound({ sessionId: 'plain:a', platform: 'plain', sessionType: 'group', groupId: '<群一>' });
    await inbound({ sessionId: 'plain:b', platform: 'plain', sessionType: 'group', groupId: '<群二>' });
    await inbound({ sessionId: 'forum:c', platform: 'forum', sessionType: 'group', groupId: '<群三>' });

    expect(sm.getSession('plain:a')?.originChat).toEqual({ type: 'group', multiParty: true, targetId: '<群一>' });
    expect(sm.getSession('forum:c')?.originChat).toMatchObject({ type: 'group', multiParty: true });
    const undeclared = warns.filter(w => w.includes('没有声明'));
    expect(undeclared).toHaveLength(2);
    expect(undeclared[0]).toContain('plain');
    expect(undeclared[1]).toContain('forum');
  });

  it('入站之前已建档的会话（WebUI 新建、终端预建）不记来源字段', async () => {
    const { sm, inbound } = await setup();
    const webui = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
    await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });

    await inbound({ sessionId: webui.id, platform: 'webui', userId: 'console' });
    await inbound({ sessionId: 'cli-default', platform: 'cli', userId: 'console' });

    for (const id of [webui.id, 'cli-default']) {
      expect(sm.getSession(id)?.originPlatform, id).toBeUndefined();
      expect(sm.getSession(id)?.originChat, id).toBeUndefined();
    }
  });

  it('已记下的来源字段之后不变：同一窗口后来的消息带了别的类型名也不改', async () => {
    const { sm, inbound } = await setup();
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001' });

    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'group', groupId: '20001' });

    expect(sm.getSession(PRIVATE)?.originChat).toEqual({ type: 'private', multiParty: false, targetId: '30001' });
  });
});

describe('来源字段只存不推', () => {
  const RECORD = { name: '<群名>', children: [], status: 'completed', config: {}, createdAt: 1, updatedAt: 1 };

  it('读表时缺来源字段的房间记录按没有出生平台：不从会话 id 推', async () => {
    const { sm } = await setup({ [GROUP]: { ...RECORD, id: GROUP } });

    expect(sm.getSession(GROUP)?.originPlatform).toBeUndefined();
    expect(sm.getSession(GROUP)?.originChat).toBeUndefined();
  });

  it('按 id 建档（/session.set、子任务兜底建档）不带来源字段；子会话不带，按根会话取', async () => {
    const { sm, inbound } = await setup();
    await sm.ensureSession(PRIVATE, { name: '<显示名>' });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    const child = await sm.createChildSession(GROUP, { name: '<子任务>' });
    const fallback = await sm.createChildSession('onebot:10000:group:20002', { name: '<子任务>' });

    expect(sm.getSession(PRIVATE)?.originPlatform).toBeUndefined();
    expect(sm.getSession('onebot:10000:group:20002')?.originChat).toBeUndefined();
    expect(child.originPlatform).toBeUndefined();
    expect(child.originChat).toBeUndefined();
    const lookup = (id: string) => sm.getSession(id);
    expect(rootSessionOf(child, lookup)?.originChat).toMatchObject({ type: 'group', targetId: '20001' });
    expect(rootSessionOf(fallback, lookup)?.id).toBe('onebot:10000:group:20002');
  });

  it('来源字段、创建来源、所属工作区、绑定与当前目录随会话表落盘，重启后仍在', async () => {
    const first = await setup();
    await first.inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', selfId: '1' });
    const { workspace } = first.sm.addWorkspace('/x');
    const work = await first.sm.createSession(
      { name: '<工作>' },
      { createdFrom: 'webui', workspace: workspace.id, work: { root: '/x' } },
    );
    const child = await first.sm.createChildSession(work.id, { name: '<子任务>' });
    await first.sm.setCurrentDir(child.id, '/x/sub');
    await first.sm.setExtraRoots(work.id, ['/y']);
    await first.sm.addWorktree(child.id, '/x-wt');
    await first.app.stop();

    const second = await setup(Object.fromEntries(first.mem.meta), Object.fromEntries(first.mem.places));
    expect(second.sm.getSession(GROUP)).toMatchObject({
      originPlatform: 'onebot',
      originChat: { type: 'group', multiParty: true, selfId: '1', targetId: '20001' },
    });
    expect(second.sm.getSession(work.id)).toMatchObject({
      createdFrom: 'webui',
      workspace: workspace.id,
      work: { root: '/x', extraRoots: ['/y'], worktrees: ['/x-wt'] },
    });
    expect(second.sm.placeOf(work.id)).toEqual({ kind: 'workspace', key: `workspace:${workspace.id}` });
    expect(second.sm.getSession(child.id)?.currentDir).toBe('/x/sub');
  });

  it('读表时来源字段、所属工作区、绑定与当前目录的类型不对：去掉这些字段照常载入', async () => {
    const { sm, warns } = await setup({
      [GROUP]: { ...RECORD, id: GROUP, originPlatform: 'onebot', originChat: { type: 'group', multiParty: 'yes' } },
      'session-a': { ...RECORD, id: 'session-a', createdFrom: 3, workspace: 4, work: { root: '/x' }, currentDir: 5 },
    });

    expect(sm.getSession(GROUP)?.originChat).toBeUndefined();
    expect(sm.getSession(GROUP)?.originPlatform).toBe('onebot');
    expect(sm.getSession('session-a')).not.toHaveProperty('createdFrom');
    expect(sm.getSession('session-a')).not.toHaveProperty('workspace');
    expect(sm.getSession('session-a')).not.toHaveProperty('work');
    expect(sm.getSession('session-a')).not.toHaveProperty('currentDir');
    expect(warns.join('\n')).toContain('originChat');
  });
});

describe('roomClass：按会话字段判受众里有谁', () => {
  /** owner 在 onebot 与 forum 上各有一个身份，账号都是 30001 */
  const isOwner = (p: string, u: string) => (p === 'onebot' || p === 'forum') && u === '30001';
  const base = { children: [], status: 'waiting', config: {}, createdAt: 1, updatedAt: 1 } as const;
  const session = (id: string, fields: Partial<SessionInfo> = {}): SessionInfo =>
    ({ ...base, id, name: id, kind: 'owner', ...fields }) as SessionInfo;
  const im = (platform: string, type: string, multiParty: boolean, targetId: string) =>
    ({ originPlatform: platform, originChat: { type, multiParty, targetId } }) as const;

  const table = new Map<string, SessionInfo>(
    [
      session('mcp-server'),
      session('workflow::<编排>'),
      session(GROUP, { kind: 'room' }), // 定时任务的目标、兜底建档的会话：按 id 建档，没有来源字段
      session('session-webui', { createdFrom: 'webui' }),
      session('cli-default', { createdFrom: 'cli' }),
      session('session-work', { createdFrom: 'webui', work: { root: '/x', extraRoots: [], worktrees: [] } }),
      session('session-bare-work', { work: { root: '/x', extraRoots: [], worktrees: [] } }),
      session('onebot:1:group:2', im('onebot', 'group', true, '2')),
      session('onebot:1:group:30001', im('onebot', 'group', true, '30001')),
      session('onebot:1:private:30001', im('onebot', 'private', false, '30001')),
      session('onebot:1:private:30002', im('onebot', 'private', false, '30002')),
      session('forum:thread:30001', im('forum', 'thread', true, '30001')),
      session('forum:dm:30001', im('forum', 'dm', false, '30001')),
      session('forum:dm:30002', im('forum', 'dm', false, '30002')),
      session('qq:private:30001', im('qq', 'private', false, '30001')),
      session('onebot:1:private:30001::a', { parentId: 'onebot:1:private:30001' }),
      session('onebot:1:group:2::a', { parentId: 'onebot:1:group:2' }),
      session('session-webui::a', { parentId: 'session-webui' }),
      session('session-webui::a::b', { parentId: 'session-webui::a' }),
      session('orphan::a', { parentId: 'orphan' }),
    ].map(s => [s.id, s]),
  );
  const classOf = (id: string) => roomClass(table.get(id), x => table.get(x), isOwner);

  it.each<[string, RoomClass]>([
    ['不在会话表里的 id', 'internal'],
    ['mcp-server', 'internal'],
    ['workflow::<编排>', 'internal'],
    [GROUP, 'internal'],
    ['session-webui', 'owner-only'],
    ['cli-default', 'owner-only'],
    ['session-work', 'owner-only'],
    ['session-bare-work', 'internal'],
    ['onebot:1:group:2', 'room'],
    ['onebot:1:group:30001', 'room'],
    ['onebot:1:private:30001', 'owner-only'],
    ['onebot:1:private:30002', 'room'],
    ['forum:thread:30001', 'room'],
    ['forum:dm:30001', 'owner-only'],
    ['forum:dm:30002', 'room'],
    ['qq:private:30001', 'room'],
    ['onebot:1:private:30001::a', 'owner-only'],
    ['onebot:1:group:2::a', 'room'],
    ['session-webui::a', 'owner-only'],
    ['session-webui::a::b', 'owner-only'],
    ['orphan::a', 'internal'],
  ])('%s → %s', (id, expected) => {
    expect(classOf(id)).toBe(expected);
  });

  it('父会话链成环（坏数据：指向自己、两条互指）：上溯到走过的会话即停，没有根会话，房间类别为 internal', () => {
    const loops = new Map<string, SessionInfo>(
      [
        session('self-loop', { parentId: 'self-loop' }),
        session('loop-a', { parentId: 'loop-b' }),
        session('loop-b', { parentId: 'loop-a' }),
        session('loop-a::c', { parentId: 'loop-a' }),
      ].map(s => [s.id, s]),
    );
    let steps = 0;
    const lookup = (id: string) => {
      if (++steps > 100) throw new Error('上溯没有停');
      return loops.get(id);
    };
    for (const id of loops.keys()) {
      steps = 0;
      expect(rootSessionOf(loops.get(id), lookup), id).toBeUndefined();
      steps = 0;
      expect(roomClass(loops.get(id), lookup, isOwner), id).toBe('internal');
    }
  });
});

describe('创建来源与来源字段不收调用方传值', () => {
  const smuggled = {
    createdFrom: 'webui',
    originPlatform: 'onebot',
    originChat: { type: 'private', multiParty: false, targetId: '30001' },
    workspace: 'default',
    work: { root: '/', extraRoots: [], worktrees: [] },
    currentDir: '/',
  };
  const fields = (info: SessionInfo | undefined) => ({
    createdFrom: info?.createdFrom,
    originPlatform: info?.originPlatform,
    originChat: info?.originChat,
    workspace: info?.workspace,
    work: info?.work,
    currentDir: info?.currentDir,
  });

  it('createSession、ensureSession、createChildSession 在会话字段里带上的一律丢弃', async () => {
    const { sm } = await setup();

    const root = await sm.createSession({ name: '<新会话>', ...smuggled } as never);
    const ensured = await sm.ensureSession('<固定 id>', { name: '<会话>', ...smuggled } as never);
    const child = await sm.createChildSession(root.id, { name: '<子任务>', ...smuggled } as never);

    for (const info of [root, ensured, child]) expect(fields(info)).toEqual({});
  });

  it('专用参数只给根会话：建子会话时带上被拒，不建档', async () => {
    const { sm } = await setup();
    const root = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });

    await expect(sm.createSession({ name: '<子>', parentId: root.id }, { createdFrom: 'webui' })).rejects.toThrow();
    expect(sm.getChildren(root.id)).toEqual([]);
  });

  it('专用参数：createSession 与 ensureSession 建档时写创建来源；ensureSession 碰上已有记录不改', async () => {
    const { sm } = await setup();

    const created = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
    const ensured = await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });
    const again = await sm.ensureSession('cli-default', { name: '<改名>' }, { createdFrom: 'webui' });

    expect(created.createdFrom).toBe('webui');
    expect(ensured.createdFrom).toBe('cli');
    expect(again).toMatchObject({ name: '<改名>', createdFrom: 'cli' });
  });
});

describe('项目会话的绑定与当前目录', () => {
  /** 登记 /x 为项目工作区，在它里面建一个会话 */
  async function project(sm: SessionManagerService) {
    const { workspace } = sm.addWorkspace('/x');
    return sm.createSession(
      { name: '<工作>' },
      { createdFrom: 'webui', workspace: workspace.id, work: { root: '/x' } },
    );
  }

  it('建项目会话：绑定目录、空的附加目录与 worktree，不写当前目录；子会话取父会话此刻的当前目录', async () => {
    const { sm } = await setup();

    const work = await project(sm);
    expect(work).toMatchObject({ work: { root: '/x', extraRoots: [], worktrees: [] } });
    expect(work.currentDir).toBeUndefined();
    await sm.setCurrentDir(work.id, '/x/a');
    const child = await sm.createChildSession(work.id, { name: '<子任务>' });
    const plain = await sm.createSession({ name: '<聊天>' }, { createdFrom: 'webui' });
    const plainChild = await sm.createChildSession(plain.id, { name: '<子任务>' });

    expect(sm.getSession(work.id)?.currentDir).toBe('/x/a');
    expect(child.currentDir).toBe('/x/a');
    expect(child.work, '绑定只在根会话上').toBeUndefined();
    expect(child.workspace, '所属工作区只在根会话上').toBeUndefined();
    expect(plain.work).toBeUndefined();
    expect(plain.currentDir).toBeUndefined();
    expect(plainChild.currentDir).toBeUndefined();
  });

  it('子会话改当前目录不影响父会话；父会话增删附加目录后子会话实时看到；子会话里记的 worktree 记进根会话', async () => {
    const { sm } = await setup();
    const work = await project(sm);
    await sm.setCurrentDir(work.id, '/x');
    const child = await sm.createChildSession(work.id, { name: '<子任务>' });
    const grandchild = await sm.createChildSession(child.id, { name: '<孙任务>' });
    const lookup = (id: string) => sm.getSession(id);

    await sm.setCurrentDir(child.id, '/x/sub');
    expect(sm.getSession(work.id)?.currentDir).toBe('/x');
    expect(sm.getSession(child.id)?.currentDir).toBe('/x/sub');

    await sm.setExtraRoots(work.id, ['/y', '/z']);
    expect(rootSessionOf(sm.getSession(grandchild.id), lookup)?.work?.extraRoots).toEqual(['/y', '/z']);
    await sm.setExtraRoots(child.id, ['/z']);
    expect(sm.getSession(work.id)?.work?.extraRoots, '子会话增删的也是根会话的').toEqual(['/z']);

    await sm.addWorktree(grandchild.id, '/x-wt');
    await sm.addWorktree(work.id, '/x-wt');
    expect(sm.getSession(work.id)?.work?.worktrees).toEqual(['/x-wt']);
    expect(sm.getSession(grandchild.id)?.work).toBeUndefined();
  });

  it('改动发 session:updated；当前目录对全部会话开放，附加目录与 worktree 不在项目会话树里时被拒；会话不存在时被拒；子会话不能带绑定', async () => {
    const { app, sm } = await setup();
    const updated: string[] = [];
    app.bind({ events }).events.on('session:updated', s => void updated.push(s.id));
    const work = await project(sm);
    const plain = await sm.createSession({ name: '<聊天>' }, { createdFrom: 'webui' });

    await sm.setCurrentDir(work.id, '/x/a');
    await sm.setExtraRoots(work.id, ['/y']);
    await sm.setCurrentDir(plain.id, '/tmp');
    expect(updated).toEqual([work.id, work.id, plain.id]);
    expect(sm.getSession(plain.id)?.currentDir).toBe('/tmp');

    await expect(sm.setExtraRoots(plain.id, ['/y'])).rejects.toThrow();
    await expect(sm.addWorktree(plain.id, '/x-wt')).rejects.toThrow();
    await expect(sm.setCurrentDir('<不存在>', '/x')).rejects.toThrow();
    await expect(
      sm.createSession({ name: '<子>', parentId: work.id }, { createdFrom: 'webui', work: { root: '/x' } }),
    ).rejects.toThrow();
    expect(sm.getChildren(work.id)).toEqual([]);
  });
});
