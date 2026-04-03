import { useState, useRef, useEffect, useCallback } from 'react';
import { getSessionId, onSessionChange } from './api';
import type { LogEntry } from './types';

export function useWebSocket(
  onMessage: (content: string, reasoningContent?: string) => void,
  onStream: (contentDelta?: string, reasoningDelta?: string, done?: boolean, toolLimitReached?: boolean) => void,
  onLog: (entry: LogEntry) => void,
  onToolCall: (toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => void,
  onStateChanged?: () => void,
  onRestarting?: () => void,
  onReload?: () => void,
  onSessionSwitched?: (sessionId: string) => void,
  onSessionsChanged?: () => void,
  onTodoUpdated?: (items: unknown[]) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  /** 当前已订阅的 sessionId */
  const subscribedSessionRef = useRef<string>(getSessionId());

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        ws.send(JSON.stringify({ type: 'subscribe_logs' }));
        ws.send(JSON.stringify({ type: 'subscribe_session', sessionId: getSessionId() }));
        subscribedSessionRef.current = getSessionId();
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'stream') {
            onStream(data.contentDelta, data.reasoningDelta, data.done, data.toolLimitReached);
          } else if (data.type === 'message' && data.content) {
            onMessage(data.content, data.reasoningContent);
          } else if (data.type === 'tool_call' && data.toolName) {
            onToolCall(data.toolName, data.toolArgs ?? {}, data.toolPhase, data.toolResult);
          } else if (data.type === 'log' && data.log) {
            onLog(data.log);
          } else if (data.type === 'state_changed') {
            onStateChanged?.();
          } else if (data.type === 'restarting') {
            onRestarting?.();
          } else if (data.type === 'reload') {
            onReload?.();
          } else if (data.type === 'session_switched') {
            // 服务端广播的会话切换通知
            onSessionSwitched?.(data.sessionId);
          } else if (data.type === 'sessions_changed') {
            // 会话列表变更（创建/更新/删除/完成）
            onSessionsChanged?.();
          } else if (data.type === 'todo_updated' && data.todoItems) {
            onTodoUpdated?.(data.todoItems);
          }
        } catch { /* ignore */ }
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [onMessage, onStream, onLog, onToolCall, onStateChanged, onRestarting, onReload, onSessionSwitched, onSessionsChanged, onTodoUpdated]);

  // 监听 sessionId 变化，动态切换 WS 订阅
  useEffect(() => {
    const unsubscribe = onSessionChange((newId) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        // 取消旧会话订阅
        ws.send(JSON.stringify({ type: 'unsubscribe_session', sessionId: subscribedSessionRef.current }));
        // 订阅新会话
        ws.send(JSON.stringify({ type: 'subscribe_session', sessionId: newId }));
        subscribedSessionRef.current = newId;
      }
    });
    return unsubscribe;
  }, []);

  const send = useCallback((content: string, images?: string[], files?: Array<{ name: string; data: string; mimeType?: string }>, attachmentOrder?: Array<'image' | 'file'>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = {
        type: 'message',
        content,
        sessionId: getSessionId(),
      };
      if (images && images.length > 0) {
        payload.images = images;
      }
      if (files && files.length > 0) {
        payload.files = files;
      }
      if (attachmentOrder && attachmentOrder.length > 0) {
        payload.attachmentOrder = attachmentOrder;
      }
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const sendRaw = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, sendRaw, connected };
}
