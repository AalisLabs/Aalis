import type { ConfigSchema, Context } from '@aalis/core';
import type { MemoryService } from '@aalis/plugin-memory-api';
import type { IncomingMessage, Message } from '@aalis/plugin-message-api';
import { resolvePlatformBySession } from '@aalis/plugin-platform-api';
import type { AccessChecker, AccessCheckerDisposer, SessionHistoryService } from '@aalis/plugin-tool-session-api';
import type { ToolCallContext } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-agent-api';
import '@aalis/plugin-tools-api';
import '@aalis/plugin-tool-session-api';

// ===== 跨会话委派：proactive depth 防雪崩 =====
// 防止 A→B→C→... 无限链；任一会话被 delegate 进入 proactive 链路后，链上下一跳禁止再次 delegate。
const PROACTIVE_DEPTH_MAX = 1;
const PROACTIVE_DEPTH_TTL_MS = 10 * 60 * 1000;
const proactiveDepth = new Map<string, { depth: number; expiresAt: number }>();

function getProactiveDepth(sessionId: string): number {
  const entry = proactiveDepth.get(sessionId);
  if (!entry) return 0;
  if (entry.expiresAt <= Date.now()) {
    proactiveDepth.delete(sessionId);
    return 0;
  }
  return entry.depth;
}

function setProactiveDepth(sessionId: string, depth: number): void {
  proactiveDepth.set(sessionId, { depth, expiresAt: Date.now() + PROACTIVE_DEPTH_TTL_MS });
}

// ===== 插件元数据 =====

export const name = '@aalis/plugin-tool-session';
export const displayName = '会话工具';
export const subsystem = 'session';
export const provides = ['session-history'];
export const inject = {
  optional: ['memory'],
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用会话历史读取工具', default: true },
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
  crossSessionEnabled: {
    type: 'boolean',
    label: '启用跨会话委派 (delegate_to_session / list_known_sessions)',
    default: true,
    description:
      '允许 agent 列出其他活跃会话并向其派发任务（如私聊→群聊、跨平台委派）。受 proactive-depth 与平台限速保护。',
  },
  crossSessionDefaultTimeoutSec: {
    type: 'number',
    label: '跨会话委派默认等待秒数',
    default: 60,
    description: 'delegate_to_session 在未显式指定 timeout_seconds 时使用的等待上限。',
  },
};

interface PluginConfig {
  enabled: boolean;
  maxLimit: number;
  defaultLimit: number;
  scope: 'current' | 'platform' | 'all';
  includeArchivedDefault: boolean;
  perMessageMaxChars: number;
  crossSessionEnabled: boolean;
  crossSessionDefaultTimeoutSec: number;
}

interface SessionHistoryResult {
  ok: true;
  sessionId: string;
  count: number;
  limit: number;
  includeArchived: boolean;
  messages: Array<Record<string, unknown>>;
}

function resolveConfig(raw: Record<string, unknown>): PluginConfig {
  const scopeRaw = raw.scope;
  const scope = scopeRaw === 'current' || scopeRaw === 'all' ? scopeRaw : 'platform';
  const maxLimit = Math.max(1, Math.min(1000, Number(raw.maxLimit) || 100));
  const defaultLimitRaw = Math.max(1, Math.floor(Number(raw.defaultLimit) || 20));
  return {
    enabled: raw.enabled !== false,
    maxLimit,
    defaultLimit: Math.min(defaultLimitRaw, maxLimit),
    scope,
    includeArchivedDefault: raw.includeArchivedDefault === true,
    perMessageMaxChars: Math.max(0, Number(raw.perMessageMaxChars) || 0),
    crossSessionEnabled: raw.crossSessionEnabled !== false,
    crossSessionDefaultTimeoutSec: Number(raw.crossSessionDefaultTimeoutSec) || 60,
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
  checkers: readonly AccessChecker[],
  callCtx: ToolCallContext,
): { ok: true } | { ok: false; reason: string } {
  // 0. scope 粗筛
  if (targetSessionId === currentSessionId) {
    // 同会话仍允许平台 checker 表态（防御性）
  } else if (scope === 'current') {
    return { ok: false, reason: '当前配置仅允许读取当前会话历史' };
  } else if (scope === 'platform') {
    const current = currentPlatform || parsePlatform(currentSessionId);
    const target = parsePlatform(targetSessionId);
    if (!current || !target || current !== target) {
      return {
        ok: false,
        reason: `当前配置仅允许读取同平台会话历史（当前=${current || 'unknown'}, 目标=${target || 'unknown'}）`,
      };
    }
  }
  // scope === 'all' 直接走 checker 链

  // 1. 找匹配目标 platform 的 checker，any-deny 短路；无匹配 checker 默认通过
  const targetPlatform = parsePlatform(targetSessionId);
  const matched = checkers.filter(c => c.platform === targetPlatform);
  for (const checker of matched) {
    const verdict = checker.check({ currentSessionId, targetSessionId, callCtx });
    if (verdict?.decision === 'deny') {
      return { ok: false, reason: verdict.reason || `平台 ${targetPlatform} 拒绝此次跨会话访问` };
    }
  }
  return { ok: true };
}

function createSessionHistoryService(ctx: Context, cfg: PluginConfig): SessionHistoryService {
  const checkers: AccessChecker[] = [];

  return {
    registerAccessChecker(checker: AccessChecker): AccessCheckerDisposer {
      checkers.push(checker);
      return () => {
        const idx = checkers.indexOf(checker);
        if (idx >= 0) checkers.splice(idx, 1);
      };
    },

    async getHistory(options, callCtx) {
      const memory = ctx.getService<MemoryService>('memory');
      if (!memory) return { error: 'memory 服务不可用' };

      const targetSessionId = String(options.sessionId ?? '').trim();
      if (!targetSessionId) return { error: 'sessionId 不能为空' };

      const verdict = canReadSessionHistory(
        callCtx.sessionId,
        targetSessionId,
        callCtx.platform,
        cfg.scope,
        checkers,
        callCtx,
      );
      if (!verdict.ok) return { error: verdict.reason };

      const limit = Math.max(1, Math.min(cfg.maxLimit, Math.floor(Number(options.limit) || cfg.defaultLimit)));
      const includeArchived =
        typeof options.includeArchived === 'boolean' ? options.includeArchived : cfg.includeArchivedDefault;

      try {
        const history =
          includeArchived && memory.getFullHistory
            ? await memory.getFullHistory(targetSessionId, limit)
            : await memory.getHistory(targetSessionId, limit);
        const result: SessionHistoryResult = {
          ok: true,
          sessionId: targetSessionId,
          count: history.length,
          limit,
          includeArchived: includeArchived && !!memory.getFullHistory,
          messages: history.map((message, index) => formatHistoryMessage(message, index + 1, cfg.perMessageMaxChars)),
        };
        return result;
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
            limit: {
              type: 'number',
              description: `读取最近多少条，默认 ${cfg.defaultLimit}，最多 ${cfg.maxLimit}`,
            },
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

function registerCrossSessionTools(ctx: Context, cfg: PluginConfig): void {
  useToolService(ctx).registerGroup({
    name: 'session-delegate',
    label: '跨会话派发',
    description: '向已存在的其他会话（如另一个群、另一个 QQ 好友、另一个平台）派发任务并可选等待结果。',
  });

  // ---- list_known_sessions ----
  // 列出最近活跃的会话（按平台/最近活跃时间），供 agent 在 delegate 前发现可派发目标，
  // 避免凭空拼接 sessionId 出错。基于 memory 的 getRecentMessagesAcrossSessions 能力。
  useToolService(ctx).register({
    groups: ['session-delegate'],
    definition: {
      type: 'function',
      function: {
        name: 'list_known_sessions',
        description: [
          '列出 agent 最近活跃过的会话，按最近活动时间倒序返回，用于 delegate_to_session 之前发现目标 sessionId。',
          '',
          '【返回字段】',
          '- session_id：完整 sessionId（可直接用于 delegate_to_session 的 target_session_id）',
          '- platform：所属平台（如 onebot / webui / scheduler）',
          '- last_activity_ts：最近一条消息的时间戳（毫秒）',
          '- preview：最近一条消息的内容预览（截断到 80 字）',
          '',
          '【注意】',
          '- 仅返回 memory 中存在历史的会话；从未对话过的群/好友需要用平台专属工具（如 onebot_get_group_list）查询。',
          '- 默认排除当前会话本身。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: '最大返回会话数（默认 20，最大 100）',
            },
            platform: {
              type: 'string',
              description: '仅返回指定平台的会话（如 "onebot"）；省略则不限平台',
            },
            since_hours: {
              type: 'number',
              description: '仅返回最近 N 小时内有活动的会话（默认 168 小时 = 7 天）',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const memory = ctx.getService<MemoryService>('memory');
      if (!memory?.getRecentMessagesAcrossSessions) {
        return JSON.stringify({
          error: '当前 memory 服务不支持 getRecentMessagesAcrossSessions 能力',
        });
      }
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const sinceHours =
        Number.isFinite(Number(args.since_hours)) && Number(args.since_hours) > 0 ? Number(args.since_hours) : 168;
      const platformFilter =
        typeof args.platform === 'string' && args.platform.trim().length > 0 ? args.platform.trim() : undefined;
      const sinceTs = Date.now() - sinceHours * 3600 * 1000;

      // 多取一些消息再按 session 聚合，确保 limit 个会话能凑齐
      const records = await memory.getRecentMessagesAcrossSessions({
        limit: Math.max(limit * 10, 200),
        sinceTs,
        platform: platformFilter,
        excludeSessionIds: callCtx.sessionId ? [callCtx.sessionId] : undefined,
        roles: ['user', 'assistant'],
      });

      const bySession = new Map<string, { sessionId: string; platform?: string; lastTs: number; preview: string }>();
      for (const rec of records) {
        const ts = rec.message.timestamp ?? 0;
        const existing = bySession.get(rec.sessionId);
        if (!existing || ts > existing.lastTs) {
          const content = typeof rec.message.content === 'string' ? rec.message.content : '';
          const preview = content.length > 80 ? `${content.slice(0, 80)}...` : content;
          const platform =
            (rec.message.metadata as Record<string, unknown> | undefined)?.platform != null
              ? String((rec.message.metadata as Record<string, unknown>).platform)
              : rec.sessionId.split(':')[0] || undefined;
          bySession.set(rec.sessionId, {
            sessionId: rec.sessionId,
            platform,
            lastTs: ts,
            preview,
          });
        }
      }

      const items = [...bySession.values()]
        .sort((a, b) => b.lastTs - a.lastTs)
        .slice(0, limit)
        .map(s => ({
          session_id: s.sessionId,
          platform: s.platform,
          last_activity_ts: s.lastTs,
          preview: s.preview,
        }));

      return JSON.stringify({
        count: items.length,
        since_hours: sinceHours,
        sessions: items,
      });
    },
  });

  // ---- delegate_to_session ----
  // 向已存在的目标会话派发一次任务，目标会话的 agent 在自己原本的人设/记忆/工具集下完整推理；
  // 与 create_subtask 不同：目标不是新建的"子会话"，而是任意已知 sessionId（如群聊、私聊、跨平台）。
  useToolService(ctx).register({
    groups: ['session-delegate'],
    definition: {
      type: 'function',
      function: {
        name: 'delegate_to_session',
        description: [
          '向指定的目标会话（target_session_id）派发一次任务，目标会话的 agent 会在它自己的人设、记忆、工具集、',
          '平台环境下自主完成一次完整推理（可能调用工具、分多段回复等）。',
          '',
          '【典型使用场景】',
          '- 你在私聊里被要求"去 xx 群禁言 yyy"：群管理类工具只能在群聊会话内调用，',
          '  此时应 delegate 到该群 sessionId，让群里的 agent 执行 onebot_group_ban。',
          '- 跨平台转告：把消息从 webui 转告到某个 QQ 群。',
          '- 主动联系某位好友 / 在某个群发布公告。',
          '',
          '【与 create_subtask 区别】',
          '- create_subtask：新建一个"子会话"分支，状态独立、有 parent/child 关系，用于把当前任务拆分成并行子任务。',
          '- delegate_to_session：目标是已经存在（或将以平台身份存在）的会话，没有 parent/child 关系，',
          '  对目标会话来说就像收到一条"主动消息"。',
          '',
          '【sessionId 怎么拿】',
          '- OneBot 群/私聊：onebot:<selfId>:group:<群号> 或 onebot:<selfId>:private:<QQ号>，',
          '  也可先调用 onebot_resolve_session_id 转换。',
          '- 其他平台：参考各平台 adapter 的 sessionId 约定。',
          '',
          '【安全限制】',
          '- 防雪崩：被 delegate 进来的会话最多再链一层（A→B 允许，B 在 proactive 链中不能再 delegate）。',
          '- 平台限速：平台 adapter 可声明 checkAndRecordProactiveSend 做主动发送频率限制，超额会被拒绝。',
          '- 自委派被禁止：target_session_id 不能等于当前 sessionId。',
          '',
          '【wait_for_result】',
          '- true（默认）：同步等待目标 agent 完成一轮回复，把对方 reply 文本返回给你，最长等 timeout_seconds 秒。',
          '- false：fire-and-forget，立刻返回"已派发"，不阻塞当前会话。',
          '',
          '【返回值字段】',
          '- outcome: replied / silent / aborted。silent 表示目标 agent 本轮 reply 为空（可能在执行工具未发文本、',
          '  或被中间件吞掉、或目标策略层主动静默）；reply="" 不代表任务一定已完成。',
          '- reply: 目标 agent 真正对外发出的可见文本（可能为空）。',
          '- personaState: 可选字段。若目标会话挂载了 persona 且本轮产出结构化状态，则附带，用于辅助判断；',
          '  不挂载或未产出时不出现，不要假设它一定存在。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            target_session_id: {
              type: 'string',
              description: '目标会话完整 sessionId（如 "onebot:10000:group:20002"）',
            },
            task: {
              type: 'string',
              description:
                '给目标会话 agent 的任务说明。注意这不是要原样发出的文本，而是"该做什么/该说什么"的指令，' +
                '目标 agent 会按自己的风格、记忆、工具集组织措辞和动作。',
            },
            wait_for_result: {
              type: 'boolean',
              description: '是否同步等待目标 agent 完成本轮回复并把内容返回。默认 true。',
            },
            timeout_seconds: {
              type: 'number',
              description: `wait_for_result=true 时的等待上限，默认 ${cfg.crossSessionDefaultTimeoutSec} 秒，最大 300 秒。`,
            },
          },
          required: ['target_session_id', 'task'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const targetSessionId = String(args.target_session_id ?? '').trim();
      const task = String(args.task ?? '');
      const waitForResult = args.wait_for_result === undefined ? true : args.wait_for_result === true;
      const requestedTimeoutSec = Number(args.timeout_seconds);
      const timeoutSec =
        Number.isFinite(requestedTimeoutSec) && requestedTimeoutSec > 0
          ? Math.min(300, requestedTimeoutSec)
          : cfg.crossSessionDefaultTimeoutSec;
      const timeoutMs = Math.max(1000, timeoutSec * 1000);

      if (!targetSessionId) return JSON.stringify({ error: 'target_session_id 不能为空' });
      if (!task.trim()) return JSON.stringify({ error: 'task 不能为空' });
      if (targetSessionId === callCtx.sessionId) {
        return JSON.stringify({ error: 'target_session_id 不能等于当前会话；如需自我追问请直接生成下一轮回复。' });
      }

      // 防雪崩：源 depth + 1 即将传给目标
      const sourceDepth = getProactiveDepth(callCtx.sessionId);
      const targetDepth = sourceDepth + 1;
      if (targetDepth > PROACTIVE_DEPTH_MAX) {
        return JSON.stringify({
          error: `委派链已达最大深度 ${PROACTIVE_DEPTH_MAX}（当前会话本身正以 proactive 链路被驱动，禁止再次 delegate 以防雪崩）`,
        });
      }

      // 解析目标平台，应用可选限速闸门
      let platformName: string | undefined;
      try {
        const adapter = await resolvePlatformBySession(ctx, targetSessionId);
        if (adapter) {
          platformName = adapter.platform;
          const gate = adapter.checkAndRecordProactiveSend;
          if (typeof gate === 'function') {
            const verdict = gate.call(adapter, targetSessionId);
            if (!verdict.allowed) {
              return JSON.stringify({ error: `委派被平台限速拦截：${verdict.reason ?? '超出限速阈值'}` });
            }
          }
        }
      } catch (err) {
        ctx.logger.warn(`[delegate] 解析目标平台失败 (${targetSessionId}): ${err}`);
      }

      // 标记目标进入 proactive 链路
      setProactiveDepth(targetSessionId, targetDepth);

      const incoming: IncomingMessage = {
        content: task,
        sessionId: targetSessionId,
        platform: platformName ?? callCtx.platform ?? 'internal',
        source: `proactive:from:${callCtx.sessionId}`,
        triggerType: 'proactive',
      };

      const taskPreview =
        task.length > 80 ? `${task.slice(0, 80)}... (+${task.length - 80}字，全文已完整传递给目标会话)` : task;
      ctx.logger.info(
        `[delegate] from=${callCtx.sessionId} -> ${targetSessionId} depth=${targetDepth} wait=${waitForResult} task="${taskPreview}"`,
      );

      if (!waitForResult) {
        ctx.emit('inbound:message', incoming).catch(err => {
          ctx.logger.warn(`[delegate] 派发失败 (${targetSessionId}): ${err}`);
        });
        return JSON.stringify({
          delegated: true,
          targetSessionId,
          wait: false,
          depth: `${targetDepth}/${PROACTIVE_DEPTH_MAX}`,
          message: '已派发，不等待目标会话结果',
        });
      }

      // wait_for_result=true：在派发前注册 agent:turn:after 监听，捕获目标 sessionId 的首条 reply
      let captured: { reply: string; outcome: string } | undefined;
      let resolveWait: (() => void) | undefined;
      const waitPromise = new Promise<void>(resolve => {
        resolveWait = resolve;
      });
      const dispose = ctx.middleware('agent:turn:after', async (data, next) => {
        await next();
        if (captured) return;
        if (data.sessionId !== targetSessionId) return;
        captured = { reply: data.reply ?? '', outcome: data.outcome };
        resolveWait?.();
      });

      const timeoutHandle = setTimeout(() => resolveWait?.(), timeoutMs);
      try {
        await ctx.emit('inbound:message', incoming);
        await waitPromise;
      } finally {
        clearTimeout(timeoutHandle);
        dispose();
      }

      if (!captured) {
        return JSON.stringify({
          delegated: true,
          targetSessionId,
          wait: true,
          timedOut: true,
          depth: `${targetDepth}/${PROACTIVE_DEPTH_MAX}`,
          message: `已派发但在 ${timeoutSec}s 内未捕获 agent:turn:after（目标可能仍在执行或被中间件 swallow）`,
        });
      }
      const replyTruncated =
        captured.reply.length > 2000
          ? `${captured.reply.slice(0, 2000)}\n...[已截断, 原长 ${captured.reply.length} 字]`
          : captured.reply;

      // 可选附加：若目标会话挂载了 persona service 且本轮产出结构化状态，附带返回；
      // 不挂载或未产出时不放该字段，避免上游对「persona 一定存在」做假设。
      let personaState: Record<string, unknown> | undefined;
      try {
        const personaService = ctx.getService<{
          getSessionState?: (sid: string) => Record<string, unknown> | undefined;
        }>('persona');
        const state = personaService?.getSessionState?.(targetSessionId);
        if (state && Object.keys(state).length > 0) {
          personaState = state;
        }
      } catch {
        // service 未启用 / 未提供接口，静默忽略
      }

      const payload: Record<string, unknown> = {
        delegated: true,
        targetSessionId,
        wait: true,
        timedOut: false,
        outcome: captured.outcome,
        reply: replyTruncated,
        depth: `${targetDepth}/${PROACTIVE_DEPTH_MAX}`,
      };
      if (personaState) payload.personaState = personaState;
      return JSON.stringify(payload);
    },
  });

  ctx.logger.info('跨会话协作工具已注册');
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  const historyService = createSessionHistoryService(ctx, cfg);
  ctx.provide('session-history', historyService, { label: '会话历史读取' });
  registerSessionHistoryTools(ctx, historyService, cfg);

  if (cfg.crossSessionEnabled) {
    registerCrossSessionTools(ctx, cfg);
  }
}
