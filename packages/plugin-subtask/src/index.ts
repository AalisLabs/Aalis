import type { ConfigSchema, Context } from '@aalis/core';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import { resolvePlatformBySession } from '@aalis/plugin-platform-api';
import type { SessionInfo, SessionManagerService } from '@aalis/plugin-session-manager-api';
import { useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-agent-api';
import '@aalis/plugin-tools-api';

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

export const name = '@aalis/plugin-subtask';
export const displayName = '子任务';
export const subsystem = 'session';
export const inject = {
  optional: ['session-manager', 'message-archive'],
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用子任务工具', default: true },
  pollIntervalMs: { type: 'number', label: '等待轮询间隔 (ms)', default: 3000 },
  maxWaitMs: { type: 'number', label: '单次等待最大时长 (ms)', default: 300000 },
  crossSessionEnabled: {
    type: 'boolean',
    label: '启用跨会话委派 (delegate_to_session)',
    default: true,
    description:
      '允许 agent 向任意已知 sessionId 派发任务（如私聊→群聊、跨平台委派）。受 proactive-depth 与平台限速保护。',
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
  pollIntervalMs: number;
  maxWaitMs: number;
  crossSessionEnabled: boolean;
  crossSessionDefaultTimeoutSec: number;
}

function resolveConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    enabled: raw.enabled !== false,
    pollIntervalMs: Number(raw.pollIntervalMs) || 3000,
    maxWaitMs: Number(raw.maxWaitMs) || 300000,
    crossSessionEnabled: raw.crossSessionEnabled !== false,
    crossSessionDefaultTimeoutSec: Number(raw.crossSessionDefaultTimeoutSec) || 60,
  };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  // 注册工具分组
  useToolService(ctx).registerGroup({
    name: 'subtask',
    label: '子任务管理',
    description: '创建、管理和协调子任务会话，支持并行执行',
  });

  if (cfg.crossSessionEnabled) {
    useToolService(ctx).registerGroup({
      name: 'cross-session',
      label: '跨会话协作',
      description: '向已存在的其他会话（如另一个群、另一个 QQ 好友、另一个平台）派发任务并可选等待结果。',
    });
  }

  // ---- create_subtask ----
  useToolService(ctx).register({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'create_subtask',
        description: [
          '创建一个子任务会话并异步派发任务。子任务将在独立会话中并行执行，不阻塞当前会话。',
          '返回子任务 ID，后续可用 check_subtask 查询状态或 wait_subtasks 等待完成。',
          '你可以连续调用多次 create_subtask 来创建多个并行子任务。',
          '',
          '【重要协作规范】',
          '1. 创建子任务前，先用 manage_todo_list 列出计划，包含"创建子任务"和"等待子任务完成"两步',
          '2. 共享文档协作：如果多个子任务需要操作同一个文档（如 PPT、Word、Excel），先在主会话中创建文档拿到 docId，然后在 task 中明确告知子任务该 docId——子任务会直接操作同一文档，无需各自创建',
          '3. task 描述中应包含：(a) 具体任务内容 (b) 需要使用的共享资源 ID（如 docId）(c) 子任务负责的范围（如"负责第3-4张幻灯片"）',
          '4. 创建完所有子任务后，必须立即调用 wait_subtasks 等待结果，不要在未等待的情况下继续主任务',
          '5. 子任务无法调用 create_subtask（不可嵌套）；保持 save 操作在主会话中执行',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '要派发给子任务的详细任务描述/指令',
            },
            name: {
              type: 'string',
              description: '子任务显示名称（可选，默认自动生成）',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const sm = ctx.getService<SessionManagerService>('session-manager');
      if (!sm) return JSON.stringify({ error: 'session-manager 服务不可用' });

      const task = String(args.task || '');
      if (!task) return JSON.stringify({ error: '缺少任务描述' });

      const parentId = callCtx.sessionId;

      // 防止子任务嵌套创建子任务
      const parentSession = sm.getSession(parentId);
      if (parentSession?.parentId) {
        return JSON.stringify({ error: '子任务中不能再创建子任务。请直接完成当前任务，由父会话负责任务拆分和协调。' });
      }

      const taskName = args.name
        ? String(args.name)
        : `子任务 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;

      try {
        // 子会话复制父会话的 resolved config
        const inheritedConfig = sm.resolveConfig(parentId, callCtx.platform);

        // 创建子会话（存储 platform 用于后续自动触发）
        const child = await sm.createChildSession(parentId, {
          name: taskName,
          createdBy: 'agent',
          inputContext: task,
          config: { ...inheritedConfig },
          metadata: { platform: callCtx.platform || 'internal', title: taskName },
        });

        // 异步派发任务消息，触发 agent 处理（不等待完成）
        ctx
          .emit('inbound:message', {
            content: task,
            sessionId: child.id,
            platform: callCtx.platform || 'internal',
            userId: `parent:${parentId}`,
            nickname: undefined,
          } satisfies IncomingMessage)
          .catch(err => {
            ctx.logger.warn(`子任务消息派发失败 (${child.id}):`, err);
          });

        return JSON.stringify({
          subtaskId: child.id,
          name: taskName,
          status: 'active',
          message: `子任务 "${taskName}" 已创建并开始执行`,
        });
      } catch (err) {
        return JSON.stringify({ error: `创建子任务失败: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  // ---- check_subtask ----
  useToolService(ctx).register({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'check_subtask',
        description: [
          '查询一个或多个子任务的当前状态和结果。',
          '返回每个子任务的状态（active=进行中, completed=已完成, error=出错）、结果摘要等。',
          '如果有子任务状态为 error，可使用 send_to_subtask 重新发送指令让其重试。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '要查询的子任务 ID 列表',
            },
          },
          required: ['subtask_ids'],
          additionalProperties: false,
        },
      },
    },
    handler: async args => {
      const sm = ctx.getService<SessionManagerService>('session-manager');
      if (!sm) return JSON.stringify({ error: 'session-manager 服务不可用' });

      const ids = (args.subtask_ids as string[]) || [];
      if (ids.length === 0) {
        return JSON.stringify({
          error: '缺少 subtask_ids 参数。正确用法: { "subtask_ids": ["<子任务ID1>", "<子任务ID2>"] }',
        });
      }
      const results = ids.map(id => {
        const session = sm.getSession(id);
        if (!session) return { id, error: '会话不存在' };
        const statusLabel =
          session.status === 'active'
            ? '进行中'
            : session.status === 'completed'
              ? '已完成'
              : session.status === 'error'
                ? '出错'
                : session.status;
        return {
          id,
          name: session.name,
          status: session.status,
          statusLabel,
          result: session.result || null,
          inputContext: session.inputContext || null,
        };
      });

      const summary = {
        total: results.length,
        active: results.filter(r => !('error' in r) && r.status === 'active').length,
        completed: results.filter(r => !('error' in r) && r.status === 'completed').length,
        errored: results.filter(r => !('error' in r) && r.status === 'error').length,
      };

      return JSON.stringify({ summary, subtasks: results });
    },
  });

  // ---- send_to_subtask ----
  useToolService(ctx).register({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'send_to_subtask',
        description: [
          '向子任务会话发送追加消息（追问、补充指令等）。',
          '消息将作为父会话用户身份注入子任务，触发子任务 agent 继续处理。',
          '子任务如已完成，将被重新激活为 active 状态。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_id: {
              type: 'string',
              description: '子任务会话 ID',
            },
            message: {
              type: 'string',
              description: '要发送给子任务的消息内容',
            },
          },
          required: ['subtask_id', 'message'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const sm = ctx.getService<SessionManagerService>('session-manager');
      if (!sm) return JSON.stringify({ error: 'session-manager 服务不可用' });

      const subtaskId = String(args.subtask_id || '');
      const message = String(args.message || '');
      if (!subtaskId || !message) return JSON.stringify({ error: '缺少子任务 ID 或消息内容' });

      const session = sm.getSession(subtaskId);
      if (!session) return JSON.stringify({ error: `子任务不存在: ${subtaskId}` });

      // 如果子任务已完成，重新激活
      if (session.status === 'completed') {
        await sm.updateSession(subtaskId, { status: 'active' });
      }

      // 派发消息
      ctx
        .emit('inbound:message', {
          content: message,
          sessionId: subtaskId,
          platform: callCtx.platform || 'internal',
          userId: `parent:${callCtx.sessionId}`,
          nickname: undefined,
        } satisfies IncomingMessage)
        .catch(err => {
          ctx.logger.warn(`向子任务发送消息失败 (${subtaskId}):`, err);
        });

      return JSON.stringify({
        subtaskId,
        sent: true,
        message: `消息已发送到子任务 "${session.name}"`,
      });
    },
  });

  // ---- delete_subtask ----
  useToolService(ctx).register({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'delete_subtask',
        description: [
          '删除指定的子任务会话及其所有子会话（递归删除）。',
          '只能删除当前会话的直接或间接子任务，不能删除根会话或其他会话的子任务。',
          '删除后会话的消息历史也会被一并清除。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_id: {
              type: 'string',
              description: '要删除的子任务 ID',
            },
          },
          required: ['subtask_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      const sm = ctx.getService<SessionManagerService>('session-manager');
      if (!sm) return JSON.stringify({ error: 'session-manager 服务不可用' });

      const subtaskId = String(args.subtask_id || '').trim();
      if (!subtaskId) return JSON.stringify({ error: '缺少子任务 ID' });

      const session = sm.getSession(subtaskId);
      if (!session) return JSON.stringify({ error: `会话不存在: ${subtaskId}`, notFound: true });

      // 安全检查：只能删除当前会话的子任务
      if (session.parentId !== callCtx.sessionId) {
        return JSON.stringify({
          error: `无权删除该会话。当前会话 (${callCtx.sessionId}) 不是该会话的父会话 (parentId=${session.parentId})。`,
          denied: true,
        });
      }

      try {
        const name = session.name;
        await sm.deleteSession(subtaskId);
        return JSON.stringify({
          subtaskId,
          name,
          deleted: true,
          message: `子任务 "${name}" (${subtaskId}) 已删除`,
        });
      } catch (err) {
        return JSON.stringify({ error: `删除失败: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  // ---- wait_subtasks ----
  useToolService(ctx).register({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'wait_subtasks',
        description: [
          '等待指定的子任务全部完成。阻塞直到所有子任务完成或超时。',
          '返回每个子任务的状态和结果摘要。超时后仍返回当前状态（部分可能未完成）。',
          '',
          '【必须调用】创建子任务后，必须调用此工具等待所有子任务完成。',
          '不等待就继续主任务会导致：子任务结果丢失、文档内容不完整、最终输出质量差。',
          '调用后请检查返回的 allCompleted 字段和每个子任务的 result，确认所有子任务均成功完成。',
          '如有子任务失败或超时，可使用 send_to_subtask 补充指令后再次等待。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '要等待的子任务 ID 列表',
            },
            timeout_seconds: {
              type: 'number',
              description: '超时时间（秒），默认 120',
            },
          },
          required: ['subtask_ids'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, _callCtx) => {
      const sm = ctx.getService<SessionManagerService>('session-manager');
      if (!sm) return JSON.stringify({ error: 'session-manager 服务不可用' });

      const ids = (args.subtask_ids as string[]) || [];
      if (ids.length === 0) {
        return JSON.stringify({
          error: '缺少 subtask_ids 参数。正确用法: { "subtask_ids": ["<子任务ID1>", "<子任务ID2>"] }',
        });
      }

      const timeoutSec = Number(args.timeout_seconds) || cfg.maxWaitMs / 1000;
      const timeoutMs = Math.min(timeoutSec * 1000, cfg.maxWaitMs);

      // 先检查是否已经全部完成（避免不必要的等待）
      const isTerminal = (id: string) => {
        const s = sm.getSession(id);
        return !s || s.status === 'completed' || s.status === 'error';
      };

      if (!ids.every(isTerminal)) {
        // 使用事件驱动 + 超时，替代轮询
        await new Promise<void>(resolve => {
          const pending = new Set(ids.filter(id => !isTerminal(id)));
          if (pending.size === 0) {
            resolve();
            return;
          }

          const cleanup = () => {
            clearTimeout(timer);
            disposeCompleted();
            disposeUpdated();
          };

          // 监听 session:completed 事件
          const disposeCompleted = ctx.on('session:completed', (session: SessionInfo) => {
            pending.delete(session.id);
            if (pending.size === 0) {
              cleanup();
              resolve();
            }
          });

          // 兜底：也监听 session:updated 以防状态通过 updateSession 变更
          const disposeUpdated = ctx.on('session:updated', (session: SessionInfo) => {
            if ((session.status === 'completed' || session.status === 'error') && pending.has(session.id)) {
              pending.delete(session.id);
              if (pending.size === 0) {
                cleanup();
                resolve();
              }
            }
          });

          // 超时保护
          const timer = setTimeout(() => {
            cleanup();
            resolve();
          }, timeoutMs);
        });
      }

      // 收集结果
      const results = ids.map(id => {
        const session = sm.getSession(id);
        if (!session) return { id, error: '会话不存在' };
        return {
          id,
          name: session.name,
          status: session.status,
          inputContext: session.inputContext || null,
          result: session.result || null,
          completed: session.status === 'completed',
        };
      });

      const allCompleted = results.every(r => 'completed' in r && r.completed);
      const timedOut = !allCompleted;

      return JSON.stringify({
        allCompleted,
        timedOut,
        subtasks: results,
      });
    },
  });

  // ---- delegate_to_session ----
  // 向已存在的目标会话派发一次任务，目标会话的 agent 在自己原本的人设/记忆/工具集下完整推理；
  // 与 create_subtask 不同：目标不是新建的"子会话"，而是任意已知 sessionId（如群聊、私聊、跨平台）。
  if (cfg.crossSessionEnabled) {
    useToolService(ctx).register({
      groups: ['cross-session'],
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

        ctx.logger.info(
          `[delegate] from=${callCtx.sessionId} -> ${targetSessionId} depth=${targetDepth} wait=${waitForResult} task="${task.slice(0, 80)}"`,
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
        return JSON.stringify({
          delegated: true,
          targetSessionId,
          wait: true,
          timedOut: false,
          outcome: captured.outcome,
          reply: replyTruncated,
          depth: `${targetDepth}/${PROACTIVE_DEPTH_MAX}`,
        });
      },
    });
  }

  // ---- 子任务的系统提示增强 ----
  // 当 agent 处理子任务消息时，在系统提示中注入子任务上下文
  const SUBTASK_CONTEXT_MARKER = '--- 子任务上下文 ---';
  const PARENT_CONTEXT_MARKER = '--- 活跃子任务提醒 ---';

  ctx.middleware('agent:llm:before', async (data, next) => {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) {
      await next();
      return;
    }

    const sessionId = data.sessionId;
    if (!sessionId) {
      await next();
      return;
    }

    const session = sm.getSession(sessionId);
    const messages = data.messages;
    if (!messages || messages.length === 0) {
      await next();
      return;
    }

    // 找到第一个 system 消息
    const sysMsg = messages.find(m => m.role === 'system');
    if (!sysMsg || typeof sysMsg.content !== 'string') {
      await next();
      return;
    }

    // ---- 子任务侧：注入子任务上下文 ----
    if (session?.parentId) {
      // 幂等检查：避免多轮工具调用中重复注入
      if (!sysMsg.content.includes(SUBTASK_CONTEXT_MARKER)) {
        const subtaskContext = [
          `\n\n--- 子任务上下文 ---`,
          `你正在一个子任务会话中执行独立任务。`,
          `子任务名称: ${session.name}`,
          session.inputContext ? `任务指令: ${session.inputContext}` : '',
          '',
          '回答规则：',
          '- 像普通对话一样正常回答问题或完成任务即可',
          '- 系统会自动将你的最终回复作为任务结果报告给父会话',
          '- 请给出完整、有价值的回答，因为你的回复内容将直接成为子任务结果',
          '',
          '共享资源规则：',
          '- 如果任务指令中包含 docId（如 doc-xxxxxxxx），直接使用该 ID 操作文档，不要创建新文档',
          '- 严格只操作你负责的范围（如指定的幻灯片编号、工作表等），不要越界修改其他部分',
          '- 完成后请在回复中汇报你做了什么（如添加了哪些幻灯片、内容摘要等），方便父会话整合',
          '- 不要调用 save 操作——由父会话统一保存',
          '--- 子任务上下文结束 ---',
        ]
          .filter(Boolean)
          .join('\n');

        (sysMsg as { content: string }).content += subtaskContext;
        const prevContributions = (sysMsg.metadata?._tokenContributions as Record<string, number>) ?? {};
        (sysMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...sysMsg.metadata,
          _tokenContributions: { ...prevContributions, subtask: subtaskContext.length },
        };
      }
    }

    // ---- 父会话侧：注入活跃子任务提醒 ----
    if (!session?.parentId && session) {
      // 检查是否有子任务
      const children = session.children;
      if (children && children.length > 0) {
        // 收集活跃/已完成/出错的子任务信息
        const activeChildren: string[] = [];
        const completedChildren: string[] = [];
        const errorChildren: string[] = [];

        for (const childId of children) {
          const child = sm.getSession(childId);
          if (!child) continue;
          if (child.status === 'active') {
            activeChildren.push(`  - [进行中] ${child.name} (ID: ${childId})`);
          } else if (child.status === 'completed') {
            const resultPreview = child.result ?? '(无结果)';
            completedChildren.push(`  - [已完成] ${child.name} (ID: ${childId}): ${resultPreview}`);
          } else if (child.status === 'error') {
            const resultPreview = child.result ?? '(无错误详情)';
            errorChildren.push(`  - [出错] ${child.name} (ID: ${childId}): ${resultPreview}`);
          }
        }

        // 只有存在需要关注的子任务时才注入
        if (activeChildren.length > 0 || completedChildren.length > 0 || errorChildren.length > 0) {
          // 幂等：移除旧的提醒（每轮重新注入最新状态）
          const content = sysMsg.content as string;
          const markerStart = content.indexOf(`\n\n${PARENT_CONTEXT_MARKER}`);
          if (markerStart !== -1) {
            const markerEnd = content.indexOf('--- 活跃子任务提醒结束 ---', markerStart);
            if (markerEnd !== -1) {
              (sysMsg as { content: string }).content =
                content.slice(0, markerStart) + content.slice(markerEnd + '--- 活跃子任务提醒结束 ---'.length);
            }
          }

          const lines: string[] = [`\n\n${PARENT_CONTEXT_MARKER}`];

          if (activeChildren.length > 0) {
            lines.push(`⚠️ 你有 ${activeChildren.length} 个子任务正在执行：`);
            lines.push(...activeChildren);
            lines.push('');
            lines.push('你必须调用 wait_subtasks 等待这些子任务完成后再继续。不要忽略进行中的子任务。');
          }

          if (errorChildren.length > 0) {
            lines.push(`❌ 以下子任务执行出错：`);
            lines.push(...errorChildren);
            lines.push('');
            lines.push(
              '可使用 send_to_subtask 向出错的子任务发送修正指令让其重试，或使用 check_subtask 查看详细状态。',
            );
          }

          if (completedChildren.length > 0) {
            lines.push(`以下子任务已完成，请检查结果：`);
            lines.push(...completedChildren);
          }

          lines.push('--- 活跃子任务提醒结束 ---');
          const parentContext = lines.join('\n');
          (sysMsg as { content: string }).content += parentContext;
          const prevContributions = (sysMsg.metadata?._tokenContributions as Record<string, number>) ?? {};
          (sysMsg as { metadata?: Record<string, unknown> }).metadata = {
            ...sysMsg.metadata,
            _tokenContributions: {
              ...prevContributions,
              subtask: (prevContributions.subtask ?? 0) + parentContext.length,
            },
          };
        }
      }
    }

    await next();
  });

  // ---- 子任务自动完成 ----
  // 当子任务 agent 正常回复后，自动将回复内容作为结果完成会话
  // 同时在子会话历史中合成一条 tool call 记录，展示"报告给父会话"的流程
  ctx.middleware('agent:turn:after', async (data, next) => {
    await next();

    // 仅在本轮真正产生回复时回报父会话；silent / aborted 不应触发自动完成
    if (data.outcome !== 'replied') return;

    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) return;

    const session = sm.getSession(data.sessionId);
    if (!session?.parentId) return; // 非子任务
    if (session.status === 'completed' || session.status === 'error') return; // 已完成

    const result = data.reply;
    if (!result || result.trim().length === 0) return;

    try {
      // 在子会话历史中合成 tool call 记录，展示报告流程
      const archive = ctx.getService<MessageArchiveService>('message-archive');
      if (archive) {
        const syntheticToolCallId = `report-${Date.now()}`;
        // 合成 assistant 消息（含 tool_calls）
        await archive.saveMessage(data.sessionId, {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: syntheticToolCallId,
              type: 'function',
              function: {
                name: 'report_to_parent',
                arguments: JSON.stringify({ result: result.trim() }),
              },
            },
          ],
          timestamp: Date.now(),
        });
        // 合成 tool 结果消息
        await archive.saveMessage(data.sessionId, {
          role: 'tool',
          content: JSON.stringify({ success: true, message: '结果已报告给父会话' }),
          toolCallId: syntheticToolCallId,
          timestamp: Date.now(),
        });
      }

      await sm.completeSession(data.sessionId, result.trim());
      ctx.logger.info(`子任务自动完成: ${session.name} (${data.sessionId})`);
    } catch (err) {
      ctx.logger.warn(`子任务自动完成失败 (${data.sessionId}):`, err);
    }
  });

  ctx.logger.info('子任务工具已注册');
}
