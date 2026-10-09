import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContextMap } from '../../packages/api-hooks/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, type Logger, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';
import { ONEBOT_TYPES, PERSONA, settingsPlugin } from '../fixtures/session-settings.js';

// ════════════════════════════════════════════════════════════
// IM 房间收录：会话表里还没有记录、不是子任务的会话，首条真人入站（不带 source）即按这条消息登记，记下出生平台与
// 聊天窗口（来源字段的细节见 session-origin-fields.test.ts），名字只采信出生平台自己的入站；
// 带 source 的内部注入（工作流、好友申请的合成通知、空闲开话题等）不登记。
// 状态在回合真正开始的 agent:input:before 翻 active（已归档的不翻），同一个中间件在 finally 里收口，
// 后面的中间件拦下或抛错时房间也不停在「进行中」。收口按这一轮的结局：出错为 error，其余为 completed；
// 结局为 replied 时记下她最近开口的时间。房间建档时记下接管它的平台适配器实例，会话列表按它分组；
// 没记下的（建档时没有适配器认领、读表读进来的旧房间）下一次有消息进来时补记。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

/** 入站收录不等建档与补记完成，让它落定 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

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

/**
 * instances：另装两个 onebot 适配器实例（按 id 里的账号认领）和一个只认 cli-default 的 cli 适配器；
 * stored：会话表里预置的记录
 */
async function setup(
  adapters: Partial<PlatformAdapter>[] = [],
  { instances = false, stored = {} }: { instances?: boolean; stored?: Record<string, Record<string, unknown>> } = {},
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
  const host = app.bind({ provide, events, hooks, sessionManager });
  const mem = fakeMemory(stored);
  host.provide(memory, mem as never);
  for (const adapter of adapters) host.provide(platform, adapter as never);
  if (instances) {
    await app.plugin(
      adapterPlugin('onebot-a', { platform: 'onebot', canHandle: id => id.startsWith('onebot:10000:') }),
    );
    await app.plugin(
      adapterPlugin('onebot-b', { platform: 'onebot', canHandle: id => id.startsWith('onebot:20000:') }),
    );
    await app.plugin(adapterPlugin('cli', { platform: 'cli', canHandle: id => id === 'cli-default' }));
  }
  await app.plugin(sessionManagerPlugin);
  // 用例经 ensureSession 落人设（/session.set 的落点），人设这一项要有人登记
  await app.plugin(settingsPlugin('test-settings', [PERSONA]));
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.require();

  const inbound = (msg: Omit<IncomingMessage, 'content'>) =>
    host.events.emit('inbound:message', { content: '<占位>', ...msg });

  // 回合 id 每轮不同，与 agent 一致
  let turns = 0;

  /** 按 agent 的顺序跑一轮：agent:input:before 的默认动作里跑完回合，最后发 agent:turn:after */
  const turn = async (sessionId: string, during?: () => Promise<void> | void, outcome: Outcome = 'replied') => {
    const message: IncomingMessage = { content: '<占位>', sessionId, platform: 'onebot' };
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

  /** 开一轮、回合体由用例控制（不发 agent:turn:after：收口只看输入中间件的 finally） */
  const running = (sessionId: string, body: () => Promise<void>) =>
    host.hooks.run(
      'agent:input:before',
      { message: { content: '<占位>', sessionId, platform: 'onebot' }, turnId: `t${++turns}`, metadata: {} },
      body,
    );

  return { app, sm, host, mem, inbound, turn, running, warns };
}

describe('IM 房间按首条真人入站登记', () => {
  it('群消息建档：名字取群名，room，记下出生平台与聊天窗口，状态 waiting，没有创建来源；私聊以对方昵称为名', async () => {
    const { sm, inbound } = await setup();

    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupId: '20001',
      groupName: '<群名>',
      nickname: '<甲>',
    });
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', nickname: '<乙>' });

    const group = sm.getSession(GROUP);
    expect(group).toMatchObject({
      name: '<群名>',
      kind: 'room',
      originPlatform: 'onebot',
      originChat: { type: 'group', multiParty: true, targetId: '20001' },
      status: 'waiting',
    });
    expect(group?.createdFrom).toBeUndefined();
    expect(sm.getSession(PRIVATE)).toMatchObject({ name: '<乙>', kind: 'room', status: 'waiting' });
  });

  it('没有执行过 /session.set、也没开过子任务的群同样登记', async () => {
    const { sm, inbound } = await setup();
    expect(sm.getSession(GROUP)).toBeUndefined();

    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });

    expect(sm.getSession(GROUP), '首条真人入站就该登记').toBeDefined();
  });

  it('子任务 id 的入站不建房间档，也不顺手登记它的父房间', async () => {
    const { sm, inbound } = await setup();

    await inbound({ sessionId: `${GROUP}::abcd1234`, platform: 'onebot', groupName: '<群名>' });
    expect(sm.getSession(`${GROUP}::abcd1234`), '子任务 id 不该被当成房间登记').toBeUndefined();
    expect(sm.getSession(GROUP), '也不顺手登记它的父房间').toBeUndefined();
  });

  it('带 source 的内部注入不登记：工作流发往群、好友申请的合成通知、空闲开话题', async () => {
    const { sm, inbound } = await setup();
    const IDLE_GROUP = 'onebot:10000:group:20002';

    await inbound({ sessionId: GROUP, platform: 'onebot', source: 'workflow:<工作流>:<节点>' });
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', source: 'onebot-request' });
    await inbound({ sessionId: IDLE_GROUP, platform: 'onebot', source: 'idle-trigger' });

    expect([GROUP, PRIVATE, IDLE_GROUP].map(id => sm.getSession(id))).toEqual([undefined, undefined, undefined]);
  });
});

describe('一个会话 id 由不止一个平台认领：判不出是谁的窗口，不收录也不补记', () => {
  /** 终端配置的会话 id 配成了 OneBot 的群 id */
  const CLI_ON_GROUP: Partial<PlatformAdapter> = { platform: 'cli', canHandle: id => id === GROUP };
  const ONEBOT: Partial<PlatformAdapter> = {
    platform: 'onebot',
    sessionTypes: ONEBOT_TYPES,
    canHandle: id => id.startsWith('onebot:10000:'),
  };
  const fromCli = { sessionId: GROUP, platform: 'cli', userId: 'console' };
  const fromGroup = {
    sessionId: GROUP,
    platform: 'onebot',
    sessionType: 'group',
    groupId: '20001',
    groupName: '<群名>',
  };

  it.each([
    ['终端先登记', [CLI_ON_GROUP, ONEBOT]],
    ['OneBot 先登记', [ONEBOT, CLI_ON_GROUP]],
  ])('%s：终端与 OneBot 的入站都不收录，兜底建档的空记录也不补记；每个 id 告警一次', async (_, adapters) => {
    const { sm, inbound, warns } = await setup(adapters);

    await inbound(fromCli);
    await inbound(fromGroup);
    expect(sm.getSession(GROUP), '不收录').toBeUndefined();
    await sm.createChildSession(GROUP, { name: '<子任务>' });
    await inbound(fromCli);
    await inbound(fromGroup);
    await settle();

    expect(sm.getSession(GROUP)?.originPlatform, '不补记').toBeUndefined();
    const ambiguous = warns.filter(w => w.includes(GROUP));
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toContain('「cli」');
    expect(ambiguous[0]).toContain('「onebot」');
  });

  it('只有 OneBot 认领：照常收录，不告警；同一平台的两个实例都认领仍算一个平台', async () => {
    const { app, sm, inbound, warns } = await setup([ONEBOT]);
    await app.plugin(adapterPlugin('onebot-2', ONEBOT));
    await app.plugins.idle();

    await inbound(fromGroup);

    expect(sm.getSession(GROUP)).toMatchObject({ originPlatform: 'onebot', originChat: { type: 'group' } });
    expect(warns).toEqual([]);
  });
});

describe('房间记下接管它的适配器实例：建档时解析，没记下的下一次有消息进来时补记', () => {
  /** canHandle 等到 release 才回答，用来卡住解析；asked 记下被问过的会话 */
  function gatedAdapter() {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const asked: string[] = [];
    const adapter: Partial<PlatformAdapter> = {
      platform: 'onebot',
      canHandle: async id => {
        asked.push(id);
        await gate;
        return id.startsWith('onebot:10000:');
      },
    };
    return { adapter, release, asked };
  }

  /** canHandle 照 claiming 回答：起初不认领，模拟适配器还没装好、连接还没上来 */
  function laterAdapter() {
    const state = { claiming: false };
    const adapter: Partial<PlatformAdapter> = { platform: 'onebot', canHandle: () => state.claiming };
    return { adapter, state };
  }

  /** 读表读进来的旧房间：有来源字段，没有 originInstance */
  const STORED_ROOM: SessionInfo = {
    id: GROUP,
    name: '<群名>',
    children: [],
    status: 'completed',
    config: {},
    createdAt: 1,
    updatedAt: 1,
    kind: 'room',
    originPlatform: 'onebot',
    originChat: { type: 'group', multiParty: true, targetId: '20001' },
  };
  const stored = (info: SessionInfo) => ({ [info.id]: info as unknown as Record<string, unknown> });

  it('原生入站建出的房间各记各的实例；按 id 建档的（子任务兜底、/session 落配置）在补记来源字段之后才记；认不出的、owner 面会话与子任务不记', async () => {
    const { sm, inbound } = await setup([], { instances: true });
    const B_GROUP = 'onebot:20000:group:20001';
    const B_PRIVATE = 'onebot:20000:private:30001';
    const UNKNOWN = 'onebot:30000:group:20001';
    const instanceOf = (id: string) => sm.getSession(id)?.originInstance;

    await sm.ensureSession(B_PRIVATE, { config: { persona: '<人设>' } }); // /session.set 的落点
    const child = await sm.createChildSession(B_GROUP, { name: '<子任务>' });
    await sm.ensureSession(UNKNOWN, {});
    expect([B_PRIVATE, B_GROUP, UNKNOWN].map(instanceOf), '没有来源字段，还不是房间').toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    await inbound({ sessionId: B_PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001' });
    await inbound({ sessionId: B_GROUP, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    await inbound({ sessionId: UNKNOWN, platform: 'onebot', sessionType: 'group', groupId: '20001' });
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    // 终端的会话在入站之前建档（plugin-cli）；cli 适配器认领它，但它不是房间
    await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });
    await inbound({ sessionId: 'cli-default', platform: 'cli', userId: 'console' });
    await settle();
    expect(instanceOf(B_PRIVATE)).toBe('onebot-b');
    expect(instanceOf(B_GROUP)).toBe('onebot-b');
    expect(instanceOf(child.id), '子任务挂在父会话下').toBeUndefined();
    expect(instanceOf(UNKNOWN), '没有适配器认领，也就不补记').toBeUndefined();
    expect(instanceOf(GROUP)).toBe('onebot-a');
    expect(sm.getSession('cli-default')).toBeDefined();
    expect(instanceOf('cli-default'), 'owner 面会话不分组').toBeUndefined();
  });

  it('收录之前问认领的期间别处按 id 建了档：只建一次档，问完按这条记录补记来源字段，实例也记下', async () => {
    const gated = gatedAdapter();
    const { sm, host, inbound } = await setup([gated.adapter]);
    const created: string[] = [];
    host.events.on('session:created', session => void created.push(session.id));

    const arriving = inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupName: '<群名>' });
    expect(gated.asked, '认领已经在问').toContain(GROUP);
    await sm.ensureSession(GROUP, { config: { persona: '<人设>' } });
    gated.release();
    await arriving;
    await settle();

    expect(created).toEqual([GROUP]);
    expect(sm.getSession(GROUP)).toMatchObject({ originPlatform: 'onebot', config: { persona: '<人设>' } });
    expect(sm.getSession(GROUP)?.originInstance).toBeTypeOf('string');
  });

  it('补记实例的解析晚于一次落盘：记下的实例照样落盘', async () => {
    const gated = gatedAdapter();
    const { sm, mem, inbound } = await setup([gated.adapter], { stored: stored(STORED_ROOM) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await inbound({ sessionId: GROUP, platform: 'onebot' });
    expect(gated.asked, '补记的解析已经发起').toContain(GROUP);
    await sm.updateSession(GROUP, { name: '<改名>' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mem.meta.get(GROUP)?.name, '改名已落盘').toBe('<改名>');
    // 假后端存的是会话对象的引用：换成快照，才看得出之后有没有再落一次盘
    mem.meta.set(GROUP, { ...mem.meta.get(GROUP) });
    gated.release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mem.meta.get(GROUP)?.originInstance).toBeTypeOf('string');
  });

  it('读表后保留记下的实例与她最近开口的时间', async () => {
    const stored: SessionInfo = {
      id: GROUP,
      name: '<群名>',
      children: [],
      status: 'completed',
      config: {},
      createdAt: 1,
      updatedAt: 1,
      kind: 'room',
      originInstance: 'onebot-a',
      lastReplyAt: 5,
    };
    const { sm } = await setup([], { stored: { [GROUP]: stored as unknown as Record<string, unknown> } });

    expect(sm.getSession(GROUP)).toMatchObject({ originInstance: 'onebot-a', lastReplyAt: 5 });
  });

  it('没记下实例的房间（读表读进来的旧房间、建档时没有适配器认领的）在下一条真人入站时补记，推 session:updated', async () => {
    const later = laterAdapter();
    const t = await setup([later.adapter], { stored: stored(STORED_ROOM) });
    await t.inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', nickname: '<乙>' });
    await settle();
    expect(
      [GROUP, PRIVATE].map(id => t.sm.getSession(id)?.originInstance),
      '还没有适配器认领',
    ).toEqual([undefined, undefined]);
    const pushed: Array<[string, string | undefined]> = [];
    t.host.events.on('session:updated', session => void pushed.push([session.id, session.originInstance]));

    later.state.claiming = true;
    for (const id of [GROUP, PRIVATE]) await t.inbound({ sessionId: id, platform: 'onebot' });
    await settle();

    const recorded = t.sm.getSession(GROUP)?.originInstance;
    expect(recorded).toBeTypeOf('string');
    expect(t.sm.getSession(PRIVATE)?.originInstance).toBe(recorded);
    expect(pushed).toContainEqual([GROUP, recorded]);
    expect(pushed).toContainEqual([PRIVATE, recorded]);
  });

  it('已记下的实例不改：之后的入站不重新解析', async () => {
    const { sm, inbound } = await setup([], {
      instances: true,
      stored: stored({ ...STORED_ROOM, originInstance: '<原实例>' }),
    });

    await inbound({ sessionId: GROUP, platform: 'onebot' });
    await settle();

    expect(sm.getSession(GROUP)?.originInstance).toBe('<原实例>');
  });

  it('补记的解析期间会话被删除：不写回，也不推送更新', async () => {
    const gated = gatedAdapter();
    const { sm, host, inbound } = await setup([gated.adapter], { stored: stored(STORED_ROOM) });

    await inbound({ sessionId: GROUP, platform: 'onebot' });
    expect(gated.asked, '补记的解析已经发起').toContain(GROUP);
    await sm.deleteSession(GROUP);
    const updated: string[] = [];
    host.events.on('session:updated', session => void updated.push(session.id));
    gated.release();
    await settle();

    expect(sm.getSession(GROUP)).toBeUndefined();
    expect(updated).toEqual([]);
  });
});

describe('房间取名与补名', () => {
  it('群的首条入站是不带群名的戳一戳：名字为 id，不取戳人者昵称；之后带群名的群消息补上群名', async () => {
    const { sm, inbound } = await setup();

    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', nickname: '<戳人者>' });
    expect(sm.getSession(GROUP)?.name).toBe(GROUP);

    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupName: '<群名>' });
    expect(sm.getSession(GROUP)?.name).toBe('<群名>');
  });

  it('owner 起过名的房间不被后到的群名覆盖', async () => {
    const { sm, inbound } = await setup();

    await inbound({ sessionId: GROUP, platform: 'onebot', nickname: '<戳人者>' });
    // /session.set -n 的落点
    await sm.ensureSession(GROUP, { name: '<显示名>' });
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });

    expect(sm.getSession(GROUP)?.name).toBe('<显示名>');
  });

  it('收录之前就起过名的房间（/session.set 先建档）：原生入站补记来源字段，名字不动', async () => {
    const { sm, inbound } = await setup([], { instances: true });

    await sm.ensureSession(GROUP, { name: '<显示名>' });
    await inbound({ sessionId: GROUP, platform: 'onebot', sessionType: 'group', groupName: '<群名>' });
    await settle();

    expect(sm.getSession(GROUP)).toMatchObject({ name: '<显示名>', originPlatform: 'onebot' });
  });

  it('WebUI 往房间插话：不补名，不取 owner 的昵称；之后对方的私聊补上昵称', async () => {
    const { sm, inbound } = await setup();
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', userId: '30001' });
    expect(sm.getSession(PRIVATE)?.name).toBe(PRIVATE);

    await inbound({ sessionId: PRIVATE, platform: 'webui', userId: 'console', nickname: '<owner 昵称>' });
    expect(sm.getSession(PRIVATE)?.name, '入口不是出生平台时不补名').toBe(PRIVATE);

    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', nickname: '<乙>' });
    expect(sm.getSession(PRIVATE)?.name).toBe('<乙>');
  });

  it('有出生平台、没有聊天窗口的记录（读表时聊天窗口的类型不对被去掉）：判不出群还是私聊，不补名', async () => {
    const { sm, inbound } = await setup([], {
      stored: {
        [GROUP]: {
          id: GROUP,
          name: GROUP,
          children: [],
          status: 'waiting',
          config: {},
          createdAt: 1,
          updatedAt: 1,
          originPlatform: 'onebot',
        },
      },
    });

    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupName: '<群名>',
      nickname: '<群员>',
    });

    expect(sm.getSession(GROUP)?.name).toBe(GROUP);
  });

  it('带 source 的注入回合在未登记的群房间下开子任务：父会话按 id 兜底建档、名字为 id；WebUI 插话不补记，之后的原生入站补记来源字段与群名', async () => {
    const { sm, inbound } = await setup([], { instances: true });

    await inbound({ sessionId: GROUP, platform: 'onebot', source: 'workflow:<工作流>:<节点>' });
    expect(sm.getSession(GROUP), '带 source 的注入不登记').toBeUndefined();
    // create_subtask 的落点：父会话未登记时兜底建档
    await sm.createChildSession(GROUP, { name: '<子任务>' });
    expect(sm.getSession(GROUP)?.name).toBe(GROUP);
    expect(sm.getSession(GROUP)?.originPlatform).toBeUndefined();

    await inbound({ sessionId: GROUP, platform: 'webui', userId: 'console', nickname: '<owner 昵称>' });
    await settle();
    expect(sm.getSession(GROUP)?.originPlatform, '这个 id 不归 webui 的适配器管').toBeUndefined();

    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      selfId: '10000',
      groupId: '20001',
      groupName: '<群名>',
    });
    await settle();
    expect(sm.getSession(GROUP)).toMatchObject({
      name: '<群名>',
      originPlatform: 'onebot',
      originChat: { type: 'group', multiParty: true, selfId: '10000', targetId: '20001' },
      originInstance: 'onebot-a',
    });
  });

  it('升级前只记了出生平台的记录（没有聊天窗口、创建来源与绑定）：出生平台的原生入站补记聊天窗口与群名，场所成为它自己的窗口', async () => {
    const legacy = { id: GROUP, name: GROUP, children: [], status: 'waiting', config: {}, createdAt: 1, updatedAt: 1 };
    const { sm, inbound } = await setup([], {
      instances: true,
      stored: { [GROUP]: { ...legacy, originPlatform: 'onebot' } },
    });
    expect(sm.placeOf(GROUP), '补记之前按窗口 onebot:: 算').toEqual({ kind: 'window', key: 'onebot::' });

    await inbound({ sessionId: GROUP, platform: 'webui', userId: 'console', nickname: '<owner 昵称>' });
    await settle();
    expect(sm.getSession(GROUP)?.originChat, '入口不是出生平台时不补记').toBeUndefined();

    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      selfId: '10000',
      groupId: '20001',
      groupName: '<群名>',
    });
    await settle();
    expect(sm.getSession(GROUP)).toMatchObject({
      name: '<群名>',
      originPlatform: 'onebot',
      originChat: { type: 'group', multiParty: true, selfId: '10000', targetId: '20001' },
      originInstance: 'onebot-a',
    });
    expect(sm.placeOf(GROUP)).toEqual({ kind: 'window', key: 'onebot:group:20001' });
  });

  it('有创建来源的会话不经收录补记：终端的会话收到终端的入站仍没有出生平台', async () => {
    const { sm, inbound } = await setup([], { instances: true });
    await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });

    await inbound({ sessionId: 'cli-default', platform: 'cli', userId: 'console' });
    await settle();

    expect(sm.getSession('cli-default')?.originPlatform).toBeUndefined();
  });
});

describe('状态在回合开始时翻 active', () => {
  it('群里只有消息、没有回合时不是 active；回合中为 active，回合结束后为 completed', async () => {
    const { sm, inbound, turn } = await setup();

    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    expect(sm.getSession(GROUP)?.status, '只有消息、她没开口的房间不该显示进行中').not.toBe('active');

    let during: string | undefined;
    await turn(GROUP, () => {
      during = sm.getSession(GROUP)?.status;
    });
    expect(during).toBe('active');
    expect(sm.getSession(GROUP)?.status).toBe('completed');
  });

  it('已归档的会话跑一轮仍是归档：回合开始与结束都不改它，开口时间照常记下', async () => {
    const { sm, inbound, turn } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    await sm.updateSession(GROUP, { status: 'archived' });

    let during: string | undefined;
    await turn(GROUP, () => {
      during = sm.getSession(GROUP)?.status;
    });
    expect(during).toBe('archived');
    expect(sm.getSession(GROUP)?.status).toBe('archived');
    expect(sm.getSession(GROUP)?.lastReplyAt).toEqual(expect.any(Number));

    await turn(GROUP, undefined, 'error');
    expect(sm.getSession(GROUP)?.status, '出错的一轮同样不翻').toBe('archived');
  });

  it('WebUI 会话（回归）：入站本身不翻，回合中为 active，结束后收口', async () => {
    const { sm, inbound, turn } = await setup();
    const owner = await sm.createSession({ name: '新会话', status: 'waiting' });

    await inbound({ sessionId: owner.id, platform: 'webui', userId: 'console' });
    let during: string | undefined;
    await turn(owner.id, () => {
      during = sm.getSession(owner.id)?.status;
    });

    expect(during).toBe('active');
    expect(sm.getSession(owner.id)?.status).toBe('completed');
  });

  it('后面的输入中间件不调 next() 或抛错：房间都不停在 active', async () => {
    const { sm, host, turn } = await setup();
    await sm.ensureSession(GROUP, { status: 'waiting' });
    const seen: (string | undefined)[] = [];

    const swallow = host.hooks.middleware('agent:input:before', async () => {
      seen.push(sm.getSession(GROUP)?.status);
    });
    await turn(GROUP);
    swallow();
    expect(sm.getSession(GROUP)?.status, '被拦下的回合不该停在进行中').not.toBe('active');

    host.hooks.middleware('agent:input:before', async () => {
      seen.push(sm.getSession(GROUP)?.status);
      throw new Error('<预处理失败>');
    });
    await expect(turn(GROUP)).rejects.toThrow('<预处理失败>');
    expect(sm.getSession(GROUP)?.status, '抛错的回合不该停在进行中').not.toBe('active');
    // 拦下与抛错都发生在翻 active 之后：收口靠的是同一个中间件的 finally
    expect(seen).toEqual(['active', 'active']);
  });

  it('同一会话两轮并行（后台任务结束通知与真人回合各占一条 lane）：先结束的一轮不收口，最后一轮结束才收口', async () => {
    const { sm, inbound, running } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });

    const long = running(GROUP, () => gate);
    await running(GROUP, async () => {});
    expect(sm.getSession(GROUP)?.status, '另一轮还在跑，不该显示已完成').toBe('active');

    release();
    await long;
    expect(sm.getSession(GROUP)?.status).toBe('completed');
  });

  it('回合中途发出的出站消息（send_attachment、paper_send 在工具执行中直接发）不收口，回合结束才收口', async () => {
    const { sm, host, inbound, running } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    let during: string | undefined;

    await running(GROUP, async () => {
      await host.events.emit('outbound:message', {
        content: '<附件>',
        sessionId: GROUP,
        platform: 'onebot',
        source: 'agent',
      });
      during = sm.getSession(GROUP)?.status;
    });

    expect(during, '工具还在执行，回合没结束').toBe('active');
    expect(sm.getSession(GROUP)?.status).toBe('completed');
  });

  it('回合之外建档的会话为 waiting（首条消息是被指令相位吞掉的指令时没有回合）；回合中建档的为 active，回合结束收口', async () => {
    const { sm, host, inbound, running } = await setup();

    // CLI 会话不经 createSession 预建：首条入站由自动标题路径兜底建档
    await inbound({ sessionId: 'cli-default', platform: 'cli', userId: 'console' });
    expect(sm.getSession('cli-default')?.status, '还没有回合，不该显示进行中').toBe('waiting');
    // 指令回复不开回合，也不改状态
    await host.events.emit('outbound:message', {
      content: '<指令回复>',
      sessionId: 'cli-default',
      platform: 'cli',
      source: 'command',
    });
    expect(sm.getSession('cli-default')?.status).toBe('waiting');

    // 回合里才建档（如 create_subtask 兜底建父会话档）：这时已有回合在跑
    let during: string | undefined;
    await running('cli-other', async () => {
      await sm.ensureSession('cli-other', { config: {} });
      during = sm.getSession('cli-other')?.status;
    });
    expect(during).toBe('active');
    expect(sm.getSession('cli-other')?.status).toBe('completed');
  });
});

describe('收口按这一轮的结局，replied 记下她最近开口的时间', () => {
  it('出错的一轮结束后为 error；下一轮开始翻回 active，正常结束为 completed', async () => {
    const { sm, inbound, turn } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });

    await turn(GROUP, undefined, 'error');
    expect(sm.getSession(GROUP)?.status).toBe('error');

    let during: string | undefined;
    await turn(GROUP, () => {
      during = sm.getSession(GROUP)?.status;
    });
    expect(during).toBe('active');
    expect(sm.getSession(GROUP)?.status).toBe('completed');
  });

  it('silent、aborted 收口为 completed；被拦下、没有结局的一轮也是 completed，不沿用上一轮的 error', async () => {
    const { sm, inbound, turn, running } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });

    for (const outcome of ['silent', 'aborted'] as const) {
      await turn(GROUP, undefined, 'error');
      await turn(GROUP, undefined, outcome);
      expect(sm.getSession(GROUP)?.status, outcome).toBe('completed');
    }
    await turn(GROUP, undefined, 'error');
    await running(GROUP, async () => {});
    expect(sm.getSession(GROUP)?.status).toBe('completed');
  });

  it('同一会话两轮并行：最后结束的一轮决定收口', async () => {
    const { sm, inbound, turn } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    const hold = () => {
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      return { gate, release };
    };

    const first = hold();
    const failing = turn(GROUP, () => first.gate, 'error');
    await turn(GROUP, undefined, 'replied');
    expect(sm.getSession(GROUP)?.status, '出错的一轮还在跑').toBe('active');
    first.release();
    await failing;
    expect(sm.getSession(GROUP)?.status).toBe('error');

    const second = hold();
    const replying = turn(GROUP, () => second.gate, 'replied');
    await turn(GROUP, undefined, 'error');
    second.release();
    await replying;
    expect(sm.getSession(GROUP)?.status).toBe('completed');
  });

  it('只有 replied 写入她最近开口的时间：silent、aborted、error 不改', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { sm, inbound, turn } = await setup();
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    expect(sm.getSession(GROUP)?.lastReplyAt, '没开过口').toBeUndefined();

    vi.setSystemTime(1_000);
    await turn(GROUP);
    expect(sm.getSession(GROUP)?.lastReplyAt).toBe(1_000);

    for (const [at, outcome] of [
      [2_000, 'silent'],
      [3_000, 'aborted'],
      [4_000, 'error'],
    ] as const) {
      vi.setSystemTime(at);
      await turn(GROUP, undefined, outcome);
      expect(sm.getSession(GROUP)?.lastReplyAt, outcome).toBe(1_000);
    }
  });

  it('另一轮还在跑时也记下开口时间，随 session:updated 推出并落盘', async () => {
    const { sm, host, mem, inbound, turn, running } = await setup();
    // 落盘是 1 秒去抖：从建档起就用假时钟推进
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });
    const updates: Array<number | undefined> = [];
    host.events.on('session:updated', session => {
      if (session.id === GROUP) updates.push(session.lastReplyAt);
    });

    await running(GROUP, async () => {
      // 先把翻 active 落盘；假后端存的是会话对象的引用，换成快照才看得出开口时间有没有再落一次盘
      await vi.advanceTimersByTimeAsync(1_000);
      mem.meta.set(GROUP, { ...mem.meta.get(GROUP) });

      await turn(GROUP);
      expect(sm.getSession(GROUP)?.status, '另一轮还在跑').toBe('active');
      const replied = sm.getSession(GROUP)?.lastReplyAt;
      expect(replied).toBeTypeOf('number');
      expect(updates).toContain(replied);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mem.meta.get(GROUP)?.lastReplyAt).toBe(replied);
    });
  });
});
