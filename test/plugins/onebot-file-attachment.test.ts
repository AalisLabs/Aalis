import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authority, type OriginTurn } from '../../packages/api-authority/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { callPlatformAction, platform } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { type SessionInfo, sessionManager, TAKE_UNKNOWN } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { type MergeContext, notAccepted, readHistory } from '../../packages/plugin-session-server/src/history.js';
import { t as storageTexts } from '../../packages/plugin-storage-local/src/texts.js';
import { isTextRef, TextError, toSource } from '../../packages/schema-i18n/src/index.js';
import {
  type IncomingMessage,
  type Message,
  type MessageAttachment,
  type OutboundDeliveryResult,
  type OutgoingMessage,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';

// ════════════════════════════════════════════════════════════
// onebot 出站的文件附件与内联前的文件头核对。
//
// file 附件经 upload_group_file / upload_private_file 发出，内容只收 base64://：超过内联上限的存储文件
// attachmentToOneBotFile 会退回 file://<宿主路径>，容器里的 NapCat 读不到，一律拒发。超过内联上限的网址附件（不论类型）
// 一律拒发，原网址不交给实现端去拉。
// image、audio、video 按文件头分流：NapCat 能内联的格式走消息段；send_attachment 白名单里其余的媒体
// （BMP、AVIF、HEIC 图片，MKV、AVI 视频）改经文件上传，不静默丢弃；不是媒体的（如配置文本）拒发，
// 免得任意可读文件冒充媒体发出。没发出去的附件，agent 发出的消息在会话记忆里留投递失败记录。
// 带 markup 的正文（她的回复）里存储地址的媒体标记经网关派发时由 image-sender 转成附件：按回复所在那一轮的授权身份过媒体
// 判据（不是回合里的不带授权身份），都核文件头。它只摘掉转成了附件的标记，没转成的与别的写法留在正文里：网址的由适配器下载
// 内联，其余由适配器去掉、投递报失败（会话表、取用规则与 owner 判定是替身：私聊的对端与 WebUI 的 console 是 owner，取用规则
// 一律不放行）。一条回复里的媒体（网址的标记与转成的附件合计）最多发 10 个，附件同时最多读 4 个。入站的引用与撤回按存档反查原文时，按归档时记下的标签去掉发送者前缀。
// 发送不重试：没等到回执（超时、回执前断线）的记结果未知；逐条发出时一条没发成就停，投递结果与回报写明前几条已发出。实现端回
// 失败时报错带返回码，「不支持该动作」另标出来；合并转发只按 id 拉，缓存命中时带截断标志与收到它的会话，没展开过的交回收到它的
// 会话与现拉的办法、不先拉。
// 本地起一个假的 OneBot 实现端（WebSocket 服务）记录适配器发出的 action。
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

const MIB = 1024 * 1024;
const SELF = '10000';
const GROUP = `onebot:${SELF}:group:20001`;
const PRIVATE = `onebot:${SELF}:private:30001`;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(24)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
const HTML = Buffer.from('<!doctype html><title>占位报告</title><p>占位</p>');
const le32 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const be32 = (n: number) => Buffer.from([n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
/** ISO 基础媒体文件的 ftyp 盒：主品牌、次版本 0、兼容品牌表，后面补零 */
const ftyp = (major: string, ...compatible: string[]) =>
  Buffer.concat([
    be32(16 + 4 * compatible.length),
    Buffer.from(`ftyp${major}`),
    Buffer.alloc(4),
    Buffer.from(compatible.join('')),
    Buffer.alloc(24),
  ]);
/** EBML 头：版本字段后接 DocType（0x4282 + 一字节长度 + 名字），后面补零 */
const ebml = (docType: string) =>
  Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]),
    Buffer.from([0x42, 0x82, 0x80 | docType.length]),
    Buffer.from(docType),
    Buffer.alloc(24),
  ]);
const BMP = Buffer.concat([Buffer.from('BM'), le32(58), Buffer.alloc(4), le32(54), le32(40), Buffer.alloc(24)]);
const AVIF = ftyp('avif', 'avif', 'mif1', 'miaf', 'MA1B');
const HEIC = ftyp('heic', 'mif1', 'heic');
const MKV = ebml('matroska');
const AVI = Buffer.concat([Buffer.from('RIFF'), le32(4096), Buffer.from('AVI LIST'), Buffer.alloc(24)]);
const MOV = ftyp('qt  ', 'qt  ');
const WEBM = ebml('webm');
const M4A = ftyp('M4A ', 'M4A ', 'mp42', 'isom');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(24)]);
const CONFIG = Buffer.from('llm:\n  apiKey: <占位 key>\n');

let httpServer: Server;
let httpBase: string;

beforeAll(async () => {
  setNetworkPolicy({ blockPrivate: false }); // 只为连本机测试服务；afterAll 复原
  httpServer = createServer((req, res) => {
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) });
      res.end(PNG);
      return;
    }
    if (req.url === '/method.png') {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/big.html') {
      const body = Buffer.alloc(10 * MIB + 1, 0x61);
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(body.byteLength) });
      res.end(body);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  httpBase = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setNetworkPolicy({ blockPrivate: true });
  httpServer.closeAllConnections();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
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

/**
 * 内存 storage：data 根可写（出站附件落盘用），aalis 根只读（占位的配置文件所在）；别的根抛 storage-local 的「未知存储根」
 * （它的字典里同一句，TextError）。reads 记整份读取的在途数与峰值，每次读等 delayMs
 */
function memStorage(files: Map<string, Buffer>, reads: { delayMs: number; inFlight: number; peak: number }) {
  const root = (name: string, writable: boolean) => ({
    name,
    label: name,
    kind: name,
    browsable: true,
    readable: true,
    writable,
    deletable: false,
  });
  const get = (uri: string) => {
    const name = uri.slice(0, uri.indexOf(':/'));
    if (name !== 'data' && name !== 'aalis') {
      throw new TextError(storageTexts('unknownRoot', { root: name, roots: 'data, aalis' }));
    }
    const f = files.get(uri);
    if (!f) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
    return f;
  };
  return {
    listRoots: () => [root('data', true), root('aalis', false)],
    async stat(uri: string) {
      return { size: get(uri).byteLength, isDirectory: false };
    },
    async readFile(uri: string) {
      reads.peak = Math.max(reads.peak, ++reads.inFlight);
      try {
        if (reads.delayMs) await new Promise(r => setTimeout(r, reads.delayMs));
        return get(uri);
      } finally {
        reads.inFlight--;
      }
    },
    async readFileRange(uri: string, start: number, end: number) {
      return get(uri).subarray(start, end);
    },
    async writeFile(uri: string, data: Uint8Array) {
      files.set(uri, Buffer.from(data));
    },
    async resolveLocalPath(uri: string) {
      return `/host/${uri.replace(':/', '/')}`;
    },
  };
}

interface Action {
  action: string;
  params: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;

/**
 * imageSender 为真时另装 plugin-image-sender，经 sendAttachment 调它的 send_attachment；gateway 为真时另装网关，经 dispatch
 * 派发出站，会话表里有 GROUP 与 PRIVATE、PRIVATE 的对端与 WebUI 的 console 是 owner，owner 在 onebot 登记的账号是 PRIVATE 的
 * 对端（sessions 为假时不装会话管理）；post 从实现端推一个 v11 事件，inbound 是适配器发出的入站。replyToSend 是实现端怎么回
 * 发送与上传：failText 只让发消息失败、上传照常成功。failSendAt 让第 N 次 send_* 回失败，failActions 让这些动作回给定的返回码
 * 与原话。config 并进适配器的配置。media 是 media 服务的替身，只给出站会调到的那个方法。callAction 经平台路由调 GROUP 所在
 * 实例的动作，drop 断开实现端的连接
 */
async function boot(
  opts: {
    protocol?: 'v11' | 'v12';
    files?: Record<string, Buffer>;
    imageSender?: boolean;
    gateway?: boolean;
    sessions?: boolean;
    replyToSend?: 'ok' | 'fail' | 'failText' | 'hold';
    failSendAt?: number;
    failActions?: Record<string, { retcode: number; message: string }>;
    config?: Record<string, unknown>;
    media?: { rememberDescriptionAlias(source: string, landedRef: string): void };
    /** 每次整份读取存储文件等多久（毫秒） */
    readDelayMs?: number;
  } = {},
) {
  const protocol = opts.protocol ?? 'v11';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  cleanups.push(
    () =>
      new Promise<void>(r => {
        for (const c of server.clients) c.terminate();
        server.close(() => r());
      }),
  );
  const actions: Action[] = [];
  const heldReplies: Array<() => void> = [];
  let socket: WsSocket | undefined;
  let sends = 0;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as Action & { echo?: string };
      actions.push({ action: req.action, params: req.params });
      if (req.echo) {
        const reply = (status: 'ok' | 'failed', failure = { retcode: 100, message: 'fake send failure' }) =>
          ws.send(
            JSON.stringify({
              status,
              retcode: status === 'ok' ? 0 : failure.retcode,
              message: status === 'ok' ? undefined : failure.message,
              data: { user_id: SELF },
              echo: req.echo,
            }),
          );
        const failure = opts.failActions?.[req.action];
        if (/^send_/.test(req.action)) sends++;
        const fails =
          (/^(send_|upload_)/.test(req.action) && opts.replyToSend === 'fail') ||
          (/^send_/.test(req.action) && (opts.replyToSend === 'failText' || sends === opts.failSendAt));
        if (failure) reply('failed', failure);
        else if (/^(send_|upload_)/.test(req.action) && opts.replyToSend === 'hold')
          heldReplies.push(() => reply('ok'));
        else reply(fails ? 'failed' : 'ok');
      }
    });
  });

  const warns: string[] = [];
  const logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    child: () => logger,
  } as unknown as Logger;
  const app = new App({ name: 'T', logLevel: 'error', logger });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events, platform });
  const files = new Map<string, Buffer>(Object.entries(opts.files ?? {}));
  const reads = { delayMs: opts.readDelayMs ?? 0, inFlight: 0, peak: 0 };
  host.provide.use(storage, memStorage(files, reads) as never);
  if (opts.media) host.provide.use(media, opts.media as never);
  // 转码一律失败：语音附件保留原数据，直接走内联前的文件头核对
  host.provide.use(processService, {
    async makeTempDir() {
      throw new Error('测试里不转码');
    },
    // 同 process-local：先量大小，超过上限就抛错；宿主路径按 memStorage.resolveLocalPath 的写法映射回 storage
    async readExternalFile(path: string, maxBytes?: number) {
      const uri = path.replace(/^file:\/\/\/host\//, '').replace('/', ':/');
      const f = files.get(uri);
      if (!f) throw new Error(`ENOENT: ${path}`);
      if (maxBytes !== undefined && f.byteLength > maxBytes) throw new Error('外部文件超过上限');
      return f;
    },
  } as never);
  const delivered: OutgoingMessage[] = [];
  host.events.use.on('outbound:delivered', msg => void delivered.push(msg));
  const inbound: IncomingMessage[] = [];
  host.events.use.on('inbound:message', msg => void inbound.push(msg));
  // 存档用真的：送达之后的快照由它记进会话历史，记忆是只记写入的替身
  const notes: Array<{ sessionId: string; message: Message }> = [];
  host.provide.use(memory, {
    async saveMessage(sessionId: string, message: Message) {
      notes.push({ sessionId, message });
    },
    getHistory: async (sessionId: string) => notes.filter(n => n.sessionId === sessionId).map(n => n.message),
    clearSession: async () => {},
  } as unknown as MemoryService);
  await app.plugins.register(messageArchivePlugin, { debugLogs: false });
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
    ...opts.config,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  if (opts.gateway) {
    if (opts.sessions !== false) {
      const rooms = new Map([GROUP, PRIVATE].map(id => [id, storedRoom(id) as unknown as SessionInfo]));
      host.provide.use(sessionManager, {
        getSession: (id: string) => rooms.get(id),
        listSessions: () => [...rooms.values()],
        canTake: () => ({ ok: false, reason: TAKE_UNKNOWN }),
      } as never);
    }
    const isOwner = (p: string, u?: string) => (p === 'onebot' && u === '30001') || (p === 'webui' && u === 'console');
    host.provide.use(authority, {
      isOwner,
      ownerOn: (p: string) => (p === 'onebot' ? { userId: '30001' } : undefined),
      principalOf: (turn: OriginTurn) => principalKind(turn, isOwner),
    } as never);
    await app.plugins.register(gatewayPlugin);
    await app.plugins.idle();
  }
  const toolHandlers = new Map<string, ToolHandler>();
  if (opts.imageSender) {
    host.provide.use(tools, {
      register: (tool: { definition: { function: { name: string } }; handler: ToolHandler }) => {
        toolHandlers.set(tool.definition.function.name, tool.handler);
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
    await app.plugins.register(imageSenderPlugin);
    await app.plugins.idle();
    if (app.plugins.getPlugin(imageSenderPlugin.name)?.state !== 'active') throw new Error('image-sender 未激活');
  }
  await app.start(); // app:ready 时连接
  const selfInfo = protocol === 'v11' ? 'get_login_info' : 'get_self_info';
  await until(() => actions.some(a => a.action === selfInfo));

  const sent = () => actions.filter(a => /^(send_|upload_)/.test(a.action));
  // 每条出站消息各自在后台投递，先交出的不一定先发完；flush 靠这些回执等它们结束。
  const deliveries: Array<Promise<unknown>> = [];
  const send = async (msg: OutgoingMessage) => {
    await host.events.use.emit('outbound:message', msg);
    if (msg.delivery) deliveries.push(msg.delivery);
  };
  /** 经网关派发（outbound:dispatch 中间件链先跑），投递结果同 send 一样记下 */
  const dispatch = async (msg: OutgoingMessage) => {
    await app.bind({ gateway }).gateway.use.dispatchOutbound(msg);
    if (msg.delivery) deliveries.push(msg.delivery);
  };
  /** 她在一轮里的回复：这一轮的输入是 input，回复带这一轮的回合 id 经网关派发 */
  const dispatchInTurn = (msg: OutgoingMessage, input: IncomingMessage) => {
    const turnId = `turn-${input.userId ?? 'none'}`;
    msg.turnId = turnId;
    return app
      .bind({ hooks })
      .hooks.use.run('agent:turn:before', { turnId, sessionId: msg.sessionId, inputs: [{ message: input }] }, () =>
        dispatch(msg),
      );
  };
  /** 等此前经 send 交出的消息都有了投递结果，再发一条哨兵文字并等它到达 */
  const flush = async (sessionId = GROUP) => {
    await Promise.allSettled(deliveries.splice(0));
    await send({ sessionId, content: '哨兵' });
    await until(() => JSON.stringify(sent()).includes('哨兵'));
  };
  const failureNotes = () => notes.filter(n => n.message.kind === WellKnownKinds.OutboundDeliveryFailed);
  const imageNotes = () => notes.filter(n => n.message.kind === 'outbound-image');
  const sendAttachment = async (args: Record<string, unknown>, sessionId = GROUP, signal?: AbortSignal) => {
    const handler = toolHandlers.get('send_attachment');
    if (!handler) throw new Error('send_attachment 未注册');
    return JSON.parse(await handler(args, { sessionId, platform: 'onebot', signal } as ToolCallContext)) as Record<
      string,
      unknown
    >;
  };
  /** 从实现端推一个 v11 事件 */
  const post = (event: Record<string, unknown>) =>
    socket?.send(JSON.stringify({ self_id: Number(SELF), time: 0, ...event }));
  const callAction = (action: string, params: Record<string, unknown>) =>
    callPlatformAction(host.platform, GROUP, action, params);
  const drop = () => {
    for (const c of server.clients) c.terminate();
  };
  return {
    actions,
    files,
    reads,
    sent,
    send,
    post,
    callAction,
    drop,
    inbound,
    archive: () => app.bind({ messageArchive }).messageArchive.use,
    dispatch,
    dispatchInTurn,
    flush,
    warns,
    notes,
    delivered,
    failureNotes,
    imageNotes,
    heldReplies,
    sendAttachment,
  };
}

const decode = (file: unknown) => Buffer.from(String(file).slice('base64://'.length), 'base64');
/** 投递结果没成时的原因的原文（给模型的读者取的就是它）；成了或没有结果为 undefined */
const reasonOf = (result: OutboundDeliveryResult | undefined) =>
  result?.ok === false ? toSource(result.error) : undefined;

describe('onebot 出站：文件附件', () => {
  it('群会话：文字与消息段先发，文件随后经 upload_group_file 以 base64:// 上传，不进消息段', async () => {
    const t = await boot({ files: { 'data:/out/a.html': HTML, 'data:/out/a.png': PNG } });
    await t.send({
      sessionId: GROUP,
      content: '文件在这',
      attachments: [
        { kind: 'image', data: 'data:/out/a.png' },
        { kind: 'file', data: 'data:/out/a.html', name: '占位报告.html' },
      ],
    });
    await until(() => t.sent().some(a => a.action === 'upload_group_file'));

    const sent = t.sent();
    const upload = sent.find(a => a.action === 'upload_group_file');
    expect(upload?.params.group_id).toBe(20001);
    expect(String(upload?.params.file).startsWith('base64://')).toBe(true);
    expect(decode(upload?.params.file).equals(HTML)).toBe(true);
    expect(upload?.params.name).toBe('占位报告.html');

    const messages = sent.filter(a => a.action === 'send_group_msg');
    expect(messages.length).toBeGreaterThan(0);
    expect(sent.indexOf(upload as Action), '文件在文字与消息段之后上传').toBeGreaterThan(
      sent.indexOf(messages[messages.length - 1]),
    );
    const segmentTypes = messages.flatMap(m => (m.params.message as Array<{ type: string }>).map(s => s.type));
    expect(segmentTypes).toContain('image');
    expect(segmentTypes, '文件不以消息段发出').not.toContain('file');
    expect(JSON.stringify(messages)).not.toContain(HTML.toString('base64'));
    // 送达快照：文字发出了，带 content
    await until(() => t.delivered.length > 0);
    expect(t.delivered.map(msg => msg.content)).toEqual(['文件在这']);
  });

  it('存储地址的附件（如工具产出的文件，没带 ref）：落盘的副本只用来发，记进历史的是原来的地址；data URL 的图记落盘的副本', async () => {
    const t = await boot({ files: { 'data:/out/a.html': HTML } });
    await t.send({
      sessionId: GROUP,
      content: '',
      source: 'agent',
      attachments: [
        { kind: 'file', data: 'data:/out/a.html', name: '占位报告.html' },
        { kind: 'image', data: `data:image/png;base64,${PNG.toString('base64')}` },
      ],
    });
    await until(() => t.notes.length >= 2);
    // 送达快照里消息段发出的附件在前、上传的文件在后
    expect(t.notes.map(n => [n.message.kind, n.message.metadata?.ref])).toEqual([
      ['outbound-image', expect.stringMatching(/^data:\/images\/onebot_10000_group_20001\/onebot\/[0-9a-f]{16}\.png$/)],
      ['outbound-file', 'data:/out/a.html'],
    ]);
  });

  it('文字没发出、文件上传成功：送达快照的 content 是空串，只带上传了的文件', async () => {
    const t = await boot({ replyToSend: 'failText', files: { 'data:/out/a.html': HTML } });
    await t.send({
      sessionId: GROUP,
      content: '文件在这',
      source: 'command',
      attachments: [{ kind: 'file', data: 'data:/out/a.html', name: '占位报告.html' }],
    });
    await until(() => t.delivered.length > 0);
    expect(t.delivered.map(msg => [msg.content, msg.attachments?.map(att => att.name)])).toEqual([
      ['', ['占位报告.html']],
    ]);
  });

  it('私聊：经 upload_private_file 上传，文件名去掉路径分隔符', async () => {
    const t = await boot({ files: { 'data:/out/a.html': HTML } });
    await t.send({
      sessionId: PRIVATE,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/out/a.html', name: '../占位/目录\\报告.html' }],
    });
    await until(() => t.sent().some(a => a.action === 'upload_private_file'));
    const upload = t.sent().find(a => a.action === 'upload_private_file');
    expect(upload?.params.user_id).toBe(30001);
    expect(decode(upload?.params.file).equals(HTML)).toBe(true);
    expect(upload?.params.name).toBe('..占位目录报告.html');
    expect(t.sent().some(a => a.action === 'upload_group_file')).toBe(false);
  });

  it('超过内联上限的文件附件不发、warn，agent 发出的在会话记忆里留投递失败记录', async () => {
    const t = await boot({ files: { 'data:/out/big.html': Buffer.alloc(10 * MIB + 1, 0x61) } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/out/big.html', name: 'big.html' }],
      source: 'agent',
    });
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.warns.some(w => w.includes('文件附件'))).toBe(true);
    expect(t.failureNotes().map(n => [n.sessionId, n.message.role])).toEqual([[GROUP, 'system']]);
  });

  it('投递失败记录带这条消息的回合或调用 id，原因与投递结果同一句', async () => {
    const t = await boot({ files: { 'data:/out/big.html': Buffer.alloc(10 * MIB + 1, 0x61) } });
    const big = { kind: 'file' as const, data: 'data:/out/big.html', name: 'big.html' };
    const reply: OutgoingMessage = {
      sessionId: GROUP,
      content: '',
      attachments: [big],
      source: 'agent',
      turnId: 't-1',
    };
    const viaTool: OutgoingMessage = {
      sessionId: GROUP,
      content: '',
      attachments: [big],
      source: 'agent',
      callId: 'c-1',
    };
    await t.send(reply);
    await t.send(viaTool);
    await until(() => t.failureNotes().length === 2);
    const [replyResult, toolResult] = [await reply.delivery, await viaTool.delivery];
    expect(t.failureNotes().map(n => n.message.metadata)).toEqual([
      expect.objectContaining({ turnId: 't-1', error: replyResult?.ok === false && replyResult.error }),
      expect.objectContaining({ callId: 'c-1', error: toolResult?.ok === false && toolResult.error }),
    ]);
    expect(t.failureNotes()[0].message.metadata).not.toHaveProperty('callId');
    expect(t.failureNotes()[0].message.kind).toBe(WellKnownKinds.OutboundDeliveryFailed);
  });

  it('selfId 无匹配连接时不误发到其他机器人', async () => {
    const t = await boot({ files: { 'data:/out/a.html': HTML } });
    // selfId 对不上：当前适配器不认领该会话
    const other = `onebot:99999:group:20001`;
    await t.send({
      sessionId: other,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/out/a.html', name: 'a.html' }],
      source: 'agent',
    });
    await t.flush();
    expect(t.failureNotes()).toEqual([]);
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
  });

  it('回归：图片、语音照旧以 base64:// 消息段发出；不超过上限的视频也改走 base64://', async () => {
    const t = await boot({
      files: { 'data:/m/a.png': PNG, 'data:/m/a.wav': WAV, 'data:/m/a.mp4': MP4 },
    });
    const attachments: MessageAttachment[] = [
      { kind: 'image', data: 'data:/m/a.png' },
      { kind: 'audio', data: 'data:/m/a.wav' },
      { kind: 'video', data: 'data:/m/a.mp4' },
    ];
    await t.send({ sessionId: GROUP, content: '', attachments });
    await t.flush();
    const segments = t
      .sent()
      .filter(a => a.action === 'send_group_msg')
      .flatMap(m => m.params.message as Array<{ type: string; data: { file?: string } }>);
    const byType = (type: string) => segments.find(s => s.type === type)?.data.file;
    expect(decode(byType('image')).equals(PNG)).toBe(true);
    expect(decode(byType('record')).equals(WAV)).toBe(true);
    expect(String(byType('video')).startsWith('base64://')).toBe(true);
    expect(decode(byType('video')).equals(MP4)).toBe(true);
  });

  it('附件的消息段各自单独成一条发出：语音与视频不同条', async () => {
    const t = await boot({ files: { 'data:/m/a.wav': WAV, 'data:/m/a.mp4': MP4 } });
    const attachments: MessageAttachment[] = [
      { kind: 'audio', data: 'data:/m/a.wav' },
      { kind: 'video', data: 'data:/m/a.mp4' },
    ];
    await t.send({ sessionId: GROUP, content: '', attachments });
    await t.flush();
    const messages = t
      .sent()
      .filter(a => a.action === 'send_group_msg')
      .map(m => (m.params.message as Array<{ type: string }>).map(s => s.type));
    expect(messages).toEqual([['record'], ['video'], ['text']]);
  });

  it('v12 连接：文件附件不支持，warn 并按投递失败处理', async () => {
    const t = await boot({ protocol: 'v12', files: { 'data:/out/a.html': HTML } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/out/a.html', name: 'a.html' }],
      source: 'agent',
    });
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.warns.some(w => w.includes('v12'))).toBe(true);
  });

  it('上传超时：报结果未知、不要重发，不说未能送达', async () => {
    const t = await boot({ replyToSend: 'hold', files: { 'data:/out/a.html': HTML } });
    // 只伪造计时器、且随真实时间推进：until() 的轮询照常，再一次性跳过 action 的 30 秒上限
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const msg: OutgoingMessage = {
        sessionId: GROUP,
        content: '',
        attachments: [{ kind: 'file', data: 'data:/out/a.html', name: 'a.html' }],
        source: 'agent',
      };
      await t.send(msg);
      await until(() => t.sent().some(a => a.action === 'upload_group_file'));
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await msg.delivery;
      expect(result, '只有上传超时：结构化地标为结果未知').toMatchObject({ ok: false, unconfirmed: true });
      expect(reasonOf(result)).toBe('已发出但没等到确认，结果未知，可能已经送达，不要重发：文件 a.html');
      await until(() => t.failureNotes().length > 0);
      const note = String(t.failureNotes()[0].message.content);
      expect(note).toContain('可能已经送达');
      expect(note).not.toContain('未能送达');
      expect(t.sent().filter(a => a.action === 'upload_group_file')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('上传超时夹着确定没发出的附件：照样标结果未知，原因里写着结果未知的那个', async () => {
    const t = await boot({
      replyToSend: 'hold',
      files: { 'data:/out/a.html': HTML, 'data:/out/big.html': Buffer.alloc(10 * MIB + 1, 0x61) },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const msg: OutgoingMessage = {
        sessionId: GROUP,
        content: '',
        attachments: [
          { kind: 'file', data: 'data:/out/a.html', name: 'a.html' },
          { kind: 'file', data: 'data:/out/big.html', name: 'big.html' },
        ],
        source: 'agent',
      };
      await t.send(msg);
      await until(() => t.sent().some(a => a.action === 'upload_group_file'));
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await msg.delivery;
      expect(result).toMatchObject({ ok: false, unconfirmed: true });
      expect(reasonOf(result)).toContain('已发出但没等到确认，结果未知，可能已经送达，不要重发：文件 a.html');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('onebot 出站：发送不重试，停在没发成的那一条', () => {
  const textSends = (t: Awaited<ReturnType<typeof boot>>) => t.sent().filter(a => a.action === 'send_group_msg');
  const THREE_PIECES = '第一句足够长的一段话。第二句也足够长的一段话。第三句同样足够长的一段话。';

  /**
   * 她这条回复在 WebUI 里标的未发出原因：实时按投递结果（会话服务的 notAccepted），刷新后按存档里的投递失败记录（readHistory；
   * 她的回复由 agent 先落库，记录随后由适配器经存档写下）
   */
  async function undeliveredReasons(t: Awaited<ReturnType<typeof boot>>, msg: OutgoingMessage) {
    const result = await msg.delivery;
    if (result?.ok !== false) throw new Error('应当投递失败');
    await until(() => t.failureNotes().length > 0);
    const archived: Message[] = [
      { role: 'assistant', content: msg.content, timestamp: 1, metadata: { turnId: msg.turnId } },
      ...t.failureNotes().map(n => n.message),
    ];
    const room: MergeContext = {
      isOwner: () => false,
      room: true,
      multiParty: true,
      signFile: () => undefined,
      display: () => undefined,
    };
    const { items } = await readHistory(
      { getHistory: async () => archived } as unknown as MemoryService,
      GROUP,
      { limit: 100, skip: () => false },
      room,
      { warn() {} },
    );
    return {
      live: toSource(notAccepted(result.error, result)),
      history: items.flatMap(i =>
        i.kind === 'agent-message' && i.undelivered ? [toSource(i.undelivered.reason)] : [],
      ),
    };
  }

  it('发消息超时：只发一次，报结果未知、不劝重发', async () => {
    const t = await boot({ replyToSend: 'hold' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const msg: OutgoingMessage = { sessionId: GROUP, content: '<占位文字>', source: 'agent' };
      await t.send(msg);
      await until(() => textSends(t).length > 0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(textSends(t), '超时不重发').toHaveLength(1);
      expect(await msg.delivery).toMatchObject({ ok: false, unconfirmed: true });
      await until(() => t.failureNotes().length > 0);
      const note = String(t.failureNotes()[0].message.content);
      expect(note).toContain('可能已经送达');
      expect(note).not.toContain('未能送达');
    } finally {
      vi.useRealTimers();
    }
  });

  it('发消息回失败：只发一次，按确定失败报，不带结果未知', async () => {
    const t = await boot({ replyToSend: 'fail' });
    const msg: OutgoingMessage = { sessionId: GROUP, content: '<占位文字>', source: 'agent' };
    await t.send(msg);
    const result = await msg.delivery;
    expect(textSends(t)).toHaveLength(1);
    expect(result).toMatchObject({ ok: false });
    expect(result && 'unconfirmed' in result).toBe(false);
  });

  it('回执前连接断开：报结果未知，不重发', async () => {
    const t = await boot({ replyToSend: 'hold' });
    const msg: OutgoingMessage = { sessionId: GROUP, content: '<占位文字>', source: 'agent' };
    await t.send(msg);
    await until(() => textSends(t).length > 0);
    t.drop();
    expect(await msg.delivery).toMatchObject({ ok: false, unconfirmed: true });
    expect(textSends(t)).toHaveLength(1);
  });

  it('正文分三条、第二条回失败：停在第二条，投递结果与回报写明前 1 条已发出，只补没发出的部分', async () => {
    const t = await boot({
      failSendAt: 2,
      config: { splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] } },
    });
    const msg: OutgoingMessage = { sessionId: GROUP, content: THREE_PIECES, source: 'agent', markup: true };
    await t.send(msg);
    const result = await msg.delivery;
    expect(textSends(t), '第三条不再发').toHaveLength(2);
    expect(result).toMatchObject({ ok: false, sentPieces: 1 });
    expect(reasonOf(result)).toContain('fake send failure');
    await until(() => t.failureNotes().length > 0);
    const [note] = t.failureNotes();
    expect(note.message.content).toContain('前 1 条已经发出，从第 2 条起没有送达');
    expect(note.message.content).not.toContain('未能送达对方');
    expect(note.message.content).not.toContain('稍后重发');
    expect(note.message.metadata).toMatchObject({
      [WellKnownMetadataKeys.SentPieces]: 1,
      error: result?.ok === false && result.error,
    });
  });

  it('正文分两条、第一条没等到回执：第二条不发，投递结果标结果未知，时间线与刷新后的历史都写「可能已经发出」', async () => {
    const t = await boot({
      replyToSend: 'hold',
      config: { splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const msg: OutgoingMessage = {
        sessionId: GROUP,
        content: '第一句足够长的一段话。第二句也足够长的一段话。',
        source: 'agent',
        markup: true,
        turnId: 'turn-1',
      };
      await t.send(msg);
      await until(() => textSends(t).length === 1);
      await vi.advanceTimersByTimeAsync(30_000);
      const { live, history } = await undeliveredReasons(t, msg);
      expect(live).toMatch(/^可能已经发出，没等到平台确认：/);
      expect(history).toEqual([live]);
      expect(textSends(t), '第二条不再发').toHaveLength(1);
      expect(await msg.delivery).toMatchObject({ ok: false, unconfirmed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('正文分三条、第二条没等到回执：第 2 条记结果未知，从第 3 条起没发出；时间线与刷新后的历史按已发出的条数写「只发出了前 1 条」', async () => {
    const t = await boot({
      replyToSend: 'hold',
      config: { splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const msg: OutgoingMessage = {
        sessionId: GROUP,
        content: THREE_PIECES,
        source: 'agent',
        markup: true,
        turnId: 'turn-1',
      };
      await t.send(msg);
      await until(() => textSends(t).length === 1);
      for (const ack of t.heldReplies.splice(0)) ack();
      await until(() => textSends(t).length === 2);
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await msg.delivery;
      expect(textSends(t), '第三条不再发').toHaveLength(2);
      expect(result).toMatchObject({ ok: false, sentPieces: 1, unconfirmed: true });
      expect(reasonOf(result)).toBe(
        '从第 3 条起没发出；已发出但没等到确认，结果未知，可能已经送达，不要重发：消息（第 2 条）',
      );
      expect(result?.ok === false && renderIn(result.error, 'en')).toBe(
        'Not sent from message 3 onward; Sent but not confirmed (the result is unknown and it may already have been delivered, so do not resend): message 2',
      );
      const { live, history } = await undeliveredReasons(t, msg);
      expect(live).toMatch(/^只发出了前 1 条：/);
      expect(history).toEqual([live]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('停在最后一条、这一条没等到回执，另有文件没传上去：回报照样写明前 1 条已发出、不要整条重发，另说有文件没送达', async () => {
    const t = await boot({
      replyToSend: 'hold',
      failActions: { upload_group_file: { retcode: 100, message: '<占位原话>' } },
      files: { 'data:/out/a.html': HTML },
      config: { splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const msg: OutgoingMessage = {
        sessionId: GROUP,
        content: '第一句足够长的一段话。第二句也足够长的一段话。',
        source: 'agent',
        markup: true,
        attachments: [{ kind: 'file', data: 'data:/out/a.html', name: 'a.html' }],
      };
      await t.send(msg);
      await until(() => textSends(t).length === 1);
      for (const ack of t.heldReplies.splice(0)) ack();
      await until(() => textSends(t).length === 2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await msg.delivery).toMatchObject({ ok: false, sentPieces: 1 });
      await until(() => t.failureNotes().length > 0);
      const note = String(t.failureNotes()[0].message.content);
      expect(note).toContain('前 1 条已经发出');
      expect(note).toContain('不要整条重发');
      expect(note).toContain('另有图片、媒体或文件未能送达对方');
      expect(note).toContain('结果未知，可能已经送达；不要重发，以免出现两份：消息（第 2 条）');
      expect(note).not.toContain('稍后重发');
    } finally {
      vi.useRealTimers();
    }
  });

  it('WebUI 时间线与刷新后的历史里只写一次「前 1 条」：投递结果的原因只交原话，已发出的条数随 sentPieces', async () => {
    const t = await boot({
      failSendAt: 2,
      config: { splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] } },
    });
    const msg: OutgoingMessage = {
      sessionId: GROUP,
      content: THREE_PIECES,
      source: 'agent',
      markup: true,
      turnId: 'turn-1',
    };
    await t.send(msg);
    const { live, history } = await undeliveredReasons(t, msg);
    expect(history).toEqual([live]);
    expect(live.match(/前 1 条/g), live).toHaveLength(1);
    expect(live).toContain('fake send failure');
  });

  it('停在中途、另有文件没传上去：回报写明前 1 条已发出，另说有文件没送达', async () => {
    const t = await boot({
      failSendAt: 2,
      failActions: { upload_group_file: { retcode: 100, message: '<占位原话>' } },
      files: { 'data:/out/a.html': HTML },
      config: { splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] } },
    });
    const msg: OutgoingMessage = {
      sessionId: GROUP,
      content: THREE_PIECES,
      source: 'agent',
      markup: true,
      attachments: [{ kind: 'file', data: 'data:/out/a.html', name: 'a.html' }],
    };
    await t.send(msg);
    expect(await msg.delivery).toMatchObject({ ok: false, sentPieces: 1 });
    await until(() => t.failureNotes().length > 0);
    const note = String(t.failureNotes()[0].message.content);
    expect(note).toContain('前 1 条已经发出，从第 2 条起没有送达');
    expect(note).toContain('另有图片、媒体或文件未能送达对方');
  });

  it('两个内联附件、第二个回失败：送达快照只带第一个，投递结果带已发出条数', async () => {
    const t = await boot({ failSendAt: 2, files: { 'data:/m/a.png': PNG, 'data:/m/b.jpg': JPEG } });
    const msg: OutgoingMessage = {
      sessionId: GROUP,
      content: '',
      source: 'agent',
      attachments: [
        { kind: 'image', data: 'data:/m/a.png' },
        { kind: 'image', data: 'data:/m/b.jpg' },
      ],
    };
    await t.send(msg);
    expect(await msg.delivery).toMatchObject({ ok: false, sentPieces: 1 });
    await until(() => t.delivered.length > 0);
    expect(t.delivered.flatMap(m => m.attachments ?? []).map(a => a.ref)).toEqual(['data:/m/a.png']);
  });
});

describe('onebot 动作：失败带返回码，合并转发只按 id 拉', () => {
  it('实现端回不支持该动作（v11 为 1404）时拒绝带 unsupported；别的返回码不带', async () => {
    const t = await boot({
      failActions: {
        zz_unknown: { retcode: 1404, message: '不支持的API zz_unknown' },
        set_group_ban: { retcode: 200, message: '<占位原话>' },
      },
    });
    const unsupported = await t.callAction('zz_unknown', {}).catch((err: unknown) => err);
    expect(unsupported).toMatchObject({ unsupported: true, retcode: 1404 });
    expect(String((unsupported as Error).message)).toContain('retcode=1404');
    const refused = await t.callAction('set_group_ban', {}).catch((err: unknown) => err);
    expect(refused).toMatchObject({ unsupported: false, retcode: 200 });
    expect(String((refused as Error).message)).toContain('<占位原话>');
  });

  it('收到时没拉到的转发：get_forward_msg 交回收到它的会话与现拉的办法、不先拉；现拉只按 id 拉，拉不到抛出实现端原话；从没收到过的会话为空', async () => {
    const t = await boot({ failActions: { get_forward_msg: { retcode: 100, message: '<占位原话>' } } });
    t.post({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 803,
      group_id: 20001,
      user_id: 30002,
      sender: { user_id: 30002, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'zz-forward' } }],
    });
    await until(() => t.inbound.length > 0);
    const pulls = () => t.actions.filter(a => a.action === 'get_forward_msg').map(a => a.params);
    expect(pulls()).toEqual([{ id: 'zz-forward' }]);
    const receipt = (await t.callAction('get_forward_msg', { id: 'zz-forward' })) as {
      sessionIds: string[];
      fetch: () => Promise<unknown>;
    };
    expect(receipt).toMatchObject({ __aalisForwardReceipt: true, sessionIds: [GROUP] });
    expect(pulls()).toHaveLength(1);
    await expect(receipt.fetch()).rejects.toThrow('<占位原话>');
    expect(pulls()).toEqual([{ id: 'zz-forward' }, { id: 'zz-forward' }]);
    expect(await t.callAction('get_forward_msg', { id: 'zz-unknown' })).toMatchObject({ sessionIds: [] });
    expect(pulls()).toHaveLength(2);
  });

  it('入站展开过的转发：get_forward_msg 命中缓存时带截断标志与收到它的会话', async () => {
    const t = await boot({ config: { forward: { maxNodesPerLevel: 2, summarize: false } } });
    const node = (text: string) => ({ type: 'node', data: { nickname: '甲', user_id: 30002, content: text } });
    t.post({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 802,
      group_id: 20001,
      user_id: 30002,
      sender: { user_id: 30002, nickname: '甲' },
      message: [{ type: 'forward', data: { id: 'zz-forward', content: [node('一'), node('二'), node('三')] } }],
    });
    await until(() => t.inbound.length > 0);
    expect(await t.callAction('get_forward_msg', { id: 'zz-forward' })).toMatchObject({
      truncatedNodes: true,
      truncatedDepth: false,
      sessionIds: [GROUP],
    });
  });
});

describe('onebot 出站：媒体按文件头分流', () => {
  it('认得出但不能内联的媒体（BMP、AVIF、HEIC、MKV、AVI）改经群文件上传，不进消息段，不留投递失败记录', async () => {
    const files = {
      'data:/m/a.bmp': BMP,
      'data:/m/a.avif': AVIF,
      'data:/m/a.heic': HEIC,
      'data:/m/a.mkv': MKV,
      'data:/m/a.avi': AVI,
    };
    const t = await boot({ files });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [
        { kind: 'image', data: 'data:/m/a.bmp' },
        { kind: 'image', data: 'data:/m/a.avif' },
        { kind: 'image', data: 'data:/m/a.heic' },
        { kind: 'video', data: 'data:/m/a.mkv' },
        { kind: 'video', data: 'data:/m/a.avi' },
      ],
      source: 'agent',
    });
    await until(() => t.sent().filter(a => a.action === 'upload_group_file').length === 5);
    await t.flush();
    const uploads = t.sent().filter(a => a.action === 'upload_group_file');
    expect(uploads.map(u => u.params.name)).toEqual([
      'image.bmp',
      'image.avif',
      'image.heic',
      'video.mkv',
      'video.avi',
    ]);
    expect(uploads.map(u => decode(u.params.file))).toEqual([BMP, AVIF, HEIC, MKV, AVI]);
    const segmentTypes = t
      .sent()
      .flatMap(m => (m.params.message as Array<{ type: string }> | undefined)?.map(s => s.type) ?? []);
    expect(segmentTypes).not.toContain('image');
    expect(segmentTypes).not.toContain('video');
    expect(t.failureNotes()).toEqual([]);
  });

  it('私聊：改走上传的媒体经 upload_private_file 发出，附件自带名字时用它', async () => {
    const t = await boot({ files: { 'data:/m/a.heic': HEIC } });
    await t.send({
      sessionId: PRIVATE,
      content: '',
      attachments: [{ kind: 'image', data: 'data:/m/a.heic', name: '占位/照片.heic' }],
    });
    await until(() => t.sent().some(a => a.action === 'upload_private_file'));
    const upload = t.sent().find(a => a.action === 'upload_private_file');
    expect(upload?.params.name).toBe('占位照片.heic');
    expect(decode(upload?.params.file).equals(HEIC)).toBe(true);
  });

  it('回归：能内联的格式（JPEG、MOV、WebM、M4A）照旧以 base64:// 消息段发出，不上传', async () => {
    const t = await boot({
      files: { 'data:/m/a.jpg': JPEG, 'data:/m/a.mov': MOV, 'data:/m/a.webm': WEBM, 'data:/m/a.m4a': M4A },
    });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [
        { kind: 'image', data: 'data:/m/a.jpg' },
        { kind: 'video', data: 'data:/m/a.mov' },
        { kind: 'video', data: 'data:/m/a.webm' },
        { kind: 'audio', data: 'data:/m/a.m4a' },
      ],
    });
    await t.flush();
    const segments = t
      .sent()
      .filter(a => a.action === 'send_group_msg')
      .flatMap(m => m.params.message as Array<{ type: string; data: { file?: string } }>);
    const files = (type: string) => segments.filter(s => s.type === type).map(s => decode(s.data.file));
    expect(files('image')).toEqual([JPEG]);
    expect(files('video')).toEqual([MOV, WEBM]);
    expect(files('record')).toEqual([M4A]);
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
  });

  it('超过内联上限、又不能内联的媒体：上传只收 base64://，不发、不交宿主路径，留投递失败记录', async () => {
    const t = await boot({ files: { 'data:/m/big.bmp': Buffer.concat([BMP, Buffer.alloc(10 * MIB)]) } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'image', data: 'data:/m/big.bmp' }],
      source: 'agent',
    });
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(JSON.stringify(t.actions)).not.toContain('file://');
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
  });
});

describe('onebot 出站：send_attachment 交来的存储库文件', () => {
  it('超过 10 MiB 的 PNG：send_attachment 交出 storage URI，适配器按区间读出文件头核对后交宿主路径', async () => {
    const bigPng = Buffer.concat([PNG, Buffer.alloc(10 * MIB)]);
    const t = await boot({ imageSender: true, files: { 'data:/images/onebot_10000_group_20001/big.png': bigPng } });
    expect(
      await t.sendAttachment({ kind: 'image', storage_uri: 'data:/images/onebot_10000_group_20001/big.png' }),
    ).toMatchObject({
      ok: true,
    });
    await t.flush();
    const segments = t
      .sent()
      .filter(a => a.action === 'send_group_msg')
      .flatMap(m => m.params.message as Array<{ type: string; data: { file?: string } }>);
    expect(segments.find(s => s.type === 'image')?.data.file).toBe(
      'file:///host/data/images/onebot_10000_group_20001/big.png',
    );
    expect(t.failureNotes()).toEqual([]);
  });

  it('超过 10 MiB 的 BMP（send_attachment 放行、实现端不能内联）：不以宿主路径发出，留投递失败记录', async () => {
    const bigBmp = Buffer.concat([BMP, Buffer.alloc(10 * MIB)]);
    const t = await boot({ imageSender: true, files: { 'data:/images/onebot_10000_group_20001/big.bmp': bigBmp } });
    expect(
      await t.sendAttachment({ kind: 'image', storage_uri: 'data:/images/onebot_10000_group_20001/big.bmp' }),
    ).toHaveProperty('error');
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(JSON.stringify(t.actions)).not.toContain('file://');
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.imageNotes()).toEqual([]);
  });
});

describe('onebot 出站：她回复里的媒体标记', () => {
  const GROUP_DIR = 'onebot_10000_group_20001';
  const OTHER = 'data:/images/onebot_10000_group_20002/b.png';
  const segmentsOf = (actions: Action[], action: string) =>
    actions
      .filter(a => a.action === action)
      .flatMap(a => a.params.message as Array<{ type: string; data: { file?: string; text?: string } }>);
  const sendAction = (sessionId: string) => (sessionId === GROUP ? 'send_group_msg' : 'send_private_msg');
  const textOf = (actions: Action[], sessionId = GROUP) =>
    segmentsOf(actions, sendAction(sessionId))
      .filter(s => s.type === 'text')
      .map(s => s.data.text);

  it.each([
    ['群里', 'file://', GROUP, 'file:///zz/placeholder.png'],
    ['群里', '本机绝对路径', GROUP, '/zz/placeholder.png'],
    ['群里', 'data: 内联数据', GROUP, `data:image/png;base64,${PNG.toString('base64')}`],
    ['群里', '别的会话的存储地址', GROUP, OTHER],
    ['群里', 'base64://（按根名 base64 的存储地址算，读不出）', GROUP, `base64://${PNG.toString('base64')}`],
    ['受众只有 owner 的私聊', 'file://', PRIVATE, 'file:///zz/placeholder.png'],
    [
      '受众只有 owner 的私聊',
      'base64://（按根名 base64 的存储地址算，读不出）',
      PRIVATE,
      `base64://${PNG.toString('base64')}`,
    ],
  ])('%s：%s 的标记没转成附件，留在正文里由适配器去掉，不发，投递报失败', async (_where, _label, sessionId, url) => {
    const t = await boot({ imageSender: true, gateway: true, files: { [OTHER]: JPEG } });
    const content = `一<image url="${url}"/>二`;
    const message: OutgoingMessage = { sessionId, source: 'agent', markup: true, content };
    await t.dispatch(message);
    expect(message.content, '派发前的转换不动这个标记').toBe(content);
    expect(message.attachments ?? []).toEqual([]);
    expect(reasonOf(await message.delivery)).toContain('不是网址');
    await t.flush(sessionId);
    expect(segmentsOf(t.sent(), sendAction(sessionId)).filter(s => s.type !== 'text')).toEqual([]);
    expect(JSON.stringify(t.actions)).not.toContain(url);
    expect(textOf(t.sent(), sessionId)).toEqual(['一', '二', '哨兵']);
  });

  it.each([
    ['owner 私聊里 owner 那一轮的本机文件', PRIVATE, 'aalis:/aalis.config.yaml'],
    ['群里本会话的目录', GROUP, `data:/images/${GROUP_DIR}/note.png`],
  ])('%s：不是媒体的存储文件的标记留在正文里由适配器去掉，投递报失败，也不复制进会话的媒体目录', async (_where, sessionId, uri) => {
    const t = await boot({ imageSender: true, gateway: true, files: { [uri]: CONFIG } });
    const content = `一<image url="${uri}"/>二`;
    const message: OutgoingMessage = { sessionId, source: 'agent', markup: true, content };
    await t.dispatchInTurn(message, { content: '<占位>', sessionId, platform: 'onebot', userId: '30001' });
    expect(message.content).toBe(content);
    expect(message.attachments ?? []).toEqual([]);
    expect(reasonOf(await message.delivery)).toContain('不是网址');
    await t.flush(sessionId);
    expect(JSON.stringify(t.actions)).not.toContain(CONFIG.toString('base64'));
    expect([...t.files.keys()]).toEqual([uri]);
  });

  it('群里：协议名大写的网址 image-sender 不碰，由适配器当网址经 safeFetch 下载内联', async () => {
    const t = await boot({ imageSender: true, gateway: true });
    const url = `${httpBase.replace('http://', 'HTTP://')}/ok.png`;
    await t.dispatch({ sessionId: GROUP, source: 'agent', markup: true, content: `一<image url="${url}"/>二` });
    await t.flush();
    const images = segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type === 'image');
    expect(images.map(s => decode(s.data.file))).toEqual([PNG]);
    expect(JSON.stringify(t.actions)).not.toContain(url);
    expect(textOf(t.sent())).toEqual(['一', '二', '哨兵']);
  });

  it.each([
    ['file://', 'file:///zz/placeholder.png'],
    ['别的会话的存储地址', OTHER],
  ])('群里：适配器去掉取不下来的网址标记后，两边的文字照旧是文字，拼不出 %s 的标记', async (_label, url) => {
    const t = await boot({ imageSender: true, gateway: true, files: { [OTHER]: JPEG } });
    await t.dispatch({
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `一<ima<image url="${httpBase}/missing.png"/>ge url="${url}"/>二`,
    });
    await t.flush();
    expect(segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type !== 'text')).toEqual([]);
    expect(textOf(t.sent())).toEqual(['一<ima', `ge url="${url}"/>二`, '哨兵']);
  });

  it.each([
    ['群里', GROUP],
    ['owner 私聊', PRIVATE],
  ])('%s：http:// 开头、解析不了的网址标记不交给实现端，投递报失败', async (_label, sessionId) => {
    const t = await boot({ imageSender: true, gateway: true });
    const url = 'http://127.0.0.1:99999/zz-placeholder.png';
    const message: OutgoingMessage = { sessionId, source: 'agent', markup: true, content: `一<image url="${url}"/>二` };
    await t.dispatch(message);
    expect(await message.delivery).toMatchObject({ ok: false });
    await t.flush(sessionId);
    expect(JSON.stringify(t.actions)).not.toContain(url);
  });

  it('群里：不设 markup 的 agent 文字按纯文字显示，里面的标记不转附件、不去掉', async () => {
    const t = await boot({ imageSender: true, gateway: true, files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG } });
    const content = `一<image url="data:/images/${GROUP_DIR}/a.png"/>二<image url="file:///zz/placeholder.png"/>三`;
    await t.dispatch({ sessionId: GROUP, source: 'agent', content });
    await t.flush();
    expect(segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type !== 'text')).toEqual([]);
    expect(textOf(t.sent())).toEqual([content, '哨兵']);
  });

  it('群里：设了 markup 的宿主正文同样按受众处理，本会话的转成附件，别的会话的留在正文里由适配器去掉', async () => {
    const own = `data:/images/${GROUP_DIR}/a.png`;
    const t = await boot({ imageSender: true, gateway: true, files: { [own]: PNG, [OTHER]: JPEG } });
    const message: OutgoingMessage = {
      sessionId: GROUP,
      source: 'system',
      markup: true,
      content: `一<image url="${own}"/>二<image url="${OTHER}"/>三`,
    };
    await t.dispatch(message);
    expect(message.content).toBe(`一二<image url="${OTHER}"/>三`);
    expect(reasonOf(await message.delivery)).toContain('不是网址');
    await t.flush();
    const images = segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type === 'image');
    expect(images.map(s => decode(s.data.file))).toEqual([PNG]);
    expect(JSON.stringify(t.actions)).not.toContain(OTHER);
  });

  it('群里：本会话的存储地址按同类附件发出（image、record 为语音、video），送达之后与别的附件一样记进历史', async () => {
    const t = await boot({
      imageSender: true,
      gateway: true,
      files: {
        [`data:/images/${GROUP_DIR}/a.png`]: PNG,
        [`data:/audios/${GROUP_DIR}/a.wav`]: WAV,
        [`data:/videos/${GROUP_DIR}/a.mp4`]: MP4,
      },
    });
    await t.dispatch({
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content:
        `一<image url="data:/images/${GROUP_DIR}/a.png"/>二<record url="data:/audios/${GROUP_DIR}/a.wav"/>` +
        `三<video url="data:/videos/${GROUP_DIR}/a.mp4"/>`,
    });
    await t.flush();
    const segments = segmentsOf(t.sent(), 'send_group_msg');
    const byType = (type: string) => segments.filter(s => s.type === type).map(s => decode(s.data.file));
    expect(byType('image')).toEqual([PNG]);
    expect(byType('record')).toEqual([WAV]);
    expect(byType('video')).toEqual([MP4]);
    expect(textOf(t.sent())).toContain('一二三');
    await until(() => t.imageNotes().length > 0);
    expect(t.imageNotes().map(n => n.message.metadata?.ref)).toEqual([`data:/images/${GROUP_DIR}/a.png`]);
  });

  it('群里：网址的标记留在正文原处，由适配器经 safeFetch 下载内联，超过内联上限的去掉，网址不交给实现端', async () => {
    const t = await boot({ imageSender: true, gateway: true });
    await t.dispatch({
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `一<image url="${httpBase}/ok.png"/>二<image url="${httpBase}/big.html"/>三`,
    });
    await t.flush();
    const images = segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type === 'image');
    expect(images.map(s => decode(s.data.file))).toEqual([PNG]);
    expect(textOf(t.sent())).toEqual(['一', '二', '三', '哨兵']);
    expect(JSON.stringify(t.actions)).not.toContain(httpBase);
  });

  it('群里：网址的标记与存储地址的标记混排，只摘掉转成附件的那个，网址的留在原处内联', async () => {
    const t = await boot({ imageSender: true, gateway: true, files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG } });
    const message: OutgoingMessage = {
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `一<image url="${httpBase}/ok.png"/>二<image url="data:/images/${GROUP_DIR}/a.png"/>三`,
    };
    await t.dispatch(message);
    expect(message.content).toBe(`一<image url="${httpBase}/ok.png"/>二三`);
    expect(message.attachments).toHaveLength(1);
    expect(await message.delivery).toEqual({ ok: true });
    await t.flush();
    const images = segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type === 'image');
    expect(images.map(s => decode(s.data.file))).toEqual([PNG, PNG]);
  });

  it('群里：一条回复里存储地址的标记转成的附件也计入最多 10 个媒体，多出的不读、去掉，投递报多出的个数；附件同时最多读 4 个', async () => {
    const t = await boot({
      imageSender: true,
      gateway: true,
      readDelayMs: 20,
      files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG },
    });
    const message: OutgoingMessage = {
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `看${`<image url="data:/images/${GROUP_DIR}/a.png"/>`.repeat(24)}`,
    };
    await t.dispatch(message);
    const delivery = await message.delivery;
    await t.flush();
    expect(segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type === 'image')).toHaveLength(10);
    expect(t.reads.peak).toBeLessThanOrEqual(4);
    expect(delivery?.ok === false && toSource(delivery.error)).toBe('一条回复最多发 10 个媒体，多出的 14 个已拒发');
  });

  it('群里：网址的标记与存储地址的标记合计最多 10 个，按发出的先后数（正文在前，转成的附件接在后面）', async () => {
    const t = await boot({ imageSender: true, gateway: true, files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG } });
    const pair = `<image url="${httpBase}/ok.png"/><image url="data:/images/${GROUP_DIR}/a.png"/>`;
    const message: OutgoingMessage = {
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `看${pair.repeat(6)}`,
    };
    await t.dispatch(message);
    const delivery = await message.delivery;
    await t.flush();
    expect(segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type === 'image')).toHaveLength(10);
    expect(delivery?.ok === false && toSource(delivery.error)).toBe('一条回复最多发 10 个媒体，多出的 2 个已拒发');
  });

  it.each([
    ['file://', 'file:///zz/outer.png'],
    ['本会话的存储地址', `data:/images/${GROUP_DIR}/b.png`],
  ])('群里：摘掉转成附件的标记后两边的文字拼成 %s 的标记，不再转换，由适配器去掉，投递报失败', async (_label, url) => {
    const t = await boot({
      imageSender: true,
      gateway: true,
      files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG, [`data:/images/${GROUP_DIR}/b.png`]: JPEG },
    });
    const message: OutgoingMessage = {
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `一<ima<image url="data:/images/${GROUP_DIR}/a.png"/>ge url="${url}"/>二`,
    };
    await t.dispatch(message);
    expect(message.content).toBe(`一<image url="${url}"/>二`);
    expect(reasonOf(await message.delivery)).toContain('不是网址');
    await t.flush();
    const images = segmentsOf(t.sent(), 'send_group_msg').filter(s => s.type !== 'text');
    expect(images.map(s => decode(s.data.file))).toEqual([PNG]);
    expect(JSON.stringify(t.actions)).not.toContain(url);
    expect(textOf(t.sent())).toEqual(['一', '二', '哨兵']);
  });

  it('会话管理不在：群里的标记照样转换或去掉', async () => {
    const t = await boot({
      imageSender: true,
      gateway: true,
      sessions: false,
      files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG },
    });
    await t.dispatch({
      sessionId: GROUP,
      source: 'agent',
      markup: true,
      content: `一<image url="file:///zz/placeholder.png"/>二<image url="data:/images/${GROUP_DIR}/a.png"/>`,
    });
    await t.flush();
    const segments = segmentsOf(t.sent(), 'send_group_msg');
    expect(segments.filter(s => s.type === 'image').map(s => decode(s.data.file))).toEqual([PNG]);
    expect(JSON.stringify(t.actions)).not.toContain('placeholder.png');
  });

  it('owner 私聊里 owner 那一轮：本机文件的标记转成同类附件发出、送达之后记进历史；别的会话的按取用规则判，替身不放行，留在正文里由适配器去掉', async () => {
    const elsewhere = 'data:/downloads/zz-placeholder.jpg';
    const other = `data:/images/${GROUP_DIR}/a.png`;
    const t = await boot({ imageSender: true, gateway: true, files: { [other]: PNG, [elsewhere]: JPEG } });
    const message: OutgoingMessage = {
      sessionId: PRIVATE,
      source: 'agent',
      markup: true,
      content: `一<image url="${other}"/>二<image url="${elsewhere}"/>`,
    };
    await t.dispatchInTurn(message, { content: '<占位>', sessionId: PRIVATE, platform: 'onebot', userId: '30001' });
    expect(message.content).toBe(`一<image url="${other}"/>二`);
    expect(reasonOf(await message.delivery)).toContain('不是网址');
    await t.flush(PRIVATE);
    const images = segmentsOf(t.sent(), 'send_private_msg').filter(s => s.type === 'image');
    expect(images.map(s => decode(s.data.file))).toEqual([JPEG]);
    expect(JSON.stringify(t.actions)).not.toContain(other);
    await until(() => t.imageNotes().length === 1);
    expect(t.imageNotes().map(n => n.message.metadata?.ref)).toEqual([elsewhere]);
  });

  it('会话管理不在：反查不出图所在的会话，私聊里别的会话的存储地址留在正文里由适配器去掉', async () => {
    const t = await boot({
      imageSender: true,
      gateway: true,
      sessions: false,
      files: { [`data:/images/${GROUP_DIR}/a.png`]: PNG },
    });
    const content = `一<image url="data:/images/${GROUP_DIR}/a.png"/>二`;
    const message: OutgoingMessage = { sessionId: PRIVATE, source: 'agent', markup: true, content };
    await t.dispatch(message);
    expect(message.content).toBe(content);
    expect(reasonOf(await message.delivery)).toContain('不是网址');
    await t.flush(PRIVATE);
    expect(segmentsOf(t.sent(), 'send_private_msg').filter(s => s.type !== 'text')).toEqual([]);
    expect(textOf(t.sent(), PRIVATE)).toEqual(['一', '二', '哨兵']);
  });
});

describe('onebot 出站：send_attachment 投递结果', () => {
  const imageOnWire = (actions: Action[]) =>
    actions
      .filter(a => a.action === 'send_group_msg')
      .flatMap(a => a.params.message as Array<{ type: string; data: { file?: string } }>)
      .filter(s => s.type === 'image');

  it('HTTP 405：工具返回错误，平台没有发图，也没有成功归档', async () => {
    const t = await boot({ imageSender: true });
    const result = await t.sendAttachment({ kind: 'image', url: `${httpBase}/method.png` });
    expect(result).toHaveProperty('error');
    await t.flush();
    expect(imageOnWire(t.sent())).toEqual([]);
    expect(t.imageNotes()).toEqual([]);
  });

  it('拒绝连接：工具返回错误，平台没有发图，也没有成功归档', async () => {
    const t = await boot({ imageSender: true });
    const result = await t.sendAttachment({ kind: 'image', url: 'http://127.0.0.1:1/unreachable.png' });
    expect(result).toHaveProperty('error');
    await t.flush();
    expect(imageOnWire(t.sent())).toEqual([]);
    expect(t.imageNotes()).toEqual([]);
  });

  it('HTTP PNG：实际 WebSocket 图片消息段携带原字节，OneBot ACK 后工具才成功', async () => {
    const t = await boot({ imageSender: true, replyToSend: 'hold' });
    let settled = false;
    const resultPromise = t.sendAttachment({ kind: 'image', url: `${httpBase}/ok.png` }).then(result => {
      settled = true;
      return result;
    });
    await until(() => imageOnWire(t.sent()).length > 0);
    expect(imageOnWire(t.sent())).toHaveLength(1);
    expect(decode(imageOnWire(t.sent())[0].data.file)).toEqual(PNG);
    expect(settled, '平台尚未确认时工具不能报告成功').toBe(false);
    expect(t.imageNotes(), '平台尚未确认时不能成功归档').toEqual([]);
    for (const ack of t.heldReplies.splice(0)) ack();
    expect(await resultPromise).toMatchObject({ ok: true });
    await until(() => t.imageNotes().length > 0);
    expect(t.imageNotes()).toHaveLength(1);
  });

  it.each(['url', 'history_ref'])('%s 写协议名大写的网址：照网址下载、内联发出', async key => {
    const t = await boot({ imageSender: true });
    const url = `${httpBase.replace('http://', 'HTTP://')}/ok.png`;
    expect(await t.sendAttachment({ kind: 'image', [key]: url })).toMatchObject({ ok: true });
    expect(imageOnWire(t.sent()).map(s => decode(s.data.file))).toEqual([PNG]);
  });

  it('等待 ACK 时回合中止：工具立即返回未确认，不报告成功也不报未发送', async () => {
    const t = await boot({ imageSender: true, replyToSend: 'hold' });
    const turn = new AbortController();
    const resultPromise = t.sendAttachment({ kind: 'image', url: `${httpBase}/ok.png` }, GROUP, turn.signal);
    await until(() => imageOnWire(t.sent()).length > 0);
    turn.abort();
    const result = await resultPromise;
    expect(result).not.toHaveProperty('ok');
    expect(String(result.error)).toContain('未确认');
    for (const ack of t.heldReplies.splice(0)) ack();
    await until(() => t.imageNotes().length > 0);
    expect(t.imageNotes(), '中止后平台照常确认的附件仍归档').toHaveLength(1);
  });

  it('图片消息段迟迟没有回执：适配器到回执时限报结果未知，send_attachment 不报告成功、不劝重发，也不重发', async () => {
    const t = await boot({ imageSender: true, replyToSend: 'hold' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      let settled = false;
      const resultPromise = t.sendAttachment({ kind: 'image', url: `${httpBase}/ok.png` }).then(result => {
        settled = true;
        return result;
      });
      await until(() => imageOnWire(t.sent()).length > 0);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(settled, '回执时限之前照常等待').toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;
      expect(result).not.toHaveProperty('ok');
      expect(String(result.error)).toContain('可能已经送达');
      expect(String(result.error)).toContain('请勿重发');
      expect(imageOnWire(t.sent()), '不重发').toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('OneBot action 返回失败：工具不报告成功，也不成功归档', async () => {
    const t = await boot({
      imageSender: true,
      replyToSend: 'fail',
      files: { 'data:/images/onebot_10000_group_20001/a.png': PNG },
    });
    const result = await t.sendAttachment({
      kind: 'image',
      storage_uri: 'data:/images/onebot_10000_group_20001/a.png',
    });
    expect(result).toHaveProperty('error');
    expect(t.imageNotes()).toEqual([]);
  });

  it('连接不可用：工具不报告成功，也不成功归档', async () => {
    const t = await boot({ imageSender: true, files: { 'data:/images/onebot_99999_group_20001/a.png': PNG } });
    const result = await t.sendAttachment(
      { kind: 'image', storage_uri: 'data:/images/onebot_99999_group_20001/a.png' },
      'onebot:99999:group:20001',
    );
    expect(result).toHaveProperty('error');
    expect(t.imageNotes()).toEqual([]);
    expect(imageOnWire(t.sent())).toEqual([]);
  });

  it('网址图片落盘后登记描述别名：原网址指到会话媒体目录里的落盘路径', async () => {
    const aliases: Array<[string, string]> = [];
    const t = await boot({
      imageSender: true,
      media: { rememberDescriptionAlias: (source, landedRef) => void aliases.push([source, landedRef]) },
    });
    const url = `${httpBase}/ok.png`;
    expect(await t.sendAttachment({ kind: 'image', url })).toMatchObject({ ok: true });
    expect(aliases).toEqual([
      [url, expect.stringMatching(/^data:\/images\/onebot_10000_group_20001\/onebot\/[0-9a-f]{16}\.png$/)],
    ]);
    expect(t.files.get(aliases[0][1])).toEqual(PNG);
  });

  it('混合附件部分失败：只归档已投递的 PNG', async () => {
    const t = await boot({ imageSender: true });
    const goodRef = `${httpBase}/ok.png`;
    const badRef = `${httpBase}/method.png`;
    await t.send({
      sessionId: GROUP,
      content: '',
      source: 'agent',
      attachments: [
        { kind: 'image', data: goodRef, ref: goodRef },
        { kind: 'image', data: badRef, ref: badRef },
      ],
    });
    await until(() => imageOnWire(t.sent()).length > 0);
    await until(() => t.imageNotes().length > 0);
    expect(imageOnWire(t.sent())).toHaveLength(1);
    expect(decode(imageOnWire(t.sent())[0].data.file)).toEqual(PNG);
    expect(t.imageNotes().map(n => n.message.metadata?.ref)).toEqual([goodRef]);
  });
});

describe('onebot 出站：安全', () => {
  it('超限的 storage 文件与超限的 http 文件：发出的 action 里没有 file:// 与 http 形态，按失败处理', async () => {
    const t = await boot({ files: { 'data:/out/big.html': Buffer.alloc(10 * MIB + 1, 0x61) } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [
        { kind: 'file', data: 'data:/out/big.html', name: 'big.html' },
        { kind: 'file', data: `${httpBase}/big.html`, name: 'remote.html' },
      ],
      source: 'agent',
    });
    // 等到有定论：拒发时留投递失败记录；防线失守时两个文件都会被上传
    await until(() => t.failureNotes().length > 0 || t.sent().filter(a => a.action.startsWith('upload_')).length === 2);
    await t.flush();
    const wire = JSON.stringify(t.actions);
    expect(wire).not.toContain('file://');
    expect(wire).not.toContain(httpBase);
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
  });

  it('超过内联上限的网址图片附件：不发，原网址不交给实现端去拉，投递报超过内联上限', async () => {
    const t = await boot();
    const message: OutgoingMessage = {
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'image', data: `${httpBase}/big.html` }],
    };
    await t.send(message);
    expect(reasonOf(await message.delivery)).toContain('超过内联上限');
    await t.flush();
    expect(JSON.stringify(t.actions)).not.toContain(httpBase);
  });

  it('不是对应格式的文件（占位的配置文本）以 image、audio、video 发出：不内联、不发出，并有 warn', async () => {
    const t = await boot({ files: { 'aalis:/aalis.config.yaml': CONFIG } });
    for (const kind of ['image', 'audio', 'video'] as const) {
      await t.send({ sessionId: GROUP, content: '', attachments: [{ kind, data: 'aalis:/aalis.config.yaml' }] });
    }
    await t.flush();
    const wire = JSON.stringify(t.actions);
    expect(wire).not.toContain(CONFIG.toString('base64'));
    const segmentTypes = t
      .sent()
      .flatMap(m => (m.params.message as Array<{ type: string }> | undefined)?.map(s => s.type) ?? []);
    expect(segmentTypes).not.toContain('image');
    expect(segmentTypes).not.toContain('record');
    expect(segmentTypes).not.toContain('video');
    expect(
      t.sent().some(a => a.action.startsWith('upload_')),
      '不是媒体的也不改走文件上传',
    ).toBe(false);
    expect(t.warns.filter(w => w.includes('文件头')).length).toBe(3);
  });

  it('agent 发出的非媒体附件与指向没登记的存储根的附件都拒发：留投递失败记录，不当作已发出；原因是文字对象，时间线按读者的语言写出两条，给模型的是原文，都不带 Error: 前缀', async () => {
    const t = await boot({ files: { 'aalis:/aalis.config.yaml': CONFIG } });
    const message: OutgoingMessage = {
      sessionId: GROUP,
      content: '',
      attachments: [
        { kind: 'image', data: 'aalis:/aalis.config.yaml' },
        { kind: 'file', data: 'zz:/a.html', name: 'a.html' },
      ],
      source: 'agent',
    };
    await t.send(message);
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(JSON.stringify(t.actions)).not.toContain(CONFIG.toString('base64'));
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.failureNotes().map(n => n.sessionId)).toEqual([GROUP]);
    expect(isTextRef(t.failureNotes()[0].message.metadata?.[WellKnownMetadataKeys.DeliveryError])).toBe(true);
    const result = await message.delivery;
    if (result?.ok !== false) throw new Error('应当投递失败');
    const shown = notAccepted(result.error, result);
    expect([renderIn(shown, 'en'), renderIn(shown, 'zh-CN'), toSource(result.error)]).toEqual([
      'Not sent: the platform did not accept it (The content is not a sendable image format (the file header does not match), so it was not sent; Unknown storage root: zz (registered roots: data, aalis))',
      '没有发出：平台没收下（内容不是可发送的 image 格式（文件头不符），已拒发；未知存储根：zz（已注册根：data, aalis））',
      '内容不是可发送的 image 格式（文件头不符），已拒发；未知存储根：zz（已注册根：data, aalis）',
    ]);
  });

  it('拒发的附件多到超过渲染的嵌套上限（40 件）：各条原因照样按读者的语言相连（原文以「；」，英文以「; 」）', async () => {
    const t = await boot();
    const message: OutgoingMessage = {
      sessionId: GROUP,
      content: '',
      attachments: Array.from({ length: 40 }, (_, i) => ({
        kind: 'file' as const,
        data: `zz:/${i}.html`,
        name: `${i}.html`,
      })),
      source: 'agent',
    };
    await t.send(message);
    const result = await message.delivery;
    if (result?.ok !== false) throw new Error('应当投递失败');
    expect([renderIn(result.error, 'en'), toSource(result.error)]).toEqual([
      Array(40).fill('Unknown storage root: zz (registered roots: data, aalis)').join('; '),
      Array(40).fill('未知存储根：zz（已注册根：data, aalis）').join('；'),
    ]);
  });

  it('超过内联上限的 storage 文件退回宿主路径之前也核对文件头：不是对应格式的不发，真的图片照旧交宿主路径', async () => {
    const bigText = Buffer.concat([CONFIG, Buffer.alloc(10 * MIB, 0x61)]);
    const bigPng = Buffer.concat([PNG, Buffer.alloc(10 * MIB)]);
    const t = await boot({ files: { 'aalis:/big.log': bigText, 'data:/images/big.png': bigPng } });
    for (const kind of ['image', 'video'] as const) {
      await t.send({ sessionId: GROUP, content: '', attachments: [{ kind, data: 'aalis:/big.log' }] });
    }
    await t.send({ sessionId: GROUP, content: '', attachments: [{ kind: 'image', data: 'data:/images/big.png' }] });
    await t.flush();
    const wire = JSON.stringify(t.actions);
    expect(wire).not.toContain('big.log');
    expect(wire).toContain('file:///host/data/images/big.png');
    expect(t.warns.filter(w => w.includes('文件头')).length).toBe(2);
  });
});

describe('onebot 入站：引用与撤回反查归档原文', () => {
  it('owner 从 WebUI 往群里插的话被引用、被撤回：按归档时记下的标签去掉「[<owner 账号>]: 」，不按这条消息自己的身份拼', async () => {
    const t = await boot({ gateway: true });
    const archived = await t.archive().archiveIncoming({
      content: '周五停课',
      sessionId: GROUP,
      platform: 'webui',
      userId: 'console',
      messageId: 'zz-quoted',
    });
    expect(archived?.content).toBe('[30001]: 周五停课');

    t.post({
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 801,
      group_id: 20001,
      user_id: 30002,
      sender: { user_id: 30002, nickname: '乙' },
      message: [
        { type: 'reply', data: { id: 'zz-quoted' } },
        { type: 'text', data: { text: '收到' } },
      ],
    });
    await until(() => t.inbound.length > 0);
    expect(t.inbound[0].replyTo).toMatchObject({ messageId: 'zz-quoted', content: '周五停课' });

    t.post({
      post_type: 'notice',
      notice_type: 'group_recall',
      group_id: 20001,
      user_id: 30001,
      message_id: 'zz-quoted',
    });
    await until(() => t.notes.some(n => n.message.kind === 'group_recall'));
    expect(t.notes.find(n => n.message.kind === 'group_recall')?.message.content).toContain('发送：「周五停课」）');
  });
});
