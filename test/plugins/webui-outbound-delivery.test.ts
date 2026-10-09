import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MessageArchiveService, messageArchive } from '../../packages/api-message-archive/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import imageSender from '../../packages/plugin-image-sender/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import type { Message, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { storedRoom } from '../fixtures/rooms.js';
import { freePort } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 发往 WebUI 自己会话的出站消息：会话历史就是 WebUI 的收件箱，回执表示这条消息已经进了会话历史，
// 不看有没有页面在线（打开着的页面由会话服务推送）。owner 从 WebUI 驱动的 IM 房间（根会话记下了出生平台）
// 由那个平台的适配器认领，按会话字段判，不看会话 id 的写法。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * archive 给了就登记成 message-archive 服务；只用到 saveMessage。withImageSender 时同时装上 image-sender。
 * sessions 给了就登记一个只有 getSession 的会话管理，会话表里是这些记录
 */
async function startWebui(
  archive?: Pick<MessageArchiveService, 'saveMessage'>,
  withImageSender = false,
  sessions?: SessionInfo[],
) {
  const port = await freePort();
  const token = 'outbound-delivery-test-token-0000';
  const app = new App({ name: 'WebUI delivery test', logLevel: 'error' });
  apps.push(app);
  const host = app.bind({ provide });
  if (archive) host.provide(messageArchive, archive as never);
  if (sessions) {
    const table = new Map(sessions.map(s => [s.id, s]));
    host.provide(sessionManager, { getSession: (id: string) => table.get(id) } as never);
  }
  await app.pluginAll([
    {
      definition: webuiServer,
      config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: token },
    },
    ...(withImageSender ? [{ definition: imageSender, config: {} }] : []),
  ]);
  await app.start();
  return { app };
}

describe('WebUI outbound delivery confirmation', () => {
  it('fails when there is no archive to save into', async () => {
    const { app } = await startWebui();
    const delivered: OutgoingMessage[] = [];
    app.bind({ events }).events.on('outbound:delivered', message => {
      delivered.push(message);
    });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      attachments: [{ kind: 'image', data: 'https://example.com/image.png' }],
      source: 'agent',
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(message.delivery).toBeDefined();
    expect(await message.delivery).toEqual({ ok: false, error: expect.stringContaining('没有存进') });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delivered).toEqual([]);
  });

  it('saves the message into the history before confirming (the history is the inbox)', async () => {
    const saved: Array<{ sessionId: string; message: Message }> = [];
    const { app } = await startWebui({
      async saveMessage(sessionId, message) {
        saved.push({ sessionId, message });
      },
    });
    const host = app.bind({ events });
    const delivered: OutgoingMessage[] = [];
    host.events.on('outbound:delivered', message => {
      delivered.push(message);
    });
    const sessionId = 'webui-offline';
    const send = async (message: OutgoingMessage) => {
      await host.events.emit('outbound:message', message);
      return message.delivery;
    };

    // 宿主通知不是她说的：记成事件标记
    expect(await send({ sessionId, platform: 'webui', content: '[作品通知] 《猫》已上线', source: 'system' })).toEqual({
      ok: true,
    });
    // 她的文字回复由 agent 存档，这里不再记
    expect(await send({ sessionId, platform: 'webui', content: '画好了', source: 'agent' })).toEqual({ ok: true });
    // 她发的图片与文件由这里记；history_ref 重发（skipArchive）的原图已在历史里，不再记
    expect(
      await send({
        sessionId,
        platform: 'webui',
        content: '',
        source: 'agent',
        attachments: [
          { kind: 'image', data: 'data:/images/new.png', ref: 'data/images/new.png' },
          { kind: 'image', data: 'data:/images/cat.png', ref: 'cat', skipArchive: true },
          { kind: 'file', data: 'paper:/n-a/tasks/t-1/out/a-1.html', name: '主页.html' },
          // 不是存储地址的文件签不出下载句柄：只记名字，内容不进历史
          { kind: 'file', data: 'data:application/pdf;base64,QUJD', name: '报告.pdf' },
        ],
      }),
    ).toEqual({ ok: true });

    expect(saved.every(s => s.sessionId === sessionId)).toBe(true);
    expect(saved.map(({ message: { role, kind, content } }) => ({ role, kind, content }))).toEqual([
      { role: 'system', kind: 'event-marker', content: '[作品通知] 《猫》已上线' },
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:data:/images/new.png]' },
      {
        role: 'assistant',
        kind: 'outbound-file',
        content: '[文件: 主页.html | ref:paper:/n-a/tasks/t-1/out/a-1.html]',
      },
      { role: 'system', kind: 'event-marker', content: '[文件] 报告.pdf' },
    ]);
    // 已经记过：快照里的附件都标上 skipArchive，image-sender 不再记一份
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].attachments?.map(({ data, skipArchive }) => ({ data, skipArchive }))).toEqual([
      { data: 'data:/images/new.png', skipArchive: true },
      { data: 'data:/images/cat.png', skipArchive: true },
      { data: 'paper:/n-a/tasks/t-1/out/a-1.html', skipArchive: true },
      { data: 'data:application/pdf;base64,QUJD', skipArchive: true },
    ]);
  });

  it('saves the image she sends without image-sender installed: the history has it and the receipt is ok', async () => {
    const saved: Message[] = [];
    const { app } = await startWebui({
      async saveMessage(_sessionId, message) {
        saved.push(message);
      },
    });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'paper:/n-a/tasks/t-1/out/a-1.png', name: '猫.png' }],
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
    expect(saved.map(({ role, kind, content }) => ({ role, kind, content }))).toEqual([
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:paper:/n-a/tasks/t-1/out/a-1.png]' },
    ]);
  });

  it('records the image she sends only once when image-sender is installed too', async () => {
    const saved: Array<{ sessionId: string; message: Message }> = [];
    const { app } = await startWebui(
      {
        async saveMessage(sessionId, message) {
          saved.push({ sessionId, message });
        },
      },
      true,
    );
    const host = app.bind({ events });
    const delivered: OutgoingMessage[] = [];
    host.events.on('outbound:delivered', message => {
      delivered.push(message);
    });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      source: 'agent',
      attachments: [{ kind: 'image', data: 'data:/images/new.png', ref: 'data/images/new.png', description: '猫' }],
    };
    await host.events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    // 只给快照标 skipArchive，生产者手里的消息不动
    expect(message.attachments?.[0].skipArchive).toBeUndefined();
    // image-sender 的归档在后台：等一拍再数
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(saved.map(({ message: { kind, content } }) => ({ kind, content }))).toEqual([
      { kind: 'outbound-image', content: '[图片: 猫 | ref:data:/images/new.png]' },
    ]);
  });

  it('fails when saving into the history fails', async () => {
    const { app } = await startWebui({
      async saveMessage() {
        throw new Error('zz-disk-full');
      },
    });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '[作品通知] 《猫》已上线',
      source: 'system',
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: false, error: 'zz-disk-full' });
  });

  it('archives media that does not come from her in the image-sender format (image-sender only archives agent media)', async () => {
    const saved: Message[] = [];
    const { app } = await startWebui({
      async saveMessage(_sessionId, message) {
        saved.push(message);
      },
    });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      source: 'command',
      attachments: [{ kind: 'image', data: 'data:/images/chart.png' }],
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
    expect(saved.map(({ role, kind, content }) => ({ role, kind, content }))).toEqual([
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:data:/images/chart.png]' },
    ]);
  });

  it('archives audio and video by their own kind and keeps the description (same format as image-sender)', async () => {
    const saved: Message[] = [];
    const { app } = await startWebui({
      async saveMessage(_sessionId, message) {
        saved.push(message);
      },
    });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: '',
      source: 'command',
      attachments: [
        { kind: 'audio', data: 'data:/audio/hello.mp3', description: '问好' },
        { kind: 'video', data: 'data:/video/clip.mp4' },
      ],
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
    expect(saved.map(({ role, kind, content }) => ({ role, kind, content }))).toEqual([
      { role: 'assistant', kind: 'outbound-audio', content: '[音频: 问好 | ref:data:/audio/hello.mp3]' },
      { role: 'assistant', kind: 'outbound-video', content: '[视频 | ref:data:/video/clip.mp4]' },
    ]);
  });

  describe('IM rooms driven from WebUI belong to their own platform', () => {
    const ROOM = 'onebot:123:private:456';
    const TASK = `${ROOM}::abcd1234`;
    /** WebUI 的会话：按字段认出，不看 id 的写法 */
    const MINE = 'zz:session-mine';
    const sessions = [
      storedRoom(ROOM),
      { id: TASK, name: TASK, children: [], status: 'waiting', config: {}, createdAt: 0, updatedAt: 0, parentId: ROOM },
      {
        id: MINE,
        name: MINE,
        children: [],
        status: 'waiting',
        config: {},
        createdAt: 0,
        updatedAt: 0,
        createdFrom: 'webui',
      },
    ] as unknown as SessionInfo[];
    const send = async (app: App, sessionId: string, platform?: string) => {
      const message: OutgoingMessage = {
        sessionId,
        platform,
        content: '',
        attachments: [{ kind: 'image', data: 'https://example.com/image.png' }],
        source: 'agent',
      };
      await app.bind({ events }).events.emit('outbound:message', message);
      return message.delivery;
    };

    it.each([
      undefined,
      'webui',
    ])('does not claim the room or its subtasks when entry platform is %s', async platform => {
      const { app } = await startWebui({ async saveMessage() {} }, false, sessions);
      expect(await send(app, ROOM, platform)).toBeUndefined();
      expect(await send(app, TASK, platform)).toBeUndefined();
    });

    it('claims a WebUI session even when its id contains a colon', async () => {
      const { app } = await startWebui({ async saveMessage() {} }, false, sessions);
      expect(await send(app, MINE, 'webui')).toEqual({ ok: true });
    });
  });

  it('does not claim a message that names no platform: another transport may own that session', async () => {
    const { app } = await startWebui({ async saveMessage() {} });
    const message: OutgoingMessage = { sessionId: 'session-x', content: 'reply', source: 'agent' };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(message.delivery).toBeUndefined();
  });

  it('does not overwrite a receipt already owned by another transport', async () => {
    const { app } = await startWebui();
    const receipt = Promise.resolve({ ok: false as const, error: 'original failure' });
    const message: OutgoingMessage = {
      sessionId: 'webui-offline',
      platform: 'webui',
      content: 'reply',
      delivery: receipt,
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(message.delivery).toBe(receipt);
    expect(await message.delivery).toEqual({ ok: false, error: 'original failure' });
  });
});
