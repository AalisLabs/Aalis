import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type {
  Context,
  Message,
  LLMService,
  MemoryService,
  ConfigSchema,
} from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-summary';
export const inject = {
  required: ['memory', 'llm'],
};

export const configSchema: ConfigSchema = {
  dbPath: {
    type: 'string',
    label: '数据库路径',
    default: 'data/aalis.db',
    description: '摘要存储的 SQLite 数据库路径',
  },
  threshold: {
    type: 'number',
    label: '摘要触发阈值',
    default: 30,
    description: '当会话历史超过此条数时，触发旧消息摘要',
  },
  keepRecent: {
    type: 'number',
    label: '保留最近消息数',
    default: 20,
    description: '摘要后保留的最近消息条数（不参与摘要的部分）',
  },
  maxSummaryTokens: {
    type: 'number',
    label: '摘要最大 Token',
    default: 1024,
    description: '注入到提示词的摘要最大 token 预算',
  },
  summaryGenerateTokens: {
    type: 'number',
    label: '摘要生成最大 Token',
    default: 800,
    description: 'LLM 生成摘要时的最大输出 token 数',
  },
  summaryPrompt: {
    type: 'string',
    label: '摘要生成提示词',
    description: '用于指导 LLM 生成摘要的系统提示词',
  },
};

export const defaultConfig = {
  dbPath: 'data/aalis.db',
  threshold: 30,
  keepRecent: 20,
  maxSummaryTokens: 1024,
  summaryGenerateTokens: 800,
  summaryPrompt: '',
};

// ===== 配置 =====

interface SummaryConfig {
  dbPath: string;
  /** 当会话消息 > threshold 时，触发摘要生成 */
  threshold: number;
  /** 摘要时保留最近 N 条消息不参与摘要 */
  keepRecent: number;
  /** 注入的摘要 token 预算上限 */
  maxSummaryTokens: number;
  /** LLM 生成摘要时的最大输出 token */
  summaryGenerateTokens: number;
  /** 自定义摘要提示词 */
  summaryPrompt: string;
}

// ===== 默认摘要生成提示词 =====

const DEFAULT_SUMMARY_PROMPT = `你是一个对话摘要助手。请将以下对话内容压缩成一段信息丰富的摘要。

要求：
1. 保留关键信息：用户的核心需求、重要决策、达成的共识
2. 保留重要的事实和数据
3. 保留对话中提到的人名、地点、时间等关键实体
4. 保留用户的偏好和习惯信息
5. 保留情感状态变化、关系动态、讨论中形成的观点
6. 忽略纯粹的寒暄和无信息量的重复内容
7. 如果有之前的摘要，在此基础上整合新内容，确保旧摘要中的重要信息不因新内容加入而被丢弃
8. 使用第三方视角描述，标注发言者身份（如"用户[小明]..."、"助手..."）
9. 按话题或时间分段组织，便于后续检索
10. 摘要长度应与原始对话信息量成正比，充分利用可用空间，不要刻意压缩`;

// ===== 摘要存储 =====

class SummaryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dbDir = resolve(dbPath, '..');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        summary TEXT NOT NULL,
        coveredUpTo INTEGER NOT NULL,
        messageCount INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_session
        ON session_summaries(sessionId);
    `);
  }

  /** 获取某个会话最新的摘要 */
  getSummary(sessionId: string): { summary: string; coveredUpTo: number; messageCount: number } | null {
    const row = this.db.prepare(`
      SELECT summary, coveredUpTo, messageCount
      FROM session_summaries
      WHERE sessionId = ?
      ORDER BY coveredUpTo DESC
      LIMIT 1
    `).get(sessionId) as { summary: string; coveredUpTo: number; messageCount: number } | undefined;

    return row ?? null;
  }

  /** 更新或插入会话摘要 */
  upsertSummary(sessionId: string, summary: string, coveredUpTo: number, messageCount: number): void {
    const existing = this.getSummary(sessionId);
    if (existing) {
      this.db.prepare(`
        UPDATE session_summaries
        SET summary = ?, coveredUpTo = ?, messageCount = ?, updatedAt = datetime('now')
        WHERE sessionId = ? AND id = (
          SELECT id FROM session_summaries WHERE sessionId = ? ORDER BY coveredUpTo DESC LIMIT 1
        )
      `).run(summary, coveredUpTo, messageCount, sessionId, sessionId);
    } else {
      this.db.prepare(`
        INSERT INTO session_summaries (sessionId, summary, coveredUpTo, messageCount)
        VALUES (?, ?, ?, ?)
      `).run(sessionId, summary, coveredUpTo, messageCount);
    }
  }

  /** 删除会话的所有摘要 */
  clearSession(sessionId: string): void {
    this.db.prepare('DELETE FROM session_summaries WHERE sessionId = ?').run(sessionId);
  }

  /** 清空所有会话的摘要 */
  clearAll(): void {
    this.db.exec('DELETE FROM session_summaries');
  }

  close(): void {
    this.db.close();
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const cfg: SummaryConfig = {
    dbPath: (config.dbPath as string) ?? 'data/aalis.db',
    threshold: (config.threshold as number) ?? 30,
    keepRecent: (config.keepRecent as number) ?? 20,
    maxSummaryTokens: (config.maxSummaryTokens as number) ?? 1024,
    summaryGenerateTokens: (config.summaryGenerateTokens as number) ?? 800,
    summaryPrompt: (config.summaryPrompt as string) ?? '',
  };

  const dbPath = resolve(ctx.config.getConfigDir(), cfg.dbPath);
  const store = new SummaryStore(dbPath);

  ctx.logger.info('会话摘要插件已启动');

  // 正在摘要中的 session，避免并发重复摘要
  const summarizing = new Set<string>();

  // 摘要生成提示词
  const summarySystemPrompt = cfg.summaryPrompt || DEFAULT_SUMMARY_PROMPT;

  /**
   * 为指定 session 生成/更新摘要
   *
   * 流程：
   * 1. 从 memory 获取完整历史
   * 2. 如果总消息数 < threshold，不需要摘要
   * 3. 取 [0, total - keepRecent) 区间的消息作为待摘要内容
   * 4. 联合已有摘要 → 调用 LLM 生成新摘要
   * 5. 存入 DB
   */
  async function generateSummary(sessionId: string): Promise<void> {
    if (summarizing.has(sessionId)) return;
    summarizing.add(sessionId);

    try {
      const memory = ctx.getService<MemoryService>('memory');
      const llm = ctx.getService<LLMService>('llm');
      if (!memory || !llm) return;

      // 获取较多的历史消息来判断是否需要摘要
      const allHistory = await memory.getHistory(sessionId, 200);
      const totalCount = allHistory.length;

      if (totalCount < cfg.threshold) return;

      // 检查是否已有摘要
      const existing = store.getSummary(sessionId);

      // 取所有待摘要的旧消息（除最近 keepRecent 条之外的）
      const messagesToSummarize = allHistory.slice(0, totalCount - cfg.keepRecent);

      if (messagesToSummarize.length === 0) return;

      // 格式化消息用于摘要
      const formattedMessages = messagesToSummarize
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => {
          const role = m.role === 'user' ? '用户' : '助手';
          return `${role}: ${m.content ?? '(空)'}`;
        })
        .join('\n');

      // 构建摘要请求
      const summaryMessages: Message[] = [
        { role: 'system', content: summarySystemPrompt },
      ];

      // 如果已有旧摘要，在提示中包含它
      if (existing?.summary) {
        summaryMessages.push({
          role: 'user',
          content: `以下是之前的对话摘要：\n${existing.summary}\n\n以下是新增的对话内容，请在之前摘要的基础上整合生成更新的摘要：\n${formattedMessages}`,
        });
      } else {
        summaryMessages.push({
          role: 'user',
          content: `请为以下对话生成摘要：\n${formattedMessages}`,
        });
      }

      ctx.logger.debug(`正在为 session=${sessionId} 生成摘要 (${messagesToSummarize.length} 条旧消息 → 摘要，保留最近 ${cfg.keepRecent} 条)`);

      // 调用 LLM 生成摘要（非流式，低 temperature）
      let summaryText = '';
      for await (const chunk of llm.chatStream({
        messages: summaryMessages,
        temperature: 0.3,
        maxTokens: cfg.summaryGenerateTokens,
      })) {
        if (chunk.contentDelta) {
          summaryText += chunk.contentDelta;
        }
      }

      if (summaryText.trim()) {
        store.upsertSummary(sessionId, summaryText.trim(), messagesToSummarize.length, totalCount);

        // 真正的压缩：从数据库删除旧消息，只保留最近 keepRecent 条
        if (memory.trimHistory) {
          const deleted = await memory.trimHistory(sessionId, cfg.keepRecent);
          ctx.logger.info(`会话已压缩: session=${sessionId}, 删除 ${deleted} 条旧消息，保留 ${cfg.keepRecent} 条`);
        } else {
          ctx.logger.warn('记忆服务不支持 trimHistory，旧消息未删除');
        }
      }
    } catch (err) {
      ctx.logger.warn('生成会话摘要失败:', err);
    } finally {
      summarizing.delete(sessionId);
    }
  }

  // === 中间件：在 LLM 调用前注入摘要 ===
  // 优先级 40（低于 vector-memory 的 50，确保摘要在向量记忆之后注入）
  ctx.middleware('llm-call:before', async (data, next) => {
    const sessionId = data.sessionId;
    if (!sessionId) {
      await next();
      return;
    }

    const existing = store.getSummary(sessionId);
    if (existing?.summary) {
      // 估算摘要 token
      const summaryTokens = Math.ceil(existing.summary.length / 3);
      let summaryContent = existing.summary;

      // 如果超出预算，截断
      if (summaryTokens > cfg.maxSummaryTokens) {
        const maxChars = cfg.maxSummaryTokens * 3;
        summaryContent = summaryContent.slice(0, maxChars) + '\n... [摘要已截断]';
      }

      const summaryMsg: Message = {
        role: 'system',
        content: `以下是之前对话的摘要，包含了较早的对话上下文：\n${summaryContent}`,
      };

      // 插入到第一个 system 消息之后、其他消息之前
      const idx = data.messages.findIndex(m => m.role !== 'system');
      const insertIdx = idx === -1 ? data.messages.length : idx;
      data.messages.splice(insertIdx, 0, summaryMsg);
    }

    await next();
  }, 40);

  // === 在 message:after 钩子触发摘要生成 ===
  // 每轮对话结束后，异步检查是否需要生成摘要
  ctx.middleware('message:after', async (data, next) => {
    await next();
    // 异步触发，不阻塞主流程
    generateSummary(data.sessionId).catch(err => {
      ctx.logger.warn('异步摘要生成失败:', err);
    });
  }, 0);

  // 监听 memory:clear-session 事件，支持由 /clear 命令触发清空摘要
  ctx.on('memory:clear-session', (data: unknown) => {
    const d = data as { sessionId?: string; type?: string };
    if (d.type === 'summary' && d.sessionId) {
      store.clearSession(d.sessionId);
      ctx.logger.info(`会话摘要已清空: session=${d.sessionId}`);
    }
  });

  ctx.on('memory:clear-all', () => {
    store.clearAll();
    ctx.logger.info('所有会话摘要已清空');
  });

  // 清理
  ctx.on('dispose', () => {
    store.close();
    ctx.logger.info('会话摘要数据库已关闭');
  });
}
