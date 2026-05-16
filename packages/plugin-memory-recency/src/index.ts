/**
 * plugin-memory-recency —— 把"该平台 / 跨平台最近 N 条消息"作为可选上下文注入 agent。
 *
 * 设计要点：
 * - 监听 `inbound:message:archived` 与 `outbound:message`，维护一个进程内
 *   `RecencyBuffer`（按 timestamp 排序，FIFO 淘汰）。
 * - 启动时（whenService memory）通过 session-manager.listSessions() 拉所有已知
 *   sessionId，调用 memory.getHistory 预热填充。session-manager 不可用时跳过预热，
 *   ring buffer 会从下次 inbound 开始自然填充。
 * - 通过 `agent:llm:before` middleware 把"近期消息"作为单独 system 消息注入 messages[]，
 *   header 文本可配置；明确告诉模型不要在回复中提"其他会话/其他来源"等元概念。
 * - 同时把同一查询逻辑包装为 `recent_messages` 工具供 agent 主动按需调用。
 *
 * 与 `agent.historyLimit` 的关系：
 * - historyLimit 加载的是**当前 sessionId** 的最近 N 条（拼到 messages[] 主历史区）；
 * - memory-recency 注入的是**跨 session（同平台或全平台）**的近期片段（独立 system 块），
 *   两者并存且可能在内容上有部分重叠（buffer 里也包括当前 session 的消息）——
 *   header 文本里已说明"可能包含本次回复对象的过往发言"，模型理解为"参考材料"即可。
 */

import type { ConfigSchema, Context } from '@aalis/core';
import '@aalis/plugin-agent-api';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message, OutgoingMessage } from '@aalis/plugin-message-api';
import { useToolService } from '@aalis/plugin-tools-api';

import { RecencyBuffer, type RecentEntry } from './buffer.js';
import type { QueryOptions, RecencyConfig, RecencyScope, RecencyService } from './types.js';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-recency';
export const displayName = '近期消息上下文';
export const subsystem = 'memory';
export const inject = {
  required: ['memory'],
  optional: ['session-manager', 'tools'],
};

// ===== 配置 schema =====

export const configSchema: ConfigSchema = {
  scope: {
    type: 'select',
    label: '默认作用域',
    default: 'same-platform',
    options: [
      { label: '关闭注入（仍保留 buffer 与工具）', value: 'off' },
      { label: '同平台跨会话聚合（如 OneBot 下所有群+私聊）', value: 'same-platform' },
      { label: '跨平台全部聚合（onebot+webui+cli 全合并）', value: 'cross-platform' },
    ],
    description:
      '"该平台" = 取与当前消息同 platform 的历史；"跨平台" = 全部 platform 合并。off 时不再自动注入 system-block，但工具仍可主动调用。',
  },
  limit: {
    type: 'number',
    label: '注入条数上限',
    default: 20,
    description: '默认每次注入的最大消息条数；工具调用未指定 limit 时也用这个值。',
  },
  maxAgeMinutes: {
    type: 'number',
    label: '时间窗口（分钟）',
    default: 60,
    description: '只取最近 N 分钟内的消息；0 表示不限时间。',
  },
  preheatPerSession: {
    type: 'number',
    label: '启动预热每会话条数',
    default: 30,
    description: '启动时通过 session-manager 列出已知会话并各拉这么多条历史填入 buffer。0 = 不预热。',
  },
  bufferCapacity: {
    type: 'number',
    label: 'Ring buffer 容量',
    default: 2000,
    description: '进程内 buffer 总条数上限，超出按时间最旧淘汰。',
  },
  whitelistPlatforms: {
    type: 'textarea',
    label: '平台白名单',
    default: '',
    description: '一行一个 platform 名（如 onebot / webui / cli）；为空则不限制。',
  },
  whitelistSessions: {
    type: 'textarea',
    label: '会话白名单',
    default: '',
    description: '一行一个 sessionId；为空则不限制。',
  },
  blacklistSessions: {
    type: 'textarea',
    label: '会话黑名单',
    default: '',
    description: '一行一个 sessionId；永远排除这些会话（优先级高于白名单）。',
  },
  headerText: {
    type: 'string',
    label: '注入 header 文本',
    default:
      '📜 以下是仅供参考的近期消息片段（按时间升序）。它们可能来自当前对话对象的过往发言，也可能来自其他来源；请只用作背景理解，不要在回复中提及"其他会话""其他来源""不同平台"等元概念，也不要直接复述这些消息的存在。',
    description: '注入到 messages[] 的 system 消息开头说明文字。建议保留隐私/防泄漏提示。',
  },
  toolEnabled: {
    type: 'boolean',
    label: '注册查询工具',
    default: true,
    description: '是否注册 recent_messages 工具供 agent 主动按需查询。',
  },
  toolName: {
    type: 'string',
    label: '工具名',
    default: 'recent_messages',
  },
};

export const defaultConfig = {
  scope: 'same-platform',
  limit: 20,
  maxAgeMinutes: 60,
  preheatPerSession: 30,
  bufferCapacity: 2000,
  whitelistPlatforms: '',
  whitelistSessions: '',
  blacklistSessions: '',
  headerText:
    '📜 以下是仅供参考的近期消息片段（按时间升序）。它们可能来自当前对话对象的过往发言，也可能来自其他来源；请只用作背景理解，不要在回复中提及"其他会话""其他来源""不同平台"等元概念，也不要直接复述这些消息的存在。',
  toolEnabled: true,
  toolName: 'recent_messages',
};

// ===== 工具函数 =====

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v === 'string') {
    return v
      .split(/[\n,]/)
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  return [];
}

function normalizeConfig(raw: Record<string, unknown>): RecencyConfig {
  const scopeRaw = (raw.scope as string) ?? 'same-platform';
  const scope: RecencyScope =
    scopeRaw === 'off' || scopeRaw === 'same-platform' || scopeRaw === 'cross-platform' ? scopeRaw : 'same-platform';
  return {
    scope,
    limit: Math.max(1, Number(raw.limit ?? 20)),
    maxAgeMinutes: Math.max(0, Number(raw.maxAgeMinutes ?? 60)),
    preheatPerSession: Math.max(0, Number(raw.preheatPerSession ?? 30)),
    bufferCapacity: Math.max(50, Number(raw.bufferCapacity ?? 2000)),
    whitelist: {
      platforms: asStringArray(raw.whitelistPlatforms),
      sessions: asStringArray(raw.whitelistSessions),
    },
    blacklist: {
      sessions: asStringArray(raw.blacklistSessions),
    },
    headerText: typeof raw.headerText === 'string' ? raw.headerText : (defaultConfig.headerText as string),
    toolEnabled: raw.toolEnabled !== false,
    toolName: (asString(raw.toolName) ?? 'recent_messages').replace(/[^a-zA-Z0-9_-]/g, '_'),
    injectMetadataSource: 'memory-recency',
  };
}

function isAllowed(entry: { platform: string; sessionId: string }, cfg: RecencyConfig): boolean {
  if (cfg.blacklist.sessions.includes(entry.sessionId)) return false;
  if (cfg.whitelist.platforms.length > 0 && !cfg.whitelist.platforms.includes(entry.platform)) return false;
  if (cfg.whitelist.sessions.length > 0 && !cfg.whitelist.sessions.includes(entry.sessionId)) return false;
  return true;
}

function formatTimestamp(ts: number): string {
  if (!ts) return '????-??-?? ??:??:??';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortSession(sessionId: string, max = 24): string {
  if (sessionId.length <= max) return sessionId;
  return `${sessionId.slice(0, max - 3)}...`;
}

function formatEntries(entries: RecentEntry[]): string {
  return entries
    .map(e => {
      const tag = e.role === 'assistant' ? 'Assistant' : 'User';
      const sender = e.senderName ? `/${e.senderName}` : '';
      const group = e.groupName ? `@${e.groupName}` : '';
      return `[${formatTimestamp(e.timestamp)}][${e.platform}/${shortSession(e.sessionId)}${group}][${tag}${sender}] ${e.content}`;
    })
    .join('\n');
}

function entryFromMessage(msg: Message, sessionId: string): RecentEntry | null {
  if (msg.role !== 'user' && msg.role !== 'assistant') return null;
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  // system-event（如压缩分隔线）走 name='system-event'，role 也可能是 system，已在上面被过滤
  if (msg.name === 'system-event') return null;
  return {
    timestamp: msg.timestamp ?? 0,
    platform: asString(meta.platform) ?? 'unknown',
    sessionId,
    role: msg.role,
    content: msg.content ?? '',
    senderName: asString(meta.nickname),
    groupName: asString(meta.groupName),
    groupId: asString(meta.groupId),
  };
}

// ===== 入口 =====

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const cfg = normalizeConfig(rawConfig);
  const buffer = new RecencyBuffer(cfg.bufferCapacity);

  ctx.logger.info(
    `近期消息上下文插件已启动（scope=${cfg.scope} limit=${cfg.limit} maxAge=${cfg.maxAgeMinutes}min capacity=${cfg.bufferCapacity}）`,
  );

  // ---- 实时收集 ----

  ctx.on('inbound:message:archived', data => {
    try {
      const e = entryFromMessage(data.archivedMessage, data.sessionId);
      if (!e) return;
      // incoming 必带 platform，覆盖 metadata 里的（更可信）
      if (data.incoming.platform) e.platform = data.incoming.platform;
      if (!isAllowed(e, cfg)) return;
      buffer.push(e);
    } catch (err) {
      ctx.logger.warn('memory-recency: 处理 inbound 失败:', err);
    }
  });

  ctx.on('outbound:message', (msg: OutgoingMessage) => {
    try {
      if (!msg.content || !msg.sessionId) return;
      // outbound:message 的 platform 字段可能缺失；尽力而为，缺失就用 unknown
      const e: RecentEntry = {
        timestamp: Date.now(),
        platform: asString(msg.platform) ?? 'unknown',
        sessionId: msg.sessionId,
        role: 'assistant',
        content: msg.content,
      };
      if (!isAllowed(e, cfg)) return;
      buffer.push(e);
    } catch (err) {
      ctx.logger.warn('memory-recency: 处理 outbound 失败:', err);
    }
  });

  // ---- 启动预热 ----
  // session-manager 是 optional inject，可能不存在；不存在时跳过预热。
  if (cfg.preheatPerSession > 0) {
    ctx.whenService<{
      listSessions: () => Array<{ id: string }>;
    }>('session-manager', sm => {
      const memory = ctx.getService<MemoryService>('memory');
      if (!memory) return undefined;
      // 异步预热，不阻塞插件 apply 返回
      void (async () => {
        try {
          const sessions = sm.listSessions();
          let total = 0;
          for (const s of sessions) {
            try {
              const msgs = await memory.getHistory(s.id, cfg.preheatPerSession);
              for (const m of msgs) {
                const e = entryFromMessage(m, s.id);
                if (!e || !isAllowed(e, cfg)) continue;
                if (buffer.push(e)) total++;
              }
            } catch (err) {
              ctx.logger.debug(`memory-recency: 预热 session=${s.id} 失败:`, err);
            }
          }
          ctx.logger.info(`memory-recency: 预热完成，共 ${total} 条来自 ${sessions.length} 个会话`);
        } catch (err) {
          ctx.logger.warn('memory-recency: 预热失败:', err);
        }
      })();
      return undefined;
    });
  }

  // ---- 服务封装 ----

  function resolveQuery(opts: QueryOptions): RecentEntry[] {
    const scope: RecencyScope = opts.scope ?? cfg.scope;
    if (scope === 'off') return [];
    const limit = Math.max(1, Math.min(opts.limit ?? cfg.limit, cfg.bufferCapacity));
    const maxAge = opts.maxAgeMinutes ?? cfg.maxAgeMinutes;
    const sinceTs = maxAge > 0 ? Date.now() - maxAge * 60_000 : undefined;
    const currentPlatform = opts.currentPlatform;

    const filter = (e: RecentEntry): boolean => {
      if (scope === 'same-platform') {
        // currentPlatform 缺失时退化为不过滤（容错；实际 hook 总会带）
        if (currentPlatform && e.platform !== currentPlatform) return false;
      }
      return true;
    };
    return buffer.query(filter, limit, sinceTs);
  }

  const service: RecencyService = {
    query: resolveQuery,
    size: () => buffer.size(),
    clear: () => buffer.clear(),
  };
  ctx.provide('memory-recency', service);

  // ---- 注入 hook ----

  ctx.middleware('agent:llm:before', async (data, next) => {
    if (cfg.scope === 'off') {
      await next();
      return;
    }
    // 已经注入过就跳过（避免 hook 被多次触发的情况下重复插入）
    if (data.messages.some(m => m.role === 'system' && m.metadata?.source === cfg.injectMetadataSource)) {
      await next();
      return;
    }
    const entries = resolveQuery({
      currentPlatform: data.platform,
      currentSessionId: data.sessionId,
    });
    if (entries.length === 0) {
      await next();
      return;
    }

    const block = `${cfg.headerText}\n\n${formatEntries(entries)}`;
    const injectMsg: Message = {
      role: 'system',
      content: block,
      metadata: { source: cfg.injectMetadataSource },
    };
    // 插入到第一条非 system 消息之前；与 memory-summary / memory-vector 同区域
    const idx = data.messages.findIndex(m => m.role !== 'system');
    const insertIdx = idx === -1 ? data.messages.length : idx;
    data.messages.splice(insertIdx, 0, injectMsg);

    await next();
  });

  // ---- 工具注册 ----

  if (cfg.toolEnabled) {
    const tools = useToolService(ctx);
    tools.register({
      definition: {
        type: 'function',
        function: {
          name: cfg.toolName,
          description:
            '查询近期消息上下文。返回按时间升序排列的消息片段，可用于了解平台/跨平台的近期对话动态。每条格式为 [time][platform/session][role/sender] content。',
          parameters: {
            type: 'object',
            properties: {
              scope: {
                type: 'string',
                enum: ['same-platform', 'cross-platform'],
                description:
                  'same-platform = 仅取与当前消息同平台的历史；cross-platform = 跨所有平台聚合。不传则使用插件配置默认值。',
              },
              limit: {
                type: 'number',
                description: `返回条数上限（默认 ${cfg.limit}）。`,
              },
              maxAgeMinutes: {
                type: 'number',
                description: `只返回最近 N 分钟内的消息；0 = 不限。默认 ${cfg.maxAgeMinutes}。`,
              },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args, callCtx) => {
        const scope = args.scope === 'same-platform' || args.scope === 'cross-platform' ? args.scope : undefined;
        const entries = resolveQuery({
          scope,
          currentPlatform: callCtx.platform,
          currentSessionId: callCtx.sessionId,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          maxAgeMinutes: typeof args.maxAgeMinutes === 'number' ? args.maxAgeMinutes : undefined,
        });
        if (entries.length === 0) return '（最近没有匹配的消息）';
        return formatEntries(entries);
      },
      // 只读查询，无副作用 → safe + authority 1（默认）
      safety: 'safe',
    });
  }
}

export type { RecentEntry } from './buffer.js';
export { RecencyBuffer } from './buffer.js';
export type { QueryOptions, RecencyScope, RecencyService } from './types.js';

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    'memory-recency': import('./types.js').RecencyService;
  }
}
