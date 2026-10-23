import { processService } from '@aalis/api-process';
import { storage } from '@aalis/api-storage';
import type { Logger } from '@aalis/core';
import { App, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerHubs } from '../fixtures/hubs.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 出口形态变换：主模型 images 字段里绝不能出现附件引用原串
//
// 事故：适配器给 attachment.data 的曾是相对路径 `data/images/{会话}/{哈希}.gif`，
// agent 原样塞进 message.images，而 provider 只认 data URI / http / file:// / 绝对路径 ——
// 引用原串被当成 base64 送给 Ollama，整轮请求被拒：
//   Ollama API 错误 (400): {"error":"illegal base64 data at input byte 18"}
// 以前主模型是 DeepSeek，无 vision 能力、images 被忽略，缺陷潜伏；换成自带 vision 的
// 本地模型后当场引爆。引用现在是存储地址，provider 同样不认。契约：出口只交出 provider 能解码的形态，
// 交不出就丢这一张。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

/** 无提供者的能力桩：本套用例只考出口形态变换，不需要任何服务在场 */
const caps = emptyMediaCaps(logger);

const REF = 'data:/images/onebot_10000_group_20001/onebot/b4476ff0fcb7e633.gif';
const DATA_URI = 'data:image/png;base64,iVBORw0KGgo=';

function svcWith(): MediaServiceImpl {
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'auto', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
  } as unknown as MediaConfigResolved;
  return new MediaServiceImpl(caps, cfg);
}

describe('transformModelImages：附件引用不得流向 provider', () => {
  it('describe 交付：一张不交（识别是识别模型的活，主模型只读正文文字）', async () => {
    expect(await svcWith().transformModelImages([REF], 'describe')).toEqual([]);
  });

  it('passthrough 交付：已是 data URI 的原样交出（不重复编码）', async () => {
    const out = await svcWith().transformModelImages([DATA_URI], 'passthrough');
    expect(out).toEqual([DATA_URI]);
  });

  it('passthrough 交付：物化不了的附件引用被丢弃，而不是原样外泄', async () => {
    // 无 media 运行时（storage 未注入）→ 规范化必然失败，此时正确行为是丢图，
    // 而不是把附件引用塞给 provider 让整轮请求 400。
    expect(await svcWith().transformModelImages([REF], 'passthrough')).toEqual([]);
  });

  it('passthrough + 可用 storage：动图抽帧失败时附件引用仍被物化成 data URL（修复的正向路径）', async () => {
    // 上面几条只证明「没外泄」，空数组也算通过；这条才守住「确实变成了合法形态」。
    // 这里没有 process 运行时，动图抽帧的物化必然失败 → 退回整图规范化。
    const gif = Buffer.from('GIF89a-fake-bytes');
    setMediaRuntime({
      proc: {} as never,
      storage: {
        readFile: async () => gif,
        writeFile: async () => {},
        resolveLocalPath: async () => '/tmp/zz-model-images/b4476ff0fcb7e633.gif',
      } as never,
    });
    const out = await svcWith().transformModelImages([REF], 'passthrough');
    expect(out).toHaveLength(1);
    expect(out[0].startsWith('data:image/gif;base64,')).toBe(true);
    expect(out[0]).toContain(gif.toString('base64'));
  });

  it('多张混合：data URI 保留、附件引用不外泄', async () => {
    const out = await svcWith().transformModelImages([DATA_URI, REF, DATA_URI], 'passthrough');
    expect(out.filter(s => s === DATA_URI)).toHaveLength(2);
    expect(out).not.toContain(REF);
  });
});

describe('agent:llm:before 中间件：describe 模式也必须过形态闸', () => {
  it('describe 模式下末条 user 的附件引用不会原样送到 provider（现场 400 的那条路径）', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, hooks });
    // media 把 process / storage 声明为 required：不放桩它就停在 pending，中间件根本没挂上。
    host.provide.use(processService, {} as never);
    host.provide.use(storage, {} as never);
    const media = (await import('../../packages/plugin-media/src/index.js')).default;
    await app.plugin(media, { vision: { delivery: 'describe' } });
    await app.plugins.idle();
    if (app.plugins.getPlugin(media.name)?.state !== 'active') throw new Error('plugin-media 未激活');

    const data = {
      messages: [
        { role: 'system' as const, content: '头' },
        { role: 'user' as const, content: '带图消息', images: [REF, DATA_URI] },
      ],
      tools: [],
      sessionId: 's',
      dryRun: false,
    };
    await host.hooks.use.run('agent:llm:before', data as never);
    await app.stop();

    // 改前：中间件被 mode 闸挡住 → REF 原样进 provider → 400 illegal base64。
    // 改后 describe 模式一张不交，附件引用与合法形态一起清空——主模型读正文里的识别结果。
    expect(data.messages[1].images).toEqual([]);
  });

  it('同一轮两条带图的 user 消息（插进来的输入各带各的图）：每条都规范化，不只末条', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    const host = app.bind({ provide, hooks });
    host.provide.use(processService, {} as never);
    host.provide.use(storage, {} as never);
    const media = (await import('../../packages/plugin-media/src/index.js')).default;
    await app.plugin(media, { vision: { delivery: 'describe' } });
    await app.plugins.idle();
    if (app.plugins.getPlugin(media.name)?.state !== 'active') throw new Error('plugin-media 未激活');

    const data = {
      messages: [
        { role: 'system' as const, content: '头' },
        { role: 'user' as const, content: '第一条', images: [REF] },
        { role: 'user' as const, content: '第二条', images: [DATA_URI] },
      ],
      tools: [],
      sessionId: 's',
      dryRun: false,
    };
    await host.hooks.use.run('agent:llm:before', data as never);
    await app.stop();

    expect(data.messages.map(m => m.images)).toEqual([undefined, [], []]);
  });
});
