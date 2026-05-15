/**
 * @aalis/plugin-mcp-server
 *
 * 反向 MCP 桥：把 Aalis 注册的 tools 通过 MCP 协议暴露给外部 client
 * （Claude Desktop / Cursor / 其他 MCP-aware app）。
 *
 * 传输方式：HTTP + SSE（Aalis 是常驻进程，stdio 已被日志占用）。
 * 外部 client 通过 SSE URL 连接。
 *
 * 安全考虑：
 * - 默认拒绝 safetyLevel='dangerous' 的工具暴露；config.allowDangerous 可改
 * - config.toolGroups 白名单：仅暴露指定分组（空数组=全部允许）
 * - config.bind 默认 127.0.0.1（仅本机访问）
 */
import { createServer, type Server } from 'node:http';
import type { ConfigSchema, Context } from '@aalis/core';
import '@aalis/plugin-tools-api';
import type { RegisteredTool, ToolCallContext, ToolService, ToolSummary } from '@aalis/plugin-tools-api';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface Config {
  enabled: boolean;
  /** 监听端口；0 = 不启动 */
  port: number;
  /** 监听地址，默认 127.0.0.1 */
  bind: string;
  /** 仅暴露这些工具分组（空 = 全部允许，但仍受 allowDangerous 约束） */
  toolGroups: string[];
  /** 是否允许暴露 safetyLevel='dangerous' 的工具 */
  allowDangerous: boolean;
}

export const name = '@aalis/plugin-mcp-server';
export const displayName = 'MCP 服务端';
export const subsystem = 'tools';

export const inject = { required: ['tools'] };

export const defaultConfig: Config = {
  enabled: false,
  port: 7861,
  bind: '127.0.0.1',
  toolGroups: [],
  allowDangerous: false,
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用', default: false } as ConfigSchema[string],
  port: {
    type: 'number',
    label: '监听端口',
    description: '必须 > 0；设为 0 或负数会报错。要禁用请取消上面的「启用」。',
    default: 7861,
  } as ConfigSchema[string],
  bind: { type: 'string', label: '监听地址', default: '127.0.0.1' } as ConfigSchema[string],
  toolGroups: {
    type: 'array',
    label: '允许的工具分组（空=全部，受危险开关约束）',
    description: '空列表 = 暴露所有分组的工具（仍受 allowDangerous 约束）。',
    items: {
      name: {
        type: 'string',
        label: '分组名',
        description: '如 mcp:godot / file / system。',
        required: true,
      },
    },
    default: [],
  } as ConfigSchema[string],
  allowDangerous: {
    type: 'boolean',
    label: '允许暴露 dangerous 工具',
    default: false,
  } as ConfigSchema[string],
};

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = rawConfig as unknown as Config;

  if (!config.enabled) {
    ctx.logger.info('plugin-mcp-server 未启用（enabled=false）');
    return;
  }
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    ctx.logger.error(`plugin-mcp-server 启用但端口非法：port=${config.port}。请设置 1-65535 之间的整数，或取消启用。`);
    return;
  }

  // 兼容两种 toolGroups 形态：string[]（yaml 手写）/ Array<{name:string}>（WebUI 数组项）
  config.toolGroups = (config.toolGroups as unknown as Array<string | { name?: unknown }>)
    .map(g => (typeof g === 'string' ? g : typeof g?.name === 'string' ? g.name : ''))
    .filter(Boolean);

  const tools = ctx.getService<ToolService>('tools');
  if (!tools) {
    ctx.logger.error('tools 服务不可用');
    return;
  }

  // SSE 同时只支持一个活跃连接（标准约束）；新连接挤掉旧的
  let currentTransport: SSEServerTransport | undefined;
  let mcpServer: McpServer | undefined;

  const httpServer: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/sse') {
      // 新 SSE 连接
      if (currentTransport) {
        try {
          await currentTransport.close();
        } catch {
          /* ignore */
        }
      }
      const transport = new SSEServerTransport('/messages', res);
      currentTransport = transport;

      mcpServer = buildMcpServer(ctx, tools, config);
      await mcpServer.connect(transport);
      ctx.logger.info('MCP client 已通过 SSE 连接');

      req.on('close', () => {
        if (currentTransport === transport) {
          currentTransport = undefined;
          mcpServer = undefined;
          ctx.logger.info('MCP client 已断开');
        }
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      if (!currentTransport) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no active SSE session' }));
        return;
      }
      await currentTransport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.bind, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  ctx.logger.info(
    `MCP server 监听 http://${config.bind}:${config.port}/sse (allowDangerous=${config.allowDangerous}, groups=${config.toolGroups.length === 0 ? '*' : config.toolGroups.join(',')})`,
  );

  ctx.onDispose(async () => {
    if (currentTransport) {
      try {
        await currentTransport.close();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    ctx.logger.info('MCP server 已停止');
  });
}

/**
 * 构造一个 MCP server 实例并装好 ListTools / CallTool 路由。
 * 不绑定 transport；调用方负责 `server.connect(transport)`。
 * 导出以便集成测试通过 InMemoryTransport 直连，避开 HTTP/SSE 层。
 */
export function buildMcpServer(_ctx: Context, tools: ToolService, config: Config): McpServer {
  const server = new McpServer({ name: 'aalis-mcp-server', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const all = tools.getAll();
    const groupFilter = new Set(config.toolGroups);
    const filtered = all.filter(t => {
      if (!config.allowDangerous && t.safety === 'dangerous') return false;
      if (groupFilter.size > 0) {
        const groups = t.groups ?? [];
        if (!groups.some(g => groupFilter.has(g))) return false;
      }
      return true;
    });

    // 需要拿 definition 才能给出 parameters；这里再走一次 getDefinitions 取
    const defsByName = new Map<string, ToolSummary>();
    for (const s of tools.getSummaries()) defsByName.set(s.name, s);
    const definitions = tools.getDefinitions();
    const defMap = new Map(definitions.map(d => [d.function.name, d]));

    return {
      tools: filtered.map(t => {
        const def = defMap.get(t.name);
        return {
          name: t.name,
          description: t.description,
          inputSchema: (def?.function.parameters as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
        };
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // 二次安全检查：即便 listTools 已过滤，CallTool 仍重新校验，防止 client 越界
    const meta = tools.getAll().find(t => t.name === toolName);
    if (!meta) {
      return {
        content: [{ type: 'text', text: `工具不存在: ${toolName}` }],
        isError: true,
      };
    }
    if (!config.allowDangerous && meta.safety === 'dangerous') {
      return {
        content: [{ type: 'text', text: `工具 "${toolName}" 已被 plugin-mcp-server 拒绝（dangerous）` }],
        isError: true,
      };
    }

    const callCtx: ToolCallContext = {
      sessionId: 'mcp-server',
      userId: 'mcp-client',
      platform: 'mcp',
    };

    try {
      const result = await tools.execute(toolName, args, callCtx);
      return { content: [{ type: 'text', text: result }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `执行失败: ${msg}` }], isError: true };
    }
  });

  return server;
}

// 抑制 unused 警告：RegisteredTool 仅用于文档/类型参考
export type _ReferencedTypes = RegisteredTool;
