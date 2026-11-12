import { afterEach, describe, expect, it } from 'vitest';
import { events } from '../../packages/api-events/src/index.js';
import { media } from '../../packages/api-media/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, provide } from '../../packages/core/src/index.js';
import messageArchive from '../../packages/plugin-message-archive/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import { defineTexts, localize, resolveText, TextError } from '../../packages/schema-i18n/src/index.js';
import type { Message, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { provideEvents } from '../fixtures/hubs.js';
import { storedRoom } from '../fixtures/rooms.js';
import { deferred } from '../helpers/deferred.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 发往 WebUI 自己会话的出站消息：会话历史就是 WebUI 的收件箱，回执表示这条消息已经由 message-archive 的 recordOutbound
// 记进会话历史，不看有没有页面在线（打开着的页面由会话服务推送）；送达本身就是写进历史，不再发 outbound:delivered。
// owner 从 WebUI 驱动的 IM 房间（根会话记下了出生平台）由那个平台的适配器认领，子会话由存档认领，按会话字段判，
// 不看会话 id 的写法。
// ════════════════════════════════════════════════════════════

const t = defineTexts({
  ns: '@zz/webui-outbound-delivery',
  language: 'zh-CN',
  source: { diskFull: '磁盘满了' } as const,
});

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

interface StartOptions {
  /** 不装 message-archive */
  noArchive?: boolean;
  /** 记忆的写入：缺省记进 saved */
  save?: (sessionId: string, message: Message) => Promise<void>;
  /** 会话表：给了就登记一个只有 getSession 的会话管理 */
  sessions?: SessionInfo[];
  /** 识图：给了就登记一个媒体服务 */
  describe?: (url: string) => Promise<string>;
}

/** WebUI 与 message-archive，记忆是只记写入的替身（声明了改写：存档据此在后台识图，这里不改） */
async function startWebui(opts: StartOptions = {}) {
  const port = await freePort();
  const token = 'outbound-delivery-test-token-0000';
  const app = new App({ name: 'WebUI delivery test', logLevel: 'error' });
  provideEvents(app);
  apps.push(app);
  const host = app.bind({ provide, events });
  const saved: Array<{ sessionId: string; message: Message }> = [];
  const store: Pick<MemoryService, 'saveMessage' | 'getHistory' | 'clearSession' | 'updateMessageContent'> = {
    saveMessage:
      opts.save ??
      (async (sessionId, message) => {
        saved.push({ sessionId, message });
      }),
    getHistory: async sessionId => saved.filter(s => s.sessionId === sessionId).map(s => s.message),
    clearSession: async () => {},
    updateMessageContent: async () => 0,
  };
  host.provide.use(memory, store as MemoryService);
  if (opts.sessions) {
    const table = new Map(opts.sessions.map(s => [s.id, s]));
    host.provide.use(sessionManager, { getSession: (id: string) => table.get(id) } as never);
  }
  if (opts.describe) {
    const describe = opts.describe;
    host.provide.use(media, { describeImage: describe, describeVideo: describe } as never);
  }
  await app.pluginAll([
    {
      definition: webuiServer,
      config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: token },
    },
    ...(opts.noArchive ? [] : [{ definition: messageArchive, config: { debugLogs: false } }]),
  ]);
  await app.start();
  const delivered: OutgoingMessage[] = [];
  app.bind({ events }).events.use.on('outbound:delivered', message => {
    delivered.push(message);
  });
  const send = async (message: OutgoingMessage) => {
    await app.bind({ events }).events.use.emit('outbound:message', message);
    return message.delivery;
  };
  return { app, saved, delivered, send };
}

describe('WebUI outbound delivery confirmation', () => {
  it('fails when there is no archive to save into: the reason is a text object readers render in their language', async () => {
    const { send, delivered } = await startWebui({ noArchive: true });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      attachments: [{ kind: 'image', data: 'https://example.com/image.png' }],
      source: 'agent',
    };
    const delivery = await send(message);
    expect(message.delivery).toBeDefined();
    expect(localize(delivery, text => resolveText(text, ['en']))).toEqual({
      ok: false,
      error: 'The message archive service is absent, so this message was not saved to the WebUI session history',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delivered).toEqual([]);
  });

  it('saves the message into the history before confirming, once each, and emits no outbound:delivered', async () => {
    const { send, saved, delivered } = await startWebui();
    const sessionId = 'webui-offline';
    expect(await send({ sessionId, platform: 'webui', content: '[系统通知] 备份已完成', source: 'system' })).toEqual({
      ok: true,
    });
    expect(
      await send({
        sessionId,
        platform: 'webui',
        content: '',
        source: 'agent',
        attachments: [
          { kind: 'image', data: 'data:/images/new.png' },
          { kind: 'file', data: 'workspace:/out/a-1.html', name: '主页.html' },
        ],
      }),
    ).toEqual({ ok: true });
    // 记法由 outbound-record 守着，这里只看每样一条、都记进了这个会话
    expect(saved.map(s => s.sessionId)).toEqual([sessionId, sessionId, sessionId]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(delivered).toEqual([]);
  });

  it('her web image: the receipt settles once the record is written, without waiting for recognition', async () => {
    const description = deferred<string>();
    let recognizing = false;
    const { send, saved } = await startWebui({
      describe: () => {
        recognizing = true;
        return description.promise;
      },
    });
    const delivery = await send({
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'https://example.invalid/cat.png' }],
    });
    expect(delivery).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
    expect(recognizing).toBe(true);
    description.resolve('');
  });

  it('fails when saving into the history fails: the error is the reason, its text object kept', async () => {
    const diskFull = t('diskFull');
    const { send } = await startWebui({
      save: async () => {
        throw new TextError(diskFull);
      },
    });
    expect(
      await send({
        sessionId: 'webui-offline',
        platform: 'webui',
        content: '[系统通知] 备份已完成',
        source: 'system',
      }),
    ).toEqual({ ok: false, error: diskFull });
  });

  describe('IM rooms driven from WebUI belong to their own platform; subtasks belong to the archive', () => {
    const ROOM = 'onebot:123:private:456';
    /** WebUI 的会话：按字段认出，不看 id 的写法 */
    const MINE = 'zz:session-mine';
    const blank = { children: [], status: 'waiting', config: {}, createdAt: 0, updatedAt: 0 };
    const sessions = [
      storedRoom(ROOM),
      { id: 'session-room-task', name: 'task', ...blank, parentId: ROOM },
      { id: MINE, name: MINE, ...blank, createdFrom: 'webui' },
      { id: 'session-mine-task', name: 'task', ...blank, parentId: MINE },
    ] as unknown as SessionInfo[];
    const image = (sessionId: string, platform?: string): OutgoingMessage => ({
      sessionId,
      platform,
      content: '',
      attachments: [{ kind: 'image', data: 'https://example.com/image.png' }],
      source: 'agent',
    });

    it.each([undefined, 'webui'])('does not claim the room when entry platform is %s', async platform => {
      const { send } = await startWebui({ sessions });
      expect(await send(image(ROOM, platform))).toBeUndefined();
    });

    it('claims a WebUI session even when its id contains a colon', async () => {
      const { send } = await startWebui({ sessions });
      expect(await send(image(MINE, 'webui'))).toEqual({ ok: true });
    });

    it.each([
      'session-room-task',
      'session-mine-task',
    ])('leaves subtask %s to the archive, which records it in the subtask history', async sessionId => {
      const without = await startWebui({ sessions, noArchive: true });
      expect(await without.send(image(sessionId, 'webui'))).toBeUndefined();
      const { send, saved } = await startWebui({ sessions });
      expect(await send(image(sessionId, 'webui'))).toEqual({ ok: true });
      expect(saved.map(s => s.sessionId)).toEqual([sessionId]);
    });
  });

  it('does not claim a message that names no platform: another transport may own that session', async () => {
    const { send } = await startWebui();
    expect(await send({ sessionId: 'session-x', content: 'reply', source: 'agent' })).toBeUndefined();
  });

  it('does not overwrite a receipt already owned by another transport', async () => {
    const { send } = await startWebui();
    const receipt = Promise.resolve({ ok: false as const, error: 'original failure' });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: 'reply',
      delivery: receipt,
    };
    await send(message);
    expect(message.delivery).toBe(receipt);
    expect(await message.delivery).toEqual({ ok: false, error: 'original failure' });
  });
});
