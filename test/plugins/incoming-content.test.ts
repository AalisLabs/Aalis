import { afterEach, describe, expect, it } from 'vitest';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import {
  buildIncomingContent,
  type IncomingMessage,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 入站消息的归档文本：自 plugin-message-archive 原样移到 schema-message，归档与触发判定共用。
// 下面钉住逐字输出；归档用例确认归档写入的正文就是这个函数的结果，两边不会各拼一份，另核归档另记的发言人写的话与
// 附件清单。
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

describe('归档', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  async function archiveService() {
    app = new App({ name: 'T', logLevel: 'error' });
    await registerHubs(app);
    await app.plugins.register(memoryInMemory, {});
    await app.plugins.register(messageArchivePlugin, { debugLogs: false });
    await app.plugins.idle();
    const host = app.bind({ provide, messageArchive });
    // 归档只问存储服务有哪些根
    const root = (name: 'data' | 'workspace') => ({
      name,
      kind: name,
      browsable: true,
      readable: true,
      writable: true,
      deletable: true,
    });
    host.provide(storage, { listRoots: () => [root('data'), root('workspace')] } as unknown as StorageService);
    return host.messageArchive.require();
  }

  it('archiveIncoming 写入的正文与共享函数逐字一致', async () => {
    const msg = group({
      replyTo: { messageId: 'm1', content: '原话', nickname: '乙', userId: '30002' },
      _attachmentDescriptions: ['[图片: 一只猫 | ref:data/a.png]'],
    });
    const { content, message } = await (await archiveService()).archiveIncoming(msg);
    expect(content).toBe(buildIncomingContent(msg));
    expect(message.content).toBe('[甲(30001)]: 看这个\n[引用 乙(30002) 的消息: 原话]\n[图片: 一只猫 | ref:data/a.png]');
  });

  it('另记发言人写的话与附件清单：附件的地址取 data（相对的存储路径归一成存储地址），data 是内联数据的取预处理器给它写的描述里同种附件的引用，都没有的只记种类与名字；存储地址只认存储服务根表里的根', async () => {
    const K = WellKnownMetadataKeys;
    const { message } = await (await archiveService()).archiveIncoming(
      group({
        attachments: [
          { kind: 'image', name: 'cat.png', data: 'data:image/png;base64,AAAA' },
          { kind: 'image', data: 'data/images/g/dog.jpg' },
          { kind: 'video', data: 'https://v.example.invalid/a.mp4' },
          { kind: 'file', name: '报告.txt', data: 'workspace:/up/报告.txt' },
          { kind: 'file', name: '笔记.md', data: 'data:text/markdown;base64,AAAA' },
          { kind: 'audio', data: 'file:///tmp/a.wav' },
          { kind: 'file', name: 'b.txt', data: 'aalis-file://0123abcd' },
          { kind: 'file', name: 'c.txt', data: 'nowhere:/c.txt' },
        ],
        _attachmentDescriptions: [
          '[图片: 一只猫 | ref:data/images/g/cat.png]',
          undefined,
          undefined,
          '〔报告.txt：三页〕',
          '[文件 | ref:workspace:/别的文件.md]',
          '[音频] 你好',
          undefined,
          '[文件 | ref:nowhere:/d.txt]',
        ],
      }),
    );
    expect(message.metadata?.[K.SpokenContent]).toBe('看这个');
    expect(message.metadata?.[K.Attachments]).toEqual([
      { kind: 'image', name: 'cat.png', ref: 'data:/images/g/cat.png' },
      { kind: 'image', ref: 'data:/images/g/dog.jpg' },
      { kind: 'video', ref: 'https://v.example.invalid/a.mp4' },
      { kind: 'file', name: '报告.txt', ref: 'workspace:/up/报告.txt' },
      { kind: 'file', name: '笔记.md', ref: 'workspace:/别的文件.md' },
      { kind: 'audio' },
      { kind: 'file', name: 'b.txt' },
      { kind: 'file', name: 'c.txt' },
    ]);
  });

  it('发言人写的话与归档正文相同时不记，没有附件时不记附件清单', async () => {
    const { message } = await (await archiveService()).archiveIncoming({
      content: '你好',
      sessionId: 'webui-default',
      platform: 'webui',
      userId: 'console',
    });
    expect(Object.keys(message.metadata ?? {}).sort()).toEqual([
      WellKnownMetadataKeys.Platform,
      WellKnownMetadataKeys.UserId,
    ]);
  });
});
