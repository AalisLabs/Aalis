import type { Context, Logger } from '@aalis/core';
import { App } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';

// ════════════════════════════════════════════════════════════
// 出口形态变换：主模型 images 字段里绝不能出现裸路径 ref
//
// 事故：适配器给 attachment.data 的是历史相对路径 `data/images/{会话}/{哈希}.gif`，
// agent 原样塞进 message.images，而 provider 只认 data URI / http / file:// / 绝对路径 ——
// 裸路径被当成 base64 送给 Ollama，整轮请求被拒：
//   Ollama API 错误 (400): {"error":"illegal base64 data at input byte 18"}
//   （`data/images/onebot` 正好 18 字符，第 18 字节是非法 base64 字符 `_`）
// 以前主模型是 DeepSeek，无 vision 能力、images 被忽略，缺陷潜伏；换成自带 vision 的
// 本地模型后当场引爆。契约：出口只交出 provider 能解码的形态，交不出就丢这一张。
// ════════════════════════════════════════════════════════════

const ctx = { getAllServices: () => [], getService: () => undefined } as unknown as Context;
const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

const REF = 'data/images/onebot_1321759429_group_878279594/b4476ff0fcb7e633.gif';
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';

function svcWith(mode: string): MediaServiceImpl {
  const cfg = {
    vision: { mode, maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
  } as unknown as MediaConfigResolved;
  return new MediaServiceImpl(ctx, logger, cfg);
}

describe('transformModelImages：裸路径 ref 不得流向 provider', () => {
  it('describe 模式：一张不交（识别是视觉模型的活，主模型只读正文文字）', async () => {
    expect(await svcWith('describe').transformModelImages([REF])).toEqual([]);
  });

  it('disabled 模式：一张不交（配置语义即「丢弃图片」）', async () => {
    expect(await svcWith('disabled').transformModelImages([REF])).toEqual([]);
  });

  it('passthrough 模式：已是 data URI 的原样交出（不重复编码）', async () => {
    const out = await svcWith('passthrough').transformModelImages([DATA_URI]);
    expect(out).toEqual([DATA_URI]);
  });

  it('passthrough 模式：物化不了的裸路径被丢弃，而不是原样外泄', async () => {
    // 无 media 运行时（storage 未注入）→ 规范化必然失败，此时正确行为是丢图，
    // 而不是把裸路径塞给 provider 让整轮请求 400。
    expect(await svcWith('passthrough').transformModelImages([REF])).toEqual([]);
  });

  it('passthrough-raw 模式：不抽帧，但同样不外泄裸路径', async () => {
    expect(await svcWith('passthrough-raw').transformModelImages([REF])).toEqual([]);
  });

  it('passthrough-raw + 可用 storage：裸路径被真的物化成 data URL（修复的正向路径）', async () => {
    // 上面几条只证明「没外泄」，空数组也算通过；这条才守住「确实变成了合法形态」。
    const gif = Buffer.from('GIF89a-fake-bytes');
    setMediaRuntime({
      proc: {} as never,
      storage: {
        readFile: async () => gif,
        writeFile: async () => {},
        resolveLocalPath: async () => `/tmp/${REF}`,
      } as never,
    });
    const out = await svcWith('passthrough-raw').transformModelImages([REF]);
    expect(out).toHaveLength(1);
    expect(out[0].startsWith('data:image/gif;base64,')).toBe(true);
    expect(out[0]).toContain(gif.toString('base64'));
  });

  it('多张混合：data URI 保留、裸路径不外泄', async () => {
    const out = await svcWith('passthrough').transformModelImages([DATA_URI, REF, DATA_URI]);
    expect(out.filter(s => s === DATA_URI)).toHaveLength(2);
    expect(out.some(s => s.startsWith('data/'))).toBe(false);
  });
});

describe('agent:llm:before 中间件：describe 模式也必须过形态闸', () => {
  it('describe 模式下末条 user 的裸路径 ref 不会原样送到 provider（现场 400 的那条路径）', async () => {
    const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
    app.ctx.provide('process', {} as never);
    app.ctx.provide('storage', {} as never);
    const mediaModule = await import('../../packages/plugin-media/src/index.js');
    await app.ctx.useModule(mediaModule as never, { vision: { mode: 'describe' } });
    await app.plugins.idle();

    const data = {
      messages: [
        { role: 'system' as const, content: '头' },
        { role: 'user' as const, content: '带图消息', images: [REF, DATA_URI] },
      ],
      tools: [],
      sessionId: 's',
      dryRun: false,
    };
    await app.ctx.runHook('agent:llm:before', data as never);
    await app.stop();

    // 改前：中间件被 mode 闸挡住 → REF 原样进 provider → 400 illegal base64。
    // 改后 describe 模式一张不交，裸路径与合法形态一起清空——主模型读正文里的识别结果。
    expect(data.messages[1].images).toEqual([]);
  });
});
