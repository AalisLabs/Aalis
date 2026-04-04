import { useState, useEffect, useRef, useCallback } from 'react';
import type { ContentSegment } from './types';

export interface DetailStreamState {
  /** 当前流式输出的 segments（文本 + 工具调用交替） */
  segments: ContentSegment[];
  /** 思考过程的 segments（推理文本 + 推理期间的工具调用） */
  reasoningSegments: ContentSegment[];
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 当前是否处于推理阶段（用于将工具调用归入 reasoningSegments） */
  isReasoning: boolean;
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
    reasoningSegments: [],
    isStreaming: false,
    isReasoning: false,
    done: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const shouldStream = !!(sessionId && (sessionStatus === 'active' || sessionStatus === 'waiting'));

  useEffect(() => {
    if (!shouldStream || !sessionId) {
      setState({ segments: [], reasoningSegments: [], isStreaming: false, isReasoning: false, done: false });
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
          const reasoningContent = data.reasoningContent ?? '';
          const rSegs: ContentSegment[] = [];
          const segs: ContentSegment[] = [];
          if (reasoningContent) {
            rSegs.push({ type: 'text', content: reasoningContent });
          }
          if (data.segments && data.segments.length > 0) {
            for (const seg of data.segments as ContentSegment[]) {
              if (seg.type === 'tool_call' && reasoningContent) {
                rSegs.push(seg);
              } else {
                segs.push(seg);
              }
            }
          } else {
            const content = data.content ?? '';
            if (content) segs.push({ type: 'text', content });
          }
          setState({
            segments: segs,
            reasoningSegments: rSegs,
            isStreaming: !data.done,
            isReasoning: !!reasoningContent && !data.content,
            done: !!data.done,
          });
        } else if (data.type === 'stream') {
          if (data.done) {
            setState(prev => ({ ...prev, isStreaming: false, isReasoning: false, done: true }));
          } else {
            setState(prev => {
              const segments = [...prev.segments];
              const reasoningSegments = [...prev.reasoningSegments];
              let isReasoning = prev.isReasoning;
              if (data.reasoningDelta) {
                isReasoning = true;
                const last = reasoningSegments[reasoningSegments.length - 1];
                if (last && last.type === 'text') {
                  reasoningSegments[reasoningSegments.length - 1] = { type: 'text', content: last.content + data.reasoningDelta };
                } else {
                  reasoningSegments.push({ type: 'text', content: data.reasoningDelta });
                }
              }
              if (data.contentDelta) {
                isReasoning = false;
                const last = segments[segments.length - 1];
                if (last && last.type === 'text') {
                  segments[segments.length - 1] = { type: 'text', content: last.content + data.contentDelta };
                } else {
                  segments.push({ type: 'text', content: data.contentDelta });
                }
              }
              return { ...prev, segments, reasoningSegments, isReasoning, isStreaming: true };
            });
          }
        } else if (data.type === 'tool_call') {
          setState(prev => {
            // 曾产生过推理内容时，工具调用归入 reasoningSegments
            const hasReasoning = prev.reasoningSegments.length > 0;
            const target = hasReasoning ? [...prev.reasoningSegments] : [...prev.segments];
            if (data.toolPhase === 'start') {
              target.push({ type: 'tool_call', name: data.toolName, args: data.toolArgs ?? {} });
            } else if (data.toolPhase === 'end' && data.toolResult !== undefined) {
              const idx = target.findLastIndex(
                (s): s is Extract<ContentSegment, { type: 'tool_call' }> =>
                  s.type === 'tool_call' && s.name === data.toolName && s.result == null,
              );
              if (idx >= 0) {
                const seg = target[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
                target[idx] = { ...seg, result: data.toolResult };
              }
            }
            if (hasReasoning) {
              return { ...prev, reasoningSegments: target, isStreaming: true };
            }
            return { ...prev, segments: target, isStreaming: true };
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
    setState({ segments: [], reasoningSegments: [], isStreaming: false, isReasoning: false, done: false });
  }, []);

  return [state, reset];
}
