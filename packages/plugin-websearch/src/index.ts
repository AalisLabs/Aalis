import type { Context } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-websearch';

// ===== 配置 =====

interface WebSearchConfig {
  provider: 'serper';
  serper: {
    apiKey: string;
  };
  rateLimit: {
    maxPerMinute: number;
    maxPerDay: number;
    maxConcurrent: number;
  };
  defaultNumResults: number;
}

// ===== 速率限制器 =====

class RateLimiter {
  private readonly maxPerMinute: number;
  private readonly maxPerDay: number;
  private readonly maxConcurrent: number;

  private minuteTimestamps: number[] = [];
  private dayTimestamps: number[] = [];
  private concurrent = 0;

  constructor(config: WebSearchConfig['rateLimit']) {
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

async function serperSearch(
  query: string,
  apiKey: string,
  numResults: number,
): Promise<SerperResponse> {
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

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg: WebSearchConfig = {
    provider: (config.provider as string as 'serper') ?? 'serper',
    serper: {
      apiKey: ((config.serper as Record<string, unknown>)?.apiKey as string) ?? '',
    },
    rateLimit: {
      maxPerMinute: ((config.rateLimit as Record<string, unknown>)?.maxPerMinute as number) ?? 10,
      maxPerDay: ((config.rateLimit as Record<string, unknown>)?.maxPerDay as number) ?? 100,
      maxConcurrent: ((config.rateLimit as Record<string, unknown>)?.maxConcurrent as number) ?? 3,
    },
    defaultNumResults: (config.defaultNumResults as number) ?? 5,
  };

  if (!cfg.serper.apiKey) {
    ctx.logger.warn('未配置 Serper API Key，网络搜索不可用');
    return;
  }

  const limiter = new RateLimiter(cfg.rateLimit);

  ctx.logger.info(
    `网络搜索已启用 (provider: ${cfg.provider}, ` +
    `限制: ${cfg.rateLimit.maxPerMinute}/min, ${cfg.rateLimit.maxPerDay}/day, ` +
    `并发: ${cfg.rateLimit.maxConcurrent})`,
  );

  // 注册搜索工具
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        strict: true,
        description:
          '搜索互联网获取最新信息。当用户询问实时信息、新闻、不确定的事实、' +
          '或任何可能需要最新数据的问题时使用此工具。',
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
    handler: async (args) => {
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
        const data = await serperSearch(query, cfg.serper.apiKey, numResults);
        return formatSearchResults(data);
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
