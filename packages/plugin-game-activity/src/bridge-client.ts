import { randomUUID } from 'node:crypto';
import type { Context } from '@aalis/core';
import WebSocket from 'ws';
import type { BridgeCommand, BridgeEvent } from './protocol.js';

/**
 * Aalis 作为 *主动端* 连接游戏 mod 的 WebSocket 客户端。
 *
 * 设计取舍：
 * - 唯一长连接：同时刻只期望连接到一个游戏实例（mod 在游戏进程内监听）。
 * - 自动重连：游戏开/关随时发生，断线后无限退避重试（不视作错误）。
 * - 协议层不变：握手/state/prompt 流向与原 BridgeServer 完全一致，只是物理角色翻转。
 */

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface BridgeConnection {
  readonly id: string;
  send(message: BridgeCommand): void;
  isOpen(): boolean;
}

export interface BridgeClientHandlers {
  onConnect(conn: BridgeConnection): void;
  onMessage(conn: BridgeConnection, message: BridgeEvent): void;
  onClose(conn: BridgeConnection, reason?: string): void;
  onError(conn: BridgeConnection | undefined, err: unknown): void;
  /** 状态变化回调（用于 start_game tool 查询是否游戏可用） */
  onStateChange?(state: ConnectionState): void;
}

export interface BridgeClientOptions {
  /** 完整的 WebSocket URL，例如 ws://127.0.0.1:43772/aalis-bridge */
  url: string;
  ctx: Context;
  handlers: BridgeClientHandlers;
  /** 初次重连间隔 ms（指数退避起点） */
  initialBackoffMs?: number;
  /** 最大重连间隔 ms */
  maxBackoffMs?: number;
}

export interface BridgeClientHandle {
  /** 当前连接状态 */
  getState(): ConnectionState;
  /** 当前连接（仅在 connected 时存在） */
  getConnection(): BridgeConnection | undefined;
  /** 主动停止所有重连（plugin unload 时调用） */
  close(): void;
}

export function startBridgeClient(opts: BridgeClientOptions): BridgeClientHandle {
  const { url, ctx, handlers } = opts;
  const initialBackoff = opts.initialBackoffMs ?? 1000;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;

  let state: ConnectionState = 'disconnected';
  let backoff = initialBackoff;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let ws: WebSocket | undefined;
  let currentConn: BridgeConnection | undefined;

  function setState(next: ConnectionState): void {
    if (state === next) return;
    state = next;
    try {
      handlers.onStateChange?.(next);
    } catch (err) {
      ctx.logger.debug(`onStateChange 抛错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      tryConnect();
    }, delay);
  }

  function tryConnect(): void {
    if (stopped) return;
    setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      ctx.logger.debug(`bridge 连接构造失败: ${err instanceof Error ? err.message : String(err)}`);
      scheduleReconnect();
      return;
    }
    ws = socket;

    const conn: BridgeConnection = {
      id: randomUUID(),
      isOpen: () => socket.readyState === WebSocket.OPEN,
      send(message: BridgeCommand) {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(JSON.stringify(message));
        } catch (err) {
          ctx.logger.debug(`bridge send 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
    currentConn = conn;

    socket.on('open', () => {
      backoff = initialBackoff;
      setState('connected');
      ctx.logger.info(`game-activity 已连接到 mod: ${url}`);
      try {
        handlers.onConnect(conn);
      } catch (err) {
        handlers.onError(conn, err);
      }
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      let text: string;
      if (typeof raw === 'string') text = raw;
      else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
      else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
      else text = Buffer.from(raw as ArrayBuffer).toString('utf8');
      try {
        const msg = JSON.parse(text) as BridgeEvent;
        handlers.onMessage(conn, msg);
      } catch (err) {
        handlers.onError(conn, err);
      }
    });

    socket.on('close', (_code: number, reason: Buffer) => {
      const reasonText = reason?.length ? reason.toString('utf8') : undefined;
      try {
        handlers.onClose(conn, reasonText);
      } catch {
        /* noop */
      }
      ws = undefined;
      currentConn = undefined;
      setState('disconnected');
      scheduleReconnect();
    });

    socket.on('error', err => {
      // ECONNREFUSED 等常态错误降级为 debug，避免日志刷屏
      const msg = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET/.test(msg)) {
        ctx.logger.debug(`bridge 连接尝试失败: ${msg}`);
      } else {
        handlers.onError(conn, err);
      }
    });
  }

  // 立刻发起首次连接
  tryConnect();

  return {
    getState: () => state,
    getConnection: () => (state === 'connected' ? currentConn : undefined),
    close() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        ws = undefined;
      }
      currentConn = undefined;
      setState('disconnected');
    },
  };
}
