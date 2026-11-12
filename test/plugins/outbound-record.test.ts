import { afterEach, describe, expect, it, vi } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { hooks } from '../../packages/api-hooks/src/index.js';
import { media, sessionMediaUri } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, LogHub, provide } from '../../packages/core/src/index.js';
import imageSenderPlugin from '../../packages/plugin-image-sender/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { type MergeContext, mergeArchive } from '../../packages/plugin-session-server/src/history.js';
import { isTextRef, resolveText } from '../../packages/schema-i18n/src/index.js';
import type { Message, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 出站记历史一套规则：所有平台发出去的都由 message-archive 的 recordOutbound 记。IM 房间的适配器在送达之后发
// outbound:delivered，存档据此记；子会话没有窗口，没人认领的出站由存档认领、记进子会话自己的历史并算送达。
// 附件按有没有地址分：有地址的记成 Outbound*（她发的 role assistant，插件发的 role notice），没有地址的记成事件标记。
// 她发的网址图片与视频发出即记，识图描述在后台补上后改写同一条。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)]);

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

interface SetupOptions {
  /** 记忆后端：缺省用内存记忆（有 updateMessageContent） */
  memory?: MemoryService;
  /** 会话表：给了才登记会话管理 */
  sessions?: Array<Record<string, unknown>>;
  /** 识图（signal 是交给识图的中止信号）：缺省不登记媒体服务 */
  describe?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** 存储里的文件（存储地址 → 内容）：给了才登记存储与 image-sender */
  files?: Map<string, Uint8Array>;
}

/**
 * 存档、记忆、钩子与一个替身适配器：onebot 房间的出站由它认领，送达之后发 outbound:delivered（与 onebot 适配器一样）。
 * 日志的 warn 记在 warns 里
 */
async function setup(opts: SetupOptions = {}) {
  const hub = new LogHub();
  const warns: string[] = [];
  hub.onEntry(entry => {
    if (entry.level === 'warn') warns.push(entry.message);
  });
  const app = new App({ name: 'T', logLevel: 'warn', logHub: hub });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, memory, messageArchive });
  if (opts.memory) host.provide.use(memory, opts.memory);
  else await app.plugin(memoryInMemoryPlugin);
  if (opts.sessions) {
    const table = new Map(opts.sessions.map(s => [s.id as string, s as unknown as SessionInfo]));
    host.provide.use(sessionManager, {
      getSession: (id: string) => table.get(id),
      listSessions: () => [...table.values()],
    } as never);
  }
  const described: string[] = [];
  if (opts.describe) {
    const describe = opts.describe;
    host.provide.use(media, {
      describeImage: async (url: string, opts?: { signal?: AbortSignal }) => {
        described.push(url);
        return describe(url, opts?.signal);
      },
      describeVideo: async (url: string, opts?: { signal?: AbortSignal }) => {
        described.push(url);
        return describe(url, opts?.signal);
      },
    } as never);
  }
  const handlers: Record<string, (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<string>> = {};
  if (opts.files) {
    const files = opts.files;
    host.provide.use(storage, {
      listRoots: () => [{ name: 'data', kind: 'data' }],
      readFileRange: async (uri: string) => {
        const data = files.get(uri);
        if (!data) throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
        return data;
      },
    } as never);
    host.provide.use(tools, {
      register: (tool: { definition: { function: { name: string } }; handler: (typeof handlers)[string] }) => {
        handlers[tool.definition.function.name] = tool.handler;
        return () => {};
      },
      registerGroup: () => () => {},
    } as never);
  }
  host.events.use.on('outbound:message', msg => {
    if (msg.delivery || !msg.sessionId.startsWith('onebot:')) return;
    msg.delivery = Promise.resolve({ ok: true });
    const snapshot = { ...msg, delivery: undefined, attachments: msg.attachments?.map(att => ({ ...att })) };
    void host.events.use.emit('outbound:delivered', snapshot);
  });
  await app.plugin(messageArchivePlugin, { debugLogs: false });
  if (opts.files) await app.plugin(imageSenderPlugin);
  await app.plugins.idle();
  if (app.plugins.getPlugin(messageArchivePlugin.name)?.state !== 'active') throw new Error('消息归档未激活');
  const archived: Message[] = [];
  host.events.use.on('assistant:message:archived', ({ message }) => {
    archived.push(message);
  });
  const history = (sessionId: string) => host.memory.use.getHistory(sessionId, 50);
  return { app, host, warns, described, archived, history, handlers };
}

/** 存档里记录的几样：role、kind、正文与元数据 */
const recordOf = ({ role, kind, content, metadata }: Message) => ({ role, kind, content, metadata });

/** 会话服务归并存档用的上下文：存储地址的文件签发成「句柄:地址」 */
const mergeContext: MergeContext = {
  isOwner: () => false,
  room: true,
  multiParty: true,
  signFile: uri => (uri.startsWith('data:/') ? `handle:${uri}` : undefined),
  display: () => undefined,
};

describe('IM 房间的出站在送达之后记进历史', () => {
  it('插件发的图与音频各记成一条通知（role notice），Source 是出站的 source，带着的描述照记；不识图，也不算她的发言', async () => {
    const { host, history, described, archived } = await setup({ describe: async () => '一张图表' });
    const out: OutgoingMessage = {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'command',
      attachments: [
        { kind: 'image', data: 'https://example.invalid/chart.png' },
        { kind: 'audio', data: 'data:/audios/x/hello.mp3', description: '问好' },
      ],
    };
    await host.events.use.emit('outbound:message', out);
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(2));
    expect((await history(ROOM)).map(recordOf)).toEqual([
      {
        role: 'notice',
        kind: 'outbound-image',
        content: '[图片 | ref:https://example.invalid/chart.png]',
        metadata: { source: 'command', ref: 'https://example.invalid/chart.png' },
      },
      {
        role: 'notice',
        kind: 'outbound-audio',
        content: '[音频: 问好 | ref:data:/audios/x/hello.mp3]',
        metadata: { source: 'command', ref: 'data:/audios/x/hello.mp3' },
      },
    ]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(described).toEqual([]);
    expect(archived).toEqual([]);
  });

  it('她发的存储地址的文件记成 OutboundFile，带原样的地址与文件名；会话服务回看时还原成带句柄的文件', async () => {
    const { host, history } = await setup();
    const file = 'data:/files/onebot_10000_group_20001/onebot/0123456789abcdef.pdf';
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'file', data: file, name: '周报.pdf' }],
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(1));
    const stored = await history(ROOM);
    expect(stored.map(recordOf)).toEqual([
      {
        role: 'assistant',
        kind: 'outbound-file',
        content: `[文件: 周报.pdf | ref:${file}]`,
        metadata: { source: 'agent', ref: file, name: '周报.pdf' },
      },
    ]);
    expect(mergeArchive(stored, mergeContext, new Map()).map(item => item.kind === 'agent-message' && item)).toEqual([
      expect.objectContaining({ attachments: [{ kind: 'file', name: '周报.pdf', src: `handle:${file}` }] }),
    ]);
  });

  it('她发的网址图片发出即记、不等识图；描述补上后改写同一条（时间戳不变），历史里只有这一条', async () => {
    const description = deferred<string>();
    const { host, history, described } = await setup({ describe: () => description.promise });
    const url = 'https://example.invalid/cat.png';
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: url, ref: url }],
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(1));
    const [first] = await history(ROOM);
    expect(first.content).toBe(`[图片 | ref:${url}]`);
    expect(described).toEqual([url]);

    description.resolve('一只橘猫');
    await vi.waitFor(async () => expect((await history(ROOM))[0].content).toBe(`[图片: 一只橘猫 | ref:${url}]`));
    const after = await history(ROOM);
    expect(after).toHaveLength(1);
    expect(after[0].timestamp).toBe(first.timestamp);
  });

  it.each([
    ['图片', 'image', 'https://example.invalid/cat.png'],
    ['视频', 'video', 'https://example.invalid/cat.mp4'],
  ] as const)('识别%s途中存档停用：交给识别的中止信号随之断开，不记补不上描述的 warn', async (_label, kind, url) => {
    const signals: Array<AbortSignal | undefined> = [];
    const { app, host, history, warns } = await setup({
      describe: (_url, signal) =>
        new Promise<string>((_, reject) => {
          signals.push(signal);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind, data: url, ref: url }],
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(1));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await app.plugins.disable(messageArchivePlugin.name);
    expect(signals[0]?.aborted).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(warns.filter(line => line.includes('补上描述'))).toEqual([]);
  });

  it.each([
    ['图片', 'image', 'https://example.invalid/slow.png', 25_000, '图片'],
    ['视频', 'video', 'https://example.invalid/slow.mp4', 30_000, '视频'],
  ] as const)('识别%s到时限：交给识别的信号随之断开，这一条保持不带描述，记一条超时的 warn', async (_label, kind, url, ms, tag) => {
    // 时限信号换成用例手里的，到时由用例断开
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const signals: Array<AbortSignal | undefined> = [];
    // 与媒体服务一样：中止时 describeImage 抛中止原因，describeVideo 回空串
    const { host, history, warns } = await setup({
      describe: (_url, signal) =>
        new Promise<string>((resolve, reject) => {
          signals.push(signal);
          signal?.addEventListener('abort', () => (kind === 'video' ? resolve('') : reject(signal.reason)), {
            once: true,
          });
        }),
    });
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind, data: url }],
    });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(timeout).toHaveBeenCalledWith(ms);
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(signals[0]?.aborted).toBe(true);
    await vi.waitFor(() => expect(warns).toEqual([expect.stringContaining(`识图超时（${ms / 1000} 秒）`)]));
    expect((await history(ROOM)).map(m => m.content)).toEqual([`[${tag} | ref:${url}]`]);
  });

  it('记忆后端没有 updateMessageContent：她发的网址图片照记，不识图，也不记 warn', async () => {
    const saved: Message[] = [];
    const plain = {
      saveMessage: async (_sessionId: string, message: Message) => {
        saved.push(message);
      },
      getHistory: async () => saved,
      clearSession: async () => {},
    } as unknown as MemoryService;
    const { host, described, warns } = await setup({ memory: plain, describe: async () => '一只橘猫' });
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'https://example.invalid/cat.png' }],
    });
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(saved[0].content).toBe('[图片 | ref:https://example.invalid/cat.png]');
    expect(described).toEqual([]);
    expect(warns).toEqual([]);
  });

  it('没有地址的附件（data URL 的图、本机路径的文件）记成事件标记，正文不含 data URL，文字对象按读者语言显示', async () => {
    const { host, history } = await setup();
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [
        { kind: 'image', data: 'data:image/png;base64,iVBORw0KGgo=' },
        { kind: 'file', data: 'file:///tmp/zz/report.pdf', name: '报告.pdf' },
      ],
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(2));
    const stored = await history(ROOM);
    expect(stored.map(({ role, kind, content }) => ({ role, kind, content }))).toEqual([
      { role: 'system', kind: 'event-marker', content: '[图片]' },
      { role: 'system', kind: 'event-marker', content: '[文件] 报告.pdf' },
    ]);
    expect(JSON.stringify(stored)).not.toContain('base64');
    const texts = stored.map(m => m.metadata?.text);
    expect(texts.every(isTextRef)).toBe(true);
    expect(texts.map(text => (isTextRef(text) ? resolveText(text, ['en']) : text))).toEqual([
      '[Image]',
      '[File] 报告.pdf',
    ]);
  });

  it('她发的网址文件记成 OutboundFile，会话服务回看时还原成指向那个网址的文件', async () => {
    const { host, history } = await setup();
    const url = 'https://example.invalid/files/manual.pdf';
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'file', data: url, name: '手册.pdf' }],
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(1));
    const stored = await history(ROOM);
    expect(stored[0].kind).toBe('outbound-file');
    expect(mergeArchive(stored, mergeContext, new Map()).map(item => item.kind === 'agent-message' && item)).toEqual([
      expect.objectContaining({ attachments: [{ kind: 'file', name: '手册.pdf', src: url }] }),
    ]);
  });

  it('记录写失败：记一条 warn，不阻塞同一事件的其它监听', async () => {
    const failing = {
      saveMessage: async () => {
        throw new Error('磁盘满了');
      },
      getHistory: async () => [],
      clearSession: async () => {},
    } as unknown as MemoryService;
    const { host, warns } = await setup({ memory: failing });
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'data:/images/x/onebot/0123456789abcdef.png' }],
    });
    await vi.waitFor(() => expect(warns).toEqual([expect.stringContaining('磁盘满了')]));
  });

  it('同一会话的两次出站落在同一毫秒：各条时间戳各不相同（向量记忆按会话与时间戳认条目）', async () => {
    const { host, history } = await setup();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (const name of ['a', 'b']) {
      await host.events.use.emit('outbound:message', {
        sessionId: ROOM,
        platform: 'onebot',
        content: '',
        source: 'agent',
        attachments: [{ kind: 'image', data: `https://example.invalid/${name}.png` }],
      });
    }
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(2));
    const stamps = (await history(ROOM)).map(m => m.timestamp);
    expect(new Set(stamps).size).toBe(2);
  });

  it('调用之后改写消息（会话 id、附件）不影响记下的：要记的内容在调用时取走', async () => {
    const { host, history } = await setup();
    const out: OutgoingMessage = {
      sessionId: ROOM,
      platform: 'onebot',
      content: '/help 的回复',
      source: 'command',
      attachments: [{ kind: 'image', data: 'https://example.invalid/chart.png' }],
    };
    const recorded = host.messageArchive.use.recordOutbound(out);
    out.sessionId = 'onebot:10000:group:29999';
    out.attachments = [{ kind: 'image', data: 'https://example.invalid/other.png' }];
    await recorded;
    expect((await history(ROOM)).map(m => m.content)).toEqual([
      '/help 的回复',
      '[图片 | ref:https://example.invalid/chart.png]',
    ]);
    expect(await history('onebot:10000:group:29999')).toEqual([]);
  });

  it('不是她回复的文字记成事件标记，元数据记出站的来源；没有来源也没有文字对象的不带元数据；她的回复不记', async () => {
    const { host, history } = await setup();
    for (const out of [
      { content: '/help 的回复', source: 'command' as const },
      { content: '没有来源的提示' },
      { content: '她的回复', source: 'agent' as const },
    ]) {
      await host.messageArchive.use.recordOutbound({ sessionId: ROOM, platform: 'onebot', ...out });
    }
    expect((await history(ROOM)).map(recordOf)).toEqual([
      { role: 'system', kind: 'event-marker', content: '/help 的回复', metadata: { source: 'command' } },
      { role: 'system', kind: 'event-marker', content: '没有来源的提示', metadata: undefined },
    ]);
  });

  it('记录带出站的回合 id 与调用 id，出站没带的不记', async () => {
    const { host, history } = await setup();
    const image = { kind: 'image' as const, data: 'data:/images/x/onebot/0123456789abcdef.png' };
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '',
      source: 'agent',
      turnId: 'turn-1',
      callId: 'call-1',
      attachments: [image],
    });
    await host.events.use.emit('outbound:message', {
      sessionId: ROOM,
      platform: 'onebot',
      content: '/help 的回复',
      source: 'command',
      callId: 'call-2',
      attachments: [image],
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(3));
    expect((await history(ROOM)).map(m => m.metadata)).toEqual([
      { source: 'agent', turnId: 'turn-1', callId: 'call-1', ref: image.data },
      { source: 'command', callId: 'call-2' },
      { source: 'command', callId: 'call-2', ref: image.data },
    ]);
  });
});

describe('重发与回复里转出的媒体也记', () => {
  const landed = `${sessionMediaUri('image', ROOM, 'onebot')}/0123456789abcdef.png`;
  const files = () => new Map([[landed, PNG]]);

  it('send_attachment 的 history_ref 重发记一条，带这次调用的回合 id 与调用 id', async () => {
    const { host, history, handlers } = await setup({ sessions: [storedRoom(ROOM)], files: files() });
    await host.messageArchive.use.saveMessage(ROOM, {
      role: 'user',
      content: `[图片 | ref:${landed}]`,
      timestamp: Date.now(),
      metadata: { attachments: [{ kind: 'image', ref: landed }] },
    });
    const result = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', history_ref: landed },
        { sessionId: ROOM, platform: 'onebot', turnId: 'turn-1', callId: 'call-1' },
      ),
    );
    expect(result.ok).toBe(true);
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(2));
    expect(recordOf((await history(ROOM))[1])).toEqual({
      role: 'assistant',
      kind: 'outbound-image',
      content: `[图片 | ref:${landed}]`,
      metadata: { source: 'agent', turnId: 'turn-1', callId: 'call-1', ref: landed },
    });
  });

  it('她回复里存储地址的媒体标记转成的附件记一条，带这一轮的回合 id，并通知旁观者（WebUI 的实时时间线据此画出）', async () => {
    const { host, history, archived } = await setup({ sessions: [storedRoom(ROOM)], files: files() });
    const message: OutgoingMessage = {
      sessionId: ROOM,
      platform: 'onebot',
      content: `给你看<image url="${landed}"/>`,
      markup: true,
      source: 'agent',
      turnId: 'turn-2',
    };
    await host.hooks.use.run('outbound:dispatch', { message, metadata: {} }, async () => {
      await host.events.use.emit('outbound:message', message);
    });
    await vi.waitFor(async () => expect(await history(ROOM)).toHaveLength(1));
    expect(recordOf((await history(ROOM))[0])).toEqual({
      role: 'assistant',
      kind: 'outbound-image',
      content: `[图片 | ref:${landed}]`,
      metadata: { source: 'agent', turnId: 'turn-2', ref: landed },
    });
    expect(archived.map(m => m.content)).toEqual([`[图片 | ref:${landed}]`]);
  });
});

describe('子会话的出站由存档认领', () => {
  const TASK = 'session-0a1b2c3d';
  const task = { ...storedRoom(TASK), originPlatform: undefined, originChat: undefined, parentId: ROOM };

  it('IM 房间里派出的子任务用 send_attachment 发图：存档认领，记进子会话自己的历史，回执 ok', async () => {
    const { history, handlers } = await setup({ sessions: [storedRoom(ROOM), task], files: new Map() });
    const result = JSON.parse(
      await handlers.send_attachment(
        { kind: 'image', url: 'https://example.invalid/cat.png' },
        { sessionId: TASK, platform: 'onebot', callId: 'call-1' },
      ),
    );
    expect(result).toEqual({
      ok: true,
      sent: { kind: 'image', via: 'url', ref: 'https://example.invalid/cat.png' },
    });
    expect((await history(TASK)).map(m => m.content)).toEqual(['[图片 | ref:https://example.invalid/cat.png]']);
    expect(await history(ROOM)).toEqual([]);
  });

  it('会话管理不在时判不出是不是子会话，不认领；有窗口的会话没有适配器认领时照旧没人认领', async () => {
    const { host } = await setup();
    const orphan: OutgoingMessage = { sessionId: TASK, platform: 'onebot', content: 'x', source: 'agent' };
    await host.events.use.emit('outbound:message', orphan);
    expect(orphan.delivery).toBeUndefined();

    const withSessions = await setup({ sessions: [storedRoom('zz:room:1')] });
    const windowed: OutgoingMessage = { sessionId: 'zz:room:1', platform: 'zz', content: 'x', source: 'agent' };
    await withSessions.host.events.use.emit('outbound:message', windowed);
    expect(windowed.delivery).toBeUndefined();
  });
});
