// ════════════════════════════════════════════════════════════
// 回合控制：发消息、工具调用达到上限后继续、停止、手动压缩、回滚、清空待办。
// 消息以连接的身份（传输层认证出的平台与用户）发进入站事件，经网关进 agent，与平台适配器收到的消息走同一条路。
// 停止、压缩、回滚（与回滚之前查检查点）、清空待办转给对应的服务，服务不在回 unsupported。
// ════════════════════════════════════════════════════════════

import type { AgentService } from '@aalis/api-agent';
import type { CheckpointService } from '@aalis/api-checkpoint';
import type { CompressionService } from '@aalis/api-memory';
import type { SessionInfo } from '@aalis/api-session-manager';
import type { SessionPeer } from '@aalis/api-session-protocol';
import type { TodoListService } from '@aalis/api-todo-list';
import type { Events, ServiceSelection } from '@aalis/core';
import type { MessageAttachment } from '@aalis/schema-message';
import { failure, type MethodHandlers } from './connection.js';

/** 工具调用达到上限后请她接着做 */
const CONTINUE_PROMPT = '[请继续执行未完成的工具调用]';

interface TurnControlDeps {
  events: Events;
  agent: ServiceSelection<AgentService>;
  checkpoint: ServiceSelection<CheckpointService>;
  compression: ServiceSelection<CompressionService>;
  todoList: ServiceSelection<TodoListService>;
  requireSession(id: string): SessionInfo;
  /** 请 agent 重发某会话的用量 */
  requestUsage(sessionId: string, platform: string): void;
}

export function createTurnControl(deps: TurnControlDeps) {
  const { events, requireSession } = deps;

  /** 发一条入站消息：网关收下就回，回合的进展经条目推送 */
  function send(peer: SessionPeer, sessionId: string, content: string, attachments?: MessageAttachment[]) {
    const { platform, userId } = peer.identity;
    return events.emit('inbound:message', {
      content,
      sessionId,
      platform,
      userId,
      ...(attachments?.length ? { attachments } : {}),
    });
  }

  const handlers: Pick<
    MethodHandlers,
    'turn/send' | 'turn/continue' | 'turn/abort' | 'session/compress' | 'turn/checkpoint' | 'turn/rewind' | 'plan/clear'
  > = {
    'turn/send': async ({ sessionId, content, attachments }, conn) => {
      requireSession(sessionId);
      await send(conn.peer, sessionId, content.trim(), attachments);
      return {};
    },
    'turn/continue': async ({ sessionId }, conn) => {
      requireSession(sessionId);
      await send(conn.peer, sessionId, CONTINUE_PROMPT);
      return {};
    },
    'turn/abort': ({ sessionId, turnId }) => {
      requireSession(sessionId);
      const agent = deps.agent.present ? deps.agent.use : undefined;
      if (!agent?.abort) throw failure('unsupported', '没有能停止回合的 agent 服务');
      if (!agent.abort(sessionId, turnId) && turnId !== undefined) {
        throw failure('expected-turn-mismatch', `这一轮不在跑：${turnId}`);
      }
      return {};
    },
    'session/compress': async ({ sessionId }, conn) => {
      requireSession(sessionId);
      if (!deps.compression.present) throw failure('unsupported', '没有压缩服务');
      const compression = deps.compression.use;
      await compression.compress(sessionId, { reason: 'manual' });
      deps.requestUsage(sessionId, conn.peer.identity.platform);
      return {};
    },
    'turn/checkpoint': async ({ sessionId, turnId }) => {
      requireSession(sessionId);
      if (!deps.checkpoint.present) throw failure('unsupported', '没有检查点服务');
      const checkpoint = deps.checkpoint.use;
      return { execUsed: await checkpoint.execUsed(sessionId, turnId) };
    },
    'turn/rewind': ({ sessionId, turnId, scope }) => {
      requireSession(sessionId);
      if (!deps.checkpoint.present) throw failure('unsupported', '没有检查点服务，不能回滚');
      const checkpoint = deps.checkpoint.use;
      return scope === 'code' ? checkpoint.rollback(sessionId, turnId) : checkpoint.rollbackWithChat(sessionId, turnId);
    },
    'plan/clear': async ({ sessionId }) => {
      requireSession(sessionId);
      if (!deps.todoList.present) throw failure('unsupported', '没有待办服务');
      const todoList = deps.todoList.use;
      await todoList.clear(sessionId);
      return {};
    },
  };

  return { handlers };
}
