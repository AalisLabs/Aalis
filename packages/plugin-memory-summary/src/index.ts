import type { ConfigSchema, Context } from '@aalis/core';
import type { Message } from '@aalis/plugin-message-api';
import '@aalis/plugin-agent-api';
import type { LLMModel } from '@aalis/plugin-llm-api';
import { resolveLLMModel } from '@aalis/plugin-llm-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-summary';
export const displayName = '记忆摘要';
export const subsystem = 'memory';
export const inject = {
  required: ['memory', 'llm'],
  optional: ['message-archive'],
};

export const configSchema: ConfigSchema = {
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
  summaryTokenRatio: {
    type: 'number',
    label: '摘要 Token 占比',
    default: 0.05,
    description:
      '摘要占模型上下文窗口的比例 (0~1)，例如 0.05 表示 5%。 实际 token 上限 = contextLength × 比例，自动适配不同模型',
  },
  autoCompressThreshold: {
    type: 'number',
    label: 'Token 预压缩阈值',
    default: 0.7,
    description:
      '监听 agent 发出的 token:usage 事件，当使用率超过此比例 (0~1) 时启动后台压缩。默认 0.7 实现“临界前预压缩”，让本轮调用仍然能用原始上下文完成，压缩后的成果下一轮生效。设为 0 则禁用 token 触发。',
  },
  summaryPrompt: {
    type: 'string',
    label: '摘要生成提示词',
    description: '用于指导 LLM 生成摘要的系统提示词',
  },
  summaryModelMode: {
    type: 'select',
    label: '摘要模型来源',
    default: 'global',
    options: [
      { label: '沿用全局默认 LLM', value: 'global' },
      { label: '自定义 provider/model', value: 'custom' },
    ],
    description:
      'global=沿用全局默认 LLM；custom=使用下方 summaryLLM 指定的模型。session（沿用会话当轮模型）暂未实现。',
  },
  summaryLLM: {
    type: 'llm-ref',
    label: '摘要模型',
    description: '仅当 summaryModelMode=custom 时生效；provider 为 LLM 插件实例 contextId，model 为实例内某个模型名。',
  },
};

export const defaultConfig = {
  threshold: 30,
  keepRecent: 20,
  summaryTokenRatio: 0.05,
  autoCompressThreshold: 0.7,
  summaryPrompt: '',
  summaryModelMode: 'global',
};

// ===== 配置 =====

interface SummaryConfig {
  /** 当会话消息 > threshold 时，触发摘要生成 */
  threshold: number;
  /** 摘要时保留最近 N 条消息不参与摘要 */
  keepRecent: number;
  /** 摘要占模型上下文窗口的比例 (0~1) */
  summaryTokenRatio: number;
  /** Token 使用率超过此比例时启动后台压缩 (0~1)，0 表示禁用 */
  autoCompressThreshold: number;
  /** 自定义摘要提示词 */
  summaryPrompt: string;
  /** 摘要模型来源：global=全局默认 LLM；custom=指定 provider+model */
  summaryModelMode: 'global' | 'custom';
  /** custom 模式下的 LLM ref */
  summaryLLM?: { provider: string; model: string };
}

// ===== 默认摘要生成提示词 =====

const DEFAULT_SUMMARY_PROMPT = `你是一个对话摘要助手。请将以下对话内容压缩成一段信息丰富的摘要。

要求：
1. 保留关键信息：用户的核心需求、重要决策、达成的共识
2. 保留重要的事实和数据
3. 保留对话中提到的人名、地点、时间等关键实体
4. 保留用户的偏好和习惯信息
5. 保留情感状态变化、关系动态、讨论中形成的观点
6. **特别重要**：保留每个发言者的昵称与ID的对应关系。消息中 [昵称(ID)] 格式标注了发言者身份，摘要中必须保留这种对应关系（如"小明(123456)"），以便后续能通过ID或昵称识别同一个人
6. 忽略纯粹的寒暄和无信息量的重复内容
7. 如果有之前的摘要，在此基础上整合新内容，确保旧摘要中的重要信息不因新内容加入而被丢弃
8. 使用第三方视角描述，标注发言者身份（如"用户[小明]..."、"助手..."）
9. 按话题或时间分段组织，便于后续检索
10. **特别重要**：如果对话中存在正在进行的多步骤任务或计划（如任务列表、待办事项、分步实施方案），必须完整保留任务的目标、已完成的步骤、尚未完成的步骤及其状态。在摘要末尾用独立段落列出，格式如：
    【进行中的任务】
    - 目标：...
    - 已完成：...
    - 待完成：...
11. 保留助手在对话中制定的工作计划、承诺要做的事情、以及用户尚未被满足的请求`;

// ===== 摘要存储 =====
//
// 通过 MemoryService 的 metadata API 持久化摘要，让摘要与对话历史共享同一存储后端
// （sqlite/mongodb/inmemory）。namespace 固定为 'summary'，key 为 sessionId。
// metadata payload 形如 { summary, coveredUpTo, messageCount, updatedAt }。

const SUMMARY_NAMESPACE = 'summary';

interface SummaryRecord {
  summary: string;
  coveredUpTo: number;
  messageCount: number;
}

class SummaryStore {
  constructor(private readonly ctx: Context) {
    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.saveMetadata || !memory?.getMetadata) {
      throw new Error('[memory-summary] 当前 memory 实现缺少 metadata 能力（saveMetadata/getMetadata），无法存储摘要');
    }
  }

  /** 每次惰性查询 memory provider，避免 apply 时缓存裸引用在 provider 重载后失效。 */
  private get memory(): MemoryService {
    const m = this.ctx.getService<MemoryService>('memory');
    if (!m) throw new Error('[memory-summary] memory 服务不可用');
    return m;
  }

  async getSummary(sessionId: string): Promise<SummaryRecord | null> {
    const data = await this.memory.getMetadata!(SUMMARY_NAMESPACE, sessionId);
    if (!data) return null;
    return {
      summary: String(data.summary ?? ''),
      coveredUpTo: Number(data.coveredUpTo ?? 0),
      messageCount: Number(data.messageCount ?? 0),
    };
  }

  async upsertSummary(sessionId: string, summary: string, coveredUpTo: number, messageCount: number): Promise<void> {
    await this.memory.saveMetadata!(SUMMARY_NAMESPACE, sessionId, {
      summary,
      coveredUpTo,
      messageCount,
      updatedAt: new Date().toISOString(),
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    if (this.memory.deleteMetadata) {
      await this.memory.deleteMetadata(SUMMARY_NAMESPACE, sessionId);
    }
  }

  async clearAll(): Promise<void> {
    if (!this.memory.listMetadata || !this.memory.deleteMetadata) return;
    const items = await this.memory.listMetadata(SUMMARY_NAMESPACE);
    for (const item of items) {
      await this.memory.deleteMetadata(SUMMARY_NAMESPACE, item.key);
    }
  }
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  const cfg: SummaryConfig = {
    threshold: (config.threshold as number) ?? 30,
    keepRecent: (config.keepRecent as number) ?? 20,
    summaryTokenRatio: (config.summaryTokenRatio as number) ?? 0.05,
    autoCompressThreshold: (config.autoCompressThreshold as number) ?? 0.7,
    summaryPrompt: (config.summaryPrompt as string) ?? '',
    summaryModelMode: (config.summaryModelMode as string) === 'custom' ? 'custom' : 'global',
    summaryLLM:
      config.summaryLLM &&
      typeof config.summaryLLM === 'object' &&
      (config.summaryLLM as { provider?: unknown }).provider &&
      (config.summaryLLM as { model?: unknown }).model
        ? (config.summaryLLM as { provider: string; model: string })
        : undefined,
  };

  const memory = ctx.getService<MemoryService>('memory');
  if (!memory) {
    ctx.logger.warn('memory 服务不可用，摘要插件将不会启动');
    return;
  }
  const store = new SummaryStore(ctx);

  ctx.logger.info('会话摘要插件已启动（摘要持久化经由 memory.metadata）');

  // 正在摘要中的 session，避免并发重复摘要
  const summarizing = new Set<string>();

  /**
   * 根据 summaryModelMode 解析出用于生成摘要的 LLMModel entry。
   * - global：按默认优先级/preference 选首个 chat-capable entry
   * - custom：按 cfg.summaryLLM 精确匹配
   */
  function resolveSummaryModel(): LLMModel | undefined {
    const ref = cfg.summaryModelMode === 'custom' ? cfg.summaryLLM : undefined;
    return resolveLLMModel(ctx, ref, ['chat'])?.instance;
  }

  /**
   * 根据实际使用的 LLMModel 计算摘要 token 上限。
   * service-granularity 后每个 entry 直接拥有 contextLength，无需再反查 router。
   */
  function getSummaryTokenBudget(): number {
    const model = resolveSummaryModel();
    const contextLength = model?.contextLength ?? 4096;
    return Math.max(512, Math.floor(contextLength * cfg.summaryTokenRatio));
  }

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
      const summaryModel = resolveSummaryModel();
      if (!memory || !summaryModel) return;

      // 获取较多的历史消息来判断是否需要摘要
      const allHistory = await memory.getHistory(sessionId, 200);
      const totalCount = allHistory.length;

      if (totalCount < cfg.threshold) return;

      // 检查是否已有摘要
      const existing = await store.getSummary(sessionId);

      // 取所有待摘要的旧消息（除最近 keepRecent 条之外的）
      const messagesToSummarize = allHistory.slice(0, totalCount - cfg.keepRecent);

      if (messagesToSummarize.length === 0) return;

      // 格式化消息用于摘要
      const formattedMessages = messagesToSummarize
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => {
          // user content 中已含 [昵称(ID)] 前缀，无需再加 name
          const role = m.role === 'user' ? '用户' : '助手';
          return `${role}: ${m.content ?? '(空)'}`;
        })
        .join('\n');

      // 构建摘要请求
      const summaryBudget = getSummaryTokenBudget();
      const budgetHint = `\n\n重要：你的摘要输出上限为 ${summaryBudget} tokens（约 ${summaryBudget * 4} 个英文字符，或约 ${Math.floor(summaryBudget / 1.5)} 个中文字符）。请合理分配篇幅，确保“【进行中的任务】”等关键结构能完整输出。`;
      const summaryMessages: Message[] = [{ role: 'system', content: summarySystemPrompt + budgetHint }];

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

      ctx.logger.debug(
        `正在为 session=${sessionId} 生成摘要 (${messagesToSummarize.length} 条旧消息 → 摘要，保留最近 ${cfg.keepRecent} 条)`,
      );

      // 调用 LLM 生成摘要
      let summaryText = '';
      const stream = summaryModel.chatStream?.({
        messages: summaryMessages,
        temperature: 0.3,
        maxTokens: summaryBudget,
      });
      if (!stream) {
        const resp = await summaryModel.chat({
          messages: summaryMessages,
          temperature: 0.3,
          maxTokens: summaryBudget,
        });
        summaryText = resp.content ?? '';
      } else {
        for await (const chunk of stream) {
          if (chunk.contentDelta) {
            summaryText += chunk.contentDelta;
          }
        }
      }

      if (summaryText.trim()) {
        const finalSummary = summaryText.trim();
        const summaryTs = Date.now();
        await store.upsertSummary(sessionId, finalSummary, messagesToSummarize.length, totalCount);

        // 真正的压缩：将旧消息标记为 archived，只保留最近 keepRecent 条作为热上下文
        // 安全调整：避免裁剪点落在 tool call 组中间（assistant(toolCalls) 被删但 tool 响应被保留）
        let safeKeepRecent = cfg.keepRecent;
        while (safeKeepRecent < allHistory.length) {
          const firstKeptMsg = allHistory[allHistory.length - safeKeepRecent];
          if (firstKeptMsg.role === 'tool') {
            safeKeepRecent++;
          } else {
            break;
          }
        }
        if (memory.trimHistory) {
          const deleted = await memory.trimHistory(sessionId, safeKeepRecent);
          ctx.logger.info(`会话已压缩: session=${sessionId}, 归档 ${deleted} 条旧消息，保留 ${safeKeepRecent} 条`);
        } else {
          ctx.logger.warn('记忆服务不支持 trimHistory，旧消息未归档');
        }

        // 保存系统事件消息，供前端持久化显示压缩分隔线
        const archive = ctx.getService<MessageArchiveService>('message-archive');
        if (archive)
          await archive.saveMessage(sessionId, {
            role: 'system',
            content: '对话已压缩',
            name: 'system-event',
            timestamp: summaryTs,
          });
      }
    } catch (err) {
      ctx.logger.warn('生成会话摘要失败:', err);
    } finally {
      summarizing.delete(sessionId);
    }
  }

  // === 中间件：在 LLM 调用前注入摘要 ===
  // 优先级 40（低于 vector-memory 的 50，确保摘要在向量记忆之后注入）
  ctx.middleware('agent:llm:before', async (data, next) => {
    const sessionId = data.sessionId;
    if (!sessionId) {
      await next();
      return;
    }

    const existing = await store.getSummary(sessionId);
    if (existing?.summary) {
      if (data.messages.some(m => m.role === 'system' && m.metadata?.source === 'memory-summary')) {
        await next();
        return;
      }

      // 动态计算摘要 token 预算
      const summaryBudget = getSummaryTokenBudget();
      const summaryTokens = Math.ceil(existing.summary.length / 3);
      let summaryContent = existing.summary;

      // 如果超出预算，截断
      if (summaryTokens > summaryBudget) {
        const maxChars = summaryBudget * 3;
        summaryContent = `${summaryContent.slice(0, maxChars)}\n... [摘要已截断]`;
      }

      const summaryMsg: Message = {
        role: 'system',
        content: `以下是之前对话的摘要，包含了较早的对话上下文：\n${summaryContent}`,
        metadata: { source: 'memory-summary' },
      };

      // 插入到第一个 system 消息之后、其他消息之前
      const idx = data.messages.findIndex(m => m.role !== 'system');
      const insertIdx = idx === -1 ? data.messages.length : idx;
      data.messages.splice(insertIdx, 0, summaryMsg);
    }

    await next();
  });

  // === 在 agent:turn:after 钩子触发摘要生成 ===
  // 每轮对话结束后，异步检查是否需要生成摘要
  ctx.middleware('agent:turn:after', async (data, next) => {
    await next();
    // 异步触发，不阻塞主流程
    generateSummary(data.sessionId).catch(err => {
      ctx.logger.warn('异步摘要生成失败:', err);
    });
  });

  // === 监听 token:usage 事件，预压缩触发 ===
  // agent 在每次 LLM 调用前发出 token 使用统计；
  // 当使用率超过 autoCompressThreshold（默认 0.7）时，转发为 session:compress(reason='auto') 启动后台压缩。
  // 注意：generateSummary/session:compress 内部已有 summarizing 锁，这里再做一次提前判断避免无谓 emit。
  ctx.on('token:usage', async (...args: unknown[]) => {
    const data = args[0] as { sessionId: string; usageRatio: number };
    if (!data?.sessionId) return;
    if (cfg.autoCompressThreshold <= 0) return;
    if (data.usageRatio < cfg.autoCompressThreshold) return;
    if (summarizing.has(data.sessionId)) return;
    ctx.logger.info(
      `Token 使用率 ${(data.usageRatio * 100).toFixed(1)}% 超过阈值 ${(cfg.autoCompressThreshold * 100).toFixed(0)}%，触发后台压缩`,
    );
    ctx
      .emit('session:compress', { sessionId: data.sessionId, reason: 'auto', usageRatio: data.usageRatio })
      .catch(() => {});
  });

  // === 监听手动/自动压缩事件 ===
  ctx.on('session:compress', async (...args: unknown[]) => {
    const data = args[0] as { sessionId: string; reason?: string; usageRatio?: number };
    ctx.logger.info(`收到压缩请求: session=${data.sessionId}, reason=${data.reason ?? 'unknown'}`);

    // 手动压缩时降低阈值要求：即使消息数不到 threshold 也强制执行
    if (data.reason === 'manual' || data.reason === 'auto') {
      if (summarizing.has(data.sessionId)) return;
      summarizing.add(data.sessionId);

      // 通知前端：压缩开始
      ctx.emit('session:compressing', { sessionId: data.sessionId, status: 'start' }).catch(() => {});

      try {
        const memory = ctx.getService<MemoryService>('memory');
        const summaryModel = resolveSummaryModel();
        if (!memory || !summaryModel) {
          ctx.emit('session:compressing', { sessionId: data.sessionId, status: 'done' }).catch(() => {});
          return;
        }

        const allHistory = await memory.getHistory(data.sessionId, 200);
        // 手动压缩：只要有 > keepRecent 条消息就压缩
        if (allHistory.length <= cfg.keepRecent) {
          ctx.logger.info(`会话消息数 ${allHistory.length} \u2264 keepRecent(${cfg.keepRecent})，无需压缩`);
          ctx.emit('session:compressing', { sessionId: data.sessionId, status: 'done' }).catch(() => {});
          return;
        }

        const messagesToSummarize = allHistory.slice(0, allHistory.length - cfg.keepRecent);
        if (messagesToSummarize.length === 0) {
          ctx.emit('session:compressing', { sessionId: data.sessionId, status: 'done' }).catch(() => {});
          return;
        }

        const existing = await store.getSummary(data.sessionId);
        const formattedMessages = messagesToSummarize
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => `${m.role === 'user' ? (m.name ? `用户[${m.name}]` : '用户') : '助手'}: ${m.content ?? '(空)'}`)
          .join('\\n');

        // 从历史消息中提取最近的 todo-list 状态，注入到压缩上下文中
        let todoContext = '';
        try {
          const recentMessages = allHistory.slice(-cfg.keepRecent);
          const todoMsgs = recentMessages.filter(
            m =>
              m.role === 'assistant' &&
              m.toolCalls?.some(tc => tc.function.name === 'manage_todo_list' || tc.function.name === 'todo_manage'),
          );
          if (todoMsgs.length > 0) {
            const lastTodo = todoMsgs[todoMsgs.length - 1];
            const tc = lastTodo.toolCalls?.find(
              tc => tc.function.name === 'manage_todo_list' || tc.function.name === 'todo_manage',
            );
            if (tc?.function.arguments) {
              todoContext = `\\n\\n当前任务列表状态：\\n${tc.function.arguments}`;
            }
          }
        } catch {
          /* ignore */
        }

        const summaryBudget = getSummaryTokenBudget();
        const budgetHint = `\n\n重要：你的摘要输出上限为 ${summaryBudget} tokens（约 ${summaryBudget * 4} 个英文字符，或约 ${Math.floor(summaryBudget / 1.5)} 个中文字符）。请合理分配篇幅，确保“【进行中的任务】”等关键结构能完整输出。`;
        const summaryMessages: Message[] = [{ role: 'system', content: summarySystemPrompt + budgetHint }];

        const taskHint =
          data.reason === 'auto'
            ? '\\n\\n注意：此次压缩是在任务执行过程中自动触发的，助手可能正在进行多步骤工作。请特别注意保留所有未完成的任务状态和下一步计划。'
            : '';

        if (existing?.summary) {
          summaryMessages.push({
            role: 'user',
            content: `以下是之前的对话摘要：\\n${existing.summary}\\n\\n以下是新增的对话内容，请在之前摘要的基础上整合生成更新的摘要：\\n${formattedMessages}${todoContext}${taskHint}`,
          });
        } else {
          summaryMessages.push({
            role: 'user',
            content: `请为以下对话生成摘要：\\n${formattedMessages}${todoContext}${taskHint}`,
          });
        }

        ctx.logger.debug(`正在压缩 session=${data.sessionId} (${messagesToSummarize.length} 条旧消息)`);

        let summaryText = '';
        const stream2 = summaryModel.chatStream?.({
          messages: summaryMessages,
          temperature: 0.3,
          maxTokens: summaryBudget,
        });
        if (!stream2) {
          const resp = await summaryModel.chat({
            messages: summaryMessages,
            temperature: 0.3,
            maxTokens: summaryBudget,
          });
          summaryText = resp.content ?? '';
        } else {
          for await (const chunk of stream2) {
            if (chunk.contentDelta) {
              summaryText += chunk.contentDelta;
            }
          }
        }

        if (summaryText.trim()) {
          const finalSummary = summaryText.trim();
          const summaryTs = Date.now();
          await store.upsertSummary(data.sessionId, finalSummary, messagesToSummarize.length, allHistory.length);

          // 安全调整：避免裁剪点落在 tool call 组中间
          let safeKeepRecent = cfg.keepRecent;
          while (safeKeepRecent < allHistory.length) {
            const firstKeptMsg = allHistory[allHistory.length - safeKeepRecent];
            if (firstKeptMsg.role === 'tool') {
              safeKeepRecent++;
            } else {
              break;
            }
          }
          if (memory.trimHistory) {
            const deleted = await memory.trimHistory(data.sessionId, safeKeepRecent);
            ctx.logger.info(`压缩完成: session=${data.sessionId}, 归档 ${deleted} 条旧消息，保留 ${safeKeepRecent} 条`);
          }

          // 保存系统事件消息，供前端持久化显示压缩分隔线
          const archive = ctx.getService<MessageArchiveService>('message-archive');
          if (archive)
            await archive.saveMessage(data.sessionId, {
              role: 'system',
              content: '对话已压缩',
              name: 'system-event',
              timestamp: summaryTs,
            });

          // 通知前端：压缩完成
          ctx.emit('session:compressing', { sessionId: data.sessionId, status: 'done' }).catch(() => {});
        }
      } catch (err) {
        ctx.logger.warn('压缩会话失败:', err);
        // 通知前端：压缩失败
        ctx.emit('session:compressing', { sessionId: data.sessionId, status: 'error' }).catch(() => {});
      } finally {
        summarizing.delete(data.sessionId);
      }
    } else {
      // 其他情况走标准流程
      await generateSummary(data.sessionId);
    }
  });

  // 统一记忆清除：通过 memory:clear hook 参与编排
  ctx.middleware(
    'memory:clear',
    async (
      data: {
        scope: 'session' | 'all';
        types?: string[];
        sessionId?: string;
        results: Array<{ source: string; success: boolean; message: string }>;
        rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
      },
      next,
    ) => {
      // 类型过滤：如果指定了 types 且不包含 summary，跳过
      if (data.types && !data.types.includes('summary')) {
        await next();
        return;
      }

      try {
        if (data.scope === 'all') {
          await store.clearAll();
          data.results.push({ source: 'summary', success: true, message: '所有会话摘要已清空' });
          ctx.logger.info('所有会话摘要已清空');
        } else if (data.sessionId) {
          await store.clearSession(data.sessionId);
          data.results.push({ source: 'summary', success: true, message: '当前会话摘要已清空' });
          ctx.logger.info(`会话摘要已清空: session=${data.sessionId}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        data.results.push({ source: 'summary', success: false, message: `摘要清空失败: ${msg}` });
        ctx.logger.warn('摘要清空失败:', err);
      }

      await next();
    },
  );

  // 清理
  ctx.onDispose(() => {
    ctx.logger.info('会话摘要插件已卸载');
  });
}
