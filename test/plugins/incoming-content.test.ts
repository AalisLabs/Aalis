import { afterEach, describe, expect, it } from 'vitest';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { App } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { buildIncomingContent, type IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 入站消息的归档文本：自 plugin-message-archive 原样移到 schema-message，归档与触发判定共用。
// 下面钉住逐字输出；归档用例确认归档写入的正文就是这个函数的结果，两边不会各拼一份。
// ════════════════════════════════════════════════════════════

const group = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  content: '看这个',
  sessionId: 'onebot:10000:group:20001',
  platform: 'onebot',
  sessionType: 'group',
  groupId: '20001',
  userId: '30001',
  nickname: '甲',
  ...over,
});

describe('buildIncomingContent', () => {
  it('多用户平台加发送者前缀；单用户平台（webui / cli）不加', () => {
    expect(buildIncomingContent(group())).toBe('[甲(30001)]: 看这个');
    expect(buildIncomingContent(group({ nickname: undefined }))).toBe('[30001]: 看这个');
    expect(buildIncomingContent({ content: '你好', sessionId: 'webui-default', platform: 'webui', userId: 'u' })).toBe(
      '你好',
    );
    expect(buildIncomingContent({ content: '你好', sessionId: 'cli-default', platform: 'cli', userId: 'u' })).toBe(
      '你好',
    );
  });

  it('引用回复拼在末尾；被引用者无标签时记为 ?', () => {
    expect(
      buildIncomingContent(group({ replyTo: { messageId: 'm1', content: '原话', nickname: '乙', userId: '30002' } })),
    ).toBe('[甲(30001)]: 看这个\n[引用 乙(30002) 的消息: 原话]');
    expect(buildIncomingContent(group({ replyTo: { messageId: 'm1', content: '原话' } }))).toBe(
      '[甲(30001)]: 看这个\n[引用 ? 的消息: 原话]',
    );
    // 被引用消息没有正文：不拼
    expect(buildIncomingContent(group({ replyTo: { messageId: 'm1' } }))).toBe('[甲(30001)]: 看这个');
  });

  it('附件描述按下标顺序追加，跳过空白与缺项；正文为空时只剩描述', () => {
    const descs = ['[图片: 一只猫 | ref:data/a.png]', undefined, '  ', '[音频] 你好'];
    expect(buildIncomingContent(group({ _attachmentDescriptions: descs }))).toBe(
      '[甲(30001)]: 看这个\n[图片: 一只猫 | ref:data/a.png]\n[音频] 你好',
    );
    expect(
      buildIncomingContent({
        content: '',
        sessionId: 'webui-default',
        platform: 'webui',
        _attachmentDescriptions: ['[图片: 一只猫]'],
      }),
    ).toBe('[图片: 一只猫]');
  });
});

describe('归档正文即 buildIncomingContent 的结果', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it('archiveIncoming 写入的正文与共享函数逐字一致', async () => {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.register(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    const msg = group({
      replyTo: { messageId: 'm1', content: '原话', nickname: '乙', userId: '30002' },
      _attachmentDescriptions: ['[图片: 一只猫 | ref:data/a.png]'],
    });
    const { content, message } = await app.bind({ messageArchive }).messageArchive.require().archiveIncoming(msg);
    expect(content).toBe(buildIncomingContent(msg));
    expect(message.content).toBe('[甲(30001)]: 看这个\n[引用 乙(30002) 的消息: 原话]\n[图片: 一只猫 | ref:data/a.png]');
  });
});
