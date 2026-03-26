import type { Context, IncomingMessage, OutgoingMessage, Message, MiddlewareNext, VectorStoreService, EmbeddingService, ConfigSchema } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-vector';
export const provides = ['semantic-memory'];
export const inject = {
  required: ['vectorstore', 'embedding'],
};

export const configSchema: ConfigSchema = {
  search: {
    label: '搜索设置',
    fields: {
      topK: { type: 'number', label: '最大返回数', default: 5, description: '语义搜索返回的最大记忆条数' },
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

  // 注册为 semantic-memory 服务
  ctx.provide('semantic-memory', { name: 'vector-memory' });

  // === 按对话轮次索引（user + assistant 一组） ===

  // 暂存最近 user 消息，等 assistant 回复后一起 embed
  const pendingUserMessages = new Map<string, { content: string; timestamp: number }>();

  async function indexTurn(sessionId: string, userContent: string, assistantContent: string, timestamp: number): Promise<void> {
    // 合并为一个对话轮次
    const turnText = `用户: ${userContent}\n助手: ${assistantContent}`;
    if (!turnText.trim()) return;
    try {
      const vec = await embedder.embed(turnText);
      await store.add(vec, {
        type: 'turn', // 标记为对话轮次
        userContent,
        assistantContent,
        content: turnText, // 完整文本用于去重
        sessionId,
        timestamp,
      });
      await store.save();
    } catch (err) {
      ctx.logger.warn('向量索引失败:', err);
    }
  }

  ctx.on('message:received', (msg: IncomingMessage) => {
    pendingUserMessages.set(msg.sessionId, {
      content: msg.content,
      timestamp: Date.now(),
    });
  });

  ctx.on('message:send', (msg: OutgoingMessage) => {
    const pending = pendingUserMessages.get(msg.sessionId);
    if (pending) {
      pendingUserMessages.delete(msg.sessionId);
      // 异步索引对话轮次
      indexTurn(msg.sessionId, pending.content, msg.content, pending.timestamp);
    }
  });

  // === 检索并注入上下文（增强去重） ===

  ctx.middleware('llm-call:before', async (data: { messages: Message[]; tools: unknown[]; sessionId?: string }, next: MiddlewareNext) => {
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

      // 增强去重：
      // 1. 完全匹配：内容与 data.messages 中已有消息完全相同
      // 2. 当前会话重叠：如果检索到的是当前 sessionId 的消息，且已被 getHistory() 覆盖
      const currentContents = new Set(data.messages.map(m => m.content).filter(Boolean));

      // 构建当前会话中用户和助手消息的子串集合，用于模糊去重
      const currentUserContents = new Set(
        data.messages.filter(m => m.role === 'user').map(m => m.content).filter(Boolean),
      );
      const currentAssistantContents = new Set(
        data.messages.filter(m => m.role === 'assistant').map(m => m.content).filter(Boolean),
      );

      const relevant = topResults.filter(r => {
        const content = r.metadata.content as string;
        // 完全匹配去重
        if (currentContents.has(content)) return false;

        // 当前 session 的对话轮次 — 检查 user/assistant 内容是否已在历史中
        if (data.sessionId && r.metadata.sessionId === data.sessionId) {
          const uContent = r.metadata.userContent as string | undefined;
          const aContent = r.metadata.assistantContent as string | undefined;
          if (uContent && currentUserContents.has(uContent) && aContent && currentAssistantContents.has(aContent)) {
            return false; // 这个轮次的两条消息都已在上下文中
          }
        }

        return true;
      });

      if (relevant.length > 0) {
        const contextLines = relevant.map((r, i) => {
          const date = new Date(r.metadata.timestamp as number).toLocaleString('zh-CN');
          const type = r.metadata.type as string;
          if (type === 'turn') {
            return `[${i + 1}] (对话, ${date}, session: ${(r.metadata.sessionId as string).slice(0, 8)})\n  ${r.metadata.content}`;
          }
          // 兼容旧格式的单条消息
          return `[${i + 1}] (${r.metadata.role}, ${date}) ${r.metadata.content}`;
        });
        const contextBlock = `以下是从长期记忆中检索到的相关历史片段，可作为参考：\n${contextLines.join('\n')}`;

        const idx = data.messages.findIndex(m => m.role !== 'system');
        const insertIdx = idx === -1 ? data.messages.length : idx;
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
