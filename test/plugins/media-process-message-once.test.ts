import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import type { MediaProcessor } from '../../packages/api-media/src/index.js';
import { type MediaConfigResolved, MediaServiceImpl } from '../../packages/plugin-media/src/service.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { emptyMediaCaps } from '../fixtures/service-ref.js';

// ════════════════════════════════════════════════════════════
// processMessage 按消息对象只处理一次
//
// 触发判定（判定模型要看附件描述）可能先于 agent 预处理器启动识别，预处理器再调时
// 必须拿到同一次处理，否则同一条消息识别两遍——语音与视频没有描述缓存，延迟与算力翻倍。
// 判据按消息对象，而不是「已有 _attachmentDescriptions 就跳过」：预处理器的先后取决于
// 登记次序，file-reader 先跑时会先写好文件描述，按「有描述」跳过会漏掉图片识别；
// 同理写回时不能整表覆盖，否则冲掉 file-reader 写好的文件描述。
// ════════════════════════════════════════════════════════════

const logger = { info: () => {}, debug: () => {}, warn: () => {} } as unknown as Logger;

function makeSvc() {
  const calls = { vision: 0, audio: 0 };
  const cfg = {
    vision: { recognizeOnArrival: true, delivery: 'describe', maxTokens: 300, think: false, prompt: '' },
    audio: { mode: 'enabled' },
    video: { mode: 'disabled' },
    animatedImage: { maxFrames: 4 },
    contextHistory: { enabled: false, maxMessages: 0 },
    senderContext: { enabled: false, profileMaxChars: 0 },
  } as unknown as MediaConfigResolved;
  const svc = new MediaServiceImpl(emptyMediaCaps(logger), cfg);
  svc.registerProcessor({
    name: 'fake-vision',
    capabilities: ['vision'],
    describe: async () => {
      calls.vision++;
      return { descriptions: ['一只橘猫'] };
    },
  } as MediaProcessor);
  svc.registerProcessor({
    name: 'fake-audio',
    capabilities: ['audio'],
    transcribe: async () => {
      calls.audio++;
      return { text: '你好' };
    },
  } as MediaProcessor);
  return { svc, calls };
}

const message = (attachments: IncomingMessage['attachments'], descs?: IncomingMessage['_attachmentDescriptions']) =>
  ({
    content: '',
    sessionId: 'onebot:10000:group:20001',
    platform: 'onebot',
    attachments,
    _attachmentDescriptions: descs,
  }) as IncomingMessage;

describe('processMessage 按消息对象只处理一次', () => {
  it('同一消息并发与先后调用共享一次处理：图片与语音各只识别一次，返回同一份报告', async () => {
    const { svc, calls } = makeSvc();
    const msg = message([
      { kind: 'image', data: 'https://example.invalid/pic/once-1.jpg' },
      { kind: 'audio', data: 'https://example.invalid/voice/once-1.amr' },
    ]);

    const [first, concurrent] = await Promise.all([svc.processMessage(msg), svc.processMessage(msg)]);
    const later = await svc.processMessage(msg);
    expect(calls).toEqual({ vision: 1, audio: 1 });
    expect(concurrent).toBe(first);
    expect(later).toBe(first);
    expect(msg._attachmentDescriptions?.[0]).toContain('一只橘猫');
    expect(msg._attachmentDescriptions?.[1]).toBe('[音频] 你好');
  });

  it('file-reader 先写好文件描述：图片照常识别，文件描述不被冲掉', async () => {
    const { svc, calls } = makeSvc();
    const fileDesc = '[文件: a.txt (ID: f1)]';
    const msg = message(
      [
        { kind: 'file', name: 'a.txt', data: 'aalis-file://f1' },
        { kind: 'image', data: 'https://example.invalid/pic/once-2.jpg' },
      ],
      [fileDesc, undefined],
    );

    await svc.processMessage(msg);
    expect(calls.vision).toBe(1);
    expect(msg._attachmentDescriptions?.[0]).toBe(fileDesc);
    expect(msg._attachmentDescriptions?.[1]).toContain('一只橘猫');
  });
});
