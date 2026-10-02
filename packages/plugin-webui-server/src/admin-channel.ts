// ============================================================
// admin-channel.ts — /admin：管理面事件推送
//
// 会话之外的推送（日志、插件与页面登记表的变化、重启、换前端）走这条端点，与会话协议的 /session 分开。
// 事件类型见 @aalis/api-webui 的 WebuiAdminEvent：日志只推给订阅了的连接，其余事件推给全部连接。
// 前端发来的只有日志的订阅与退订；认不出的消息记一行告警后忽略，连接照常，较新的前端连上较旧的服务端也不会被断开。
// ============================================================

import type { WebuiAdminClientMessage, WebuiAdminEvent } from '@aalis/api-webui';
import type { Logger } from '@aalis/core';
import { WebSocket } from 'ws';

export const ADMIN_PATH = '/admin';

/** 帧里的 type；不是 JSON 对象时为 undefined */
function messageType(text: string): unknown {
  try {
    return (JSON.parse(text) as { type?: unknown } | null)?.type;
  } catch {
    return undefined;
  }
}

export function createAdminChannel(logger: Logger) {
  const clients = new Set<WebSocket>();
  const logSubscribers = new Set<WebSocket>();

  /** 接一条已认证的 /admin 连接 */
  function accept(ws: WebSocket): void {
    clients.add(ws);
    ws.on('message', data => {
      const type = messageType(String(data)) as WebuiAdminClientMessage['type'] | undefined;
      if (type === 'log.subscribe') logSubscribers.add(ws);
      else if (type === 'log.unsubscribe') logSubscribers.delete(ws);
      else logger.warn('WebUI /admin 收到认不出的消息，已忽略');
    });
    ws.on('close', () => {
      clients.delete(ws);
      logSubscribers.delete(ws);
    });
  }

  /** 推一个事件：日志推给订阅了的连接，其余推给全部连接 */
  function send(event: WebuiAdminEvent): void {
    const json = JSON.stringify(event);
    for (const ws of event.type === 'log' ? logSubscribers : clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  return { accept, send };
}
