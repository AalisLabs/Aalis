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

/**
 * WebSocket 消息回调集合。
 *
 * 用单一对象（而非一长串位置参数）传入，避免「漏传/错位某个回调」的脆弱性；
 * 内部存入 ref，使底层连接只在挂载时建立一次，回调更新不会触发重连。
 */
interface WebSocketHandlers {
  onMessage: (
    content: string,
    reasoningContent?: string,
    segments?: ContentSegment[],
    attachments?: Array<{ kind: 'image' | 'audio' | 'video' | 'file'; data: string; mimeType?: string; name?: string }>,
    modelInfo?: { provider?: string; model?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; elapsedMs?: number },
  ) => void;
  onStream: (contentDelta?: string, reasoningDelta?: string, done?: boolean, toolLimitReached?: boolean) => void;
  onLog: (entry: LogEntry) => void;
  onToolCall: (toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => void;
  onStateChanged?: () => void;
  onRestarting?: () => void;
  onReload?: () => void;
  onSessionsChanged?: () => void;
  onTodoUpdated?: (items: unknown[]) => void;
  onStreamResume?: (
    content: string,
    reasoningContent: string,
    segments: ContentSegment[],
    done: boolean,
    toolCallsProgress?: Array<{ index: number; name: string; charsAccumulated: number; startedAt: number }>,
  ) => void;
  onConfirm?: (content: string) => void;
  onTokenUsage?: (usage: TokenUsageData) => void;
  onCompressing?: (sessionId: string, status: 'start' | 'done' | 'error') => void;
  onHistoryChanged?: (sessionId: string) => void;
  /** 单条增量更新；done=true 时调用 onToolCallProgressClear */
  onToolCallProgress?: (progress: { index: number; name: string; charsAccumulated: number }) => void;
  /** 清空所有生成中进度（stream done / 各类重置） */
  onToolCallProgressClear?: () => void;
}

export function useWebSocket(handlers: WebSocketHandlers) {
  // 回调集合存入 ref：底层 WS 只在挂载时连接一次，回调引用变化不触发重连。
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
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
          const h = handlersRef.current;
          if (data.type === 'stream') {
            h.onStream(data.contentDelta, data.reasoningDelta, data.done, data.toolLimitReached);
            if (data.toolCallProgress) {
              h.onToolCallProgress?.(data.toolCallProgress);
            }
            if (data.done) {
              h.onToolCallProgressClear?.();
            }
          } else if (data.type === 'message' && (data.content || data.attachments?.length)) {
            h.onMessage(data.content ?? '', data.reasoningContent, data.segments, data.attachments, data.modelInfo);
          } else if (data.type === 'tool_call' && data.toolName) {
            h.onToolCall(data.toolName, data.toolArgs ?? {}, data.toolPhase, data.toolResult);
          } else if (data.type === 'log' && data.log) {
            h.onLog(data.log);
          } else if (data.type === 'state_changed') {
            h.onStateChanged?.();
          } else if (data.type === 'restarting') {
            h.onRestarting?.();
          } else if (data.type === 'reload') {
            h.onReload?.();
          } else if (data.type === 'sessions_changed') {
            // 会话列表变更（创建/更新/删除/完成）
            h.onSessionsChanged?.();
          } else if (data.type === 'todo_updated' && data.todoItems) {
            h.onTodoUpdated?.(data.todoItems);
          } else if (data.type === 'stream_resume') {
            h.onStreamResume?.(data.content ?? '', data.reasoningContent ?? '', data.segments ?? [], !!data.done, data.toolCallsProgress);
          } else if (data.type === 'confirm' && data.content) {
            h.onConfirm?.(data.content);
          } else if (data.type === 'token_usage' && data.tokenUsage) {
            h.onTokenUsage?.(data.tokenUsage);
          } else if (data.type === 'compressing' && data.sessionId) {
            h.onCompressing?.(data.sessionId, data.content ?? 'start');
          } else if (data.type === 'history_changed' && data.sessionId) {
            h.onHistoryChanged?.(data.sessionId);
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
  }, []);

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

  const send = useCallback((
    content: string,
    attachments?: Array<{ kind: 'image' | 'audio' | 'video' | 'file'; data: string; mimeType?: string; name?: string }>,
  ) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload: Record<string, unknown> = {
        type: 'message',
        content,
        sessionId: getSessionId(),
      };
      if (attachments && attachments.length > 0) {
        payload.attachments = attachments;
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
