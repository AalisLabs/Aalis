import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { App, type Logger, provide } from '@aalis/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { be32, chunk, gif, png } from '../fixtures/file-heads.js';
import { registerHubs } from '../fixtures/hubs.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 两种交付形态的出口变换（transformModelImages + agent:llm:before 中间件）：
//   describe    → 一张不交给主模型（识别是识别模型的职责，结果已在正文文字里）
//   passthrough → 静图规范化交出，动图抽帧为多张静图 data URI
// 要不要抽帧按来源的字节判：视频容器，或多帧的 GIF、APNG、动态 WebP；单帧 GIF 按静图。扩展名、data URL 写的类型与
// 适配器报的 mimeType 都不看。
// ════════════════════════════════════════════════════════════

const mocks = vi.hoisted(() => ({
  getFrameCount: vi.fn<(path: string) => Promise<number>>(),
  extractFrames: vi.fn<(path: string, indices: number[]) => Promise<string[]>>(),
  materializeBytes:
    vi.fn<(bytes: Uint8Array) => Promise<{ path: string; uri: string; cleanup: () => Promise<void> } | null>>(),
  cleanup: vi.fn(async () => {}),
}));

vi.mock(import('../../packages/plugin-media/src/ffmpeg.js'), async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    getFrameCount: mocks.getFrameCount,
    extractFrames: mocks.extractFrames,
    materializeBytes: mocks.materializeBytes,
  };
});

import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';

const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const ANIMATED_GIF = dataUrl('image/gif', gif(2));
const SINGLE_GIF = dataUrl('image/gif', gif(1));
const APNG = dataUrl('image/png', png(chunk('acTL', [...be32(2), ...be32(0)]), chunk('IDAT', [0])));
const STATIC_PNG = dataUrl('image/png', png(chunk('IDAT', [0])));
/** 存储里没有扩展名的两帧 GIF */
const NOEXT_REF = 'data:/images/s/onebot/0123456789abcdef';
/** 存储里扩展名写着 .png 的 JPEG 静图 */
const JPEG_REF = 'data:/images/s/onebot/fedcba9876543210.png';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const FRAMES = ['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4'];

function makeSvc(recognizeOnArrival = false): MediaServiceImpl {
  const cfg = {
    vision: { recognizeOnArrival, delivery: 'auto', maxTokens: 300, think: false },
    animatedImage: { maxFrames: 5 },
    video: { mode: 'disabled', maxFrames: 5, framePrefix: '[画面] ' },
    audio: { mode: 'disabled' },
    contextHistory: { enabled: false },
    senderContext: false,
  } as unknown as MediaConfigResolved;
  // 无提供者的能力桩：动图判定与抽帧都不碰服务
  const caps = emptyMediaCaps({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger);
  return new MediaServiceImpl(caps, cfg);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.materializeBytes.mockResolvedValue({
    path: '/tmp/zz-frames-src',
    uri: 'tmp:/zz-frames-src',
    cleanup: mocks.cleanup,
  });
  mocks.getFrameCount.mockResolvedValue(20);
  mocks.extractFrames.mockImplementation(async (_p, indices) => indices.map((_, i) => `frame-${i}`));
  // 存储里只有那张没有扩展名的两帧 GIF 与写着 .png 的 JPEG；上传的图照常落盘（写入不留），存储地址解析成同名的本机路径
  setMediaRuntime({
    proc: {} as never,
    storage: {
      readFile: async (uri: string) => {
        if (uri === NOEXT_REF) return gif(2);
        if (uri === JPEG_REF) return JPEG;
        throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
      },
      writeFile: async () => {},
      resolveLocalPath: async (uri: string) => `/zz-local/${uri.slice(uri.lastIndexOf('/') + 1)}`,
    } as never,
  });
});

describe('transformModelImages 交付形态真值表', () => {
  it('describe：一张不交给主模型（识别由识别模型负责，结果已是正文里的文字）', async () => {
    const svc = makeSvc();
    // 改前这里断言「原样」——那是主模型无 vision 能力时代的无害空转。主模型一旦有
    // vision，同一张图就被识别两遍：实测 57KB 的图多花 1,090 token / 4.7 秒预填充。
    expect(await svc.transformModelImages([STATIC_PNG, ANIMATED_GIF], 'describe')).toEqual([]);
    expect(mocks.materializeBytes).not.toHaveBeenCalled();
  });

  it('passthrough + 静图：原样，不抽帧', async () => {
    const svc = makeSvc();
    expect(await svc.transformModelImages([STATIC_PNG], 'passthrough')).toEqual([STATIC_PNG]);
    expect(mocks.materializeBytes).not.toHaveBeenCalled();
  });

  it('passthrough + 存储地址的静图：按读到的字节转成 data URL 交出，类型取判定结果，不按扩展名猜', async () => {
    const svc = makeSvc();
    expect(await svc.transformModelImages([JPEG_REF], 'passthrough')).toEqual([dataUrl('image/jpeg', JPEG)]);
  });

  it('passthrough + 单帧 GIF：按静图规范化交出，不抽帧', async () => {
    const svc = makeSvc();
    expect(await svc.transformModelImages([SINGLE_GIF], 'passthrough')).toEqual([SINGLE_GIF]);
    expect(mocks.getFrameCount).not.toHaveBeenCalled();
  });

  it.each([
    ['两帧 GIF 的 data URL', ANIMATED_GIF],
    ['APNG', APNG],
    ['没有扩展名的存储地址里的两帧 GIF', NOEXT_REF],
  ])('passthrough + %s：抽帧替换，并清理临时文件', async (_label, source) => {
    const svc = makeSvc();
    expect(await svc.transformModelImages([source], 'passthrough')).toEqual(FRAMES);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('passthrough：帧数受 animatedImage.maxFrames 截断（100 帧源 → 采样 5 个索引）', async () => {
    const svc = makeSvc();
    mocks.getFrameCount.mockResolvedValue(100);
    await svc.transformModelImages([ANIMATED_GIF], 'passthrough');
    const indices = mocks.extractFrames.mock.calls[0][1];
    expect(indices).toHaveLength(5);
  });

  it('临时文件写不出 / 抽不出帧：已是合法形态的整图原样退回（裸 ref 则丢弃，见 media-model-images）', async () => {
    const svc = makeSvc();
    mocks.materializeBytes.mockResolvedValueOnce(null);
    expect(await svc.transformModelImages([ANIMATED_GIF], 'passthrough')).toEqual([ANIMATED_GIF]);
    mocks.getFrameCount.mockResolvedValueOnce(0);
    expect(await svc.transformModelImages([ANIMATED_GIF], 'passthrough')).toEqual([ANIMATED_GIF]);
  });

  it('混合列表保持顺序：静图不动、动图原位展开', async () => {
    const svc = makeSvc();
    mocks.extractFrames.mockResolvedValue(['f1', 'f2']);
    const out = await svc.transformModelImages([STATIC_PNG, ANIMATED_GIF, SINGLE_GIF], 'passthrough');
    expect(out).toEqual([STATIC_PNG, 'f1', 'f2', SINGLE_GIF]);
  });
});

describe('网址来源：先下载下来判，只下一次', () => {
  let server: Server;
  let origin: string;
  const requests: string[] = [];

  beforeAll(async () => {
    setNetworkPolicy({ blockPrivate: false }); // 只为连本机的上游桩；afterAll 复原
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(req.url === '/anim' ? gif(2) : png(chunk('IDAT', [0])));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setNetworkPolicy({ blockPrivate: true });
    await new Promise(resolve => server.close(resolve));
  });

  it('静图按下到的字节转成 data URL 交出，类型取判定结果；没有扩展名的两帧 GIF 抽帧', async () => {
    const svc = makeSvc();
    requests.length = 0;
    const out = await svc.transformModelImages([`${origin}/still`, `${origin}/anim`], 'passthrough');
    expect(out).toEqual([STATIC_PNG, ...FRAMES]);
    expect(requests, '每张只下一次').toEqual(['/still', '/anim']);
  });

  it('到达识别命中缓存时不再下载来源，描述位与第一次同一形态', async () => {
    const svc = makeSvc(true);
    const vision = visionAnswering(() => '一张图');
    svc.registerProcessor(vision.processor);
    requests.length = 0;
    const url = `${origin}/cached-still`;
    const first = await svc.processMessage(imageMessage(url));
    const second = await svc.processMessage(imageMessage(url));
    expect(requests).toEqual(['/cached-still']);
    expect(vision.modes).toEqual(['single']);
    expect(second.items[0].description).toBe(first.items[0].description);
  });
});

/** 识图替身：按识别模式回一句，记下每次的模式 */
function visionAnswering(answer: (mode: string | undefined) => string) {
  const modes: Array<string | undefined> = [];
  const processor: MediaProcessor = {
    name: 'fake-vision',
    capabilities: ['vision'],
    describe: async input => {
      modes.push(input.mode);
      return { descriptions: [answer(input.mode)] };
    },
  };
  return { processor, modes };
}

/** 一条只带一张图的入站消息（每次新建：同一条消息对象只处理一次） */
const imageMessage = (data: string) =>
  ({
    sessionId: 's',
    platform: 'test',
    content: '',
    attachments: [{ kind: 'image', data }],
  }) as unknown as IncomingMessage;

describe('到达识别（recognizeOnArrival）按字节判动图', () => {
  it('单帧 GIF（适配器报的 mimeType 是 image/gif）走单图识别，不抽帧', async () => {
    const svc = makeSvc(true);
    const modes: Array<string | undefined> = [];
    const vision: MediaProcessor = {
      name: 'fake-vision',
      capabilities: ['vision'],
      describe: async input => {
        modes.push(input.mode);
        return { descriptions: ['一张图'] };
      },
    };
    svc.registerProcessor(vision);
    const msg = {
      sessionId: 's',
      platform: 'test',
      content: '',
      attachments: [{ kind: 'image', data: SINGLE_GIF, mimeType: 'image/gif' }],
    } as unknown as IncomingMessage;
    await svc.processMessage(msg);
    expect(modes).toEqual(['single']);
    expect(mocks.getFrameCount).not.toHaveBeenCalled();
  });

  it('动图抽出帧：合并识别，描述位与静图同一形态（带落盘的引用）', async () => {
    const svc = makeSvc(true);
    const vision = visionAnswering(() => '一段动图');
    svc.registerProcessor(vision.processor);
    const report = await svc.processMessage(imageMessage(dataUrl('image/gif', gif(3))));
    expect(vision.modes).toEqual(['combined']);
    expect(report.items[0].description).toMatch(
      /^\[图片: \[画面］ 一段动图 \| ref:data:\/images\/.+\/media\/[0-9a-f]{16}\.gif\]$/,
    );
  });

  it('动图抽不出帧：退回整图识别，不写视频的失败说明', async () => {
    mocks.getFrameCount.mockResolvedValue(0);
    const svc = makeSvc(true);
    const vision = visionAnswering(() => '一张图');
    svc.registerProcessor(vision.processor);
    const report = await svc.processMessage(imageMessage(dataUrl('image/gif', gif(4))));
    expect(vision.modes).toEqual(['single']);
    expect(report.items[0].description).toMatch(/^\[图片: 一张图 \| ref:data:\/images\//);
  });

  it('动图抽不出帧、整图也没识别出：不进缓存，下一条照样重试', async () => {
    mocks.getFrameCount.mockResolvedValue(0);
    const svc = makeSvc(true);
    svc.registerProcessor(visionAnswering(() => '').processor);
    const data = dataUrl('image/gif', gif(5));
    await svc.processMessage(imageMessage(data));
    await svc.processMessage(imageMessage(data));
    expect(mocks.getFrameCount).toHaveBeenCalledTimes(2);
  });
});

describe('describeImage 按字节判动图', () => {
  it('动图抽不出帧：退回整图识别', async () => {
    mocks.getFrameCount.mockResolvedValue(0);
    const svc = makeSvc();
    const vision = visionAnswering(() => '一张图');
    svc.registerProcessor(vision.processor);
    expect(await svc.describeImage(dataUrl('image/gif', gif(6)), { noCache: true })).toBe('一张图');
    expect(vision.modes).toEqual(['single']);
  });

  it('存储地址的静图：按读到的字节转成 data URL 交给识别，类型取判定结果，不按扩展名猜', async () => {
    const svc = makeSvc();
    const sent: string[] = [];
    svc.registerProcessor({
      name: 'fake-vision',
      capabilities: ['vision'],
      describe: async input => {
        sent.push(...input.attachments.map(att => att.data));
        return { descriptions: ['一张图'] };
      },
    });
    await svc.describeImage(JPEG_REF, { noCache: true });
    expect(sent).toEqual([dataUrl('image/jpeg', JPEG)]);
  });

  it('给了本地缓存路径：从它读字节判动图，不下载网址', async () => {
    setMediaRuntime({
      proc: {
        readExternalFile: async (uri: string) => {
          if (uri === 'file:///zz-cache/local.gif') return gif(2);
          throw new Error(`没有这个文件：${uri}`);
        },
      } as never,
      storage: {} as never,
    });
    const svc = makeSvc();
    const vision = visionAnswering(() => '一段动图');
    svc.registerProcessor(vision.processor);
    // 网址指向本机：受保护的下载拒内网地址，读它的话拿不到字节
    await svc.describeImage('http://127.0.0.1:9/remote.gif', { localPath: '/zz-cache/local.gif', noCache: true });
    expect(vision.modes).toEqual(['combined']);
  });
});

describe('agent:llm:before 中间件接线', () => {
  /** 装一份真 media：process / storage 是它的 required 依赖，不放桩它停在 pending、中间件不挂 */
  async function bootMedia(delivery: string, capabilities = ['chat']) {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, hooks });
    host.provide.use(processService, {} as never);
    host.provide.use(storage, {} as never);
    // media 自己取得到的对话模型：交付不看它，只看钩子交来的 acceptsImages
    host.provide.use(llm, { id: 'm', capabilities } as never, { entryId: 'zz-p/m' });
    const media = (await import('../../packages/plugin-media/src/index.js')).default;
    await app.plugin(media, { vision: { delivery } });
    await app.plugins.idle();
    if (app.plugins.getPlugin(media.name)?.state !== 'active') throw new Error('plugin-media 未激活');
    return { app, host };
  }

  async function runHookWith(delivery: string, dryRun: boolean, acceptsImages = true, capabilities?: string[]) {
    const { app, host } = await bootMedia(delivery, capabilities);
    const data = {
      messages: [
        { role: 'system' as const, content: '头' },
        { role: 'user' as const, content: '先到的输入', images: [ANIMATED_GIF] },
        { role: 'user' as const, content: '后到的输入', images: [ANIMATED_GIF, STATIC_PNG] },
      ],
      tools: [],
      sessionId: 's',
      acceptsImages,
      dryRun,
    };
    await host.hooks.use.run('agent:llm:before', data as never);
    await app.stop();
    return data;
  }

  it('passthrough：这一轮各条带图的 user 消息里的动图都被抽帧替换（历史消息不带图）', async () => {
    const data = await runHookWith('passthrough', false);
    expect(data.messages[2].images).toEqual([...FRAMES, STATIC_PNG]);
    expect(data.messages[1].images).toEqual(FRAMES);
  });

  it('dryRun 估算轮：跳过变换', async () => {
    const data = await runHookWith('passthrough', true);
    expect(data.messages[2].images).toEqual([ANIMATED_GIF, STATIC_PNG]);
  });

  it('describe 交付：这一轮各条 user 的 images 都被清空（主模型不重复识别）', async () => {
    const data = await runHookWith('describe', false);
    expect(data.messages[2].images).toEqual([]);
    expect(data.messages[1].images).toEqual([]);
  });

  it('auto：只按这一轮交来的 acceptsImages 判，不查 media 自己取得到的模型：不能看图清空 user 的 images，能看图抽帧交出', async () => {
    const blind = await runHookWith('auto', false, false, ['chat', 'vision']);
    expect(blind.messages[2].images).toEqual([]);
    const sees = await runHookWith('auto', false, true, ['chat']);
    expect(sees.messages[2].images).toEqual([...FRAMES, STATIC_PNG]);
  });

  it('工具循环重跑钩子：每条消息只处理一次（成功不重做，失败不重试）', async () => {
    const { app, host } = await bootMedia('passthrough');

    // 失败形态：临时文件写不出 → 原图放回 images（仍是动图）
    mocks.materializeBytes.mockResolvedValue(null);
    const data = {
      messages: [{ role: 'user' as const, content: '当前', images: [ANIMATED_GIF] }],
      tools: [],
      sessionId: 's',
      dryRun: false,
    };
    await host.hooks.use.run('agent:llm:before', data as never);
    expect(data.messages[0].images).toEqual([ANIMATED_GIF]); // 失败原样退回
    // 工具循环第二、三轮重跑同一钩子：不得再次尝试抽帧（负缓存生效）
    await host.hooks.use.run('agent:llm:before', data as never);
    await host.hooks.use.run('agent:llm:before', data as never);
    expect(mocks.materializeBytes).toHaveBeenCalledTimes(1);
    await app.stop();
  });
});
