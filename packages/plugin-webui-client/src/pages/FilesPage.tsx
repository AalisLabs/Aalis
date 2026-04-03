import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderOpen, File, Download, Trash2, Pencil, Info, RefreshCw, ChevronRight, ArrowLeft, X } from 'lucide-react';
import { api } from '../api';

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  ext: string;
}

interface FileStat {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: string;
  birthtime: string;
  ext: string;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function FilesPage() {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 重命名状态
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 详情面板
  const [detailEntry, setDetailEntry] = useState<FileStat | null>(null);

  // 删除确认
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

  // toast
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

  // 自动刷新
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDir = useCallback(async (dir: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await api<{ path: string; entries: FileEntry[] }>(`/api/files?path=${encodeURIComponent(dir)}`);
      setEntries(data.entries);
      setCurrentPath(data.path);
    } catch (e: any) {
      setError(e.message || '加载失败');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDir(currentPath); }, []);

  // 自动刷新
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) {
      intervalRef.current = setInterval(() => fetchDir(currentPath), 5000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, currentPath, fetchDir]);

  const navigate = (dir: string) => {
    setRenaming(null);
    setDetailEntry(null);
    fetchDir(dir);
  };

  const goUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    navigate(parts.join('/'));
  };

  // 面包屑
  const breadcrumbs = currentPath ? currentPath.split('/') : [];

  // 重命名
  const startRename = (entry: FileEntry) => {
    setRenaming(entry.path);
    setRenameValue(entry.name);
    setTimeout(() => renameInputRef.current?.select(), 50);
  };

  const submitRename = async () => {
    if (!renaming || !renameValue.trim()) { setRenaming(null); return; }
    try {
      await api('/api/files/rename', {
        method: 'POST',
        body: JSON.stringify({ path: renaming, newName: renameValue.trim() }),
      });
      showToast('重命名成功');
      fetchDir(currentPath);
    } catch (e: any) {
      showToast(`重命名失败: ${e.message}`);
    }
    setRenaming(null);
  };

  // 删除
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api('/api/files/delete', {
        method: 'POST',
        body: JSON.stringify({ path: deleteTarget.path }),
      });
      showToast('已删除');
      setDeleteTarget(null);
      fetchDir(currentPath);
    } catch (e: any) {
      showToast(`删除失败: ${e.message}`);
    }
  };

  // 下载
  const downloadFile = (entry: FileEntry) => {
    const a = document.createElement('a');
    a.href = `/api/files/download?path=${encodeURIComponent(entry.path)}`;
    a.download = entry.name;
    a.click();
  };

  // 查看详情
  const viewInfo = async (entry: FileEntry) => {
    try {
      const info = await api<FileStat>(`/api/files/info?path=${encodeURIComponent(entry.path)}`);
      setDetailEntry(info);
    } catch (e: any) {
      showToast(`获取详情失败: ${e.message}`);
    }
  };

  return (
    <div className="page-files">
      {/* 工具栏 */}
      <div className="files-toolbar">
        <div className="files-breadcrumb">
          <button className="files-nav-btn" onClick={goUp} disabled={!currentPath} title="返回上级">
            <ArrowLeft size={16} />
          </button>
          <span className="breadcrumb-item" onClick={() => navigate('')}>workspace</span>
          {breadcrumbs.map((seg, i) => (
            <span key={i}>
              <ChevronRight size={12} className="breadcrumb-sep" />
              <span className="breadcrumb-item" onClick={() => navigate(breadcrumbs.slice(0, i + 1).join('/'))}>
                {seg}
              </span>
            </span>
          ))}
        </div>
        <div className="files-toolbar-actions">
          <label className="files-auto-refresh" title="自动刷新 (5s)">
            <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
            <span>自动刷新</span>
          </label>
          <button className="files-refresh-btn" onClick={() => fetchDir(currentPath)} title="刷新">
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {/* 文件列表 */}
      {error ? (
        <div className="files-error">{error}</div>
      ) : (
        <div className="files-table-wrapper">
          <table className="files-table">
            <thead>
              <tr>
                <th className="col-name">名称</th>
                <th className="col-size">大小</th>
                <th className="col-mtime">修改时间</th>
                <th className="col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && !loading && (
                <tr><td colSpan={4} className="files-empty">空目录</td></tr>
              )}
              {entries.map(entry => (
                <tr key={entry.path} className="files-row" onDoubleClick={() => entry.isDirectory && navigate(entry.path)}>
                  <td className="col-name">
                    <span className="file-icon">
                      {entry.isDirectory ? <FolderOpen size={16} /> : <File size={16} />}
                    </span>
                    {renaming === entry.path ? (
                      <input
                        ref={renameInputRef}
                        className="rename-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={submitRename}
                        onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null); }}
                      />
                    ) : (
                      <span
                        className={`file-name ${entry.isDirectory ? 'is-dir' : ''}`}
                        onClick={() => entry.isDirectory ? navigate(entry.path) : undefined}
                      >
                        {entry.name}
                      </span>
                    )}
                  </td>
                  <td className="col-size">{entry.isDirectory ? '—' : formatSize(entry.size)}</td>
                  <td className="col-mtime">{formatTime(entry.mtime)}</td>
                  <td className="col-actions">
                    <button className="file-action-btn" title="重命名" onClick={() => startRename(entry)}><Pencil size={14} /></button>
                    {!entry.isDirectory && (
                      <button className="file-action-btn" title="下载" onClick={() => downloadFile(entry)}><Download size={14} /></button>
                    )}
                    <button className="file-action-btn" title="详情" onClick={() => viewInfo(entry)}><Info size={14} /></button>
                    <button className="file-action-btn danger" title="删除" onClick={() => setDeleteTarget(entry)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <div className="files-modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="files-modal" onClick={e => e.stopPropagation()}>
            <div className="files-modal-title">确认删除</div>
            <p>确定要删除 <strong>{deleteTarget.name}</strong> 吗？{deleteTarget.isDirectory ? '（将递归删除目录下所有内容）' : ''}</p>
            <div className="files-modal-actions">
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>取消</button>
              <button className="btn-danger" onClick={confirmDelete}>删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 详情面板 */}
      {detailEntry && (
        <div className="files-modal-overlay" onClick={() => setDetailEntry(null)}>
          <div className="files-modal files-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="files-modal-header">
              <div className="files-modal-title">文件详情</div>
              <button className="files-modal-close" onClick={() => setDetailEntry(null)}><X size={16} /></button>
            </div>
            <div className="files-detail-grid">
              <span className="detail-label">名称</span><span className="detail-value">{detailEntry.name}</span>
              <span className="detail-label">路径</span><span className="detail-value">{detailEntry.path}</span>
              <span className="detail-label">类型</span><span className="detail-value">{detailEntry.isDirectory ? '目录' : (detailEntry.ext || '文件')}</span>
              <span className="detail-label">大小</span><span className="detail-value">{detailEntry.isDirectory ? '—' : formatSize(detailEntry.size)}</span>
              <span className="detail-label">修改时间</span><span className="detail-value">{formatTime(detailEntry.mtime)}</span>
              <span className="detail-label">创建时间</span><span className="detail-value">{formatTime(detailEntry.birthtime)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && <div className="files-toast">{toast}</div>}
    </div>
  );
}
