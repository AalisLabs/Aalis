import { afterEach, describe, expect, it } from 'vitest';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import {
  buildIncomingContent,
  forwardPlaceholder,
  type IncomingMessage,
  WellKnownMetadataKeys,
  withForwards,
} from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 入站消息的归档文本：schema-message 的 buildIncomingContent，归档与触发判定共用；说话人由调用方给（谁算说话人见
// speaker-prefix.test.ts）。下面钉住逐字输出；随消息转发来的聊天记录在 forwards，正文里留占位，归档文本把展开换回占位的位置，
// 与展开直接写在正文里逐字相同。归档用例确认归档写入的正文就是这个函数的结果，两边不会各拼一份，另核归档另记的发言人写的话、
// 附件清单与转发。
// ════════════════════════════════════════════════════════════

const SPEAKER = { nickname: '甲', userId: '30001' };

/** 转发的占位与展开（OneBot 信封的写法）、给界面的事实 */
const PLACEHOLDER = '<forward id="F1">[合并转发消息]</forward>';
const ENV =
  '<forward id="F1" count=1 participants="丙(30003)">\n1. 丙(30003): <at id="30004">30004</at>你好\n</forward>';
const FACTS = { count: 1, participants: ['丙(30003)'], text: '1. 丙(30003): <at id="30004">30004</at>你好' };

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
  it('给了说话人才加前缀，不看平台', () => {
    expect(buildIncomingContent(group(), SPEAKER)).toBe('[甲(30001)]: 看这个');
    expect(buildIncomingContent(group(), { userId: '30001' })).toBe('[30001]: 看这个');
    expect(buildIncomingContent(group())).toBe('看这个');
    expect(
      buildIncomingContent({ content: '你好', sessionId: 'webui-1', platform: 'webui' }, { userId: 'console' }),
    ).toBe('[console]: 你好');
  });

  it('引用回复拼在末尾；被引用者无标签时记为 ?', () => {
    expect(
      buildIncomingContent(
        group({ replyTo: { messageId: 'm1', content: '原话', nickname: '乙', userId: '30002' } }),
        SPEAKER,
      ),
    ).toBe('[甲(30001)]: 看这个\n[引用 乙(30002) 的消息: 原话]');
    expect(buildIncomingContent(group({ replyTo: { messageId: 'm1', content: '原话' } }), SPEAKER)).toBe(
      '[甲(30001)]: 看这个\n[引用 ? 的消息: 原话]',
    );
    // 被引用消息没有正文：不拼
    expect(buildIncomingContent(group({ replyTo: { messageId: 'm1' } }), SPEAKER)).toBe('[甲(30001)]: 看这个');
  });

  it('附件描述按下标顺序追加，跳过空白与缺项；正文为空时只剩描述', () => {
    const descs = ['[图片: 一只猫 | ref:data/a.png]', undefined, '  ', '[音频] 你好'];
    expect(buildIncomingContent(group({ _attachmentDescriptions: descs }), SPEAKER)).toBe(
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

  it('转发的展开换回占位的位置，引用与附件描述照旧接在后面：与展开直接写在正文里逐字相同', () => {
    const msg = group({
      content: `看这个${PLACEHOLDER}`,
      forwards: [{ id: 'F1', content: ENV }],
      replyTo: { messageId: 'm1', content: '原话', nickname: '乙', userId: '30002' },
      _attachmentDescriptions: ['[图片: 一只猫 | ref:data/a.png]'],
    });
    const expected = `[甲(30001)]: 看这个${ENV}\n[引用 乙(30002) 的消息: 原话]\n[图片: 一只猫 | ref:data/a.png]`;
    expect(buildIncomingContent(msg, SPEAKER)).toBe(expected);
    expect(buildIncomingContent({ ...msg, content: `看这个${ENV}`, forwards: undefined }, SPEAKER)).toBe(expected);
  });

  it('没有展开的占位原样留着', () => {
    expect(forwardPlaceholder('F1')).toBe(PLACEHOLDER);
    const content = `看${PLACEHOLDER}和${forwardPlaceholder('F3')}`;
    expect(withForwards(content, [{ id: 'F1', content: ENV }])).toBe(`看${ENV}和${forwardPlaceholder('F3')}`);
    expect(withForwards(content, undefined)).toBe(content);
  });
});

describe('归档', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  async function archiveService() {
    app = new App({ logLevel: 'error' });
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
    host.provide.use(storage, { listRoots: () => [root('data'), root('workspace')] } as unknown as StorageService);
    return host.messageArchive.use;
  }

  it('archiveIncoming 写入的正文与共享函数逐字一致', async () => {
    const msg = group({
      replyTo: { messageId: 'm1', content: '原话', nickname: '乙', userId: '30002' },
      _attachmentDescriptions: ['[图片: 一只猫 | ref:data/a.png]'],
    });
    const archived = await (await archiveService()).archiveIncoming(msg);
    if (!archived) throw new Error('没落档');
    const { content, message } = archived;
    // 会话管理不在：说话人是这条消息自己的
    expect(content).toBe(buildIncomingContent(msg, SPEAKER));
    expect(message.content).toBe('[甲(30001)]: 看这个\n[引用 乙(30002) 的消息: 原话]\n[图片: 一只猫 | ref:data/a.png]');
  });

  it('另记发言人写的话与附件清单：附件的地址取 data（网址与存储地址，相对路径不算），data 不是地址的取预处理器写在附件 ref 上的落盘地址，描述里的引用不算，都没有的只记种类与名字；存储地址只认存储服务根表里的根', async () => {
    const K = WellKnownMetadataKeys;
    const archived = await (await archiveService()).archiveIncoming(
      group({
        attachments: [
          { kind: 'image', name: 'cat.png', data: 'data:image/png;base64,AAAA', ref: 'data:/images/g/media/cat.png' },
          { kind: 'image', data: 'data/images/g/dog.jpg' },
          { kind: 'video', data: 'https://v.example.invalid/a.mp4' },
          { kind: 'file', name: '报告.txt', data: 'workspace:/up/报告.txt' },
          { kind: 'file', name: '笔记.md', data: 'data:text/markdown;base64,AAAA' },
          { kind: 'audio', data: 'file:///tmp/a.wav' },
          { kind: 'file', name: 'b.txt', data: 'aalis-file://0123abcd', ref: 'workspace:/up/b.txt' },
          { kind: 'file', name: 'c.txt', data: 'nowhere:/c.txt', ref: 'nowhere:/d.txt' },
        ],
        _attachmentDescriptions: [
          '[图片: 一只猫 | ref:data:/images/g/media/cat.png]',
          undefined,
          undefined,
          '〔报告.txt：三页〕',
          '[文件 | ref:workspace:/别的文件.md]',
          '[音频] 你好',
          undefined,
          undefined,
        ],
      }),
    );
    if (!archived) throw new Error('没落档');
    const { message } = archived;
    expect(message.metadata?.[K.SpokenContent]).toBe('看这个');
    expect(message.metadata?.[K.Attachments]).toEqual([
      { kind: 'image', name: 'cat.png', ref: 'data:/images/g/media/cat.png' },
      { kind: 'image' },
      { kind: 'video', ref: 'https://v.example.invalid/a.mp4' },
      { kind: 'file', name: '报告.txt', ref: 'workspace:/up/报告.txt' },
      { kind: 'file', name: '笔记.md' },
      { kind: 'audio' },
      { kind: 'file', name: 'b.txt', ref: 'workspace:/up/b.txt' },
      { kind: 'file', name: 'c.txt' },
    ]);
  });

  it('转发：归档正文拼回展开，发言人写的话只有占位，另记各段转发的 id 与事实（不存展开），转发里 @ 的人不算', async () => {
    const K = WellKnownMetadataKeys;
    const failed = '<forward id="F2">[合并转发消息：展开过程出错]</forward>';
    const msg = group({
      content: `看这个${PLACEHOLDER}${forwardPlaceholder('F2')}`,
      forwards: [
        { id: 'F1', content: ENV, facts: FACTS },
        { id: 'F2', content: failed },
      ],
    });
    const archived = await (await archiveService()).archiveIncoming(msg);
    if (!archived) throw new Error('没落档');
    const { message } = archived;
    expect(message.content).toBe(buildIncomingContent(msg, SPEAKER));
    expect(message.metadata?.[K.SpokenContent]).toBe(msg.content);
    expect(message.metadata?.[K.Forwards]).toEqual([{ id: 'F1', facts: FACTS }, { id: 'F2' }]);
    expect(message.metadata?.[K.Mentions]).toBeUndefined();
  });

  it('发言人写的话与归档正文相同时不记，没有附件时不记附件清单', async () => {
    const archived = await (await archiveService()).archiveIncoming({
      content: '你好',
      sessionId: 'webui-default',
      platform: 'webui',
    });
    if (!archived) throw new Error('没落档');
    const { message } = archived;
    expect(Object.keys(message.metadata ?? {})).toEqual([WellKnownMetadataKeys.Platform]);
  });
});
