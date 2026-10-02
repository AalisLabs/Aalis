// ============================================================
// session-transport.ts — /session：把一条已认证的 WebSocket 接到会话协议
//
// 帧的解析、握手与分派都在会话服务里（@aalis/api-session-protocol 的 sessionProtocol），
// 这里只搬运文本帧：收到的帧原样交给 receive，服务端要发的帧原样 send，底层连接关闭时 close。
//
// 会话服务在连接到达时现取：不在就以 1013 关闭并写明原因，客户端稍后重连；它停止或重载时
// 自己断开现有连接，客户端重连时接到新的提供者。本插件不必随它重启。
// ============================================================

import type { Identity, SessionProtocolService } from '@aalis/api-session-protocol';
import type { WebSocket } from 'ws';

export const SESSION_PATH = '/session';

/** WebSocket 关闭帧里的原因最多 123 字节（UTF-8），超出时 ws 的 close 直接抛错 */
const CLOSE_REASON_BYTES = 123;

/**
 * 截成关闭帧放得下的原因。会话服务给的原因可能更长（握手时客户端报的版本号原样写进原因里），
 * encodeInto 只写完整的字，截断不会落在一个字的中间。
 */
function closeReason(reason: string): string {
  const { read } = new TextEncoder().encodeInto(reason, new Uint8Array(CLOSE_REASON_BYTES));
  return reason.slice(0, read);
}

/** 接一条已认证的 /session 连接；service 是此刻的会话服务，不在时传 undefined */
export function acceptSessionSocket(
  ws: WebSocket,
  identity: Identity,
  service: SessionProtocolService | undefined,
): void {
  if (!service) {
    ws.close(1013, '会话服务不在');
    return;
  }
  const conn = service.connect(
    { identity, surface: 'webui', disconnect: reason => ws.close(1000, closeReason(reason)) },
    frame => ws.send(frame),
  );
  ws.on('message', data => void conn.receive(String(data)));
  ws.on('close', () => conn.close());
}
