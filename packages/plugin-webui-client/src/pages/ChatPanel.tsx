import { useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, SystemStatus } from '../types';

/** 将 File 转为 base64 data URL */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

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
  pendingImages,
  setPendingImages,
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
  pendingImages: string[];
  setPendingImages: (v: string[] | ((prev: string[]) => string[])) => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newImages: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      // 限制单张 10MB
      if (file.size > 10 * 1024 * 1024) continue;
      const dataUrl = await fileToDataUrl(file);
      newImages.push(dataUrl);
    }
    if (newImages.length > 0) {
      setPendingImages(prev => [...prev, ...newImages]);
    }
    // 清空 file input 以允许重复选择同一文件
    e.target.value = '';
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: string[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const dataUrl = await fileToDataUrl(file);
      newImages.push(dataUrl);
    }
    if (newImages.length > 0) {
      setPendingImages(prev => [...prev, ...newImages]);
    }
  };

  const removeImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  };

  /** 检查最后一条消息是否正在生成（用于放置停止按钮） */
  const lastMsg = messages[messages.length - 1];
  const isGenerating = lastMsg?.role === 'assistant' && loading;

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
            {/* 用户消息中的图片 */}
            {msg.role === 'user' && msg.images && msg.images.length > 0 && (
              <div className="message-images">
                {msg.images.map((img, j) => (
                  <img key={j} src={img} alt={`attached-${j}`} className="message-image" />
                ))}
              </div>
            )}
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
            {/* 停止生成按钮：放在正在生成的气泡下方 */}
            {msg.role === 'assistant' && i === messages.length - 1 && isGenerating && (
              <button className="stop-generate-btn" onClick={onAbort} title="停止生成">
                ■ 停止生成
              </button>
            )}
          </div>
        ))}
        {/* 仅在没有 assistant 消息时显示 loading 指示器（首次生成等待） */}
        {loading && (!lastMsg || lastMsg.role !== 'assistant') && (
          <div className="message-group assistant">
            <div className="message-sender">{status?.name ?? 'Aalis'}</div>
            <div className="message-bubble">
              <div className="typing-indicator">
                <span /><span /><span />
              </div>
            </div>
            <button className="stop-generate-btn" onClick={onAbort} title="停止生成">
              ■ 停止生成
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 图片预览区域 */}
      {pendingImages.length > 0 && (
        <div className="pending-images">
          {pendingImages.map((img, i) => (
            <div key={i} className="pending-image-item">
              <img src={img} alt={`pending-${i}`} />
              <button className="pending-image-remove" onClick={() => removeImage(i)}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="input-area">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <button
          className="upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected}
          title="上传图片"
        >
          🖼
        </button>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => { setInput(e.target.value); autoResize(); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={!connected}
          rows={1}
        />
        <button
          className="send-btn"
          onClick={onSend}
          disabled={!connected || (!input.trim() && pendingImages.length === 0)}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
