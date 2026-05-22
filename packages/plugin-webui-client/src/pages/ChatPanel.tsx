import { useRef, useEffect, useCallback, useState, useMemo, memo } from 'react';
import { MessageSquare, FileText, BrainCircuit, Wrench, Paperclip, ChevronDown, ChevronRight, X, ListTodo, Circle, Loader, CheckCircle2, Square, Zap, Archive, AlertTriangle, History, FolderOpen } from 'lucide-react';
import { pageAction, getSessionId, proxiedMediaUrl } from '../api';
import ReactMarkdown from 'react-markdown';
import 'katex/dist/katex.min.css';
import type { ChatMessage, SystemStatus, TodoItem, ContentSegment } from '../types';
import type { MutableRefObject } from 'react';
import type { TokenUsageData } from '../useWebSocket';
import { preprocessLaTeX } from '../preprocessLaTeX';
import { formatChatTime } from '../utils/dateFormat';
import { REMARK_PLUGINS, REHYPE_PLUGINS, MARKDOWN_COMPONENTS } from '../components/markdownConfig';
import { UploadedFilesDrawer } from '../components/UploadedFilesDrawer';

/** 工具调用实时计时器 */
function ToolCallTimer({ startTime, endTime }: { startTime?: number; endTime?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endTime || !startTime) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [startTime, endTime]);
  if (!startTime) return null;
  const elapsed = ((endTime || now) - startTime) / 1000;
  return <span className="tool-call-timer">{elapsed.toFixed(1)}s</span>;
}

/** 压缩计时器 */
function CompressTimer({ startTime, endTime }: { startTime: number; endTime?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endTime) return;
    let raf: number;
    const tick = () => { setNow(Date.now()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [endTime]);
  const elapsed = ((endTime || now) - startTime) / 1000;
  return <span className="compress-timer">{elapsed.toFixed(1)}s</span>;
}

/** 渲染 tool_call 段的 <details> 块 */
function ToolCallBlock({ seg, index }: { seg: Extract<ContentSegment, { type: 'tool_call' }>; index: number }) {
  return (
    <details key={index} className="tool-call-block">
      <summary className="tool-call-summary">
        <Wrench size={14} /> {seg.name}{seg.result == null ? ' …' : ''}
        <ToolCallTimer startTime={seg.startTime} endTime={seg.endTime} />
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
  );
}

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

/** 部分解析的 JSON 字段 */
interface PartialField {
  key: string;
  keyDone: boolean;
  value: string;
  valueDone: boolean;
  valueType: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'unknown';
}

/** 增量解析不完整的 JSON，提取已流出的字段及其值（用于流式渲染） */
function parsePartialJson(raw: string): PartialField[] | null {
  const s = raw.trim();
  if (!s.startsWith('{')) return null;
  const fields: PartialField[] = [];
  let i = 1;
  const skip = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };

  while (i < s.length) {
    skip();
    if (i >= s.length || s[i] === '}') break;
    if (s[i] !== '"') break;
    i++;
    let key = '';
    let keyDone = false;
    while (i < s.length) {
      if (s[i] === '\\' && i + 1 < s.length) { key += s[i + 1]; i += 2; }
      else if (s[i] === '"') { keyDone = true; i++; break; }
      else { key += s[i]; i++; }
    }
    if (!keyDone) { fields.push({ key, keyDone: false, value: '', valueDone: false, valueType: 'unknown' }); break; }
    skip();
    if (i >= s.length || s[i] !== ':') { fields.push({ key, keyDone: true, value: '', valueDone: false, valueType: 'unknown' }); break; }
    i++; skip();
    if (i >= s.length) { fields.push({ key, keyDone: true, value: '', valueDone: false, valueType: 'unknown' }); break; }

    if (s[i] === '"') {
      i++;
      let val = '';
      let done = false;
      while (i < s.length) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const c = s[i + 1];
          val += c === 'n' ? '\n' : c === 't' ? '\t' : c === '"' ? '"' : c === '\\' ? '\\' : c;
          i += 2;
        } else if (s[i] === '"') { done = true; i++; break; }
        else { val += s[i]; i++; }
      }
      fields.push({ key, keyDone: true, value: val, valueDone: done, valueType: 'string' });
    } else if (s[i] === '{' || s[i] === '[') {
      const open = s[i], close = open === '{' ? '}' : ']';
      let depth = 1; const start = i; i++;
      let inStr = false;
      while (i < s.length && depth > 0) {
        if (inStr) { if (s[i] === '\\') i++; else if (s[i] === '"') inStr = false; }
        else if (s[i] === '"') inStr = true;
        else if (s[i] === open) depth++;
        else if (s[i] === close) depth--;
        i++;
      }
      fields.push({ key, keyDone: true, value: s.slice(start, i), valueDone: depth === 0, valueType: open === '{' ? 'object' : 'array' });
    } else {
      let val = '';
      while (i < s.length && !/[,\s}]/.test(s[i])) { val += s[i]; i++; }
      const done = i < s.length && /[,}]/.test(s[i]);
      const vt = /^(true|false)$/.test(val) ? 'boolean' as const : val === 'null' ? 'null' as const : 'number' as const;
      fields.push({ key, keyDone: true, value: val, valueDone: done, valueType: vt });
    }
  }
  return fields.length > 0 ? fields : null;
}

/** 友好的 JSON 字段标签映射 */
const FIELD_LABELS: Record<string, string> = {
  mood: '心情',
  state: '状态',
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
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
            {preprocessLaTeX(strValue)}
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

/** 流式 JSON 视图：随传输逐字段/逐字符实时渲染 */
function StreamingJsonView({ fields }: { fields: PartialField[] }) {
  return (
    <div className="json-message-view">
      {fields.map((f, idx) => {
        const isLast = idx === fields.length - 1;
        const showCursor = isLast && (!f.valueDone || !f.keyDone);
        const label = f.keyDone ? (FIELD_LABELS[f.key] || f.key) : f.key;
        const isReply = f.keyDone && REPLY_KEYS.has(f.key);

        return (
          <div key={idx} className={`json-field${isReply ? ' json-field-reply' : ''}`}>
            <span className={`json-field-label${!f.keyDone ? ' json-field-partial' : ''}`}>
              {label}
              {!f.keyDone && showCursor && <span className="streaming-cursor" />}
            </span>
            {f.keyDone && (
              isReply && f.value ? (
                <div className="json-field-value json-field-value-md">
                  <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
                    {preprocessLaTeX(f.value)}
                  </ReactMarkdown>
                  {showCursor && <span className="streaming-cursor" />}
                </div>
              ) : (
                <span className="json-field-value">
                  {f.value}
                  {showCursor && <span className="streaming-cursor" />}
                </span>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 渲染助手消息内容：JSON 结构化显示，或 Markdown */
const AssistantContent = memo(function AssistantContent({ content }: { content: string }) {
  const parsed = tryParseJsonObject(content);
  if (parsed) return <JsonMessageView data={parsed} />;
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    const fields = parsePartialJson(content);
    if (fields) return <StreamingJsonView fields={fields} />;
    return null;
  }
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {preprocessLaTeX(content)}
    </ReactMarkdown>
  );
});

/** 根据上传能力计算 accept 属性 */
function computeAccept(caps?: { image: boolean; file: boolean }): string {
  if (!caps) return '';
  const parts: string[] = [];
  if (caps.image) parts.push('image/*');
  if (caps.file) parts.push(DOCUMENT_ACCEPT);
  // 多模态：始终允许 audio/video（由服务端 plugin-media 决定是否处理）
  parts.push('audio/*');
  parts.push('video/*');
  return parts.join(',');
}

/** 判断 mime 是否为 audio/video，用于送 WS 时分流到 attachments[] */
function classifyMediaKind(mime?: string): 'audio' | 'video' | null {
  if (!mime) return null;
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

/** 任务计划状态图标 */
function TodoStatusIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed': return <CheckCircle2 size={14} className="todo-icon todo-icon-done" />;
    case 'in-progress': return <Loader size={14} className="todo-icon todo-icon-active" />;
    default: return <Circle size={14} className="todo-icon todo-icon-pending" />;
  }
}

/** 任务计划栏：可折叠的 todo 列表 */
function TodoBar({ items, onClear, loading }: { items: TodoItem[]; onClear: () => void; loading: boolean }) {
  const [open, setOpen] = useState(true);
  const completed = items.filter(i => i.status === 'completed').length;
  const total = items.length;
  const allDone = completed === total;
  // 有未完成项且正在生成中时，禁止删除
  const clearDisabled = !allDone && loading;

  return (
    <div className={`todo-bar ${allDone ? 'todo-bar-done' : ''}`}>
      <div className="todo-bar-header" onClick={() => setOpen(!open)}>
        <ListTodo size={15} className="todo-bar-icon" />
        <span className="todo-bar-title">任务计划</span>
        <span className="todo-bar-count">{completed}/{total}</span>
        <div className="todo-bar-progress">
          <div className="todo-bar-progress-fill" style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }} />
        </div>
        <button className="todo-bar-toggle" title={open ? '收起' : '展开'}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <button className="todo-bar-clear" onClick={e => { e.stopPropagation(); if (!clearDisabled) onClear(); }} disabled={clearDisabled} title={clearDisabled ? '任务执行中，无法清除' : '清除计划'}>
          <X size={14} />
        </button>
      </div>
      {open && (
        <div className="todo-bar-list">
          {items.map(item => (
            <div key={item.id} className={`todo-item todo-item-${item.status}`}>
              <TodoStatusIcon status={item.status} />
              <span className="todo-item-title">{item.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Checkpoint 回合摘要（来自 plugin-checkpoint） */
interface CheckpointTurnSummary {
  turnId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  fileCount: number;
  execUsed?: boolean;
  filesPreview: string[];
}

/** 单条消息渲染（memoized，避免全量重绘） */
const MessageItem = memo(function MessageItem({ msg, senderName, isLast, isGenerating, onAbort, checkpoint, rolledBack, onRollback, onRollbackWithChat, toolCallsProgress }: {
  msg: ChatMessage;
  senderName: string;
  isLast: boolean;
  isGenerating: boolean;
  onAbort: () => void;
  checkpoint?: CheckpointTurnSummary;
  /** 该回合是否已被回滚过 */
  rolledBack?: boolean;
  onRollback?: (turn: CheckpointTurnSummary) => void;
  onRollbackWithChat?: (turn: CheckpointTurnSummary) => void;
  /** 仅最后一条 assistant 且 isGenerating 时传入：当前正在生成的工具调用进度（按 index 索引） */
  toolCallsProgress?: Map<number, { name: string; charsAccumulated: number; startedAt: number }>;
}) {
  if (msg.role === 'system') {
    return (
      <div className="system-event-separator">
        <span className="system-event-line" />
        <span className="system-event-text"><Archive size={12} /> {msg.content}</span>
        <span className="system-event-line" />
      </div>
    );
  }

  return (
    <div className={`message-group ${msg.role}`}>
      <div className="message-sender">
        <span className="message-sender-name">{msg.role === 'user' ? 'You' : senderName}</span>
        {msg.timestamp ? (
          <span className="message-time" title={new Date(msg.timestamp).toLocaleString()}>
            {formatChatTime(msg.timestamp)}
          </span>
        ) : null}
      </div>
      {/* 用户消息中的图片 */}
      {msg.role === 'user' && msg.images && msg.images.length > 0 && (
        <div className="message-images">
          {msg.images.map((img, j) => (
            <div key={j} className="message-image-wrap">
              <img src={proxiedMediaUrl(img)} alt={`attached-${j}`} className="message-image" />
            </div>
          ))}
        </div>
      )}
      {/* 用户消息中的文件 */}
      {msg.role === 'user' && msg.fileNames && msg.fileNames.length > 0 && (
        <div className="message-files">
          {msg.fileNames.map((name, j) => (
            <div key={j} className="message-file-item">
              <FileText size={14} /> {name}
            </div>
          ))}
        </div>
      )}
      {/* assistant 主动发送的附件（send_image 等工具产生） */}
      {msg.role === 'assistant' && msg.attachments && msg.attachments.length > 0 && (
        <div className="message-images">
          {msg.attachments.map((att, j) => {
            if (att.kind === 'image') {
              return (
                <div key={`a-${j}`} className="message-image-wrap">
                  <img src={proxiedMediaUrl(att.data)} alt={att.name ?? `attachment-${j}`} className="message-image" />
                </div>
              );
            }
            if (att.kind === 'video') {
              return (
                // biome-ignore lint/a11y/useMediaCaption: assistant 生成内容无字幕信息
                <video key={`a-${j}`} controls src={proxiedMediaUrl(att.data)} className="message-image" />
              );
            }
            if (att.kind === 'audio') {
              // biome-ignore lint/a11y/useMediaCaption: assistant 生成内容无字幕信息
              return <audio key={`a-${j}`} controls src={proxiedMediaUrl(att.data)} />;
            }
            return (
              <div key={`a-${j}`} className="message-file-item">
                <FileText size={14} /> {att.name ?? 'attachment'}
              </div>
            );
          })}
        </div>
      )}
      {msg.role === 'assistant' && msg.segments && msg.segments.length > 0 ? (
        // 统一时间线渲染：相邻 reasoning_text 段合并成一个折叠块（默认折叠），
        // text 段渲染为 markdown 气泡，tool_call 段渲染为工具卡片。所有顺序与模型输出一致。
        <div className="message-bubble">
          {(() => {
            const out: React.ReactNode[] = [];
            let i = 0;
            while (i < msg.segments.length) {
              const seg = msg.segments[i];
              if (seg.type === 'reasoning_text') {
                // 合并连续的 reasoning_text（中间允许 tool_call 也归入同一思考块？
                // 这里只合并连续的 reasoning_text；若中间出现 tool_call，则先关闭一个思考块）
                const group: ContentSegment[] = [];
                while (i < msg.segments.length && msg.segments[i].type === 'reasoning_text') {
                  group.push(msg.segments[i]);
                  i++;
                }
                const text = group
                  .filter((s): s is Extract<ContentSegment, { type: 'reasoning_text' }> => s.type === 'reasoning_text')
                  .map(s => s.content)
                  .join('');
                if (text) {
                  out.push(
                    <details key={`r-${i}`} className="thinking-block">
                      <summary className="thinking-summary"><BrainCircuit size={14} /> 思考过程</summary>
                      <div className="thinking-content">
                        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
                          {preprocessLaTeX(text)}
                        </ReactMarkdown>
                      </div>
                    </details>
                  );
                }
                continue;
              }
              if (seg.type === 'text') {
                if (seg.content) {
                  out.push(<AssistantContent key={`t-${i}`} content={seg.content} />);
                }
                i++;
                continue;
              }
              // tool_call
              out.push(<ToolCallBlock key={`tc-${i}`} seg={seg} index={i} />);
              i++;
            }
            return out;
          })()}
        </div>
      ) : msg.role === 'assistant' && msg.reasoningContent ? (
        // 老数据 fallback：无 segments，只能两段式（reasoning 折叠块 + 内容气泡）
        <>
          <details className="thinking-block">
            <summary className="thinking-summary"><BrainCircuit size={14} /> 思考过程</summary>
            <div className="thinking-content">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
                {preprocessLaTeX(msg.reasoningContent)}
              </ReactMarkdown>
            </div>
          </details>
          <div className="message-bubble">
            <AssistantContent content={msg.content} />
          </div>
        </>
      ) : (
        <div className="message-bubble">
          {msg.role === 'assistant' ? (
            <AssistantContent content={msg.content} />
          ) : (
            msg.content
          )}
        </div>
      )}
      {/* 工具调用「生成中」占位卡：与 ToolCallBlock 视觉对齐（同 .tool-call-block 外框），
          phase='start' 后被真正的 ToolCallBlock 接管，原地渐变。
          注意：容器不带 .message-bubble 类，避免被当作独立气泡漏出在主气泡外。 */}
      {msg.role === 'assistant' && toolCallsProgress && toolCallsProgress.size > 0 && (
        <div className="tool-call-progress-bubble">
          {[...toolCallsProgress.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, p]) => (
              <ToolCallProgressCard
                key={`pending-${index}`}
                name={p.name}
                charsAccumulated={p.charsAccumulated}
                startedAt={p.startedAt}
              />
            ))}
        </div>
      )}
      {/* 停止生成按钮：放在正在生成的气泡下方 */}
      {isLast && isGenerating && msg.role === 'assistant' && (
        <button className="stop-generate-btn" onClick={onAbort} title="停止生成">
          ■ 停止生成
        </button>
      )}
      {/* Checkpoint 回滚按钮：仅 assistant 消息且生成完成后显示 */}
      {msg.role === 'assistant' && checkpoint && !isGenerating && (
        rolledBack ? (
          <span className="checkpoint-rolled-back">
            <History size={12} /> 此次修改已回滚
          </span>
        ) : (
          <div className="checkpoint-rollback-actions">
            {checkpoint.fileCount > 0 && (
              <button
                className="checkpoint-rollback-btn"
                onClick={() => onRollback?.(checkpoint)}
                title={`仅回滚本回合的 ${checkpoint.fileCount} 个文件改动（保留对话）${checkpoint.execUsed ? '\n注意：本回合调用过 exec/shell，命令副作用无法回滚' : ''}`}
              >
                <History size={12} /> 回滚文件改动
                {checkpoint.execUsed && <span className="checkpoint-warn"><AlertTriangle size={11} /> exec</span>}
              </button>
            )}
            <button
              className="checkpoint-rollback-btn"
              onClick={() => onRollbackWithChat?.(checkpoint)}
              title={`回滚本轮对话（含 ${checkpoint.fileCount} 处文件改动）：删除本轮的用户提问、回复和工具调用记录，并恢复文件${checkpoint.execUsed ? '\n注意：本回合调用过 exec/shell，命令副作用无法回滚' : ''}`}
            >
              <History size={12} /> 回滚本轮对话（含文件）
              {checkpoint.execUsed && <span className="checkpoint-warn"><AlertTriangle size={11} /> exec</span>}
            </button>
          </div>
        )
      )}
    </div>
  );
});

/**
 * 工具调用「生成中」占位卡。
 *
 * 视觉上和 `ToolCallBlock` 保持同一外框（`tool-call-block` + `tool-call-progress` 修饰类），
 * 这样从「生成中 → 执行中 → 完成」是同一块原地渐变，不会跳动。
 *
 * 上下文：OpenAI/DeepSeek/Ollama 在生成 `tool_calls` 期间不会发送 `delta.content`，
 * 用户会以为卡死。本组件提供"正在生成 xxx · 142 字符 · 3.2s"的提示，并支持
 * 同一回合中**多工具并发生成**（按 index 分别一张）。
 */
function ToolCallProgressCard({
  name,
  charsAccumulated,
  startedAt,
}: {
  name: string;
  charsAccumulated: number;
  startedAt: number;
}) {
  const [elapsedMs, setElapsedMs] = useState(Date.now() - startedAt);
  useEffect(() => {
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 100);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const seconds = (elapsedMs / 1000).toFixed(1);
  return (
    <div className="tool-call-block tool-call-block-pending" aria-live="polite">
      <div className="tool-call-summary">
        <span className="tool-call-progress-icon"><Wrench size={14} /></span>
        <span>{name || '正在生成…'}</span>
        <span className="tool-call-progress-meta">{charsAccumulated} 字符 · {seconds}s</span>
      </div>
    </div>
  );
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
  sessionTitle,
  onNewSession,
  todoItems,
  onClearTodos,
  toolLimitReached,
  onContinueTools,
  toolCallsProgress,
  tokenUsage,
  compressingStatus,
  onCompress,
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
  /** 当前会话的显示标题 */
  sessionTitle?: string;
  /** 新建会话的回调 */
  onNewSession?: () => void;
  /** 任务计划列表 */
  todoItems?: TodoItem[];
  /** 清除任务计划 */
  onClearTodos?: () => void;
  /** 工具调用达到上限 */
  toolLimitReached?: boolean;
  /** 用户确认继续工具调用 */
  onContinueTools?: () => void;
  /** LLM 正在生成工具调用（在 tool_call 阶段不发文本，需要 UI 显示「生成中」避免「卡死感」）
   *  多工具并发场景：按 index 维护多个 entry，渲染为多张占位卡 */
  toolCallsProgress?: Map<number, { name: string; charsAccumulated: number; startedAt: number }>;
  /** Token 使用量统计 */
  tokenUsage?: TokenUsageData | null;
  /** 压缩状态 */
  compressingStatus?: 'start' | 'done' | 'error' | null;
  /** 手动压缩回调 */
  onCompress?: () => void;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  // ──────── Checkpoint 状态 ────────
  /** 当前 session 的所有 checkpoint 回合（按 startedAt 倒序） */
  const [checkpointTurns, setCheckpointTurns] = useState<CheckpointTurnSummary[]>([]);
  /** 已成功回滚的 turnId 集合（用于将按钮变为「已回滚」状态） */
  const [rolledBackTurns, setRolledBackTurns] = useState<Set<string>>(new Set());
  /** 当前 loading 标志的镜像，用于检测「生成结束」边沿来刷新 checkpoints */
  const prevLoadingRef = useRef(loading);
  useEffect(() => {
    let cancelled = false;
    async function fetchTurns() {
      try {
        const sid = getSessionId();
        if (!sid || sid === '__new_chat__') {
          if (!cancelled) setCheckpointTurns([]);
          return;
        }
        const res = await pageAction<CheckpointTurnSummary[] | { error: string }>(
          '@aalis/plugin-checkpoint',
          'listTurns',
          { sessionId: sid },
        );
        if (!cancelled && Array.isArray(res)) setCheckpointTurns(res);
      } catch {
        // plugin-checkpoint 未启用 → 静默忽略
      }
    }
    // 初次加载或刚生成完毕时拉取
    if (prevLoadingRef.current && !loading) fetchTurns();
    else if (messages.length === 0) setCheckpointTurns([]);
    else fetchTurns();
    prevLoadingRef.current = loading;
    return () => { cancelled = true; };
    // sessionTitle 改变作为 session 切换信号
  }, [loading, sessionTitle, messages.length]);

  /** 给定 assistant 消息 timestamp，匹配它所属的回合（窗口 ±5s 容差） */
  const turnByTimestamp = useMemo(() => {
    return (ts: number): CheckpointTurnSummary | undefined => {
      for (const t of checkpointTurns) {
        const lo = t.startedAt - 1000;
        const hi = (t.endedAt ?? t.startedAt + 60_000) + 5000;
        if (ts >= lo && ts <= hi) return t;
      }
      return undefined;
    };
  }, [checkpointTurns]);

  const handleRollback = useCallback(async (turn: CheckpointTurnSummary) => {
    const preview = turn.filesPreview.slice(0, 3).join('\n');
    const more = turn.fileCount > turn.filesPreview.length ? `\n... 共 ${turn.fileCount} 个文件` : '';
    const execWarn = turn.execUsed ? '\n\n⚠ 本回合调用过 exec/shell，命令的副作用无法回滚！' : '';
    const ok = window.confirm(
      `将回滚此回合的文件改动：\n\n${preview}${more}${execWarn}\n\n确定继续？`,
    );
    if (!ok) return;
    try {
      const result = await pageAction<{ ok: boolean; restored: string[]; deleted: string[]; errors: Array<{ uri: string; reason: string }> }>(
        '@aalis/plugin-checkpoint',
        'rollback',
        { sessionId: getSessionId(), turnId: turn.turnId },
      );
      const summary = `回滚完成：恢复 ${result.restored.length} 个，删除 ${result.deleted.length} 个`;
      if (result.errors.length > 0) {
        window.alert(`${summary}\n失败 ${result.errors.length} 个（如有新建文件在不可删除的根下，需手动删除）：\n` + result.errors.map(e => `${e.uri}: ${e.reason}`).join('\n'));
      } else {
        window.alert(summary);
      }
      // 无论是否有部分失败，都标记为已回滚（至少执行了部分还原）
      setRolledBackTurns(prev => new Set([...prev, turn.turnId]));
    } catch (err) {
      window.alert(`回滚失败：${(err as Error).message}`);
    }
  }, []);

  const handleRollbackWithChat = useCallback(async (turn: CheckpointTurnSummary) => {
    const preview = turn.filesPreview.slice(0, 3).join('\n');
    const more = turn.fileCount > turn.filesPreview.length ? `\n... 共 ${turn.fileCount} 个文件` : '';
    const execWarn = turn.execUsed ? '\n\n⚠ 本回合调用过 exec/shell，命令的副作用无法回滚！' : '';
    const fileText = turn.fileCount > 0 ? `\n\n同时恢复以下文件：\n${preview}${more}` : '';
    const ok = window.confirm(
      `将回滚本轮对话：\n\n· 删除本轮的用户提问、AI 回复和工具调用记录\n· 清除对应的向量记忆条目${fileText}${execWarn}\n\n此操作不可撤销。确定继续？`,
    );
    if (!ok) return;
    try {
      const result = await pageAction<{ ok: boolean; restored: string[]; deleted: string[]; errors: Array<{ uri: string; reason: string }>; deletedMessages: number; chatDeleted: boolean }>(
        '@aalis/plugin-checkpoint',
        'rollbackWithChat',
        { sessionId: getSessionId(), turnId: turn.turnId },
      );
      const parts: string[] = [];
      if (result.chatDeleted) parts.push(`删除 ${result.deletedMessages} 条消息`);
      if (turn.fileCount > 0) parts.push(`恢复 ${result.restored.length} 个文件，删除 ${result.deleted.length} 个新建文件`);
      const summary = parts.length > 0 ? `回滚完成：${parts.join('；')}` : '回滚完成';
      if (result.errors.length > 0) {
        window.alert(`${summary}\n失败 ${result.errors.length} 项：\n` + result.errors.map(e => `${e.uri || '(memory)'}: ${e.reason}`).join('\n'));
      } else {
        // 成功时不打扰用户，前端会通过 history_changed 自动刷新
      }
      setRolledBackTurns(prev => new Set([...prev, turn.turnId]));
    } catch (err) {
      window.alert(`回滚失败：${(err as Error).message}`);
    }
  }, []);

  /** 用户正在主动滚动（防止 auto-scroll 与用户手势冲突） */
  const userScrollingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUserScrolling = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [showTokenPanel, setShowTokenPanel] = useState(false);
  const [showUploadedFiles, setShowUploadedFiles] = useState(false);
  const compressStartTime = useRef(0);
  const compressEndTime = useRef(0);

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

  // 跟踪压缩计时
  useEffect(() => {
    if (compressingStatus === 'start') {
      compressStartTime.current = Date.now();
      compressEndTime.current = 0;
    } else if (compressingStatus === 'done' || compressingStatus === 'error') {
      compressEndTime.current = Date.now();
    }
  }, [compressingStatus]);

  // 智能滚动：用户滚动查看上方内容时不强制滚动，回到底部时恢复自动滚动
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // 距底部小于 200px 视为在底部
      userScrolledUp.current = scrollHeight - scrollTop - clientHeight > 200;
      // 标记用户正在主动操作滚动条，短暂抑制自动滚动
      isUserScrolling.current = true;
      if (userScrollingTimer.current) clearTimeout(userScrollingTimer.current);
      userScrollingTimer.current = setTimeout(() => { isUserScrolling.current = false; }, 300);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // 监听容器高度变化（包括 details 展开、流式内容增长等）自动跟随底部
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (!userScrolledUp.current && !isUserScrolling.current) {
        // 流式生成中用 instant 跳转避免堆积 smooth 动画
        messagesEndRef.current?.scrollIntoView({ behavior: loading ? 'instant' : 'smooth' });
      }
    });
    // 只观察容器本身——子元素尺寸变化会冒泡到容器高度变化
    observer.observe(container);
    return () => observer.disconnect();
  }, [messages.length]);

  useEffect(() => {
    if (!userScrolledUp.current && !isUserScrolling.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
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

  /** 处理拖拽上传的文件 */
  const processDroppedFiles = async (fileList: FileList) => {
    const newImages: string[] = [];
    const newFiles: Array<{ name: string; data: string; mimeType?: string }> = [];
    const orderEntries: Array<'image' | 'file'> = [];
    for (const file of Array.from(fileList)) {
      if (file.type.startsWith('image/') && canUploadImage) {
        if (file.size > 10 * 1024 * 1024) continue;
        const dataUrl = await fileToDataUrl(file);
        newImages.push(dataUrl);
        orderEntries.push('image');
      } else if (canUploadFile) {
        if (file.size > 20 * 1024 * 1024) continue;
        const dataUrl = await fileToDataUrl(file);
        newFiles.push({ name: file.name, data: dataUrl, mimeType: file.type || undefined });
        orderEntries.push('file');
      }
    }
    if (newImages.length > 0) setPendingImages(prev => [...prev, ...newImages]);
    if (newFiles.length > 0) setPendingFiles(prev => [...prev, ...newFiles]);
    if (orderEntries.length > 0) attachmentOrderRef.current = [...attachmentOrderRef.current, ...orderEntries];
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (canUpload && e.dataTransfer.types.includes('Files')) setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false); }
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    if (!canUpload || !e.dataTransfer.files.length) return;
    await processDroppedFiles(e.dataTransfer.files);
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
    <div
      className={`chat-panel${isDragging ? ' drag-over' : ''}`}
      style={{ width }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-content"><Paperclip size={16} /> 松开以上传文件</div>
        </div>
      )}
      <div className="chat-panel-header">
        <span className="chat-panel-title">
          <MessageSquare size={16} /> {sessionTitle || status?.name || 'Aalis'}
        </span>
        <div className="chat-panel-header-actions">
          <div
            className="token-usage-badge"
            onMouseEnter={() => setShowTokenPanel(true)}
            onMouseLeave={() => setShowTokenPanel(false)}
          >
            <Zap size={12} />
            <span className={`token-usage-number${tokenUsage && tokenUsage.usageRatio > 0.85 ? ' warn' : tokenUsage && tokenUsage.usageRatio > 0.7 ? ' caution' : ''}`}>
              {tokenUsage ? tokenUsage.used.toLocaleString() : '--'}
            </span>
            {showTokenPanel && (
              <div className="token-usage-panel">
                <div className="token-panel-title">Token 使用情况</div>
                {tokenUsage ? (
                  <>
                    <div className="token-panel-bar">
                      <div
                        className={`token-panel-bar-fill${tokenUsage.usageRatio > 0.85 ? ' warn' : tokenUsage.usageRatio > 0.7 ? ' caution' : ''}`}
                        style={{ width: `${Math.min(100, tokenUsage.usageRatio * 100)}%` }}
                      />
                    </div>
                    <div className="token-panel-ratio">{(tokenUsage.usageRatio * 100).toFixed(1)}% 已使用</div>
                    <div className="token-panel-rows">
                      <div className="token-panel-row">
                        <span>上下文窗口</span>
                        <span>{tokenUsage.contextWindow.toLocaleString()}</span>
                      </div>
                      <div className="token-panel-section-header">系统提示词 <span className="token-panel-section-total">{tokenUsage.breakdown.system.toLocaleString()}</span></div>
                      <div className="token-panel-row sub">
                        <span>人设 / Persona</span>
                        <span>{tokenUsage.breakdown.persona.toLocaleString()}</span>
                      </div>
                      {tokenUsage.breakdown.memorySummary > 0 && (
                        <div className="token-panel-row sub">
                          <span>对话摘要</span>
                          <span>{tokenUsage.breakdown.memorySummary.toLocaleString()}</span>
                        </div>
                      )}
                      {tokenUsage.breakdown.memoryVector > 0 && (
                        <div className="token-panel-row sub">
                          <span>向量记忆</span>
                          <span>{tokenUsage.breakdown.memoryVector.toLocaleString()}</span>
                        </div>
                      )}
                      {tokenUsage.breakdown.skills > 0 && (
                        <div className="token-panel-row sub">
                          <span>技能描述</span>
                          <span>{tokenUsage.breakdown.skills.toLocaleString()}</span>
                        </div>
                      )}
                      {tokenUsage.breakdown.platform > 0 && (
                        <div className="token-panel-row sub">
                          <span>平台提示</span>
                          <span>{tokenUsage.breakdown.platform.toLocaleString()}</span>
                        </div>
                      )}
                      {tokenUsage.breakdown.subtask > 0 && (
                        <div className="token-panel-row sub">
                          <span>子任务上下文</span>
                          <span>{tokenUsage.breakdown.subtask.toLocaleString()}</span>
                        </div>
                      )}
                      {tokenUsage.breakdown.systemOther > 0 && (
                        <div className="token-panel-row sub">
                          <span>其他系统提示</span>
                          <span>{tokenUsage.breakdown.systemOther.toLocaleString()}</span>
                        </div>
                      )}
                      <div className="token-panel-row">
                        <span>历史消息</span>
                        <span>{tokenUsage.breakdown.history.toLocaleString()}</span>
                      </div>
                      <div className="token-panel-row">
                        <span>工具结果</span>
                        <span>{tokenUsage.breakdown.toolResults.toLocaleString()}</span>
                      </div>
                      <div className="token-panel-row">
                        <span>工具定义</span>
                        <span>{tokenUsage.breakdown.toolDefs.toLocaleString()}</span>
                      </div>
                      <div className="token-panel-row">
                        <span>回复保留量</span>
                        <span>{tokenUsage.breakdown.reservedForReply.toLocaleString()}</span>
                      </div>
                    </div>
                    {onCompress && (
                      <button
                        className="token-panel-compress-btn"
                        onClick={(e) => { e.stopPropagation(); onCompress(); }}
                        disabled={compressingStatus === 'start'}
                      >
                        {compressingStatus === 'start' ? <><Loader size={12} className="compress-spinner" /> 压缩中…</> : <><Archive size={12} /> 压缩对话</>}
                      </button>
                    )}
                  </>
                ) : (
                  <div className="token-panel-empty">发送消息后将显示 Token 用量统计</div>
                )}
              </div>
            )}
          </div>
          {onNewSession && (
            <button className="chat-panel-new-btn" onClick={onNewSession} title="新对话">+</button>
          )}
          <button
            className="chat-panel-new-btn"
            onClick={() => setShowUploadedFiles(v => !v)}
            title="已上传的文件"
            aria-label="已上传的文件"
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </div>
      <UploadedFilesDrawer
        open={showUploadedFiles}
        onClose={() => setShowUploadedFiles(false)}
        sessionId={getSessionId()}
      />
      <div className="messages" ref={messagesContainerRef}>
        {messages.length === 0 && (
          <div className="empty">
            <div className="empty-icon"><MessageSquare size={40} /></div>
            开始和 {status?.name ?? 'Aalis'} 对话吧
          </div>
        )}
        {messages.map((msg, i) => {
          const isLast = i === messages.length - 1;
          return (
            <MessageItem
              key={i}
              msg={msg}
              senderName={status?.name ?? 'Aalis'}
              isLast={isLast}
              isGenerating={isGenerating}
              onAbort={onAbort}
              checkpoint={msg.role === 'assistant' ? turnByTimestamp(msg.timestamp) : undefined}
              rolledBack={msg.role === 'assistant' ? (() => { const t = turnByTimestamp(msg.timestamp); return t ? rolledBackTurns.has(t.turnId) : false; })() : false}
              onRollback={handleRollback}
              onRollbackWithChat={handleRollbackWithChat}
              toolCallsProgress={isLast && msg.role === 'assistant' && isGenerating ? toolCallsProgress : undefined}
            />
          );
        })}
        {/* 仅在没有 assistant 消息时显示 loading 指示器（首次生成等待） */}
        {loading && (!lastMsg || lastMsg.role !== 'assistant') && (
          <div className="message-group assistant">
            <div className="message-sender">{status?.name ?? 'Aalis'}</div>
            <div className="message-bubble">
              {toolCallsProgress && toolCallsProgress.size > 0 ? (
                // LLM 直接进入 tool_call 生成（无文本/无 reasoning）：渲染占位卡
                [...toolCallsProgress.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([index, p]) => (
                    <ToolCallProgressCard
                      key={`pending-${index}`}
                      name={p.name}
                      charsAccumulated={p.charsAccumulated}
                      startedAt={p.startedAt}
                    />
                  ))
              ) : (
                <div className="typing-indicator">
                  <span /><span /><span />
                </div>
              )}
            </div>
            <button className="stop-generate-btn" onClick={onAbort} title="停止生成">
              ■ 停止生成
            </button>
          </div>
        )}
        {/* 工具调用达到上限提示 */}
        {toolLimitReached && !loading && (
          <div className="tool-limit-bar">
            <span className="tool-limit-text">⚠ 工具调用次数已达上限</span>
            <div className="tool-limit-actions">
              {onContinueTools && (
                <button className="tool-limit-btn continue" onClick={onContinueTools}>
                  继续迭代
                </button>
              )}
              <span className="tool-limit-hint">或输入新内容引导模型</span>
            </div>
          </div>
        )}
        {/* 对话压缩状态 — 消息流内分隔线样式 + 实时计时 */}
        {compressingStatus === 'start' && (
          <div className="system-event-separator compressing">
            <span className="system-event-line" />
            <span className="system-event-text"><Loader size={12} className="compress-spinner" /> 压缩对话中 <CompressTimer startTime={compressStartTime.current} /></span>
            <span className="system-event-line" />
          </div>
        )}
        {compressingStatus === 'done' && (
          <div className="system-event-separator compress-done">
            <span className="system-event-line" />
            <span className="system-event-text"><CheckCircle2 size={12} /> 已压缩对话 <CompressTimer startTime={compressStartTime.current} endTime={compressEndTime.current} /></span>
            <span className="system-event-line" />
          </div>
        )}
        {compressingStatus === 'error' && (
          <div className="system-event-separator compress-error">
            <span className="system-event-line" />
            <span className="system-event-text"><AlertTriangle size={12} /> 压缩失败</span>
            <span className="system-event-line" />
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

      {/* 任务计划栏 */}
      {todoItems && todoItems.length > 0 && onClearTodos && (
        <TodoBar items={todoItems} onClear={onClearTodos} loading={loading} />
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
        {(() => {
          const hasContent = !!(input.trim() || pendingImages.length > 0 || pendingFiles.length > 0);
          const showStop = loading && !hasContent;
          return showStop ? (
            <button
              className="send-btn stop-mode"
              onClick={onAbort}
              title="停止生成"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={onSend}
              disabled={!connected || !hasContent}
            >
              ↑
            </button>
          );
        })()}
      </div>
    </div>
  );
}
