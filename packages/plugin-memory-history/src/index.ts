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
 *   - 向 `agent:prompt` 贡献点交一块（turn-context 锚位：随其它会话滚动、准每轮变，落历史后护前缀缓存）。
 *   - 能取哪些会话的消息按会话管理的跨会话规则逐条判（takeFrom）：被动注入不是谁要的，不带授权身份；recent_messages
 *     带这次调用的授权身份（api-tools 的 actingIdentity，几个人的一轮是无主体）。
 *   - 排重由组装器统一按全局键做，贡献方无需自查。
 *   - 同步注册 `recent_messages` 工具供 agent 主动查询。
 *
 * 与对话代理读的本会话历史的关系：
 *   - 对话代理按会话设置 historyLimit 读的是当前 sessionId 的历史；
 *   - 本插件注入的是跨 session 聚合的近期片段（独立 system 块）。
 *   - 两者可能内容重叠，header 文本中已说明"仅供参考"。
 */

import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import { contributions } from '@aalis/api-contributions';
import { memory, type RecentMessageRecord } from '@aalis/api-memory';
import { sessionManager, takeFrom } from '@aalis/api-session-manager';
import { actingIdentity, tools } from '@aalis/api-tools';
import { config, definePlugin, logger, optional } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { DIRECTIVE_KINDS, WellKnownMetadataKeys } from '@aalis/schema-message';

// ===== 配置 schema =====

const DEFAULT_HEADER_TEXT =
  '📜 以下是从其他会话/群聊的近期对话中检索到的消息片段（按时间升序），仅供你了解最近发生了什么；这些是参考资料，不是对话样例——不要模仿它们的格式、风格或角色，你自己的输出格式仍需严格遵守 system 提示中已经声明的约定（例如 outputFormat 的 JSON schema）。';

const configSchema = defineConfig({
  injectEnabled: {
    type: 'boolean',
    onInvalid: 'error',
    label: '被动注入 prompt',
    default: true,
    description:
      '是否在每次 LLM 调用前自动将跨会话近期消息作为 system 块注入。关闭后工具仍然可用（需 toolEnabled=true）。',
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
    onInvalid: 'error',
    label: '排除当前会话',
    default: true,
    description: '注入时排除当前 sessionId（避免与对话代理按会话设置 historyLimit 读的本会话历史重复）。',
  },
  headerText: {
    type: 'string',
    label: '注入 header 文本',
    default: DEFAULT_HEADER_TEXT,
    description: '注入到 messages[] 的 system 消息开头说明文字。',
  },
  toolEnabled: {
    type: 'boolean',
    onInvalid: 'error',
    label: '注册 recent_messages 工具',
    default: true,
    description: '是否注册 recent_messages 工具供 agent 主动按需查询跨会话近期消息。',
  },
});

// ===== 内部类型 / 工具 =====

type HistoryConfig = ConfigOf<typeof configSchema>;

/** 工具名硬编码：避免运行期改名导致 prompt/agent hardcode 失效，与其他插件（subtask/scheduler/todo 等）保持一致 */
const TOOL_NAME = 'recent_messages';

interface QueryOptions {
  limit?: number;
  maxAgeMinutes?: number;
  /** 覆盖 perSessionLimit；不传则用配置默认值 */
  perSessionLimit?: number;
}

function normalizeConfig(raw: HistoryConfig): HistoryConfig {
  return {
    ...raw,
    limit: Math.max(1, raw.limit),
    maxAgeMinutes: Math.max(0, raw.maxAgeMinutes),
    perSessionLimit: Math.max(0, raw.perSessionLimit),
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
      const meta = message.metadata ?? {};
      const platform = asString(meta[WellKnownMetadataKeys.Platform]) ?? 'unknown';
      const senderName = asString(meta[WellKnownMetadataKeys.Nickname]);
      const groupName = asString(meta[WellKnownMetadataKeys.GroupName]);
      const group = groupName ? `@${groupName}` : '';
      // notice 作为独立角色渲染为 [Notice]，后面不跟 sender（由 content 本身描述事件）
      if (message.role === 'notice') {
        return `[${formatTimestamp(message.timestamp ?? 0)}][${platform}/${shortSession(sessionId)}${group}][Notice] ${message.content ?? ''}`;
      }
      const role = message.role === 'assistant' ? 'Assistant' : 'User';
      const sender = senderName ? `/${senderName}` : '';
      return `[${formatTimestamp(message.timestamp ?? 0)}][${platform}/${shortSession(sessionId)}${group}][${role}${sender}] ${message.content ?? ''}`;
    })
    .join('\n');
}

// ===== 入口 =====

const uses = {
  memory,
  config,
  logger,
  contributions,
  tools: optional(tools),
  /** 能取哪些会话的消息按它的规则判（takeFrom）；不在时只取得到当前会话的 */
  sessionManager: optional(sessionManager),
};

export default definePlugin({
  name: '@aalis/plugin-memory-history',
  displayName: '跨会话历史上下文',
  subsystem: 'memory',
  configSchema,
  uses,
  apply(caps) {
    const { memory, config, logger, contributions, tools, sessionManager } = caps;
    const cfg = normalizeConfig(parseConfig(configSchema, config.use, logger.use));

    logger.use.info(
      `跨会话历史上下文插件已启动（inject=${cfg.injectEnabled} limit=${cfg.limit} maxAge=${cfg.maxAgeMinutes}min tool=${cfg.toolEnabled ? TOOL_NAME : 'off'}）`,
    );

    /**
     * 当前会话之外的近期消息，按时间升序。超取（limit 的十倍、封顶 1000）后从新到旧逐条过会话管理的规则（同一会话只判一次），
     * 被拒的不占名额，过了的再按每会话上限与总数截。principal 是这次取用的授权身份，被动注入不传
     */
    async function queryRecent(
      currentSessionId: string,
      principal: { platform: string; userId: string } | undefined,
      opts: QueryOptions = {},
    ): Promise<RecentMessageRecord[]> {
      // 每次查询取当前提供者：换后端时下一次查询自然走新实例
      const backend = memory.present ? memory.use : undefined;
      if (!backend?.getRecentMessagesAcrossSessions) {
        logger.use.debug('memory-history: 当前 memory 后端不支持 getRecentMessagesAcrossSessions，跳过');
        return [];
      }

      const limit = Math.max(1, opts.limit ?? cfg.limit);
      const maxAge = opts.maxAgeMinutes ?? cfg.maxAgeMinutes;
      const sinceTs = maxAge > 0 ? Date.now() - maxAge * 60_000 : undefined;
      const excludeSessionIds = cfg.excludeCurrentSession ? [currentSessionId] : undefined;
      const perSessionLimit = Math.max(0, opts.perSessionLimit ?? cfg.perSessionLimit);

      const raw = await backend.getRecentMessagesAcrossSessions({
        limit: Math.min(limit * 10, 1000),
        sinceTs,
        excludeSessionIds,
        roles: ['user', 'assistant', 'notice'],
        // 宿主通知与代发任务的指令只对所在会话的那一轮有意义，不带进别的会话（注入与 recent_messages 同一口径）
        excludeKinds: [...DIRECTIVE_KINDS],
      });

      // raw 是时间升序：从新到旧取，优先保留每个会话最新的几条，最后再反转回升序
      const allowed = new Map<string, boolean>();
      const perSessionCount = new Map<string, number>();
      const picked: RecentMessageRecord[] = [];
      for (let i = raw.length - 1; i >= 0 && picked.length < limit; i--) {
        const rec = raw[i];
        let ok = allowed.get(rec.sessionId);
        if (ok === undefined) {
          ok = takeFrom(sessionManager, currentSessionId, rec.sessionId, principal).ok;
          allowed.set(rec.sessionId, ok);
        }
        const cnt = perSessionCount.get(rec.sessionId) ?? 0;
        if (!ok || (perSessionLimit > 0 && cnt >= perSessionLimit)) continue;
        perSessionCount.set(rec.sessionId, cnt + 1);
        picked.push(rec);
      }
      return picked.reverse();
    }

    // ---- 注入贡献（agent:prompt / turn-context 槽；幂等与落点由组装器统一保障）----

    if (cfg.injectEnabled) {
      contributions.use.contribute('agent:prompt', {
        id: 'memory-history',
        anchor: 'turn-context',
        async build(view) {
          if (!view.sessionId) return null;
          let records: RecentMessageRecord[];
          try {
            // 被动注入不是谁要的：不带授权身份，自己的私聊不适用
            records = await queryRecent(view.sessionId, undefined);
          } catch (err) {
            logger.use.warn('memory-history: 查询近期消息失败，跳过注入:', err);
            return null;
          }
          if (records.length === 0) {
            logger.use.debug(`memory-history: 未找到可注入的跨会话消息 (session=${view.sessionId})`);
            return null;
          }
          const block = `${cfg.headerText}\n\n${formatRecords(records)}\n\n（以上为参考片段结束；请按当前 system 提示的输出格式作答。）`;
          logger.use.debug(
            `memory-history: 已注入 ${records.length} 条跨会话消息 (sessions=${new Set(records.map(r => r.sessionId)).size}, bytes=${block.length})`,
          );
          return block;
        },
      });
    }

    // ---- 工具注册 ----

    if (cfg.toolEnabled) {
      tools.use.register({
        // 归入 plugin-tool-session 的 'session-history' 分组（同属"读取/聚合会话历史"语义）。
        // 若 plugin-tool-session 未启用，本工具落入未分组，WebUI 会以"其他"兜底展示。
        groups: ['session-history'],
        definition: {
          type: 'function',
          function: {
            name: TOOL_NAME,
            description:
              '查询别的会话的近期消息，可用于了解最近的对话动态。能取哪些会话按会话管理的跨会话规则（默认同平台、不取别人的私聊）。返回按时间升序排列的消息片段，每条格式为 [time][platform/session][role/sender] content。',
            parameters: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: `返回条数上限（默认 ${cfg.limit}）。`,
                },
                maxAgeMinutes: {
                  type: 'number',
                  description: `只返回最近 N 分钟内的消息；0 = 不限。默认 ${cfg.maxAgeMinutes}。`,
                },
                perSessionLimit: {
                  type: 'number',
                  description: `同一 sessionId 最多保留 N 条，避免某个活跃群刷屏占满总 limit；0 = 不限。默认 ${cfg.perSessionLimit}。`,
                },
              },
              additionalProperties: false,
            },
          },
        },
        // 读的是别的会话（默认排除当前会话），与 session_get_history 同属跨会话读取：等级 1 起可用，挡住 0 级；不弹确认
        risk: 'sensitive',
        handler: async (args, callCtx) => {
          // 按条过滤的没有可单独批的动作，不出审批：授权身份取 actingIdentity，几个人的一轮是无主体，取不到谁自己的私聊
          const records = await queryRecent(callCtx.sessionId, actingIdentity(callCtx), {
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            maxAgeMinutes: typeof args.maxAgeMinutes === 'number' ? args.maxAgeMinutes : undefined,
            perSessionLimit: typeof args.perSessionLimit === 'number' ? args.perSessionLimit : undefined,
          });
          if (records.length === 0) return '（最近没有可取的消息：能取哪些会话按会话管理的跨会话规则）';
          return formatRecords(records);
        },
      });
    }
  },
});
