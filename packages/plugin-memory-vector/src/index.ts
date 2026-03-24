import type { Context, IncomingMessage, OutgoingMessage, Message, MiddlewareNext, VectorStoreService, EmbeddingService, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-vector';
export const provides = ['semanticMemory'];
export const inject = {
  required: ['vectorstore', 'embedding'],
};

export const configSchema: ConfigSchema = {
  search: {
    label: '搜索设置',
    fields: {
      topK: { type: 'number', label: '最大返回数', default: 5 },
      timeWeight: { type: 'number', label: '时间权重', default: 0.3, description: '0=纯语义，1=纯时间近因' },
    },
  },
};

export const defaultConfig = {
  search: {
    topK: 5,
    timeWeight: 0.3,
  },
};

// ===== 配置 =====

interface VectorMemoryConfig {
  search: {
    /** 返回的最大结果数 */
    topK: number;
    /** 时间衰减权重 (0-1)，0=纯语义相似度，1=纯时间近因 */
    timeWeight: number;
  };
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
    throw new Error('向量记忆插件需要 vectorstore 服务，请确保向量存储插件已加载');
  }
  const store: VectorStoreService = vectorstore;

  // 获取 embedding 服务
  const embeddingService = ctx.getService<EmbeddingService>('embedding');
  if (!embeddingService) {
    throw new Error('向量记忆插件需要 embedding 服务，请确保 embedding 插件已加载');
  }
  const embedder: EmbeddingService = embeddingService;

  const searchRaw = (config.search ?? {}) as Record<string, unknown>;

  const cfg: VectorMemoryConfig = {
    search: {
      topK: (searchRaw.topK as number) ?? 5,
      timeWeight: Math.max(0, Math.min(1, (searchRaw.timeWeight as number) ?? 0.3)),
    },
  };

  ctx.logger.info(`向量记忆已启动: 当前 ${await store.size()} 条记录`);

  // 注册为 semanticMemory 服务
  ctx.provide('semanticMemory', { name: 'vector-memory' }, {
    capabilities: ['indexing', 'semantic_search', 'context_injection'],
  });

  // === 索引新消息 ===

  async function indexMessage(role: 'user' | 'assistant', content: string, sessionId: string): Promise<void> {
    if (!content.trim()) return;
    try {
      const vec = await embedder.embed(content);
      await store.add(vec, { role, content, sessionId, timestamp: Date.now() });
      await store.save();
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
      const candidateCount = Math.min(cfg.search.topK * 3, await store.size());
      if (candidateCount === 0) {
        await next();
        return;
      }

      const queryVec = await embedder.embed(lastUserMsg.content);
      const candidates = await store.search(queryVec, candidateCount);

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
