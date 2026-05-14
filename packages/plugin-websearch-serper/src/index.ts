import type { ConfigSchema, Context } from '@aalis/core';
import { resolveLLMModel } from '@aalis/plugin-llm-api';
import type { Message } from '@aalis/plugin-message-api';
import { useToolService } from '@aalis/plugin-tools-api';
import type { WebSearchRequest, WebSearchResponse, WebSearchResult, WebSearchService } from './types.js';
import { WebSearchCapabilities } from './types.js';
import '@aalis/plugin-tools-api';

export type {
  WebSearchCapability,
  WebSearchCapabilityRegistry,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
  WebSearchService,
} from './types.js';
export { WebSearchCapabilities } from './types.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-websearch-serper';
export const displayName = 'Serper 网络搜索';
export const subsystem = 'tools';
export const provides = ['web-search'];
export const inject = {
  optional: ['llm'],
};

export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'Serper API Key', required: true, secret: true, description: 'Serper.dev API 密钥' },
  maxPerMinute: { type: 'number', label: '每分钟最大次数', default: 10, description: '频率限制：每分钟最多搜索次数' },
  maxPerDay: { type: 'number', label: '每天最大次数', default: 100, description: '频率限制：每天最多搜索次数' },
  maxConcurrent: { type: 'number', label: '最大并发', default: 3, description: '同时进行的搜索请求数上限' },
  defaultNumResults: { type: 'number', label: '默认结果数', default: 5, description: '每次搜索返回的结果条数' },
  enableCompression: {
    type: 'boolean',
    label: '启用搜索结果压缩',
    default: false,
    description: '启用后，搜索结果将先经过 LLM 压缩整合后再返回给 Agent，减少 Token 消耗并提升信息质量。',
  },
  compressionLLM: {
    type: 'llm-ref',
    label: '压缩模型',
    description: '选择用于压缩搜索结果的模型。留空则使用默认 LLM 提供者。',
  },
  compressionPrompt: {
    type: 'textarea',
    label: '压缩提示词',
    default: '',
    description: '自定义压缩搜索结果的提示词。留空使用默认提示。提示词中可使用 {query} 代表搜索关键词。',
  },
};

export const defaultConfig = {
  maxPerMinute: 10,
  maxPerDay: 100,
  maxConcurrent: 3,
  defaultNumResults: 5,
  enableCompression: false,
  compressionPrompt: '',
};

// ===== 配置 =====

interface WebSearchConfig {
  apiKey: string;
  maxPerMinute: number;
  maxPerDay: number;
  maxConcurrent: number;
  defaultNumResults: number;
  enableCompression: boolean;
  compressionLLM?: { provider: string; model: string };
  compressionPrompt: string;
}

// ===== 速率限制器 =====

class RateLimiter {
  private readonly maxPerMinute: number;
  private readonly maxPerDay: number;
  private readonly maxConcurrent: number;

  private minuteTimestamps: number[] = [];
  private dayTimestamps: number[] = [];
  private concurrent = 0;

  constructor(config: Pick<WebSearchConfig, 'maxPerMinute' | 'maxPerDay' | 'maxConcurrent'>) {
    this.maxPerMinute = config.maxPerMinute;
    this.maxPerDay = config.maxPerDay;
    this.maxConcurrent = config.maxConcurrent;
  }

  /**
   * 检查是否可以发起请求，返回 null 表示允许，否则返回拒绝原因
   */
  check(): string | null {
    const now = Date.now();

    // 清理过期记录
    const oneMinuteAgo = now - 60_000;
    const oneDayAgo = now - 86_400_000;
    this.minuteTimestamps = this.minuteTimestamps.filter(t => t > oneMinuteAgo);
    this.dayTimestamps = this.dayTimestamps.filter(t => t > oneDayAgo);

    if (this.concurrent >= this.maxConcurrent) {
      return `已达最大并发数 (${this.maxConcurrent})`;
    }
    if (this.minuteTimestamps.length >= this.maxPerMinute) {
      return `已达每分钟调用上限 (${this.maxPerMinute}/min)`;
    }
    if (this.dayTimestamps.length >= this.maxPerDay) {
      return `已达每日调用上限 (${this.maxPerDay}/day)`;
    }
    return null;
  }

  acquire(): void {
    const now = Date.now();
    this.minuteTimestamps.push(now);
    this.dayTimestamps.push(now);
    this.concurrent++;
  }

  release(): void {
    this.concurrent = Math.max(0, this.concurrent - 1);
  }

  getStatus() {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const oneDayAgo = now - 86_400_000;
    return {
      minuteUsed: this.minuteTimestamps.filter(t => t > oneMinuteAgo).length,
      minuteLimit: this.maxPerMinute,
      dayUsed: this.dayTimestamps.filter(t => t > oneDayAgo).length,
      dayLimit: this.maxPerDay,
      concurrent: this.concurrent,
      concurrentLimit: this.maxConcurrent,
    };
  }
}

// ===== Serper API =====

interface SerperSearchResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

interface SerperResponse {
  searchParameters: { q: string };
  knowledgeGraph?: {
    title?: string;
    type?: string;
    description?: string;
  };
  organic: SerperSearchResult[];
  answerBox?: {
    title?: string;
    answer?: string;
    snippet?: string;
  };
}

async function serperSearch(query: string, apiKey: string, numResults: number): Promise<SerperResponse> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: numResults,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Serper API 错误 (${response.status}): ${text}`);
  }

  return (await response.json()) as SerperResponse;
}

function formatSearchResults(data: SerperResponse): string {
  const parts: string[] = [];

  if (data.answerBox) {
    const ab = data.answerBox;
    parts.push(`【直接回答】${ab.answer ?? ab.snippet ?? ab.title ?? ''}`);
  }

  if (data.knowledgeGraph) {
    const kg = data.knowledgeGraph;
    if (kg.description) {
      parts.push(`【知识图谱】${kg.title ?? ''}: ${kg.description}`);
    }
  }

  if (data.organic && data.organic.length > 0) {
    parts.push('【搜索结果】');
    for (const item of data.organic) {
      parts.push(`${item.position ?? '-'}. ${item.title}\n   ${item.link}\n   ${item.snippet}`);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : '未找到搜索结果。';
}

/** 将 Serper 原始响应转换为标准 WebSearchResult 数组 */
function toStandardResults(data: SerperResponse): WebSearchResult[] {
  return (data.organic ?? []).map(item => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
  }));
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: WebSearchConfig = {
    apiKey: (config.apiKey as string) ?? '',
    maxPerMinute: (config.maxPerMinute as number) ?? 10,
    maxPerDay: (config.maxPerDay as number) ?? 100,
    maxConcurrent: (config.maxConcurrent as number) ?? 3,
    defaultNumResults: (config.defaultNumResults as number) ?? 5,
    enableCompression: (config.enableCompression as boolean) ?? false,
    compressionLLM:
      config.compressionLLM &&
      typeof config.compressionLLM === 'object' &&
      (config.compressionLLM as { provider?: unknown }).provider &&
      (config.compressionLLM as { model?: unknown }).model
        ? (config.compressionLLM as { provider: string; model: string })
        : undefined,
    compressionPrompt: (config.compressionPrompt as string) ?? '',
  };

  if (!cfg.apiKey) {
    throw new Error('未配置 Serper API Key，网络搜索不可用');
  }

  const limiter = new RateLimiter(cfg);

  const DEFAULT_COMPRESSION_PROMPT =
    '请根据用户的搜索意图，将以下搜索结果压缩整合为一段简洁、准确、有条理的摘要。' +
    '保留关键事实、数据和来源，去除重复和无关信息。用中文回答。\n\n' +
    '搜索关键词: {query}\n\n搜索结果:\n{results}';

  /** 使用 LLM 压缩搜索结果 */
  async function compressResults(query: string, rawResults: string): Promise<string> {
    const entry = resolveLLMModel(ctx, cfg.compressionLLM, ['chat']);
    if (!entry) return rawResults;

    const promptTemplate = cfg.compressionPrompt || DEFAULT_COMPRESSION_PROMPT;
    const prompt = promptTemplate.replace('{query}', query).replace('{results}', rawResults);

    const messages: Message[] = [{ role: 'user', content: prompt }];

    try {
      const response = await entry.instance.chat({
        messages,
        maxTokens: 1024,
      });
      return response.content?.trim() || rawResults;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`搜索结果压缩失败，返回原始结果: ${msg}`);
      return rawResults;
    }
  }

  ctx.logger.info(
    `网络搜索已启用 (provider: serper, ` +
      `限制: ${cfg.maxPerMinute}/min, ${cfg.maxPerDay}/day, ` +
      `并发: ${cfg.maxConcurrent}` +
      `${cfg.enableCompression ? ', 压缩: 已启用' : ''})`,
  );

  // 注册为 web-search 服务，供其他插件消费
  const serperService: WebSearchService = {
    providerName: 'serper',
    async search(request: WebSearchRequest): Promise<WebSearchResponse> {
      const num = Math.min(10, Math.max(1, request.numResults ?? cfg.defaultNumResults));
      const data = await serperSearch(request.query, cfg.apiKey, num);
      return {
        query: request.query,
        results: toStandardResults(data),
        answer: data.answerBox?.answer ?? data.answerBox?.snippet,
        raw: data as unknown as Record<string, unknown>,
      };
    },
  };
  const { Web, Compression } = WebSearchCapabilities;
  ctx.provide('web-search', serperService, {
    capabilities: cfg.enableCompression ? [Web, Compression] : [Web],
    label: 'Serper',
  });

  // 注册工具分组
  useToolService(ctx).registerGroup({
    name: 'search',
    label: '网页搜索',
    description: '通过 Serper API 搜索互联网获取最新信息',
  });

  // 注册搜索工具
  useToolService(ctx).register({
    groups: ['search'],
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        strict: true,
        description:
          '搜索互联网获取最新信息。以下情况应主动使用，不要等被明确要求才搜索：' +
          '(1) 遇到不熟悉的梗、网络用语、表情包、段子、缩写；' +
          '(2) 时事新闻、热点事件、最新数据；' +
          '(3) 任何拿不准或想核实的事实、人物、作品；' +
          '(4) 用户明确要求查询的内容。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词，应当简洁且有针对性',
            },
            numResults: {
              type: 'number',
              description: `返回结果数量，默认 ${cfg.defaultNumResults}，范围 1-10`,
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      const query = args.query as string;
      const numResults = Math.min(10, Math.max(1, (args.numResults as number) ?? cfg.defaultNumResults));

      // 速率限制检查
      const rejectReason = limiter.check();
      if (rejectReason) {
        ctx.logger.warn(`搜索被限流: ${rejectReason}`);
        return JSON.stringify({
          error: `搜索请求被限流: ${rejectReason}`,
          status: limiter.getStatus(),
        });
      }

      limiter.acquire();
      try {
        ctx.logger.debug(`执行搜索: "${query}" (${numResults} 条结果)`);
        const data = await serperSearch(query, cfg.apiKey, numResults);
        let result = formatSearchResults(data);

        // 压缩整合
        if (cfg.enableCompression) {
          ctx.logger.debug(`压缩搜索结果 (原始长度: ${result.length})`);
          result = await compressResults(query, result);
          ctx.logger.debug(`压缩完成 (压缩后长度: ${result.length})`);
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.error(`搜索失败: ${message}`);
        return JSON.stringify({ error: `搜索失败: ${message}` });
      } finally {
        limiter.release();
      }
    },
  });
}
