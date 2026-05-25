import { forwardRef, memo, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { FileText, Paperclip, Square } from 'lucide-react';

/** 将 File 转为 base64 data URL */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export interface ChatInputHandle {
  /** 由外层 drop / 其他渠道接收到的文件转交此处统一处理 */
  addFiles(fileList: FileList | File[]): Promise<void>;
}

interface ChatInputProps {
  loading: boolean;
  connected: boolean;
  canUpload: boolean;
  canUploadImage: boolean;
  canUploadFile: boolean;
  acceptAttr: string;
  onSend: (
    content: string,
    pendingFiles: Array<{ name: string; data: string; mimeType?: string }>,
    pendingImages: string[],
    order: Array<'image' | 'file'>,
  ) => Promise<void> | void;
  onAbort: () => void;
}

/**
 * 输入区组件 —— 将输入框、附件预览、发送按钮等局部 state 隔离在此处，
 * 避免在 ChatPanel 顶层 setState 触发整个 messages 列表 / Drawer 重渲染。
 */
export const ChatInput = memo(
  forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
    { loading, connected, canUpload, canUploadImage, canUploadFile, acceptAttr, onSend, onAbort },
    ref,
  ) {
    const [input, setInput] = useState('');
    const [pendingImages, setPendingImages] = useState<string[]>([]);
    const [pendingFiles, setPendingFiles] = useState<
      Array<{ name: string; data: string; mimeType?: string }>
    >([]);
    const attachmentOrderRef = useRef<Array<'image' | 'file'>>([]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const autoResize = useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }, []);

    const ingestFiles = useCallback(
      async (files: File[] | FileList) => {
        const newImages: string[] = [];
        const newFiles: Array<{ name: string; data: string; mimeType?: string }> = [];
        const orderEntries: Array<'image' | 'file'> = [];
        for (const file of Array.from(files)) {
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
        if (orderEntries.length > 0) {
          attachmentOrderRef.current = [...attachmentOrderRef.current, ...orderEntries];
        }
      },
      [canUploadImage, canUploadFile],
    );

    useImperativeHandle(ref, () => ({ addFiles: ingestFiles }), [ingestFiles]);

    const handleSendAction = useCallback(async () => {
      await onSend(input, pendingFiles, pendingImages, attachmentOrderRef.current);
      setInput('');
      setPendingImages([]);
      setPendingFiles([]);
      attachmentOrderRef.current = [];
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }, [input, pendingFiles, pendingImages, onSend]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSendAction();
      }
    };

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) await ingestFiles(e.target.files);
      e.target.value = '';
    };

    const handlePaste = async (e: React.ClipboardEvent) => {
      if (!canUploadImage) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const pasted: File[] = [];
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) pasted.push(file);
      }
      if (pasted.length > 0) await ingestFiles(pasted);
    };

    const removeImage = (index: number) => {
      setPendingImages(prev => prev.filter((_, i) => i !== index));
      const order = [...attachmentOrderRef.current];
      let count = 0;
      for (let i = 0; i < order.length; i++) {
        if (order[i] === 'image') {
          if (count === index) {
            order.splice(i, 1);
            break;
          }
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
          if (count === index) {
            order.splice(i, 1);
            break;
          }
          count++;
        }
      }
      attachmentOrderRef.current = order;
    };

    // 预计算附件全局序号映射，避免渲染时每个 item 都 O(N) 扫一遍 order 数组
    const order = attachmentOrderRef.current;
    const imageGlobalPos: number[] = new Array(pendingImages.length);
    const fileGlobalPos: number[] = new Array(pendingFiles.length);
    {
      let imgI = 0;
      let fileI = 0;
      for (let k = 0; k < order.length; k++) {
        if (order[k] === 'image') {
          if (imgI < imageGlobalPos.length) imageGlobalPos[imgI] = k + 1;
          imgI++;
        } else if (order[k] === 'file') {
          if (fileI < fileGlobalPos.length) fileGlobalPos[fileI] = k + 1;
          fileI++;
        }
      }
    }

    const hasContent = !!(input.trim() || pendingImages.length > 0 || pendingFiles.length > 0);
    const showStop = loading && !hasContent;

    return (
      <>
        {pendingImages.length > 0 && (
          <div className="pending-images">
            {pendingImages.map((img, i) => (
              <div key={i} className="pending-image-item">
                <img src={img} alt={`pending-${i}`} />
                <button className="pending-image-remove" onClick={() => removeImage(i)}>
                  ×
                </button>
                {imageGlobalPos[i] > 0 && <span className="pending-order-badge">#{imageGlobalPos[i]}</span>}
              </div>
            ))}
          </div>
        )}

        {pendingFiles.length > 0 && (
          <div className="pending-files">
            {pendingFiles.map((file, i) => (
              <div key={i} className="pending-file-item">
                {fileGlobalPos[i] > 0 && <span className="pending-file-order">#{fileGlobalPos[i]}</span>}
                <span className="pending-file-icon">
                  <FileText size={14} />
                </span>
                <span className="pending-file-name">{file.name}</span>
                <button className="pending-file-remove" onClick={() => removeFile(i)}>
                  ×
                </button>
              </div>
            ))}
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
              title={
                canUploadImage && canUploadFile
                  ? '上传图片或文件'
                  : canUploadImage
                    ? '上传图片'
                    : '上传文件'
              }
            >
              <Paperclip size={18} />
            </button>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => {
              setInput(e.target.value);
              autoResize();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
            disabled={!connected}
            rows={1}
          />
          {showStop ? (
            <button className="send-btn stop-mode" onClick={onAbort} title="停止生成">
              <Square size={16} />
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={() => {
                void handleSendAction();
              }}
              disabled={!connected || !hasContent}
            >
              ↑
            </button>
          )}
        </div>
      </>
    );
  }),
);
