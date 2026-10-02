import { createRequire } from 'node:module';
import { type AddressInfo, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import {
  aggregatePlatformConnections,
  callPlatformAction,
  getPlatformSelfIdentity,
  platform,
  resolvePlatformBySession,
  sendPlatformMessage,
} from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type RegisteredTool, tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import toolOnebot from '../../packages/plugin-tool-onebot/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 一个 OneBot 插件装成两个实例、各带自己的机器人账号时，按会话 id 里的账号找到所属实例：
// 平台动作与消息发到那个实例的连接，会话管理按它给房间记下所属实例（会话列表据此分组），
// tool-onebot 的动作（含合成会话 id、显式 self_id 与兜底账号）也发到账号所在的实例。
// 每个在线账号对应一个进程内起在 127.0.0.1 的假 OneBot 实现端；「配置里写明、还没连上」的账号
// 连向一个已关闭的端口。不连任何外部服务。
// ════════════════════════════════════════════════════════════

/** 用到的 ws 服务端面（ws 是 onebot 包的依赖，test/ 解析不到它的类型） */
type WsSocket = { on(event: 'message', cb: (raw: Buffer) => void): void; send(data: string): void; terminate(): void };
type WsServer = {
  on(event: 'connection', cb: (socket: WsSocket) => void): void;
  once(event: 'listening', cb: () => void): void;
  address(): AddressInfo;
  clients: Set<WsSocket>;
  close(cb: () => void): void;
};
const { WebSocketServer } = createRequire(
  new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url),
)('ws') as { WebSocketServer: new (opts: { host: string; port: number }) => WsServer };

const A = `${onebotPlugin.name}:a`;
const B = `${onebotPlugin.name}:b`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`等待超时: ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 假 OneBot 实现端：记下收到的 action，一律回成功；发消息类回一个 message_id，供「撤回自己发的消息」 */
async function fakeImplementation(selfId: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  cleanups.push(
    () =>
      new Promise<void>(r => {
        for (const c of server.clients) c.terminate();
        server.close(() => r());
      }),
  );
  const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
  let socket: WsSocket | undefined;
  let nextMessageId = 1;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo?: string };
      if (!req.echo) return;
      actions.push({ action: req.action, params: req.params });
      const data = req.action === 'get_login_info' ? { user_id: selfId } : { message_id: nextMessageId++ };
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo }));
    });
  });
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    actions,
    /** 以这个账号的身份推一个事件给适配器 */
    push: (event: Record<string, unknown>) =>
      socket?.send(JSON.stringify({ self_id: Number(selfId), time: 0, ...event })),
  };
}

/** 一个已关闭的本地端口：连上去立即被拒，连接停在未上线 */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(r => server.close(() => r()));
  return `ws://127.0.0.1:${port}`;
}

type Account = { self: string; online: boolean };

/** 按给定账号装两个 OneBot 实例（a、b）、会话管理与 tool-onebot；在线账号全部连上后返回 */
async function world(accounts: { a: Account[]; b: Account[] }) {
  const servers = new Map<string, Awaited<ReturnType<typeof fakeImplementation>>>();
  const connections = async (list: Account[]) =>
    Promise.all(
      list.map(async ({ self, online }) => {
        if (!online) return { url: await closedPortUrl(), protocol: 'v11', selfId: self };
        const server = await fakeImplementation(self);
        servers.set(self, server);
        return { url: server.url, protocol: 'v11', selfId: self };
      }),
    );

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events, platform, sessionManager });
  host.provide(storage, { listRoots: () => [] } as never);
  host.provide(processService, {} as never);
  host.provide(memory, fakeMemory() as never);
  const handlers = new Map<string, RegisteredTool['handler']>();
  host.provide(tools, {
    register(tool: Omit<RegisteredTool, 'pluginName'>) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);

  await app.pluginAll([
    { definition: onebotPlugin, config: { connections: await connections(accounts.a) }, instanceId: A },
    { definition: onebotPlugin, config: { connections: await connections(accounts.b) }, instanceId: B },
    { definition: sessionManagerPlugin },
    { definition: toolOnebot },
  ]);
  await app.plugins.idle();
  for (const id of [A, B, sessionManagerPlugin.name, toolOnebot.name]) {
    if (app.plugins.getPlugin(id)?.state !== 'active') throw new Error(`${id} 未激活`);
  }
  await app.start(); // app:ready 时连接
  const onlineCount = [...accounts.a, ...accounts.b].filter(a => a.online).length;
  await until(
    () => aggregatePlatformConnections(host.platform).filter(c => c.status === 'online').length === onlineCount,
    '在线账号全部连上',
  );

  const server = (self: string) => {
    const s = servers.get(self);
    if (!s) throw new Error(`账号 ${self} 没有假实现端`);
    return s;
  };
  /** 某个账号的实现端收到过的 action 名 */
  const actionsOf = (self: string) => server(self).actions.map(a => a.action);
  const tool = (name: string) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`工具 ${name} 未注册`);
    return (args: Record<string, unknown>, sessionId: string) => handler(args, { sessionId, platform: 'onebot' });
  };
  return { host, server, actionsOf, tool, sm: () => host.sessionManager.require() };
}

/** 两个实例：a 带一个在线账号，b 带一个在线账号和一个配置里写明、还没连上的账号 */
const TWO_INSTANCES = {
  a: [{ self: '111', online: true }],
  b: [
    { self: '222', online: true },
    { self: '333', online: false },
  ],
};

describe('OneBot 多实例：会话按账号路由到所属实例', () => {
  it('解析结果带出所属实例；配置里写明、连接还没上来的账号也认', async () => {
    const { host } = await world(TWO_INSTANCES);

    const owner = async (sessionId: string) => (await resolvePlatformBySession(host.platform, sessionId))?.contextId;
    expect(await owner('onebot:111:group:1')).toBe(A);
    expect(await owner('onebot:222:group:1')).toBe(B);
    expect(await owner('onebot:333:private:1'), '配置里写明的账号，连接没上来也归 b').toBe(B);
  });

  it('平台动作与消息发到账号所在实例的连接', async () => {
    const { host, actionsOf } = await world(TWO_INSTANCES);

    await callPlatformAction(host.platform, 'onebot:222:group:5', 'get_group_info', { group_id: 5 });
    await sendPlatformMessage(host.platform, 'onebot:222:group:5', '<文本>');

    expect(actionsOf('222')).toEqual(expect.arrayContaining(['get_group_info', 'send_group_msg']));
    expect(actionsOf('111')).not.toContain('get_group_info');
    expect(actionsOf('111')).not.toContain('send_group_msg');
  });

  it('认不出的账号：报错列出各实例已知的账号与连接状态', async () => {
    const { host } = await world(TWO_INSTANCES);

    const error = await callPlatformAction(host.platform, 'onebot:999:group:5', 'get_group_info', {}).then(
      () => undefined,
      (err: Error) => err.message,
    );

    expect(error).toContain('onebot:999:group:5');
    expect(error).toContain(`${A}: 111(online)`);
    expect(error).toMatch(new RegExp(`${B}: 222\\(online\\)、333\\((offline|connecting)\\)`));
  });

  it('机器人自身身份取账号所在实例的', async () => {
    const { host } = await world(TWO_INSTANCES);

    expect(getPlatformSelfIdentity(host.platform, 'onebot', 'onebot:222:group:5')?.selfId).toBe('222');
    expect(getPlatformSelfIdentity(host.platform, 'onebot', 'onebot:111:group:5')?.selfId).toBe('111');
  });
});

describe('会话管理收录房间时记下所属实例', () => {
  it('原生入站、owner 插话、配置里写明还没连上的账号，各记各的实例；认不出的账号不记', async () => {
    const { server, host, sm } = await world(TWO_INSTANCES);

    server('222').push({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      user_id: 40001,
      group_id: 50001,
      message_id: 1,
      message: [{ type: 'text', data: { text: '<群消息>' } }],
      raw_message: '<群消息>',
      sender: { user_id: 40001, nickname: '<甲>' },
    });
    const owner = (sessionId: string) =>
      host.events.emit('inbound:message', { content: '<插话>', sessionId, platform: 'webui', userId: 'console' });
    await owner('onebot:111:private:7');
    await owner('onebot:333:group:9');
    await owner('onebot:999:group:9');

    const instanceOf = (id: string) => sm().getSession(id)?.originInstance;
    await until(() => instanceOf('onebot:222:group:50001') !== undefined, 'b 的群房间收录');
    await until(() => instanceOf('onebot:333:group:9') !== undefined, 'owner 插话建出的房间');
    expect(instanceOf('onebot:222:group:50001')).toBe(B);
    expect(instanceOf('onebot:111:private:7')).toBe(A);
    expect(instanceOf('onebot:333:group:9')).toBe(B);
    expect(sm().getSession('onebot:999:group:9'), '认不出的账号照样收录').toBeDefined();
    expect(instanceOf('onebot:999:group:9')).toBeUndefined();
  });
});

describe('tool-onebot：动作发到账号所在的实例', () => {
  it('当前会话的账号、显式 self_id 都按账号路由（工具用的是合成会话 id）', async () => {
    const { actionsOf, tool } = await world(TWO_INSTANCES);

    await tool('onebot_get_group_info')({}, 'onebot:222:group:5');
    expect(actionsOf('222')).toContain('get_group_info');

    await tool('onebot_get_group_list')({ self_id: '222' }, 'onebot:111:group:5');
    expect(actionsOf('222')).toContain('get_group_list');
    expect(actionsOf('111')).not.toContain('get_group_list');
  });

  it('兜底账号优先取在线的，不被排在前面的实例里没连上的账号挡住', async () => {
    const { actionsOf, tool } = await world({
      a: [{ self: '333', online: false }],
      b: [{ self: '222', online: true }],
    });

    await tool('onebot_get_group_list')({}, 'session-abcd1234');

    expect(actionsOf('222')).toContain('get_group_list');
  });

  it('撤回自己发的消息：找的是发出这条消息的实例', async () => {
    const { host, actionsOf, tool } = await world(TWO_INSTANCES);
    await sendPlatformMessage(host.platform, 'onebot:222:group:5', '<文本>');

    const result = await tool('onebot_recall_self')({}, 'onebot:222:group:5');

    expect(result).toContain('已撤回');
    expect(actionsOf('222')).toContain('delete_msg');
  });

  it('自身禁言列表汇总各实例', async () => {
    const { server, tool } = await world(TWO_INSTANCES);
    const ban = (self: string, groupId: number) =>
      server(self).push({
        post_type: 'notice',
        notice_type: 'group_ban',
        sub_type: 'ban',
        user_id: Number(self),
        group_id: groupId,
        operator_id: 9,
        duration: 600,
      });
    ban('111', 6);
    ban('222', 5);

    const listed = async () =>
      (
        JSON.parse(String(await tool('onebot_list_self_mutes')({}, 'session-abcd1234'))) as {
          mutes: Array<{ selfId: string; groupId: string }>;
        }
      ).mutes.map(m => `${m.selfId}/${m.groupId}`);
    let mutes: string[] = [];
    await until(async () => {
      mutes = await listed();
      return mutes.length === 2;
    }, '两个实例的禁言都到达');

    expect(mutes.sort()).toEqual(['111/6', '222/5']);
  });

  it('好友申请交给收到它的实例处理', async () => {
    const { server, actionsOf, tool } = await world(TWO_INSTANCES);
    server('222').push({ post_type: 'request', request_type: 'friend', user_id: 30001, flag: 'f1', comment: '' });

    let result = '';
    await until(async () => {
      result = String(
        await tool('onebot_handle_friend_request')({ user_id: '30001', approve: true }, 'onebot:222:private:30001'),
      );
      return !result.startsWith('未找到来自');
    }, '申请到达后处理');

    expect(result).toContain('已同意');
    expect(actionsOf('222')).toContain('set_friend_add_request');
  });
});
