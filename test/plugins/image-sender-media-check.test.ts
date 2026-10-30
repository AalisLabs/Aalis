import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authority, type OriginTurn } from '../../packages/api-authority/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type ToolCallContext, tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import { principalKind } from '../../packages/plugin-authority/src/authority-model.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import { defineTexts } from '../../packages/schema-i18n/src/index.js';
import {
  type Message,
  type OutboundDeliveryResult,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { bytes, FAKE_SQLITE, FAKE_TOKEN, FAKE_YAML, png } from '../fixtures/file-heads.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { storedRoom } from '../fixtures/rooms.js';
import { toolContext } from '../fixtures/tool-call.js';

// ════════════════════════════════════════════════════════════
// send_attachment 发送存储库内的文件前按文件头核对格式。
//
// 此前 storage_uri / history_ref 只 stat 就转成本地路径发出，onebot 把文件按 base64
// 内联当图片发送、不看内容：群里任何人都能让模型把存储根里的配置、令牌、记忆库、
// 日志当图片外发。现在读文件头，按 kind 的白名单认格式，不符拒发。文件头的用例以 owner 在自己的会话里调用
// （不属于任何会话的本机文件能取，只看文件头）；history_ref 按真实落库的形状、只在调用所在会话的历史里按全等找。
// 全部用本地假文件（内容为占位符），不碰真实配置、不连 NapCat、不发网络请求。
// ════════════════════════════════════════════════════════════

/** 最小合法的 PNG。各格式的签名与判定见 test/utils/util-file-signature.test.ts */
const PNG = png();

type ToolHandler = (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;

/** owner 在 WebUI 的会话（受众只有 owner）与一个群（预置收录过的房间） */
const OWNER_SESSION = 'webui-owner-1';
const ROOM = 'onebot:x:group:1';
const OWNER_CALL = toolContext({ sessionId: OWNER_SESSION, platform: 'webui', userId: 'console' });
const ROOM_CALL = toolContext({ sessionId: ROOM, platform: 'onebot', userId: '90002' });

/**
 * 起一个 App：宿主侧 tools 替身收集 handler，memory 替身按会话交出给定历史，会话表里有 OWNER_SESSION 与 ROOM，
 * owner 是 webui:console
 */
function startApp(histories: Record<string, Message[]>) {
  const app = new App({ name: 'T', logLevel: 'error' });
  const handlers: Record<string, ToolHandler> = {};
  const host = app.bind({ provide, events });
  host.provide.use(tools, {
    register: (t: { definition: { function: { name: string } }; handler: ToolHandler }) => {
      handlers[t.definition.function.name] = t.handler;
      return () => {};
    },
    registerGroup: () => () => {},
  } as never);
  host.provide.use(memory, { getHistory: async (sessionId: string) => histories[sessionId] ?? [] } as never);
  const ownerSession: SessionInfo = {
    id: OWNER_SESSION,
    children: [],
    status: 'waiting',
    createdAt: 0,
    updatedAt: 0,
    kind: 'room',
    createdFrom: 'webui',
  };
  const sessions = new Map([
    [OWNER_SESSION, ownerSession],
    [ROOM, storedRoom(ROOM) as unknown as SessionInfo],
  ]);
  host.provide.use(sessionManager, {
    getSession: (id: string) => sessions.get(id),
    listSessions: () => [...sessions.values()],
  } as never);
  const isOwner = (p: string, u?: string) => p === 'webui' && u === 'console';
  host.provide.use(authority, { isOwner, principalOf: (turn: OriginTurn) => principalKind(turn, isOwner) } as never);
  return { app, host, handlers };
}

describe('send_attachment 发送存储库内的文件前核对文件头', () => {
  let base: string;
  let app: App;
  let handlers: Record<string, ToolHandler>;
  let outbound: Array<{ attachments?: Array<{ kind: string; data: string }> }>;
  /** 平台的投递结果：pending 是一直不给结果，null 是没有适配器认领 */
  let deliveryResult: OutboundDeliveryResult | 'pending' | null;

  /** 默认以 owner 在自己的会话里调用：本机文件能取，只看文件头 */
  const send = async (args: Record<string, unknown>, call = OWNER_CALL) =>
    JSON.parse(await handlers.send_attachment(args, call));

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'aalis-imgsend-sig-'));
    // data 是 storage-local 的内置根，映射到家目录的 state/
    const dataDir = join(base, 'state');
    mkdirSync(join(dataDir, 'images', 's'), { recursive: true });
    mkdirSync(join(dataDir, 'secret'), { recursive: true });
    writeFileSync(join(dataDir, 'images', 's', 'cat.png'), PNG);
    writeFileSync(join(dataDir, 'images', 's', 'other.png'), PNG);
    writeFileSync(join(dataDir, 'images', 's', 'song.mp3'), bytes('ID3', [4, 0, 0, 0, 0, 0, 0]));
    writeFileSync(join(dataDir, 'secret', 'config.yaml'), FAKE_YAML);
    writeFileSync(join(dataDir, 'secret', 'token.txt'), FAKE_TOKEN);
    writeFileSync(join(dataDir, 'secret', 'memory.db'), FAKE_SQLITE);
    // 不在会话媒体目录里的本机图片（如 owner 发进群的截图），历史里记作发出的附件
    mkdirSync(join(dataDir, 'shots'), { recursive: true });
    writeFileSync(join(dataDir, 'shots', 'latest.png'), PNG);

    // 真实落库的形状：入站附件的地址在 metadata 的附件清单里，她发出的附件在 SentRef 里；正文只是给模型看的占位符
    const history: Message[] = [
      {
        role: 'user',
        content: '[图片 | ref:data:/images/s/cat.png]',
        timestamp: 1,
        metadata: { [WellKnownMetadataKeys.Attachments]: [{ kind: 'image', ref: 'data:/images/s/cat.png' }] },
      },
      {
        role: 'user',
        content: '[文件: config.yaml | ref:data:/secret/config.yaml]',
        timestamp: 2,
        metadata: {
          [WellKnownMetadataKeys.Attachments]: [{ kind: 'file', name: 'config.yaml', ref: 'data:/secret/config.yaml' }],
        },
      },
      {
        role: 'assistant',
        content: '[音频 | ref:data:/images/s/song.mp3]',
        timestamp: 3,
        metadata: { [WellKnownMetadataKeys.SentRef]: 'data:/images/s/song.mp3' },
      },
      {
        role: 'assistant',
        content: '[图片 | ref:data:/shots/latest.png]',
        timestamp: 4,
        metadata: { [WellKnownMetadataKeys.SentRef]: 'data:/shots/latest.png' },
      },
    ];
    const started = startApp({ [OWNER_SESSION]: history, [ROOM]: history });
    app = started.app;
    handlers = started.handlers;
    outbound = [];
    deliveryResult = { ok: true };
    // 本组只验证文件头与来源选择，平台发送由显式模拟确认。
    started.host.events.use.on('outbound:message', m => {
      outbound.push(m as (typeof outbound)[number]);
      if (deliveryResult === 'pending') m.delivery = new Promise(() => {});
      else if (deliveryResult) m.delivery = Promise.resolve(deliveryResult);
    });
    provideHostPaths(app, base);
    await app.plugins.register(storageLocalPlugin, {});
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
    ['data:/secret/token.txt', 'audio', '音频'],
    ['data:/secret/memory.db', 'video', '视频'],
  ])('storage_uri 指向非媒体文件（%s，按 %s）→ 拒发，不出站', async (uri, kind, label) => {
    const out = await send({ kind, storage_uri: uri });
    expect(out.ok).toBeUndefined();
    expect(out.error).toMatch(new RegExp(`^文件不是受支持的${label}格式（.+），不能按 ${kind} 发送$`));
    expect(outbound).toHaveLength(0);
  });

  it('storage_uri 是媒体但 kind 不符 → 拒发，说出检测到的格式与该用的 kind', async () => {
    const out = await send({ kind: 'image', storage_uri: 'data:/images/s/song.mp3' });
    expect(out.error).toBe('文件是 MP3 音频，不能按 image 发送；请改用 kind=audio 重新发送');
    expect(outbound).toHaveLength(0);
  });

  it('storage_uri 读不出时照实报原因：未知存储根不报成「不存在」', async () => {
    const out = await send({ kind: 'image', storage_uri: 'nope:/cat.png' });
    expect(out.error).toMatch(/^未知存储根: nope/);
    expect(outbound).toHaveLength(0);
  });

  // 本机路径不是存储地址：回给模型的是工具层的说明，不是写给配置作者的「去 roots 里加根」
  it.each([
    '/data/images/s/cat.png',
    'C:\\pics\\cat.png',
    'C:/pics/cat.png',
    '~/pics/cat.png',
  ])('storage_uri 写成本机路径 %s → 拒发，说明要写存储地址', async uri => {
    const out = await send({ kind: 'image', storage_uri: uri });
    expect(out.error).toBe('storage_uri 要写存储地址（如 data:/images/…），不能写本机路径');
    expect(outbound).toHaveLength(0);
  });

  it('storage_uri 指向合法 PNG → 照常发出', async () => {
    const out = await send({ kind: 'image', storage_uri: 'data:/images/s/cat.png' });
    expect(out).toEqual({ ok: true, sent: { kind: 'image', via: 'storage_uri', ref: 'data:/images/s/cat.png' } });
    expect(outbound).toHaveLength(1);
    expect(outbound[0].attachments?.[0].data, '交出 storage URI，送达形态由平台适配器定').toBe(
      'data:/images/s/cat.png',
    );
  });

  it.each([
    ['owner 在自己的会话里', OWNER_CALL],
    ['群友在群里', ROOM_CALL],
  ])('history_ref 按真实落库的形状找到并发出（%s）：入站附件清单与发出的附件都算', async (_label, call) => {
    const image = await send({ kind: 'image', history_ref: 'ref:data:/images/s/cat.png' }, call);
    expect(image).toEqual({ ok: true, sent: { kind: 'image', via: 'history_ref', ref: 'data:/images/s/cat.png' } });
    const audio = await send({ kind: 'audio', history_ref: 'data:/images/s/song.mp3' }, call);
    expect(audio.ok).toBe(true);
    expect(outbound.map(m => m.attachments?.[0].data)).toEqual(['data:/images/s/cat.png', 'data:/images/s/song.mp3']);
  });

  it.each([
    ['owner 在自己的会话里', OWNER_CALL],
    ['群友在群里', ROOM_CALL],
  ])('history_ref 指向存在、但不在本会话历史里的文件 → 拒（%s）', async (_label, call) => {
    const out = await send({ kind: 'image', history_ref: 'data:/images/s/other.png' }, call);
    expect(out.error).toBe('未在本会话历史中找到引用: data:/images/s/other.png');
    const elsewhere = await send(
      { kind: 'image', history_ref: 'data:/images/s/cat.png' },
      { ...call, sessionId: 'zz' },
    );
    expect(elsewhere.error).toBe('未在本会话历史中找到引用: data:/images/s/cat.png');
    expect(outbound).toHaveLength(0);
  });

  it('history_ref 找到的是历史里发出过的本机文件：与 storage_uri 同一份判据，owner 自己的会话照发，群友在群里越界拒、不发', async () => {
    const own = await send({ kind: 'image', history_ref: 'data:/shots/latest.png' });
    expect(own.ok).toBe(true);
    const room = await send({ kind: 'image', history_ref: 'data:/shots/latest.png' }, ROOM_CALL);
    expect(room.error).toMatch(/^这个文件不在这一轮能取的范围里/);
    expect(outbound).toHaveLength(1);
  });

  it('history_ref 找到的是存储库内的非媒体文件 → 按文件头拒发', async () => {
    const out = await send({ kind: 'image', history_ref: 'ref:data:/secret/config.yaml' });
    expect(out.error).toMatch(/^文件不是受支持的图片格式/);
    expect(outbound).toHaveLength(0);
  });

  // 历史引用只记网址与存储地址：本机路径、file:// 与只写文件名的都找不到
  it.each([
    '/root/.config/QQ/Ptt/abc.amr',
    'C:\\Users\\napcat\\Ptt\\def.amr',
    '~/Ptt/ghi.amr',
    'file:///data/secret/config.yaml',
    'cat.png',
  ])('history_ref 写 %s → 按找不到拒', async ref => {
    const out = await send({ kind: 'audio', history_ref: ref });
    expect(out.error).toBe(`未在本会话历史中找到引用: ${ref}`);
    expect(outbound).toHaveLength(0);
  });

  it('history_ref 直接写网址 → 照 url 发出', async () => {
    const out = await send({ kind: 'image', history_ref: 'ref:https://example.invalid/pics/cat.png' });
    expect(out.ok).toBe(true);
    expect(out.sent.via).toBe('history_ref');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].attachments?.[0].data).toBe('https://example.invalid/pics/cat.png');
  });

  it('url 来源不读文件、照旧直发', async () => {
    const out = await send({ kind: 'image', url: 'https://example.invalid/cat.png' });
    expect(out.ok).toBe(true);
    expect(outbound[0].attachments?.[0].data).toBe('https://example.invalid/cat.png');
  });

  it('平台明确拒绝时，合法 PNG 也不能报告成功；原因是文字对象时交给模型的是原文', async () => {
    const t = defineTexts({
      ns: '@zz/image-sender-media-check',
      language: 'zh-CN',
      source: { refused: '模拟平台拒绝' },
    });
    deliveryResult = { ok: false, error: t('refused') };
    const out = await send({ kind: 'image', storage_uri: 'data:/images/s/cat.png' });
    expect(out.ok).toBeUndefined();
    expect(out.error).toBe('模拟平台拒绝');
    expect(outbound).toHaveLength(1);
  });

  it('平台一直不给结果、调用方没有回合信号：等到上限返回未确认，不报告成功', async () => {
    deliveryResult = 'pending';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      let settled = false;
      const pending = send({ kind: 'image', storage_uri: 'data:/images/s/cat.png' }).then(out => {
        settled = true;
        return out;
      });
      while (outbound.length === 0) await new Promise(r => setImmediate(r));
      await vi.advanceTimersByTimeAsync(80_000);
      expect(settled, '上限之前照常等待').toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      const out = await pending;
      expect(out.ok).toBeUndefined();
      expect(out.error).toContain('未确认');
    } finally {
      vi.useRealTimers();
    }
  });

  it('平台报结果未知（可能已经送达）：不报告成功，也不劝重发——不靠适配器的措辞', async () => {
    deliveryResult = { ok: false, error: 'upload timeout', unconfirmed: true };
    const out = await send({ kind: 'image', storage_uri: 'data:/images/s/cat.png' });
    expect(out.ok).toBeUndefined();
    expect(out.error).toContain('可能已经送达');
    expect(out.error).toContain('请勿重发');
    expect(outbound).toHaveLength(1);
  });
});

describe('send_attachment 只读文件头，不整份载入', () => {
  let app: App;

  afterEach(async () => {
    await app.stop();
  });

  it('按字节区间读前 4 KiB，不调 readFile', async () => {
    const started = startApp({});
    app = started.app;
    const reads: Array<[string, number, number]> = [];
    const big = new Uint8Array(8 * 1024 * 1024);
    big.set(PNG);
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
    started.host.provide.use(storage, fake as StorageService);
    // 大文件测试只量区间读取；平台 ACK 在此显式模拟。
    started.host.events.use.on('outbound:message', msg => {
      msg.delivery = Promise.resolve({ ok: true });
    });
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();

    const out = JSON.parse(
      await started.handlers.send_attachment({ kind: 'image', storage_uri: 'data:/big.png' }, OWNER_CALL),
    );
    expect(out.ok).toBe(true);
    expect(reads).toEqual([['data:/big.png', 0, 4096]]);
  });
});
