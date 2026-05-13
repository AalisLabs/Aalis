import type { ConfigSchema, Context, MiddlewareNext } from '@aalis/core';

import type { EmbeddingService } from '@aalis/plugin-embedding-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';
import { prefixSender } from '@aalis/plugin-message-api';
import type { VectorStoreService } from '@aalis/plugin-vectorstore-api';
import '@aalis/plugin-agent-api';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-vector';
export const displayName = '向量记忆';
export const subsystem = 'memory';
export const provides = ['semantic-memory'];
export const inject = {
  required: ['vectorstore', 'embedding'],
  optional: ['memory'],
};

export const configSchema: ConfigSchema = {
  search: {
    label: '搜索设置',
    fields: {
      topK: {
        type: 'number',
        label: '最大返回数',
        default: 5,
        description: '语义搜索返回的命中条数（每条会再带上下文窗口）',
      },
      timeWeight: {
        type: 'number',
        label: '时间权重',
        default: 0.3,
        description: '0=纯语义，1=纯时间近因',
      },
      userPriorityBoost: {
        type: 'number',
        label: '同用户加权系数',
        default: 2.0,
        description: '在 user 模式下对同一用户消息的命中分数乘以该系数（>1 表示优先）',
      },
      perItemMaxChars: {
        type: 'number',
        label: '单条截断字数',
        default: 200,
        description: '每条消息呈现给 LLM 时的字符上限，超出截断',
      },
      minScore: {
        type: 'number',
        label: '最低相似度阈值',
        default: 0,
        description: '0~1，命中分数（时间加权前的语义分）低于该值则丢弃。0 表示不过滤',
      },
    },
  },
  contextExpand: {
    label: '上下文情景扩展',
    description: '命中后自动取该消息在原会话中的前后 N 条相邻消息（含 user/assistant/system/tool）还原情景。0 = 关闭。',
    fields: {
      window: {
        type: 'number',
        label: '扩展窗口（前后各 N 条消息）',
        default: 2,
        description: '0 = 仅命中本身。建议 2~5。负数会报错',
      },
      crossSession: {
        type: 'boolean',
        label: '跨会话也扩展',
        default: true,
        description: '若命中消息来自其他会话（user/all 模式可能发生），是否对那个会话也取上下文',
      },
    },
  },
  indexing: {
    label: '索引设置',
    description: '控制后台向量索引的削峰与并发。搜索路径不受该队列影响。',
    fields: {
      concurrency: {
        type: 'number',
        label: '最大并发索引数',
        default: 10,
        description:
          '同时进行的后台 embedding + 向量写入任务数。0 或负数表示不限制；建议 2~10，过高可能压垮本地 embedding 服务。',
      },
      maxQueueSize: {
        type: 'number',
        label: '最大索引队列长度',
        default: 500,
        description: '待索引消息队列上限。0 或负数表示不限制；超出后丢弃最旧待索引消息，避免内存无限增长。',
      },
    },
  },
  crossSessionMode: {
    type: 'select',
    label: '跨会话检索模式',
    default: 'all',
    description: '控制向量记忆的跨会话可见范围',
    options: [
      { label: '不互通（仅当前会话）', value: 'isolated' },
      { label: '同用户增强（跨会话，同用户加权）', value: 'user' },
      { label: '同平台（仅相同平台的会话）', value: 'platform' },
      { label: '全部打通（所有平台所有会话）', value: 'all' },
    ],
  },
};

export const defaultConfig = {
  search: {
    topK: 5,
    timeWeight: 0.3,
    userPriorityBoost: 2.0,
    perItemMaxChars: 200,
    minScore: 0,
  },
  contextExpand: {
    window: 2,
    crossSession: true,
  },
  indexing: {
    concurrency: 10,
    maxQueueSize: 500,
  },
  crossSessionMode: 'all',
};

// ===== 配置 =====

type CrossSessionMode = 'isolated' | 'user' | 'platform' | 'all';

interface VectorMemoryConfig {
  search: {
    topK: number;
    timeWeight: number;
    userPriorityBoost: number;
    perItemMaxChars: number;
    minScore: number;
  };
  contextExpand: {
    window: number;
    crossSession: boolean;
  };
  indexing: {
    concurrency: number;
    maxQueueSize: number;
  };
  crossSessionMode: CrossSessionMode;
}

// ===== 工具 =====

function recencyScore(timestampMs: number, nowMs: number): number {
  const daysSince = (nowMs - timestampMs) / (1000 * 60 * 60 * 24);
  return Math.exp(-0.1 * daysSince);
}

function truncate(text: string | undefined | null, max: number): string {
  const s = text ?? '';
  if (max <= 0 || s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function parsePlatform(sessionId: string): string {
  return sessionId.split(':')[0] ?? '';
}

/** 从消息文本中抽取 @提及的用户 ID（各 adapter 输出统一 <at id="X"> 标签） */
function extractMentions(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  const re = /<at(?:\s+self)?\s+id="([^"]+)">/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const id = m[1];
    if (id && id !== 'all') ids.add(id);
    m = re.exec(text);
  }
  return [...ids];
}

/** 人可读的平台名（cli 不叠加避免噪音） */
function platformLabel(platform: string | undefined): string {
  if (!platform || platform === 'cli') return '';
  return platform;
}

/** 剖掉 agent 在某条消息开头注入的临时时间标签（如 "(刚刚) " / "(3 分钟前) "）。
 * 只剖首个括号对，保留后续内容（包括 [发送者] 前缀）。
 */
function stripTimeLabel(content: string): string {
  if (!content) return content;
  return content.replace(/^\([^)]{1,16}\)\s+/, '');
}

/** 渲染一条消息为可读文本（含来源标签） */
function renderMessage(m: Message, max: number): string {
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  const ts = m.timestamp ?? 0;
  const date = new Date(ts).toLocaleString('zh-CN');

  const userId = (meta.userId as string | undefined) ?? m.name ?? '';
  const nickname = meta.nickname as string | undefined;
  const groupName = meta.groupName as string | undefined;
  const platform = platformLabel(meta.platform as string | undefined);
  const sessionType = meta.sessionType as string | undefined;

  // 位置描述：优先群名、其次会话类型
  let where = '';
  if (groupName) {
    where = `群「${groupName}」/`;
  } else if (sessionType === 'private') {
    where = '私聊/';
  } else if (sessionType === 'channel') {
    where = '频道/';
  }
  // 平台前缀
  const platformPrefix = platform ? `${platform}/` : '';

  const who = nickname ? `${nickname}${userId ? `(${userId})` : ''}` : userId;
  const tag = `[${platformPrefix}${where}${who}${who ? ' ' : ''}@ ${date}]`;

  // 渲染时剥掉历史消息内已有的 sender 前缀（archive 入库时加的 [Alice(123)]: ...）
  // 来源标签 tag 已表达完整身份，避免双重前缀
  const cleanContent = (m.content ?? '').replace(/^\[[^\]]{1,80}\]:\s+/, '');

  return `${tag} ${truncate(cleanContent, max)}`;
}

/** 渲染向量命中（均为 user 消息）。 */
function renderMemoryEntry(m: Message, messageMax: number): string {
  return renderMessage(m, messageMax);
}

/** 给消息生成稳定 key 用于跨命中去重（sessionId + timestamp + role + content hash） */
function messageKey(sessionId: string, m: Message): string {
  return `${sessionId}|${m.timestamp ?? 0}|${m.role}|${(m.content ?? '').slice(0, 64)}`;
}

// ===== 插件入口 =====

export async function apply(ctx: Context, config: Record<string, unknown>): Promise<void> {
  function getStore(): VectorStoreService {
    return ctx.getService<VectorStoreService>('vectorstore')!;
  }
  function getEmbedder(): EmbeddingService {
    return ctx.getService<EmbeddingService>('embedding')!;
  }
  const memory = ctx.getService<MemoryService>('memory');

  const hasRangeQuery = !!memory?.getMessagesBySessionRange;

  const searchRaw = (config.search ?? {}) as Record<string, unknown>;
  const expandRaw = (config.contextExpand ?? {}) as Record<string, unknown>;
  const indexingRaw = (config.indexing ?? {}) as Record<string, unknown>;

  // 配置校验
  const windowRaw = expandRaw.window;
  const windowNum = typeof windowRaw === 'number' ? windowRaw : Number(windowRaw ?? 2);
  if (Number.isNaN(windowNum) || !Number.isFinite(windowNum)) {
    throw new Error(
      'memory-vector 配置错误: contextExpand.window 必须为非负整数（0 表示仅命中本身，N>0 表示前后各 N 条）',
    );
  }
  if (windowNum < 0) {
    throw new Error(`memory-vector 配置错误: contextExpand.window=${windowNum} 不能为负数`);
  }
  if (!Number.isInteger(windowNum)) {
    throw new Error(`memory-vector 配置错误: contextExpand.window=${windowNum} 必须是整数`);
  }

  const cfg: VectorMemoryConfig = {
    search: {
      topK: (searchRaw.topK as number) ?? 5,
      timeWeight: Math.max(0, Math.min(1, (searchRaw.timeWeight as number) ?? 0.3)),
      userPriorityBoost: Math.max(1, (searchRaw.userPriorityBoost as number) ?? 2.0),
      perItemMaxChars: Math.max(20, (searchRaw.perItemMaxChars as number) ?? 200),
      minScore: Math.max(0, Math.min(1, (searchRaw.minScore as number) ?? 0)),
    },
    contextExpand: {
      window: Math.floor(windowNum),
      crossSession: expandRaw.crossSession !== false,
    },
    indexing: {
      concurrency: Math.floor((indexingRaw.concurrency as number) ?? 10),
      maxQueueSize: Math.floor((indexingRaw.maxQueueSize as number) ?? 500),
    },
    crossSessionMode: (config.crossSessionMode as CrossSessionMode) ?? 'all',
  };

  ctx.logger.info(
    `向量记忆已启动: ${await getStore().size()} 条向量, 范围查询=${hasRangeQuery ? '可用' : '不可用'}, ` +
      `userBoost=${cfg.search.userPriorityBoost}, expandWindow=${cfg.contextExpand.window}, ` +
      `单条截断=${cfg.search.perItemMaxChars}字, minScore=${cfg.search.minScore}, ` +
      `indexConcurrency=${cfg.indexing.concurrency <= 0 ? 'unlimited' : cfg.indexing.concurrency}, ` +
      `indexQueue=${cfg.indexing.maxQueueSize <= 0 ? 'unlimited' : cfg.indexing.maxQueueSize}`,
  );

  if (!hasRangeQuery && cfg.contextExpand.window > 0) {
    ctx.logger.warn('当前 memory 后端不支持范围查询，contextExpand 将退化为仅命中本身');
  }

  ctx.provide('semantic-memory', { name: 'vector-memory' });

  // === 索引：仅对 user 消息建索引，触发即写（不依赖 assistant 是否回复） ===

  /** 待索引项：保留消息及其在 memory 中的时间戳，使向量与消息时间戳对齐，便于精确删除 */
  const pendingIndexMessages: Array<{ msg: IncomingMessage; timestamp: number }> = [];
  let activeIndexers = 0;

  function enqueueIndexMessage(item: { msg: IncomingMessage; timestamp: number }): void {
    pendingIndexMessages.push(item);
    if (cfg.indexing.maxQueueSize > 0 && pendingIndexMessages.length > cfg.indexing.maxQueueSize) {
      const dropped = pendingIndexMessages.splice(0, pendingIndexMessages.length - cfg.indexing.maxQueueSize).length;
      ctx.logger.warn(`向量索引队列过长，已丢弃 ${dropped} 条最旧待索引消息`);
    }
    void drainIndexQueue();
  }

  async function drainIndexQueue(): Promise<void> {
    while (
      (cfg.indexing.concurrency <= 0 || activeIndexers < cfg.indexing.concurrency) &&
      pendingIndexMessages.length > 0
    ) {
      const next = pendingIndexMessages.shift()!;
      activeIndexers++;
      void (async () => {
        try {
          await indexUserMessage(next.msg, next.timestamp);
        } finally {
          activeIndexers--;
          void drainIndexQueue();
        }
      })();
    }
  }

  async function indexUserMessage(msg: IncomingMessage, messageTimestamp: number): Promise<void> {
    // 跳过非真实用户输入：闲聊主动触发等系统级伪 incoming，不应进入向量库
    if (msg.source === 'idle-trigger') return;
    const rawText = msg.content?.trim();
    if (!rawText) return;
    try {
      // 方案 C：与 archive 入库格式一致、与检索侧对称。
      // embed 带发送者前缀的文本，使身份信号进入向量空间；不加临时时间标签。
      const embedText = prefixSender(rawText, msg.nickname, msg.userId);
      const vec = await getEmbedder().embed(embedText);
      const mentions = extractMentions(rawText);
      const metadata: Record<string, unknown> = {
        sessionId: msg.sessionId,
        userId: msg.userId ?? '',
        nickname: msg.nickname ?? '',
        platform: msg.platform ?? parsePlatform(msg.sessionId),
        groupName: msg.groupName ?? '',
        groupId: msg.groupId ?? '',
        sessionType: msg.sessionType ?? '',
        timestamp: messageTimestamp,
        // 兜底内容：存原始纯净文本（供渲染兜底使用，不含发送者前缀）
        content: rawText,
        // @提及到的用户 ID 列表，用于检索时同用户加权
        mentions,
      };
      await getStore().add(vec, metadata);
      await getStore().save();
    } catch (err) {
      ctx.logger.warn(`向量索引失败: ${formatError(err)}`);
    }
  }

  // 与 plugin-user-profile 等「派生持久数据」插件统一锚点：仅对已成功落库的入站消息建索引，
  // 避免归档失败的消息进入向量库，也消除归档前/后两套订阅时机的不一致。
  ctx.on('inbound:message:archived', data => {
    // 使用 archive 写入时的真实时间戳作为向量 metadata.timestamp，
    // 保证后续按时间戳精确删除（如「回滚本轮对话」）能命中向量条目。
    const ts = data.archivedMessage.timestamp ?? Date.now();
    enqueueIndexMessage({ msg: data.incoming, timestamp: ts });
  });

  // === 按时间戳删除向量（供 plugin-checkpoint 回滚整轮对话使用） ===
  ctx.on('memory:messages-deleted', async (...args: unknown[]) => {
    const data = args[0] as { sessionId?: string; timestamps?: number[] } | undefined;
    if (!data?.sessionId || !Array.isArray(data.timestamps) || data.timestamps.length === 0) return;
    const currentStore = getStore();
    if (!currentStore.deleteByFilter) {
      ctx.logger.warn('当前向量存储不支持按条件删除，跳过 memory:messages-deleted');
      return;
    }
    let total = 0;
    for (const ts of data.timestamps) {
      try {
        total += await currentStore.deleteByFilter({ sessionId: data.sessionId, timestamp: ts });
      } catch (err) {
        ctx.logger.warn(`按时间戳删除向量失败 (ts=${ts}): ${formatError(err)}`);
      }
    }
    if (total > 0) {
      try {
        await currentStore.save();
      } catch (err) {
        ctx.logger.warn(`向量保存失败: ${formatError(err)}`);
      }
      ctx.logger.info(`回滚清除向量: session=${data.sessionId}, 删除 ${total} 条`);
    }
  });

  // === 统一记忆清除 ===

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
      if (data.types && !data.types.includes('vector')) {
        await next();
        return;
      }

      try {
        if (data.scope === 'all') {
          await getStore().clear();
          await getStore().save();
          data.results.push({ source: 'vector', success: true, message: '所有向量记忆已清空' });
          ctx.logger.info('向量记忆已全部清空');
        } else if (data.sessionId) {
          let deleted = 0;
          const currentStore = getStore();
          if (currentStore.deleteByFilter) {
            deleted = await currentStore.deleteByFilter({ sessionId: data.sessionId });
            await currentStore.save();
          } else {
            ctx.logger.warn('当前向量存储不支持按条件删除，会话级向量清空跳过');
          }
          data.results.push({ source: 'vector', success: true, message: `向量记忆已清空 (${deleted} 条)` });
          ctx.logger.info(`向量记忆已清空: session=${data.sessionId}, 删除 ${deleted} 条向量`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        data.results.push({ source: 'vector', success: false, message: `向量清空失败: ${msg}` });
        ctx.logger.warn(`向量清空失败: ${formatError(err)}`);
      }

      await next();
    },
  );

  // === 检索并注入上下文 ===

  ctx.middleware(
    'agent:llm:before',
    async (
      data: { messages: Message[]; tools: unknown[]; sessionId?: string; userId?: string; platform?: string },
      next: MiddlewareNext,
    ) => {
      if (data.messages.some(m => m.role === 'system' && m.metadata?.source === 'memory-vector')) {
        await next();
        return;
      }

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

        const candidateCount = Math.min(cfg.search.topK * 4, await getStore().size());
        if (candidateCount === 0) {
          await next();
          return;
        }

        const queryVec = await getEmbedder().embed(stripTimeLabel(lastUserMsg.content));
        const candidates = await getStore().search(queryVec, candidateCount);

        // 1. 阈值过滤
        const passThreshold = candidates.filter(c => c.score >= cfg.search.minScore);

        // 2. 跨会话模式过滤
        const filtered = passThreshold.filter(c => {
          switch (mode) {
            case 'isolated':
              return c.metadata.sessionId === curSessionId;
            case 'platform':
              return (
                (c.metadata.platform as string) === curPlatform ||
                parsePlatform(c.metadata.sessionId as string) === curPlatform
              );
            default:
              return true;
          }
        });

        // 3. 时间加权 + 同用户加权（作者匹配 或 当前用户被 @提及，均享 boost）
        const now = Date.now();
        const ranked = filtered.map(c => {
          let score =
            (1 - cfg.search.timeWeight) * c.score +
            cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now);
          if (mode === 'user' && curUserId) {
            const isAuthor = (c.metadata.userId as string) === curUserId;
            const mentions = c.metadata.mentions as string[] | undefined;
            const isMentioned = Array.isArray(mentions) && mentions.includes(curUserId);
            if (isAuthor || isMentioned) {
              score *= cfg.search.userPriorityBoost;
            }
          }
          return { ...c, finalScore: score };
        });
        ranked.sort((a, b) => b.finalScore - a.finalScore);

        const topResults = ranked.slice(0, cfg.search.topK);
        if (topResults.length === 0) {
          await next();
          return;
        }

        // 4. 命中点 + 上下文窗口扩展（合并区间，去重）
        const W = cfg.contextExpand.window;
        const collected = new Map<string, { sessionId: string; msg: Message }>();

        // 当前对话已有的内容用于去重（只比较纯文本）
        const currentContents = new Set(data.messages.map(m => (m.content ?? '').trim()).filter(Boolean));

        // 按 sessionId 聚合命中点的时间戳，决定每个会话需要拉取的时间窗口
        const sessionPivots = new Map<string, number[]>();
        for (const r of topResults) {
          const sid = r.metadata.sessionId as string | undefined;
          const ts = r.metadata.timestamp as number | undefined;
          if (!sid || ts === undefined) continue;
          if (!cfg.contextExpand.crossSession && sid !== curSessionId) {
            // 不允许跨会话扩展时，对非当前会话只放入命中点本身（走兜底分支）
            continue;
          }
          const arr = sessionPivots.get(sid) ?? [];
          arr.push(ts);
          sessionPivots.set(sid, arr);
        }

        // 拉取每个会话的扩展消息
        if (W > 0 && hasRangeQuery) {
          for (const [sid, pivots] of sessionPivots) {
            // 用宽时间窗一次拉，再按 pivot 切片合并（避免多次小查询）
            const minTs = Math.min(...pivots);
            const maxTs = Math.max(...pivots);
            // 4 小时缓冲，足以覆盖 N=数十条邻居的常见场景
            const bufferMs = 4 * 60 * 60 * 1000;
            try {
              const all = await memory!.getMessagesBySessionRange!(sid, minTs - bufferMs, maxTs + bufferMs);
              const sorted = all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

              // 对每个 pivot 在 sorted 中定位并取 ±W 条
              for (const pivotTs of pivots) {
                const pivotIdx = sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs && m.role === 'user');
                const idx = pivotIdx >= 0 ? pivotIdx : sorted.findIndex(m => (m.timestamp ?? 0) === pivotTs);
                if (idx < 0) {
                  // pivot 在 messages 表里找不到（消息表已老化清理），从向量 metadata 兜底插入
                  const cand = topResults.find(r => r.metadata.sessionId === sid && r.metadata.timestamp === pivotTs);
                  if (cand) {
                    const fakeMsg: Message = {
                      role: 'user',
                      content: (cand.metadata.content as string) ?? '',
                      timestamp: pivotTs,
                      name: cand.metadata.userId as string | undefined,
                      metadata: cand.metadata,
                    };
                    const key = messageKey(sid, fakeMsg);
                    if (!collected.has(key)) collected.set(key, { sessionId: sid, msg: fakeMsg });
                  }
                  continue;
                }
                const start = Math.max(0, idx - W);
                const end = Math.min(sorted.length, idx + W + 1);
                for (let i = start; i < end; i++) {
                  const m = sorted[i];
                  if (!m.content) continue;
                  if (m.role === 'system' && m.name === 'system-event' && m.content === '对话已压缩') continue;
                  if (currentContents.has((m.content ?? '').trim())) continue;
                  const key = messageKey(sid, m);
                  if (!collected.has(key)) collected.set(key, { sessionId: sid, msg: m });
                }
              }
            } catch (err) {
              ctx.logger.warn(`扩展上下文失败 (session=${sid}): ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        // 兜底：把所有未被扩展覆盖的命中（如跨会话扩展关闭、或无 range query）放入 collected
        for (const r of topResults) {
          const sid = r.metadata.sessionId as string | undefined;
          const ts = r.metadata.timestamp as number | undefined;
          if (!sid || ts === undefined) continue;
          if (r.metadata.content === '对话已压缩') continue;
          const fakeMsg: Message = {
            role: 'user',
            content: (r.metadata.content as string) ?? '',
            timestamp: ts,
            name: r.metadata.userId as string | undefined,
            metadata: r.metadata,
          };
          if (!fakeMsg.content) continue;
          if (currentContents.has(fakeMsg.content.trim())) continue;
          const key = messageKey(sid, fakeMsg);
          if (!collected.has(key)) collected.set(key, { sessionId: sid, msg: fakeMsg });
        }

        if (collected.size === 0) {
          await next();
          return;
        }

        // 5. 按时间排序混排
        const sortedAll = [...collected.values()].sort((a, b) => (a.msg.timestamp ?? 0) - (b.msg.timestamp ?? 0));

        const lines = sortedAll.map(({ msg }) => renderMemoryEntry(msg, cfg.search.perItemMaxChars));

        const contextBlock =
          '以下是从长期记忆中检索到的相关聊天记录片段（可能跨会话/跨群），按时间顺序呈现，仅供参考：\n' +
          lines.join('\n');

        const insertAt = data.messages.findIndex(m => m.role !== 'system');
        const insertIdx = insertAt === -1 ? data.messages.length : insertAt;
        data.messages.splice(insertIdx, 0, {
          role: 'system',
          content: contextBlock,
          metadata: { source: 'memory-vector' },
        });
      } catch (err) {
        ctx.logger.warn(`向量记忆检索失败: ${formatError(err)}`);
      }

      await next();
    },
  );

  // === 工具：主动语义召回 ===
  // LLM 可在判断"被动注入不够用"时主动调用，按任意 query 检索
  ctx.registerTool({
    definition: {
      type: 'function',
      function: {
        name: 'memory_recall',
        description:
          '从长期向量记忆中检索与某个关键词或问题相关的历史对话片段。' +
          '适用场景：用户提到「上次」「以前」「之前」等指代；' +
          '你需要核实自己或某个用户过往说过/承诺过什么；' +
          '当前对话上下文不足以回答而你怀疑历史里有线索时。' +
          '注意：每轮对话开始前已自动注入了 topK 条相关命中，请勿重复调用。' +
          '只在默认注入信息不足或需要换关键词重查时才使用本工具。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '检索关键词或自然语言问题。建议提炼成短句而非整段文本。',
            },
            topK: {
              type: 'number',
              description: `返回条数。默认 ${cfg.search.topK}，最多 15。`,
            },
            scope: {
              type: 'string',
              enum: ['session', 'platform', 'all'],
              description:
                'session=仅当前会话；platform=同平台所有会话；all=全部。' +
                `默认沿用插件配置（当前=${cfg.crossSessionMode}）。` +
                '为安全起见，scope 只能比插件配置更窄，不能更宽。',
            },
          },
          required: ['query'],
        },
      },
    },
    handler: async (args, callCtx): Promise<string> => {
      const query = String(args.query ?? '').trim();
      if (!query) return JSON.stringify({ error: 'query 不能为空' });

      const requestedTopK = Math.min(15, Math.max(1, Number(args.topK) || cfg.search.topK));
      const requestedScope = args.scope as 'session' | 'platform' | 'all' | undefined;

      // scope 收紧规则：插件配置 isolated 时强制 session；否则取插件配置和请求的较严者
      const modeRank: Record<CrossSessionMode | 'session', number> = {
        isolated: 0,
        session: 0,
        user: 1,
        platform: 2,
        all: 3,
      };
      const cfgRank = modeRank[cfg.crossSessionMode];
      const reqRank = requestedScope ? modeRank[requestedScope] : cfgRank;
      const effectiveRank = Math.min(cfgRank, reqRank);
      const effectiveScope: 'session' | 'platform' | 'all' =
        effectiveRank <= 0 ? 'session' : effectiveRank === 2 ? 'platform' : 'all';

      const curSessionId = callCtx.sessionId;
      const curPlatform = callCtx.platform ?? (curSessionId ? parsePlatform(curSessionId) : '');

      try {
        const storeSize = await getStore().size();
        if (storeSize === 0) {
          return JSON.stringify({ ok: true, query, results: [], message: '向量库为空' });
        }

        const queryVec = await getEmbedder().embed(query);
        const candidates = await getStore().search(queryVec, Math.min(requestedTopK * 4, storeSize));

        const passThreshold = candidates.filter(c => c.score >= cfg.search.minScore);

        const filtered = passThreshold.filter(c => {
          if (effectiveScope === 'session') return c.metadata.sessionId === curSessionId;
          if (effectiveScope === 'platform') {
            return (
              (c.metadata.platform as string) === curPlatform ||
              parsePlatform(c.metadata.sessionId as string) === curPlatform
            );
          }
          return true;
        });

        const now = Date.now();
        const ranked = filtered.map(c => {
          const score =
            (1 - cfg.search.timeWeight) * c.score +
            cfg.search.timeWeight * recencyScore((c.metadata.timestamp as number) ?? 0, now);
          return { ...c, finalScore: score };
        });
        ranked.sort((a, b) => b.finalScore - a.finalScore);

        const top = ranked.slice(0, requestedTopK);
        if (top.length === 0) {
          return JSON.stringify({ ok: true, query, results: [], message: '无命中' });
        }

        const results = top.map(r => {
          const m: Message = {
            role: 'user',
            content: (r.metadata.content as string) ?? '',
            timestamp: (r.metadata.timestamp as number) ?? 0,
            name: r.metadata.userId as string | undefined,
            metadata: r.metadata,
          };
          return {
            score: Number(r.finalScore.toFixed(4)),
            text: renderMemoryEntry(m, cfg.search.perItemMaxChars),
            sessionId: r.metadata.sessionId,
          };
        });

        return JSON.stringify({
          ok: true,
          query,
          scope: effectiveScope,
          count: results.length,
          results,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`memory_recall 失败: ${msg}`);
        return JSON.stringify({ error: `检索失败: ${msg}` });
      }
    },
  });
}
