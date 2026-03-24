import type {
  Context,
  ConfigSchema,
  ToolDefinition,
  ToolCallContext,
  ToolSummary,
} from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-search';

export const inject = {
  required: [] as string[],
  optional: [] as string[],
};

export const configSchema: ConfigSchema = {
  maxDirectTools: {
    type: 'number',
    label: '直传阈值',
    default: 5,
    description: '当注册的工具总数不超过此值时，跳过搜索层，直接将全部工具发送给 LLM',
  },
};

export const defaultConfig = {
  maxDirectTools: 5,
};

// ===== 常量 =====

/** search_tools 自身的工具名 */
const SEARCH_TOOL_NAME = 'search_tools';

/** search_tools 的工具定义 */
const SEARCH_TOOL_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: SEARCH_TOOL_NAME,
    description:
      '搜索可用工具。传入关键词，返回匹配的工具列表及其描述。' +
      '搜索到工具后即可直接调用对应工具。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，可以是工具名称、功能描述等（空字符串返回所有工具摘要）',
        },
      },
      required: ['query'],
    },
  },
};

// ===== 工具搜索逻辑 =====

/**
 * 在工具摘要列表中按关键词搜索
 */
function searchTools(
  summaries: ToolSummary[],
  query: string,
  userAuthority?: number,
): ToolSummary[] {
  // 排除 search_tools 自身
  let pool = summaries.filter(s => s.name !== SEARCH_TOOL_NAME);

  // 按权限过滤
  if (userAuthority !== undefined) {
    pool = pool.filter(s => s.authority <= userAuthority);
  }

  if (!query.trim()) return pool;

  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pool.filter(tool => {
    const text = `${tool.name} ${tool.description}`.toLowerCase();
    return keywords.some(kw => text.includes(kw));
  });
}

/**
 * 从消息历史中提取已搜索过的工具名称集合
 *
 * 扫描所有 assistant 的 search_tools 调用及其对应的 tool 结果消息，
 * 解析出已被发现的工具名。
 */
function extractDiscoveredTools(
  messages: { role: string; content?: string | null; toolCalls?: { id: string; function: { name: string } }[]; toolCallId?: string }[],
): Set<string> {
  const discovered = new Set<string>();

  // 收集所有 search_tools 调用的 id
  const searchCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.function.name === SEARCH_TOOL_NAME) {
          searchCallIds.add(tc.id);
        }
      }
    }
  }

  // 解析对应 tool 结果
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && searchCallIds.has(msg.toolCallId)) {
      if (!msg.content) continue;
      try {
        const result = JSON.parse(msg.content);
        if (Array.isArray(result.tools)) {
          for (const t of result.tools) {
            if (typeof t.name === 'string') discovered.add(t.name);
          }
        }
      } catch {
        // 结果解析失败，忽略
      }
    }
  }

  return discovered;
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const logger = ctx.logger.child('tool-search');
  const maxDirectTools = (config.maxDirectTools as number) ?? 5;

  // 注册 search_tools 工具
  ctx.registerTool({
    definition: SEARCH_TOOL_DEF,
    async handler(args: Record<string, unknown>, callCtx: ToolCallContext) {
      const query = String(args.query ?? '');
      const summaries = ctx.tools.getSummaries();
      const results = searchTools(summaries, query);

      logger.debug(`搜索工具 "${query}" → ${results.length} 条结果`);

      return JSON.stringify({
        found: results.length,
        tools: results.map(t => ({
          name: t.name,
          description: t.description,
          authority: t.authority,
          safety: t.safety,
        })),
        hint: results.length > 0
          ? '这些工具已对你可用，你可以直接调用它们。'
          : '未找到匹配的工具，请尝试其他关键词。',
      });
    },
  });

  // 注册 llm-call:before 钩子 —— 高优先级，替换工具列表
  ctx.middleware('llm-call:before', async (data, next) => {
    const allDefs = data.tools;

    // 工具数量不超过阈值时，跳过搜索层 (+1 因为 search_tools 自身也在列表中)
    if (allDefs.length <= maxDirectTools + 1) {
      await next();
      return;
    }

    // 从消息历史提取已发现的工具
    const discovered = extractDiscoveredTools(data.messages);

    // 构建筛选后的工具列表：search_tools + 已发现的工具
    const filtered: ToolDefinition[] = [SEARCH_TOOL_DEF];
    if (discovered.size > 0) {
      for (const def of allDefs) {
        if (def.function.name !== SEARCH_TOOL_NAME && discovered.has(def.function.name)) {
          filtered.push(def);
        }
      }
    }

    data.tools = filtered;
    logger.debug(
      `工具搜索层: ${allDefs.length} 个工具 → 暴露 ${filtered.length} 个 (已发现 ${discovered.size})`,
    );

    await next();
  }, 100); // 高优先级，先于其他中间件执行
}
