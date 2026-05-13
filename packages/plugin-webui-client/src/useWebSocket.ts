import { useState, useRef, useEffect, useCallback } from 'react';
import { getSessionId, onSessionChange } from './api';
import type { LogEntry, ContentSegment } from './types';

export interface TokenUsageData {
  contextWindow: number;
  maxTokens: number;
  tokenBudget: number;
  used: number;
  usageRatio: number;
  breakdown: {
    system: number;
    persona: number;
    memorySummary: number;
    memoryVector: number;
    skills: number;
    platform: number;
    subtask: number;
    systemOther: number;
    history: number;
    toolResults: number;
    toolDefs: number;
    reservedForReply: number;
  };
}

export function useWebSocket(
  onMessage: (content: string, reasoningContent?: string, segments?: ContentSegment[]) => void,
  onStream: (contentDelta?: string, reasoningDelta?: string, done?: boolean, toolLimitReached?: boolean) => void,
  onLog: (entry: LogEntry) => void,
  onToolCall: (toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => void,
  onStateChanged?: () => void,
  onRestarting?: () => void,
  onReload?: () => void,
  onSessionSwitched?: (sessionId: string) => void,
  onSessionsChanged?: () => void,
  onTodoUpdated?: (items: unknown[]) => void,
  onStreamResume?: (
    content: string,
    reasoningContent: string,
    segments: ContentSegment[],
    done: boolean,
    toolCallsProgress?: Array<{ index: number; name: string; charsAccumulated: number; startedAt: number }>,
  ) => void,
  onConfirm?: (content: string) => void,
  onTokenUsage?: (usage: TokenUsageData) => void,
  onCompressing?: (sessionId: string, status: 'start' | 'done' | 'error') => void,
  onHistoryChanged?: (sessionId: string) => void,
  /** 单条增量更新；done=true 时调用 onToolCallProgressClear */
  onToolCallProgress?: (progress: { index: number; name: string; charsAccumulated: number }) => void,
  /** 清空所有生成中进度（stream done / 各类重置） */
  onToolCallProgressClear?: () => void,
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
            if (data.toolCallProgress) {
              onToolCallProgress?.(data.toolCallProgress);
            }
            if (data.done) {
              onToolCallProgressClear?.();
            }
          } else if (data.type === 'message' && data.content) {
            onMessage(data.content, data.reasoningContent, data.segments);
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
          } else if (data.type === 'stream_resume') {
            onStreamResume?.(data.content ?? '', data.reasoningContent ?? '', data.segments ?? [], !!data.done, data.toolCallsProgress);
          } else if (data.type === 'confirm' && data.content) {
            onConfirm?.(data.content);
          } else if (data.type === 'token_usage' && data.tokenUsage) {
            onTokenUsage?.(data.tokenUsage);
          } else if (data.type === 'compressing' && data.sessionId) {
            onCompressing?.(data.sessionId, data.content ?? 'start');
          } else if (data.type === 'history_changed' && data.sessionId) {
            onHistoryChanged?.(data.sessionId);
          } else if (data.type === 'page_refresh') {
            // 通知 DynamicPage 之类的订阅者重新拉数据。pluginName 缺省 = 全部。
            window.dispatchEvent(new CustomEvent('aalis:page-refresh', { detail: { pluginName: data.pluginName } }));
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
  }, [onMessage, onStream, onLog, onToolCall, onStateChanged, onRestarting, onReload, onSessionSwitched, onSessionsChanged, onTodoUpdated, onStreamResume, onConfirm, onTokenUsage, onCompressing, onHistoryChanged, onToolCallProgress, onToolCallProgressClear]);

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
