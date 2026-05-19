import type { ConfigSchema, Context } from '@aalis/core';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { MessageArchiveService } from '@aalis/plugin-message-archive-api';
import type { SessionInfo, SessionManagerService } from '@aalis/plugin-session-manager-api';
import { useToolService } from '@aalis/plugin-tools-api';
import '@aalis/plugin-agent-api';
import '@aalis/plugin-tools-api';

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
  defaultProvider: {
    type: 'string',
    label: '子任务默认 LLM provider',
    default: '',
    description: '不填则继承父会话。建议填轻量本地模型（如 ollama）让子任务跑在更便宜的模型上，节省 token',
  },
  defaultModel: {
    type: 'string',
    label: '子任务默认模型名',
    default: '',
    description: '与 defaultProvider 配套。例如 qwen3:8b、deepseek-chat。两个都不填则继承父会话模型。',
  },
};

interface PluginConfig {
  enabled: boolean;
  pollIntervalMs: number;
  maxWaitMs: number;
  defaultProvider: string;
  defaultModel: string;
}

function resolveConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    enabled: raw.enabled !== false,
    pollIntervalMs: Number(raw.pollIntervalMs) || 3000,
    maxWaitMs: Number(raw.maxWaitMs) || 300000,
    defaultProvider: String(raw.defaultProvider ?? '').trim(),
    defaultModel: String(raw.defaultModel ?? '').trim(),
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
          '',
          '【模型选择】可选 provider+model 参数为子任务指定更便宜/轻量的模型：',
          '- 适合轻量模型的任务：语法检查、格式转换、摄取信息、翻译、简单总结、文档快速审阅',
          '- 依然需要父同模型的任务：复杂推理、多步规划、代码生成、独立决策',
          '- 不填则使用插件默认子任务模型，都未配置则继承父会话',
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
            provider: {
              type: 'string',
              description:
                '可选：为子任务指定 LLM provider（如 ollama 、 deepseek）。与 model 配套使用，二者同填才会生效。',
            },
            model: {
              type: 'string',
              description:
                '可选：为子任务指定 model 名称（如 qwen3:8b、deepseek-chat）。二者同填才会生效；未填则使用插件默认或父会话模型。',
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

        // 模型优先级：工具参数 > 插件默认 > 父会话继承
        // 仅当 provider 和 model 同时提供才覆盖，避免半填产生歧义
        const argProvider = String((args.provider as string | undefined) ?? '').trim();
        const argModel = String((args.model as string | undefined) ?? '').trim();
        let llmOverride: { provider: string; model: string } | undefined;
        if (argProvider && argModel) {
          llmOverride = { provider: argProvider, model: argModel };
        } else if (cfg.defaultProvider && cfg.defaultModel) {
          llmOverride = { provider: cfg.defaultProvider, model: cfg.defaultModel };
        }
        const childConfig = llmOverride ? { ...inheritedConfig, llm: llmOverride } : { ...inheritedConfig };

        // 创建子会话（存储 platform 用于后续自动触发）
        const child = await sm.createChildSession(parentId, {
          name: taskName,
          createdBy: 'agent',
          inputContext: task,
          config: childConfig,
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
