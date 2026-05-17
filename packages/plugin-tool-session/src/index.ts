import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { Message } from '@aalis/plugin-message-api';
import type { ToolCallContext } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-tools-api';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-session';
export const displayName = '会话历史工具';
export const subsystem = 'session';
export const provides = ['session-history'];
export const inject = {
  optional: ['memory'],
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用会话历史读取工具', default: true },
  maxLimit: { type: 'number', label: '单次最多读取条数', default: 30 },
  scope: {
    type: 'select',
    label: '允许读取范围',
    default: 'platform',
    options: [
      { label: '仅当前会话', value: 'current' },
      { label: '同平台会话', value: 'platform' },
      { label: '全部会话', value: 'all' },
    ],
  },
  includeArchivedDefault: { type: 'boolean', label: '默认包含已归档消息', default: false },
  perMessageMaxChars: {
    type: 'number',
    label: '每条消息截断字数',
    default: 0,
    description: '返给 LLM 的每条历史消息的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。',
  },
};

interface PluginConfig {
  enabled: boolean;
  maxLimit: number;
  scope: 'current' | 'platform' | 'all';
  includeArchivedDefault: boolean;
  perMessageMaxChars: number;
}

interface SessionHistoryOptions {
  sessionId: string;
  limit?: number;
  includeArchived?: boolean;
}

interface SessionHistoryResult {
  ok: true;
  sessionId: string;
  count: number;
  limit: number;
  includeArchived: boolean;
  messages: Array<Record<string, unknown>>;
}

interface SessionHistoryService {
  getHistory(
    options: SessionHistoryOptions,
    callCtx: ToolCallContext,
  ): Promise<SessionHistoryResult | { error: string }>;
}

function resolveConfig(raw: Record<string, unknown>): PluginConfig {
  const scopeRaw = raw.scope;
  const scope = scopeRaw === 'current' || scopeRaw === 'all' ? scopeRaw : 'platform';
  return {
    enabled: raw.enabled !== false,
    maxLimit: Math.max(1, Math.min(100, Number(raw.maxLimit) || 30)),
    scope,
    includeArchivedDefault: raw.includeArchivedDefault === true,
    perMessageMaxChars: Math.max(0, Number(raw.perMessageMaxChars) || 0),
  };
}

function parsePlatform(sessionId: string): string {
  return sessionId.split(':')[0] ?? '';
}

function formatHistoryMessage(message: Message, index: number, perMessageMaxChars: number): Record<string, unknown> {
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content == null
        ? ''
        : JSON.stringify(message.content);
  const content =
    perMessageMaxChars > 0 && text.length > perMessageMaxChars
      ? `${text.slice(0, perMessageMaxChars)}…[已截断，还剩 ${text.length - perMessageMaxChars} 个字符未展示]`
      : text;
  return {
    index,
    role: message.role,
    content,
    timestamp: message.timestamp ?? null,
    name: message.name ?? null,
    metadata: message.metadata ?? undefined,
  };
}

function canReadSessionHistory(
  currentSessionId: string,
  targetSessionId: string,
  currentPlatform: string | undefined,
  scope: 'current' | 'platform' | 'all',
): { ok: true } | { ok: false; reason: string } {
  if (scope === 'all') return { ok: true };
  if (targetSessionId === currentSessionId) return { ok: true };
  if (scope === 'current') return { ok: false, reason: '当前配置仅允许读取当前会话历史' };

  const current = currentPlatform || parsePlatform(currentSessionId);
  const target = parsePlatform(targetSessionId);
  if (current && target && current === target) return { ok: true };
  return {
    ok: false,
    reason: `当前配置仅允许读取同平台会话历史（当前=${current || 'unknown'}, 目标=${target || 'unknown'}）`,
  };
}

function createSessionHistoryService(ctx: Context, cfg: PluginConfig): SessionHistoryService {
  return {
    async getHistory(options, callCtx) {
      const memory = ctx.getService<MemoryService>('memory');
      if (!memory) return { error: 'memory 服务不可用' };

      const targetSessionId = String(options.sessionId ?? '').trim();
      if (!targetSessionId) return { error: 'sessionId 不能为空' };

      const verdict = canReadSessionHistory(callCtx.sessionId, targetSessionId, callCtx.platform, cfg.scope);
      if (!verdict.ok) return { error: verdict.reason };

      const limit = Math.max(1, Math.min(cfg.maxLimit, Math.floor(Number(options.limit) || 20)));
      const includeArchived =
        typeof options.includeArchived === 'boolean' ? options.includeArchived : cfg.includeArchivedDefault;

      try {
        const history =
          includeArchived && memory.getFullHistory
            ? await memory.getFullHistory(targetSessionId, limit)
            : await memory.getHistory(targetSessionId, limit);
        return {
          ok: true,
          sessionId: targetSessionId,
          count: history.length,
          limit,
          includeArchived: includeArchived && !!memory.getFullHistory,
          messages: history.map((message, index) => formatHistoryMessage(message, index + 1, cfg.perMessageMaxChars)),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`session-history 读取失败 (${targetSessionId}): ${message}`);
        return { error: `读取会话历史失败: ${message}` };
      }
    },
  };
}

function registerSessionHistoryTools(ctx: Context, historyService: SessionHistoryService, cfg: PluginConfig): void {
  useToolService(ctx).registerGroup({
    name: 'session-history',
    label: '会话历史读取',
    description: '按 Aalis sessionId 读取近期会话历史，用于核实跨会话上下文',
  });

  useToolService(ctx).register({
    groups: ['session-history'],
    definition: {
      type: 'function',
      function: {
        name: 'session_get_history',
        description: [
          '按 Aalis sessionId 读取指定会话最近若干条消息。',
          '适合在用户明确提到另一个会话、需要核实原文上下文时使用。',
          '默认只允许读取配置范围内的会话；不要把它当作全局搜索工具，语义检索请用 memory_recall。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '目标 Aalis sessionId，例如 onebot:10000:group:20001' },
            limit: { type: 'number', description: `读取最近多少条，默认 20，最多 ${cfg.maxLimit}` },
            include_archived: { type: 'boolean', description: '是否包含已归档消息。默认使用插件配置。' },
          },
          required: ['session_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const targetSessionId = String(args.session_id ?? '').trim();
      if (!targetSessionId) return JSON.stringify({ error: 'session_id 不能为空' });
      const result = await historyService.getHistory(
        {
          sessionId: targetSessionId,
          limit: Number(args.limit) || undefined,
          includeArchived: typeof args.include_archived === 'boolean' ? args.include_archived : undefined,
        },
        callCtx,
      );
      return JSON.stringify(result);
    },
  });

  ctx.logger.info('会话历史读取工具已注册');
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  const historyService = createSessionHistoryService(ctx, cfg);
  ctx.provide('session-history', historyService, { label: '会话历史读取' });
  registerSessionHistoryTools(ctx, historyService, cfg);
}
