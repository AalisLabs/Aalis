import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Logger } from '@aalis/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LLMModel } from '../../packages/api-llm/src/index.js';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import type { RegisteredTool } from '../../packages/api-tools/src/index.js';
import {
  lookupCachedDescription,
  rememberDescription,
  VIDEO_FAILURE_TEXTS,
} from '../../packages/plugin-media/src/cache.js';
import { setMediaRuntime } from '../../packages/plugin-media/src/runtime.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import { registerMediaTools } from '../../packages/plugin-media/src/tools.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';
import { emptyMediaCaps, fixedRef, ref } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// 描述缓存的键空间一致性——「缓存只存裸描述，包装在消费点重建」。
//
// 背景：附件落盘是内容寻址路径，归档路径（processMessage）与转发/工具路径
// （describeImage）自此共用同一缓存键。改前归档路径把带 ref 标记的格式化
// 文本写进缓存：转发命中会渲染成 [图片: [图片 | ref:...]] 双层包裹；
// 反向命中则丢 ref。契约：入库一律裸描述；归档消费时按形态重新包装。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

/** 无提供者的能力桩：识别走外部注册的 processor，其余能力一律缺席 */
const caps = emptyMediaCaps(logger);

function makeSvc(description = '猫在沙发上'): { svc: MediaServiceImpl; describeCount: () => number } {
  let n = 0;
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(caps, cfg);
  const proc: MediaProcessor = {
    name: 'fake-vision',
    capabilities: ['vision'],
    priority: 10,
    describe: async () => {
      n++;
      return { descriptions: [description] };
    },
  };
  svc.registerProcessor(proc);
  return { svc, describeCount: () => n };
}

function msgWith(data: string): IncomingMessage {
  return {
    content: '[图片]',
    sessionId: 'onebot:t:group:1',
    platform: 'onebot',
    attachments: [{ kind: 'image', data }],
  } as IncomingMessage;
}

describe('描述缓存键空间一致性（裸描述入库、消费点包装）', () => {
  it('归档路径：缓存写入裸描述（不带 ref 标记），描述位仍是带 ref 的格式化文本', async () => {
    const { svc } = makeSvc();
    const key = 'data:/images/onebot_t_group_1/onebot/cachetest1.jpg';
    const report = await svc.processMessage(msgWith(key));
    expect(report.items[0].description).toContain('猫在沙发上');
    expect(report.items[0].description).toContain('ref:');
    // 缓存里必须是裸描述——格式化文本入库即双层包裹回归
    expect(lookupCachedDescription(key)).toBe('猫在沙发上');
  });

  it('归档路径缓存命中：不再调模型，且描述位重新包装出 ref（命中≠丢格式）', async () => {
    const { svc, describeCount } = makeSvc();
    const key = 'data:/images/onebot_t_group_1/onebot/cachetest2.jpg';
    await svc.processMessage(msgWith(key));
    expect(describeCount()).toBe(1);
    const second = await svc.processMessage(msgWith(key));
    expect(describeCount()).toBe(1); // 命中缓存，模型零调用
    expect(second.items[0].description).toContain('猫在沙发上');
    expect(second.items[0].description).toContain('ref:');
  });

  it('跨路径命中：describeImage 拿到的是裸描述，不含归档侧的 ref 包装', async () => {
    const { svc, describeCount } = makeSvc();
    const key = 'data:/images/onebot_t_group_1/onebot/cachetest3.jpg';
    await svc.processMessage(msgWith(key)); // 归档先识别并入缓存
    const viaTool = await svc.describeImage(key);
    expect(describeCount()).toBe(1); // 共用缓存，模型零新调用
    expect(viaTool).toBe('猫在沙发上');
    expect(viaTool).not.toContain('ref:');
  });

  it('识别模型给出的描述以「[图片: 」开头也照常进缓存：第二次命中，不再调模型', async () => {
    const { svc, describeCount } = makeSvc('[图片: 一只猫]');
    const key = 'data:/images/onebot_t_group_1/onebot/bracket-desc.jpg';
    expect(await svc.describeImage(key)).toBe('[图片: 一只猫]');
    expect(await svc.describeImage(key)).toBe('[图片: 一只猫]');
    expect(describeCount()).toBe(1);
  });
});

// 视频取不到或抽不出帧时 describeVideo 回失败说明：失败不进缓存，下次照样重试，否则同一个视频 30 天内永不重试
describe('视频失败不进缓存', () => {
  it('抽不出帧：回失败说明，再调一次重新抽', async () => {
    let probes = 0;
    setMediaRuntime({
      proc: {
        execFile: async () => {
          probes++;
          return { code: 0, signal: null, stdout: '0', stderr: '' };
        },
      } as never,
      storage: { resolveLocalPath: async () => '/zz-host/v.mp4' } as never,
    });
    const { svc } = makeSvc();
    const video = 'data:/videos/onebot_t_group_1/onebot/0123456789abcdef.mp4';
    expect(await svc.describeVideo(video)).toBe(VIDEO_FAILURE_TEXTS.noFrames);
    expect(await svc.describeVideo(video)).toBe(VIDEO_FAILURE_TEXTS.noFrames);
    expect(probes, '第二次照样去抽帧').toBe(2);
  });
});

// 失败说明与工具说明写给模型看，不点名某个平台：媒体也可能来自别的适配器或工具
describe('说明不点名平台', () => {
  it('视频失败说明与 analyze_image、update_image_description 的说明都不含 OneBot', () => {
    const definitions: unknown[] = [];
    registerMediaTools(
      {
        tools: fixedRef(
          stubBoundTools({ onRegister: (t: Omit<RegisteredTool, 'pluginName'>) => definitions.push(t.definition) }),
        ),
        memory: ref(),
        events: ref(),
        sessionManager: ref(),
        authority: ref(),
      },
      makeSvc().svc,
    );
    expect(definitions).toHaveLength(2);
    for (const text of [...Object.values(VIDEO_FAILURE_TEXTS), ...definitions.map(d => JSON.stringify(d))]) {
      expect(text).not.toMatch(/onebot/i);
    }
  });
});

// 「来源 → 落盘 ref」别名：非内容寻址的来源串（WebUI 上传的整段 base64 data URI）
// 本身不含内容哈希，落盘后才有内容寻址路径。落盘时登记一次别名，此后按原始来源串
// 读写描述都落到落盘 ref 的内容哈希键上——引用消息只拿到原始来源串时照样命中，
// 同一张图换来源进来也不重认。
describe('来源 → 落盘 ref 别名', () => {
  /** 只记 uri 的内存 storage：cacheImageRef 只用 writeFile */
  const files = new Map<string, string>();
  beforeAll(() => {
    setMediaRuntime({
      proc: {} as never,
      storage: {
        writeFile: async (uri: string) => void files.set(uri, ''),
      } as never,
    });
  });

  it('引用消息带原始图片 URL 时命中已有描述', async () => {
    const { svc, describeCount } = makeSvc();
    const bytes = Buffer.from('alias-case-fake-png-bytes');
    const sourceUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);

    // 到达路径：识别一次 + 落盘（落盘处登记别名）
    await svc.processMessage(msgWith(sourceUrl));
    expect(describeCount()).toBe(1);
    expect(
      files.has(`data:/images/onebot_t_group_1/media/${hash}.png`),
      '落在媒体识别自己的子目录，文件名是内容哈希',
    ).toBe(true);

    // 同一张图换来源（适配器已落盘的存储地址）、换会话再进来：模型零新调用
    const second = await svc.processMessage({
      content: '[图片]',
      sessionId: 'onebot:t:group:2',
      platform: 'onebot',
      attachments: [{ kind: 'image', data: `data:/images/onebot_t_group_2/onebot/${hash}.png` }],
    } as IncomingMessage);
    expect(describeCount(), '跨来源命中同一条内容哈希键，不该再识别').toBe(1);
    expect(second.items[0].description).toContain('猫在沙发上');
  });

  it('落盘方登记后按原始远端 URL 查即命中（OneBot 引用消息那条路径的闭环）', async () => {
    const { svc, describeCount } = makeSvc();
    // 适配器先把 QQ 直链落成内容寻址路径，媒体侧按落盘 ref 识别入缓存
    const landed = 'data:/images/onebot_t_group_9/onebot/0f1e2d3c4b5a6978.jpg';
    await svc.processMessage(msgWith(landed));
    expect(describeCount()).toBe(1);

    const remote = 'https://gchat.qpic.cn/download?fileid=abc&rkey=xyz';
    expect(svc.lookupDescription(remote), '未登记别名时原始 URL 查不到').toBeNull();

    // 适配器落盘成功处调的就是这个（MediaService.rememberDescriptionAlias）
    svc.rememberDescriptionAlias(remote, landed);
    expect(svc.lookupDescription(remote), '登记后原始 URL 落到落盘 ref 的内容哈希键').toBe('猫在沙发上');
  });
});

// 描述缓存按详略档分键：analyze_image 传 detailed/professional 时曾直接命中到达时写下的简述——
// 「详细分析」拿到的是同一句话。各档各存一条（plugin-file-reader 刻意不传 hint 就是为了让 detailed 走缓存）。
describe('描述缓存按详略档分键', () => {
  it('detailed 不命中 auto 条目、自己一条可复用；auto 条目不被覆盖；显式 auto 等于默认', async () => {
    const { svc, describeCount } = makeSvc();
    const key = 'data:/images/onebot_t_group_1/onebot/detail-level.jpg';
    expect(await svc.describeImage(key)).toBe('猫在沙发上');
    await svc.describeImage(key);
    expect(describeCount(), 'auto 命中缓存').toBe(1);
    await svc.describeImage(key, { detailLevel: 'detailed' });
    expect(describeCount(), 'detailed 不得命中 auto 的简述').toBe(2);
    await svc.describeImage(key, { detailLevel: 'detailed' });
    expect(describeCount(), 'detailed 自己那条可复用').toBe(2);
    await svc.describeImage(key, { detailLevel: 'casual' });
    expect(describeCount(), '各档各一条').toBe(3);
    await svc.describeImage(key);
    expect(describeCount(), 'auto 条目仍在').toBe(3);
    await svc.describeImage(key, { detailLevel: 'auto' });
    expect(describeCount(), '显式 auto 与默认同一条目').toBe(3);
    // 内容哈希键同样分档：档位后缀加在哈希之后，跨会话共享与快照对各档一致
    expect(
      lookupCachedDescription('data:/images/onebot_t_group_1/onebot/0123456789abcdef.jpg', true, 'detailed'),
    ).toBeNull();
    rememberDescription('data:/images/onebot_t_group_1/onebot/0123456789abcdef.jpg', '详细版', true, 'detailed');
    expect(lookupCachedDescription('data:/images/onebot_t_group_2/onebot/0123456789abcdef.jpg', true, 'detailed')).toBe(
      '详细版',
    );
    expect(lookupCachedDescription('data:/images/onebot_t_group_2/onebot/0123456789abcdef.jpg')).toBeNull();
  });
});

// 识别模型在长度上限处停下的描述带着截断标记进缓存：同一张图再识别不调模型，取回的就是带标记的那一句，不重试
describe('截断的描述原样进缓存', () => {
  it('describeImage：第一次识别被截断，第二次命中缓存、不调模型，两次都带标记', async () => {
    let calls = 0;
    const vision = {
      id: 'zz-vision',
      capabilities: ['vision'],
      chat: async () => {
        calls++;
        return { content: '一只猫在', finishReason: 'length' };
      },
    } as unknown as LLMModel;
    const cfg = {
      vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 2048, think: false, prompt: '' },
      audio: { mode: 'disabled', maxTokens: 2048, think: true },
      video: { mode: 'disabled' },
      animatedImage: { maxFrames: 4 },
      contextHistory: { enabled: false, maxMessages: 0 },
    } as unknown as MediaConfigResolved;
    const svc = new MediaServiceImpl(
      { ...caps, llm: ref([{ instance: vision, contextId: 'zz-provider/zz-vision', priority: 0 }]) },
      cfg,
    );
    // data URL 原样交给识图模型，不经存储；内容是一张 PNG 的文件头
    const key = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')}`;
    expect(await svc.describeImage(key)).toBe('一只猫在（已在长度上限处截断）');
    expect(await svc.describeImage(key)).toBe('一只猫在（已在长度上限处截断）');
    expect(calls).toBe(1);
  });
});
