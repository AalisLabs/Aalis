import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MessageArchiveService, messageArchive } from '../../packages/api-message-archive/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import imageSender from '../../packages/plugin-image-sender/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import type { Message, OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { freePort } from '../helpers/net.js';

type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const apps: App[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.stop();
});

/** archive 给了就登记成 message-archive 服务；只用到 saveMessage。withImageSender 时同时装上 image-sender */
async function startWebui(archive?: Pick<MessageArchiveService, 'saveMessage'>, withImageSender = false) {
  const port = await freePort();
  const token = 'outbound-delivery-test-token';
  const app = new App({ name: 'WebUI delivery test', logLevel: 'error' });
  apps.push(app);
  if (archive) app.bind({ provide }).provide(messageArchive, archive as never);
  await app.pluginAll([
    {
      definition: webuiServer,
      config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: token },
    },
    ...(withImageSender ? [{ definition: imageSender, config: {} }] : []),
  ]);
  await app.start();
  return { app, port, token };
}

async function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/ws`, {
    headers: { cookie: `aalis_webui_token=${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebUI WebSocket failed to open'));
  });
  sockets.push(ws);
  return ws;
}

describe('WebUI outbound delivery confirmation', () => {
  it('fails when there is no open page and no archive to save into', async () => {
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
    expect(await message.delivery).toEqual({ ok: false, error: expect.stringContaining('没有保存') });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(delivered).toEqual([]);
  });

  it('saves the message into the history before confirming, with no open page (the history is the inbox)', async () => {
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
        ],
      }),
    ).toEqual({ ok: true });

    expect(saved.every(s => s.sessionId === sessionId)).toBe(true);
    expect(saved.map(({ message: { role, kind, content } }) => ({ role, kind, content }))).toEqual([
      { role: 'system', kind: 'event-marker', content: '[作品通知] 《猫》已上线' },
      { role: 'assistant', kind: 'outbound-image', content: '[图片 | ref:data:/images/new.png]' },
      { role: 'system', kind: 'event-marker', content: '[文件] 主页.html' },
    ]);
    // 已经记过：快照里的附件都标上 skipArchive，image-sender 不再记一份
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0].attachments?.map(({ data, skipArchive }) => ({ data, skipArchive }))).toEqual([
      { data: 'data:/images/new.png', skipArchive: true },
      { data: 'data:/images/cat.png', skipArchive: true },
      { data: 'paper:/n-a/tasks/t-1/out/a-1.html', skipArchive: true },
    ]);
  });

  it('saves the image she sends without image-sender installed: no open page, the history has it and the receipt is ok', async () => {
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
    // image-sender 的归档在后台：等一拍再数
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(saved.map(({ message: { kind, content } }) => ({ kind, content }))).toEqual([
      { kind: 'outbound-image', content: '[图片: 猫 | ref:data:/images/new.png]' },
    ]);
  });

  it('fails when saving into the history fails and no page is open', async () => {
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

  it('still confirms when an open page got the frame but saving into the history failed', async () => {
    const { app, port, token } = await startWebui({
      async saveMessage() {
        throw new Error('zz-disk-full');
      },
    });
    const ws = await connect(port, token);
    const sessionId = 'webui-archive-down';
    const inbound = new Promise<void>(resolve => {
      app.bind({ events }).events.on('inbound:message', message => {
        if (message.sessionId === sessionId) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'message', sessionId, content: 'hello' }));
    await inbound;
    const received = new Promise<unknown>(resolve => {
      ws.onmessage = event => resolve(JSON.parse(String(event.data)));
    });
    const message: OutgoingMessage = { sessionId, platform: 'webui', content: '[作品通知] 已上线', source: 'system' };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
    expect(await received).toMatchObject({ type: 'message', sessionId, content: '[作品通知] 已上线' });
  });

  it('does not wait for an open page to write the frame out', async () => {
    const { app, port, token } = await startWebui();
    const ws = await connect(port, token);
    const sessionId = 'webui-stalled-page';
    const inbound = new Promise<void>(resolve => {
      app.bind({ events }).events.on('inbound:message', message => {
        if (message.sessionId === sessionId) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'message', sessionId, content: 'hello' }));
    await inbound;

    // 服务端用的 ws 包：页面卡住时写出回调迟迟不来
    const { WebSocket: ServerSocket } = createRequire(
      new URL('../../packages/plugin-webui-server/package.json', import.meta.url),
    )('ws') as { WebSocket: { prototype: { send: (...args: unknown[]) => void } } };
    const stalled = vi.spyOn(ServerSocket.prototype, 'send').mockImplementation(() => {});
    try {
      const message: OutgoingMessage = { sessionId, platform: 'webui', content: 'reply', source: 'agent' };
      await app.bind({ events }).events.emit('outbound:message', message);
      const settled = await Promise.race([
        message.delivery,
        new Promise(resolve => setTimeout(() => resolve('still waiting'), 1000)),
      ]);
      expect(stalled).toHaveBeenCalled();
      expect(settled).toEqual({ ok: true });
    } finally {
      stalled.mockRestore();
    }
  });

  it('confirms an open WebUI socket and emits the successfully sent attachment snapshot', async () => {
    const { app, port, token } = await startWebui();
    const ws = await connect(port, token);
    const sessionId = 'webui-image-room';
    const inbound = new Promise<void>(resolve => {
      app.bind({ events }).events.on('inbound:message', message => {
        if (message.sessionId === sessionId) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'message', sessionId, content: 'hello' }));
    await inbound;

    const delivered: OutgoingMessage[] = [];
    app.bind({ events }).events.on('outbound:delivered', message => {
      delivered.push(message);
    });
    const received = new Promise<unknown>(resolve => {
      ws.onmessage = event => resolve(JSON.parse(String(event.data)));
    });
    const message: OutgoingMessage = {
      sessionId,
      platform: 'webui',
      content: '',
      attachments: [{ kind: 'image', data: 'https://example.com/image.png', ref: 'image-ref' }],
      source: 'agent',
    };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(message.delivery).toBeDefined();
    expect(await message.delivery).toEqual({ ok: true });
    expect(await received).toMatchObject({
      type: 'message',
      sessionId,
      attachments: [{ kind: 'image', data: 'https://example.com/image.png' }],
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].attachments).toEqual(message.attachments?.map(att => ({ ...att, skipArchive: true })));
    expect(message.attachments?.[0].skipArchive).toBeUndefined();
  });

  it.each([undefined, 'webui'])('does not claim OneBot traffic when entry platform is %s', async platform => {
    const { app, port, token } = await startWebui();
    const ws = await connect(port, token);
    const sessionId = 'onebot:123:private:456';
    const inbound = new Promise<void>(resolve => {
      app.bind({ events }).events.on('inbound:message', message => {
        if (message.sessionId === sessionId) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'message', sessionId, content: 'hello' }));
    await inbound;

    const message: OutgoingMessage = {
      sessionId,
      platform,
      content: '',
      attachments: [{ kind: 'image', data: 'https://example.com/image.png' }],
      source: 'agent',
    };
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

  it('claims legacy WebUI traffic without a platform when the room has an open subscriber', async () => {
    const { app, port, token } = await startWebui();
    const ws = await connect(port, token);
    const sessionId = 'legacy-webui-room';
    const inbound = new Promise<void>(resolve => {
      app.bind({ events }).events.on('inbound:message', message => {
        if (message.sessionId === sessionId) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'message', sessionId, content: 'hello' }));
    await inbound;

    const message: OutgoingMessage = { sessionId, content: 'reply', source: 'agent' };
    await app.bind({ events }).events.emit('outbound:message', message);
    expect(await message.delivery).toEqual({ ok: true });
  });
});
