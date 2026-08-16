import type { Context, Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { DescribeInput, MediaProcessor } from '../../packages/api-media/src/index.js';
import {
  DEFAULT_VISION_AUTO_PROMPT,
  DEFAULT_VISION_DETAILED_PROMPT,
  DEFAULT_VISION_PROFESSIONAL_PROMPT,
  DEFAULT_VISION_PROMPT,
} from '../../packages/plugin-media/src/llm-adapter.js';
import type { MediaConfigResolved } from '../../packages/plugin-media/src/service.js';
import { MediaServiceImpl } from '../../packages/plugin-media/src/service.js';

// ════════════════════════════════════════════════════════════
// 视觉档位单次自路由——「取消前置分类推理」的结构定格。
//
// 背景：旧 auto 路径对每张图先跑一次 32-token 的分类推理挑 prompt 模板，
// 视觉推理的大头是图像编码，分类那次的成本≈一次完整推理——每张图算力翻倍，
// 在产能贴线的本机部署上是最大单项浪费（26h 日志中 9110 次真实推理约半数是分类）。
// 契约：auto = 一次推理（自路由 prompt，模型看图自判详略）；
// 显式 casual/detailed/professional 直接选模板；cfg.vision.prompt 覆盖 auto 与 casual。
// 谁想把分类调用加回来，先让「恰好一次 describe」的锚变红。
// ════════════════════════════════════════════════════════════

const ctx = { getAllServices: () => [] } as unknown as Context;
const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

function makeSvc(visionPromptOverride = ''): { svc: MediaServiceImpl; calls: DescribeInput[] } {
  const calls: DescribeInput[] = [];
  const cfg = {
    vision: { maxTokens: 300, think: false, prompt: visionPromptOverride },
    audio: { maxTokens: 1024, think: true },
    video: { maxTokens: 300, think: false },
    animatedImage: { maxFrames: 4 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(ctx, logger, cfg);
  const proc: MediaProcessor = {
    name: 'fake-vision',
    capabilities: ['vision'],
    priority: 10,
    describe: async req => {
      calls.push(req);
      return { descriptions: ['一张图'] };
    },
  };
  svc.registerProcessor(proc);
  return { svc, calls };
}

describe('describeImage 档位路由（分类推理已取消）', () => {
  it('auto：恰好一次 describe，用自路由 prompt——分类调用回归即红', async () => {
    const { svc, calls } = makeSvc();
    await svc.describeImage('http://x/auto-1.jpg', { noCache: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].basePrompt).toBe(DEFAULT_VISION_AUTO_PROMPT);
    // 旧分类调用的特征是 maxTokens=32——任何请求都不允许再带这个形状
    expect(calls.every(c => c.maxTokens !== 32)).toBe(true);
  });

  it('显式档位直接选模板：casual / detailed / professional', async () => {
    const { svc, calls } = makeSvc();
    await svc.describeImage('http://x/c.jpg', { noCache: true, detailLevel: 'casual' });
    await svc.describeImage('http://x/d.jpg', { noCache: true, detailLevel: 'detailed' });
    await svc.describeImage('http://x/p.jpg', { noCache: true, detailLevel: 'professional' });
    expect(calls.map(c => c.basePrompt)).toEqual([
      DEFAULT_VISION_PROMPT,
      DEFAULT_VISION_DETAILED_PROMPT,
      DEFAULT_VISION_PROFESSIONAL_PROMPT,
    ]);
    expect(calls).toHaveLength(3);
  });

  it('cfg.vision.prompt 覆盖 auto 与 casual，不覆盖 detailed/professional', async () => {
    const { svc, calls } = makeSvc('用户自定义视觉提示词');
    await svc.describeImage('http://x/o1.jpg', { noCache: true });
    await svc.describeImage('http://x/o2.jpg', { noCache: true, detailLevel: 'casual' });
    await svc.describeImage('http://x/o3.jpg', { noCache: true, detailLevel: 'detailed' });
    expect(calls.map(c => c.basePrompt)).toEqual([
      '用户自定义视觉提示词',
      '用户自定义视觉提示词',
      DEFAULT_VISION_DETAILED_PROMPT,
    ]);
  });
});
