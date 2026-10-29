import { chatModelPicker, llm } from '@aalis/api-llm';
import { tools, wrapUntrustedContent } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, defineService, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import type { Message } from '@aalis/schema-message';
import { t } from './texts.js';
import type { WebSearchRequest, WebSearchResponse, WebSearchResult, WebSearchService } from './types.js';

export type {
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
  WebSearchService,
} from './types.js';

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const webSearch = defineService<WebSearchService>('web-search');

const configSchema = defineConfig({
  apiKey: {
    type: 'string',
    label: 'Serper API Key',
    required: true,
    secret: true,
    onInvalid: 'error',
    description: t('apiKeyDescription'),
  },
  maxPerMinute: {
    type: 'number',
    label: t('maxPerMinuteLabel'),
    default: 10,
    description: t('maxPerMinuteDescription'),
  },
  maxPerDay: { type: 'number', label: t('maxPerDayLabel'), default: 100, description: t('maxPerDayDescription') },
  maxConcurrent: {
    type: 'number',
    label: t('maxConcurrentLabel'),
    default: 3,
    description: t('maxConcurrentDescription'),
  },
  defaultNumResults: {
    type: 'number',
    label: t('defaultNumResultsLabel'),
    default: 5,
    description: t('defaultNumResultsDescription'),
  },
  enableCompression: {
    type: 'boolean',
    label: t('enableCompressionLabel'),
    default: false,
    description: t('enableCompressionDescription'),
  },
  compressionPrompt: {
    type: 'textarea',
    label: t('compressionPromptLabel'),
    default: '',
    description: t('compressionPromptDescription'),
  },
});

// ===== 配置 =====

type WebSearchConfig = ConfigOf<typeof configSchema>;

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

  if (parts.length === 0) return '未找到搜索结果。';
  return wrapUntrustedContent(parts.join('\n\n'), '网络搜索结果');
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

const uses = { tools: optional(tools), logger, config, provide, llm: optional(llm) };
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-websearch-serper',
  displayName: t('displayName'),
  subsystem: 'tools',
  configSchema,
  provides: [webSearch],
  uses,
  apply(caps) {
    registerSerper(caps);
  },
});

function registerSerper({ tools, logger, config, provide, llm }: Caps): void {
  const cfg = parseConfig(configSchema, config.use, logger.use);

  const limiter = new RateLimiter(cfg);

  const DEFAULT_COMPRESSION_PROMPT =
    '请根据用户的搜索意图，将以下搜索结果压缩整合为一段简洁、准确、有条理的摘要。' +
    '保留关键事实、数据和来源，去除重复和无关信息。用中文回答。\n\n' +
    '搜索关键词: {query}\n\n搜索结果:\n{results}';

  const pickChatModel = chatModelPicker(llm, () => logger.use.warn('没有可用的对话模型，搜索结果压缩跳过'));

  /**
   * 使用 LLM 压缩搜索结果；没有能对话的模型时返回原始结果。模型取 llm 服务给本插件挑的能对话的那一个（见 chatModelPicker）。
   * 输出上限只防失控；模型在上限处停下时末尾标出截断。压缩模型读的是网页原文，它的输出同样不可信：由这里包上标记，不靠提示词让
   * 模型自己加；截断说明接在正文末尾，在标记之内（标记没有闭合）
   */
  async function compressResults(query: string, rawResults: string): Promise<string> {
    const entry = pickChatModel();
    if (!entry) return rawResults;

    const promptTemplate = cfg.compressionPrompt || DEFAULT_COMPRESSION_PROMPT;
    // 一次换完两个占位符：替换值里的 $ 不当替换模式，搜索词里写的 {results} 也不会再被换掉
    const prompt = promptTemplate.replace(/\{(query|results)\}/g, (_, key) => (key === 'query' ? query : rawResults));

    const messages: Message[] = [{ role: 'user', content: prompt }];

    try {
      const response = await entry.use.chat({
        messages,
        maxTokens: 2048,
      });
      const text = response.content?.trim();
      if (!text) return rawResults;
      return wrapUntrustedContent(
        response.finishReason === 'length' ? `${text}（已在长度上限处截断）` : text,
        '网络搜索结果',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.use.warn(`搜索结果压缩失败，返回原始结果: ${msg}`);
      return rawResults;
    }
  }

  logger.use.info(
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
  provide.use(webSearch, serperService, {
    label: 'Serper',
  });

  // 注册工具分组
  tools.use.registerGroup({
    name: 'search',
    label: t('groupLabel'),
    summary: t('groupSummary'),
    description: '通过 Serper API 搜索互联网获取最新信息',
  });

  // 注册搜索工具
  tools.use.register({
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
        logger.use.warn(`搜索被限流: ${rejectReason}`);
        return JSON.stringify({
          error: `搜索请求被限流: ${rejectReason}`,
          status: limiter.getStatus(),
        });
      }

      limiter.acquire();
      try {
        logger.use.debug(`执行搜索: "${query}" (${numResults} 条结果)`);
        const data = await serperSearch(query, cfg.apiKey, numResults);
        let result = formatSearchResults(data);

        // 压缩整合
        if (cfg.enableCompression) {
          logger.use.debug(`压缩搜索结果 (原始长度: ${result.length})`);
          result = await compressResults(query, result);
          logger.use.debug(`压缩完成 (压缩后长度: ${result.length})`);
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.use.error(`搜索失败: ${message}`);
        return JSON.stringify({ error: `搜索失败: ${message}` });
      } finally {
        limiter.release();
      }
    },
  });

  // 图片搜索工具：返回候选图片 URL 列表，配合 send_attachment 使用
  tools.use.register({
    groups: ['search'],
    definition: {
      type: 'function',
      function: {
        name: 'search_images',
        description:
          '搜索互联网图片，返回候选图片 URL 列表。常与 send_attachment 配合：' +
          '先 search_images 拿候选 → 评估缩略图 → 调 send_attachment(kind="image", url) 发出。' +
          '适用场景：用户要求"发个 xxx 表情包"、"找张 xxx 的图发我"。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '图片搜索关键词。' },
            numResults: {
              type: 'number',
              description: `返回数量，默认 ${cfg.defaultNumResults}，范围 1-10`,
            },
          },
          required: ['query'],
        },
      },
    },
    handler: async args => {
      const query = args.query as string;
      const numResults = Math.min(10, Math.max(1, (args.numResults as number) ?? cfg.defaultNumResults));
      const rejectReason = limiter.check();
      if (rejectReason) return JSON.stringify({ error: `图片搜索被限流: ${rejectReason}` });
      limiter.acquire();
      try {
        const res = await fetch('https://google.serper.dev/images', {
          method: 'POST',
          headers: { 'X-API-KEY': cfg.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: query, num: numResults }),
          // 与 serperSearch 对齐：挂起期间限流槽不释放，几次就把图片+网页搜索一起锁死
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return JSON.stringify({ error: `Serper images API 错误 ${res.status}` });
        const data = (await res.json()) as { images?: Array<Record<string, unknown>> };
        const images = (data.images ?? []).slice(0, numResults).map(it => ({
          title: it.title as string,
          imageUrl: it.imageUrl as string,
          thumbnailUrl: it.thumbnailUrl as string,
          source: it.source as string,
          link: it.link as string,
          width: it.imageWidth as number,
          height: it.imageHeight as number,
        }));
        // title/source 源自各网页，同 web_search 一样标注为不可信（imageUrl 供 send_attachment 用，无碍）
        return JSON.stringify({
          query,
          count: images.length,
          images: wrapUntrustedContent(JSON.stringify(images), '图片搜索结果'),
        });
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        limiter.release();
      }
    },
  });
}
