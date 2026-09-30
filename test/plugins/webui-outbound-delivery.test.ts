import { afterEach, describe, expect, it } from 'vitest';
import { App, events } from '../../packages/core/src/index.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { freePort } from '../helpers/net.js';

type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const apps: App[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.stop();
});

async function startWebui() {
  const port = await freePort();
  const token = 'outbound-delivery-test-token';
  const app = new App({ name: 'WebUI delivery test', logLevel: 'error' });
  apps.push(app);
  await app.pluginAll([
    {
      definition: webuiServer,
      config: { port, host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken: token },
    },
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
  it('reports failure when an explicit WebUI target has no subscribed open socket', async () => {
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
    expect(await message.delivery).toMatchObject({ ok: false });
    expect(delivered).toEqual([]);
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
    expect(delivered[0].attachments).toEqual(message.attachments);
    expect(delivered[0].attachments).not.toBe(message.attachments);
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
