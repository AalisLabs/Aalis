import type { WebuiAdminClientMessage, WebuiAdminEvent } from '@aalis/api-webui';
import { type ConnectionState, openSocket } from './socket';

// 管理面的客户端：/admin 推来的事件按名字分给登记的处理函数。事件只是「变了」的信号，断线期间丢的不补发，
// 重连上以后经 onReconnect 通知调用方重取。

type AdminEventType = WebuiAdminEvent['type'];

export interface AdminClient {
  readonly state: ConnectionState;
  onState(listener: (state: ConnectionState) => void): () => void;
  on<T extends AdminEventType>(type: T, handler: (event: Extract<WebuiAdminEvent, { type: T }>) => void): () => void;
  /** 重连上以后调用，第一次连上不算 */
  onReconnect(listener: () => void): () => void;
  /** 发一条消息；没连上时不发，订阅方按连接状态在连上后重发 */
  send(message: WebuiAdminClientMessage): void;
  close(): void;
}

export function createAdminClient(): AdminClient {
  const handlers = new Map<AdminEventType, Set<(event: WebuiAdminEvent) => void>>();
  const reconnectListeners = new Set<() => void>();
  let connectedBefore = false;

  const socket = openSocket('/admin', {
    opened() {
      if (connectedBefore) for (const listener of reconnectListeners) listener();
      connectedBefore = true;
    },
    message(text) {
      const event = JSON.parse(text) as WebuiAdminEvent;
      for (const handler of handlers.get(event.type) ?? []) handler(event);
    },
  });

  return {
    get state() {
      return socket.state;
    },
    onState: listener => socket.onState(listener),
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler as (event: WebuiAdminEvent) => void);
      return () => set.delete(handler as (event: WebuiAdminEvent) => void);
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    send: message => void socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}
