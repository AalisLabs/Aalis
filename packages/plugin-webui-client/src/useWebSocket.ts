import { useState, useRef, useEffect, useCallback } from 'react';
import { SESSION_ID } from './api';
import type { LogEntry } from './types';

export function useWebSocket(
  onMessage: (content: string, reasoningContent?: string) => void,
  onStream: (contentDelta?: string, reasoningDelta?: string, done?: boolean) => void,
  onLog: (entry: LogEntry) => void,
  onToolCall: (toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => void,
  onStateChanged?: () => void,
  onRestarting?: () => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

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
            onStream(data.contentDelta, data.reasoningDelta, data.done);
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
  }, [onMessage, onStream, onLog, onToolCall, onStateChanged, onRestarting]);

  const send = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content,
        sessionId: SESSION_ID,
      }));
    }
  }, []);

  const sendRaw = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, sendRaw, connected };
}
