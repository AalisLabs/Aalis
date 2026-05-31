import type { ConfigSchema, Context } from '@aalis/core';
import type { ToolCallContext, ToolDefinition, ToolService, ToolSummary } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-agent-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-search';
export const displayName = '搜索工具';
export const subsystem = 'tools';
// tools 服务由核心提供，无需声明依赖

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
  maxSearchResults: {
    type: 'number',
    label: '搜索结果上限',
    default: 5,
    description: '单次搜索返回的最大工具数量，0 表示不限制',
  },
  alwaysDirectTools: {
    type: 'multiselect',
    label: '直出工具名单',
    default: [],
    allowCustom: true,
    description: '即使启用工具搜索层，也始终直接暴露这些工具的完整定义。填写工具名，如 web_search。',
  },
  maxDiscoveredKeep: {
    type: 'number',
    label: '已发现工具队列上限',
    default: 20,
    description:
      '从消息历史推断出的“已发现工具”最多保留 N 个（按最近使用时间倒序保留，0 = 不限）。' +
      '避免长会话里 discovered 集合无限膨胀，使搜索层失去瘦身价值。',
  },
};

export const defaultConfig = {
  enabled: true,
  showToolNames: true,
  maxDirectTools: 5,
  maxSearchResults: 5,
  alwaysDirectTools: [],
  maxDiscoveredKeep: 20,
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
    '发现并激活系统中的功能工具。搜索到的工具会被系统自动激活，你可以直接调用它们（搜索结果直接包含完整参数定义）。' +
    '\n本工具仅用于发现可调用的功能工具，不会返回任何实际内容。' +
    '\n能直接回答的简单问题无需调用工具；需要工具时，先搜索再直接调用即可。';

  if (toolNames && toolNames.length > 0) {
    description +=
      '\n\n下方"可用工具名清单"仅用于让你知道哪些功能存在，' +
      '便于你想出合适的搜索关键词。' +
      '\n**严禁**仅凭名字直接调用清单里的工具——它们的参数 schema 你并不知道，' +
      '凭名字直接调用会产生参数幻觉、危险副作用或意外失败。' +
      '\n要使用清单中的任何工具，必须先调用 search_tools 拿到完整 parameters 定义后再调用。' +
      `\n\n当前可用工具名清单（仅供搜索参考，禁止直接调用）:\n${toolNames.map(n => `- ${n}`).join('\n')}`;
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
            description: '工具名称或搜索关键词（空字符串返回所有工具摘要）',
          },
          limit: {
            type: 'number',
            description: '本次返回的最大工具数量（默认由系统配置决定）',
          },
          offset: {
            type: 'number',
            description: '跳过前 N 条结果，用于翻页（默认 0）',
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
function searchTools(summaries: ToolSummary[], query: string): ToolSummary[] {
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
 * 从消息历史中提取“已发现”工具名集合
 *
 * 两类来源都算已发现（语义：模型已经知道这个工具叫什么并且能调到）：
 *   1. search_tools 调用结果里返回过的工具名
 *   2. assistant.toolCalls 中实际被调用且收到执行结果（即对应 tool 消息存在）的工具名
 *      —— 这覆盖“模型靠工具名清单 hallucinate 直接调出”的情况，避免下轮又只看到 search_tools。
 *
 * 返回值按“最近一次出现的时间正序排列”：调用方可对 size 做 FIFO 截断保留最近 N 个。
 */
function extractDiscoveredTools(
  messages: {
    role: string;
    content?: string | null;
    toolCalls?: { id: string; function: { name: string } }[];
    toolCallId?: string;
  }[],
  maxKeep: number,
): Set<string> {
  // Map 保持插入顺序；重复出现时 delete+set 把它顶到末尾，天然 LRU
  const ordered = new Map<string, true>();

  // 第一遍：识别 search_tools 调用 id 与所有“收到了 tool 响应”的 toolCallId
  const searchCallIds = new Set<string>();
  const respondedToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.function.name === SEARCH_TOOL_NAME) searchCallIds.add(tc.id);
      }
    } else if (msg.role === 'tool' && msg.toolCallId) {
      respondedToolCallIds.add(msg.toolCallId);
    }
  }

  // 第二遍：按消息时序累积
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        const name = tc.function.name;
        if (name === SEARCH_TOOL_NAME) continue;
        if (!respondedToolCallIds.has(tc.id)) continue;
        if (ordered.has(name)) ordered.delete(name);
        ordered.set(name, true);
      }
      continue;
    }
    if (msg.role === 'tool' && msg.toolCallId && searchCallIds.has(msg.toolCallId) && msg.content) {
      try {
        const result = JSON.parse(msg.content);
        if (Array.isArray(result.tools)) {
          for (const t of result.tools) {
            if (typeof t?.name !== 'string') continue;
            if (ordered.has(t.name)) ordered.delete(t.name);
            ordered.set(t.name, true);
          }
        }
      } catch {
        // 结果解析失败，忽略
      }
    }
  }

  if (maxKeep > 0 && ordered.size > maxKeep) {
    const arr = [...ordered.keys()];
    return new Set(arr.slice(-maxKeep));
  }
  return new Set(ordered.keys());
}

function normalizeToolNames(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean),
  );
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const logger = ctx.logger.child('tool-search');
  const enabled = (config.enabled as boolean) ?? true;
  const showToolNames = (config.showToolNames as boolean) ?? true;
  const maxDirectTools = (config.maxDirectTools as number) ?? 5;
  const maxSearchResults = (config.maxSearchResults as number) ?? 5;
  const alwaysDirectTools = normalizeToolNames(config.alwaysDirectTools);
  const maxDiscoveredKeep = Math.max(0, Math.floor(Number(config.maxDiscoveredKeep ?? 20)));
  const warnedMissingDirectTools = new Set<string>();

  if (!enabled) {
    logger.info('工具搜索层已禁用');
    return;
  }

  // 注册 search_tools 工具（初始定义，钩子中会动态更新 description）
  useToolService(ctx).register({
    definition: buildSearchToolDef(),
    async handler(args: Record<string, unknown>, callCtx: ToolCallContext) {
      const query = String(args.query ?? '');
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      // limit: 优先用模型传入值，否则用配置的 maxSearchResults
      const effectiveLimit =
        typeof args.limit === 'number' && args.limit > 0
          ? Math.floor(args.limit)
          : maxSearchResults > 0
            ? maxSearchResults
            : Infinity;

      // 使用与当前平台一致的分组过滤
      const filter = callCtx.enabledGroups ? { groups: callCtx.enabledGroups } : undefined;
      const summaries = ctx.getService<ToolService>('tools')!.getSummaries(filter);
      const allResults = searchTools(summaries, query);
      const paged = allResults.slice(offset, offset + effectiveLimit);
      // 搜索结果直接包含完整参数定义（parameters schema），配合 getDefinitions 提供

      // 获取完整工具定义（含 parameters schema），构建查找表
      const defs = ctx.getService<ToolService>('tools')!.getDefinitions(filter);
      const defMap = new Map(defs.map(d => [d.function.name, d]));

      const toolDetails = paged.map(t => {
        const def = defMap.get(t.name);
        return {
          name: t.name,
          description: t.description,
          parameters: def?.function.parameters,
        };
      });

      // 收集搜索结果所在分组中未包含的其他工具，作为关联提示
      const resultNames = new Set(paged.map(r => r.name));
      const relatedNames = new Set<string>();
      for (const r of paged) {
        if (!r.groups?.length) continue;
        for (const s of summaries) {
          if (resultNames.has(s.name) || s.name === SEARCH_TOOL_NAME) continue;
          if (s.groups?.some(g => r.groups!.includes(g))) relatedNames.add(s.name);
        }
      }

      // 可用工具总数（排除 search_tools 自身）
      const totalAvailable = summaries.filter(s => s.name !== SEARCH_TOOL_NAME).length;
      const hasMore = offset + paged.length < allResults.length;

      logger.debug(
        `搜索工具 "${query}" → ${paged.length}/${totalAvailable} 条结果 (offset=${offset}, total=${allResults.length})`,
      );

      return JSON.stringify({
        found: `${paged.length}/${totalAvailable}`,
        ...(allResults.length > paged.length
          ? {
              pagination: {
                total: allResults.length,
                offset,
                returned: paged.length,
                ...(hasMore ? { nextOffset: offset + paged.length } : {}),
              },
            }
          : {}),
        tools: toolDetails,
        ...(relatedNames.size > 0
          ? {
              related: `同组相关工具: ${[...relatedNames].join(', ')}。如需使用，请先用 search_tools 激活。`,
            }
          : {}),
        hint:
          paged.length > 0
            ? '你搜索到的工具已激活。搜索结果已包含完整参数定义（parameters），你现在可以直接调用，无需再次搜索。这并不代表同组工具都已激活，也不代表相关或类似的工具都已激活，对于其他工具你仍然需要使用 search_tools 激活。' +
              (hasMore ? ` 还有更多结果，使用 offset=${offset + paged.length} 查看下一页。` : '')
            : '未找到匹配的工具，请尝试其他关键词。',
      });
    },
  });

  // 注册 agent:llm:before 钩子 —— 高优先级，替换工具列表
  ctx.middleware('agent:llm:before', async (data, next) => {
    const allDefs = data.tools;

    // 工具数量不超过阈值时，跳过搜索层 (+1 因为 search_tools 自身也在列表中)
    if (allDefs.length <= maxDirectTools + 1) {
      await next();
      return;
    }

    // 从消息历史提取已发现的工具（含历史调用过的，FIFO 上限保护）
    const discovered = extractDiscoveredTools(data.messages, maxDiscoveredKeep);

    // 构建 search_tools 定义（showToolNames 时附带工具名列表）
    const otherToolNames = allDefs.map(d => d.function.name).filter(n => n !== SEARCH_TOOL_NAME);
    const searchDef = buildSearchToolDef(showToolNames ? otherToolNames : undefined);

    // 构建筛选后的工具列表：search_tools + 直出工具 + 已发现工具完整定义
    const filtered: ToolDefinition[] = [searchDef];
    const visibleToolNames = new Set<string>();
    let directVisibleCount = 0;
    let discoveredVisibleCount = 0;
    for (const def of allDefs) {
      const toolName = def.function.name;
      if (toolName === SEARCH_TOOL_NAME) continue;
      const isDirect = alwaysDirectTools.has(toolName);
      const isDiscovered = discovered.has(toolName);
      if (!isDirect && !isDiscovered) continue;
      if (visibleToolNames.has(toolName)) continue;
      visibleToolNames.add(toolName);
      if (isDirect) directVisibleCount += 1;
      else if (isDiscovered) discoveredVisibleCount += 1;
      filtered.push(def);
    }

    if (alwaysDirectTools.size > 0) {
      for (const toolName of alwaysDirectTools) {
        if (!otherToolNames.includes(toolName) && !warnedMissingDirectTools.has(toolName)) {
          warnedMissingDirectTools.add(toolName);
          logger.warn(`直出工具未注册或当前不可用: ${toolName}`);
        }
      }
    }

    data.tools = filtered;
    logger.debug(
      `工具搜索层: ${allDefs.length} 个工具 → 暴露 ${filtered.length} 个` +
        ` (直出 ${directVisibleCount}/${alwaysDirectTools.size}, 已发现 ${discoveredVisibleCount}/${discovered.size}, 名称列表: ${showToolNames ? '是' : '否'})`,
    );

    await next();
  });
}
