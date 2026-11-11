import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// onebot 适配器停用时，收尾段等展开之后在后台写的转发原文（持久化与过期清理）落定再撤回，收尾开始之后不再开始写：停用落定
// 之后不再有写入。本地启动假的 OneBot v11 实现端推一条带内嵌合并转发的私聊消息（不用拉取），记忆后端是替身，读或写转发原文
// 卡在一道闸上，用例放行；order 记下写入开始、写完与停用落定的先后。
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

/** 启动 onebot 适配器连上假的实现端，记忆后端用给定的替身，推一条带内嵌合并转发的私聊消息；交回 app */
async function receiveForward(memoryDouble: Record<string, unknown>): Promise<App> {
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
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
    });
  });

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events });
  host.provide.use(storage, { writeFile: async () => {} } as never);
  host.provide.use(processService, {} as never);
  host.provide.use(memory, memoryDouble as never);
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }],
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  await app.start();
  await expect.poll(() => actions.includes('get_login_info')).toBe(true);

  const node = {
    type: 'node',
    data: { nickname: '乙', user_id: '30002', content: [{ type: 'text', data: { text: '你好' } }] },
  };
  socket?.send(
    JSON.stringify({
      time: 0,
      post_type: 'message',
      message_type: 'private',
      self_id: Number(SELF),
      user_id: 30001,
      message_id: 1,
      message: [{ type: 'forward', data: { id: 'zz-forward', content: [node] } }],
      sender: { nickname: '甲' },
    }),
  );
  return app;
}

describe('onebot 停用时等在途的转发原文落盘', () => {
  it('转发原文写入途中停用：停用等写完才落定，之后不再有写入', async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    let reached = false;
    const app = await receiveForward({
      getMetadata: async () => undefined,
      listMetadata: async () => [],
      commitMetadata: async () => {},
      saveMetadata: async () => {
        order.push('写入开始');
        reached = true;
        await gate.promise;
        order.push('写完');
      },
    });
    await expect.poll(() => reached).toBe(true);
    const disabled = app.plugins.disable(onebotPlugin.name).then(() => {
      order.push('停用落定');
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toContain('写完');
    expect(order.at(-1)).toBe('停用落定');
  });

  it('读转发原文途中停用：读回来时收尾已开始，不再写', async () => {
    const order: string[] = [];
    const gate = deferred<void>();
    let reading = false;
    const app = await receiveForward({
      getMetadata: async () => {
        reading = true;
        await gate.promise;
        return undefined;
      },
      saveMetadata: async () => {
        order.push('写入');
      },
    });
    await expect.poll(() => reading).toBe(true);
    await app.plugins.disable(onebotPlugin.name);
    order.push('停用落定');
    gate.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual(['停用落定']);
  });
});
