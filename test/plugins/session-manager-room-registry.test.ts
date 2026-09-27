import { afterEach, describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// IM 房间收录：有出生平台、不是子任务的会话，首条真人入站（不带 source）即登记，名字只采信出生平台自己的入站；
// 带 source 的内部注入（工作流、好友申请的合成通知、空闲开话题等）不登记。
// 状态在回合真正开始的 agent:input:before 翻 active，同一个中间件在 finally 里收口，
// 后面的中间件拦下或抛错时房间也不停在「进行中」。
// ════════════════════════════════════════════════════════════

const GROUP = 'onebot:10000:group:20001';
const PRIVATE = 'onebot:10000:private:30001';

const ONEBOT = { adapterName: 'OneBot', platform: 'onebot', getConnections: () => [], sendMessage: async () => {} };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(adapters: Partial<PlatformAdapter>[] = []) {
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
  host.provide(memory, fakeMemory() as never);
  for (const adapter of adapters) host.provide(platform, adapter as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.require();

  const inbound = (msg: Omit<IncomingMessage, 'content'>) =>
    host.events.emit('inbound:message', { content: '<占位>', ...msg });

  /** 按 agent 的顺序跑一轮：agent:input:before 的默认动作里跑完回合，最后发 agent:turn:after */
  const turn = async (sessionId: string, during?: () => void) => {
    const message: IncomingMessage = { content: '<占位>', sessionId, platform: 'onebot' };
    await host.hooks.run('agent:input:before', { message, metadata: {} }, async () => {
      during?.();
      await host.hooks.run('agent:turn:after', {
        message,
        reply: '<回复>',
        outcome: 'replied',
        sessionId,
        metadata: {},
      });
    });
  };

  return { sm, host, inbound, turn, warns };
}

describe('IM 房间按首条真人入站登记', () => {
  it('群消息建档：名字取群名，room、group、onebot，状态 waiting，由 system 建；私聊以对方昵称为名', async () => {
    const { sm, inbound } = await setup();

    await inbound({
      sessionId: GROUP,
      platform: 'onebot',
      sessionType: 'group',
      groupName: '<群名>',
      nickname: '<甲>',
    });
    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', nickname: '<乙>' });

    const group = sm.getSession(GROUP);
    expect(group).toMatchObject({
      name: '<群名>',
      kind: 'room',
      audience: 'group',
      originPlatform: 'onebot',
      status: 'waiting',
      createdBy: 'system',
    });
    expect(sm.getSession(PRIVATE)).toMatchObject({ name: '<乙>', audience: 'private', status: 'waiting' });
  });

  it('没有执行过 /session.set、也没开过子任务的群同样登记', async () => {
    const { sm, inbound } = await setup();
    expect(sm.getSession(GROUP)).toBeUndefined();

    await inbound({ sessionId: GROUP, platform: 'onebot', groupName: '<群名>' });

    expect(sm.getSession(GROUP), '首条真人入站就该登记').toBeDefined();
  });

  it('子任务 id 的入站不建房间档；没有出生平台的会话不经这条路径建档', async () => {
    const { sm, inbound } = await setup();

    await inbound({ sessionId: `${GROUP}::abcd1234`, platform: 'onebot', groupName: '<群名>' });
    expect(sm.getSession(`${GROUP}::abcd1234`), '子任务 id 不该被当成房间登记').toBeUndefined();
    expect(sm.getSession(GROUP), '也不顺手登记它的父房间').toBeUndefined();

    // webui 入口的 session-<8位> 可能被自动标题兜底建档（既有行为），但不是由这里以 system 身份建的
    await inbound({ sessionId: 'session-abcd1234', platform: 'webui' });
    await inbound({ sessionId: 'mcp-server', platform: 'mcp' });
    expect(sm.getSession('session-abcd1234')?.createdBy).not.toBe('system');
    expect(sm.getSession('mcp-server')).toBeUndefined();
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

  it('WebUI 往未登记的私聊房间插话：建档用 id 作名字，不取 owner 的昵称；之后对方的私聊补上昵称', async () => {
    const { sm, inbound } = await setup();

    await inbound({ sessionId: PRIVATE, platform: 'webui', userId: 'console', nickname: '<owner 昵称>' });
    expect(sm.getSession(PRIVATE)).toMatchObject({ name: PRIVATE, audience: 'private', createdBy: 'system' });

    await inbound({ sessionId: PRIVATE, platform: 'webui', nickname: '<owner 昵称>' });
    expect(sm.getSession(PRIVATE)?.name, '入口不是出生平台时不补名').toBe(PRIVATE);

    await inbound({ sessionId: PRIVATE, platform: 'onebot', sessionType: 'private', nickname: '<乙>' });
    expect(sm.getSession(PRIVATE)?.name).toBe('<乙>');
  });
});

describe('状态在回合开始时翻 active', () => {
  it('群里只有消息、没有回合时不是 active；回合中为 active，agent:turn:after 之后为 completed', async () => {
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
});

describe('id 前缀与平台名不一致的告警', () => {
  it('前缀不是发来消息的平台、也不是已注册的平台名：每个前缀只告警一次', async () => {
    const { warns, inbound } = await setup([ONEBOT]);

    await inbound({ sessionId: '<缩写>:<x>:group:<y>', platform: '<平台甲>' });
    await inbound({ sessionId: '<缩写>:<x>:group:<z>', platform: '<平台甲>' });

    const hits = warns.filter(w => w.includes('<缩写>'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('<平台甲>');
  });

  it('已注册 onebot 适配器时，WebUI 往 onebot 房间插话不告警', async () => {
    const { warns, inbound } = await setup([ONEBOT]);

    await inbound({ sessionId: GROUP, platform: 'webui', userId: 'console' });

    expect(warns.filter(w => w.includes('onebot'))).toEqual([]);
  });
});
