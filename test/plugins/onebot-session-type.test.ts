import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { roomClass, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// OneBot 入站带的平台类型名与聊天窗口：适配器把实现端给的消息类型原样带成类型名，会话管理按它的声明记下聊天窗口。
// 声明里没有的类型（如部分 v11 实现扩展的 guild）按多方记下并告警，不当成一对一：否则第一个发言的若是 owner，
// 这个多人窗口就成了 owner 的一对一。频道的窗口 id 是 `<guild>:<channel>`，消息上的 groupId 与会话 id 的目标段一致。
// 本地起一个假的 OneBot 实现端推送消息事件。
// ════════════════════════════════════════════════════════════

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

const SELF = '10000';
const OWNER_QQ = '99999';
const isOwner = (platform: string, userId: string) => platform === 'onebot' && userId === OWNER_QQ;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 假实现端 + onebot 适配器 + 会话管理；push 推一个原始事件，等它进了 inbound:message */
async function boot(protocol: 'v11' | 'v12') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(
    () =>
      new Promise<void>(resolve => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  let socket: WsSocket | undefined;
  const actions: string[] = [];
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { echo?: string; action?: string };
      if (req.action) actions.push(req.action);
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
    });
  });

  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  host.provide.use(memory, fakeMemory() as never);
  const inbound: IncomingMessage[] = [];
  host.events.use.on('inbound:message', (msg: IncomingMessage) => void inbound.push(msg));
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
  });
  await app.plugin(sessionManagerPlugin);
  await app.plugins.idle();
  for (const name of [onebotPlugin.name, sessionManagerPlugin.name]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  await app.start();
  await until(() => socket !== undefined && actions.includes(protocol === 'v11' ? 'get_login_info' : 'get_self_info'));

  const sm = host.sessionManager.use;
  return {
    sm,
    warns,
    inbound,
    async push(event: Record<string, unknown>) {
      const before = inbound.length;
      socket?.send(JSON.stringify(event));
      await until(() => inbound.length > before);
      await new Promise<void>(resolve => setImmediate(resolve));
      return inbound[inbound.length - 1] as IncomingMessage;
    },
  };
}

describe('OneBot 入站的平台类型名', () => {
  it('v11 的 guild 消息（声明里没有的类型）：原样带出类型名，记成多方并告警一次；owner 先发言也是 room', async () => {
    const t = await boot('v11');
    const guild = (userId: string) => ({
      time: 0,
      post_type: 'message',
      message_type: 'guild',
      self_id: Number(SELF),
      user_id: Number(userId),
      message: '<占位>',
    });

    const first = await t.push(guild(OWNER_QQ));
    await t.push(guild('30001'));

    expect(first.sessionType).toBe('guild');
    const session = t.sm.getSession(first.sessionId);
    expect(session?.originChat).toMatchObject({ type: 'guild', multiParty: true });
    expect(roomClass(session, id => t.sm.getSession(id), isOwner)).toBe('room');
    expect(t.warns.filter(w => w.includes('没有声明'))).toHaveLength(1);
  });

  it('v12 的频道消息：groupId 是 `<guild>:<channel>`，与会话 id 的目标段一致，记成聊天窗口的目标', async () => {
    const t = await boot('v12');

    const msg = await t.push({
      type: 'message',
      detail_type: 'channel',
      self: { user_id: SELF },
      user_id: '30001',
      guild_id: '40001',
      channel_id: '50001',
      message: [{ type: 'text', data: { text: '<占位>' } }],
      time: 0,
    });

    expect(msg).toMatchObject({ sessionId: `onebot:${SELF}:channel:40001:50001`, sessionType: 'channel' });
    expect(msg.groupId).toBe('40001:50001');
    expect(t.sm.getSession(msg.sessionId)?.originChat).toMatchObject({
      type: 'channel',
      multiParty: true,
      targetId: '40001:50001',
    });
  });
});
