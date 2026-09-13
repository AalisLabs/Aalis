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
 * - 默认拒绝 visibility='restricted' 的工具暴露；config.allowRestricted 可改
 * - config.toolGroups 白名单：仅暴露指定分组（空数组=全部允许）
 * - config.bind 默认 127.0.0.1（仅本机访问）
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ToolCallContext, ToolService } from '@aalis/api-tools';
import { asToolExecutionResult } from '@aalis/api-tools';
import type { Context } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface Config {
  /** 监听端口（必须 1-65535）。要暂停服务请在插件列表里禁用本插件。 */
  port: number;
  /** 监听地址，默认 127.0.0.1 */
  bind: string;
  /** 仅暴露这些工具分组（空 = 全部允许，但仍受 allowRestricted 约束） */
  toolGroups: string[];
  /** 是否允许暴露 visibility='restricted' 的工具 */
  allowRestricted: boolean;
}

export const name = '@aalis/plugin-mcp-server';
export const displayName = 'MCP 服务端';
export const subsystem = 'tools';

export const inject = { required: ['tools'] };

export const configSchema: ConfigSchema = {
  port: {
    type: 'number',
    label: '监听端口',
    description: '必须 1-65535；非法值会报错不启动。要暂停服务请在「插件列表」里禁用本插件。',
    default: 7861,
    min: 1,
    max: 65535,
    integer: true,
  } as ConfigSchema[string],
  bind: { type: 'string', label: '监听地址', default: '127.0.0.1' } as ConfigSchema[string],
  toolGroups: {
    type: 'array',
    label: '允许的工具分组（空=全部，受受限开关约束）',
    description: "空列表或单个 '*' = 暴露所有分组的工具（仍受 allowRestricted 约束）。",
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
  allowRestricted: {
    type: 'boolean',
    label: '允许暴露 restricted（受限）工具',
    default: false,
  } as ConfigSchema[string],
};

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = rawConfig as unknown as Config;

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    ctx.logger.error(
      `plugin-mcp-server 端口非法：port=${config.port}。请设置 1-65535 之间的整数；要停服务请在插件列表里禁用本插件。`,
    );
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
  // handle 是函数声明（可提升），TS 不把上面的窄化带进去；固化成非可选类型的常量
  const toolService: ToolService = tools;

  // SSE 同时只支持一个活跃连接（标准约束）；新连接挤掉旧的
  let currentTransport: SSEServerTransport | undefined;
  let mcpServer: McpServer | undefined;

  const httpServer: Server = createServer(async (req, res) => {
    try {
      // 不拿 Host 拼 base：这段代码根本不用 host，而畸形/空 Host（`Host:` 解析成空字符串，
      // 空串非 nullish、?? 兜不住）会让 base 退化成 'http://' 并抛 ERR_INVALID_URL。
      const url = new URL(req.url ?? '/', 'http://localhost');
      await handle(req, res, url);
    } catch (err) {
      // 回调是 async 且这里是它唯一的出口：漏一个异常就是一条 unhandledRejection，
      // 而 runtime 的处理器会判致命并结束进程（webui 走 express 自带兜底，这条没有）。
      ctx.logger.warn(`MCP 请求处理失败: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  });

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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

      mcpServer = buildMcpServer(ctx, toolService, config);
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
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.bind, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  ctx.logger.info(
    `MCP server 监听 http://${config.bind}:${config.port}/sse (allowRestricted=${config.allowRestricted}, groups=${config.toolGroups.length === 0 ? '*' : config.toolGroups.join(',')})`,
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

  // 暴露策略（allowRestricted + toolGroups 白名单）：ListTools 与 CallTool 必须共用同一谓词，
  // 否则分组限制只在发现期生效、执行期可被知道工具名的 client 绕过。
  const groupFilter = new Set(config.toolGroups);
  const isExposed = (t: { visibility?: string; groups?: readonly string[] }): boolean => {
    if (!config.allowRestricted && t.visibility === 'restricted') return false;
    if (groupFilter.size > 0 && !groupFilter.has('*') && !(t.groups ?? []).some(g => groupFilter.has(g))) return false;
    return true;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const filtered = tools.getAll().filter(isExposed);

    // 需要拿 definition 才能给出 parameters。分组过滤默认只回无分组工具，所以要把本次暴露集合自身的
    // 组名传回去——不写 '*' 是为了不依赖注册表版本：旧版把 '*' 当字面组名，带分组工具的 inputSchema
    // 会静默塌成空对象。暴露与否已由 isExposed 裁决，这里只为查 parameters。
    const groups = [...new Set(filtered.flatMap(t => t.groups ?? []))];
    const defMap = new Map(tools.getDefinitions({ groups }).map(d => [d.function.name, d]));

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

    // 二次安全检查：即便 listTools 已过滤，CallTool 仍用同一 isExposed 重新校验
    // （含 allowRestricted + toolGroups 白名单），防 client 按名直调未暴露分组的工具。
    const meta = tools.getAll().find(t => t.name === toolName);
    if (!meta || !isExposed(meta)) {
      return {
        content: [{ type: 'text', text: `工具不可用或未暴露: ${toolName}` }],
        isError: true,
      };
    }

    const callCtx: ToolCallContext = {
      sessionId: 'mcp-server',
      userId: 'mcp-client',
      platform: 'mcp',
    };

    try {
      const result = asToolExecutionResult(await tools.execute(toolName, args, callCtx));
      // MCP 侧只透传文本：工具交给主模型看的图（images）是 agent 回合内的载荷，不在此暴露
      return { content: [{ type: 'text', text: result.content }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text', text: `执行失败: ${msg}` }], isError: true };
    }
  });

  return server;
}
