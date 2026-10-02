import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvals } from '../../packages/api-approval/src/index.js';
import { authority } from '../../packages/api-authority/src/index.js';
import type { HostPaths } from '../../packages/api-host-paths/src/index.js';
import {
  SESSION_PROTOCOL_VERSION,
  type SessionItem,
  type SessionMethod,
  type SessionMethodParams,
  type SessionMethodResult,
  type SessionPeer,
  sessionMethods,
  sessionNotifications,
  sessionProtocol,
} from '../../packages/api-session-protocol/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import sessionServerPlugin from '../../packages/plugin-session-server/src/index.js';
import toolsPlugin from '../../packages/plugin-tools/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';
import { memoryStorage } from '../fixtures/paper.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的 /session：已认证的 WebSocket 接到会话协议（sessionProtocol.connect）。
// 前几组起真的 webui-server、会话服务与 agent，经真实的 WebSocket 收发；后几组把会话服务换成替身，
// 只看传输本身：身份、帧的转交、关闭码与原因、拆卸。
// ════════════════════════════════════════════════════════════

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const TOKEN = 'session-transport-test-token';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const WEBUI_CONFIG = { host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN };

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const apps: App[] = [];
const sockets: WebSocket[] = [];
const rawSockets: Socket[] = [];
/** 每个 App 一个临时家目录：会话服务的审批审计写在它下面 */
const homes: string[] = [];
/** 像 runtime 一样在根上提供 host-paths，家目录是新建的临时目录 */
function provideHome(app: App): HostPaths {
  const home = mkdtempSync(join(tmpdir(), 'aalis-session-server-'));
  homes.push(home);
  return provideHostPaths(app, home);
}
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const socket of rawSockets.splice(0)) socket.destroy();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** webui-server 在 app:ready 时才监听：等登录状态接口答得上来 */
async function listening(port: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (!res.ok) throw new Error(`状态接口回 ${res.status}`);
    },
    { timeout: 3000, interval: 20 },
  );
}

/**
 * 真的一整套：mock 模型、agent、网关、会话管理、会话服务（可以不装）与 webui-server。
 * 不装会话服务时，sessionServer() 之后再补上
 */
async function startStack({ withSessionServer = true } = {}) {
  const port = await freePort();
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  apps.push(app);
  const paths = provideHome(app);
  await registerHubs(app);
  await app.plugin(createMockLLMPlugin({ responses: [{ content: '你好呀' }] }));
  await app.plugin(toolsPlugin, {});
  await app.plugin(memoryInMemoryPlugin);
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  await app.plugin(gatewayPlugin);
  await app.plugin(agentPlugin, { systemPrompt: 'test' });
  await app.plugins.idle();
  app.bind({ provide }).provide(storage, memoryStorage(new Map()));
  await app.plugin(sessionManagerPlugin, {});
  const sessionServer = async () => {
    await app.plugin(sessionServerPlugin, {});
    await app.plugins.idle();
    expect(app.plugins.getPlugin(sessionServerPlugin.name)?.state, '会话服务未激活').toBe('active');
  };
  if (withSessionServer) await sessionServer();
  await app.plugin(webuiServer, { ...WEBUI_CONFIG, port });
  await app.plugins.idle();
  await app.start();
  await listening(port);
  return { app, port, paths, sessionServer };
}

/** 会话服务换成替身：记下每条连接的对端、收到的帧与 close 次数，send 留给用例主动发帧 */
async function startWithStub() {
  const port = await freePort();
  const app = new App({ name: 'T', logLevel: 'error', logger: silent });
  apps.push(app);
  const links: Array<{ peer: SessionPeer; received: string[]; closes: number; send(frame: string): void }> = [];
  app.bind({ provide }).provide(sessionProtocol, {
    connect(peer, send) {
      const link = { peer, received: [] as string[], closes: 0, send };
      links.push(link);
      return {
        receive: async frame => void link.received.push(frame),
        close: () => void link.closes++,
      };
    },
  });
  await app.plugin(webuiServer, { ...WEBUI_CONFIG, port });
  await app.plugins.idle();
  await app.start();
  await listening(port);
  return { app, port, links };
}

type Frame = Record<string, unknown> & { id?: unknown; method?: string; params?: Record<string, unknown> };

/** 一条 /session 连接：收到的帧原文留存，closed 在连接关闭时给出关闭码与原因 */
async function open(port: number) {
  const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/session`, {
    headers: { cookie: COOKIE },
  });
  sockets.push(ws);
  const texts: string[] = [];
  ws.onmessage = event => void texts.push(String(event.data));
  const closed = new Promise<{ code: number; reason: string }>(resolve => {
    ws.onclose = event => resolve({ code: event.code, reason: event.reason });
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('连不上 /session'));
  });
  const frames = () => texts.map(text => JSON.parse(text) as Frame);
  let nextId = 0;
  const request = async (method: string, params: unknown): Promise<Frame> => {
    const id = ++nextId;
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return vi.waitFor(() => {
      const reply = frames().find(f => f.id === id);
      if (!reply) throw new Error(`${method} 还没有回应`);
      return reply;
    });
  };
  const call = async <M extends SessionMethod>(method: M, params: SessionMethodParams<M>) => {
    const reply = await request(method, params);
    if ('error' in reply) throw new Error(`${method} 出错：${JSON.stringify(reply.error)}`);
    return sessionMethods[method].result.parse(reply.result) as SessionMethodResult<M>;
  };
  const init = () =>
    call('initialize', { protocolVersion: SESSION_PROTOCOL_VERSION, client: { name: 't', version: '0' } });
  return { ws, texts, frames, closed, call, init };
}

/** 这个会话的条目推送里 seq 大于 after 的那些，先过协议 schema */
function pushes(frames: Frame[], sessionId: string, after: number): Frame[] {
  return frames.filter(f => {
    if (f.method !== 'item/started' && f.method !== 'item/delta' && f.method !== 'item/completed') return false;
    const { sessionId: id, seq } = sessionNotifications[f.method].parse(f.params);
    return id === sessionId && seq > after;
  });
}

/** 发一个 WebSocket 升级请求：被接受时给出状态码与升级后的套接字，被拒时只有状态码 */
function upgrade(port: number, path: string, cookie?: string): Promise<{ status: number; socket?: Socket }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        ...(cookie ? { cookie } : {}),
      },
    });
    req.on('upgrade', (res, socket) => {
      rawSockets.push(socket);
      resolve({ status: res.statusCode ?? 0, socket });
    });
    req.on('response', res => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('/session 接上真的会话服务', () => {
  it('两条连接订阅同一会话，一条发消息：两边收到的条目推送一致，时间线里是这一轮', async () => {
    const { port } = await startStack();
    const a = await open(port);
    const b = await open(port);
    for (const c of [a, b]) {
      expect(await c.init()).toMatchObject({ identity: { platform: 'webui', userId: 'console' }, surface: 'webui' });
    }
    const { session } = await a.call('session/create', { name: 'S' });
    // 有标题就不在第一条消息时调模型起标题，预设的模型回复只给 agent 用
    await a.call('session/rename', { sessionId: session.id, title: 'S' });
    const snapA = await a.call('session/subscribe', { sessionId: session.id });
    const snapB = await b.call('session/subscribe', { sessionId: session.id });

    await a.call('turn/send', { sessionId: session.id, content: '你好' });
    const outcome = (c: typeof a) =>
      pushes(c.frames(), session.id, 0).flatMap(f => {
        if (f.method !== 'item/completed') return [];
        const { item } = sessionNotifications['item/completed'].parse(f.params);
        return item.kind === 'turn' ? [item.outcome] : [];
      });
    await vi.waitFor(() => {
      expect(outcome(a)).toContain('replied');
      expect(outcome(b)).toContain('replied');
    });

    // b 订阅得晚：从它的快照往后，两边收到的推送逐帧相同
    await vi.waitFor(() =>
      expect(pushes(a.frames(), session.id, snapB.seq)).toEqual(pushes(b.frames(), session.id, snapB.seq)),
    );
    const items = new Map<string, SessionItem>(snapA.items.map(item => [item.itemId, item]));
    for (const f of pushes(a.frames(), session.id, snapA.seq)) {
      if (f.method !== 'item/delta') {
        const { item } = sessionNotifications['item/completed'].parse(f.params);
        items.set(item.itemId, item);
      }
    }
    const content = [...items.values()].flatMap(
      (i): Array<Record<string, unknown>> =>
        i.kind === 'user-message' || i.kind === 'agent-message'
          ? [{ kind: i.kind, text: i.text }]
          : i.kind === 'turn'
            ? [{ kind: i.kind, outcome: i.outcome }]
            : [],
    );
    expect(content).toEqual([
      { kind: 'user-message', text: '你好' },
      { kind: 'turn', outcome: 'replied' },
      { kind: 'agent-message', text: '你好呀' },
    ]);
  });

  it('webui 审批面：在场上报与应答经 /session 连接到达，审计里的审批面是 webui-server 登记的', async () => {
    const { app, port, paths } = await startStack();
    const host = app.bind({ provide, approvals });
    host.provide(authority, { isOwner: (p: string, u?: string) => p === 'webui' && u === 'console' } as never);
    const c = await open(port);
    expect(await c.init()).toMatchObject({ surface: 'webui' });
    const { session } = await c.call('session/create', { name: 'S' });
    await c.call('presence/update', { active: true });

    const outcome = host.approvals.require().request({
      sessionId: session.id,
      origin: { kind: 'owner', platform: 'webui', userId: 'console' },
      tool: 'exec',
      args: { command: 'ls' },
      rule: 'tool:exec 声明需确认',
    });
    const { approval } = await vi.waitFor(() => {
      const frame = c.frames().find(f => f.method === 'approval/requested');
      if (!frame) throw new Error('还没收到审批');
      return sessionNotifications['approval/requested'].parse(frame.params);
    });
    await c.call('approval/respond', {
      approvalId: approval.id,
      decision: 'approve',
      contentHash: approval.contentHash,
    });
    expect(await outcome).toEqual({ approvalId: approval.id, approved: true });

    const audit = join(paths.state, 'audit', 'approvals.jsonl');
    const lines = await vi.waitFor(() => {
      const read = readFileSync(audit, 'utf8').split('\n').filter(Boolean);
      expect(read).toHaveLength(2);
      return read.map(line => JSON.parse(line) as Record<string, unknown>);
    });
    expect(lines[1]).toMatchObject({
      responder: { platform: 'webui', userId: 'console' },
      surface: { name: 'webui', plugin: '@aalis/plugin-webui-server' },
    });
  });

  it('会话服务不在：连接以 1013 关闭并写明原因，不挂起；会话服务上线后新连接照常握手，不用重启 webui-server', async () => {
    const { port, sessionServer } = await startStack({ withSessionServer: false });
    const early = await open(port);
    expect(await early.closed).toEqual({ code: 1013, reason: '会话服务不在' });

    await sessionServer();
    const late = await open(port);
    expect(await late.init()).toMatchObject({ protocolVersion: SESSION_PROTOCOL_VERSION });
  });

  it('会话服务停止：已有的连接以 1000 关闭，原因是会话服务给的', async () => {
    const { app, port } = await startStack();
    const c = await open(port);
    await c.init();
    await app.plugins.disable(sessionServerPlugin.name);
    expect(await c.closed).toEqual({ code: 1000, reason: '会话服务已停止' });
  });
});

describe('/session 的传输', () => {
  it('升级请求：没有 token 或 token 不对回 401，不透露有哪些路径；认证之后只认 /session 与 /ws，别的路径回 404', async () => {
    const { port } = await startWithStub();
    expect((await upgrade(port, '/session')).status).toBe(401);
    expect((await upgrade(port, '/session', 'aalis_webui_token=wrong')).status).toBe(401);
    expect((await upgrade(port, '/nope')).status).toBe(401);
    expect((await upgrade(port, '/nope', COOKIE)).status).toBe(404);
    expect((await upgrade(port, '/session/x', COOKIE)).status).toBe(404);
    expect((await upgrade(port, '/session?v=1', COOKIE)).status).toBe(101);
    expect((await upgrade(port, '/ws', COOKIE)).status).toBe(101);
  });

  it('连接原样接到会话服务：身份取自认证、审批面是登记的 webui，帧原文双向转交，对端关闭时撤掉连接', async () => {
    const { port, links } = await startWithStub();
    const c = await open(port);
    await vi.waitFor(() => expect(links).toHaveLength(1));
    const [link] = links;
    expect(link.peer.identity).toEqual({ platform: 'webui', userId: 'console' });
    expect(link.peer.surface.name).toBe('webui');

    c.ws.send('第一帧，不必是 JSON');
    c.ws.send('{"jsonrpc":"2.0"}');
    await vi.waitFor(() => expect(link.received).toEqual(['第一帧，不必是 JSON', '{"jsonrpc":"2.0"}']));
    link.send('服务端的一帧');
    await vi.waitFor(() => expect(c.texts).toEqual(['服务端的一帧']));

    c.ws.close();
    await c.closed;
    await vi.waitFor(() => expect(link.closes).toBe(1));
  });

  it('会话服务要断开时以 1000 关闭并带上原因；原因超过 123 字节时整字截短', async () => {
    const { port, links } = await startWithStub();
    const plain = await open(port);
    const long = await open(port);
    await vi.waitFor(() => expect(links).toHaveLength(2));

    links[0].peer.disconnect('会话服务已停止');
    expect(await plain.closed).toEqual({ code: 1000, reason: '会话服务已停止' });
    // 40 个三字节的字加一个 a 是 121 字节，再多一个字就超了：不能切在字的中间
    links[1].peer.disconnect(`${'协'.repeat(40)}a${'协'.repeat(10)}`);
    expect(await long.closed).toEqual({ code: 1000, reason: `${'协'.repeat(40)}a` });
  });

  it('webui-server 卸载：/session 的连接以 1001 关闭，会话服务那头的连接随之撤掉', async () => {
    const { app, port, links } = await startWithStub();
    const c = await open(port);
    await vi.waitFor(() => expect(links).toHaveLength(1));
    await app.plugins.disable(webuiServer.name);
    expect(await c.closed).toEqual({ code: 1001, reason: 'webui 正在卸载' });
    await vi.waitFor(() => expect(links[0].closes).toBe(1));
  });

  it('畸形帧（文本帧里是坏 UTF-8）：连接以 1007 关闭，进程不出未捕获的异常', async () => {
    const { port, links } = await startWithStub();
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => void uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const { status, socket } = await upgrade(port, '/session', COOKIE);
      expect(status).toBe(101);
      await vi.waitFor(() => expect(links).toHaveLength(1));
      const received: Buffer[] = [];
      socket?.on('data', chunk => void received.push(chunk));
      // 客户端发的帧要加掩码：FIN + 文本帧，两字节载荷 0xff 0xfe 不是合法的 UTF-8
      const mask = [1, 2, 3, 4];
      const payload = [0xff, 0xfe].map((byte, i) => byte ^ mask[i % 4]);
      socket?.write(Buffer.from([0x81, 0x80 | payload.length, ...mask, ...payload]));
      // 服务端回关闭帧：0x88，关闭码 1007
      await vi.waitFor(() => {
        const head = Buffer.concat(received);
        expect([head[0], head.readUInt16BE(2)]).toEqual([0x88, 1007]);
      });
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
