import { describe, expect, it, vi } from 'vitest';
import type { ChatModelRequest } from '../../packages/api-llm/src/index.js';
import type { ReviewConfig } from '../../packages/plugin-publish-review/src/config.js';
import { createReviewPipeline } from '../../packages/plugin-publish-review/src/pipeline.js';
import type { RenderRequest } from '../../packages/util-offline-render/src/index.js';

function chunk(type: string, body: Uint8Array): Uint8Array {
  const payload = Buffer.concat([Buffer.from(type), body]);
  let crc = -1;
  for (const byte of payload) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length, 0);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ -1) >>> 0, result.length - 4);
  return result;
}
const png = Buffer.concat([
  Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  chunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0)),
  chunk('IDAT', Uint8Array.of(1, 2, 3)),
  chunk('IEND', new Uint8Array()),
]);

const make = (textClassifier: { provider?: string; model?: string }) => {
  const chat = vi.fn(async (_request: ChatModelRequest) => ({
    content: '{"verdict":"allow","categories":[],"note":""}',
  }));
  const llm = { all: () => [{ contextId: 'provider/model', instance: { capabilities: ['vision'], chat } }] };
  const renderer = { renderPng: vi.fn(async (_request: RenderRequest) => png) };
  const config = {
    ffmpegPath: 'ffmpeg',
    reviewEnabled: true,
    textClassifier,
    imageClassifier: textClassifier,
  } as ReviewConfig;
  const pipeline = createReviewPipeline({
    config,
    llm: llm as never,
    renderer: renderer as never,
    storage: {} as never,
  });
  return { pipeline, chat, renderer };
};

describe('publish review pipeline', () => {
  const input = {
    id: 'abcdefghijklmnop',
    title: '作品',
    summary: '简介',
    files: [
      {
        path: 'index.html',
        bytes: new TextEncoder().encode('<!doctype html><html><p aria-label="隐含文字">正文</p></html>'),
      },
    ],
    signal: new AbortController().signal,
  };

  it('reviews exact text and vision models and renders a self-contained webpage', async () => {
    const { pipeline, chat, renderer } = make({ provider: 'provider', model: 'model' });
    const result = await pipeline.run(input);
    expect(result.verdict).toEqual({ verdict: 'allow', reasons: [] });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0][0].messages[0].content).toContain('隐含文字');
    expect(chat.mock.calls[1][0].requireImages).toBe(true);
    expect(renderer.renderPng.mock.calls[0][0].entry).toBe('https://render.invalid/abcdefghijklmnop/');
  });

  it('does not fall back from an incomplete or unavailable model reference', async () => {
    const { pipeline, chat } = make({ provider: 'provider' });
    const result = await pipeline.run(input);
    expect(result.verdict.verdict).toBe('unsure');
    expect(chat).not.toHaveBeenCalled();
  });

  it('when review is disabled, strips files and approves without marking, rendering, or calling models', async () => {
    const { chat, renderer } = make({ provider: 'provider', model: 'model' });
    const pipeline = createReviewPipeline({
      config: {
        ffmpegPath: 'ffmpeg',
        reviewEnabled: false,
        textClassifier: { provider: 'provider', model: 'model' },
      } as ReviewConfig,
      llm: { all: () => [{ contextId: 'provider/model', instance: { capabilities: ['vision'], chat } }] } as never,
      renderer: renderer as never,
      storage: {} as never,
    });
    const result = await pipeline.run({
      ...input,
      title: '色情',
      files: [{ path: 'index.html', bytes: new TextEncoder().encode('<!doctype html><html><body>色情</body></html>') }],
    });
    expect(result.verdict).toEqual({ verdict: 'allow', reasons: [] });
    expect(result.files[0].bytes).toEqual(new TextEncoder().encode('<!doctype html><html><body>色情</body></html>'));
    expect(result.evidence?.flags).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
    expect(renderer.renderPng).not.toHaveBeenCalled();
    const aborted = new AbortController();
    aborted.abort();
    const stopped = await pipeline.run({ ...input, signal: aborted.signal });
    expect(stopped.verdict.verdict).not.toBe('allow');
  });

  it('fails closed for MP4 stripping without a sandbox and stays unsure for GIF frame extraction', async () => {
    const { pipeline } = make({ provider: 'provider', model: 'model' });
    const mp4 = await pipeline.run({ ...input, files: [{ path: 'film.mp4', bytes: Uint8Array.of(1, 2, 3) }] });
    expect(mp4.verdict.verdict).toBe('failed');
    const gif = Uint8Array.of(
      ...Buffer.from('GIF89a'),
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      0x2c,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      2,
      1,
      0,
      0,
      0x3b,
    );
    const animation = await pipeline.run({ ...input, files: [{ path: 'animation.gif', bytes: gif }] });
    expect(animation.verdict.verdict).toBe('unsure');
    expect(animation.verdict.reasons).toContain('抽帧失败');
  });
});
