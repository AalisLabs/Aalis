// ============================================================
// admin-channel.ts — /admin：管理面事件推送
//
// 会话之外的推送（日志、插件与页面登记表的变化、重启、换前端）走这条端点，与会话协议的 /session 分开。
// 事件类型见 @aalis/api-webui 的 WebuiAdminEvent：日志只推给订阅了、符合它订阅时的筛选的连接，其余事件推给全部连接。
// 前端发来的只有日志的订阅（可带筛选，再订阅一次换掉筛选）与退订；认不出的消息（含写法不对的筛选）记一行告警后忽略，
// 连接与之前的订阅照常，较新的前端连上较旧的服务端也不会被断开。
// ============================================================

import type { LogFilter, WebuiAdminEvent } from '@aalis/api-webui';
import type { LogEntry, Logger } from '@aalis/core';
import { WebSocket } from 'ws';
import { parseLogFilter } from './logs.js';

export const ADMIN_PATH = '/admin';

/** 帧按 JSON 读出的对象；不是 JSON 对象时为 undefined */
function messageOf(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** match 按筛选给出判定日志的函数 */
export function createAdminChannel(logger: Logger, match: (filter: LogFilter) => (entry: LogEntry) => boolean) {
  const clients = new Set<WebSocket>();
  const logSubscribers = new Map<WebSocket, (entry: LogEntry) => boolean>();

  /** 接一条已认证的 /admin 连接 */
  function accept(ws: WebSocket): void {
    clients.add(ws);
    ws.on('message', data => {
      const message = messageOf(String(data));
      const filter = message?.type === 'log.subscribe' ? parseLogFilter(message.filter) : undefined;
      if (filter) logSubscribers.set(ws, match(filter));
      else if (message?.type === 'log.unsubscribe') logSubscribers.delete(ws);
      else logger.warn('WebUI /admin 收到认不出的消息，已忽略');
    });
    ws.on('close', () => {
      clients.delete(ws);
      logSubscribers.delete(ws);
    });
  }

  /** 推一个事件：日志推给订阅了、符合筛选的连接，其余推给全部连接 */
  function send(event: WebuiAdminEvent): void {
    const json = JSON.stringify(event);
    const targets =
      event.type === 'log'
        ? [...logSubscribers].flatMap(([ws, accepts]) => (accepts(event.entry) ? [ws] : []))
        : clients;
    for (const ws of targets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  return { accept, send };
}
