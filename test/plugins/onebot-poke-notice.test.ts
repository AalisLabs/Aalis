import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type ArchiveNoticeOptions, messageArchive } from '../../packages/api-message-archive/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

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

type Protocol = 'v11' | 'v12';
async function boot(protocol: Protocol) {
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

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide(storage, { listRoots: () => [] } as never);
  host.provide(processService, {} as never);
  const directNotices: ArchiveNoticeOptions[] = [];
  host.provide(messageArchive, {
    async archiveNotice(opts: ArchiveNoticeOptions) {
      directNotices.push(opts);
      return null;
    },
  } as never);
  const inbound: IncomingMessage[] = [];
  host.events.on('inbound:message', (msg: IncomingMessage) => {
    inbound.push(msg);
  });
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  await app.start();
  await until(() => socket !== undefined && actions.includes(protocol === 'v11' ? 'get_login_info' : 'get_self_info'));

  function poke(userId: number, targetId: number, groupId?: number): void {
    const event =
      protocol === 'v11'
        ? {
            post_type: 'notice',
            notice_type: 'notify',
            sub_type: 'poke',
            self_id: Number(SELF),
            user_id: userId,
            target_id: targetId,
            group_id: groupId,
            time: 0,
          }
        : {
            type: 'notice',
            detail_type: 'poke',
            self: { user_id: SELF },
            user_id: String(userId),
            target_id: String(targetId),
            group_id: groupId == null ? undefined : String(groupId),
            time: 0,
          };
    socket?.send(JSON.stringify(event));
  }
  return { poke, inbound, directNotices };
}

describe.each(['v11', 'v12'] as const)('OneBot %s poke 入站', protocol => {
  it('群友互戳、戳 bot 及重复互动均逐条进入各自群会话，并保留是否戳 bot 的身份', async () => {
    const t = await boot(protocol);
    t.poke(30001, 30002, 20001);
    t.poke(30003, 30004, 20002);
    t.poke(30001, 30002, 20001);
    t.poke(30005, Number(SELF), 20001);
    await until(() => t.inbound.length === 4);

    expect(
      t.inbound.map(m => [m.sessionId, m.sessionType, m.groupId, m.userId, m.noticeType, m.noticeTargetIsSelf]),
    ).toEqual([
      [`onebot:${SELF}:group:20001`, 'group', '20001', '30001', 'poke', false],
      [`onebot:${SELF}:group:20002`, 'group', '20002', '30003', 'poke', false],
      [`onebot:${SELF}:group:20001`, 'group', '20001', '30001', 'poke', false],
      [`onebot:${SELF}:group:20001`, 'group', '20001', '30005', 'poke', true],
    ]);
    expect(t.inbound[0]?.content).toContain('30001');
    expect(t.inbound[0]?.content).toContain('30002');
    expect(t.inbound[0]?.content).not.toContain('戳了你');
    expect(t.inbound[1]?.content).toContain('30003');
    expect(t.inbound[1]?.content).toContain('30004');
    expect(t.inbound[3]?.content).toContain('30005');
    expect(t.directNotices).toEqual([]);
  });

  it('私聊戳一戳继续走入站，且不直接调用 notice 归档', async () => {
    const t = await boot(protocol);
    t.poke(30001, Number(SELF));
    await until(() => t.inbound.length === 1);
    expect(t.inbound[0]).toMatchObject({
      sessionId: `onebot:${SELF}:private:30001`,
      sessionType: 'private',
      userId: '30001',
      noticeType: 'poke',
      noticeTargetIsSelf: true,
    });
    expect(t.directNotices).toEqual([]);
  });

  it('机器人自己发出的群 poke 回显不重新触发入站', async () => {
    const t = await boot(protocol);
    t.poke(Number(SELF), 30002, 20001);
    t.poke(30001, Number(SELF), 20001);
    await until(() => t.inbound.length === 1);
    expect(t.inbound).toHaveLength(1);
    expect(t.inbound[0]).toMatchObject({ userId: '30001', noticeTargetIsSelf: true });
    expect(t.directNotices).toEqual([]);
  });
});
