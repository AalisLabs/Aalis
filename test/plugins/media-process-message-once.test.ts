import type { Logger } from '@aalis/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type AgentService, agent, type PreprocessorFn } from '../../packages/api-agent/src/index.js';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import { type StorageRootInfo, type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import fileReaderPlugin from '../../packages/plugin-file-reader/src/index.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// processMessage 按消息对象只处理一次
//
// 触发判定（判定模型要看附件描述）可能先于 agent 预处理器启动识别，预处理器再调时
// 必须拿到同一次处理，否则同一条消息识别两遍——语音与视频没有描述缓存，延迟与算力翻倍。
// 判据按消息对象，而不是「已有 _attachmentDescriptions 就跳过」：预处理器的先后取决于
// 登记次序，file-reader 先跑时会先写好文件描述，按「有描述」跳过会漏掉图片识别；
// 同理写回时不能整表覆盖，否则冲掉 file-reader 写好的文件描述。
//
// 触发判定启动的识别，宿主放行时不等它跑完，识别可能与 agent 预处理链并发：两边的写回都按
// 写回那一刻的消息只补不换，file-reader 换好的 aalis-file:// 引用与另一方的描述都保留。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

/** visionGate：识别模型在它落定前不返回，用来把识别卡在途中 */
function makeSvc(visionGate?: Promise<void>) {
  const calls = { vision: 0, audio: 0 };
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'enabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg);
  svc.registerProcessor({
    name: 'fake-vision',
    capabilities: ['vision'],
    describe: async () => {
      calls.vision++;
      await visionGate;
      return { descriptions: ['一只橘猫'] };
    },
  } as MediaProcessor);
  svc.registerProcessor({
    name: 'fake-audio',
    capabilities: ['audio'],
    transcribe: async () => {
      calls.audio++;
      return { text: '你好' };
    },
  } as MediaProcessor);
  return { svc, calls };
}

const message = (attachments: IncomingMessage['attachments'], descs?: IncomingMessage['_attachmentDescriptions']) =>
  ({
    content: '',
    sessionId: 'onebot:10000:group:20001',
    platform: 'onebot',
    attachments,
    _attachmentDescriptions: descs,
  }) as IncomingMessage;

describe('processMessage 按消息对象只处理一次', () => {
  it('同一消息并发与先后调用共享一次处理：图片与语音各只识别一次，返回同一份报告', async () => {
    const { svc, calls } = makeSvc();
    const msg = message([
      { kind: 'image', data: 'https://example.invalid/pic/once-1.jpg' },
      { kind: 'audio', data: 'https://example.invalid/voice/once-1.amr' },
    ]);

    const [first, concurrent] = await Promise.all([svc.processMessage(msg), svc.processMessage(msg)]);
    const later = await svc.processMessage(msg);
    expect(calls).toEqual({ vision: 1, audio: 1 });
    expect(concurrent).toBe(first);
    expect(later).toBe(first);
    expect(msg._attachmentDescriptions?.[0]).toContain('一只橘猫');
    expect(msg._attachmentDescriptions?.[1]).toBe('[音频] 你好');
  });

  it('file-reader 先写好文件描述：图片照常识别，文件描述不被冲掉', async () => {
    const { svc, calls } = makeSvc();
    const fileDesc = '[文件: a.txt (ID: f1)]';
    const msg = message(
      [
        { kind: 'file', name: 'a.txt', data: 'aalis-file://f1' },
        { kind: 'image', data: 'https://example.invalid/pic/once-2.jpg' },
      ],
      [fileDesc, undefined],
    );

    await svc.processMessage(msg);
    expect(calls.vision).toBe(1);
    expect(msg._attachmentDescriptions?.[0]).toBe(fileDesc);
    expect(msg._attachmentDescriptions?.[1]).toContain('一只橘猫');
  });
});

const PLUGIN_DATA_ROOT: StorageRootInfo = {
  name: 'pluginData',
  label: '插件数据',
  kind: 'pluginData',
  browsable: false,
  readable: true,
  writable: true,
  deletable: true,
};

const booted: App[] = [];

afterEach(async () => {
  for (const app of booted.splice(0)) await app.stop();
});

/** 真实 file-reader 的预处理器，存储换成内存桩；writeGate 设上后存盘在它落定前不返回 */
async function fileReaderPreprocessor() {
  const app = new App({ name: 'T', logLevel: 'error' });
  booted.push(app);
  await registerHubs(app);
  const host = app.bind({ provide });
  const files = new Map<string, Buffer>();
  const writes: { gate?: Promise<void> } = {};
  host.provide(storage, {
    listRoots: () => [PLUGIN_DATA_ROOT],
    async list(uri: string) {
      throw new Error(`目录不存在: ${uri}`);
    },
    async readFile(uri: string, encoding?: BufferEncoding) {
      const buf = files.get(uri);
      if (!buf) throw new Error(`文件不存在: ${uri}`);
      return encoding ? buf.toString(encoding) : buf;
    },
    async writeFile(uri: string, data: string | Buffer) {
      await writes.gate;
      files.set(uri, typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data));
    },
  } as unknown as StorageService);
  let preprocessor: PreprocessorFn | undefined;
  host.provide(agent, {
    async handleMessage() {},
    registerPreprocessor(_name: string, handler: PreprocessorFn) {
      preprocessor = handler;
      return () => {};
    },
  } as AgentService);
  await app.plugins.register(fileReaderPlugin, {});
  await app.plugins.idle();
  const run = preprocessor;
  if (!run) throw new Error('file-reader 未登记预处理器');
  return { run: (msg: IncomingMessage) => run(msg, async () => {}), writes };
}

const textFile = () => ({
  kind: 'file' as const,
  name: 'a.txt',
  mimeType: 'text/plain',
  data: `data:text/plain;base64,${Buffer.from('文件正文').toString('base64')}`,
});

describe('识别与 file-reader 预处理并发：写回只补不换', () => {
  it('file-reader 先完成：识别迟到的写回不把 aalis-file:// 引用改回原始数据', async () => {
    const vision = deferred();
    const { svc } = makeSvc(vision.promise);
    const fileReader = await fileReaderPreprocessor();
    const msg = message([textFile(), { kind: 'image', data: 'https://example.invalid/pic/race-1.jpg' }]);

    const recognition = svc.processMessage(msg); // 识别卡在途中
    await fileReader.run(msg);
    expect(msg.attachments?.[0].data).toMatch(/^aalis-file:\/\//);

    vision.resolve();
    await recognition;
    expect(msg.attachments?.[0].data, '文件引用应保留').toMatch(/^aalis-file:\/\//);
    expect(msg.attachments?.[1].mimeType, '图片照常补上 mimeType').toBe('image/jpeg');
    expect(msg._attachmentDescriptions?.[0]).toContain('[文件: a.txt');
    expect(msg._attachmentDescriptions?.[1]).toContain('一只橘猫');
  });

  it('识别先完成（file-reader 存盘途中）：file-reader 结尾的写回不冲掉图片描述', async () => {
    const vision = deferred();
    const { svc } = makeSvc(vision.promise);
    const fileReader = await fileReaderPreprocessor();
    const msg = message([textFile(), { kind: 'image', data: 'https://example.invalid/pic/race-2.jpg' }]);

    const recognition = svc.processMessage(msg);
    const writeGate = deferred();
    fileReader.writes.gate = writeGate.promise;
    const reading = fileReader.run(msg); // 开头读过描述，卡在存盘
    vision.resolve();
    await recognition;
    expect(msg._attachmentDescriptions?.[1]).toContain('一只橘猫');

    writeGate.resolve();
    await reading;
    expect(msg.attachments?.[0].data).toMatch(/^aalis-file:\/\//);
    expect(msg._attachmentDescriptions?.[0]).toContain('[文件: a.txt');
    expect(msg._attachmentDescriptions?.[1], '图片描述应保留').toContain('一只橘猫');
  });
});
