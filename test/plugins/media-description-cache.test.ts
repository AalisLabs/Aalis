import type { Context, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import { lookupCachedDescription } from '../../packages/plugin-media/src/cache.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 描述缓存的键空间一致性——「缓存只存裸描述，包装在消费点重建」。
//
// 背景：附件落盘是内容寻址路径，归档路径（processMessage）与转发/工具路径
// （describeImage）自此共用同一缓存键。改前归档路径把带 ref 标记的格式化
// 文本写进缓存：转发命中会渲染成 [图片: [图片 | ref:...]] 双层包裹；
// 反向命中则丢 ref。契约：入库一律裸描述；归档消费时按形态重新包装。
// ════════════════════════════════════════════════════════════

const ctx = { getAllServices: () => [], getService: () => undefined } as unknown as Context;
const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

function makeSvc(): { svc: MediaServiceImpl; describeCount: () => number } {
  let n = 0;
  const cfg = {
    vision: { mode: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'disabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(ctx, logger, cfg);
  const proc: MediaProcessor = {
    name: 'fake-vision',
    capabilities: ['vision'],
    priority: 10,
    describe: async () => {
      n++;
      return { descriptions: ['猫在沙发上'] };
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
    const key = 'data:/images/onebot_t_group_1/cachetest1.jpg';
    const report = await svc.processMessage(msgWith(key));
    expect(report.items[0].description).toContain('猫在沙发上');
    expect(report.items[0].description).toContain('ref:');
    // 缓存里必须是裸描述——格式化文本入库即双层包裹回归
    expect(lookupCachedDescription(key)).toBe('猫在沙发上');
  });

  it('归档路径缓存命中：不再调模型，且描述位重新包装出 ref（命中≠丢格式）', async () => {
    const { svc, describeCount } = makeSvc();
    const key = 'data:/images/onebot_t_group_1/cachetest2.jpg';
    await svc.processMessage(msgWith(key));
    expect(describeCount()).toBe(1);
    const second = await svc.processMessage(msgWith(key));
    expect(describeCount()).toBe(1); // 命中缓存，模型零调用
    expect(second.items[0].description).toContain('猫在沙发上');
    expect(second.items[0].description).toContain('ref:');
  });

  it('跨路径命中：describeImage 拿到的是裸描述，不含归档侧的 ref 包装', async () => {
    const { svc, describeCount } = makeSvc();
    const key = 'data:/images/onebot_t_group_1/cachetest3.jpg';
    await svc.processMessage(msgWith(key)); // 归档先识别并入缓存
    const viaTool = await svc.describeImage(key);
    expect(describeCount()).toBe(1); // 共用缓存，模型零新调用
    expect(viaTool).toBe('猫在沙发上');
    expect(viaTool).not.toContain('ref:');
  });
});
