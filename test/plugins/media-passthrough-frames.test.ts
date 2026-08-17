import { App, type Context } from '@aalis/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 图像四模式的出口形态变换（transformModelImages + agent:llm:before 中间件）：
//   describe / disabled → 一张不交给主模型（识别是视觉模型的职责，结果已在正文文字里；
//                          disabled 的配置语义本就是「丢弃图片」）
//   passthrough-raw     → 不抽帧，形态规范化后交出
//   passthrough         → 静图规范化交出，动图抽帧为多张静图 data URI
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

import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';

const GIF_DATA = 'data:image/gif;base64,R0lGODlh';
const PLAIN_URL = 'https://example.invalid/img.jpg';
const NOEXT_URL = 'https://example.invalid/rkey/pic?id=1';

function makeSvc(mode: MediaConfigResolved['vision']['mode']): MediaServiceImpl {
  const cfg = {
    vision: { mode, maxTokens: 300, think: false },
    animatedImage: { maxFrames: 5 },
    video: { mode: 'disabled', maxFrames: 5 },
    audio: { mode: 'disabled' },
    contextHistory: { enabled: false },
    senderContext: false,
  } as unknown as MediaConfigResolved;
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return new MediaServiceImpl({} as Context, logger as never, cfg);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.materializeAttachment.mockResolvedValue({ path: '/tmp/x.gif', cleanup: mocks.cleanup });
  mocks.getFrameCount.mockResolvedValue(20);
  mocks.extractFrames.mockImplementation(async (_p, indices) => indices.map((_, i) => `frame-${i}`));
});

describe('transformModelImages 三模式真值表', () => {
  it('describe：一张不交给主模型（识别由视觉模型负责，结果已是正文里的文字）', async () => {
    const svc = makeSvc('describe');
    // 改前这里断言「原样」——那是主模型无 vision 能力时代的无害空转。主模型一旦有
    // vision，同一张图就被识别两遍：实测 57KB 的图多花 1,090 token / 4.7 秒预填充。
    expect(await svc.transformModelImages([PLAIN_URL, GIF_DATA])).toEqual([]);
    expect(mocks.materializeAttachment).not.toHaveBeenCalled();
  });

  it('disabled：同样一张不交（配置项语义就是「丢弃图片」）', async () => {
    const svc = makeSvc('disabled');
    expect(await svc.transformModelImages([PLAIN_URL, GIF_DATA])).toEqual([]);
  });

  it('passthrough-raw：一律原样（动图不抽帧）', async () => {
    const svc = makeSvc('passthrough-raw');
    const images = [GIF_DATA];
    expect(await svc.transformModelImages(images)).toEqual(images);
    expect(mocks.materializeAttachment).not.toHaveBeenCalled();
  });

  it('passthrough + 静图：原样，不物化', async () => {
    const svc = makeSvc('passthrough');
    expect(await svc.transformModelImages([PLAIN_URL])).toEqual([PLAIN_URL]);
    expect(mocks.materializeAttachment).not.toHaveBeenCalled();
  });

  it('passthrough + 动图 data URL：抽帧替换，并清理临时文件', async () => {
    const svc = makeSvc('passthrough');
    const out = await svc.transformModelImages([GIF_DATA]);
    expect(out).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4']);
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it('passthrough：帧数受 animatedImage.maxFrames 截断（100 帧源 → 采样 5 个索引）', async () => {
    const svc = makeSvc('passthrough');
    mocks.getFrameCount.mockResolvedValue(100);
    await svc.transformModelImages([GIF_DATA]);
    const indices = mocks.extractFrames.mock.calls[0][1];
    expect(indices).toHaveLength(5);
  });

  it('物化失败 / 抽不出帧：原样退回，不丢图', async () => {
    const svc = makeSvc('passthrough');
    mocks.materializeAttachment.mockResolvedValueOnce(null);
    expect(await svc.transformModelImages([GIF_DATA])).toEqual([GIF_DATA]);
    mocks.getFrameCount.mockResolvedValueOnce(0);
    expect(await svc.transformModelImages([GIF_DATA])).toEqual([GIF_DATA]);
  });

  it('混合列表保持顺序：静图不动、动图原位展开', async () => {
    const svc = makeSvc('passthrough');
    mocks.extractFrames.mockResolvedValue(['f1', 'f2']);
    const out = await svc.transformModelImages([PLAIN_URL, GIF_DATA, NOEXT_URL]);
    expect(out).toEqual([PLAIN_URL, 'f1', 'f2', NOEXT_URL]);
  });

  it('mimeType 线索：URL 无扩展名的 GIF 经归档期登记后，出口能识别为动图', async () => {
    const svc = makeSvc('passthrough');
    const msg = {
      sessionId: 's',
      platform: 'test',
      content: '',
      attachments: [{ kind: 'image', data: NOEXT_URL, mimeType: 'image/gif' }],
    } as unknown as IncomingMessage;
    await svc.processMessage(msg); // 归档期：登记动图线索，不做描述
    expect(msg._attachmentDescriptions).toEqual([undefined]);
    const out = await svc.transformModelImages([NOEXT_URL]);
    expect(out).toEqual(['frame-0', 'frame-1', 'frame-2', 'frame-3', 'frame-4']);
  });
});

describe('agent:llm:before 中间件接线', () => {
  async function runHookWith(mode: string, dryRun: boolean) {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('process', {} as never);
    app.ctx.provide('storage', {} as never);
    const mediaModule = await import('../../packages/plugin-media/src/index.js');
    await app.ctx.useModule(mediaModule as never, { vision: { mode } });
    await app.plugins.idle();
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
    await app.ctx.runHook('agent:llm:before', data as never);
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

  it('describe 模式：末条 user 的 images 被清空（主模型不重复识别）', async () => {
    const data = await runHookWith('describe', false);
    expect(data.messages[2].images).toEqual([]);
    expect(data.messages[1].images).toEqual([GIF_DATA]); // 仅末条，历史 user 消息不动
  });

  it('工具循环重跑钩子：每条消息只处理一次（成功不重做，失败不重试）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('process', {} as never);
    app.ctx.provide('storage', {} as never);
    const mediaModule = await import('../../packages/plugin-media/src/index.js');
    await app.ctx.useModule(mediaModule as never, { vision: { mode: 'passthrough' } });
    await app.plugins.idle();

    // 失败形态：物化返回 null → 原图放回 images（仍是动图特征）
    mocks.materializeAttachment.mockResolvedValue(null);
    const data = {
      messages: [{ role: 'user' as const, content: '当前', images: [GIF_DATA] }],
      tools: [],
      sessionId: 's',
      dryRun: false,
    };
    await app.ctx.runHook('agent:llm:before', data as never);
    expect(data.messages[0].images).toEqual([GIF_DATA]); // 失败原样退回
    // 工具循环第二、三轮重跑同一钩子：不得再次尝试物化（负缓存生效）
    await app.ctx.runHook('agent:llm:before', data as never);
    await app.ctx.runHook('agent:llm:before', data as never);
    expect(mocks.materializeAttachment).toHaveBeenCalledTimes(1);
    await app.stop();
  });
});
