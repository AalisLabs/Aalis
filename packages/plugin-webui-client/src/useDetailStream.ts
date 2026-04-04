import { useState, useEffect, useRef, useCallback } from 'react';
import type { ContentSegment } from './types';

export interface DetailStreamState {
  /** 当前流式输出的 segments（文本 + 工具调用交替） */
  segments: ContentSegment[];
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 本轮生成已完成（触发刷新） */
  done: boolean;
}

/**
 * 为会话详情页提供流式输出订阅。
 * 当被查看的会话处于 active/waiting 状态时，自动建立独立 WebSocket 连接并订阅该会话的流式事件。
 */
export function useDetailStream(
  sessionId: string | null,
  sessionStatus: string | undefined,
): [DetailStreamState, () => void] {
  const [state, setState] = useState<DetailStreamState>({
    segments: [],
    isStreaming: false,
    done: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const shouldStream = !!(sessionId && (sessionStatus === 'active' || sessionStatus === 'waiting'));

  useEffect(() => {
    if (!shouldStream || !sessionId) {
      setState({ segments: [], isStreaming: false, done: false });
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe_session', sessionId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'stream_resume') {
          // 刚订阅时，服务端推送已累积的内容（含 segments 则使用完整 segments）
          if (data.segments && data.segments.length > 0) {
            setState({
              segments: data.segments,
              isStreaming: !data.done,
              done: !!data.done,
            });
          } else {
            const content = data.content ?? '';
            setState({
              segments: content ? [{ type: 'text', content }] : [],
              isStreaming: !data.done,
              done: !!data.done,
            });
          }
        } else if (data.type === 'stream') {
          if (data.done) {
            setState(prev => ({ ...prev, isStreaming: false, done: true }));
          } else {
            setState(prev => {
              const segments = [...prev.segments];
              if (data.contentDelta) {
                const last = segments[segments.length - 1];
                if (last && last.type === 'text') {
                  segments[segments.length - 1] = { type: 'text', content: last.content + data.contentDelta };
                } else {
                  segments.push({ type: 'text', content: data.contentDelta });
                }
              }
              return { ...prev, segments, isStreaming: true };
            });
          }
        } else if (data.type === 'tool_call') {
          setState(prev => {
            const segments = [...prev.segments];
            if (data.toolPhase === 'start') {
              segments.push({ type: 'tool_call', name: data.toolName, args: data.toolArgs ?? {} });
            } else if (data.toolPhase === 'end' && data.toolResult !== undefined) {
              const idx = segments.findLastIndex(
                (s): s is Extract<ContentSegment, { type: 'tool_call' }> =>
                  s.type === 'tool_call' && s.name === data.toolName && s.result == null,
              );
              if (idx >= 0) {
                const seg = segments[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
                segments[idx] = { ...seg, result: data.toolResult };
              }
            }
            return { ...prev, segments, isStreaming: true };
          });
        } else if (data.type === 'message') {
          setState(prev => ({ ...prev, done: true, isStreaming: false }));
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => { wsRef.current = null; };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, shouldStream]);

  const reset = useCallback(() => {
    setState({ segments: [], isStreaming: false, done: false });
  }, []);

  return [state, reset];
}
