import { useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, SystemStatus } from '../types';

export function ChatPanel({
  messages,
  loading,
  connected,
  status,
  input,
  setInput,
  onSend,
  onAbort,
  width,
}: {
  messages: ChatMessage[];
  loading: boolean;
  connected: boolean;
  status: SystemStatus | null;
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onAbort: () => void;
  width: number;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // input 被外部清空（发送后）时重置高度
  useEffect(() => { autoResize(); }, [input, autoResize]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="chat-panel" style={{ width }}>
      <div className="chat-panel-header">
        <span className="chat-panel-title">💬 {status?.name ?? 'Aalis'}</span>
      </div>
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-icon">💬</div>
            开始和 {status?.name ?? 'Aalis'} 对话吧
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message-group ${msg.role}`}>
            <div className="message-sender">
              {msg.role === 'user' ? 'You' : status?.name ?? 'Aalis'}
            </div>
            {msg.role === 'assistant' && msg.reasoningSegments && msg.reasoningSegments.length > 0 && (
              <details className="thinking-block">
                <summary className="thinking-summary">💭 思考过程</summary>
                <div className="thinking-content">
                  {msg.reasoningSegments.map((seg, j) =>
                    seg.type === 'text' ? (
                      seg.content ? (
                        <ReactMarkdown key={j} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                          {seg.content}
                        </ReactMarkdown>
                      ) : null
                    ) : (
                      <details key={j} className="tool-call-block">
                        <summary className="tool-call-summary">
                          🔧 {seg.name}{seg.result == null ? ' …' : ''}
                        </summary>
                        <div className="tool-call-content">
                          <div className="tool-call-args">
                            <strong>参数</strong>
                            <pre>{JSON.stringify(seg.args, null, 2)}</pre>
                          </div>
                          {seg.result != null && (
                            <div className="tool-call-result">
                              <strong>结果</strong>
                              <pre>{seg.result}</pre>
                            </div>
                          )}
                        </div>
                      </details>
                    )
                  )}
                </div>
              </details>
            )}
            {msg.role === 'assistant' && msg.segments && msg.segments.length > 0 ? (
              <div className="message-bubble">
                {msg.segments.map((seg, j) =>
                  seg.type === 'text' ? (
                    seg.content ? (
                      <ReactMarkdown key={j} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {seg.content}
                      </ReactMarkdown>
                    ) : null
                  ) : (
                    <details key={j} className="tool-call-block">
                      <summary className="tool-call-summary">
                        🔧 {seg.name}{seg.result == null ? ' …' : ''}
                      </summary>
                      <div className="tool-call-content">
                        <div className="tool-call-args">
                          <strong>参数</strong>
                          <pre>{JSON.stringify(seg.args, null, 2)}</pre>
                        </div>
                        {seg.result != null && (
                          <div className="tool-call-result">
                            <strong>结果</strong>
                            <pre>{seg.result}</pre>
                          </div>
                        )}
                      </div>
                    </details>
                  )
                )}
              </div>
            ) : (
              <div className="message-bubble">
                {msg.role === 'assistant' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {msg.content}
                  </ReactMarkdown>
                ) : (
                  msg.content
                )}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="message-group assistant">
            <div className="message-sender">{status?.name ?? 'Aalis'}</div>
            <div className="message-bubble">
              <div className="typing-indicator">
                <span /><span /><span />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={!connected}
          rows={1}
        />
        {loading && !input.trim() ? (
          <button
            className="send-btn stop-btn"
            onClick={onAbort}
            disabled={!connected}
            title="停止生成"
          >
            ■
          </button>
        ) : (
          <button
            className="send-btn"
            onClick={onSend}
            disabled={!connected || !input.trim()}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
