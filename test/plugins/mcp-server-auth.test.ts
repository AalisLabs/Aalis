import { connect, type Socket } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { afterEach, describe, expect, it } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type Logger, provide } from '../../packages/core/src/index.js';
import mcpServer from '../../packages/plugin-mcp-server/src/index.js';
import { validateConfig } from '../../packages/schema-config/src/index.js';
import { freePort, isListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// mcp-server 的认证：token 是必填的密钥字段，至少 32 个可见 ASCII 字符；没填或写错时插件激活失败、不监听。
// 每个请求先核对 Authorization: Bearer <token>（方案名不分大小写，后面的空格可以不止一个），不对就回 401、不分路由：不建会话，
// 不挤掉已经连上的客户端，POST /messages 不进会话。带了 Bearer 令牌却不对时 WWW-Authenticate 带 invalid_token，没带或方案
// 不对时只写 Bearer。没通过认证的请求记一条带原因的 debug，日志里不出现令牌。停用时一并断开还开着的连接，不等客户端自己断。
// 客户端是 SDK 的 SSE 客户端（请求头同时带在建流的 GET 与每次 POST 上），服务只监听 127.0.0.1 的空闲端口。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-placeholder-token-0123456789abcdef';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 起插件，工具服务只有一个公开工具 echo，calls 记下每次执行的参数，logs 记下应用的每条日志（级别与正文） */
async function start(config: Record<string, unknown>) {
  const port = await freePort();
  const logs: [level: string, message: string][] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void logs.push([level, args.map(String).join(' ')]);
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'error', logger });
  apps.push(app);
  const calls: unknown[] = [];
  app.bind({ provide }).provide.use(tools, {
    getAll: () => [{ name: 'echo', description: 'echo', pluginName: 'test', visibility: 'public' }],
    getDefinitions: () => [
      {
        type: 'function',
        function: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {} } },
      },
    ],
    getSummaries: () => [],
    execute: async (_name: string, args: unknown) => {
      calls.push(args);
      return { content: 'ok' };
    },
  } as never);
  await app.plugins.register(mcpServer, { port, ...config });
  await app.plugins.idle();
  const entry = app.plugins.getPlugin(mcpServer.name);
  return { app, port, calls, logs, state: entry?.state, error: entry?.error };
}

/** SDK 的 SSE 客户端，请求头带对的令牌 */
async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'zz-test', version: '0.0.1' }, { capabilities: {} });
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

/** 裸发一个请求：读完状态与头（JSON 正文一并读出）就断开，SSE 的流不留着 */
async function send(port: number, path: string, init: RequestInit = {}) {
  const abort = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, signal: abort.signal });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await res.json() : undefined;
  abort.abort();
  return { status: res.status, type, challenge: res.headers.get('www-authenticate'), body };
}

describe('plugin-mcp-server 的令牌认证', () => {
  it('没填 token：激活失败、点名缺项、不监听', async () => {
    const r = await start({});
    expect(r.state).toBe('error');
    expect(r.error).toBe('缺少配置项 token，在 WebUI 或配置文件中填入后生效');
    expect(
      validateConfig(mcpServer.configSchema, {})
        .filter(issue => issue.kind === 'missing')
        .map(issue => issue.path),
    ).toEqual(['token']);
    expect(await isListening(r.port)).toBe(false);
  });

  it('令牌太短、含空白或含非 ASCII 字符：激活失败、点名 token、不监听', async () => {
    for (const token of ['zz-short', 'zz-placeholder token-0123456789abcdef', 'zz-placeholder-令牌-0123456789abcdef']) {
      const r = await start({ token });
      expect(r.state, token).toBe('error');
      expect(r.error, token).toContain('token');
      expect(await isListening(r.port), token).toBe(false);
    }
  });

  it('带对的令牌连得上：SDK 客户端列出并调用工具，方案名写成小写、后面跟两个空格也认', async () => {
    const r = await start({ token: TOKEN });
    const client = await connectClient(r.port);
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('echo');
      expect((await client.callTool({ name: 'echo', arguments: { k: 1 } })).isError).not.toBe(true);
      expect(r.calls).toEqual([{ k: 1 }]);
      for (const authorization of [`bearer ${TOKEN}`, `Bearer  ${TOKEN}`]) {
        const res = await send(r.port, '/nope', { headers: { authorization } });
        expect(res.status).toBe(404); // 过了认证才分到 404
      }
    } finally {
      await client.close();
    }
  });

  it('不认证的请求回 401，不碰已经连上的会话', async () => {
    const r = await start({ token: TOKEN });
    const client = await connectClient(r.port);
    try {
      await client.callTool({ name: 'echo', arguments: { k: 1 } });
      const wrong = `${TOKEN.slice(0, -1)}0`;
      // 比真令牌短的错令牌也回 401：两边先取摘要再比，长度不同不会让比较抛错
      const short = 'zz-short';
      const call = JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'echo', arguments: {} },
      });
      for (const [path, init, challenge] of [
        ['/sse', {}, 'Bearer'],
        ['/sse', { headers: { authorization: `Basic ${TOKEN}` } }, 'Bearer'],
        ['/sse', { headers: { authorization: `Bearer ${wrong}` } }, 'Bearer error="invalid_token"'],
        ['/sse', { headers: { authorization: `Bearer ${short}` } }, 'Bearer error="invalid_token"'],
        ['/nope', {}, 'Bearer'],
        [
          '/messages?sessionId=zz-any',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: call },
          'Bearer',
        ],
      ] as const) {
        const res = await send(r.port, path, init);
        expect([res.status, res.challenge], path).toEqual([401, challenge]);
        expect(res.body, path).toEqual({ error: 'invalid_token', error_description: expect.any(String) });
      }
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('echo');
      expect(r.calls).toEqual([{ k: 1 }]);
      const rejected = r.logs.filter(
        ([level, message]) => level === 'debug' && message.startsWith('MCP 请求未通过认证'),
      );
      expect(rejected.map(([, message]) => message)).toEqual([
        'MCP 请求未通过认证（没带 Authorization）：GET /sse',
        'MCP 请求未通过认证（方案不是 Bearer）：GET /sse',
        'MCP 请求未通过认证（令牌不对）：GET /sse',
        'MCP 请求未通过认证（令牌不对）：GET /sse',
        'MCP 请求未通过认证（没带 Authorization）：GET /nope',
        'MCP 请求未通过认证（没带 Authorization）：POST /messages',
      ]);
      expect(r.logs.filter(([, message]) => message.includes(TOKEN))).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe('plugin-mcp-server 的停用', () => {
  it('SDK 客户端关掉后还留着一条没发请求的连接：停用不等它，1 秒内完成', async () => {
    const r = await start({ token: TOKEN });
    const client = await connectClient(r.port);
    await client.callTool({ name: 'echo', arguments: {} });
    await client.close();
    // 客户端关掉之后会再开一条连接、一直不发请求，server.close() 不把它算作空闲、不关；这里主动造一条同样的
    let idle: Socket | undefined;
    try {
      const socket = connect(r.port, '127.0.0.1');
      idle = socket;
      await new Promise<void>(resolve => socket.once('connect', resolve));
      await new Promise(resolve => setTimeout(resolve, 50)); // 等服务端接下这条连接
      const closed = new Promise(resolve => socket.once('close', () => resolve('closed')));
      const stopped = r.app.stop().then(() => 'stopped');
      const within = (ms: number) => new Promise(resolve => setTimeout(resolve, ms, 'waiting'));
      expect(await Promise.race([stopped, within(1_000)])).toBe('stopped');
      expect(await Promise.race([closed, within(500)])).toBe('closed');
    } finally {
      idle?.destroy();
    }
  });
});
