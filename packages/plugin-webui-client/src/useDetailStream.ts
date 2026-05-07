import { useState, useEffect, useRef, useCallback } from 'react';
import type { ContentSegment } from './types';

export interface DetailStreamState {
  /** 当前流式输出的统一时间线 segments（保留模型原本的 思考/回答/工具调用 交错顺序） */
  segments: ContentSegment[];
  /** 是否正在流式输出 */
  isStreaming: boolean;
  /** 本轮生成已完成（触发刷新） */
  done: boolean;
}

/**
 * 为会话详情页提供流式输出订阅。
 * 当被查看的会话处于 active/waiting 状态时，自动建立独立 WebSocket 连接并订阅该会话的流式事件。
 *
 * 设计要点（与 App.tsx 主聊天面板保持一致）：
 * - segments 作为唯一真实来源；reasoning_text / text / tool_call 按到达顺序追加，相邻同类文本合并。
 * - stream_resume 事件直接信任服务端给出的 segments 完整时间线，不做按 reasoningContent 启发式重分类。
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
          // 服务端在订阅瞬间给出的“当前累积时间线”——直接信任之
          let segs: ContentSegment[] = [];
          if (Array.isArray(data.segments) && data.segments.length > 0) {
            segs = data.segments as ContentSegment[];
          } else {
            // 极老的服务端兼容：仅有字符串字段时退化展示，顺序信息已丢失
            const r = data.reasoningContent ?? '';
            const c = data.content ?? '';
            if (r) segs.push({ type: 'reasoning_text', content: r });
            if (c) segs.push({ type: 'text', content: c });
          }
          setState({
            segments: segs,
            isStreaming: !data.done,
            done: !!data.done,
          });
        } else if (data.type === 'stream') {
          if (data.done) {
            setState(prev => ({ ...prev, isStreaming: false, done: true }));
          } else {
            setState(prev => {
              const segments = [...prev.segments];
              const appendDelta = (kind: 'text' | 'reasoning_text', delta: string) => {
                const last = segments[segments.length - 1];
                if (last && last.type === kind) {
                  segments[segments.length - 1] = { type: kind, content: last.content + delta };
                } else {
                  segments.push({ type: kind, content: delta });
                }
              };
              if (data.reasoningDelta) appendDelta('reasoning_text', data.reasoningDelta);
              if (data.contentDelta) appendDelta('text', data.contentDelta);
              return { ...prev, segments, isStreaming: true };
            });
          }
        } else if (data.type === 'tool_call') {
          setState(prev => {
            const segments = [...prev.segments];
            if (data.toolPhase === 'start') {
              segments.push({
                type: 'tool_call',
                name: data.toolName,
                args: data.toolArgs ?? {},
                startTime: Date.now(),
              });
            } else if (data.toolPhase === 'end' && data.toolResult !== undefined) {
              const idx = segments.findLastIndex(
                (s): s is Extract<ContentSegment, { type: 'tool_call' }> =>
                  s.type === 'tool_call' && s.name === data.toolName && s.result == null,
              );
              if (idx >= 0) {
                const seg = segments[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
                segments[idx] = { ...seg, result: data.toolResult, endTime: Date.now() };
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
