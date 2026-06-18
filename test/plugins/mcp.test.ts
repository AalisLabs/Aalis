/**
 * MCP client / server e2e 集成测试（in-memory transport，无子进程）
 *
 * - Test A：mcp-server 侧 buildMcpServer 通过 InMemoryTransport 给一个真实 MCP Client
 *   暴露 ToolService 中的工具。验证 listTools / callTool / dangerous 过滤。
 * - Test B：mcp-client 侧 bridgeClientToTools 把外部 MCP server 暴露的工具桥接到
 *   一个 mock ToolService。验证工具名前缀、callTool 链路、错误回传。
 */
import type { Context, Logger } from '@aalis/core';
import type {
  RegisteredTool,
  ToolCallContext,
  ToolDefinition,
  ToolGroupInfo,
  ToolService,
  ToolSummary,
} from '@aalis/plugin-tools-api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { bridgeClientToTools } from '../../packages/plugin-mcp-client/src/index.js';
import { buildMcpServer } from '../../packages/plugin-mcp-server/src/index.js';

// ===== helpers =====

function makeLogger(): Logger {
  const noop = () => undefined;
  const l: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => l,
  } as unknown as Logger;
  return l;
}

/** 极简 ToolService stub，覆盖 buildMcpServer 与 bridgeClientToTools 使用到的方法 */
class FakeToolService implements ToolService {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly groups = new Map<string, ToolGroupInfo>();

  register(spec: Omit<RegisteredTool, 'pluginName'>, pluginName = 'test'): () => void {
    const entry: RegisteredTool = { ...spec, pluginName } as RegisteredTool;
    this.tools.set(entry.definition.function.name, entry);
    return () => this.tools.delete(entry.definition.function.name);
  }

  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName = 'test'): () => void {
    const info: ToolGroupInfo = { ...group, pluginName } as ToolGroupInfo;
    this.groups.set(info.name, info);
    return () => this.groups.delete(info.name);
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map(t => t.definition);
  }
  getSummaries(): ToolSummary[] {
    return [...this.tools.values()].map(t => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      groups: t.groups,
      permissions: t.permissions,
    }));
  }
  getAll(): ReturnType<ToolService['getAll']> {
    return [...this.tools.values()].map(t => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      pluginName: t.pluginName,
      visibility: t.visibility ?? 'public',
      permissions: t.permissions,
      groups: t.groups,
    }));
  }
  async execute(name: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t.handler(args, callCtx);
  }
  setExecutionGuard(): void {
    /* noop */
  }
  unregisterByPlugin(): void {
    /* noop */
  }
  getGroups(): ToolGroupInfo[] {
    return [...this.groups.values()];
  }

  /** 测试便利：直接取出注册项 */
  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}

/** 极简 Context stub，覆盖 useToolService 用到的字段 */
function makeFakeCtx(toolService: FakeToolService): Context {
  const logger = makeLogger();
  return {
    id: 'test-mcp-client',
    logger,
    getService: <T>(name: string): T | undefined => (name === 'tools' ? (toolService as unknown as T) : undefined),
    whenService: <T>(name: string, cb: (svc: T) => undefined | (() => void)): (() => void) => {
      if (name !== 'tools') return () => undefined;
      const cleanup = cb(toolService as unknown as T);
      return () => cleanup?.();
    },
    onDispose: () => {
      /* noop */
    },
  } as unknown as Context;
}

// ===== Test A：mcp-server 侧 =====

describe('plugin-mcp-server — buildMcpServer 通过 InMemoryTransport 暴露 Aalis 工具', () => {
  async function setup(opts: { allowRestricted?: boolean } = {}) {
    const tools = new FakeToolService();
    tools.register({
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: '回声',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      },
      handler: async args => `${args.text}!`,
    });
    tools.register({
      definition: {
        type: 'function',
        function: {
          name: 'rm_rf',
          description: '受限工具',
          parameters: { type: 'object', properties: {} },
        },
      },
      visibility: 'restricted',
      handler: async () => 'boom',
    });

    const server = buildMcpServer(makeFakeCtx(tools), tools, {
      port: 0,
      bind: '127.0.0.1',
      toolGroups: [],
      allowRestricted: opts.allowRestricted ?? false,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return { client, server, tools };
  }

  it('listTools 默认过滤 restricted，仅返回 public 工具', async () => {
    const { client, server } = await setup();
    const res = await client.listTools();
    const names = res.tools.map(t => t.name);
    expect(names).toContain('echo');
    expect(names).not.toContain('rm_rf');
    await client.close();
    await server.close();
  });

  it('callTool echo 走通，并返回 text 内容', async () => {
    const { client, server } = await setup();
    const res = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(res.isError ?? false).toBe(false);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('hi!');
    await client.close();
    await server.close();
  });

  it('callTool 调用 restricted 工具时返回 isError', async () => {
    const { client, server } = await setup({ allowRestricted: false });
    const res = await client.callTool({ name: 'rm_rf', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it('allowRestricted=true 时 restricted 工具可见可调用', async () => {
    const { client, server } = await setup({ allowRestricted: true });
    const list = await client.listTools();
    expect(list.tools.map(t => t.name)).toContain('rm_rf');
    const res = await client.callTool({ name: 'rm_rf', arguments: {} });
    expect(res.isError ?? false).toBe(false);
    const content = res.content as Array<{ type: string; text?: string }>;
    expect(content[0].text).toBe('boom');
    await client.close();
    await server.close();
  });
});

// ===== Test A2：toolGroups 白名单在 CallTool 同样强制（防绕过）=====

describe('plugin-mcp-server — toolGroups 白名单 ListTools/CallTool 一致强制', () => {
  async function setupGroups() {
    const tools = new FakeToolService();
    tools.register({
      definition: {
        type: 'function',
        function: { name: 'pub_a', description: 'A 组', parameters: { type: 'object', properties: {} } },
      },
      groups: ['a'],
      handler: async () => 'a-ok',
    });
    tools.register({
      definition: {
        type: 'function',
        function: { name: 'pub_b', description: 'B 组（未暴露）', parameters: { type: 'object', properties: {} } },
      },
      groups: ['b'],
      handler: async () => 'b-ok',
    });
    const server = buildMcpServer(makeFakeCtx(tools), tools, {
      port: 0,
      bind: '127.0.0.1',
      toolGroups: ['a'], // 只暴露 a 组
      allowRestricted: true,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, server };
  }

  it('ListTools 仅暴露白名单分组', async () => {
    const { client, server } = await setupGroups();
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('pub_a');
    expect(names).not.toContain('pub_b');
    await client.close();
    await server.close();
  });

  it('CallTool 按名直调未暴露分组的工具 → isError（修复前可绕过）', async () => {
    const { client, server } = await setupGroups();
    const res = await client.callTool({ name: 'pub_b', arguments: {} });
    expect(res.isError).toBe(true);
    await client.close();
    await server.close();
  });
});

// ===== Test B：mcp-client 侧 =====

describe('plugin-mcp-client — bridgeClientToTools 把远端 MCP 工具注册到 ToolService', () => {
  /** 用 SDK 直接拼一个 mock MCP server（双向 in-memory transport） */
  async function setupRemote(): Promise<{
    client: Client;
    server: McpSdkServer;
    calls: Array<{ name: string; args: unknown }>;
  }> {
    const calls: Array<{ name: string; args: unknown }> = [];

    const server = new McpSdkServer({ name: 'mock-remote', version: '0.0.1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'greet',
          description: '问好',
          inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async req => {
      calls.push({ name: req.params.name, args: req.params.arguments });
      if (req.params.name === 'greet') {
        const who = (req.params.arguments as { who?: string } | undefined)?.who ?? 'world';
        return { content: [{ type: 'text', text: `hello ${who}` }] };
      }
      return { content: [{ type: 'text', text: 'unknown' }], isError: true };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'aalis-mcp-client', version: '0.0.1' }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    return { client, server, calls };
  }

  it('注册的工具名带 mcp_<id>_ 前缀，且 inputSchema 被规范化', async () => {
    const { client, server } = await setupRemote();
    const tools = new FakeToolService();
    await bridgeClientToTools(makeFakeCtx(tools), client, { id: 'remote', command: '<irrelevant>' });

    const registered = tools.list();
    expect(registered).toHaveLength(1);
    const t = registered[0];
    expect(t.definition.function.name).toBe('mcp_remote_greet');
    expect(t.definition.function.parameters).toMatchObject({
      type: 'object',
      properties: { who: { type: 'string' } },
      required: ['who'],
    });
    expect(t.groups).toEqual(['mcp:remote']);
    expect(t.visibility ?? 'public').toBe('public');

    await client.close();
    await server.close();
  });

  it('调用桥接后的工具 → 透传到远端 MCP server，返回文本内容', async () => {
    const { client, server, calls } = await setupRemote();
    const tools = new FakeToolService();
    await bridgeClientToTools(makeFakeCtx(tools), client, { id: 'remote', command: '<irrelevant>' });

    const result = await tools.execute('mcp_remote_greet', { who: 'aalis' }, {
      sessionId: 's',
      userId: 'u',
      platform: 'test',
    } as ToolCallContext);

    expect(result).toBe('hello aalis');
    expect(calls).toEqual([{ name: 'greet', args: { who: 'aalis' } }]);

    await client.close();
    await server.close();
  });
});
