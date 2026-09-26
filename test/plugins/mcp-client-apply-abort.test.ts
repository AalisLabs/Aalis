import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, type LifecycleCap, type Logger, provide } from '../../packages/core/src/index.js';
import mcpClient from '../../packages/plugin-mcp-client/src/index.js';
import { ToolRegistry } from '../../packages/plugin-tools/src/tools.js';
import { stubBoundTools } from '../fixtures/bound-tools.js';

// ════════════════════════════════════════════════════════════
// mcp-client 的 apply 等每个 server 握手、列工具（SDK 默认各 60 秒超时）：接上 lifecycle.signal 后，
// 停用、重启、停机时 apply 随 abort 落定，中止不记「连接失败」。SDK 给传入的 signal 挂 abort 监听且从不摘除，
// 所以插件经每段专用的 controller 桥接，结束时摘掉桥：长寿的 lifecycle.signal 上不留监听器。
//
// transport 用替身：按 JSON-RPC 应答 initialize 与 tools/list；hang 指定的方法收下请求、永不应答。
// ════════════════════════════════════════════════════════════

const fake = vi.hoisted(() => ({ hang: undefined as string | undefined, closed: 0, requests: [] as string[] }));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    onmessage?: (message: unknown) => void;
    onclose?: () => void;
    async start(): Promise<void> {}
    async send(message: { id?: number; method?: string; params?: { protocolVersion?: string } }): Promise<void> {
      if (message.id === undefined || !message.method) return; // 通知（initialized、cancelled）不应答
      fake.requests.push(message.method);
      if (message.method === fake.hang) return;
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'fake', version: '0.0.0' },
            }
          : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result }));
    }
    async close(): Promise<void> {
      fake.closed++;
      this.onclose?.();
    }
  },
}));

const GRACE_MS = 1000;
const SERVERS = { servers: [{ id: 'fake', command: 'fake-mcp' }] };

function recorder() {
  const lines: Array<{ level: string; text: string }> = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push({ level, text: args.map(String).join(' ') });
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, lines };
}

async function until(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop().catch(() => {});
  Object.assign(fake, { hang: undefined, closed: 0, requests: [] });
});

describe('plugin-mcp-client 握手与列工具随 lifecycle.signal 中止', () => {
  it.each([
    ['握手', 'initialize', '握手中止后 SDK 关掉 transport（子进程）'],
    ['列工具', 'tools/list', '已连上的 client 随激活关闭（onDispose）关掉 transport'],
  ])('%s挂起时停用：apply 在宽限内落定，不记连接失败，条目转 disabled，transport 被关', async (_step, method, closedBy) => {
    fake.hang = method;
    const { logger, lines } = recorder();
    const app = new App({ name: 'T', logger, disposeTimeoutMs: GRACE_MS });
    apps.push(app);
    app.bind({ provide }).provide(tools, new ToolRegistry(logger));
    const registering = app.plugin(mcpClient, SERVERS);
    await until(() => fake.requests.includes(method), `${method} 请求`);

    const started = Date.now();
    expect(await app.plugins.disable(mcpClient.name)).toBe(true);
    const elapsed = Date.now() - started;
    await registering;
    await app.plugins.idle();

    expect(lines).toEqual([]);
    expect(app.plugins.getPlugin(mcpClient.name)?.state).toBe('disabled');
    expect(elapsed, '停用应在宽限内返回').toBeLessThan(GRACE_MS);
    expect(fake.closed, closedBy).toBe(1);
  });

  it('握手与列工具完成后，lifecycle.signal 上不留桥接监听', async () => {
    const abort = new AbortController();
    const disposers: Array<() => void | Promise<void>> = [];
    const lifecycle: LifecycleCap = {
      id: mcpClient.name,
      signal: abort.signal,
      onDrain: () => () => {},
      onDispose: fn => {
        disposers.push(fn);
        return () => {};
      },
    };
    const registered: string[] = [];
    const { logger, lines } = recorder();
    await mcpClient.apply({
      tools: stubBoundTools({ onRegister: tool => void registered.push(tool.definition.function.name) }),
      logger,
      lifecycle,
      config: SERVERS,
      plugins: { current: undefined } as never,
      hostConfig: { current: undefined } as never,
    });

    expect(lines).toEqual([]);
    expect(fake.requests).toEqual(['initialize', 'tools/list']);
    expect(registered).toContain('mcp_fake_echo');
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
    for (const dispose of disposers) await dispose();
    expect(fake.closed).toBe(1);
  });
});
