import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { media } from '../../packages/api-media/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 附件的下载与语音转码接本插件这次激活的中止信号：入站消息、出站附件与合并转发里的媒体，停用时在途的下载随之断开、
// ffmpeg 随之停下，不等各自的时限（下载 30 秒、转码 60 秒）。本地启动假的 OneBot v11 实现端（WebSocket 服务）推消息、
// 回动作；附件地址指向本机一个只收不回的上游桩，转码的 process 服务是替身，不启动真实子进程。
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
const PRIVATE = `onebot:${SELF}:private:30001`;
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(300)]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 只收不回的上游桩：requested 为收到请求，closed 为那条请求断开，open 为还开着的请求数 */
async function hangingUpstream() {
  const seen = { requested: false, closed: false, open: 0 };
  const server = createServer(req => {
    seen.requested = true;
    seen.open++;
    req.on('close', () => {
      seen.closed = true;
      seen.open--;
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；用完复原
  cleanups.push(async () => {
    setNetworkPolicy({ blockPrivate: true });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.png` };
}

/**
 * 假实现端 + v11 的 onebot 适配器。replies 是各动作回的 data（缺省回机器人账号；get_record 也这样回，语音按段里的地址读）。
 * 转码的 execFile 一直不回，中止时以非零退出拒绝（与 process 服务停掉进程组后一样）；transcodes 记下每次转码收到的中止信号。
 * 合并转发里的媒体要有 media 服务才落盘，给一个什么也不识别的替身。post 推一条私聊消息，send 交出一条出站消息并交回它：
 * 适配器同步把投递结果挂在它的 delivery 上
 */
async function boot(replies: Record<string, unknown> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  cleanups.push(
    () =>
      new Promise<void>(r => {
        for (const c of server.clients) c.terminate();
        server.close(() => r());
      }),
  );
  const actions: string[] = [];
  let socket: WsSocket | undefined;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { action: string; echo?: string };
      actions.push(req.action);
      const data = replies[req.action] ?? { user_id: SELF };
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: req.echo }));
    });
  });

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide.use(storage, { writeFile: async () => {}, readFile: async () => WAV } as never);
  const transcodes: Array<AbortSignal | undefined> = [];
  host.provide.use(processService, {
    async makeTempDir() {
      return { uri: 'data:/tmp/t', path: '/zz-host/tmp/t', cleanup: async () => {} };
    },
    execFile(_cmd: string, _args: readonly string[], opts: { signal?: AbortSignal } = {}) {
      transcodes.push(opts.signal);
      const stopped = new Error('execFile ffmpeg 退出码 null (signal SIGTERM)');
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(stopped), { once: true }));
    },
  } as never);
  host.provide.use(media, {
    lookupDescription: () => null,
    rememberDescriptionAlias() {},
    describeImage: async () => '',
  } as never);
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }],
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  await app.start();
  await expect.poll(() => actions.includes('get_login_info')).toBe(true);
  return {
    transcodes,
    disable: () => app.plugins.disable(onebotPlugin.name),
    post: (segment: Record<string, unknown>) =>
      socket?.send(
        JSON.stringify({
          time: 0,
          post_type: 'message',
          message_type: 'private',
          self_id: Number(SELF),
          user_id: 30001,
          message_id: 1,
          message: [segment],
          sender: { nickname: '甲' },
        }),
      ),
    send: async (fields: Pick<OutgoingMessage, 'content' | 'attachments' | 'markup'>) => {
      const msg: OutgoingMessage = { sessionId: PRIVATE, source: 'agent', ...fields };
      await host.events.use.emit('outbound:message', msg);
      return msg;
    },
  };
}

/** 投递结果落定了没有：落定之前为 false */
function settledFlag(delivery: Promise<unknown> | undefined) {
  const flag = { settled: false };
  void delivery?.finally(() => {
    flag.settled = true;
  });
  return flag;
}

describe('onebot 附件随停用中止', () => {
  it('入站附件下载途中停用：到上游的请求随之断开，不等满 30 秒的下载时限', async () => {
    const upstream = await hangingUpstream();
    const t = await boot();
    t.post({ type: 'image', data: { file: 'a.png', url: upstream.url } });
    await expect.poll(() => upstream.seen.requested).toBe(true);
    await t.disable();
    await expect.poll(() => upstream.seen.closed).toBe(true);
  });

  it('出站附件下载途中停用：到上游的请求随之断开，发送时不再另行发起下载，投递随之落定', async () => {
    const upstream = await hangingUpstream();
    const t = await boot();
    const msg = await t.send({ content: '', attachments: [{ kind: 'image', data: upstream.url }] });
    const delivery = settledFlag(msg.delivery);
    await expect.poll(() => upstream.seen.requested).toBe(true);
    await t.disable();
    await expect.poll(() => delivery.settled).toBe(true);
    await expect.poll(() => upstream.seen.open).toBe(0);
  });

  it('回复正文里的媒体标记下载途中停用：到上游的请求随之断开，投递随之落定', async () => {
    const upstream = await hangingUpstream();
    const t = await boot();
    const msg = await t.send({ content: `一<image url="${upstream.url}"/>二`, markup: true });
    const delivery = settledFlag(msg.delivery);
    await expect.poll(() => upstream.seen.requested).toBe(true);
    await t.disable();
    await expect.poll(() => delivery.settled).toBe(true);
    await expect.poll(() => upstream.seen.open).toBe(0);
  });

  it('合并转发里的媒体下载途中停用：到上游的请求随之断开', async () => {
    const upstream = await hangingUpstream();
    const image = { type: 'image', data: { url: upstream.url } };
    const t = await boot({
      get_forward_msg: { messages: [{ type: 'node', data: { nickname: '乙', user_id: '30002', content: [image] } }] },
    });
    t.post({ type: 'forward', data: { id: 'F1' } });
    await expect.poll(() => upstream.seen.requested).toBe(true);
    await t.disable();
    await expect.poll(() => upstream.seen.closed).toBe(true);
  });

  it('语音转码途中停用：交给 ffmpeg 的中止信号随之断开', async () => {
    const t = await boot();
    t.post({ type: 'record', data: { file: 'v1.amr', url: `data:audio/wav;base64,${WAV.toString('base64')}` } });
    await expect.poll(() => t.transcodes.length).toBe(1);
    await t.disable();
    expect(t.transcodes[0]?.aborted).toBe(true);
  });
});
