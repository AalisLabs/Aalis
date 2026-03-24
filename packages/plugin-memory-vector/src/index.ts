import type { Context, IncomingMessage, OutgoingMessage, Message, MiddlewareNext, VectorStoreService } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-vector';
export const provides: string[] = [];
export const inject = {
  required: ['vectorstore'],
};

// ===== 配置 =====

interface VectorMemoryConfig {
  embedding: {
    /** embedding 提供者: 'ollama' | 'openai' */
    provider: 'ollama' | 'openai';
    /** 模型名称 */
    model: string;
    /** API 端点 */
    baseUrl: string;
    /** API Key（openai 模式需要） */
    apiKey?: string;
  };
  search: {
    /** 返回的最大结果数 */
    topK: number;
    /** 时间衰减权重 (0-1)，0=纯语义相似度，1=纯时间近因 */
    timeWeight: number;
  };
}

// ===== Embedding Provider =====

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    // 优先使用新版 /api/embed，失败则回退到旧版 /api/embeddings
    let res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (res.ok) {
      const data = await res.json() as { embeddings: number[][] };
      return data.embeddings[0];
    }
    // 旧版 API 回退
    res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(`Ollama embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as { embedding: number[] };
    return data.embedding;
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embedding 请求失败: ${res.status} ${res.statusText}`);
    }
    const data = await res.json() as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }
}

// ===== 时间衰减计算 =====

function recencyScore(timestampMs: number, nowMs: number): number {
  const daysSince = (nowMs - timestampMs) / (1000 * 60 * 60 * 24);
  return Math.exp(-0.1 * daysSince);
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  // 获取向量数据库服务
  const vectorstore = ctx.getService<VectorStoreService>('vectorstore');
  if (!vectorstore) {
    throw new Error('向量记忆插件需要 vectorstore 服务，请确保 @aalis/plugin-vectorstore 已加载');
  }
  // 绑定到 const 以便闭包内 TS 类型收窄
  const store: VectorStoreService = vectorstore;

  const embeddingRaw = (config.embedding ?? {}) as Record<string, unknown>;
  const searchRaw = (config.search ?? {}) as Record<string, unknown>;

  const cfg: VectorMemoryConfig = {
    embedding: {
      provider: (embeddingRaw.provider as string as VectorMemoryConfig['embedding']['provider']) ?? 'ollama',
      model: (embeddingRaw.model as string) ?? 'nomic-embed-text',
      baseUrl: (embeddingRaw.baseUrl as string) ?? 'http://localhost:11434',
      apiKey: embeddingRaw.apiKey as string | undefined,
    },
    search: {
      topK: (searchRaw.topK as number) ?? 5,
      timeWeight: Math.max(0, Math.min(1, (searchRaw.timeWeight as number) ?? 0.3)),
    },
  };

  // 创建 embedding provider
  let embedder: EmbeddingProvider;
  if (cfg.embedding.provider === 'openai') {
    if (!cfg.embedding.apiKey) {
      throw new Error('向量记忆使用 OpenAI embedding 时需要配置 embedding.apiKey');
    }
    embedder = new OpenAIEmbeddingProvider(cfg.embedding.baseUrl, cfg.embedding.model, cfg.embedding.apiKey);
  } else {
    embedder = new OllamaEmbeddingProvider(cfg.embedding.baseUrl, cfg.embedding.model);
  }

  // 启动时检查 embedding 服务连通性
  try {
    await embedder.embed('ping');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding 服务不可用 (${cfg.embedding.provider} @ ${cfg.embedding.baseUrl}): ${msg}`);
  }

  ctx.logger.info(`向量记忆已启动: 当前 ${store.size()} 条记录, provider=${cfg.embedding.provider}(${cfg.embedding.model})`);

  // === 索引新消息 ===

  async function indexMessage(role: 'user' | 'assistant', content: string, sessionId: string): Promise<void> {
    if (!content.trim()) return;
    try {
      const vec = await embedder.embed(content);
      store.add(vec, { role, content, sessionId, timestamp: Date.now() });
      store.save();
    } catch (err) {
      ctx.logger.warn('向量索引失败:', err);
    }
  }

  ctx.on('message:received', (msg: IncomingMessage) => {
    indexMessage('user', msg.content, msg.sessionId);
  });

  ctx.on('message:send', (msg: OutgoingMessage) => {
    indexMessage('assistant', msg.content, msg.sessionId);
  });

  // === 检索并注入上下文 ===

  ctx.middleware('llm-call:before', async (data: { messages: Message[]; tools: unknown[] }, next: MiddlewareNext) => {
    const userMessages = data.messages.filter(m => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg?.content) {
      await next();
      return;
    }

    try {
      const candidateCount = Math.min(cfg.search.topK * 3, store.size());
      if (candidateCount === 0) {
        await next();
        return;
      }

      const queryVec = await embedder.embed(lastUserMsg.content);
      const candidates = store.search(queryVec, candidateCount);

      // 时间加权重排
      const now = Date.now();
      const ranked = candidates.map(c => ({
        ...c,
        finalScore:
          (1 - cfg.search.timeWeight) * c.score +
          cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now),
      }));
      ranked.sort((a, b) => b.finalScore - a.finalScore);

      const topResults = ranked.slice(0, cfg.search.topK);

      // 过滤掉和当前会话上下文完全重复的内容
      const currentContents = new Set(data.messages.map(m => m.content));
      const relevant = topResults.filter(r => !currentContents.has(r.metadata.content as string));

      if (relevant.length > 0) {
        const contextLines = relevant.map((r, i) => {
          const date = new Date(r.metadata.timestamp as number).toLocaleString('zh-CN');
          return `[${i + 1}] (${r.metadata.role}, ${date}) ${r.metadata.content}`;
        });
        const contextBlock = `以下是从长期记忆中检索到的相关历史片段，可作为参考：\n${contextLines.join('\n')}`;

        const insertIdx = data.messages.findIndex(m => m.role !== 'system') || 1;
        data.messages.splice(insertIdx, 0, {
          role: 'system',
          content: contextBlock,
        });
      }
    } catch (err) {
      ctx.logger.warn('向量记忆检索失败:', err);
    }

    await next();
  }, 50);
}
