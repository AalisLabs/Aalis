import { useRef, useEffect, useCallback, useState } from 'react';
import { MessageSquare, FileText, BrainCircuit, Wrench, Paperclip, ChevronDown, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage, SystemStatus } from '../types';
import type { MutableRefObject } from 'react';

/** 将 File 转为 base64 data URL */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** 支持的文档文件扩展名 */
const DOCUMENT_EXTENSIONS = [
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm',
  '.css', '.js', '.ts', '.yaml', '.yml', '.ini', '.cfg',
  '.conf', '.log', '.sh', '.py', '.java', '.c', '.cpp',
  '.h', '.rs', '.go', '.rb', '.php', '.sql',
  '.pdf', '.docx',
];

const DOCUMENT_ACCEPT = DOCUMENT_EXTENSIONS.join(',') +
  ',text/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** 尝试将内容解析为 JSON 对象；返回 null 表示非 JSON 或解析失败 */
function tryParseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 流式传输中 JSON 不完整时，提取已流出的回复文本 */
function extractStreamingReply(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return content;
  const match = trimmed.match(/^\{\s*"(?:response|reply|content|answer|text|msg|message)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (match) {
    return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\t/g, '\t');
  }
  // JSON 骨架已出现但内容尚未流出
  return '';
}

/** 友好的 JSON 字段标签映射 */
const FIELD_LABELS: Record<string, string> = {
  favor: '好感度',
  mood: '心情',
  state: '状态',
  interaction: '互动',
  desire: '发言欲望',
  current_action: '当前动作',
  think: '思考',
  message: '回复',
  response: '回复',
  reply: '回复',
  content: '内容',
  analysis: '分析',
  file_analysis: '文件分析',
  image_analysis: '图片分析',
};

/** 标记为主要回复内容的字段名 */
const REPLY_KEYS = new Set(['message', 'response', 'reply', 'content', 'answer', 'text', 'msg']);

/** 展开/折叠一个嵌套对象字段 */
function JsonFieldGroup({ label, data }: { label: string; data: Record<string, unknown> }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="json-field json-field-group">
      <div className="json-field-header json-field-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="json-field-label">{label}</span>
      </div>
      {open && (
        <div className="json-field-children">
          {Object.entries(data).map(([k, v]) => (
            <JsonField key={k} fieldKey={k} value={v} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 渲染单个 JSON 字段 */
function JsonField({ fieldKey, value }: { fieldKey: string; value: unknown }) {
  const label = FIELD_LABELS[fieldKey] || fieldKey;

  if (value === null || value === undefined || value === '') return null;

  // 嵌套对象
  if (typeof value === 'object' && !Array.isArray(value)) {
    return <JsonFieldGroup label={label} data={value as Record<string, unknown>} />;
  }

  // 数组
  if (Array.isArray(value)) {
    return (
      <div className="json-field">
        <span className="json-field-label">{label}</span>
        <span className="json-field-value">{value.map(String).join(', ')}</span>
      </div>
    );
  }

  const strValue = String(value);
  const isReply = REPLY_KEYS.has(fieldKey);

  return (
    <div className={`json-field${isReply ? ' json-field-reply' : ''}`}>
      <span className="json-field-label">{label}</span>
      {isReply ? (
        <div className="json-field-value json-field-value-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {strValue}
          </ReactMarkdown>
        </div>
      ) : (
        <span className="json-field-value">{strValue}</span>
      )}
    </div>
  );
}

/** 将 JSON 对象渲染为带标签的字段卡片 */
function JsonMessageView({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="json-message-view">
      {Object.entries(data).map(([key, value]) => (
        <JsonField key={key} fieldKey={key} value={value} />
      ))}
    </div>
  );
}

/** 渲染助手消息内容：JSON 结构化显示，或 Markdown */
function AssistantContent({ content }: { content: string }) {
  const parsed = tryParseJsonObject(content);
  if (parsed) {
    return <JsonMessageView data={parsed} />;
  }
  // 非 JSON — 可能是流式传输中尚未完整的 JSON
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    const streaming = extractStreamingReply(content);
    if (!streaming) return null; // JSON 骨架，隐藏
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {streaming}
      </ReactMarkdown>
    );
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {content}
    </ReactMarkdown>
  );
}

/** 根据上传能力计算 accept 属性 */
function computeAccept(caps?: { image: boolean; file: boolean }): string {
  if (!caps) return '';
  const parts: string[] = [];
  if (caps.image) parts.push('image/*');
  if (caps.file) parts.push(DOCUMENT_ACCEPT);
  return parts.join(',');
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
  pendingFiles,
  setPendingFiles,
  attachmentOrderRef,
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
  pendingFiles: Array<{ name: string; data: string; mimeType?: string }>;
  setPendingFiles: (v: Array<{ name: string; data: string; mimeType?: string }> | ((prev: Array<{ name: string; data: string; mimeType?: string }>) => Array<{ name: string; data: string; mimeType?: string }>)) => void;
  attachmentOrderRef: MutableRefObject<Array<'image' | 'file'>>;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 上传能力
  const uploadCaps = status?.uploadCapabilities;
  const canUploadImage = uploadCaps?.image ?? false;
  const canUploadFile = uploadCaps?.file ?? false;
  const canUpload = canUploadImage || canUploadFile;
  const acceptAttr = computeAccept(uploadCaps);

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
    const newFiles: Array<{ name: string; data: string; mimeType?: string }> = [];
    const orderEntries: Array<'image' | 'file'> = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/') && canUploadImage) {
        // 图片文件 → 图片队列
        if (file.size > 10 * 1024 * 1024) continue;
        const dataUrl = await fileToDataUrl(file);
        newImages.push(dataUrl);
        orderEntries.push('image');
      } else if (canUploadFile) {
        // 非图片文件 → 文件队列
        if (file.size > 20 * 1024 * 1024) continue;
        const dataUrl = await fileToDataUrl(file);
        newFiles.push({ name: file.name, data: dataUrl, mimeType: file.type || undefined });
        orderEntries.push('file');
      }
    }
    if (newImages.length > 0) {
      setPendingImages(prev => [...prev, ...newImages]);
    }
    if (newFiles.length > 0) {
      setPendingFiles(prev => [...prev, ...newFiles]);
    }
    if (orderEntries.length > 0) {
      attachmentOrderRef.current = [...attachmentOrderRef.current, ...orderEntries];
    }
    e.target.value = '';
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (!canUploadImage) return;
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
      attachmentOrderRef.current = [...attachmentOrderRef.current, ...newImages.map(() => 'image' as const)];
    }
  };

  const removeImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
    // 从 attachmentOrder 中移除第 (index+1) 个 'image'
    const order = [...attachmentOrderRef.current];
    let count = 0;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'image') {
        if (count === index) { order.splice(i, 1); break; }
        count++;
      }
    }
    attachmentOrderRef.current = order;
  };

  const removeFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
    const order = [...attachmentOrderRef.current];
    let count = 0;
    for (let i = 0; i < order.length; i++) {
      if (order[i] === 'file') {
        if (count === index) { order.splice(i, 1); break; }
        count++;
      }
    }
    attachmentOrderRef.current = order;
  };

  /** 检查最后一条消息是否正在生成（用于放置停止按钮） */
  const lastMsg = messages[messages.length - 1];
  const isGenerating = lastMsg?.role === 'assistant' && loading;

  return (
    <div className="chat-panel" style={{ width }}>
      <div className="chat-panel-header">
        <span className="chat-panel-title"><MessageSquare size={16} /> {status?.name ?? 'Aalis'}</span>
      </div>
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-icon"><MessageSquare size={40} /></div>
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
                {msg.images.map((img, j) => {
                  let globalPos = 0;
                  if (msg.attachmentOrder) {
                    let cnt = 0;
                    for (let k = 0; k < msg.attachmentOrder.length; k++) {
                      if (msg.attachmentOrder[k] === 'image') {
                        if (cnt === j) { globalPos = k + 1; break; }
                        cnt++;
                      }
                    }
                  }
                  return (
                    <div key={j} className="message-image-wrap">
                      <img src={img} alt={`attached-${j}`} className="message-image" />
                      {globalPos > 0 && <span className="message-attach-order">#{globalPos}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {/* 用户消息中的文件 */}
            {msg.role === 'user' && msg.fileNames && msg.fileNames.length > 0 && (
              <div className="message-files">
                {msg.fileNames.map((name, j) => {
                  let globalPos = 0;
                  if (msg.attachmentOrder) {
                    let cnt = 0;
                    for (let k = 0; k < msg.attachmentOrder.length; k++) {
                      if (msg.attachmentOrder[k] === 'file') {
                        if (cnt === j) { globalPos = k + 1; break; }
                        cnt++;
                      }
                    }
                  }
                  return (
                    <div key={j} className="message-file-item">
                      {globalPos > 0 && <span className="message-attach-order">#{globalPos}</span>}
                      <FileText size={14} /> {name}
                    </div>
                  );
                })}
              </div>
            )}
            {msg.role === 'assistant' && msg.reasoningSegments && msg.reasoningSegments.length > 0 && (
              <details className="thinking-block">
                <summary className="thinking-summary"><BrainCircuit size={14} /> 思考过程</summary>
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
                          <Wrench size={14} /> {seg.name}{seg.result == null ? ' …' : ''}
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
                      <AssistantContent key={j} content={seg.content} />
                    ) : null
                  ) : (
                    <details key={j} className="tool-call-block">
                      <summary className="tool-call-summary">
                        <Wrench size={14} /> {seg.name}{seg.result == null ? ' …' : ''}
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
                  <AssistantContent content={msg.content} />
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
          {pendingImages.map((img, i) => {
            // 计算该图片在 attachmentOrder 中的全局序号
            const order = attachmentOrderRef.current;
            let imgIdx = 0, globalPos = 0;
            for (let k = 0; k < order.length; k++) {
              if (order[k] === 'image') {
                if (imgIdx === i) { globalPos = k + 1; break; }
                imgIdx++;
              }
            }
            return (
              <div key={i} className="pending-image-item">
                <img src={img} alt={`pending-${i}`} />
                <button className="pending-image-remove" onClick={() => removeImage(i)}>×</button>
                {globalPos > 0 && <span className="pending-order-badge">#{globalPos}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* 文件预览区域 */}
      {pendingFiles.length > 0 && (
        <div className="pending-files">
          {pendingFiles.map((file, i) => {
            const order = attachmentOrderRef.current;
            let fileIdx = 0, globalPos = 0;
            for (let k = 0; k < order.length; k++) {
              if (order[k] === 'file') {
                if (fileIdx === i) { globalPos = k + 1; break; }
                fileIdx++;
              }
            }
            return (
              <div key={i} className="pending-file-item">
                {globalPos > 0 && <span className="pending-file-order">#{globalPos}</span>}
                <span className="pending-file-icon"><FileText size={14} /></span>
                <span className="pending-file-name">{file.name}</span>
                <button className="pending-file-remove" onClick={() => removeFile(i)}>×</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="input-area">
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptAttr}
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        {canUpload && (
          <button
            className="upload-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={!connected}
            title={canUploadImage && canUploadFile ? '上传图片或文件' : canUploadImage ? '上传图片' : '上传文件'}
          >
            <Paperclip size={18} />
          </button>
        )}
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
          disabled={!connected || (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0)}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
