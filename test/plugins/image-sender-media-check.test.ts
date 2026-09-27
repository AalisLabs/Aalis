import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memory } from '../../packages/api-memory/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { checkMediaHead, detectMediaFormat, type MediaKind } from '../../packages/util-media-signature/src/index.js';

// ════════════════════════════════════════════════════════════
// send_attachment 发送存储库内的文件前按文件头核对格式。
//
// 此前 storage_uri / history_ref 只 stat 就转成本地路径发出，onebot 把文件按 base64
// 内联当图片发送、不看内容：群里任何人都能让模型把存储根里的配置、令牌、记忆库、
// 日志当图片外发。现在读文件头，按 kind 的白名单认格式，不符拒发。
// 全部用本地假文件（内容为占位符），不碰真实配置、不连 NapCat、不发网络请求。
// ════════════════════════════════════════════════════════════

const ascii = (s: string) => [...s].map(c => c.charCodeAt(0));
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? ascii(p) : p)));
/** ISO 基础媒体文件的 ftyp 盒：主品牌、次版本 0、兼容品牌表。 */
const ftyp = (major: string, ...compatible: string[]) =>
  bytes(be32(16 + 4 * compatible.length), 'ftyp', major, [0, 0, 0, 0], ...compatible);
/** EBML 头：版本字段后接 DocType（0x4282 + 一字节长度 + 名字）。 */
const ebml = (docType: string) =>
  bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01],
    [0x42, 0x82, 0x80 | docType.length],
    docType,
  );

/** 各格式的最小合法文件头。 */
const HEADS: Array<[format: string, kind: MediaKind, head: Uint8Array]> = [
  ['PNG', 'image', bytes([0x89], 'PNG\r\n', [0x1a, 0x0a], be32(13), 'IHDR')],
  ['JPEG', 'image', bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 'JFIF', [0])],
  ['GIF', 'image', bytes('GIF89a', [1, 0, 1, 0, 0])],
  ['GIF', 'image', bytes('GIF87a', [1, 0, 1, 0, 0])],
  ['WebP', 'image', bytes('RIFF', le32(26), 'WEBP', 'VP8 ')],
  ['BMP', 'image', bytes('BM', le32(58), [0, 0, 0, 0], le32(54), le32(40))],
  ['AVIF', 'image', ftyp('avif', 'avif', 'mif1', 'miaf', 'MA1B')],
  ['AVIF', 'image', ftyp('mif1', 'mif1', 'avif', 'miaf')],
  ['HEIC', 'image', ftyp('heic', 'mif1', 'heic')],
  ['MP3', 'audio', bytes('ID3', [4, 0, 0, 0, 0, 0, 0])],
  ['MP3', 'audio', bytes([0xff, 0xfb, 0x90, 0x64])],
  ['MP3', 'audio', bytes([0xff, 0xf3, 0x48, 0xc4])],
  ['WAV', 'audio', bytes('RIFF', le32(36), 'WAVE', 'fmt ')],
  ['OGG', 'audio', bytes('OggS', [0, 2], [0, 0, 0, 0, 0, 0, 0, 0])],
  ['FLAC', 'audio', bytes('fLaC', [0, 0, 0, 0x22])],
  ['AMR', 'audio', bytes('#!AMR\n', [0x3c])],
  ['AMR', 'audio', bytes('#!AMR-WB\n', [0x04])],
  ['SILK', 'audio', bytes([0x02], '#!SILK_V3', [0x14, 0x00])],
  ['SILK', 'audio', bytes('#!SILK_V3', [0x14, 0x00])],
  ['M4A', 'audio', ftyp('M4A ', 'M4A ', 'mp42', 'isom')],
  ['MP4', 'video', ftyp('isom', 'isom', 'iso2', 'avc1', 'mp41')],
  ['MP4', 'video', ftyp('mp42', 'mp42', 'isom')],
  // iTunes 的 M4V 把 'M4A ' 列进兼容品牌：只看主品牌，仍是视频
  ['MP4', 'video', ftyp('M4V ', 'M4V ', 'M4A ', 'mp42', 'isom')],
  ['MOV', 'video', ftyp('qt  ', 'qt  ')],
  ['WebM', 'video', ebml('webm')],
  ['MKV', 'video', ebml('matroska')],
  ['AVI', 'video', bytes('RIFF', le32(4096), 'AVI ', 'LIST')],
];

const OTHER_KIND: Record<MediaKind, MediaKind> = { image: 'audio', audio: 'video', video: 'image' };

/** 存储根里常见的非媒体文件（内容均为占位符）。 */
const FAKE_YAML = 'server:\n  token: PLACEHOLDER-TOKEN\n  port: 0\n';
const FAKE_TOKEN = 'sk-PLACEHOLDER-0000000000000000\n';
const FAKE_SQLITE = bytes('SQLite format 3', [0], [0x10, 0x00, 0x01, 0x01]);

describe('checkMediaHead：按 kind 的白名单认格式', () => {
  it.each(HEADS)('%s 按 %s 放行', (_format, kind, head) => {
    expect(checkMediaHead(head, kind)).toBeNull();
  });

  it.each(HEADS)('detectMediaFormat 认出 %s（%s）', (format, kind, head) => {
    expect(detectMediaFormat(head)).toEqual({ kind, format });
  });

  it.each(HEADS)('%s 按别的 kind 发送：说出检测到的格式并指向正确的 kind', (format, kind, head) => {
    const message = checkMediaHead(head, OTHER_KIND[kind]);
    expect(message).toContain(`文件是 ${format} `);
    expect(message).toContain(`kind=${kind}`);
  });

  it.each([
    ['YAML 配置', bytes(FAKE_YAML)],
    ['令牌文本', bytes(FAKE_TOKEN)],
    ['SQLite 库', FAKE_SQLITE],
    ['JSON', bytes('{"users":[]}')],
    ['空文件', new Uint8Array(0)],
    ['以 BM 开头的文本', bytes('BMW owners, placeholder list\n')],
    ['以 ID3 开头的文本', bytes('ID3 tag notes\n')],
    ['以 #!AMR 开头但魔数不全的文本', bytes('#!AMRS notes\n')],
    ['AAC ADTS 帧（Layer 位为 00，不是 MP3）', bytes([0xff, 0xf1, 0x50, 0x80])],
    ['MPEG 帧同步但版本位为保留值', bytes([0xff, 0xeb, 0x90, 0x64])],
    ['MPEG Layer II 帧（不是 MP3）', bytes([0xff, 0xfd, 0x90, 0x64])],
    ['MPEG 帧但码率索引为保留值 1111', bytes([0xff, 0xfb, 0xf0, 0x64])],
    ['MPEG 帧但采样率索引为保留值 11', bytes([0xff, 0xfb, 0x9c, 0x64])],
    ['OggS 但结构版本不为 0', bytes('OggS', [1, 2], [0, 0, 0, 0, 0, 0, 0, 0])],
    ['FFD8 后不是标记', bytes([0xff, 0xd8, 0x00, 0x10])],
    ['PNG 签名不全', bytes([0x89], 'PNG', [0, 0, 0, 0])],
    ['GIF 版本不认识', bytes('GIF88a', [1, 0, 1, 0, 0])],
    ['以 fL 开头的文本', bytes('fLoat notes\n')],
    ['EBML 头但 DocType 不认识', ebml('other')],
    ['RIFF 但形式类型不认识', bytes('RIFF', le32(4), 'XXXX')],
  ])('%s：不是受支持的媒体，三种 kind 都拒', (_label, head) => {
    expect(checkMediaHead(head, 'image')).toBe(
      '文件不是受支持的图片格式（PNG、JPEG、GIF、WebP、BMP、AVIF、HEIC），不能按 image 发送',
    );
    expect(checkMediaHead(head, 'audio')).toBe(
      '文件不是受支持的音频格式（MP3、WAV、OGG、FLAC、AMR、SILK、M4A），不能按 audio 发送',
    );
    expect(checkMediaHead(head, 'video')).toBe(
      '文件不是受支持的视频格式（MP4、MOV、WebM、MKV、AVI），不能按 video 发送',
    );
    expect(detectMediaFormat(head)).toBeNull();
  });
});

type ToolHandler = (args: Record<string, unknown>, ctx: { sessionId: string }) => Promise<string>;

/** 起一个 App：宿主侧 tools 替身收集 handler，memory 替身交出给定历史。 */
function startApp(history: Message[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const handlers: Record<string, ToolHandler> = {};
  const host = app.bind({ provide, events });
  host.provide(tools, {
    register: (t: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide(memory, { getHistory: async () => history } as never);
  return { app, host, handlers };
}

describe('send_attachment 发送存储库内的文件前核对文件头', () => {
  const session = 'onebot:x:group:1';
  let base: string;
  let app: App;
  let handlers: Record<string, ToolHandler>;
  let outbound: Array<{ attachments?: Array<{ kind: string; data: string }> }>;

  const send = async (args: Record<string, unknown>) =>
    JSON.parse(await handlers.send_attachment(args, { sessionId: session }));

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-imgsend-sig-'));
    const dataDir = join(base, 'data');
    mkdirSync(join(dataDir, 'images', 's'), { recursive: true });
    mkdirSync(join(dataDir, 'secret'), { recursive: true });
    writeFileSync(join(dataDir, 'images', 's', 'cat.png'), HEADS[0][2]);
    writeFileSync(join(dataDir, 'images', 's', 'song.mp3'), bytes('ID3', [4, 0, 0, 0, 0, 0, 0]));
    writeFileSync(join(dataDir, 'secret', 'config.yaml'), FAKE_YAML);
    writeFileSync(join(dataDir, 'secret', 'token.txt'), FAKE_TOKEN);
    writeFileSync(join(dataDir, 'secret', 'memory.db'), FAKE_SQLITE);

    const history: Message[] = [
      {
        role: 'user',
        content: '[图片 | ref:data/images/s/cat.png]',
        timestamp: 1,
        attachments: [{ kind: 'image', data: 'data/images/s/cat.png' }],
      } as Message,
      {
        role: 'user',
        content: '[文件]',
        timestamp: 2,
        attachments: [{ kind: 'file', data: `file://${join(dataDir, 'secret', 'config.yaml')}` }],
      } as Message,
      {
        role: 'assistant',
        content: '[图片 | ref:https://example.invalid/pics/dog.png]',
        timestamp: 3,
        attachments: [{ kind: 'image', data: 'https://example.invalid/pics/dog.png' }],
      } as Message,
      // 入站落盘失败时 onebot 退回平台给的本机路径；首段 data 与存储根同名，Windows 路径带盘符
      {
        role: 'user',
        content: '[语音]',
        timestamp: 4,
        attachments: [
          { kind: 'audio', data: '/data/images/s/song.mp3' },
          { kind: 'audio', data: '/root/.config/QQ/Ptt/abc.amr' },
          { kind: 'audio', data: 'C:\\Users\\napcat\\Ptt\\def.amr' },
        ],
      } as Message,
    ];
    const started = startApp(history);
    app = started.app;
    handlers = started.handlers;
    outbound = [];
    started.host.events.on('outbound:message', m => {
      outbound.push(m as (typeof outbound)[number]);
    });
    await app.plugins.register(storageLocalPlugin, {
      roots: [
        {
          name: 'data',
          path: dataDir,
          label: 'data',
          kind: 'data',
          browsable: false,
          readable: true,
          writable: true,
          deletable: true,
        },
      ],
    });
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();
    const state = app.plugins.getPlugin(imageSenderPlugin.name)?.state;
    if (state !== 'active') throw new Error(`plugin-image-sender 未激活（state=${state}）`);
  });

  afterEach(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    ['data:/secret/config.yaml', 'image', '图片'],
    ['data/secret/token.txt', 'audio', '音频'],
    ['data:/secret/memory.db', 'video', '视频'],
  ])('storage_uri 指向非媒体文件（%s，按 %s）→ 拒发，不出站', async (uri, kind, label) => {
    const out = await send({ kind, storage_uri: uri });
    expect(out.ok).toBeUndefined();
    expect(out.error).toMatch(new RegExp(`^文件不是受支持的${label}格式（.+），不能按 ${kind} 发送$`));
    expect(outbound).toHaveLength(0);
  });

  it('storage_uri 是媒体但 kind 不符 → 拒发，说出检测到的格式与该用的 kind', async () => {
    const out = await send({ kind: 'image', storage_uri: 'data/images/s/song.mp3' });
    expect(out.error).toBe('文件是 MP3 音频，不能按 image 发送；请改用 kind=audio 重新发送');
    expect(outbound).toHaveLength(0);
  });

  it('storage_uri 读不出时照实报原因：未知存储根不报成「不存在」', async () => {
    const out = await send({ kind: 'image', storage_uri: 'nope:/cat.png' });
    expect(out.error).toMatch(/^未知存储根: nope/);
    expect(outbound).toHaveLength(0);
  });

  it('storage_uri 指向合法 PNG → 照常发出本地文件', async () => {
    const out = await send({ kind: 'image', storage_uri: 'data/images/s/cat.png' });
    expect(out).toEqual({ ok: true, sent: { kind: 'image', via: 'storage_uri', ref: 'data/images/s/cat.png' } });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].attachments?.[0].data).toMatch(/^file:\/\/.+\/images\/s\/cat\.png$/);
  });

  it('history_ref 直接写存储库内的非媒体文件 → 拒发', async () => {
    const out = await send({ kind: 'image', history_ref: 'ref:data/secret/config.yaml' });
    expect(out.error).toMatch(/^文件不是受支持的图片格式/);
    expect(outbound).toHaveLength(0);
  });

  it('history_ref 子串命中历史里的合法图片 → 照常发出', async () => {
    const out = await send({ kind: 'image', history_ref: 'cat.png' });
    expect(out.ok).toBe(true);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].attachments?.[0].data).toMatch(/^file:\/\/.+\/images\/s\/cat\.png$/);
  });

  it('history_ref 命中历史里存储库外的 file:// 来源 → 拒发（读不了文件头）', async () => {
    const out = await send({ kind: 'image', history_ref: 'secret/config.yaml' });
    expect(out.error).toBe('引用 secret/config.yaml 的来源不在存储库内，无法核对格式，不能发送');
    expect(outbound).toHaveLength(0);
  });

  // 宿主机绝对路径不能按首段当根名转成 storage URI：否则 /data/… 会被换成存储根 data 下同一相对路径的文件发出，
  // /root/… 报「未知存储根」
  it.each([
    ['首段与存储根同名', 'song.mp3'],
    ['首段不是存储根', 'abc.amr'],
    ['Windows 盘符路径', 'def.amr'],
  ])('history_ref 命中历史里的宿主机绝对路径（%s）→ 按库外来源拒发', async (_label, ref) => {
    const out = await send({ kind: 'audio', history_ref: ref });
    expect(out.error).toBe(`引用 ${ref} 的来源不在存储库内，无法核对格式，不能发送`);
    expect(outbound).toHaveLength(0);
  });

  it.each([
    ['子串命中历史里的 http 附件', 'dog.png', 'https://example.invalid/pics/dog.png'],
    ['直接写 URL', 'ref:https://example.invalid/pics/cat.png', 'https://example.invalid/pics/cat.png'],
  ])('history_ref 解析到 http(s)（%s）→ 照 url 发出', async (_label, ref, url) => {
    const out = await send({ kind: 'image', history_ref: ref });
    expect(out.ok).toBe(true);
    expect(out.sent.via).toBe('history_ref');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].attachments?.[0].data).toBe(url);
  });

  it('url 来源不读文件、照旧直发', async () => {
    const out = await send({ kind: 'image', url: 'https://example.invalid/cat.png' });
    expect(out.ok).toBe(true);
    expect(outbound[0].attachments?.[0].data).toBe('https://example.invalid/cat.png');
  });
});

describe('send_attachment 只读文件头，不整份载入', () => {
  let app: App;

  afterEach(async () => {
    await app.stop();
  });

  it('按字节区间读前 4 KiB，不调 readFile', async () => {
    const started = startApp([]);
    app = started.app;
    const reads: Array<[string, number, number]> = [];
    const big = new Uint8Array(8 * 1024 * 1024);
    big.set(HEADS[0][2]);
    const fake: Partial<StorageService> = {
      listRoots: () => [
        { name: 'data', kind: 'data', browsable: false, readable: true, writable: false, deletable: false },
      ],
      readFileRange: async (uri, start, end) => {
        reads.push([uri, start, end]);
        return Buffer.from(big.subarray(start, end));
      },
      readFile: async () => {
        throw new Error('不应整份读取');
      },
    };
    started.host.provide(storage, fake as StorageService);
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();

    const out = JSON.parse(
      await started.handlers.send_attachment({ kind: 'image', storage_uri: 'data:/big.png' }, { sessionId: 's' }),
    );
    expect(out.ok).toBe(true);
    expect(reads).toEqual([['data:/big.png', 0, 4096]]);
  });
});
