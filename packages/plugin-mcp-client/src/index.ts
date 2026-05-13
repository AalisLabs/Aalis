/**
 * @aalis/plugin-mcp-client
 *
 * 作为 MCP client 连接外部 MCP servers（通过 stdio），把它们的 tools
 * 包装注册到 Aalis 的 ToolService，让 Aalis agent 可以直接调用。
 *
 * 设计要点：
 * - 每个 server 在 config.servers 里独立一项（id / command / args / env）
 * - 工具名加前缀 `mcp_<server-id>_<tool-name>` 避免与本地工具冲突
 * - 每个 server 注册一个工具分组 `mcp:<server-id>`
 * - dispose 时关闭所有 client 连接（通过 ctx.onDispose）
 * - 安全级别由 config 中按 server 配置（默认 safe）；高危 server 应显式设为 dangerous
 */

import type { ConfigSchema, Context, SafetyLevel } from '@aalis/core';
import type { ToolDefinition } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
// 引入 plugin-tools-api 触发 declaration merging，使 ctx.registerTool 类型生效
import '@aalis/plugin-tools-api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface ServerSpec {
  /** 唯一 id，用于工具命名空间 */
  id: string;
  /** 可执行命令（如 npx / node / python） */
  command: string;
  /** 命令行参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 是否启用，默认 true */
  enabled?: boolean;
  /** 该 server 提供的工具的安全级别，默认 'safe'；建议对文件/shell 类设为 'dangerous' */
  safety?: SafetyLevel;
  /** 该 server 提供的工具的最低权限等级，默认 1 */
  authority?: number;
}

interface Config {
  servers: ServerSpec[];
}

export const name = '@aalis/plugin-mcp-client';
export const displayName = 'MCP 客户端';
export const subsystem = 'tools';

export const inject = { required: ['tools'] };

export const defaultConfig: Config = {
  servers: [],
};

export const configSchema: ConfigSchema = {
  servers: {
    type: 'array',
    label: 'MCP 服务器列表',
    description: '通过 stdio 连接的 MCP 服务器。每条目至少需要 id 与 command；安全级别按需调整。',
  } as ConfigSchema[string],
};

interface ToolMeta {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = rawConfig as unknown as Config;
  const servers = config.servers ?? [];

  if (servers.length === 0) {
    ctx.logger.info('未配置任何 MCP server，插件空载激活');
    return;
  }

  // 注册分组：每个 enabled server 一个分组，让平台可按需启用
  for (const spec of servers) {
    if (spec.enabled === false) continue;
    useToolService(ctx).registerGroup({
      name: `mcp:${spec.id}`,
      label: `MCP / ${spec.id}`,
      description: `通过 plugin-mcp-client 桥接的远端 MCP server "${spec.id}"`,
    });
  }

  // 并发连接所有 enabled servers；失败的不影响其他
  await Promise.all(
    servers
      .filter(s => s.enabled !== false)
      .map(spec =>
        connectServer(ctx, spec).catch(err => {
          ctx.logger.error(`连接 MCP server "${spec.id}" 失败: ${err instanceof Error ? err.message : String(err)}`);
        }),
      ),
  );
}

async function connectServer(ctx: Context, spec: ServerSpec): Promise<void> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: spec.env,
  });

  const client = new Client({ name: 'aalis-mcp-client', version: '0.1.0' }, { capabilities: {} });

  await client.connect(transport);
  ctx.logger.info(`MCP server "${spec.id}" 已连接 (${spec.command} ${(spec.args ?? []).join(' ')})`);

  // 连接生命周期：ctx dispose 时关闭
  ctx.onDispose(async () => {
    try {
      await client.close();
      ctx.logger.info(`MCP server "${spec.id}" 已关闭`);
    } catch (err) {
      ctx.logger.debug(`关闭 MCP server "${spec.id}" 抛错（已忽略）:`, err);
    }
  });

  await bridgeClientToTools(ctx, client, spec);
}

/**
 * 把一个已连接的 MCP Client 上暴露的所有工具桥接进 Aalis ToolService。
 * 导出以便集成测试直接传入 InMemoryTransport 配对的 client。
 */
export async function bridgeClientToTools(ctx: Context, client: Client, spec: ServerSpec): Promise<void> {
  const { tools: mcpTools } = (await client.listTools()) as { tools: ToolMeta[] };
  ctx.logger.info(`  发现 ${mcpTools.length} 个工具`);

  for (const t of mcpTools) {
    const toolName = sanitizeToolName(`mcp_${spec.id}_${t.name}`);
    const parameters = normalizeParameters(t.inputSchema);

    const definition: ToolDefinition = {
      type: 'function',
      function: {
        name: toolName,
        description: t.description ?? `[MCP ${spec.id}] ${t.name}`,
        parameters,
      },
    };

    useToolService(ctx).register({
      definition,
      groups: [`mcp:${spec.id}`],
      safety: spec.safety ?? 'safe',
      authority: spec.authority ?? 1,
      handler: async args => {
        try {
          const result = await client.callTool({
            name: t.name,
            arguments: args as Record<string, unknown>,
          });
          return formatToolResult(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `MCP 调用 ${spec.id}/${t.name} 失败: ${msg}`;
        }
      },
    });

    ctx.logger.debug(`  - 工具已注册: ${toolName}`);
  }
}

/**
 * MCP 工具名可能含 OpenAI tool-name 不允许的字符（如 '/'、'.'），统一映射为下划线。
 * 同时去重多余下划线，截断到 64 字符（OpenAI 限制）。
 */
function sanitizeToolName(raw: string): string {
  let s = raw.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

/**
 * 把 MCP 的 inputSchema 规范化为 Aalis ToolDefinition 所需的 OpenAI parameters 形状。
 * MCP 通常给完整 JSON Schema，这里只取顶层 type=object 的 properties / required。
 */
function normalizeParameters(schema: Record<string, unknown> | undefined): ToolDefinition['function']['parameters'] {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  const type = (schema.type as string | undefined) ?? 'object';
  if (type !== 'object') {
    // 非 object：包装成 { input: ... }
    return {
      type: 'object',
      properties: { input: schema as Record<string, unknown> },
      required: ['input'],
    };
  }
  return {
    type: 'object',
    properties: (schema.properties as Record<string, unknown>) ?? {},
    required: Array.isArray(schema.required) ? (schema.required as string[]) : undefined,
    additionalProperties: typeof schema.additionalProperties === 'boolean' ? schema.additionalProperties : undefined,
  };
}

interface McpCallToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function formatToolResult(result: unknown): string {
  const r = result as McpCallToolResult;
  const parts = (r.content ?? []).map(c => {
    if (c.type === 'text') return c.text ?? '';
    return `[${c.type}]`;
  });
  const body = parts.join('\n');
  return r.isError ? `MCP 工具返回错误:\n${body}` : body;
}
