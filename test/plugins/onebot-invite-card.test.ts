import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 私聊里的入群邀请卡片（应用名 com.tencent.qun.invite）与入群邀请事件（request/group/invite）是同一件事，按卡片类型丢掉、
// 记一条 debug，不看之前有没有推过邀请事件，也不设时间窗；别的卡片（小程序分享等）与群里的卡片照常入站。
// 本地启动一个假的 OneBot 实现端（WebSocket 服务），适配器按配置正向连接。
// ════════════════════════════════════════════════════════════

type WsServer = {
  on(event: 'connection', cb: (socket: WsSocket) => void): void;
  once(event: 'listening', cb: () => void): void;
  address(): AddressInfo;
  clients: Set<WsSocket>;
  close(cb: () => void): void;
};
type WsSocket = { on(event: 'message', cb: (raw: Buffer) => void): void; send(data: string): void; terminate(): void };

const { WebSocketServer } = createRequire(
  new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url),
)('ws') as { WebSocketServer: new (opts: { host: string; port: number }) => WsServer };

const SELF = '10000';
const INVITER = 30002;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

async function boot() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  cleanups.push(
    () =>
      new Promise<void>(r => {
        for (const c of server.clients) c.terminate();
        server.close(() => r());
      }),
  );
  let socket: WsSocket | undefined;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { echo?: string };
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
    });
  });

  const debugs: string[] = [];
  const logger = {
    debug: (...args: unknown[]) => void debugs.push(args.map(String).join(' ')),
    info() {},
    warn() {},
    error() {},
    child: () => logger,
  } as unknown as Logger;
  const app = new App({ logLevel: 'error', logger });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  const inbound: IncomingMessage[] = [];
  host.events.use.on('inbound:message', (m: IncomingMessage) => void inbound.push(m));
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }],
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  await app.start();
  await until(() => socket !== undefined);

  const send = (event: Record<string, unknown>) =>
    socket?.send(JSON.stringify({ self_id: Number(SELF), time: 0, ...event }));
  let messageId = 0;
  return {
    inbound,
    debugs,
    invite: () =>
      send({
        post_type: 'request',
        request_type: 'group',
        sub_type: 'invite',
        user_id: INVITER,
        group_id: 20002,
        flag: 'f1',
      }),
    /** 邀请人发一张卡片，缺省在私聊里，group 为真时发在群里 */
    card: (app: string, group = false) =>
      send({
        post_type: 'message',
        message_type: group ? 'group' : 'private',
        ...(group ? { group_id: 20003 } : {}),
        user_id: INVITER,
        message_id: ++messageId,
        message: [{ type: 'json', data: { data: JSON.stringify({ app, meta: {} }) } }],
        sender: { nickname: '邀请人' },
      }),
    text: (s: string) =>
      send({
        post_type: 'message',
        message_type: 'private',
        user_id: INVITER,
        message_id: ++messageId,
        message: [{ type: 'text', data: { text: s } }],
        sender: { nickname: '邀请人' },
      }),
  };
}

const cardDropped = (debugs: string[]) => debugs.filter(d => d.includes('入群邀请卡片')).length;
const contents = (t: Awaited<ReturnType<typeof boot>>) => t.inbound.map(m => m.content);

describe('onebot 入站：私聊里的入群邀请卡片', () => {
  it('没推过入群邀请事件也丢掉，记一条 debug', async () => {
    const t = await boot();
    t.card('com.tencent.qun.invite');
    t.text('哨兵');
    await until(() => contents(t).includes('哨兵'));
    expect(contents(t)).toEqual(['哨兵']);
    expect(cardDropped(t.debugs)).toBe(1);
  });

  it('推过入群邀请事件之后同样丢掉', async () => {
    const t = await boot();
    t.invite();
    await until(() => t.inbound.length === 1);
    t.card('com.tencent.qun.invite');
    t.text('哨兵');
    await until(() => contents(t).includes('哨兵'));
    expect(contents(t).slice(1)).toEqual(['哨兵']);
    expect(cardDropped(t.debugs)).toBe(1);
  });

  it('收到入群邀请之后，同一人发来的别的卡片照常入站', async () => {
    const t = await boot();
    t.invite();
    await until(() => t.inbound.length === 1);
    t.card('com.example.miniapp');
    t.text('哨兵');
    await until(() => contents(t).includes('哨兵'));
    expect(contents(t).slice(1)).toEqual(['[JSON卡片]', '哨兵']);
    expect(cardDropped(t.debugs)).toBe(0);
  });

  it('只在私聊里丢：群里同一张卡片照常入站', async () => {
    const t = await boot();
    t.card('com.tencent.qun.invite', true);
    t.text('哨兵');
    // 群消息与私聊的哨兵谁先入站不定：等到卡片入站或被丢掉再比
    await until(() => contents(t).length === 2 || (cardDropped(t.debugs) > 0 && contents(t).includes('哨兵')));
    expect([...contents(t)].sort()).toEqual(['[JSON卡片]', '哨兵'].sort());
    expect(cardDropped(t.debugs)).toBe(0);
  });
});
