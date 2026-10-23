import { memory } from '@aalis/api-memory';
import { type SessionHistoryReadResult, type SessionHistoryService, sessionHistory } from '@aalis/api-session-history';
import { sessionManager, takeFrom } from '@aalis/api-session-manager';
import { tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, logger, optional, provide } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { toSource } from '@aalis/schema-i18n';
import { CONTROL_KINDS, type Message } from '@aalis/schema-message';

// ===== 插件元数据与能力声明 =====

const configSchema = defineConfig({
  enabled: { type: 'boolean', label: '启用会话历史读取工具', default: true, onInvalid: 'error' },
  maxLimit: {
    type: 'number',
    label: '单次最多读取条数',
    default: 100,
    description: 'session_get_history 一次能返回的硬上限；LLM 传入 limit 超过此值会被 cap。建议 50~200。',
  },
  defaultLimit: {
    type: 'number',
    label: '默认读取条数（LLM 不传 limit 时）',
    default: 20,
    description: '不能超过 maxLimit。调高可让 agent 被动获取更多上下文，代价是 token 预算。',
  },
  includeArchivedDefault: { type: 'boolean', label: '默认包含已归档消息', default: false },
  perMessageMaxChars: {
    type: 'number',
    label: '每条消息截断字数',
    default: 0,
    description: '返给 LLM 的每条历史消息的字符上限；0 = 不截断（推荐）。超出会以「剩余 N 字符未展示」明示。',
  },
});

const uses = {
  tools: optional(tools),
  logger,
  config,
  provide,
  memory: optional(memory),
  /** 能不能读目标会话按它的规则判（takeFrom）；不在时只能读当前会话 */
  sessionManager: optional(sessionManager),
};
type Caps = BoundOf<typeof uses>;
type HistoryCaps = Pick<Caps, 'memory' | 'logger' | 'sessionManager'>;
type HistoryToolCaps = Pick<Caps, 'tools' | 'logger'>;

type PluginConfig = ConfigOf<typeof configSchema>;

type SessionHistoryResult = Extract<SessionHistoryReadResult, { ok: true }>;

/** 无原生区间查询的后端：区间检索退回扫描历史的最大条数（best-effort 上界，防 OOM） */
const RANGE_FALLBACK_SCAN = 5000;

// ===== 时间区间解析（纯函数，单测覆盖见 test/plugins/session-history-range.test.ts） =====

/**
 * 把一个时间值解析为毫秒时间戳。接受：
 * - number：直接当毫秒时间戳（有限值）。
 * - 纯数字字符串：当毫秒时间戳。
 * - ISO 8601 等可被 `Date.parse` 识别的字符串。
 * 无法解析时返回 `null`。
 */
export function parseTimestamp(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * 根据工具入参解析出时间区间 [fromTs, toTs]（毫秒）。
 * - 给定 `since`/`until`（ISO 或毫秒）→ 绝对区间；`until` 省略时取 `now`。
 * - 否则给定 `within_minutes`（正数）→ 相对区间 [now - N 分钟, now]。
 * - 都没给 → 返回 `null`（调用方退回纯条数检索）。
 * 解析失败或区间非法时返回 `{ error }`。
 */
export function resolveTimeRange(
  args: { within_minutes?: unknown; since?: unknown; until?: unknown },
  now: number,
): { fromTs: number; toTs: number } | { error: string } | null {
  const hasSince = args.since != null && args.since !== '';
  const hasUntil = args.until != null && args.until !== '';
  const hasWithin = args.within_minutes != null && args.within_minutes !== '';

  if (hasSince || hasUntil) {
    let fromTs = 0;
    if (hasSince) {
      const parsed = parseTimestamp(args.since);
      if (parsed == null) {
        return { error: `无法解析 since 时间：${String(args.since)}（请用 ISO 8601 或毫秒时间戳）` };
      }
      fromTs = parsed;
    }
    let toTs = now;
    if (hasUntil) {
      const parsed = parseTimestamp(args.until);
      if (parsed == null) {
        return { error: `无法解析 until 时间：${String(args.until)}（请用 ISO 8601 或毫秒时间戳）` };
      }
      toTs = parsed;
    }
    if (fromTs > toTs) return { error: 'since 不能晚于 until' };
    return { fromTs, toTs };
  }

  if (hasWithin) {
    const minutes = Number(args.within_minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { error: `within_minutes 必须为正数：${String(args.within_minutes)}` };
    }
    return { fromTs: now - minutes * 60_000, toTs: now };
  }

  return null;
}

/** 交给模型的历史不含事件标记（CONTROL_KINDS，如压缩分隔线、指令的回复）：它们不是对话内容 */
const isSaid = (message: Message) => !CONTROL_KINDS.includes(message.kind ?? '');

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

function createSessionHistoryService(
  { memory, logger, sessionManager }: HistoryCaps,
  cfg: PluginConfig,
): SessionHistoryService {
  return {
    async getHistory(options, callCtx) {
      if (!memory.present) return { error: 'memory 服务不可用' };
      const store = memory.use;

      const targetSessionId = String(options.sessionId ?? '').trim();
      if (!targetSessionId) return { error: 'sessionId 不能为空' };

      // 逐个参与者过会话管理的规则：有人过不了（某个参与者自己私聊里的）时发一道参与者审批，由过得了的人批
      const verdict = await callCtx.approveFor(who =>
        takeFrom(sessionManager, callCtx.sessionId, targetSessionId, who),
      );
      if (!verdict.ok) return { error: toSource(verdict.reason) };

      const limit = Math.max(1, Math.min(cfg.maxLimit, Math.floor(Number(options.limit) || cfg.defaultLimit)));
      const includeArchived =
        typeof options.includeArchived === 'boolean' ? options.includeArchived : cfg.includeArchivedDefault;

      // 区间检索模式：给定 sinceTs / untilTs 任一即进入。区间查询天然含归档（含完整记录），
      // 故 include_archived 在此模式下不再区分，结果统一回显 includeArchived: true。
      const hasRange = typeof options.sinceTs === 'number' || typeof options.untilTs === 'number';

      try {
        if (hasRange) {
          const fromTs = typeof options.sinceTs === 'number' ? options.sinceTs : 0;
          const toTs = typeof options.untilTs === 'number' ? options.untilTs : Date.now();
          let ranged: Message[];
          // 区间后端（getMessagesBySessionRange）天然含归档；仅当退化到 getHistory 时才是「仅活跃」。
          let includesArchived = true;
          if (store.getMessagesBySessionRange) {
            ranged = await store.getMessagesBySessionRange(targetSessionId, fromTs, toTs);
          } else {
            // 后端不支持原生区间查询：退回扫描历史 + 客户端按时间过滤（best-effort，很早的窗口可能不全）。
            let base: Message[];
            if (store.getFullHistory) {
              base = await store.getFullHistory(targetSessionId, RANGE_FALLBACK_SCAN);
            } else {
              base = await store.getHistory(targetSessionId, RANGE_FALLBACK_SCAN);
              includesArchived = false; // getHistory 不含归档，诚实回显
            }
            ranged = base.filter(m => {
              const ts = m.timestamp ?? 0;
              return ts >= fromTs && ts <= toTs;
            });
          }
          // 区间查询按时间升序返回。窗口内超过 limit 时取**最早**的 limit 条（按阅读顺序、与「区间」语义一致），
          // 并以 truncated 明示「窗口内还有更多、请缩小窗口」——不再静默丢弃。
          // 注意：原生区间后端通常有约 500 条的硬上限，极大窗口可能在后端那步就已截断，故 truncated 为保守信号。
          const said = ranged.filter(isSaid);
          const sliced = said.slice(0, limit);
          const truncated = said.length > sliced.length;
          const result: SessionHistoryResult = {
            ok: true,
            sessionId: targetSessionId,
            count: sliced.length,
            limit,
            includeArchived: includesArchived,
            range: { fromTs, toTs },
            ...(truncated ? { truncated: true } : {}),
            messages: sliced.map((message, index) => formatHistoryMessage(message, index + 1, cfg.perMessageMaxChars)),
          };
          return result;
        }

        // 多读一倍再去掉事件标记，取最后 limit 条；还是凑不满时写明略去了几条非对话记录
        const read =
          includeArchived && store.getFullHistory
            ? await store.getFullHistory(targetSessionId, limit * 2)
            : await store.getHistory(targetSessionId, limit * 2);
        const said = read.filter(isSaid);
        const history = said.slice(-limit);
        const omitted = history.length < limit ? read.length - said.length : 0;
        const result: SessionHistoryResult = {
          ok: true,
          sessionId: targetSessionId,
          count: history.length,
          limit,
          includeArchived: includeArchived && !!store.getFullHistory,
          ...(omitted > 0 ? { omittedNonConversation: omitted } : {}),
          messages: history.map((message, index) => formatHistoryMessage(message, index + 1, cfg.perMessageMaxChars)),
        };
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.use.warn(`session-history 读取失败 (${targetSessionId}): ${message}`);
        return { error: `读取会话历史失败: ${message}` };
      }
    },
  };
}

function registerSessionHistoryTools(
  { tools, logger }: HistoryToolCaps,
  historyService: SessionHistoryService,
  cfg: PluginConfig,
): void {
  tools.use.registerGroup({
    name: 'session-history',
    label: '会话历史读取',
    description: '按 Aalis sessionId 读取近期会话历史，用于核实跨会话上下文',
  });

  tools.use.register({
    groups: ['session-history'],
    definition: {
      type: 'function',
      function: {
        name: 'session_get_history',
        description: [
          '按 Aalis sessionId 读取指定会话的消息。',
          '两种模式：',
          '①【条数】默认——读最近若干条（limit 控制），不含指令回复等非对话记录；',
          '  凑不满又略去了这类记录时，结果带 omittedNonConversation（略去的条数）。',
          '②【时间区间】给定 within_minutes（最近 N 分钟）或 since/until（绝对区间）时启用——',
          '  取该会话落在区间内的消息（含归档完整记录），按时间正序返回最早的 limit 条；',
          '  窗口内更多时结果带 truncated:true（请缩小时间窗再查）。',
          '适合在用户明确提到另一个会话、需要核实原文上下文、或要查「某段时间里聊了什么」时使用。',
          '能读哪些会话按会话管理的跨会话规则（默认同平台、不读别人的私聊）；不要把它当作全局搜索工具，语义检索请用 memory_recall。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: '目标 Aalis sessionId，例如 onebot:10000:group:20001' },
            limit: {
              type: 'number',
              description: `读取多少条（区间模式下为区间内上限），默认 ${cfg.defaultLimit}，最多 ${cfg.maxLimit}`,
            },
            include_archived: {
              type: 'boolean',
              description: '是否包含已归档消息（仅条数模式生效；区间模式恒含归档）。默认使用插件配置。',
            },
            within_minutes: {
              type: 'number',
              description: '时间区间：最近 N 分钟内的消息。与 since/until 互斥，后者优先。',
            },
            since: {
              type: 'string',
              description:
                '时间区间下界，ISO 8601（如 2026-06-15T08:00:00Z）或毫秒时间戳。给定 since/until 即进入区间模式。',
            },
            until: {
              type: 'string',
              description: '时间区间上界，ISO 8601 或毫秒时间戳。省略时默认取「现在」。',
            },
          },
          required: ['session_id'],
          additionalProperties: false,
        },
      },
    },
    // 读=信息暴露向量（可含跨会话日志/记忆），等级 1 起可用，挡住 0 级；不弹确认
    risk: 'sensitive',
    handler: async (args, callCtx) => {
      const targetSessionId = String(args.session_id ?? '').trim();
      if (!targetSessionId) return JSON.stringify({ error: 'session_id 不能为空' });
      const range = resolveTimeRange(args, Date.now());
      if (range && 'error' in range) return JSON.stringify({ error: range.error });
      const result = await historyService.getHistory(
        {
          sessionId: targetSessionId,
          limit: Number(args.limit) || undefined,
          includeArchived: typeof args.include_archived === 'boolean' ? args.include_archived : undefined,
          sinceTs: range ? range.fromTs : undefined,
          untilTs: range ? range.toTs : undefined,
        },
        callCtx,
      );
      return JSON.stringify(result);
    },
  });

  logger.use.info('会话历史读取工具已注册');
}

// ===== 插件入口 =====

export default definePlugin({
  name: '@aalis/plugin-tool-session',
  displayName: '会话工具',
  subsystem: 'session',
  configSchema,
  provides: [sessionHistory],
  uses,
  apply(caps) {
    const parsed = parseConfig(configSchema, caps.config.use, caps.logger.use);
    const maxLimit = Math.max(1, Math.min(1000, parsed.maxLimit || configSchema.maxLimit.default));
    const cfg: PluginConfig = {
      ...parsed,
      maxLimit,
      defaultLimit: Math.min(
        Math.max(1, Math.floor(parsed.defaultLimit || configSchema.defaultLimit.default)),
        maxLimit,
      ),
      perMessageMaxChars: Math.max(0, parsed.perMessageMaxChars),
    };
    if (!cfg.enabled) return;

    const historyService = createSessionHistoryService(caps, cfg);
    caps.provide.use(sessionHistory, historyService, { label: '会话历史读取' });
    registerSessionHistoryTools(caps, historyService, cfg);
  },
});
