import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { type SessionItem, SessionItemSchema } from '../../packages/api-session-protocol/src/index.js';
import {
  type MergeContext,
  mergeArchive,
  notAccepted,
  readHistory,
} from '../../packages/plugin-session-server/src/history.js';
import {
  type Message,
  outboundMediaMessage,
  WellKnownKinds,
  WellKnownMetadataKeys,
} from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// 历史归并在会话服务：存档归并成条目，客户端只渲染。下面把条目压成便于比较的形状：
// 她发出的附件、按登记的键写的存档、新旧两种工具调用存档格式、系统消息与平台事件。
// ════════════════════════════════════════════════════════════

type Entry =
  | { kind: 'user'; text: string; files: string[] }
  | { kind: 'notice'; text: string }
  | { kind: 'agent'; text: string; attachments: Array<{ kind: string; src?: string }>; model?: unknown }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; result?: string };

function fromItem(item: SessionItem): Entry {
  switch (item.kind) {
    case 'user-message':
      return {
        kind: 'user',
        text: item.text,
        files: item.attachments.filter(a => a.kind === 'file').map(a => a.name ?? ''),
      };
    case 'notice':
      return { kind: 'notice', text: item.text };
    case 'agent-message':
      return {
        kind: 'agent',
        text: item.text,
        attachments: item.attachments.map(a => ({ kind: a.kind, src: a.src })),
        ...(item.model ? { model: item.model } : {}),
      };
    case 'reasoning':
      return { kind: 'reasoning', text: item.text };
    case 'tool-call':
      return { kind: 'tool', name: item.name, args: item.args, result: item.result };
    default:
      throw new Error(`历史里不该有 ${item.kind}`);
  }
}

const isOwner = (platform: string, userId?: string) => platform === 'webui' && userId === 'console';
/** 这些存档里没有她发出的文件，不签发句柄；工具都没声明展示种类 */
const context = (room = false): MergeContext => ({
  isOwner,
  room,
  signFile: () => undefined,
  display: () => undefined,
});

const merged = (raw: Message[]): Entry[] => mergeArchive(raw, context(), new Map()).map(fromItem);

describe('历史归并', () => {
  it('她发出的附件还原成只有附件的消息，不打断前后的文字回复', () => {
    const entries = merged([
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
    expect(entries).toEqual([
      { kind: 'user', text: '画只猫', files: [] },
      { kind: 'agent', text: '画好了', attachments: [] },
      { kind: 'agent', text: '', attachments: [{ kind: 'image', src: 'data:/images/cat.png' }] },
      { kind: 'agent', text: '', attachments: [{ kind: 'video', src: 'paper:/n-a/tasks/t-1/out/a-2.mp4' }] },
      { kind: 'user', text: '好看', files: [] },
    ]);
  });

  it('按登记的键写的存档：提问取发言人写的话与附件清单（文件是带句柄的卡片、图片按地址），还原出说话人、通知的种类、回复的模型与 token、工具卡的归组、发出的文件与没收下的回复', async () => {
    const K = WellKnownMetadataKeys;
    const raw: Message[] = [
      {
        role: 'user',
        content: '[甲(7)]: 看看这两个\n〔报告.txt：三页的周报〕\n[图片: 一只橘猫 | ref:data/images/g/cat.png]',
        timestamp: 1,
        metadata: {
          [K.Platform]: 'onebot',
          [K.UserId]: '7',
          [K.Nickname]: '甲',
          [K.SpokenContent]: '看看这两个',
          [K.Attachments]: [
            { kind: 'file', name: '报告.txt', ref: 'workspace:/up/报告.txt' },
            { kind: 'image', name: 'cat.png', ref: 'data:/images/g/cat.png' },
            { kind: 'file', name: '笔记.md' },
          ],
        },
      },
      {
        role: 'assistant',
        content: '我先查',
        timestamp: 2,
        toolCalls: [{ id: 'm1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        metadata: { [K.TurnId]: 't1' },
      },
      {
        role: 'tool',
        content: '结果',
        toolCallId: 'm1',
        timestamp: 3,
        metadata: { [K.TurnId]: 't1', [K.CallId]: 'c1' },
      },
      {
        role: 'assistant',
        content: '查好了',
        timestamp: 4,
        metadata: {
          [K.TurnId]: 't1',
          [K.ModelInfo]: { provider: 'p', model: 'm', promptTokens: 120, completionTokens: 30 },
        },
      },
      {
        role: 'system',
        kind: WellKnownKinds.OutboundDeliveryFailed,
        content: '[投递回报]',
        timestamp: 5,
        metadata: { [K.TurnId]: 't1', [K.DeliveryError]: '风控' },
      },
      {
        // 占位符里的地址遇到「]」截断、名字里的「]」换成全角，原样的地址与名字记在元数据里
        ...outboundMediaMessage('file', 'workspace:/out/周报].md', '周报].md'),
        timestamp: 6,
        metadata: { [K.Source]: 'webui-server', [K.SentRef]: 'workspace:/out/周报].md', [K.SentName]: '周报].md' },
      },
      {
        role: 'notice',
        kind: 'host-notice',
        content: '白纸完成',
        timestamp: 7,
        metadata: { [K.Source]: 'paper:1', [K.HostNoticeKind]: 'paper-task' },
      },
    ];
    const memory = { getHistory: async () => raw } as unknown as MemoryService;
    const { items } = await readHistory(
      memory,
      'onebot:1:group:2',
      { limit: 100, skip: () => false },
      { ...context(true), signFile: (uri, name) => `句柄 ${uri} ${name}` },
      { warn: () => {} },
    );
    expect(items.map(item => [item.kind, item.turnId, item.itemId.startsWith('c1') ? 'c1' : undefined])).toEqual([
      ['user-message', undefined, undefined],
      ['agent-message', 't1', undefined],
      ['tool-call', 't1', 'c1'],
      ['agent-message', 't1', undefined],
      ['agent-message', undefined, undefined],
      ['notice', undefined, undefined],
    ]);
    expect(items[0]).toMatchObject({
      text: '看看这两个',
      attachments: [
        { kind: 'file', name: '报告.txt', src: '句柄 workspace:/up/报告.txt 报告.txt' },
        { kind: 'image', name: 'cat.png', src: 'data:/images/g/cat.png' },
        { kind: 'file', name: '笔记.md' },
      ],
      speaker: { platform: 'onebot', userId: '7', nickname: '甲', owner: false },
    });
    expect(items[2]).toMatchObject({ kind: 'tool-call', result: '结果', status: 'completed' });
    expect(items[3]).toMatchObject({
      text: '查好了',
      model: { provider: 'p', model: 'm', promptTokens: 120, completionTokens: 30 },
      undelivered: { reason: notAccepted('风控') },
    });
    expect(items[4]).toMatchObject({
      attachments: [{ kind: 'file', name: '周报].md', src: '句柄 workspace:/out/周报].md 周报].md' }],
    });
    expect(items[5]).toMatchObject({ topic: 'paper-task', text: '白纸完成' });
    for (const item of items) expect(SessionItemSchema.safeParse(item).success, item.itemId).toBe(true);
  });

  it('存档里的附件清单与发言人写的话按类型取：不是数组、种类不认识、名字与地址不是字符串的项不认，空串的发言照样是发言', () => {
    const K = WellKnownMetadataKeys;
    const items = mergeArchive(
      [
        {
          role: 'user',
          content: '[图片描述] 一只猫',
          timestamp: 1,
          metadata: {
            [K.SpokenContent]: '',
            [K.Attachments]: [
              { kind: 'image', name: 7, ref: 'data:/images/cat.png' },
              { kind: 'sticker', ref: 'data:/x' },
              'data:/y',
              null,
              { kind: 'file', ref: 9 },
            ],
          },
        },
        { role: 'user', content: '只有字', timestamp: 2, metadata: { [K.SpokenContent]: 3, [K.Attachments]: 'x' } },
      ],
      context(),
      new Map(),
    );
    expect(items.map(item => item.kind === 'user-message' && [item.text, item.attachments])).toEqual([
      ['', [{ kind: 'image', src: 'data:/images/cat.png' }, { kind: 'file' }]],
      ['只有字', []],
    ]);
    for (const item of items) expect(SessionItemSchema.safeParse(item).success).toBe(true);
  });

  it('旧格式的工具调用组：思考前置、中间的话、工具结果回填到调用上，每条回复各成一条，最后一条是回复', () => {
    const entries = merged([
      { role: 'user', content: '查一下', timestamp: 1 },
      {
        role: 'assistant',
        content: '我先查',
        reasoningContent: '想想',
        timestamp: 2,
        toolCalls: [{ id: 'a', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', content: '结果一', toolCallId: 'a', timestamp: 3 },
      {
        role: 'assistant',
        content: null,
        timestamp: 4,
        toolCalls: [{ id: 'b', type: 'function', function: { name: 'read', arguments: '坏的 JSON' } }],
      },
      { role: 'tool', content: '结果二', toolCallId: 'b', timestamp: 5 },
      { role: 'assistant', content: '再想想', reasoningContent: '还要', timestamp: 6 },
      { role: 'assistant', content: '查好了', timestamp: 7, metadata: { modelInfo: { provider: 'p', model: 'm' } } },
      { role: 'user', content: '谢谢', timestamp: 8 },
    ]);
    expect(entries).toEqual([
      { kind: 'user', text: '查一下', files: [] },
      { kind: 'reasoning', text: '想想还要' },
      { kind: 'agent', text: '我先查', attachments: [] },
      { kind: 'tool', name: 'search', args: { q: 'x' }, result: '结果一' },
      { kind: 'tool', name: 'read', args: {}, result: '结果二' },
      { kind: 'agent', text: '再想想', attachments: [] },
      { kind: 'agent', text: '查好了', attachments: [], model: { provider: 'p', model: 'm' } },
      { kind: 'user', text: '谢谢', files: [] },
    ]);
  });

  it('回复的模型与 token 按类型取：存档里是 null 或空串的（存储把 undefined 存成 null）当没有，条目照样过协议的校验', () => {
    const items = mergeArchive(
      [
        { role: 'user', content: '在吗', timestamp: 1 },
        {
          role: 'assistant',
          content: '在',
          timestamp: 2,
          metadata: { modelInfo: { provider: 'p', model: '', promptTokens: null, completionTokens: 30 } },
        },
      ],
      context(),
      new Map(),
    );
    const reply = items.find(item => item.kind === 'agent-message');
    expect(reply?.kind === 'agent-message' && reply.model).toStrictEqual({
      provider: 'p',
      model: undefined,
      promptTokens: undefined,
      completionTokens: 30,
    });
    for (const item of items) expect(SessionItemSchema.safeParse(item).success).toBe(true);
  });

  it('新格式：最后一条带时间线的回复覆盖前面按旧格式落库的工具调用组', () => {
    const entries = merged([
      { role: 'user', content: '查一下', timestamp: 1 },
      {
        role: 'assistant',
        content: null,
        timestamp: 2,
        toolCalls: [{ id: 'a', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: '结果', toolCallId: 'a', timestamp: 3 },
      {
        role: 'assistant',
        content: '好了',
        timestamp: 4,
        metadata: { modelInfo: { provider: 'p', model: 'm' } },
        segments: [
          { type: 'reasoning_text', content: '想' },
          { type: 'reasoning_text', content: '想' },
          { type: 'text', content: '我先查' },
          { type: 'tool_call', name: 'search', args: {}, result: '结果', startTime: 10, endTime: 15 },
          { type: 'text', content: '好了' },
        ],
      },
    ]);
    expect(entries).toEqual([
      { kind: 'user', text: '查一下', files: [] },
      { kind: 'reasoning', text: '想想' },
      { kind: 'agent', text: '我先查', attachments: [] },
      { kind: 'tool', name: 'search', args: {}, result: '结果' },
      { kind: 'agent', text: '好了', attachments: [], model: { provider: 'p', model: 'm' } },
    ]);
  });

  it('系统消息只留压缩分隔线，平台事件按通知显示，孤立的工具结果跳过', () => {
    const entries = merged([
      { role: 'system', content: '对话已压缩', kind: 'event-marker', timestamp: 1 },
      { role: 'system', content: '不显示', timestamp: 2 },
      { role: 'notice', kind: 'poke', content: '小明戳了戳你', timestamp: 3 },
      { role: 'tool', content: '孤立', toolCallId: 'x', timestamp: 4 },
      {
        role: 'notice',
        kind: 'host-notice',
        content: '白纸完成',
        timestamp: 5,
        metadata: { hostNoticeKind: 'paper-task' },
      },
    ]);
    expect(entries).toEqual([
      { kind: 'notice', text: '对话已压缩' },
      { kind: 'notice', text: '小明戳了戳你' },
      { kind: 'notice', text: '白纸完成' },
    ]);
  });

  it('宿主通知带通知的 id 与给界面的事实（按登记的键取）：事实里不是字符串或有限数的项不认，id 不是字符串、事实不是对象的当没有', () => {
    const K = WellKnownMetadataKeys;
    const notice = (timestamp: number, metadata: Record<string, unknown>): Message => ({
      role: 'notice',
      kind: 'host-notice',
      content: '写给模型的那句话',
      timestamp,
      metadata: { [K.HostNoticeKind]: 'zz-kind', ...metadata },
    });
    const items = mergeArchive(
      [
        notice(1, {
          [K.HostNoticeId]: 'bg_1',
          [K.HostNoticeFacts]: {
            tool: 'zz_tool',
            status: 'failed',
            exitCode: 2,
            durationMs: 1500,
            zzNull: null,
            zzNested: { a: 1 },
            zzNaN: Number.NaN,
          },
        }),
        notice(2, { [K.HostNoticeId]: 7, [K.HostNoticeFacts]: 'zz' }),
        notice(3, { [K.HostNoticeFacts]: { zzList: [1] } }),
      ],
      context(),
      new Map(),
    );
    expect(items.map(item => item.kind === 'notice' && [item.topic, item.text, item.noticeId, item.facts])).toEqual([
      ['zz-kind', '写给模型的那句话', 'bg_1', { tool: 'zz_tool', status: 'failed', exitCode: 2, durationMs: 1500 }],
      ['zz-kind', '写给模型的那句话', undefined, undefined],
      ['zz-kind', '写给模型的那句话', undefined, undefined],
    ]);
    for (const item of items) expect(SessionItemSchema.safeParse(item).success, item.itemId).toBe(true);
  });
});

describe('服务端归并的条目', () => {
  it('旧格式里并行的几次工具调用：结果按 toolCallId 对回各自的调用，不按位置填', () => {
    const raw: Message[] = [
      {
        role: 'assistant',
        content: null,
        timestamp: 1,
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'search', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: '搜索结果', toolCallId: 'a', timestamp: 2 },
      { role: 'tool', content: '读到的内容', toolCallId: 'b', timestamp: 3 },
      { role: 'tool', content: '对不上调用的结果', toolCallId: 'x', timestamp: 4 },
    ];
    const calls = mergeArchive(raw, context(), new Map()).filter(i => i.kind === 'tool-call');
    expect(calls.map(i => i.kind === 'tool-call' && [i.name, i.result, i.status])).toEqual([
      ['search', '搜索结果', 'completed'],
      ['read', '读到的内容', 'completed'],
    ]);
  });

  it('工具卡以 callId 为 id：时间线的段与工具结果的元数据带它；都没有（旧存档）时回落到按组的序号', () => {
    const raw: Message[] = [
      { role: 'user', content: '问', timestamp: 1 },
      {
        role: 'assistant',
        content: null,
        timestamp: 2,
        toolCalls: [
          { id: 'm1', type: 'function', function: { name: 'search', arguments: '{}' } },
          { id: 'm2', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: '结果', toolCallId: 'm1', timestamp: 3, metadata: { callId: 'call-1' } },
      { role: 'tool', content: '内容', toolCallId: 'm2', timestamp: 4 },
      { role: 'user', content: '再问', timestamp: 5 },
      {
        role: 'assistant',
        content: '答',
        timestamp: 6,
        segments: [
          { type: 'tool_call', name: 'search', args: {}, result: '结果', callId: 'call-2' },
          { type: 'text', content: '答' },
        ],
      },
    ];
    const calls = mergeArchive(raw, context(), new Map()).filter(i => i.kind === 'tool-call');
    expect(calls.map(i => i.itemId)).toEqual(['call-1', expect.stringMatching(/^\d+-\w+\/1$/), 'call-2']);
  });

  it('工具卡带按工具定义解析好的展示：两种存档格式都按工具名与参数解析，解析不出的不给', () => {
    const raw: Message[] = [
      {
        role: 'assistant',
        content: null,
        timestamp: 1,
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } },
          { id: 'b', type: 'function', function: { name: 'search', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'a.txt', toolCallId: 'a', timestamp: 2 },
      { role: 'tool', content: '结果', toolCallId: 'b', timestamp: 3 },
      { role: 'user', content: '再来', timestamp: 4 },
      {
        role: 'assistant',
        content: '好',
        timestamp: 5,
        segments: [
          { type: 'tool_call', name: 'exec', args: { command: 'pwd' }, result: '/', callId: 'c2' },
          { type: 'text', content: '好' },
        ],
      },
    ];
    const items = mergeArchive(
      raw,
      {
        ...context(),
        display: (tool, args) => (tool === 'exec' ? { kind: 'command', command: String(args.command) } : undefined),
      },
      new Map(),
    );
    expect(items.flatMap(i => (i.kind === 'tool-call' ? [[i.name, i.display]] : []))).toEqual([
      ['exec', { kind: 'command', command: 'ls' }],
      ['search', undefined],
      ['exec', { kind: 'command', command: 'pwd' }],
    ]);
  });

  it('工具参数不是对象（null、数组、原始值）时按空参数显示，两种存档格式都是', () => {
    const raw: Message[] = [
      {
        role: 'assistant',
        content: null,
        timestamp: 1,
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'x', arguments: 'null' } },
          { id: 'b', type: 'function', function: { name: 'x', arguments: '[1]' } },
          { id: 'c', type: 'function', function: { name: 'x', arguments: '7' } },
        ],
      },
      { role: 'user', content: '再来', timestamp: 2 },
      {
        role: 'assistant',
        content: '好',
        timestamp: 3,
        segments: [{ type: 'tool_call', name: 'x', args: null as unknown as Record<string, unknown>, result: 'ok' }],
      },
    ];
    const items = mergeArchive(raw, context(), new Map());
    expect(items.filter(i => i.kind === 'tool-call').map(i => i.kind === 'tool-call' && i.args)).toEqual([
      {},
      {},
      {},
      {},
    ]);
    for (const item of items) expect(SessionItemSchema.safeParse(item).success, item.itemId).toBe(true);
  });

  it('房间里工具调用之前她说的话没有发进群，标「未发出」；owner 自己的会话不标', () => {
    const raw: Message[] = [
      {
        role: 'assistant',
        content: '查好了',
        timestamp: 1,
        segments: [
          { type: 'text', content: '我先查' },
          { type: 'tool_call', name: 'search', args: {}, result: 'ok' },
          { type: 'text', content: '查好了' },
        ],
      },
      { role: 'user', content: '再看看', timestamp: 2 },
      {
        role: 'assistant',
        content: '我再看看',
        timestamp: 3,
        toolCalls: [{ id: 'a', type: 'function', function: { name: 'search', arguments: '{}' } }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'a', timestamp: 4 },
    ];
    const said = (room: boolean) =>
      mergeArchive(raw, context(room), new Map()).flatMap(i =>
        i.kind === 'agent-message' ? [[i.text, i.undelivered?.reason]] : [],
      );
    expect(said(true)).toEqual([
      ['我先查', expect.stringContaining('调用工具之前')],
      ['查好了', undefined],
      ['我再看看', expect.stringContaining('调用工具之前')],
    ]);
    expect(said(false).map(([, reason]) => reason)).toEqual([undefined, undefined, undefined]);
  });

  it('条目带回合 id、说话人与 notice 的种类；同一份存档每次归并出同样的 itemId', () => {
    const raw: Message[] = [
      { role: 'user', content: '问', timestamp: 1, metadata: { platform: 'webui', userId: 'console' } },
      { role: 'user', content: '群友', timestamp: 2, metadata: { platform: 'onebot', userId: '7', nickname: '阿七' } },
      {
        role: 'assistant',
        content: '答',
        timestamp: 3,
        metadata: { turnId: 'turn-9' },
        segments: [
          { type: 'tool_call', name: 'search', args: {}, result: '{"error":"x"}', startTime: 10, endTime: 15 },
          { type: 'text', content: '答' },
        ],
      },
      {
        role: 'notice',
        kind: 'host-notice',
        content: '白纸完成',
        timestamp: 4,
        metadata: { hostNoticeKind: 'paper-task' },
      },
      { role: 'assistant', kind: 'outbound-audio', content: '[音频: 一段话 | ref:data:/a.wav]', timestamp: 5 },
    ];
    const items = mergeArchive(raw, context(), new Map());
    expect(items.map(i => [i.kind, i.turnId])).toEqual([
      ['user-message', undefined],
      ['user-message', undefined],
      ['tool-call', 'turn-9'],
      ['agent-message', 'turn-9'],
      ['notice', undefined],
      ['agent-message', undefined],
    ]);
    expect(items[0]).toMatchObject({ speaker: { platform: 'webui', userId: 'console', owner: true } });
    expect(items[1]).toMatchObject({ speaker: { platform: 'onebot', userId: '7', nickname: '阿七', owner: false } });
    expect(items[2]).toMatchObject({ status: 'failed', durationMs: 5 });
    expect(items[4]).toMatchObject({ topic: 'paper-task' });
    // 语音按存档格式（音频）还原
    expect(items[5]).toMatchObject({ attachments: [{ kind: 'audio', src: 'data:/a.wav' }] });
    expect(new Set(items.map(i => i.itemId)).size).toBe(items.length);
    expect(mergeArchive(raw, context(), new Map()).map(i => i.itemId)).toEqual(items.map(i => i.itemId));
  });
});
