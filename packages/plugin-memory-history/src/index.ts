/**
 * plugin-memory-history —— 把"跨会话最近 N 条消息"作为可选上下文注入 agent。
 *
 * 数据来源：MemoryService.getRecentMessagesAcrossSessions（DB 直查），不再维护进程
 * 内 RingBuffer。这样：
 *   - 重启 / 多进程都能立即看到完整最近历史；
 *   - 容量只受 DB 限制，与 buffer 容量解耦；
 *   - 与 vector / summary 同样走 DB，行为一致、可审计。
 *
 * 注入策略：
 *   - 监听 `agent:llm:before`，按 scope 决定是否过滤 platform。
 *   - 通过 metadata.source 标记排重，避免被多次插入。
 *   - 同步注册 `recent_messages` 工具供 agent 主动查询。
 *
 * 与 agent.historyLimit 的关系：
 *   - historyLimit 加载的是当前 sessionId 的最近 N 条；
 *   - 本插件注入的是跨 session 聚合的近期片段（独立 system 块）。
 *   - 两者可能内容重叠，header 文本中已说明"仅供参考"。
 */

import type { ConfigSchema, Context } from '@aalis/core';
import '@aalis/plugin-agent-api';
import type { MemoryService, RecentMessageRecord } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import { useToolService } from '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-memory-history';
export const displayName = '跨会话历史上下文';
export const subsystem = 'memory';
export const inject = {
  required: ['memory'],
  optional: ['tools'],
};

// ===== 配置 schema =====

export type HistoryScope = 'off' | 'same-platform' | 'cross-platform';

export const configSchema: ConfigSchema = {
  scope: {
    type: 'select',
    label: '默认作用域',
    default: 'same-platform',
    options: [
      { label: '关闭注入（仍保留工具）', value: 'off' },
      { label: '同平台跨会话聚合', value: 'same-platform' },
      { label: '跨平台全部聚合', value: 'cross-platform' },
    ],
    description:
      '"同平台" = 仅取与当前消息同 platform 的历史；"跨平台" = 全部 platform 合并。off 时不再自动注入 system-block，但工具仍可主动调用。',
  },
  limit: {
    type: 'number',
    label: '注入条数上限',
    default: 30,
    description: '每次注入的最大消息条数；工具调用未指定 limit 时也用这个值。',
  },
  maxAgeMinutes: {
    type: 'number',
    label: '时间窗口（分钟）',
    default: 180,
    description: '只取最近 N 分钟内的消息；0 表示不限时间。',
  },
  perSessionLimit: {
    type: 'number',
    label: '每会话最多条数',
    default: 5,
    description: '同一 sessionId 最多保留 N 条，避免某个活跃群刷屏占满总 limit；为 0 = 不做 per-session cap。',
  },
  excludeCurrentSession: {
    type: 'boolean',
    label: '排除当前会话',
    default: true,
    description: '注入时排除当前 sessionId（避免与 agent.historyLimit 重复）。',
  },
  headerText: {
    type: 'string',
    label: '注入 header 文本',
    default: '📜 以下是来自其他会话/群聊的近期消息片段（按时间升序），供你了解最近发生了什么。',
    description: '注入到 messages[] 的 system 消息开头说明文字。',
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
  limit: 30,
  maxAgeMinutes: 180,
  perSessionLimit: 5,
  excludeCurrentSession: true,
  headerText: '📜 以下是来自其他会话/群聊的近期消息片段（按时间升序），供你了解最近发生了什么。',
  toolEnabled: true,
  toolName: 'recent_messages',
};

// ===== 内部类型 / 工具 =====

interface HistoryConfig {
  scope: HistoryScope;
  limit: number;
  maxAgeMinutes: number;
  perSessionLimit: number;
  excludeCurrentSession: boolean;
  headerText: string;
  toolEnabled: boolean;
  toolName: string;
  injectMetadataSource: string;
}

interface QueryOptions {
  /** 覆盖 scope；不传则用配置默认值 */
  scope?: HistoryScope;
  currentPlatform?: string;
  currentSessionId?: string;
  limit?: number;
  maxAgeMinutes?: number;
}

function normalizeConfig(raw: Record<string, unknown>): HistoryConfig {
  const scopeRaw = (raw.scope as string) ?? 'same-platform';
  const scope: HistoryScope =
    scopeRaw === 'off' || scopeRaw === 'same-platform' || scopeRaw === 'cross-platform' ? scopeRaw : 'same-platform';
  const toolName =
    (typeof raw.toolName === 'string' && raw.toolName ? raw.toolName : 'recent_messages').replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    ) || 'recent_messages';
  return {
    scope,
    limit: Math.max(1, Number(raw.limit ?? 30)),
    maxAgeMinutes: Math.max(0, Number(raw.maxAgeMinutes ?? 180)),
    perSessionLimit: Math.max(0, Number(raw.perSessionLimit ?? 5)),
    excludeCurrentSession: raw.excludeCurrentSession !== false,
    headerText: typeof raw.headerText === 'string' ? raw.headerText : (defaultConfig.headerText as string),
    toolEnabled: raw.toolEnabled !== false,
    toolName,
    injectMetadataSource: 'memory-history',
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
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

function formatRecords(records: RecentMessageRecord[]): string {
  return records
    .map(({ sessionId, message }) => {
      const meta = (message.metadata ?? {}) as Record<string, unknown>;
      const platform = asString(meta.platform) ?? 'unknown';
      const senderName = asString(meta.nickname);
      const groupName = asString(meta.groupName);
      const role = message.role === 'assistant' ? 'Assistant' : 'User';
      const sender = senderName ? `/${senderName}` : '';
      const group = groupName ? `@${groupName}` : '';
      return `[${formatTimestamp(message.timestamp ?? 0)}][${platform}/${shortSession(sessionId)}${group}][${role}${sender}] ${message.content ?? ''}`;
    })
    .join('\n');
}

// ===== 入口 =====

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const cfg = normalizeConfig(rawConfig);

  ctx.logger.info(`跨会话历史上下文插件已启动（scope=${cfg.scope} limit=${cfg.limit} maxAge=${cfg.maxAgeMinutes}min）`);

  async function queryRecent(opts: QueryOptions): Promise<RecentMessageRecord[]> {
    const scope: HistoryScope = opts.scope ?? cfg.scope;
    if (scope === 'off') return [];

    const memory = ctx.getService<MemoryService>('memory');
    if (!memory?.getRecentMessagesAcrossSessions) {
      ctx.logger.debug('memory-history: 当前 memory 后端不支持 getRecentMessagesAcrossSessions，跳过');
      return [];
    }

    const limit = Math.max(1, opts.limit ?? cfg.limit);
    const maxAge = opts.maxAgeMinutes ?? cfg.maxAgeMinutes;
    const sinceTs = maxAge > 0 ? Date.now() - maxAge * 60_000 : undefined;
    const platform = scope === 'same-platform' ? opts.currentPlatform : undefined;
    const excludeSessionIds = cfg.excludeCurrentSession && opts.currentSessionId ? [opts.currentSessionId] : undefined;

    // 若启用 per-session cap，需要向 backend overscan；上限按 limit * 10 与 1000 取小，
    // 既能覆盖单会话刷屏场景，又避免极端情况下拉太多。
    const perSessionLimit = cfg.perSessionLimit;
    const backendLimit = perSessionLimit > 0 ? Math.min(limit * 10, 1000) : limit;

    const raw = await memory.getRecentMessagesAcrossSessions({
      limit: backendLimit,
      sinceTs,
      platform,
      excludeSessionIds,
      roles: ['user', 'assistant'],
    });

    if (perSessionLimit <= 0 || raw.length <= limit) return raw.slice(-limit);

    // raw 是时间升序；为做 per-session cap 时优先保留每会话最新若干条，
    // 先反转为降序遍历，命中即累计；累计到 limit 或扫完为止；最后再反转回升序。
    const perSessionCount = new Map<string, number>();
    const picked: RecentMessageRecord[] = [];
    for (let i = raw.length - 1; i >= 0 && picked.length < limit; i--) {
      const rec = raw[i];
      const cnt = perSessionCount.get(rec.sessionId) ?? 0;
      if (cnt >= perSessionLimit) continue;
      perSessionCount.set(rec.sessionId, cnt + 1);
      picked.push(rec);
    }
    picked.reverse();
    return picked;
  }

  // ---- 注入 hook ----

  ctx.middleware('agent:llm:before', async (data, next) => {
    if (cfg.scope === 'off') {
      await next();
      return;
    }
    if (data.messages.some(m => m.role === 'system' && m.metadata?.source === cfg.injectMetadataSource)) {
      await next();
      return;
    }
    let records: RecentMessageRecord[];
    try {
      records = await queryRecent({
        currentPlatform: data.platform,
        currentSessionId: data.sessionId,
      });
    } catch (err) {
      ctx.logger.warn('memory-history: 查询近期消息失败，跳过注入:', err);
      await next();
      return;
    }
    if (records.length === 0) {
      ctx.logger.debug(
        `memory-history: 未找到可注入的跨会话消息 (scope=${cfg.scope}, platform=${data.platform ?? '?'}, session=${data.sessionId ?? '?'})`,
      );
      await next();
      return;
    }

    const block = `${cfg.headerText}\n\n${formatRecords(records)}`;
    const injectMsg: Message = {
      role: 'system',
      content: block,
      metadata: { source: cfg.injectMetadataSource },
    };
    const idx = data.messages.findIndex(m => m.role !== 'system');
    const insertIdx = idx === -1 ? data.messages.length : idx;
    data.messages.splice(insertIdx, 0, injectMsg);
    ctx.logger.debug(
      `memory-history: 已注入 ${records.length} 条跨会话消息 (scope=${cfg.scope}, platform=${data.platform ?? '?'}, sessions=${new Set(records.map(r => r.sessionId)).size}, bytes=${block.length})`,
    );

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
            '查询跨会话近期消息上下文。返回按时间升序排列的消息片段，可用于了解平台/跨平台的近期对话动态。每条格式为 [time][platform/session][role/sender] content。',
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
        const records = await queryRecent({
          scope,
          currentPlatform: callCtx.platform,
          currentSessionId: callCtx.sessionId,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          maxAgeMinutes: typeof args.maxAgeMinutes === 'number' ? args.maxAgeMinutes : undefined,
        });
        if (records.length === 0) return '（最近没有匹配的消息）';
        return formatRecords(records);
      },
      safety: 'safe',
    });
  }
}
