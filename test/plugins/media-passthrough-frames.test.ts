import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import { App, type Logger, provide, type ServiceRef } from '@aalis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 两种交付形态的出口变换（transformModelImages + agent:llm:before 中间件）：
//   describe    → 一张不交给主模型（识别是识别模型的职责，结果已在正文文字里）
//   passthrough → 静图规范化交出，动图抽帧为多张静图 data URI
// 动图判定双通道：data 串自身特征（data:image/gif、.gif 扩展名）∪ 归档期登记的
// mimeType 线索（QQ 图 URL 常无扩展名，mimeType 只在 processMessage 时可见）。
// ════════════════════════════════════════════════════════════

const mocks = vi.hoisted(() => ({
  getFrameCount: vi.fn<(path: string) => Promise<number>>(),
  extractFrames: vi.fn<(path: string, indices: number[]) => Promise<string[]>>(),
  materializeAttachment: vi.fn<(data: string) => Promise<{ path: string; cleanup: () => Promise<void> } | null>>(),
  cleanup: vi.fn(async () => {}),
}));

vi.mock(import('../../packages/plugin-media/src/ffmpeg.js'), async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    getFrameCount: mocks.getFrameCount,
    extractFrames: mocks.extractFrames,
    materializeAttachment: mocks.materializeAttachment,
  };
});

import {
  type MediaConfigResolved,
  type MediaServiceCaps,
  MediaServiceImpl,
} from '../../packages/plugin-media/src/service.js';

const GIF_DATA = 'data:image/gif;base64,R0lGODlh';
const PLAIN_URL = 'https://example.invalid/img.jpg';
const NOEXT_URL = 'https://example.invalid/rkey/pic?id=1';

/** 无提供者的按激活绑定桩：动图判定与抽帧都不碰服务 */
const empty = <P>(): ServiceRef<P> => ({
  current: undefined,
  require: () => {
    throw new Error('无提供者');
  },
  all: () => [],
  follow: () => () => {},
});

function makeSvc(recognizeOnArrival = false): MediaServiceImpl {
  const cfg = {
    vision: { recognizeOnArrival, delivery: 'auto', maxTokens: 300, think: false },
    animatedImage: { maxFrames: 5 },
    video: { mode: 'disabled', maxFrames: 5 },
    audio: { mode: 'disabled' },
    contextHistory: { enabled: false },
    senderContext: false,
  } as unknown as MediaConfigResolved;
  const caps: MediaServiceCaps = {
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    llm: empty(),
    asr: empty(),
    sessionManager: empty(),
    memory: empty(),
  };
  return new MediaServiceImpl(caps, cfg);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.materializeAttachment.mockResolvedValue({ path: '/tmp/x.gif', cleanup: mocks.cleanup });
  mocks.getFrameCount.mockResolvedValue(20);
  mocks.extractFrames.mockImplementation(async (_p, indices) => indices.map((_, i) => `frame-${i}`));
});

describe('transformModelImages 交付形态真值表', () => {
  it('describe：一张不交给主模型（识别由识别模型负责，结果已是正文里的文字）', async () => {
    const svc = makeSvc();
    // 改前这里断言「原样」——那是主模型无 vision 能力时代的无害空转。主模型一旦有
    // vision，同一张图就被识别两遍：实测 57KB 的图多花 1,090 token / 4.7 秒预填充。
    expect(await svc.transformModelImages([PLAIN_URL, GIF_DATA], 'describe')).toEqual([]);
    expect(mocks.materializeAttachment).not.toHaveBeenCalled();
  });

  it('passthrough + 静图：原样，不物化', async () => {
    const svc = makeSvc();
    expect(await svc.transformModelImages([PLAIN_URL], 'passthrough')).toEqual([PLAIN_URL]);
    expect(mocks.materializeAttachment).not.toHaveBeenCalled();
  });

  it('passthrough + 动图 data URL：抽帧替换，并清理临时文件', async () => {
    const svc = makeSvc();
    const out = await svc.transformModelImages([GIF_DATA], 'passthrough');
    expect(out).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4']);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('passthrough：帧数受 animatedImage.maxFrames 截断（100 帧源 → 采样 5 个索引）', async () => {
    const svc = makeSvc();
    mocks.getFrameCount.mockResolvedValue(100);
    await svc.transformModelImages([GIF_DATA], 'passthrough');
    const indices = mocks.extractFrames.mock.calls[0][1];
    expect(indices).toHaveLength(5);
  });

  it('物化失败 / 抽不出帧：已是合法形态的整图原样退回（裸 ref 则丢弃，见 media-model-images）', async () => {
    const svc = makeSvc();
    mocks.materializeAttachment.mockResolvedValueOnce(null);
    expect(await svc.transformModelImages([GIF_DATA], 'passthrough')).toEqual([GIF_DATA]);
    mocks.getFrameCount.mockResolvedValueOnce(0);
    expect(await svc.transformModelImages([GIF_DATA], 'passthrough')).toEqual([GIF_DATA]);
  });

  it('混合列表保持顺序：静图不动、动图原位展开', async () => {
    const svc = makeSvc();
    mocks.extractFrames.mockResolvedValue(['f1', 'f2']);
    const out = await svc.transformModelImages([PLAIN_URL, GIF_DATA, NOEXT_URL], 'passthrough');
    expect(out).toEqual([PLAIN_URL, 'f1', 'f2', NOEXT_URL]);
  });

  it('mimeType 线索：URL 无扩展名的 GIF 经归档期登记后，出口能识别为动图', async () => {
    const svc = makeSvc();
    const msg = {
      sessionId: 's',
      platform: 'test',
      content: '',
      attachments: [{ kind: 'image', data: NOEXT_URL, mimeType: 'image/gif' }],
    } as unknown as IncomingMessage;
    await svc.processMessage(msg); // 归档期（只留指针）：登记动图线索，不做描述；http 来源的指针就是 URL 本身
    expect(msg._attachmentDescriptions).toEqual([`[图片 | ref:${NOEXT_URL}]`]);
    const out = await svc.transformModelImages([NOEXT_URL], 'passthrough');
    expect(out).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4']);
  });

  it('mimeType 线索在识别路径（recognizeOnArrival=true）下同样登记——线索登记不随识别开关走', async () => {
    const svc = makeSvc(true); // 无 vision processor：识别分支空跑，但线索必须已登记
    const msg = {
      sessionId: 's',
      platform: 'test',
      content: '',
      attachments: [{ kind: 'image', data: NOEXT_URL, mimeType: 'image/gif' }],
    } as unknown as IncomingMessage;
    await svc.processMessage(msg);
    const out = await svc.transformModelImages([NOEXT_URL], 'passthrough');
    expect(out).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4']);
  });
});

describe('agent:llm:before 中间件接线', () => {
  /** 装一份真 media：process / storage 是它的 required 依赖，不放桩它停在 pending、中间件不挂 */
  async function bootMedia(delivery: string) {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, hooks });
    host.provide(processService, {} as never);
    host.provide(storage, {} as never);
    const media = (await import('../../packages/plugin-media/src/index.js')).default;
    await app.plugin(media, { vision: { delivery } });
    await app.plugins.idle();
    if (app.plugins.getPlugin(media.name)?.state !== 'active') throw new Error('plugin-media 未激活');
    return { app, host };
  }

  async function runHookWith(delivery: string, dryRun: boolean) {
    const { app, host } = await bootMedia(delivery);
    const data = {
      messages: [
        { role: 'system' as const, content: '头' },
        { role: 'user' as const, content: '旧消息', images: [GIF_DATA] },
        { role: 'user' as const, content: '当前消息', images: [GIF_DATA, PLAIN_URL] },
      ],
      tools: [],
      sessionId: 's',
      dryRun,
    };
    await host.hooks.run('agent:llm:before', data as never);
    await app.stop();
    return data;
  }

  it('passthrough：末条 user 的动图被抽帧替换，历史 user 消息不动', async () => {
    const data = await runHookWith('passthrough', false);
    expect(data.messages[2].images).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4', PLAIN_URL]);
    expect(data.messages[1].images).toEqual([GIF_DATA]); // 仅末条，历史原样
  });

  it('dryRun 估算轮：跳过变换', async () => {
    const data = await runHookWith('passthrough', true);
    expect(data.messages[2].images).toEqual([GIF_DATA, PLAIN_URL]);
  });

  it('describe 交付：末条 user 的 images 被清空（主模型不重复识别）', async () => {
    const data = await runHookWith('describe', false);
    expect(data.messages[2].images).toEqual([]);
    expect(data.messages[1].images).toEqual([GIF_DATA]); // 仅末条，历史 user 消息不动
  });

  it('工具循环重跑钩子：每条消息只处理一次（成功不重做，失败不重试）', async () => {
    const { app, host } = await bootMedia('passthrough');

    // 失败形态：物化返回 null → 原图放回 images（仍是动图特征）
    mocks.materializeAttachment.mockResolvedValue(null);
    const data = {
      messages: [{ role: 'user' as const, content: '当前', images: [GIF_DATA] }],
      tools: [],
      sessionId: 's',
      dryRun: false,
    };
    await host.hooks.run('agent:llm:before', data as never);
    expect(data.messages[0].images).toEqual([GIF_DATA]); // 失败原样退回
    // 工具循环第二、三轮重跑同一钩子：不得再次尝试物化（负缓存生效）
    await host.hooks.run('agent:llm:before', data as never);
    await host.hooks.run('agent:llm:before', data as never);
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(1);
    await app.stop();
  });
});
