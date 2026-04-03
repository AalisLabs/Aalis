import type { Context, ConfigSchema, ToolCallContext, SessionManagerService, IncomingMessage, SessionInfo } from '@aalis/core';

// ===== 插件元数据 =====

export const name = '@aalis/plugin-session-tools';
export const displayName = '子任务工具';
export const inject = {
  optional: ['session-manager', 'memory'],
};

export const configSchema: ConfigSchema = {
  enabled: { type: 'boolean', label: '启用子任务工具', default: true },
  pollIntervalMs: { type: 'number', label: '等待轮询间隔 (ms)', default: 3000 },
  maxWaitMs: { type: 'number', label: '单次等待最大时长 (ms)', default: 120000 },
};

interface PluginConfig {
  enabled: boolean;
  pollIntervalMs: number;
  maxWaitMs: number;
}

function resolveConfig(raw: Record<string, unknown>): PluginConfig {
  return {
    enabled: raw.enabled !== false,
    pollIntervalMs: Number(raw.pollIntervalMs) || 3000,
    maxWaitMs: Number(raw.maxWaitMs) || 120000,
  };
}

// ===== 插件入口 =====

export function apply(ctx: Context, config: Record<string, unknown>): void {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return;

  // 注册工具分组
  ctx.registerToolGroup({
    name: 'subtask',
    label: '子任务管理',
    description: '创建、管理和协调子任务会话，支持并行执行',
  });

  // ---- create_subtask ----
  ctx.registerTool({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'create_subtask',
        description: [
          '创建一个子任务会话并异步派发任务。子任务将在独立会话中并行执行，不阻塞当前会话。',
          '返回子任务 ID，后续可用 check_subtask 查询状态或 wait_subtasks 等待完成。',
          '你可以连续调用多次 create_subtask 来创建多个并行子任务。',
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
      const taskName = args.name ? String(args.name) : `子任务 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;

      try {
        // 子会话复制父会话的 resolved config
        const inheritedConfig = sm.resolveConfig(parentId, callCtx.platform);

        // 创建子会话（存储 platform 用于后续自动触发）
        const child = await sm.createChildSession(parentId, {
          name: taskName,
          createdBy: 'agent',
          inputContext: task,
          config: { ...inheritedConfig },
          metadata: { platform: callCtx.platform || 'internal' },
        });

        // 异步派发任务消息，触发 agent 处理（不等待完成）
        ctx.emit('message:received', {
          content: task,
          sessionId: child.id,
          platform: callCtx.platform || 'internal',
          userId: `parent:${parentId}`,
          nickname: '',
        } satisfies IncomingMessage).catch(err => {
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
  ctx.registerTool({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'check_subtask',
        description: '查询一个或多个子任务的当前状态和结果。返回每个子任务的状态、结果摘要等信息。',
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
    handler: async (args) => {
      const sm = ctx.getService<SessionManagerService>('session-manager');
      if (!sm) return JSON.stringify({ error: 'session-manager 服务不可用' });

      const ids = (args.subtask_ids as string[]) || [];
      const results = ids.map(id => {
        const session = sm.getSession(id);
        if (!session) return { id, error: '会话不存在' };
        return {
          id,
          name: session.name,
          status: session.status,
          result: session.result || null,
          inputContext: session.inputContext || null,
        };
      });

      return JSON.stringify({ subtasks: results });
    },
  });

  // ---- send_to_subtask ----
  ctx.registerTool({
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
      ctx.emit('message:received', {
        content: message,
        sessionId: subtaskId,
        platform: callCtx.platform || 'internal',
        userId: `parent:${callCtx.sessionId}`,
        nickname: '',
      } satisfies IncomingMessage).catch(err => {
        ctx.logger.warn(`向子任务发送消息失败 (${subtaskId}):`, err);
      });

      return JSON.stringify({
        subtaskId,
        sent: true,
        message: `消息已发送到子任务 "${session.name}"`,
      });
    },
  });

  // ---- wait_subtasks ----
  ctx.registerTool({
    groups: ['subtask'],
    definition: {
      type: 'function',
      function: {
        name: 'wait_subtasks',
        description: [
          '等待指定的子任务全部完成。阻塞直到所有子任务完成或超时。',
          '返回每个子任务的状态和结果摘要。超时后仍返回当前状态（部分可能未完成）。',
          '建议在创建所有并行子任务后调用此工具，以收集结果后继续推进主任务。',
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
      if (ids.length === 0) return JSON.stringify({ error: '缺少子任务 ID' });

      const timeoutSec = Number(args.timeout_seconds) || (cfg.maxWaitMs / 1000);
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
          if (pending.size === 0) { resolve(); return; }

          const cleanup = () => {
            clearTimeout(timer);
            disposeCompleted();
            disposeUpdated();
          };

          // 监听 session:completed 事件
          const disposeCompleted = ctx.on('session:completed', (session: SessionInfo) => {
            pending.delete(session.id);
            if (pending.size === 0) { cleanup(); resolve(); }
          });

          // 兜底：也监听 session:updated 以防状态通过 updateSession 变更
          const disposeUpdated = ctx.on('session:updated', (session: SessionInfo) => {
            if ((session.status === 'completed' || session.status === 'error') && pending.has(session.id)) {
              pending.delete(session.id);
              if (pending.size === 0) { cleanup(); resolve(); }
            }
          });

          // 超时保护
          const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
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
  ctx.middleware('llm-call:before', async (data, next) => {
    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) { await next(); return; }

    const sessionId = data.sessionId;
    if (!sessionId) { await next(); return; }

    const session = sm.getSession(sessionId);
    if (!session?.parentId) { await next(); return; } // 非子任务，不处理

    const messages = data.messages;
    if (!messages || messages.length === 0) { await next(); return; }

    // 找到第一个 system 消息
    const sysMsg = messages.find(m => m.role === 'system');
    if (!sysMsg || typeof sysMsg.content !== 'string') { await next(); return; }

    // 幂等检查：避免多轮工具调用中重复注入
    if (sysMsg.content.includes(SUBTASK_CONTEXT_MARKER)) { await next(); return; }

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
      '--- 子任务上下文结束 ---',
    ].filter(Boolean).join('\n');

    (sysMsg as { content: string }).content += subtaskContext;

    await next();
  }, 900); // 高优先级，在其他中间件之前运行

  // ---- 子任务自动完成 ----
  // 当子任务 agent 正常回复后，自动将回复内容作为结果完成会话
  // 同时在子会话历史中合成一条 tool call 记录，展示"报告给父会话"的流程
  ctx.middleware('message:after', async (data, next) => {
    await next();

    const sm = ctx.getService<SessionManagerService>('session-manager');
    if (!sm) return;

    const session = sm.getSession(data.sessionId);
    if (!session?.parentId) return; // 非子任务
    if (session.status === 'completed' || session.status === 'error') return; // 已完成

    const result = data.response;
    if (!result || typeof result !== 'string' || result.trim().length === 0) return;

    try {
      // 在子会话历史中合成 tool call 记录，展示报告流程
      const memory = ctx.getService<import('@aalis/core').MemoryService>('memory');
      if (memory) {
        const syntheticToolCallId = `report-${Date.now()}`;
        // 合成 assistant 消息（含 tool_calls）
        await memory.saveMessage(data.sessionId, {
          role: 'assistant',
          content: null,
          toolCalls: [{
            id: syntheticToolCallId,
            type: 'function',
            function: {
              name: 'report_to_parent',
              arguments: JSON.stringify({ result: result.trim() }),
            },
          }],
          timestamp: Date.now(),
        });
        // 合成 tool 结果消息
        await memory.saveMessage(data.sessionId, {
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
  }, 50); // 低优先级，在其他 message:after 处理之后运行

  ctx.logger.info('子任务工具已注册');
}
