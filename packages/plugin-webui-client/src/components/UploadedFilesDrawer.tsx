import { useCallback, useEffect, useState } from 'react';
import { File as FileIcon, Trash2, Download, X, RefreshCw } from 'lucide-react';
import { api } from '../api';

interface UploadedFileInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sessionId: string;
  uploadedAt: number;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface UploadedFilesDrawerProps {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}

/**
 * 当前会话已上传文件列表抽屉。
 * 数据走 /api/uploaded-files（由 plugin-webui-server 暴露，背后是 plugin-file-reader
 * 持久化在 pluginData:/file-reader/{sessionId}/ 下的元数据）。
 */
export function UploadedFilesDrawer({ open, onClose, sessionId }: UploadedFilesDrawerProps) {
  const [files, setFiles] = useState<UploadedFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId || sessionId === '__new_chat__') {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ files: UploadedFileInfo[]; error?: string }>(
        `/api/uploaded-files?sessionId=${encodeURIComponent(sessionId)}`,
      );
      if (res.error) throw new Error(res.error);
      setFiles(res.files || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleDelete = useCallback(
    async (file: UploadedFileInfo) => {
      const ok = window.confirm(`确定删除文件 "${file.name}"？删除后无法恢复。`);
      if (!ok) return;
      setDeleting(file.id);
      try {
        const res = await fetch('/api/uploaded-files/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: file.sessionId, fileId: file.id }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        await refresh();
      } catch (err) {
        window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setDeleting(null);
      }
    },
    [refresh],
  );

  const handleDownload = useCallback((file: UploadedFileInfo) => {
    const url = `/api/uploaded-files/download?sessionId=${encodeURIComponent(file.sessionId)}&fileId=${encodeURIComponent(file.id)}`;
    window.open(url, '_blank');
  }, []);

  if (!open) return null;

  return (
    <div className="uploaded-files-drawer">
      <div className="uploaded-files-drawer-header">
        <span className="uploaded-files-drawer-title">已上传的文件</span>
        <div className="uploaded-files-drawer-actions">
          <button
            type="button"
            className="uploaded-files-drawer-btn"
            onClick={refresh}
            title="刷新"
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
          <button type="button" className="uploaded-files-drawer-btn" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="uploaded-files-drawer-body">
        {error && <div className="uploaded-files-drawer-error">加载失败：{error}</div>}
        {!error && files.length === 0 && !loading && (
          <div className="uploaded-files-drawer-empty">当前会话没有已上传的文件</div>
        )}
        {files.map((f) => (
          <div key={f.id} className="uploaded-files-drawer-item">
            <FileIcon size={16} className="uploaded-files-drawer-icon" />
            <div className="uploaded-files-drawer-info">
              <div className="uploaded-files-drawer-name" title={f.name}>{f.name}</div>
              <div className="uploaded-files-drawer-meta">
                {formatSize(f.size)} · {f.mimeType} · {formatTime(f.uploadedAt)}
              </div>
              <div className="uploaded-files-drawer-id" title={f.id}>ID: {f.id}</div>
            </div>
            <button
              type="button"
              className="uploaded-files-drawer-btn"
              onClick={() => handleDownload(f)}
              title="下载"
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              className="uploaded-files-drawer-btn danger"
              onClick={() => handleDelete(f)}
              disabled={deleting === f.id}
              title="删除"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
