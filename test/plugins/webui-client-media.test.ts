// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { proxiedMediaUrl } from '../../packages/plugin-webui-client/src/api.js';
import { buildChatMessages } from '../../packages/plugin-webui-client/src/useSessionManager.js';

// ════════════════════════════════════════════════════════════
// 聊天里的媒体地址：存储地址（data:/…、paper:/…）换成 /api/media；网址走代理；真正的 data 网址与其他原样。
// 回看历史：她发出的附件归档成 outbound-image 等消息、正文是 `[图片: … | ref:…]` 占位符，还原成附件显示。
// ════════════════════════════════════════════════════════════

describe('WebUI 客户端的媒体地址', () => {
  it('存储地址经 /api/media 取，网址经代理，内联 data 网址与 file 网址原样', () => {
    expect(proxiedMediaUrl('data:/images/cat.png')).toBe('/api/media?uri=data%3A%2Fimages%2Fcat.png');
    expect(proxiedMediaUrl('paper:/n-pilot/tasks/t-1/out/a-1.png')).toBe(
      `/api/media?uri=${encodeURIComponent('paper:/n-pilot/tasks/t-1/out/a-1.png')}`,
    );
    expect(proxiedMediaUrl('https://example.invalid/a.png')).toBe(
      '/api/proxy/image?url=https%3A%2F%2Fexample.invalid%2Fa.png',
    );
    expect(proxiedMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(proxiedMediaUrl('file:///tmp/a.png')).toBe('file:///tmp/a.png');
    expect(proxiedMediaUrl('')).toBe('');
  });

  it('历史里她发出的图片还原成附件气泡，不显示占位符原文；不打断前后的文字回复', () => {
    const messages = buildChatMessages([
      { role: 'user', content: '画只猫', timestamp: 1 },
      { role: 'assistant', content: '画好了', timestamp: 2 },
      {
        role: 'assistant',
        kind: 'outbound-image',
        content: '[图片: 一只橘猫 | ref:data:/images/cat.png]',
        timestamp: 3,
      },
      {
        role: 'assistant',
        kind: 'outbound-video',
        content: '[视频 | ref:paper:/n-a/tasks/t-1/out/a-2.mp4]',
        timestamp: 4,
      },
      { role: 'user', content: '好看', timestamp: 5 },
    ]);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'user']);
    expect(messages[1].content).toBe('画好了');
    expect(messages[2]).toMatchObject({
      content: '',
      attachments: [{ kind: 'image', data: 'data:/images/cat.png' }],
    });
    expect(messages[3].attachments).toEqual([{ kind: 'video', data: 'paper:/n-a/tasks/t-1/out/a-2.mp4' }]);
    expect(JSON.stringify(messages)).not.toContain('ref:');
  });

  it('历史里她发出的音频还原成音频附件（归档的占位符是「音频」）', () => {
    const messages = buildChatMessages([
      { role: 'assistant', kind: 'outbound-audio', content: '[音频 | ref:data:/audio/hello.mp3]', timestamp: 1 },
    ]);
    expect(messages).toEqual([
      { role: 'assistant', content: '', attachments: [{ kind: 'audio', data: 'data:/audio/hello.mp3' }], timestamp: 1 },
    ]);
  });

  it('相对形式的 ref 按 toStorageUri 的规则还原成存储地址，经 /api/media 取；带冒号的原样', () => {
    const messages = buildChatMessages([
      { role: 'assistant', kind: 'outbound-image', content: '[图片: 猫 | ref:data/images/cat.png]', timestamp: 1 },
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:./workspace/out/b.png]', timestamp: 2 },
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:abc.png]', timestamp: 3 },
      {
        role: 'assistant',
        kind: 'outbound-image',
        content: '[图片 | ref:https://example.invalid/c.png]',
        timestamp: 4,
      },
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:data:image/png;base64,AAAA]', timestamp: 5 },
    ]);
    expect(messages.map(m => m.attachments?.[0]?.data)).toEqual([
      'data:/images/cat.png',
      'workspace:/out/b.png',
      'data:/abc.png',
      'https://example.invalid/c.png',
      'data:image/png;base64,AAAA',
    ]);
    expect(proxiedMediaUrl(messages[0].attachments?.[0]?.data)).toBe('/api/media?uri=data%3A%2Fimages%2Fcat.png');
  });
});
