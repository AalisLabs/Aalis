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

import type { AppService, ConfigSchema, Context, PluginManagerService } from '@aalis/core';
import type { CapabilityVisibility } from '@aalis/plugin-authority-api';
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
  /** 该 server 提供的工具的默认可见性，默认 'public'；建议对文件/shell 类设为 'restricted' */
  visibility?: CapabilityVisibility;
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
    items: {
      id: {
        type: 'string',
        label: '唯一 ID',
        description: '用于工具命名空间，最终工具名形如 mcp_<id>_<tool>。仅允许字母数字与下划线/中划线。',
        required: true,
      },
      command: {
        type: 'string',
        label: '可执行命令',
        description: '例如 npx / node / python / 绝对路径。',
        required: true,
      },
      args: {
        type: 'textarea',
        label: '命令参数',
        description: '每行一个参数；或用空格分隔。会按行优先解析，行内再按空格切分。',
        default: '',
      },
      env: {
        type: 'textarea',
        label: '环境变量',
        description: '每行一个 KEY=VALUE。',
        default: '',
      },
      enabled: {
        type: 'boolean',
        label: '启用',
        description: '关闭可临时跳过该 server 而不删除整条配置。',
        default: true,
      },
      visibility: {
        type: 'select',
        label: '默认可见性',
        description: '控制该 server 暴露的所有工具的默认可见性；restricted 须被 owner/委托授予才能调用。',
        default: 'public',
        options: [
          { label: 'public（默认可用）', value: 'public' },
          { label: 'restricted（受限，须授予）', value: 'restricted' },
        ],
      },
    },
    default: [],
  },
};

interface ToolMeta {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const rawServers = ((rawConfig as { servers?: unknown }).servers ?? []) as unknown[];
  const servers: ServerSpec[] = rawServers
    .map((s, i) => normalizeServerSpec(s, i, ctx))
    .filter((s): s is ServerSpec => s !== undefined);

  if (servers.length === 0) {
    ctx.logger.info('未配置任何 MCP server，仅注册元数据工具');
    registerSelfServiceTools(ctx);
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

  // 注册 agent 自服务工具：只读列表 + toggle 已配置 server 的启用开关。
  // 故意不提供「新增 server」工具——那等价于让 agent 任意 spawn 子进程，授权风险过大。
  // 若要新增 server，应在 WebUI / yaml 手工配置。
  registerSelfServiceTools(ctx);
}

/**
 * 在 ToolService 中注册 mcp_list_servers / mcp_set_server_enabled 两个 agent 自服务工具。
 * 二者都属于 `mcp:_meta` 分组，便于平台按需开放。
 */
function registerSelfServiceTools(ctx: Context): void {
  const tools = useToolService(ctx);
  tools.registerGroup({
    name: 'mcp:_meta',
    label: 'MCP / 元数据',
    description: '让 agent 列出和切换已配置的 MCP server（不能新增/删除条目）。',
  });

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'mcp_list_servers',
        description: '列出本插件已配置的所有 MCP server（id / command / 当前 enabled 状态）。只读，不接触子进程。',
        parameters: { type: 'object', properties: {} },
      },
    },
    groups: ['mcp:_meta'],
    visibility: 'public',
    handler: async () => {
      const cfg = ctx.config.getPluginConfig<{ servers?: unknown[] }>(name);
      const list = (cfg.servers ?? []).map((s, i) => {
        const r = (s as Record<string, unknown>) ?? {};
        return {
          index: i,
          id: typeof r.id === 'string' ? r.id : `(\u7f3a\u5931 id)`,
          command: typeof r.command === 'string' ? r.command : '',
          enabled: r.enabled !== false,
        };
      });
      return JSON.stringify(list, null, 2);
    },
  });

  tools.register({
    definition: {
      type: 'function',
      function: {
        name: 'mcp_set_server_enabled',
        description:
          '切换某个已配置 MCP server 的 enabled 字段并持久化；插件会自动 bounce 让变更生效。' +
          '只能开关已存在的条目，不能新增；id 必须匹配 mcp_list_servers 返回的某项。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '目标 server 的 id' },
            enabled: { type: 'boolean', description: 'true = 启用，false = 停用' },
          },
          required: ['id', 'enabled'],
        },
      },
    },
    groups: ['mcp:_meta'],
    // 写配置 + 触发 bounce：受限能力，须被 owner/委托授予。
    visibility: 'restricted',
    handler: async args => {
      const id = typeof args.id === 'string' ? args.id : '';
      const enabled = args.enabled === true;
      if (!id) return '失败：参数 id 必填';

      const pm = ctx.getService<PluginManagerService>('plugins');
      const app = ctx.getService<AppService>('app');
      if (!pm || !app) return '失败：app/plugins 服务不可用';

      const current = ctx.config.getPluginConfig<{ servers?: unknown[] }>(name);
      const servers = Array.isArray(current.servers) ? [...current.servers] : [];
      const idx = servers.findIndex(s => {
        const r = (s as Record<string, unknown>) ?? {};
        return r.id === id;
      });
      if (idx < 0) return `失败：没有 id="${id}" 的 server，请先用 mcp_list_servers 查看`;

      const before = (servers[idx] as Record<string, unknown>) ?? {};
      if ((before.enabled !== false) === enabled) {
        return `无变化：server "${id}" 当前 enabled=${enabled}`;
      }
      servers[idx] = { ...before, enabled };

      const ok = await pm.updatePluginConfig(name, { ...current, servers });
      if (!ok) return `失败：updatePluginConfig 返回 false`;
      app.saveConfig();
      return `已将 server "${id}" 设置为 enabled=${enabled}，插件会 bounce 后生效`;
    },
  });
}

/**
 * 把来自 WebUI（textarea 字符串）/ yaml（数组对象）两种形态的 server 配置项统一成 ServerSpec。
 * 非法条目（缺 id 或 command）跳过并日志警告，避免整插件挂掉。
 */
function normalizeServerSpec(raw: unknown, index: number, ctx: Context): ServerSpec | undefined {
  if (!raw || typeof raw !== 'object') {
    ctx.logger.warn(`servers[${index}] 不是对象，跳过`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (!id || !command) {
    ctx.logger.warn(`servers[${index}] 缺少 id 或 command，跳过`);
    return undefined;
  }

  // args: 支持 string[] | string（每行一参数 / 空格分隔）
  let args: string[] | undefined;
  if (Array.isArray(r.args)) {
    args = r.args.map(x => String(x)).filter(Boolean);
  } else if (typeof r.args === 'string' && r.args.trim()) {
    args = r.args
      .split('\n')
      .flatMap(line => line.trim().split(/\s+/))
      .filter(Boolean);
  }

  // env: 支持 Record<string,string> | string（KEY=VALUE 每行一条）
  let env: Record<string, string> | undefined;
  if (r.env && typeof r.env === 'object' && !Array.isArray(r.env)) {
    env = Object.fromEntries(Object.entries(r.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  } else if (typeof r.env === 'string' && r.env.trim()) {
    env = {};
    for (const line of r.env.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }

  const visibility: CapabilityVisibility | undefined =
    r.visibility === 'restricted' ? 'restricted' : r.visibility === 'public' ? 'public' : undefined;
  const enabled = r.enabled !== false;

  return { id, command, args, env, enabled, visibility };
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
      visibility: spec.visibility ?? 'public',
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
