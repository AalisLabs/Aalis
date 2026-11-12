// ════════════════════════════════════════════════════════════
// 回合控制：发消息、工具调用达到上限后继续、停止、手动压缩、回滚、清空待办。
// 消息以连接的身份（传输层认证出的平台与用户）发进入站事件，经网关进 agent，与平台适配器收到的消息走同一条路。
// 停止、压缩、回滚、清空待办转给对应的服务，服务不在回 unsupported。
// ════════════════════════════════════════════════════════════

import type { AgentService } from '@aalis/api-agent';
import type { CheckpointService } from '@aalis/api-checkpoint';
import type { Events } from '@aalis/api-events';
import type { CompressionService } from '@aalis/api-memory';
import type { SessionInfo } from '@aalis/api-session-manager';
import type { SessionMethodParams, SessionPeer } from '@aalis/api-session-protocol';
import type { TodoListService } from '@aalis/api-todo-list';
import type { ServiceSelection } from '@aalis/core';
import type { MessageAttachment } from '@aalis/schema-message';
import { detectMediaFormat, FILE_HEAD_BYTES } from '@aalis/util-file-signature';
import { failure, type MethodHandlers } from './connection.js';
import { t } from './texts.js';

/** 工具调用达到上限后请她接着做 */
const CONTINUE_PROMPT = '[请继续执行未完成的工具调用]';

type OutgoingAttachment = NonNullable<SessionMethodParams<'turn/send'>['attachments']>[number];

/** base64 每 4 个字符是 3 个字节：解出文件头要的前这么多个字符 */
const HEAD_BASE64_CHARS = Math.ceil(FILE_HEAD_BYTES / 3) * 4;

/**
 * 客户端发来的附件进入站消息：种类按文件头判定，data URL 的类型头换成判定格式的 MIME，不是媒体的写
 * application/octet-stream，下游看不到浏览器报的类型。协议已核过 data 是 base64 的 data URL
 */
function inboundAttachment({ data, name }: OutgoingAttachment): MessageAttachment {
  const base64 = data.slice(data.indexOf(',') + 1);
  const format = detectMediaFormat(Buffer.from(base64.slice(0, HEAD_BASE64_CHARS), 'base64'));
  return {
    kind: format?.kind ?? 'file',
    data: `data:${format?.mime ?? 'application/octet-stream'};base64,${base64}`,
    ...(name !== undefined ? { name } : {}),
  };
}

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
    'turn/send' | 'turn/continue' | 'turn/abort' | 'session/compress' | 'turn/rewind' | 'plan/clear'
  > = {
    'turn/send': async ({ sessionId, content, attachments }, conn) => {
      requireSession(sessionId);
      await send(conn.peer, sessionId, content.trim(), attachments?.map(inboundAttachment));
      return {};
    },
    'turn/continue': async ({ sessionId }, conn) => {
      requireSession(sessionId);
      await send(conn.peer, sessionId, CONTINUE_PROMPT);
      return {};
    },
    'turn/abort': ({ sessionId, turnId }, conn) => {
      requireSession(sessionId);
      if (!deps.agent.present) throw failure('unsupported', t('noAgent'));
      // 停止键只停在跑的一轮，排着的照常开下一轮；停下的人是这条连接的身份
      if (
        !deps.agent.use.abort(sessionId, { turnId, reason: '停止键', by: conn.peer.identity }) &&
        turnId !== undefined
      ) {
        throw failure('expected-turn-mismatch', t('turnNotRunning', { turnId }));
      }
      return {};
    },
    'session/compress': async ({ sessionId }, conn) => {
      requireSession(sessionId);
      if (!deps.compression.present) throw failure('unsupported', t('noCompression'));
      const compression = deps.compression.use;
      await compression.compress(sessionId, { reason: 'manual' });
      deps.requestUsage(sessionId, conn.peer.identity.platform);
      return {};
    },
    'turn/rewind': ({ sessionId, turnId, scope }) => {
      requireSession(sessionId);
      if (!deps.checkpoint.present) throw failure('unsupported', t('noCheckpoint'));
      const checkpoint = deps.checkpoint.use;
      return scope === 'code' ? checkpoint.rollback(sessionId, turnId) : checkpoint.rollbackWithChat(sessionId, turnId);
    },
    'plan/clear': async ({ sessionId }) => {
      requireSession(sessionId);
      if (!deps.todoList.present) throw failure('unsupported', t('noTodoList'));
      const todoList = deps.todoList.use;
      await todoList.clear(sessionId);
      return {};
    },
  };

  return { handlers };
}
