import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredTool, ToolExecutionResult } from '../../packages/api-tools/src/index.js';
import { bridgeClientToTools } from '../../packages/plugin-mcp-client/src/index.js';
import { silentLogger } from '../fixtures/authority.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// 桥进来的 MCP 工具声明可转后台：调用带上执行器给这次调用的中止信号（中止时 SDK 向服务端发
// notifications/cancelled），请求超时取 setTimeout 能表示的最大值，长任务不被 SDK 默认的 60 秒截断；
// 参数表里已有执行器参数名的不声明，请求超时照 SDK 默认的 60 秒。远端报错与调用失败都以 error 报出，
// 后台任务据此记为失败。远端是 InMemoryTransport 上的 SDK 服务端。
// ════════════════════════════════════════════════════════════

interface Held {
  signal: AbortSignal;
  release(text: string): void;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0)) await close();
});

async function setup() {
  const held: Held[] = [];
  const server = new McpSdkServer({ name: 'zz-remote', version: '0.0.1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'slow', description: '慢', inputSchema: { type: 'object', properties: {} } },
      { name: 'broken', description: '报错', inputSchema: { type: 'object', properties: {} } },
      {
        name: 'waiter',
        description: '参数里自带 waitSeconds',
        inputSchema: { type: 'object', properties: { waitSeconds: { type: 'number' } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (req, extra) => {
    if (req.params.name === 'broken') return { content: [{ type: 'text', text: 'zz-remote-error' }], isError: true };
    return new Promise(resolve => {
      held.push({ signal: extra.signal, release: text => resolve({ content: [{ type: 'text', text }] }) });
    });
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'aalis-mcp-client', version: '0.0.1' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const registered: Record<string, Omit<RegisteredTool, 'pluginName'>> = {};
  await bridgeClientToTools(
    {
      logger: silentLogger(),
      tools: stubBoundTools({
        onRegister: t => {
          registered[t.definition.function.name] = t;
        },
      }),
    },
    client,
    { id: 'remote' },
  );
  return { held, registered };
}

const parse = (out: string | ToolExecutionResult) =>
  JSON.parse(typeof out === 'string' ? out : out.content) as Record<string, unknown>;

describe('mcp-client 桥进来的工具可转后台', () => {
  it('声明可转后台（让出时限用执行器的默认）；参数表里已有执行器参数名的不声明', async () => {
    const { registered } = await setup();
    expect(registered.mcp_remote_slow.background).toEqual({});
    expect(registered.mcp_remote_broken.background).toEqual({});
    expect(registered.mcp_remote_waiter.background).toBeUndefined();
  });

  it('中止时服务端收到 notifications/cancelled，调用回错', async () => {
    const { held, registered } = await setup();
    const ac = new AbortController();
    const pending = registered.mcp_remote_slow.handler({}, { sessionId: 's', signal: ac.signal });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    ac.abort();
    await vi.waitFor(() => expect(held[0].signal.aborted).toBe(true));
    expect(parse(await pending).error).toBeDefined();
  });

  it('调用过了 60 秒不被 SDK 截断', async () => {
    const { held, registered } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = registered.mcp_remote_slow.handler({}, { sessionId: 's', signal: new AbortController().signal });
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(settled).toBe(false);
    expect(held[0].signal.aborted).toBe(false);
    held[0].release('zz-late-result');
    const out = await pending;
    expect(typeof out === 'string' ? out : out.content).toContain('zz-late-result');
  });

  it('参数表里已有执行器参数名的工具，远端不回时照 SDK 默认的 60 秒超时回错', async () => {
    const { held, registered } = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = registered.mcp_remote_waiter.handler(
      { waitSeconds: 5 },
      { sessionId: 's', signal: new AbortController().signal },
    );
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(true);
    expect(String(parse(await pending).error)).toMatch(/timed out/i);
  });

  it('远端报错以 error 报出', async () => {
    const { registered } = await setup();
    expect(parse(await registered.mcp_remote_broken.handler({}, { sessionId: 's' })).error).toContain(
      'zz-remote-error',
    );
  });
});
