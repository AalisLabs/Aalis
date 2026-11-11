import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { claimantsOf, platform } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 子会话没有窗口：它的 id 由会话管理给，不是哪个平台的窗口 id，平台适配器不认领它，出站不交给平台。父会话靠子任务的
// 结果与提醒拿到结果，WebUI 经会话服务的时间线看子会话。此前子会话的 id 是「父会话 id::随机串」：群里建的子任务，
// 她的回复由 onebot 按 id 里的账号认领，目标拆成「群号::随机串」发出。本地启动一个假的 OneBot 实现端。
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
const GROUP = `onebot:${SELF}:group:20001`;
/** 没实现 canHandle 的平台：按 `zz:` 前缀兜底认领 */
const PREFIX_ROOM = 'zz:room-1';

const prefixAdapter = definePlugin({
  name: 'zz-adapter-prefix',
  provides: [platform],
  uses: { provide },
  apply: ({ provide }) => {
    provide.use(platform, { adapterName: 'ZZ', platform: 'zz', getConnections: () => [], sendMessage: async () => {} });
  },
});

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

/** 假实现端（一律回成功）+ onebot 适配器 + 按前缀兜底的适配器 + 会话管理 */
async function boot() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanups.push(
    () =>
      new Promise<void>(resolve => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const actions: string[] = [];
  server.on('connection', ws => {
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { echo?: string; action: string };
      actions.push(req.action);
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
    });
  });

  const app = new App({ name: 'T', logLevel: 'error' });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events, platform, sessionManager });
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  host.provide.use(memory, fakeMemory() as never);
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol: 'v11', selfId: SELF }],
  });
  await app.plugin(prefixAdapter);
  await app.plugin(sessionManagerPlugin);
  await app.plugins.idle();
  for (const name of [onebotPlugin.name, prefixAdapter.name, sessionManagerPlugin.name]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  await app.start();
  await until(() => actions.includes('get_login_info'));

  return {
    sm: host.sessionManager.use,
    platforms: host.platform,
    /** 交出一条她的回复，返回这条消息（回执在它的 delivery 上） */
    async send(sessionId: string) {
      const msg: OutgoingMessage = { sessionId, platform: 'onebot', content: '<回复>', source: 'agent', markup: true };
      await host.events.use.emit('outbound:message', msg);
      return msg;
    },
  };
}

describe('子会话的出站不交给平台', () => {
  it('群里建的子任务：她的回复不交给 onebot，不往群里发；群本身照常发', async () => {
    const t = await boot();
    const child = await t.sm.createChildSession(GROUP, { name: '<子任务>' });

    expect(await (await t.send(GROUP)).delivery).toEqual({ ok: true });
    expect((await t.send(child.id)).delivery).toBeUndefined();
  });

  it('子会话的 id 不归任何平台：按账号认领的 onebot 与按前缀兜底的适配器都不认领', async () => {
    const t = await boot();

    for (const parent of [GROUP, PREFIX_ROOM]) {
      expect(await claimantsOf(t.platforms, parent), parent).toHaveLength(1);
      const child = await t.sm.createChildSession(parent);
      expect(await claimantsOf(t.platforms, child.id), `${parent} 的子会话`).toEqual([]);
    }
  });
});
