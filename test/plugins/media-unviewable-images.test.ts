import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckResult, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { type MediaProcessor, media } from '../../packages/api-media/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import type { Logger } from '../../packages/core/src/index.js';
import { App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import mediaPlugin from '../../packages/plugin-media/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import {
  buildIncomingContent,
  type IncomingMessage,
  parseAttachmentRefs,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 看不了图时告诉模型。没有任何能看图的模型（没有识图处理器；主模型若能看图，它自己就是处理器）时，
// 图照样落盘、写成不带描述的引用，这条消息另加一行「附了 N 张图，当前无法查看」——此前到达即识别开着却没有
// 处理器、或识别返回空串时既不识别也不落引用，WebUI 传的 base64 原图从此丢失，只发图的消息成了空气泡。
// 识别失败或返回空串的，引用照留、描述写失败。doctor 的「识图」项在没有能看图的模型时报 warn。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

const UNVIEWABLE = (n: number) => `[附了 ${n} 张图，当前无法查看]`;
/** 每个用例各自的图：描述缓存是模块级的，同一张图会命中前一个用例的描述 */
const png = (seed: string) => `data:image/png;base64,${Buffer.from(`png-${seed}`).toString('base64')}`;
const LANDED = /^\[图片 \| ref:data\/images\/webui-default\/[0-9a-f]{16}\.png\]$/;

function cfg(recognizeOnArrival: boolean): MediaConfigResolved {
  return {
    vision: { recognizeOnArrival, delivery: 'auto', maxTokens: 300, think: false },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
  } as unknown as MediaConfigResolved;
}

/** 落盘写进内存；返回写过的地址 */
function landInMemory(): string[] {
  const written: string[] = [];
  setMediaRuntime({
    proc: {} as never,
    storage: { writeFile: async (uri: string) => void written.push(uri) } as never,
  });
  return written;
}

function vision(describe: MediaProcessor['describe']): MediaProcessor {
  return { name: 'fake-vision', capabilities: ['vision'], describe };
}

const webui = (attachments: IncomingMessage['attachments'], content = ''): IncomingMessage => ({
  content,
  sessionId: 'webui-default',
  platform: 'webui',
  userId: 'console',
  attachments,
});

describe('没有能看图的模型', () => {
  it('到达即识别开着：WebUI 的 base64 图逐张落盘写成不带描述的引用，消息另加一行「附了 N 张图，当前无法查看」', async () => {
    const written = landInMemory();
    const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg(true));
    const msg = webui([
      { kind: 'image', data: png('a1') },
      { kind: 'file', name: 'a.txt', data: 'data:text/plain;base64,AAAA' },
      { kind: 'image', data: png('a2') },
    ]);
    await svc.processMessage(msg);

    expect(written).toHaveLength(2);
    const [first, file, last] = msg._attachmentDescriptions ?? [];
    expect(first).toMatch(LANDED);
    expect(file).toBeUndefined();
    // 那一行跟在最后一张图的引用后面、另起一行，不进任何引用的描述位
    const [lastRef, note, ...rest] = (last ?? '').split('\n');
    expect(lastRef).toMatch(LANDED);
    expect(note).toBe(UNVIEWABLE(2));
    expect(rest).toEqual([]);

    const content = buildIncomingContent(msg);
    expect(content.split(UNVIEWABLE(2))).toHaveLength(2);
    const refs = parseAttachmentRefs(content);
    expect(refs.map(r => r.ref)).toEqual(written.map(uri => uri.replace('data:/', 'data/')));
    expect(refs.every(r => r.desc === undefined)).toBe(true);
  });

  it('到达即识别关着：同样留引用并加那一行（按需看也没有模型可用）', async () => {
    landInMemory();
    const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg(false));
    const msg = webui([{ kind: 'image', data: png('b1') }]);
    await svc.processMessage(msg);
    const [only] = msg._attachmentDescriptions ?? [];
    expect(only?.split('\n')).toEqual([expect.stringMatching(LANDED), UNVIEWABLE(1)]);
  });

  it('选中的识图处理器不会描述图片（契约里 describe 可缺）：同样算看不了', async () => {
    landInMemory();
    const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg(true));
    svc.registerProcessor({ name: 'vision-without-describe', capabilities: ['vision'] });
    const msg = webui([{ kind: 'image', data: png('b2') }]);
    await svc.processMessage(msg);
    const [only] = msg._attachmentDescriptions ?? [];
    expect(only?.split('\n')).toEqual([expect.stringMatching(LANDED), UNVIEWABLE(1)]);
    expect(svc.imageDescriber()).toBeNull();
  });

  it('OneBot 的图（正文已带引用、data 是落盘后的相对路径）：描述位不再重复写引用，只写那一行', async () => {
    landInMemory();
    const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg(true));
    const msg: IncomingMessage = {
      content: '[图片 | ref:data/images/g/a.jpg][图片 | ref:data/images/g/b.jpg]',
      sessionId: 'onebot:10000:group:20001',
      platform: 'onebot',
      userId: '30001',
      attachments: [
        { kind: 'image', data: 'data/images/g/a.jpg' },
        { kind: 'image', data: 'data/images/g/b.jpg' },
      ],
    };
    await svc.processMessage(msg);
    expect(msg._attachmentDescriptions).toEqual([undefined, UNVIEWABLE(2)]);
  });

  it('存档：附件清单带上落盘后的地址，正文只有一行「无法查看」', async () => {
    const written = landInMemory();
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.register(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    const host = app.bind({ provide, messageArchive });
    const dataRoot = { name: 'data', kind: 'data', browsable: true, readable: true, writable: true, deletable: true };
    host.provide(storage, { listRoots: () => [dataRoot] } as unknown as StorageService);
    host.provide(media, new MediaServiceImpl(emptyMediaCaps(logger), cfg(true)));

    const { message } = await host.messageArchive
      .require()
      .archiveIncoming(webui([{ kind: 'image', data: png('c1') }], '看看这个'));
    expect(message.metadata?.[WellKnownMetadataKeys.Attachments]).toEqual([{ kind: 'image', ref: written[0] }]);
    expect(message.content?.split('\n')).toEqual(['看看这个', expect.stringMatching(LANDED), UNVIEWABLE(1)]);
  });
});

describe('有能看图的模型', () => {
  it('识别成功：描述带引用，不加「无法查看」', async () => {
    landInMemory();
    const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg(true));
    svc.registerProcessor(vision(async () => ({ descriptions: ['一只猫'] })));
    const msg = webui([{ kind: 'image', data: png('d1') }]);
    await svc.processMessage(msg);
    const [only] = msg._attachmentDescriptions ?? [];
    expect(only).toMatch(/^\[图片: 一只猫 \| ref:data\/images\/webui-default\/[0-9a-f]{16}\.png\]$/);
  });

  it.each([
    ['返回空串', async () => ({ descriptions: [''] })],
    [
      '抛错',
      async () => {
        throw new Error('模型超时');
      },
    ],
  ] as const)('识别%s：引用照留，描述写「获取或识别失败，内容未知」，记为失败；不加「无法查看」', async (label, describe) => {
    const written = landInMemory();
    const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg(true));
    svc.registerProcessor(vision(describe));
    const msg = webui([{ kind: 'image', data: png(`e-${label}`) }]);
    const report = await svc.processMessage(msg);

    expect(written).toHaveLength(1);
    const [only] = msg._attachmentDescriptions ?? [];
    expect(parseAttachmentRefs(only ?? '')).toEqual([
      { kind: '图片', desc: '获取或识别失败，内容未知', ref: written[0].replace('data:/', 'data/') },
    ]);
    expect(only).not.toContain('无法查看');
    expect(report.successCount).toBe(0);
    expect(report.items[0].error).toBeTruthy();
  });
});

// ===== doctor 的「识图」项 =====

function seer(): LLMModel {
  return {
    id: 'seer',
    providerId: 'eyes',
    contextLength: 8000,
    capabilities: ['chat', 'vision'],
    async chat() {
      return { content: '看到了' };
    },
  };
}

async function bootWithDoctor() {
  const files = new Map<string, Buffer>();
  const dataRoot = { name: 'data', label: 'data', kind: 'data', readable: true, writable: true, deletable: true };
  const store = {
    listRoots: () => [dataRoot],
    async readFile(uri: string) {
      const data = files.get(uri);
      if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      return data;
    },
    async writeFile(uri: string, data: string | Buffer) {
      files.set(uri, Buffer.from(data));
    },
  } as unknown as StorageService;
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, services });
  host.provide(processService, {} as never);
  host.provide(storage, store);
  await app.plugins.register(doctorPlugin, {});
  await app.plugins.register(mediaPlugin, {});
  await app.plugins.idle();
  if (app.plugins.getPlugin(mediaPlugin.name)?.state !== 'active') throw new Error('plugin-media 没有激活');
  const service = host.services.get(doctor) as DoctorService;
  const check = async (): Promise<CheckResult | undefined> =>
    (await service.runChecks()).checks.find(c => c.id === 'media.vision');
  return { app, check };
}

describe('doctor 的「识图」项', () => {
  it('没有能看图的识别模型时 warn，写明后果与修法；加了能看图的模型后转 ok', async () => {
    const { app, check } = await bootWithDoctor();
    expect(await check()).toEqual({
      id: 'media.vision',
      category: 'service',
      level: 'warn',
      message: '装了识图插件，但没有能看图的识别模型：图片照样存下，主模型看不到内容',
      detail: '在模型服务里加一个能看图的模型，再到「多模态媒体识别」的「图像识别 → 识别模型」里选它（留空则自动选用）',
    });

    await app.plugins.register(
      definePlugin({
        name: 'eyes',
        provides: [llm],
        uses: { provide },
        apply({ provide }) {
          provide(llm, seer(), { entryId: 'eyes/seer' });
        },
      }),
      {},
    );
    await app.plugins.idle();
    expect(await check()).toMatchObject({
      id: 'media.vision',
      level: 'ok',
      message: '识图可用，识别模型：eyes/seer (vision)',
    });
  });
});
