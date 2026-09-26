import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// OneBot 请求事件（好友申请、入群邀请、加群申请）合成的「[系统通知] …」是系统侧注入，要带 source：
// 不带时它在群会话里被当成真人消息，触发判定计数后吞掉（加群申请几乎到不了 agent），冷却期内也会被吞。
// 本地起一个假的 OneBot 实现端（WebSocket 服务），适配器按配置正向连接，经真实的事件解析与请求处理发出。
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

describe('plugin-adapter-onebot：请求事件的系统通知', () => {
  it('好友申请、入群邀请、加群申请都带 source=onebot-request 发出', async () => {
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
      // 适配器连上后会调 get_login_info 等 action：一律回成功
      ws.on('message', raw => {
        const req = JSON.parse(raw.toString()) as { echo?: string };
        if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
      });
    });

    const app = new App({ name: 'T', logLevel: 'error' });
    cleanups.push(() => app.stop());
    await registerHubs(app);
    const host = app.bind({ provide, events });
    host.provide(storage, { listRoots: () => [] } as never);
    host.provide(processService, {} as never);
    const inbound: IncomingMessage[] = [];
    host.events.on('inbound:message', (m: IncomingMessage) => {
      inbound.push(m);
    });
    await app.plugins.register(onebotPlugin, {
      connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }],
    });
    await app.plugins.idle();
    if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
    await app.start(); // app:ready 时连接
    await until(() => socket !== undefined);

    const request = (extra: Record<string, unknown>) =>
      socket?.send(JSON.stringify({ post_type: 'request', self_id: Number(SELF), time: 0, ...extra }));
    request({ request_type: 'friend', user_id: 30001, flag: 'f1', comment: '你好' });
    request({ request_type: 'group', sub_type: 'invite', user_id: 30002, group_id: 20002, flag: 'f2' });
    request({ request_type: 'group', sub_type: 'add', user_id: 30003, group_id: 20001, flag: 'f3' });
    await until(() => inbound.length === 3);

    expect(inbound.map(m => [m.sessionId, m.sessionType, m.source])).toEqual([
      [`onebot:${SELF}:private:30001`, 'private', 'onebot-request'],
      [`onebot:${SELF}:private:30002`, 'private', 'onebot-request'],
      [`onebot:${SELF}:group:20001`, 'group', 'onebot-request'],
    ]);
    expect(inbound.every(m => m.content.startsWith('[系统通知]'))).toBe(true);
  });
});
