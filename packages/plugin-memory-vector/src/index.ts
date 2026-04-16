import type { Context, IncomingMessage, OutgoingMessage, Message, MiddlewareNext, ConfigSchema } from '@aalis/core';
import type { MemoryService, ConversationTurn, VectorStoreService, EmbeddingService } from '@aalis/core';
import { prefixSender } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-vector';
export const displayName = '向量记忆';
export const provides = ['semantic-memory'];
export const inject = {
  required: ['vectorstore', 'embedding'],
  optional: ['memory'],
};

export const configSchema: ConfigSchema = {
  search: {
    label: '搜索设置',
    fields: {
      topK: { type: 'number', label: '最大返回数', default: 5, description: '语义搜索返回的最大记忆条数' },
      timeWeight: { type: 'number', label: '时间权重', default: 0.3, description: '0=纯语义，1=纯时间近因' },
    },
  },
  crossSessionMode: {
    type: 'select',
    label: '跨会话检索模式',
    default: 'all',
    description: '控制向量记忆的跨会话可见范围',
    options: [
      { label: '不互通（仅当前会话）', value: 'isolated' },
      { label: '同用户增强（跨会话，同用户优先）', value: 'user' },
      { label: '同平台（仅相同平台的会话）', value: 'platform' },
      { label: '全部打通（所有平台所有会话）', value: 'all' },
    ],
  },
};

export const defaultConfig = {
  search: {
    topK: 5,
    timeWeight: 0.3,
  },
  crossSessionMode: 'all',
};

// ===== 配置 =====

type CrossSessionMode = 'isolated' | 'user' | 'platform' | 'all';

interface VectorMemoryConfig {
  search: {
    topK: number;
    timeWeight: number;
  };
  crossSessionMode: CrossSessionMode;
}

// ===== 时间衰减计算 =====

function recencyScore(timestampMs: number, nowMs: number): number {
  const daysSince = (nowMs - timestampMs) / (1000 * 60 * 60 * 24);
  return Math.exp(-0.1 * daysSince);
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  /** 动态获取 vectorstore 服务（避免静态引用导致用到错误的提供者） */
  function getStore(): VectorStoreService {
    return ctx.getService<VectorStoreService>('vectorstore')!;
  }
  /** 动态获取 embedding 服务 */
  function getEmbedder(): EmbeddingService {
    return ctx.getService<EmbeddingService>('embedding')!;
  }
  const memory = ctx.getService<MemoryService>('memory');

  const hasTurnArchive = !!memory?.saveTurn;

  const searchRaw = (config.search ?? {}) as Record<string, unknown>;
  const cfg: VectorMemoryConfig = {
    search: {
      topK: (searchRaw.topK as number) ?? 5,
      timeWeight: Math.max(0, Math.min(1, (searchRaw.timeWeight as number) ?? 0.3)),
    },
    crossSessionMode: (config.crossSessionMode as CrossSessionMode) ?? 'all',
  };

  function parsePlatform(sessionId: string): string {
    return sessionId.split(':')[0] ?? '';
  }

  ctx.logger.info(`向量记忆已启动: ${await getStore().size()} 条向量, 归档存储=${hasTurnArchive ? '可用' : '不可用（将内嵌文本）'}`);

  ctx.provide('semantic-memory', { name: 'vector-memory' });

  // === 暂存最近 user 消息，等 assistant 回复后一起索引 ===

  const pendingUserMessages = new Map<string, { content: string; timestamp: number; userId?: string; nickname?: string; platform?: string }>();

  async function indexTurn(sessionId: string, userContent: string, assistantContent: string, timestamp: number, userId?: string, platform?: string): Promise<void> {
    const turnText = `用户: ${userContent}\n助手: ${assistantContent}`;
    if (!turnText.trim()) return;
    try {
      const vec = await getEmbedder().embed(turnText);

      // 向量 metadata：只存引用 ID 和过滤所需字段
      const metadata: Record<string, unknown> = {
        sessionId,
        userId: userId ?? '',
        platform: platform ?? parsePlatform(sessionId),
        timestamp,
      };

      if (hasTurnArchive) {
        // 正确架构：原文存入归档，向量只存 turnId
        const turnId = await memory!.saveTurn!({ sessionId, userId, platform, userContent, assistantContent, timestamp });
        metadata.turnId = turnId;
      } else {
        // 降级：无归档存储时内嵌文本（兼容旧配置）
        metadata.userContent = userContent;
        metadata.assistantContent = assistantContent;
        metadata.content = turnText;
      }

      await getStore().add(vec, metadata);
      await getStore().save();
    } catch (err) {
      ctx.logger.warn('向量索引失败:', err);
    }
  }

  ctx.on('message:received', (msg: IncomingMessage) => {
    pendingUserMessages.set(msg.sessionId, {
      content: prefixSender(msg.content, msg.nickname, msg.userId),
      timestamp: Date.now(),
      userId: msg.userId,
      nickname: msg.nickname,
      platform: msg.platform,
    });
  });

  ctx.on('message:send', (msg: OutgoingMessage) => {
    const pending = pendingUserMessages.get(msg.sessionId);
    if (pending) {
      pendingUserMessages.delete(msg.sessionId);
      indexTurn(msg.sessionId, pending.content, msg.content, pending.timestamp, pending.userId, pending.platform);
    }
  });

  // === 统一记忆清除：通过 memory:clear hook 参与编排 ===

  ctx.middleware('memory:clear', async (data: {
    scope: 'session' | 'all';
    types?: string[];
    sessionId?: string;
    results: Array<{ source: string; success: boolean; message: string }>;
    rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
  }, next) => {
    // 类型过滤：如果指定了 types 且不包含 vector，跳过
    if (data.types && !data.types.includes('vector')) {
      await next();
      return;
    }

    try {
      if (data.scope === 'all') {
        pendingUserMessages.clear();
        await getStore().clear();
        await getStore().save();
        data.results.push({ source: 'vector', success: true, message: '所有向量记忆已清空' });
        ctx.logger.info('向量记忆已全部清空');
      } else if (data.sessionId) {
        pendingUserMessages.delete(data.sessionId);
        let deleted = 0;
        const currentStore = getStore();
        if (currentStore.deleteByFilter) {
          deleted = await currentStore.deleteByFilter({ sessionId: data.sessionId });
          await currentStore.save();
        } else {
          ctx.logger.warn('当前向量存储不支持按条件删除，会话级向量清空跳过');
        }
        if (hasTurnArchive) {
          await memory!.deleteTurns!(data.sessionId);
        }
        data.results.push({ source: 'vector', success: true, message: `向量记忆已清空 (${deleted} 条)` });
        ctx.logger.info(`向量记忆已清空: session=${data.sessionId}, 删除 ${deleted} 条向量`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      data.results.push({ source: 'vector', success: false, message: `向量清空失败: ${msg}` });
      ctx.logger.warn('向量清空失败:', err);
    }

    await next();
  }, 10);

  // === 检索并注入上下文 ===

  ctx.middleware('llm-call:before', async (data: { messages: Message[]; tools: unknown[]; sessionId?: string; userId?: string; platform?: string }, next: MiddlewareNext) => {
    const userMessages = data.messages.filter(m => m.role === 'user');
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (!lastUserMsg?.content) {
      await next();
      return;
    }

    try {
      const mode = cfg.crossSessionMode;
      const curSessionId = data.sessionId;
      const curPlatform = data.platform ?? (curSessionId ? parsePlatform(curSessionId) : '');
      const curUserId = data.userId ?? '';

      const candidateCount = Math.min(cfg.search.topK * 3, await getStore().size());
      if (candidateCount === 0) {
        await next();
        return;
      }

      const queryVec = await getEmbedder().embed(lastUserMsg.content);
      const candidates = await getStore().search(queryVec, candidateCount);

      // 按 crossSessionMode 过滤
      const filtered = candidates.filter(c => {
        switch (mode) {
          case 'isolated':
            return c.metadata.sessionId === curSessionId;
          case 'platform':
            return (c.metadata.platform as string) === curPlatform
              || parsePlatform(c.metadata.sessionId as string) === curPlatform;
          case 'user':
          case 'all':
          default:
            return true;
        }
      });

      // 时间加权重排
      const now = Date.now();
      const ranked = filtered.map(c => {
        let score =
          (1 - cfg.search.timeWeight) * c.score +
          cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now);

        if (mode === 'user' && curUserId && (c.metadata.userId as string) === curUserId) {
          score *= 1.2;
        }
        return { ...c, finalScore: score };
      });
      ranked.sort((a, b) => b.finalScore - a.finalScore);

      const topResults = ranked.slice(0, cfg.search.topK);

      // 解析内容：从归档中批量获取，或从 metadata 降级读取
      let turns: ConversationTurn[] = [];
      const turnIds = topResults.map(r => r.metadata.turnId as string).filter(Boolean);

      if (hasTurnArchive && turnIds.length > 0) {
        turns = await memory!.getTurns!(turnIds);
      }

      const turnMap = new Map(turns.map(t => [t.id, t]));

      // 去重：排除当前上下文中已有的内容
      const currentUserContents = new Set(
        data.messages.filter(m => m.role === 'user').map(m => m.content).filter(Boolean),
      );
      const currentAssistantContents = new Set(
        data.messages.filter(m => m.role === 'assistant').map(m => m.content).filter(Boolean),
      );

      const contextLines: string[] = [];
      let idx = 0;

      for (const r of topResults) {
        let userContent: string | undefined;
        let assistantContent: string | undefined;

        const turnId = r.metadata.turnId as string | undefined;
        if (turnId && turnMap.has(turnId)) {
          const turn = turnMap.get(turnId)!;
          userContent = turn.userContent;
          assistantContent = turn.assistantContent;
        } else if (r.metadata.userContent) {
          // 降级：从内嵌 metadata 读取
          userContent = r.metadata.userContent as string;
          assistantContent = r.metadata.assistantContent as string;
        } else {
          continue;
        }

        // 去重
        if (currentUserContents.has(userContent) && currentAssistantContents.has(assistantContent)) {
          continue;
        }

        idx++;
        const date = new Date((r.metadata.timestamp as number) ?? 0).toLocaleString('zh-CN');
        contextLines.push(`[${idx}] (${date})\n  ${userContent}\n  助手: ${assistantContent}`);
      }

      if (contextLines.length > 0) {
        const contextBlock = `以下是从长期记忆中检索到的相关历史片段，可作为参考：\n${contextLines.join('\n')}`;

        const insertAt = data.messages.findIndex(m => m.role !== 'system');
        const insertIdx = insertAt === -1 ? data.messages.length : insertAt;
        data.messages.splice(insertIdx, 0, {
          role: 'system',
          content: contextBlock,
          metadata: { source: 'memory-vector' },
        });
      }
    } catch (err) {
      ctx.logger.warn('向量记忆检索失败:', err);
    }

    await next();
  }, 50);
}
