import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import { OneBotV11 } from '../../packages/plugin-adapter-onebot/src/v11.js';
import { OneBotV12 } from '../../packages/plugin-adapter-onebot/src/v12.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 出站的回复引用（OutgoingMessage.replyTo）：onebot 只给第一条分条加引用段，v11 与 v12 各按自己的消息段写法；
// 没有 replyTo 的不加；正文里模型已经写了引用标记的，不再加第二个。本地起一个假的 OneBot 实现端记录发出的 action。
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
const GROUP = `onebot:${SELF}:group:20001`;
const TWO_PIECES = '第一句足够长的一段话。第二句也足够长的一段话。';

describe('消息段：buildSendMessage 带 replyTo', () => {
  const v11 = new OneBotV11();
  const v12 = new OneBotV12();
  const build = (protocol: OneBotV11 | OneBotV12, content: string, replyTo?: string) =>
    protocol.buildSendMessage({ detailType: 'group', targetId: '20001', content, ...(replyTo ? { replyTo } : {}) })
      .params.message;

  it('v11：引用段在最前，id 按数字给', () => {
    expect(build(v11, '好了', '12345')).toEqual([
      { type: 'reply', data: { id: 12345 } },
      { type: 'text', data: { text: '好了' } },
    ]);
  });

  it('v12：引用段在最前，写作 message_id', () => {
    expect(build(v12, '好了', '12345')).toEqual([
      { type: 'reply', data: { message_id: '12345' } },
      { type: 'text', data: { text: '好了' } },
    ]);
  });

  it('没有 replyTo 时不加；正文里已有引用标记时不再加第二个', () => {
    expect(build(v11, '好了')).toEqual([{ type: 'text', data: { text: '好了' } }]);
    expect(build(v11, '<reply id="777"/>好了', '12345')).toEqual([
      { type: 'reply', data: { id: 777 } },
      { type: 'text', data: { text: '好了' } },
    ]);
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** 假实现端 + 开着分条（切点只有句号、不延迟）的 onebot 适配器；send 交出一条出站消息并等它投递完 */
async function boot(protocol: 'v11' | 'v12') {
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
  server.on('connection', ws => {
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo?: string };
      actions.push({ action: req.action, params: req.params });
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
    });
  });

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide(storage, { listRoots: () => [] } as never);
  host.provide(processService, {} as never);
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
    splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] },
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  await app.start();
  await until(() => actions.some(a => a.action === (protocol === 'v11' ? 'get_login_info' : 'get_self_info')));

  return {
    async send(msg: OutgoingMessage) {
      await host.events.emit('outbound:message', msg);
      expect(await msg.delivery).toEqual({ ok: true });
    },
    /** 发出的各条消息的消息段 */
    sent: () =>
      actions
        .filter(a => a.action === (protocol === 'v11' ? 'send_group_msg' : 'send_message'))
        .map(a => a.params.message as Array<{ type: string; data: Record<string, unknown> }>),
  };
}

describe.each([
  ['v11' as const, { type: 'reply', data: { id: 12345 } }],
  ['v12' as const, { type: 'reply', data: { message_id: '12345' } }],
])('出站分条：%s', (protocol, reply) => {
  it('有 replyTo 时只给第一条分条加引用段', async () => {
    const t = await boot(protocol);
    await t.send({ sessionId: GROUP, content: TWO_PIECES, source: 'agent', replyTo: '12345' });
    const sent = t.sent();
    expect(sent).toHaveLength(2);
    expect(sent[0][0]).toEqual(reply);
    expect(sent[1].some(segment => segment.type === 'reply')).toBe(false);
  });

  it('没有 replyTo 时都不加', async () => {
    const t = await boot(protocol);
    await t.send({ sessionId: GROUP, content: TWO_PIECES, source: 'agent' });
    expect(t.sent()).toHaveLength(2);
    expect(
      t
        .sent()
        .flat()
        .some(segment => segment.type === 'reply'),
    ).toBe(false);
  });
});
