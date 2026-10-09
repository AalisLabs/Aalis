import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import {
  placePaperId,
  type SessionInfo,
  type SessionPlace,
  sessionManager,
} from '../../packages/api-session-manager/src/index.js';
import { type App, events, type Logger, provide } from '../../packages/core/src/index.js';
import authorityPlugin from '../../packages/plugin-authority/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { adapterPlugin, ONEBOT_TYPES, PERSONA, startSessionManager, THINK } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// 场所：每个会话恰好一个，子会话取根会话的。有聊天窗口的根会话是窗口（键 `平台:类型:目标`，不含机器人账号），
// 一对一而对端是 owner 的（owner 的 IM 私聊）是默认工作区；其余按根会话记下的工作区，没记的是默认工作区。
// 场所记录存在记忆后端里，带显示名与这个场所的设置，换会话照样生效；工作区由 owner 登记，以随机的固定编号标识，
// 取消登记只删记录与它的设置，原属会话归默认工作区。每个场所一张白纸，白纸 id 由场所键算出。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const GROUP_B = 'onebot:20000:group:20001';
const WINDOW = 'onebot:group:20001';
const OWNER_PRIVATE = 'onebot:10000:private:30001';
const OTHER_PRIVATE = 'onebot:10000:private:30002';
const DEFAULT: SessionPlace = { kind: 'workspace', key: 'workspace:default' };
const OWNERS = [{ platform: 'onebot', userId: '30001' }];

const TMP = mkdtempSync(join(tmpdir(), 'zz-slice2-places-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
/** 在临时目录下建一个文件夹，返回它的路径 */
const folder = (...parts: string[]) => {
  const dir = join(TMP, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(options: Partial<Parameters<typeof startSessionManager>[0]> = {}) {
  const started = await startSessionManager({
    settings: [PERSONA, THINK],
    adapters: [{ platform: 'onebot', sessionTypes: ONEBOT_TYPES }],
    ...options,
  });
  apps.push(started.app);
  return started;
}

const record = (id: string, fields: Partial<SessionInfo> = {}) => ({
  id,
  name: id,
  children: [],
  status: 'waiting',
  config: {},
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});
const room = (id: string, type: string, multiParty: boolean, targetId: string, selfId: string) =>
  record(id, { originPlatform: 'onebot', originChat: { type, multiParty, selfId, targetId } });
const workspace = (id: string, root: string) => ({
  key: `workspace:${id}`,
  kind: 'workspace',
  name: id,
  root,
  config: {},
  createdAt: 1,
  updatedAt: 1,
});

describe('placeOf', () => {
  const stored = {
    [GROUP]: room(GROUP, 'group', true, '20001', '10000'),
    [GROUP_B]: room(GROUP_B, 'group', true, '20001', '20000'),
    [OWNER_PRIVATE]: room(OWNER_PRIVATE, 'private', false, '30001', '10000'),
    [OTHER_PRIVATE]: room(OTHER_PRIVATE, 'private', false, '30002', '10000'),
    'session-webui': record('session-webui', { createdFrom: 'webui' }),
    'cli-default': record('cli-default', { createdFrom: 'cli' }),
    'session-proj': record('session-proj', {
      createdFrom: 'webui',
      workspace: 'w1',
      work: { root: '/zz-proj', extraRoots: [], worktrees: [] },
    }),
    'session-wt': record('session-wt', {
      createdFrom: 'webui',
      workspace: 'w1',
      work: { root: '/zz-proj-wt', extraRoots: [], worktrees: [] },
    }),
    'session-gone': record('session-gone', { createdFrom: 'webui', workspace: 'gone' }),
    'mcp-server': record('mcp-server'),
    'workflow::<编排>': record('workflow::<编排>'),
    'scheduler::<任务>': record('scheduler::<任务>'),
    'onebot:10000:group:20009': record('onebot:10000:group:20009'),
    [`${GROUP}::a`]: record(`${GROUP}::a`, { parentId: GROUP }),
    [`${OWNER_PRIVATE}::a`]: record(`${OWNER_PRIVATE}::a`, { parentId: OWNER_PRIVATE }),
    'session-proj::a': record('session-proj::a', { parentId: 'session-proj' }),
    'session-proj::a::b': record('session-proj::a::b', { parentId: 'session-proj::a' }),
  };
  const places = { 'workspace:w1': workspace('w1', '/zz-proj') };

  it.each<[string, string, SessionPlace]>([
    ['群', GROUP, { kind: 'window', key: WINDOW }],
    ['同一个群里另一个机器人账号的会话', GROUP_B, { kind: 'window', key: WINDOW }],
    ['owner 的 IM 私聊', OWNER_PRIVATE, DEFAULT],
    ['别人的私聊', OTHER_PRIVATE, { kind: 'window', key: 'onebot:private:30002' }],
    ['WebUI 会话', 'session-webui', DEFAULT],
    ['终端会话', 'cli-default', DEFAULT],
    ['项目会话', 'session-proj', { kind: 'workspace', key: 'workspace:w1' }],
    ['绑定在这个工作区仓库的 worktree 上的会话', 'session-wt', { kind: 'workspace', key: 'workspace:w1' }],
    ['mcp-server', 'mcp-server', DEFAULT],
    ['编排', 'workflow::<编排>', DEFAULT],
    ['定时任务', 'scheduler::<任务>', DEFAULT],
    ['按 id 兜底建档的房间', 'onebot:10000:group:20009', DEFAULT],
    ['群的子会话', `${GROUP}::a`, { kind: 'window', key: WINDOW }],
    ['owner 私聊的子会话', `${OWNER_PRIVATE}::a`, DEFAULT],
    ['项目会话的孙会话', 'session-proj::a::b', { kind: 'workspace', key: 'workspace:w1' }],
    ['不在会话表里的 id', 'onebot:10000:group:<没有>', DEFAULT],
  ])('%s', async (_name, id, expected) => {
    const { sm } = await setup({ stored, places, owners: OWNERS });
    expect(sm.placeOf(id)).toEqual(expected);
  });

  it('记下的工作区没有记录（坏数据）：按默认工作区，日志点名', async () => {
    const { sm, warns } = await setup({ stored, places, owners: OWNERS });
    expect(sm.placeOf('session-gone')).toEqual(DEFAULT);
    expect(warns.filter(w => w.includes('session-gone') && w.includes('gone'))).toHaveLength(1);
  });

  it('有出生平台的坏数据（聊天窗口读表时去掉了、目标为空）按窗口算，缺的段按空串拼：取不到给默认工作区设的值，日志点名一次', async () => {
    const { sm, warns } = await setup({
      stored: {
        'zz-no-chat': record('zz-no-chat', { originPlatform: 'onebot', originChat: { type: 'private' } as never }),
        'zz-no-target': room('zz-no-target', 'private', false, '', '10000'),
      },
      owners: OWNERS,
    });
    await sm.updateLayer({ scope: 'place', key: 'workspace:default' }, { think: 'high' });

    expect(sm.placeOf('zz-no-chat')).toEqual({ kind: 'window', key: 'onebot::' });
    expect(sm.placeOf('zz-no-target')).toEqual({ kind: 'window', key: 'onebot:private:' });
    for (const id of ['zz-no-chat', 'zz-no-target']) {
      expect(sm.resolveConfig(id).think, id).toBeUndefined();
      expect(
        warns.filter(w => w.includes(id) && w.includes('按窗口')),
        id,
      ).toHaveLength(1);
    }
  });

  it('没装 authority：owner 的 IM 私聊按窗口算', async () => {
    const { sm } = await setup({ stored, places });
    expect(sm.placeOf(OWNER_PRIVATE)).toEqual({ kind: 'window', key: 'onebot:private:30001' });
  });

  it('按 id 兜底建档的房间：第一条原生入站补记来源字段之后变为窗口', async () => {
    const { sm, inbound } = await setup({ stored, places, owners: OWNERS });
    const id = 'onebot:10000:group:20009';
    await inbound({ sessionId: id, platform: 'onebot', sessionType: 'group', groupId: '20009', groupName: '<群>' });
    await expect.poll(() => sm.placeOf(id)).toEqual({ kind: 'window', key: 'onebot:group:20009' });
    expect(sm.getPlace('onebot:group:20009')).toMatchObject({ kind: 'window', name: '<群>' });
  });

  it('类型名不合段写法（适配器发出带冒号或空的类型名）：场所键不二义，场所层的视图照样在平台档之上', async () => {
    const { sm, inbound } = await setup({
      layers: { platforms: { zz: { persona: '<平台>' } } },
      adapters: [{ platform: 'zz' }],
    });
    await inbound({ sessionId: 'zz:1', platform: 'zz', sessionType: 'a:b', groupId: 'c' });
    await inbound({ sessionId: 'zz:2', platform: 'zz', sessionType: 'a', groupId: 'b:c' });
    await inbound({ sessionId: 'zz:3', platform: 'zz', sessionType: '', groupId: 'z' });

    const keys = ['zz:1', 'zz:2', 'zz:3'].map(id => sm.placeOf(id).key);
    expect(new Set(keys).size).toBe(3);
    expect(placePaperId(keys[0])).not.toBe(placePaperId(keys[1]));
    expect(sm.resolveLayer({ scope: 'place', key: keys[2] }).sources).toEqual({ persona: 'platform' });
    expect(sm.resolveInheritance('zz:3').sources).toEqual({ persona: 'platform' });
  });
});

describe('场所记录', () => {
  it('激活后默认工作区的记录在，随会话表落盘', async () => {
    const { app, sm, mem } = await setup();
    expect(sm.getPlace('workspace:default')).toEqual({ ...DEFAULT, name: '默认工作区' });
    await app.stop();
    expect(mem.places.get('workspace:default')).toMatchObject({ kind: 'workspace', name: '默认工作区', config: {} });
  });

  it('房间建档时建窗口的记录：显示名取群名或对方昵称，改名后跟着更新；owner 的 IM 私聊不建窗口记录', async () => {
    const { sm, inbound } = await setup({ owners: OWNERS });
    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupId: '20001',
      groupName: '<群名>',
    });
    await inbound({
      sessionId: OTHER_PRIVATE,
      platform: 'onebot',
      sessionType: 'private',
      userId: '30002',
      nickname: '<乙>',
    });
    await inbound({
      sessionId: OWNER_PRIVATE,
      platform: 'onebot',
      sessionType: 'private',
      userId: '30001',
      nickname: '<我>',
    });

    expect(sm.getPlace(WINDOW)).toEqual({ kind: 'window', key: WINDOW, name: '<群名>' });
    expect(sm.getPlace('onebot:private:30002')).toMatchObject({ name: '<乙>' });
    expect(sm.getPlace('onebot:private:30001')).toBeUndefined();
    expect(sm.getPlace('workspace:default')?.name).toBe('默认工作区');

    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupId: '20001',
      groupName: '<新群名>',
    });
    expect(sm.getPlace(WINDOW)?.name).toBe('<新群名>');
  });

  it('窗口改名：同一窗口里各机器人账号的会话各发一次 session:updated，好让摘要里场所的显示名跟着变', async () => {
    const { host, inbound } = await setup();
    const message = { platform: 'onebot', sessionType: 'group', groupId: '20001', groupName: '<群名>' };
    await inbound({ sessionId: GROUP, ...message });
    await inbound({ sessionId: GROUP_B, ...message });
    const updated: string[] = [];
    host.events.on('session:updated', session => void updated.push(session.id));

    await inbound({ sessionId: GROUP, ...message, groupName: '<新群名>' });
    await expect.poll(() => updated.sort()).toEqual([GROUP, GROUP_B].sort());
  });

  it('删掉房间会话，同一个窗口里别的机器人账号再来消息建出的新会话照样取到场所的设置', async () => {
    const { sm, inbound } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    await sm.updateLayer({ scope: 'place', key: WINDOW }, { persona: '<场所人设>' });
    await sm.deleteSession(GROUP);

    await inbound({ sessionId: GROUP_B, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    expect(sm.getLayer({ scope: 'place', key: WINDOW })).toEqual({ persona: '<场所人设>' });
    expect(sm.resolveConfig(GROUP_B).persona).toBe('<场所人设>');
  });

  it('给默认工作区设的值，WebUI 的新会话与 owner 的 IM 私聊都取到，群取不到', async () => {
    const { sm, inbound } = await setup({ owners: OWNERS });
    await sm.updateLayer({ scope: 'place', key: 'workspace:default' }, { think: 'high' });
    const mine = await sm.createSession({}, { createdFrom: 'webui' });
    await inbound({ sessionId: OWNER_PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001' });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });

    expect(sm.resolveConfig(mine.id, 'webui').think).toBe('high');
    expect(sm.resolveConfig(OWNER_PRIVATE).think).toBe('high');
    expect(sm.resolveConfig(GROUP).think).toBeUndefined();
  });

  it('记忆后端换胜者：新后端的场所记录整体替换，旧后端的未落盘改动写回旧后端', async () => {
    const fallback = fakeMemory();
    const preferred = fakeMemory(
      {},
      { [WINDOW]: { key: WINDOW, kind: 'window', name: '<群名>', config: {}, createdAt: 1, updatedAt: 1 } },
    );
    const { app } = hostedApp({});
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, sessionManager });
    host.provide(memory, fallback as never, { priority: -100 });
    await app.plugin(sessionManagerPlugin);
    await app.plugins.idle();
    const sm = () => host.sessionManager.require();
    sm().addWorkspace(folder('switch'));

    host.provide(memory, preferred as never, { priority: 10 });
    await expect.poll(() => sm().getPlace(WINDOW)?.name).toBe('<群名>');

    expect(sm().getPlace('workspace:default'), '新后端里没有的默认工作区记录照样补上').toBeDefined();
    expect(
      sm()
        .listWorkspaces()
        .map(w => w.id),
    ).toEqual(['default']);
    expect([...fallback.places.keys()].sort()).toHaveLength(2);
    await app.stop();
    expect([...preferred.places.keys()].sort()).toEqual([WINDOW, 'workspace:default']);
  });
});

describe('工作区', () => {
  it('添加一个目录得到项目工作区：编号与路径无关，显示名取文件夹名；再添加同一个目录返回已有的；两个同名文件夹是两个工作区', async () => {
    const { sm } = await setup();
    const a = folder('a', 'proj');
    const b = folder('b', 'proj');

    const first = sm.addWorkspace(a);
    expect(first).toMatchObject({ existed: false, workspace: { name: 'proj', root: a } });
    expect(first.workspace.id).not.toContain('proj');
    expect(sm.addWorkspace(a)).toEqual({ existed: true, workspace: first.workspace });
    const second = sm.addWorkspace(b);
    expect(second.workspace.id).not.toBe(first.workspace.id);
    expect(second.workspace.name).toBe('proj');

    expect(sm.listWorkspaces()).toEqual([
      { id: 'default', name: '默认工作区' },
      { id: first.workspace.id, name: 'proj', root: a },
      { id: second.workspace.id, name: 'proj', root: b },
    ]);
    expect(sm.getPlace(`workspace:${first.workspace.id}`)).toEqual({
      kind: 'workspace',
      key: `workspace:${first.workspace.id}`,
      name: 'proj',
    });
  });

  it('在项目工作区里建会话：记下所属工作区与绑定，不写当前目录；没有记录的工作区、缺绑定、默认工作区带绑定都被拒', async () => {
    const { sm } = await setup();
    const dir = folder('create');
    const { workspace: added } = sm.addWorkspace(dir);

    const work = await sm.createSession({}, { createdFrom: 'webui', workspace: added.id, work: { root: dir } });
    expect(work).toMatchObject({ workspace: added.id, work: { root: dir, extraRoots: [], worktrees: [] } });
    expect(work.currentDir).toBeUndefined();
    expect(sm.placeOf(work.id)).toEqual({ kind: 'workspace', key: `workspace:${added.id}` });

    const inDefault = await sm.createSession({}, { createdFrom: 'webui', workspace: 'default' });
    expect(inDefault.workspace, '默认工作区不记').toBeUndefined();
    expect(sm.placeOf(inDefault.id)).toEqual(DEFAULT);

    const count = sm.listSessions().length;
    for (const creation of [
      { createdFrom: 'webui', workspace: '<没有>' },
      { createdFrom: 'webui', workspace: added.id },
      { createdFrom: 'webui', work: { root: dir } },
      { createdFrom: 'webui', workspace: 'default', work: { root: dir } },
    ]) {
      await expect(sm.createSession({}, creation), JSON.stringify(creation)).rejects.toThrow();
    }
    expect(sm.listSessions()).toHaveLength(count);
  });

  it('取消登记：只删记录与场所设置，不动文件；原属会话树归默认工作区，绑定与当前目录清掉，没有坏数据告警；默认工作区不能取消登记', async () => {
    const { app, sm, warns } = await setup();
    const dir = folder('remove');
    const { workspace: added } = sm.addWorkspace(dir);
    const key = `workspace:${added.id}`;
    await sm.updateLayer({ scope: 'place', key }, { think: 'high' });
    const work = await sm.createSession({}, { createdFrom: 'webui', workspace: added.id, work: { root: dir } });
    await sm.setCurrentDir(work.id, join(dir, 'sub'));
    const child = await sm.createChildSession(work.id, {});
    await sm.setCurrentDir(child.id, join(dir, 'sub2'));
    const other = await sm.createSession({}, { createdFrom: 'webui' });
    await sm.setCurrentDir(other.id, TMP);
    const updated: string[] = [];
    app.bind({ events }).events.on('session:updated', s => void updated.push(s.id));

    await sm.removeWorkspace(added.id);

    expect(sm.getPlace(key)).toBeUndefined();
    expect(sm.listWorkspaces().map(w => w.id)).toEqual(['default']);
    expect(statSync(dir).isDirectory(), '目录还在').toBe(true);
    for (const id of [work.id, child.id]) {
      const session = sm.getSession(id);
      expect(session?.workspace, id).toBeUndefined();
      expect(session?.work, id).toBeUndefined();
      expect(session?.currentDir, id).toBeUndefined();
      expect(sm.placeOf(id), id).toEqual(DEFAULT);
    }
    expect(sm.resolveConfig(work.id).think).toBeUndefined();
    expect(sm.getSession(other.id)?.currentDir, '别的会话不动').toBe(TMP);
    expect(updated.sort()).toEqual([work.id, child.id].sort());
    expect(warns.filter(w => w.includes(added.id))).toEqual([]);

    await expect(sm.removeWorkspace('default')).rejects.toThrow();
    await expect(sm.removeWorkspace(added.id)).rejects.toThrow();
    await expect(sm.updateLayer({ scope: 'place', key }, { think: 'off' })).rejects.toThrow();

    const again = sm.addWorkspace(dir);
    expect(again.existed).toBe(false);
    expect(again.workspace.id, '再添加得到新编号').not.toBe(added.id);
  });

  it('取消登记的工作区从记忆后端删掉，重启后不再列出', async () => {
    const first = await setup({ places: { 'workspace:w9': workspace('w9', folder('persisted')) } });
    await first.sm.removeWorkspace('w9');
    await first.app.stop();
    expect(first.mem.places.has('workspace:w9')).toBe(false);

    const second = await setup({ places: Object.fromEntries(first.mem.places) });
    expect(second.sm.listWorkspaces().map(w => w.id)).toEqual(['default']);
  });
});

describe('白纸 id', () => {
  it('对同一个场所键稳定，不同键不同；同一个群里两个机器人账号的会话用同一张白纸', async () => {
    expect(placePaperId(WINDOW)).toBe(placePaperId(WINDOW));
    expect(placePaperId(WINDOW)).toMatch(/^p:[A-Za-z0-9_-]+$/);
    expect(placePaperId(WINDOW)).not.toBe(placePaperId('onebot:group:20002'));
    expect(placePaperId('workspace:default')).not.toBe(placePaperId('workspace:defaulu'));

    const { sm, inbound } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001', selfId: '10000' });
    await inbound({ sessionId: GROUP_B, platform: 'onebot', sessionType: 'group', groupId: '20001', selfId: '20000' });
    expect(placePaperId(sm.placeOf(GROUP).key)).toBe(placePaperId(sm.placeOf(GROUP_B).key));
  });
});

describe('当前目录', () => {
  it('不带绑定的会话也能记当前目录，重启后仍在；会话不存在时被拒', async () => {
    const first = await setup();
    const mine = await first.sm.createSession({}, { createdFrom: 'webui' });
    await first.inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    await first.sm.setCurrentDir(mine.id, TMP);
    await first.sm.setCurrentDir(GROUP, TMP);
    await expect(first.sm.setCurrentDir('<不存在>', TMP)).rejects.toThrow();
    await first.app.stop();

    const second = await setup({ stored: Object.fromEntries(first.mem.meta) });
    expect(second.sm.getSession(mine.id)?.currentDir).toBe(TMP);
    expect(second.sm.getSession(GROUP)?.currentDir).toBe(TMP);
  });
});

describe('与 authority 的可选环', () => {
  function recordingLogger(lines: string[]): Logger {
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
      child: () => logger,
    };
    return logger;
  }

  it.each([
    ['会话管理先登记', [sessionManagerPlugin, authorityPlugin]],
    ['authority 先登记', [authorityPlugin, sessionManagerPlugin]],
  ] as const)('%s：两边都激活，owner 判定随 authority 启停，关停不报依赖成环', async (_name, order) => {
    const lines: string[] = [];
    const { app } = hostedApp({ owners: OWNERS }, { logger: recordingLogger(lines) });
    apps.push(app);
    await registerHubs(app);
    const host = app.bind({ provide, events, sessionManager });
    host.provide(memory, fakeMemory() as never);
    await app.plugin(adapterPlugin('zz-onebot', { platform: 'onebot', sessionTypes: ONEBOT_TYPES }));
    for (const plugin of order) await app.plugin(plugin);
    await app.plugins.idle();
    for (const plugin of order) expect(app.plugins.getPlugin(plugin.name)?.state, plugin.name).toBe('active');

    const sm = () => host.sessionManager.require();
    await host.events.emit('inbound:message', {
      content: '<占位>',
      sessionId: OWNER_PRIVATE,
      platform: 'onebot',
      sessionType: 'private',
      userId: '30001',
    });
    expect(sm().placeOf(OWNER_PRIVATE)).toEqual(DEFAULT);

    await app.plugins.disable(authorityPlugin.name);
    expect(sm().placeOf(OWNER_PRIVATE)).toEqual({ kind: 'window', key: 'onebot:private:30001' });
    await app.plugins.enable(authorityPlugin.name);
    await app.plugins.idle();
    expect(sm().placeOf(OWNER_PRIVATE)).toEqual(DEFAULT);

    await app.stop();
    expect(lines.filter(line => line.includes('依赖成环'))).toEqual([]);
  });
});
