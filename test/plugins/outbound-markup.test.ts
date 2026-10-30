import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agent } from '../../packages/api-agent/src/index.js';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { platform, sendPlatformMessage } from '../../packages/api-platform/src/index.js';
import { processService } from '../../packages/api-process/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import { App, events, LogHub, provide } from '../../packages/core/src/index.js';
import onebotPlugin from '../../packages/plugin-adapter-onebot/src/index.js';
import agentPlugin from '../../packages/plugin-agent/src/index.js';
import commandsPlugin from '../../packages/plugin-commands/src/index.js';
import gatewayPlugin from '../../packages/plugin-gateway/src/index.js';
import memoryInMemoryPlugin from '../../packages/plugin-memory-inmemory/src/index.js';
import messageArchivePlugin from '../../packages/plugin-message-archive/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import type { OutgoingMessage } from '../../packages/schema-message/src/index.js';
import { setNetworkPolicy } from '../../packages/util-network-guard/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { createMockLLMPlugin } from '../fixtures/mock-llm.js';

// ════════════════════════════════════════════════════════════
// 出站正文默认按纯文字发：只有带 markup 的（她的回复）才把 <at>、<image|record|video url>、<reply>、<face> 解析成
// 平台的 @、媒体与引用并分条；指令回显、宿主提示与第三方插件的文字原样整条发出。她回复里媒体标记的网址由适配器
// 经 safeFetch 取下来内联，不交给实现端去拉；地址不是网址的标记去掉（这里没装 plugin-image-sender，存储地址的也一样）。
// 一条回复最多内联 10 个媒体（多出的不下载、去掉，投递报失败），同时最多下载 4 个；各条按顺序发，前面的文字不等后面的下载。
// 本地起一个假的 OneBot 实现端记录发出的 action。
// ════════════════════════════════════════════════════════════

type WsServer = {
  on(event: 'connection', cb: (socket: WsSocket) => void): void;
  once(event: 'listening', cb: () => void): void;
  address(): AddressInfo;
  clients: Set<WsSocket>;
  close(cb: () => void): void;
};
type WsSocket = { on(event: 'message', cb: (raw: Buffer) => void): void; send(data: string): void; terminate(): void };
type Segment = { type: string; data: Record<string, unknown> };

const { WebSocketServer } = createRequire(
  new URL('../../packages/plugin-adapter-onebot/package.json', import.meta.url),
)('ws') as { WebSocketServer: new (opts: { host: string; port: number }) => WsServer };

const SELF = '10000';
const GROUP = `onebot:${SELF}:group:20001`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
/** 带全部标记、两句话的正文；网址是文档保留段，纯文字发时没有人会去取 */
const MARKED =
  '第一句<at id="1">某人</at>足够长的一段话。<image url="http://198.51.100.1/a.png"/><reply id="2"/><face id="3"/>第二句也足够长的一段话。';

let httpServer: Server;
let httpBase: string;
/** 图片服务器收到的请求路径 */
const fetched: string[] = [];
/** /pair-* 里还在等另一个请求的回应 */
const pairWaiting: Array<() => void> = [];
/** /held-* 的回应：测试放行之前一直挂着 */
const held: Array<() => void> = [];
/** /slow-* 同时在途的请求数与它的峰值 */
const slow = { inFlight: 0, peak: 0 };

beforeAll(async () => {
  httpServer = createServer((req, res) => {
    fetched.push(req.url ?? '');
    const png = () => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) });
      res.end(PNG);
    };
    if (req.url === '/ok.png') return png();
    if (req.url?.startsWith('/held-')) {
      held.push(png);
      return;
    }
    if (req.url?.startsWith('/slow-')) {
      slow.peak = Math.max(slow.peak, ++slow.inFlight);
      setTimeout(() => {
        slow.inFlight--;
        png();
      }, 100);
      return;
    }
    if (req.url === '/note.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('llm:\n  apiKey: <占位 key>\n');
      return;
    }
    if (req.url === '/huge.png') {
      // 只声明超过内联上限的长度，不发正文
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(20 * 1024 * 1024) });
      res.flushHeaders();
      return;
    }
    if (req.url?.startsWith('/pair-')) {
      // 两个请求都到了才一起回图片；只到一个的，1 秒后回 404
      pairWaiting.push(png);
      if (pairWaiting.length === 2) {
        for (const reply of pairWaiting.splice(0)) reply();
        return;
      }
      setTimeout(() => {
        const i = pairWaiting.indexOf(png);
        if (i < 0) return;
        pairWaiting.splice(i, 1);
        res.writeHead(404).end();
      }, 1000);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  httpBase = `127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  fetched.length = 0;
  held.length = 0;
  slow.peak = 0;
});

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, 10));
  }
}

/**
 * 假实现端 + 开着分条（切点只有句号、不延迟）的 onebot 适配器。commands 为真时另装网关与指令插件（没有 agent），say 经网关
 * 走入站相位，等它发出的出站都投递完；debugLog 为真时按 debug 级别记日志，logs 是各条日志的正文。send 交出一条出站消息
 * 并等它投递完，返回投递结果；direct 经平台契约的 sendPlatformMessage 直发
 */
async function boot(protocol: 'v11' | 'v12' = 'v11', opts: { commands?: boolean; debugLog?: boolean } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.once('listening', r));
  cleanups.push(
    () =>
      new Promise<void>(r => {
        for (const c of server.clients) c.terminate();
        server.close(() => r());
      }),
  );
  const actions: Array<{ action: string; params: Record<string, unknown> }> = [];
  server.on('connection', ws => {
    ws.on('message', raw => {
      const req = JSON.parse(raw.toString()) as { action: string; params: Record<string, unknown>; echo?: string };
      actions.push({ action: req.action, params: req.params });
      if (req.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF }, echo: req.echo }));
    });
  });

  const logs: string[] = [];
  const logHub = opts.debugLog ? new LogHub() : undefined;
  logHub?.onEntry(e => void logs.push(e.message));
  const { app } = hostedApp({ logLevel: opts.debugLog ? 'debug' : 'error' }, { logHub });
  cleanups.push(() => app.stop());
  await registerHubs(app);
  const host = app.bind({ provide, events, gateway, platform });
  const outgoing: OutgoingMessage[] = [];
  host.events.use.on('outbound:message', msg => void outgoing.push(msg));
  host.provide.use(storage, { listRoots: () => [] } as never);
  host.provide.use(processService, {} as never);
  const plugins = opts.commands ? [gatewayPlugin, commandsPlugin] : [];
  for (const p of plugins) await app.plugin(p);
  await app.plugin(onebotPlugin, {
    connections: [{ url: `ws://127.0.0.1:${server.address().port}`, protocol, selfId: SELF }],
    splitMessage: { enabled: true, delayPerChar: 0, maxDelay: 0, patterns: ['。'] },
  });
  await app.plugins.idle();
  for (const p of [...plugins, onebotPlugin]) {
    const state = app.plugins.getPlugin(p.name)?.state;
    if (state !== 'active') throw new Error(`${p.name} 未激活（state=${state}）`);
  }
  await app.start();
  await until(() => actions.some(a => a.action === (protocol === 'v11' ? 'get_login_info' : 'get_self_info')));

  /** 发出的各条消息的消息段 */
  const sent = () =>
    actions
      .filter(a => a.action === (protocol === 'v11' ? 'send_group_msg' : 'send_message'))
      .map(a => a.params.message as Segment[]);
  return {
    sent,
    logs,
    /** 交给 outbound:message 的出站消息 */
    outgoing,
    /** 交给实现端的媒体地址（v11 的 file、v12 的 file_id） */
    mediaFiles: () =>
      sent()
        .flat()
        .filter(s => ['image', 'record', 'voice', 'video'].includes(s.type))
        .map(s => String(s.data.file ?? s.data.file_id)),
    async send(msg: OutgoingMessage) {
      await host.events.use.emit('outbound:message', msg);
      return msg.delivery;
    },
    direct: (content: string) => sendPlatformMessage(host.platform, GROUP, content),
    async say(content: string) {
      await host.gateway.use.ingressMessage({
        sessionId: GROUP,
        platform: 'onebot',
        userId: '30001',
        sessionType: 'group',
        content,
      });
      await Promise.all(outgoing.map(msg => msg.delivery));
    },
  };
}

const text = (segments: Segment[]) =>
  segments
    .filter(s => s.type === 'text')
    .map(s => s.data.text)
    .join('');

describe('onebot：没设 markup 的正文按纯文字发', () => {
  it('整条一个文字段，与原文逐字一致，不分条（source=agent 也一样）', async () => {
    const t = await boot();
    expect(await t.send({ sessionId: GROUP, content: MARKED, source: 'agent' })).toEqual({ ok: true });
    expect(t.sent()).toEqual([[{ type: 'text', data: { text: MARKED } }]]);
  });

  it('带 replyTo：引用段在前，后面一个文字段', async () => {
    const t = await boot();
    expect(await t.send({ sessionId: GROUP, content: MARKED, replyTo: '12345' })).toEqual({ ok: true });
    expect(t.sent()).toEqual([
      [
        { type: 'reply', data: { id: 12345 } },
        { type: 'text', data: { text: MARKED } },
      ],
    ]);
  });

  it('平台契约的 sendMessage 直发：同样一个文字段', async () => {
    const t = await boot();
    await t.direct(MARKED);
    expect(t.sent()).toEqual([[{ type: 'text', data: { text: MARKED } }]]);
  });

  it.each(['v11' as const, 'v12' as const])('%s 带附件：正文一条文字段，附件另成一条消息段照常发', async protocol => {
    const t = await boot(protocol);
    const delivery = await t.send({
      sessionId: GROUP,
      content: '<at id="1">某人</at>',
      attachments: [{ kind: 'image', data: `data:image/png;base64,${PNG.toString('base64')}` }],
    });
    expect(delivery).toEqual({ ok: true });
    const [body, media] = t.sent();
    expect(body).toEqual([{ type: 'text', data: { text: '<at id="1">某人</at>' } }]);
    expect(t.sent()).toHaveLength(2);
    expect(media.map(s => s.type)).toEqual(['image']);
    expect(t.mediaFiles()).toEqual([`base64://${PNG.toString('base64')}`]);
  });
});

describe('onebot：markup 的正文照旧解析', () => {
  beforeAll(() => setNetworkPolicy({ blockPrivate: false })); // 只为连本机测试服务
  afterAll(() => setNetworkPolicy({ blockPrivate: true }));

  it('@ 成段、图片单独成条、引用加在所在分条、表情去掉，按句号分条', async () => {
    const t = await boot();
    const content = `第一句<at id="1">某人</at>足够长。第二句也足够长的一段话。<image url="http://${httpBase}/ok.png"/><reply id="2"/><face id="3"/>第三句也足够长的一段话。`;
    expect(await t.send({ sessionId: GROUP, content, source: 'agent', markup: true })).toEqual({ ok: true });
    expect(t.sent()).toEqual([
      [
        { type: 'text', data: { text: '第一句' } },
        { type: 'at', data: { qq: 1 } },
        { type: 'text', data: { text: '足够长' } },
      ],
      [{ type: 'text', data: { text: '第二句也足够长的一段话。' } }],
      [{ type: 'image', data: { file: `base64://${PNG.toString('base64')}` } }],
      [
        { type: 'reply', data: { id: 2 } },
        { type: 'text', data: { text: '第三句也足够长的一段话' } },
      ],
    ]);
  });
});

describe('onebot：markup 正文里地址不是网址的媒体标记去掉', () => {
  it.each([
    ['file://', '<image url="file:///zz/placeholder.png"/>'],
    ['本机绝对路径', '<image url="/zz/placeholder.png"/>'],
    ['存储地址', '<image url="data:/images/onebot_10000_group_20001/a.png"/>'],
    ['data URI', `<image url="data:image/png;base64,${PNG.toString('base64')}"/>`],
    ['外来的 base64://', `<image url="base64://${PNG.toString('base64')}"/>`],
    ['语音的 file://', '<record url="file:///zz/placeholder.wav"/>'],
    ['视频的本机路径', '<video url="/zz/placeholder.mp4"/>'],
  ])('%s：不交给实现端，文字照发，投递报失败', async (_label, marker) => {
    const t = await boot();
    const delivery = await t.send({ sessionId: GROUP, content: `一${marker}二`, source: 'agent', markup: true });
    expect(t.mediaFiles()).toEqual([]);
    expect(t.sent().map(text).join('')).toBe('一二');
    expect(delivery?.ok === false && toSource(delivery.error)).toContain('不是网址');
  });
});

describe('onebot：她回复里媒体标记的网址先经 safeFetch 取下来', () => {
  it.each([
    '<image url="http://{host}/ok.png"/>',
    '<record url="http://{host}/ok.png"/>',
    '<video url="http://{host}/ok.png"/>',
    '<image url="HTTP://{host}/ok.png"/>',
    '<image url="http:{host}/ok.png"/>',
    '<image url=" https://{host}/ok.png"/>',
  ])('私网地址 %s：不交给实现端，标记去掉，文字照发，投递报失败', async raw => {
    const t = await boot();
    const marker = raw.replace('{host}', httpBase);
    const delivery = await t.send({ sessionId: GROUP, content: `看这个${marker}`, source: 'agent', markup: true });
    expect(t.mediaFiles()).toEqual([]);
    expect(t.sent().map(text)).toEqual(['看这个']);
    expect(delivery?.ok === false && toSource(delivery.error)).toContain('拒绝访问');
    expect(fetched).toEqual([]);
  });

  it('去掉的标记两边的文字照旧是文字，不拼成新的标记', async () => {
    const t = await boot();
    const content = `看这个<image url="http://10.0.0.1/x<image url="http://${httpBase}/ok.png"/>"/>`;
    const delivery = await t.send({ sessionId: GROUP, content, source: 'agent', markup: true });
    expect(t.mediaFiles()).toEqual([]);
    expect(t.sent().map(text)).toEqual(['看这个<image url="http://10.0.0.1/x', '"/>']);
    expect(delivery?.ok === false && toSource(delivery.error)).toContain('拒绝访问');
    expect(fetched).toEqual([]);
  });

  describe('放开私网（只为连本机测试服务）', () => {
    beforeAll(() => setNetworkPolicy({ blockPrivate: false }));
    afterAll(() => setNetworkPolicy({ blockPrivate: true }));

    it('网址的图片由适配器下载、核对文件头后以 base64:// 内联，实现端拿不到网址', async () => {
      const t = await boot();
      const delivery = await t.send({
        sessionId: GROUP,
        content: `看这个<image url="http://${httpBase}/ok.png"/>`,
        source: 'agent',
        markup: true,
      });
      expect(delivery).toEqual({ ok: true });
      expect(fetched).toEqual(['/ok.png']);
      expect(t.mediaFiles()).toEqual([`base64://${PNG.toString('base64')}`]);
    });

    it('网址的内容不是图片：标记去掉不发，投递报失败', async () => {
      const t = await boot();
      const delivery = await t.send({
        sessionId: GROUP,
        content: `看这个<image url="http://${httpBase}/note.png"/>`,
        source: 'agent',
        markup: true,
      });
      expect(fetched).toEqual(['/note.png']);
      expect(t.mediaFiles()).toEqual([]);
      expect(t.sent().map(text)).toEqual(['看这个']);
      expect(delivery?.ok === false && toSource(delivery.error)).toContain('文件头不符');
    });

    it('超过内联上限：网址不交给实现端，标记去掉，文字照发，投递报失败', async () => {
      const t = await boot();
      const delivery = await t.send({
        sessionId: GROUP,
        content: `看这个<image url="http://${httpBase}/huge.png"/>`,
        source: 'agent',
        markup: true,
      });
      expect(t.mediaFiles()).toEqual([]);
      expect(t.sent().map(text)).toEqual(['看这个']);
      expect(delivery?.ok === false && toSource(delivery.error)).toContain('超过内联上限');
    });

    it('几个网址同时下载，按原来的顺序拼回', async () => {
      const t = await boot();
      const delivery = await t.send({
        sessionId: GROUP,
        content: `一<image url="http://${httpBase}/pair-a.png"/>二<image url="http://${httpBase}/pair-b.png"/>`,
        source: 'agent',
        markup: true,
      });
      expect(delivery).toEqual({ ok: true });
      expect(t.sent().map(s => s.map(seg => seg.type))).toEqual([['text'], ['image'], ['text'], ['image']]);
    });

    it('一条回复里的网址同时最多下载 4 个', async () => {
      const t = await boot();
      const markers = Array.from({ length: 6 }, (_, i) => `<image url="http://${httpBase}/slow-${i}.png"/>`);
      const delivery = await t.send({
        sessionId: GROUP,
        content: `看${markers.join('')}`,
        source: 'agent',
        markup: true,
      });
      expect(delivery).toEqual({ ok: true });
      expect(t.mediaFiles()).toHaveLength(6);
      expect(slow.peak).toBeLessThanOrEqual(4);
    });

    it('一条回复最多内联 10 个媒体：多出的不下载、去掉，文字照发，投递报多出的个数', async () => {
      const t = await boot();
      const markers = Array.from({ length: 12 }, () => `<image url="http://${httpBase}/ok.png"/>`);
      const delivery = await t.send({
        sessionId: GROUP,
        content: `看${markers.join('')}`,
        source: 'agent',
        markup: true,
      });
      expect(fetched).toHaveLength(10);
      expect(t.mediaFiles()).toHaveLength(10);
      expect(t.sent()[0]).toEqual([{ type: 'text', data: { text: '看' } }]);
      expect(delivery?.ok === false && toSource(delivery.error)).toContain(
        '一条回复最多发 10 个媒体，多出的 2 个已拒发',
      );
    });

    it('前面的文字不等后面的图下载：先发出，图下载完按原位置发，后面的文字跟在图后', async () => {
      const t = await boot();
      const pending = t.send({
        sessionId: GROUP,
        content: `先说<image url="http://${httpBase}/held-a.png"/>后说`,
        source: 'agent',
        markup: true,
      });
      await until(() => t.sent().length > 0 && held.length > 0, 2000);
      expect(t.sent()).toEqual([[{ type: 'text', data: { text: '先说' } }]]);
      for (const reply of held.splice(0)) reply();
      expect(await pending).toEqual({ ok: true });
      expect(t.sent().map(s => s.map(seg => seg.type))).toEqual([['text'], ['image'], ['text']]);
    });

    it('debug 日志记内联之前的正文', async () => {
      const t = await boot('v11', { debugLog: true });
      const content = `看这个<image url="http://${httpBase}/ok.png"/>`;
      expect(await t.send({ sessionId: GROUP, content, source: 'agent', markup: true })).toEqual({ ok: true });
      expect(t.logs.filter(line => line.startsWith('OneBot 发送消息'))).toEqual([
        `OneBot 发送消息 [${GROUP}]: ${content}`,
      ]);
    });
  });
});

describe('发出方：只有 agent 的回复设 markup', () => {
  async function bootAgent(withModel: boolean) {
    const app = new App({ name: 'T', logLevel: 'error' });
    cleanups.push(() => app.stop());
    await registerHubs(app);
    const plugins = [
      ...(withModel
        ? [createMockLLMPlugin({ throwOnce: new Error('<模型出错>'), responses: [{ content: '好' }] })]
        : []),
      memoryInMemoryPlugin,
      messageArchivePlugin,
      agentPlugin,
    ];
    for (const p of plugins) await app.plugin(p, p === agentPlugin ? { systemPrompt: 'test' } : undefined);
    await app.plugins.idle();
    for (const p of plugins) expect(app.plugins.getPlugin(p.name)?.state, `${p.name} 未激活`).toBe('active');
    const host = app.bind({ agent, events });
    const sent: OutgoingMessage[] = [];
    host.events.use.on('outbound:message', msg => void sent.push(msg));
    const ask = () =>
      host.agent.use.handleMessage({ content: '你好', sessionId: 'test:markup', platform: 'test', userId: 'u1' });
    return { sent, ask };
  }

  it('回复设 markup；[错误] 与 [系统] 提示不设', async () => {
    const a = await bootAgent(true);
    await a.ask();
    await a.ask();
    expect(a.sent.map(m => [m.content, m.markup])).toEqual([
      ['[错误] <模型出错>', undefined],
      ['好', true],
    ]);

    const b = await bootAgent(false);
    await b.ask();
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0].content).toMatch(/^\[系统\] /);
    expect(b.sent[0].markup).toBeUndefined();
  });

  it('0 级群友指令参数里的标记：报错回显按纯文字发到群里，实现端收不到图片段', async () => {
    const t = await boot('v11', { commands: true });
    const marker = "<image url='http://198.51.100.1/a.png'/>";
    await t.say(`/clear "${marker}"`);
    expect(t.outgoing.map(m => m.markup)).toEqual([undefined]);
    expect(t.mediaFiles()).toEqual([]);
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0].every(s => s.type === 'text')).toBe(true);
    expect(text(t.sent()[0])).toContain(marker);
  });

  it('网关缺 agent 时的兜底回复不设，发到群里是一个文字段', async () => {
    const t = await boot('v11', { commands: true });
    await t.say('你好');
    expect(t.outgoing.map(m => [m.source, m.markup])).toEqual([['system', undefined]]);
    expect(t.sent()).toEqual([[{ type: 'text', data: { text: t.outgoing[0].content } }]]);
  });
});
