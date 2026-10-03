import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import {
  type WebuiAdminClientMessage,
  type WebuiAdminEvent,
  webuiClient,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import {
  App,
  type AppOptions,
  DefaultLogger,
  definePlugin,
  type Logger,
  LogHub,
  provide,
  services,
} from '../../packages/core/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { freePort, upgrade, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的 /admin：会话之外的管理面事件推送。起真的 webui-server，经真实的 WebSocket 收发：
// 认证、日志的订阅与退订、插件与页面登记表变化、重启与换前端，以及多个标签页的连接都是 WebSocket 升级。
// 事件只有 TypeScript 类型，帧的形状在这里逐字核对。末尾一组是各端点共用的升级来源校验。
// ════════════════════════════════════════════════════════════

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const TOKEN = 'admin-channel-test-token-00000000';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const WEBUI_CONFIG = { host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN };

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const sockets: WebSocket[] = [];
const rawSockets: Socket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const socket of rawSockets.splice(0)) socket.destroy();
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 在 app 上装 webui-server（前面的插件由 setup 装）并启动 */
async function start(app: App, setup?: (app: App) => Promise<void>) {
  apps.push(app);
  const port = await freePort();
  await setup?.(app);
  await app.plugin(webuiServerPlugin, { ...WEBUI_CONFIG, port });
  await app.plugins.idle();
  await app.start();
  await waitListening(port);
  return port;
}

const quietApp = (options: Partial<AppOptions> = {}) =>
  new App({ name: 'T', logLevel: 'error', logger: silent, ...options });

/** 一条 /admin 连接：收到的事件按到达顺序留存 */
async function openAdmin(port: number) {
  const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/admin`, {
    headers: { cookie: COOKIE },
  });
  sockets.push(ws);
  const events: WebuiAdminEvent[] = [];
  ws.onmessage = event => void events.push(JSON.parse(String(event.data)) as WebuiAdminEvent);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连不上 /admin'));
  });
  const send = (message: WebuiAdminClientMessage | string) =>
    ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  const logs = () => events.flatMap(e => (e.type === 'log' ? [e.entry.message] : []));
  const count = (type: WebuiAdminEvent['type']) => events.filter(e => e.type === type).length;
  return { ws, events, send, logs, count };
}

describe('/admin 管理面推送', () => {
  it('升级请求：没有 token 或 token 不对回 401，带 token 的接受', async () => {
    const port = await start(quietApp());
    expect((await upgrade(port, '/admin', {}, rawSockets)).status).toBe(401);
    expect((await upgrade(port, '/admin', { cookie: 'aalis_webui_token=wrong' }, rawSockets)).status).toBe(401);
    expect((await upgrade(port, '/admin', { cookie: COOKIE }, rawSockets)).status).toBe(101);
  });

  it('日志：订阅之后才推、退订之后不推，可以再订阅；认不出的消息只告警，连接照常', async () => {
    // webui-server 自己的告警进这个中枢；推给页面的日志取进程级的默认中枢，探针往那里写
    const hub = new LogHub();
    const warns: string[] = [];
    hub.onEntry(e => {
      if (e.level === 'warn' && e.message.startsWith('WebUI /admin')) warns.push(e.message);
    });
    const port = await start(new App({ name: 'T', logLevel: 'warn', logHub: hub }));
    const probe = new DefaultLogger('admin-probe', 'info');
    const a = await openAdmin(port);
    const b = await openAdmin(port);

    /** 同一条连接上的消息按序处理：垫一条认不出的消息，它的告警出来时，之前的消息都已生效 */
    const settled = async (conn: typeof a) => {
      const before = warns.length;
      conn.send('不是 JSON');
      await vi.waitFor(() => expect(warns.length).toBe(before + 1));
    };

    a.send(JSON.stringify({ type: 'nope' }));
    await vi.waitFor(() => expect(warns).toEqual(['WebUI /admin 收到认不出的消息，已忽略']));
    a.send({ type: 'log.subscribe' });
    await settled(a);
    probe.info('探针一');
    await vi.waitFor(() => expect(a.logs()).toEqual(['探针一']));
    expect(a.events.find(e => e.type === 'log')).toEqual({
      type: 'log',
      entry: {
        seq: expect.any(Number),
        timestamp: expect.any(String),
        level: 'info',
        scope: 'admin-probe',
        message: '探针一',
      },
    });

    a.send({ type: 'log.unsubscribe' });
    await settled(a);
    probe.info('探针二');
    // 一条连接上的推送按序到达：重新订阅后的探针三到了，之前的探针二要推就已经到了
    a.send({ type: 'log.subscribe' });
    await settled(a);
    probe.info('探针三');
    await vi.waitFor(() => expect(a.logs()).toEqual(['探针一', '探针三']));

    // 没订阅的 b 一条也没收到：它订阅之后的探针四是它收到的第一条
    b.send({ type: 'log.subscribe' });
    await settled(b);
    probe.info('探针四');
    await vi.waitFor(() => expect(b.logs()).toEqual(['探针四']));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('插件停用与启用之后都推 plugins.changed', async () => {
    const probePlugin = definePlugin({ name: 'admin-probe-plugin', apply() {} });
    const app = quietApp();
    const port = await start(app, async app => void (await app.plugin(probePlugin)));
    const a = await openAdmin(port);

    await app.plugins.disable(probePlugin.name);
    await vi.waitFor(() => expect(a.count('plugins.changed')).toBeGreaterThanOrEqual(1));
    const afterDisable = a.count('plugins.changed');
    await app.plugins.enable(probePlugin.name);
    await vi.waitFor(() => expect(a.count('plugins.changed')).toBeGreaterThan(afterDisable));
    expect(new Set(a.events.map(e => JSON.stringify(e)))).toEqual(new Set(['{"type":"plugins.changed"}']));
  });

  it('页面登记与撤回：插件状态不变，也各推一次 plugins.changed', async () => {
    const app = quietApp();
    const port = await start(app);
    const a = await openAdmin(port);
    const pages = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/pages`, { headers: { cookie: COOKIE } });
      return ((await res.json()) as { pages: Array<{ key: string }> }).pages.map(p => p.key);
    };
    const service = app.bind({ services }).services.get(webuiServer)!;

    const before = a.count('plugins.changed');
    const off = service.addPage(
      { key: 'probe-page', title: '探针页', content: [{ type: 'markdown', id: 'm', data: () => '' }] },
      'admin-page-owner',
    );
    await vi.waitFor(() => expect(a.count('plugins.changed')).toBe(before + 1));
    expect(await pages()).toContain('probe-page');
    off();
    await vi.waitFor(() => expect(a.count('plugins.changed')).toBe(before + 2));
    expect(await pages()).not.toContain('probe-page');
  });

  it('应用即将重启：推 app.restarting', async () => {
    const app = quietApp({ restartStrategy: { restart() {} } });
    const port = await start(app);
    const a = await openAdmin(port);
    app.restart();
    await vi.waitFor(() => expect(a.events).toContainEqual({ type: 'app.restarting' }));
  });

  it('切换前端：推 client.reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aalis-admin-client-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>A</title>');
    const client = definePlugin({
      name: 'admin-client-a',
      provides: [webuiClient],
      uses: { provide },
      apply({ provide }) {
        provide(webuiClient, { getClientDir: () => dir });
      },
    });
    const { app } = hostedApp({}, { logger: silent });
    const port = await start(app, async app => void (await app.plugin(client)));
    const a = await openAdmin(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/services/webui-client/prefer`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({ contextId: client.name }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(a.events).toContainEqual({ type: 'client.reload' }));
  });

  it('8 个标签页的 /admin 与 /session 都是 WebSocket 升级（101），不占浏览器对每个主机约 6 条的 HTTP 连接', async () => {
    const app = quietApp();
    // /session 接到一个只收不发的会话服务替身，连接一直开着
    app.bind({ provide }).provide(sessionProtocol, {
      connect: () => ({ receive: async () => {}, close() {} }),
      resolveFile: () => undefined,
    });
    const port = await start(app);
    for (let tab = 0; tab < 8; tab++) {
      expect((await upgrade(port, '/admin', { cookie: COOKIE }, rawSockets)).status).toBe(101);
      expect((await upgrade(port, '/session', { cookie: COOKIE }, rawSockets)).status).toBe(101);
    }
  });
});

describe('WebSocket 升级的来源校验', () => {
  it('/session、/admin：同源与不带 Origin 的接受；跨源回 403，同一主机的别的端口、换个主机名、Origin 为 null 都算跨源', async () => {
    const port = await start(quietApp());
    const crossOrigins = [`http://127.0.0.1:${port + 1}`, `http://localhost:${port}`, 'https://evil.example', 'null'];
    for (const path of ['/session', '/admin']) {
      const sameOrigin = { cookie: COOKIE, origin: `http://127.0.0.1:${port}` };
      expect((await upgrade(port, path, sameOrigin, rawSockets)).status).toBe(101);
      expect((await upgrade(port, path, { cookie: COOKIE }, rawSockets)).status).toBe(101);
      for (const origin of crossOrigins) {
        const { status } = await upgrade(port, path, { cookie: COOKIE, origin }, rawSockets);
        expect(status, `${path} ${origin}`).toBe(403);
      }
    }
  });
});
