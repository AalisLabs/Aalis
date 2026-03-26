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
  required: ['tools'],
};

export const configSchema: ConfigSchema = {
  enabled: {
    type: 'boolean',
    label: '启用工具搜索层',
    default: true,
    description: '关闭后所有工具将直接发送给 LLM，不经过搜索层',
  },
  showToolNames: {
    type: 'boolean',
    label: '展示工具名称列表',
    default: true,
    description:
      '开启后，系统提示中会附带所有可用工具的名称列表（不含说明），' +
      '模型需要调用 search_tools 查询具体用法后才能使用对应工具。' +
      '关闭后模型只看到 search_tools，需要先搜索才能发现工具。',
  },
  maxDirectTools: {
    type: 'number',
    label: '直传阈值',
    default: 5,
    description: '当注册的工具总数不超过此值时，跳过搜索层，直接将全部工具发送给 LLM',
  },
};

export const defaultConfig = {
  enabled: true,
  showToolNames: true,
  maxDirectTools: 5,
};

// ===== 常量 =====

/** search_tools 自身的工具名 */
const SEARCH_TOOL_NAME = 'search_tools';

// ===== 工具搜索逻辑 =====

/**
 * 构建 search_tools 的工具定义
 * 当 showToolNames 开启时，description 中会附带所有可用工具的名称列表
 */
function buildSearchToolDef(toolNames?: string[]): ToolDefinition {
  let description =
    '查询工具的详细使用方法。传入工具名称或关键词，返回匹配工具的完整参数说明。' +
    '你必须先调用此工具了解用法后，才能调用对应工具。';

  if (toolNames && toolNames.length > 0) {
    description +=
      '\n\n当前可用工具列表:\n' +
      toolNames.map(n => `- ${n}`).join('\n');
  }

  return {
    type: 'function',
    function: {
      name: SEARCH_TOOL_NAME,
      description,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '工具名称或搜索关键词（空字符串返回所有工具的详细说明）',
          },
        },
        required: ['query'],
      },
    },
  };
}

/**
 * 在工具摘要列表中按关键词搜索
 */
function searchTools(
  summaries: ToolSummary[],
  query: string,
): ToolSummary[] {
  // 排除 search_tools 自身
  const pool = summaries.filter(s => s.name !== SEARCH_TOOL_NAME);

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
  const enabled = (config.enabled as boolean) ?? true;
  const showToolNames = (config.showToolNames as boolean) ?? true;
  const maxDirectTools = (config.maxDirectTools as number) ?? 5;

  if (!enabled) {
    logger.info('工具搜索层已禁用');
    return;
  }

  // 注册 search_tools 工具（初始定义，钩子中会动态更新 description）
  ctx.registerTool({
    definition: buildSearchToolDef(),
    async handler(args: Record<string, unknown>, callCtx: ToolCallContext) {
      const query = String(args.query ?? '');
      // 使用与当前平台一致的分组过滤
      const filter = callCtx.enabledGroups ? { groups: callCtx.enabledGroups } : undefined;
      const summaries = ctx.tools!.getSummaries().filter(t => {
        if (!filter?.groups?.length) return true;
        return !t.groups || t.groups.length === 0 || t.groups.some(g => filter.groups!.includes(g));
      });
      const results = searchTools(summaries, query);
      // 搜索结果返回完整定义，供 LLM 了解参数
      const allDefs = ctx.tools!.getDefinitions(filter);
      const defMap = new Map(allDefs.map(d => [d.function.name, d]));

      const toolDetails = results.map(t => {
        const def = defMap.get(t.name);
        return {
          name: t.name,
          description: t.description,
          parameters: def?.function.parameters ?? null,
          authority: t.authority,
          safety: t.safety,
        };
      });

      logger.debug(`搜索工具 "${query}" → ${results.length} 条结果`);

      return JSON.stringify({
        found: results.length,
        tools: toolDetails,
        hint: results.length > 0
          ? '以上工具现在对你可用，你可以直接调用它们。'
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

    // 构建 search_tools 定义（showToolNames 时附带工具名列表）
    const otherToolNames = allDefs
      .map(d => d.function.name)
      .filter(n => n !== SEARCH_TOOL_NAME);
    const searchDef = buildSearchToolDef(showToolNames ? otherToolNames : undefined);

    // 构建筛选后的工具列表：search_tools + 已发现的工具完整定义
    const filtered: ToolDefinition[] = [searchDef];
    if (discovered.size > 0) {
      for (const def of allDefs) {
        if (def.function.name !== SEARCH_TOOL_NAME && discovered.has(def.function.name)) {
          filtered.push(def);
        }
      }
    }

    data.tools = filtered;
    logger.debug(
      `工具搜索层: ${allDefs.length} 个工具 → 暴露 ${filtered.length} 个` +
      ` (已发现 ${discovered.size}, 名称列表: ${showToolNames ? '是' : '否'})`,
    );

    await next();
  }, 100); // 高优先级，先于其他中间件执行
}
