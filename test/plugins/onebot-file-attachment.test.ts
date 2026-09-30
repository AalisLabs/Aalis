import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, events, type Logger, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import type { Message, MessageAttachment, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// onebot 出站的文件附件与内联前的文件头核对。
//
// file 附件经 upload_group_file / upload_private_file 发出，内容只收 base64://：超过内联上限时
// attachmentToOneBotFile 会退回 file://<宿主路径> 或原 http 链接，容器里的 NapCat 读不到，一律拒发。
// image、audio、video 按文件头分流：NapCat 能内联的格式走消息段；send_attachment 白名单里其余的媒体
// （BMP、AVIF、HEIC 图片，MKV、AVI 视频）改经文件上传，不静默丢弃；不是媒体的（如配置文本）拒发，
// 免得任意可读文件冒充媒体发出。没发出去的附件，agent 发出的消息在会话记忆里留投递失败记录。
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
const HTML = Buffer.from('<!doctype html><title>占位成品</title><p>占位</p>');
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

/** 内存 storage：data 根可写（出站附件落盘用），aalis 根只读（占位的配置文件所在） */
function memStorage(files: Map<string, Buffer>) {
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
      return get(uri);
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

/** imageSender 为真时另装 plugin-image-sender，经 sendAttachment 调它的 send_attachment */
async function boot(
  opts: {
    protocol?: 'v11' | 'v12';
    files?: Record<string, Buffer>;
    imageSender?: boolean;
    replyToSend?: 'ok' | 'fail' | 'hold';
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
  server.on('connection', ws => {
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as Action & { echo?: string };
      actions.push({ action: req.action, params: req.params });
      if (req.echo) {
        const reply = (status: 'ok' | 'failed') =>
          ws.send(
            JSON.stringify({
              status,
              retcode: status === 'ok' ? 0 : 100,
              message: status === 'ok' ? undefined : 'fake send failure',
              data: { user_id: SELF },
              echo: req.echo,
            }),
          );
        if (/^(send_|upload_)/.test(req.action) && opts.replyToSend === 'hold') heldReplies.push(() => reply('ok'));
        else reply(/^(send_|upload_)/.test(req.action) && opts.replyToSend === 'fail' ? 'failed' : 'ok');
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
  const host = app.bind({ provide, events });
  const files = new Map<string, Buffer>(Object.entries(opts.files ?? {}));
  host.provide(storage, memStorage(files) as never);
  // 转码一律失败：语音附件保留原数据，直接走内联前的文件头核对
  host.provide(processService, {
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
  const notes: Array<{ sessionId: string; message: Message }> = [];
  host.provide(messageArchive, {
    async saveMessage(sessionId: string, message: Message) {
      notes.push({ sessionId, message });
    },
  } as never);
  await app.plugins.register(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(onebotPlugin.name)?.state !== 'active') throw new Error('onebot 适配器未激活');
  const toolHandlers = new Map<string, ToolHandler>();
  if (opts.imageSender) {
    host.provide(tools, {
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
  const send = (msg: OutgoingMessage) => host.events.emit('outbound:message', msg);
  /** 发一条哨兵文字并等它到达：在它之前交出的消息该发的都已发出 */
  const flush = async (sessionId = GROUP) => {
    await send({ sessionId, content: '哨兵' });
    await until(() => JSON.stringify(sent()).includes('哨兵'));
  };
  const failureNotes = () => notes.filter(n => n.message.kind === 'outbound-delivery-failed');
  const imageNotes = () => notes.filter(n => n.message.kind === 'outbound-image');
  const sendAttachment = async (args: Record<string, unknown>, sessionId = GROUP) => {
    const handler = toolHandlers.get('send_attachment');
    if (!handler) throw new Error('send_attachment 未注册');
    return JSON.parse(await handler(args, { sessionId, platform: 'onebot' } as ToolCallContext)) as Record<
      string,
      unknown
    >;
  };
  return { actions, sent, send, flush, warns, notes, failureNotes, imageNotes, heldReplies, sendAttachment };
}

const decode = (file: unknown) => Buffer.from(String(file).slice('base64://'.length), 'base64');

describe('onebot 出站：文件附件', () => {
  it('群会话：文字与消息段先发，文件随后经 upload_group_file 以 base64:// 上传，不进消息段', async () => {
    const t = await boot({ files: { 'data:/paper-out/a.html': HTML, 'data:/paper-out/a.png': PNG } });
    await t.send({
      sessionId: GROUP,
      content: '成品在这',
      attachments: [
        { kind: 'image', data: 'data:/paper-out/a.png' },
        { kind: 'file', data: 'data:/paper-out/a.html', name: '占位成品.html' },
      ],
    });
    await until(() => t.sent().some(a => a.action === 'upload_group_file'));

    const sent = t.sent();
    const upload = sent.find(a => a.action === 'upload_group_file');
    expect(upload?.params.group_id).toBe(20001);
    expect(String(upload?.params.file).startsWith('base64://')).toBe(true);
    expect(decode(upload?.params.file).equals(HTML)).toBe(true);
    expect(upload?.params.name).toBe('占位成品.html');

    const messages = sent.filter(a => a.action === 'send_group_msg');
    expect(messages.length).toBeGreaterThan(0);
    expect(sent.indexOf(upload as Action), '文件在文字与消息段之后上传').toBeGreaterThan(
      sent.indexOf(messages[messages.length - 1]),
    );
    const segmentTypes = messages.flatMap(m => (m.params.message as Array<{ type: string }>).map(s => s.type));
    expect(segmentTypes).toContain('image');
    expect(segmentTypes, '文件不以消息段发出').not.toContain('file');
    expect(JSON.stringify(messages)).not.toContain(HTML.toString('base64'));
  });

  it('私聊：经 upload_private_file 上传，文件名去掉路径分隔符', async () => {
    const t = await boot({ files: { 'data:/paper-out/a.html': HTML } });
    await t.send({
      sessionId: PRIVATE,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/paper-out/a.html', name: '../占位/目录\\成品.html' }],
    });
    await until(() => t.sent().some(a => a.action === 'upload_private_file'));
    const upload = t.sent().find(a => a.action === 'upload_private_file');
    expect(upload?.params.user_id).toBe(30001);
    expect(decode(upload?.params.file).equals(HTML)).toBe(true);
    expect(upload?.params.name).toBe('..占位目录成品.html');
    expect(t.sent().some(a => a.action === 'upload_group_file')).toBe(false);
  });

  it('超过内联上限的文件附件不发、warn，agent 发出的在会话记忆里留投递失败记录', async () => {
    const t = await boot({ files: { 'data:/paper-out/big.html': Buffer.alloc(10 * MIB + 1, 0x61) } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/paper-out/big.html', name: 'big.html' }],
      source: 'agent',
    });
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.warns.some(w => w.includes('文件附件'))).toBe(true);
    expect(t.failureNotes().map(n => [n.sessionId, n.message.role])).toEqual([[GROUP, 'system']]);
  });

  it('selfId 无匹配连接时不误发到其他机器人', async () => {
    const t = await boot({ files: { 'data:/paper-out/a.html': HTML } });
    // selfId 对不上：当前适配器不认领该会话
    const other = `onebot:99999:group:20001`;
    await t.send({
      sessionId: other,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/paper-out/a.html', name: 'a.html' }],
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

  it('v12 连接：文件附件不支持，warn 并按投递失败处理', async () => {
    const t = await boot({ protocol: 'v12', files: { 'data:/paper-out/a.html': HTML } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'file', data: 'data:/paper-out/a.html', name: 'a.html' }],
      source: 'agent',
    });
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.warns.some(w => w.includes('v12'))).toBe(true);
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
    const t = await boot({ imageSender: true, files: { 'data:/images/big.png': bigPng } });
    expect(await t.sendAttachment({ kind: 'image', storage_uri: 'data:/images/big.png' })).toMatchObject({ ok: true });
    await t.flush();
    const segments = t
      .sent()
      .filter(a => a.action === 'send_group_msg')
      .flatMap(m => m.params.message as Array<{ type: string; data: { file?: string } }>);
    expect(segments.find(s => s.type === 'image')?.data.file).toBe('file:///host/data/images/big.png');
    expect(t.failureNotes()).toEqual([]);
  });

  it('超过 10 MiB 的 BMP（send_attachment 放行、实现端不能内联）：不以宿主路径发出，留投递失败记录', async () => {
    const bigBmp = Buffer.concat([BMP, Buffer.alloc(10 * MIB)]);
    const t = await boot({ imageSender: true, files: { 'data:/images/big.bmp': bigBmp } });
    expect(await t.sendAttachment({ kind: 'image', storage_uri: 'data:/images/big.bmp' })).toHaveProperty('error');
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(JSON.stringify(t.actions)).not.toContain('file://');
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.imageNotes()).toEqual([]);
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

  it('OneBot action 返回失败：工具不报告成功，也不成功归档', async () => {
    const t = await boot({ imageSender: true, replyToSend: 'fail', files: { 'data:/images/a.png': PNG } });
    const result = await t.sendAttachment({ kind: 'image', storage_uri: 'data:/images/a.png' });
    expect(result).toHaveProperty('error');
    expect(t.imageNotes()).toEqual([]);
  });

  it('连接不可用：工具不报告成功，也不成功归档', async () => {
    const t = await boot({ imageSender: true, files: { 'data:/images/a.png': PNG } });
    const result = await t.sendAttachment(
      { kind: 'image', storage_uri: 'data:/images/a.png' },
      'onebot:99999:group:20001',
    );
    expect(result).toHaveProperty('error');
    expect(t.imageNotes()).toEqual([]);
    expect(imageOnWire(t.sent())).toEqual([]);
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
    const t = await boot({ files: { 'data:/paper-out/big.html': Buffer.alloc(10 * MIB + 1, 0x61) } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [
        { kind: 'file', data: 'data:/paper-out/big.html', name: 'big.html' },
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

  it('agent 发出的非媒体附件拒发之后留投递失败记录，不当作已发出', async () => {
    const t = await boot({ files: { 'aalis:/aalis.config.yaml': CONFIG } });
    await t.send({
      sessionId: GROUP,
      content: '',
      attachments: [{ kind: 'image', data: 'aalis:/aalis.config.yaml' }],
      source: 'agent',
    });
    await until(() => t.failureNotes().length > 0);
    await t.flush();
    expect(JSON.stringify(t.actions)).not.toContain(CONFIG.toString('base64'));
    expect(t.sent().some(a => a.action.startsWith('upload_'))).toBe(false);
    expect(t.failureNotes().map(n => n.sessionId)).toEqual([GROUP]);
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
