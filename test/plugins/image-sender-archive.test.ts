import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 她发出、平台确认收下的图片、音频、视频由 image-sender 在 outbound:delivered 上归档，记法同 outboundMediaMessage：
// 按附件自己的 kind 记 outbound-*，生产者带的描述写进占位符，ref 用生产者声明的稳定引用。
// 描述已带上、或 ref 不是 http(s) 时不调 media，所以这里不需要 media 服务。
// ════════════════════════════════════════════════════════════

let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe('image-sender 出站附件归档', () => {
  it('音频、视频按各自的 kind 归档，带上生产者给的描述', async () => {
    app = new App({ name: 'T', logLevel: 'error' });
    const host = app.bind({ provide, events });
    const saved: Array<{ sessionId: string; message: Message }> = [];
    host.provide(messageArchive, {
      async saveMessage(sessionId: string, message: Message) {
        saved.push({ sessionId, message });
      },
    } as never);
    await app.plugins.register(imageSenderPlugin, {});
    await app.plugins.idle();
    if (app.plugins.getPlugin(imageSenderPlugin.name)?.state !== 'active') throw new Error('image-sender 未激活');

    await host.events.emit('outbound:delivered', {
      sessionId: 'onebot:group:0',
      content: '',
      source: 'agent',
      attachments: [
        { kind: 'audio', data: 'base64://AAAA', ref: 'data/audio/hello.mp3', description: '问好' },
        { kind: 'video', data: 'data:/video/clip.mp4' },
      ],
    });

    await vi.waitFor(() => expect(saved).toHaveLength(2));
    const records = saved.map(({ sessionId, message: { role, kind, content } }) => ({
      sessionId,
      role,
      kind,
      content,
    }));
    expect(records).toContainEqual({
      sessionId: 'onebot:group:0',
      role: 'assistant',
      kind: 'outbound-audio',
      content: '[音频: 问好 | ref:data/audio/hello.mp3]',
    });
    expect(records).toContainEqual({
      sessionId: 'onebot:group:0',
      role: 'assistant',
      kind: 'outbound-video',
      content: '[视频 | ref:data:/video/clip.mp4]',
    });
  });
});
