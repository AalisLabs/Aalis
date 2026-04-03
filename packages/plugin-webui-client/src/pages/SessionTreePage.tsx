import { useState, useEffect, useCallback, useRef } from 'react';
import { pageAction } from '../api';
import { buildChatMessages } from '../useSessionManager';
import type { RawMessage } from '../useSessionManager';
import type { ChatMessage } from '../types';

// ===== 类型 =====

interface SessionInfo {
  id: string;
  name: string;
  title?: string;
  parentId?: string;
  children: string[];
  status: 'active' | 'waiting' | 'completed' | 'error' | 'archived';
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
  inputContext?: string;
  result?: string;
}

interface TreeNode {
  session: SessionInfo;
  children: TreeNode[];
}

interface SessionDetail {
  session: SessionInfo;
  messages: RawMessage[];
}

// ===== 工具函数 =====

const statusLabel: Record<string, string> = {
  active: '进行中',
  waiting: '等待中',
  completed: '已完成',
  error: '错误',
  archived: '已归档',
};

const statusColor: Record<string, string> = {
  active: '#4caf50',
  waiting: '#ff9800',
  completed: '#2196f3',
  error: '#f44336',
  archived: '#888',
};

function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ===== 组件 =====

export function SessionTreePage({ pluginName }: { pluginName: string }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTree = useCallback(() => {
    pageAction<TreeNode[]>(pluginName, 'getSessionTree')
      .then(data => { if (Array.isArray(data)) setTree(data); })
      .catch(() => setError('无法加载会话树'));
  }, [pluginName]);

  useEffect(() => {
    fetchTree();
    const iv = setInterval(fetchTree, 15000);
    return () => clearInterval(iv);
  }, [fetchTree]);

  const loadDetail = useCallback((id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    pageAction<SessionDetail>(pluginName, 'getSessionDetail', { id })
      .then(d => setDetail(d))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, []);

  if (error) {
    return <div className="tree-page-error">{error}</div>;
  }

  return (
    <div className="session-tree-page">
      {/* 左侧：树形可视化 */}
      <div className="tree-visual-panel">
        <div className="tree-visual-header">
          <h3>会话树</h3>
          <button className="tree-refresh-btn" onClick={fetchTree}>⟳</button>
        </div>
        <div className="tree-visual-body">
          {tree.length === 0 ? (
            <div className="tree-empty">暂无会话</div>
          ) : (
            tree.map(node => (
              <TreeNodeView
                key={node.session.id}
                node={node}
                selectedId={selectedId}
                onSelect={loadDetail}
                depth={0}
              />
            ))
          )}
        </div>
      </div>

      {/* 右侧：会话详情 */}
      <div className="tree-detail-panel">
        {!selectedId ? (
          <div className="tree-detail-placeholder">点击左侧会话节点查看详情</div>
        ) : detailLoading ? (
          <div className="tree-detail-placeholder">加载中…</div>
        ) : detail ? (
          <SessionDetailView detail={detail} />
        ) : (
          <div className="tree-detail-placeholder">无法加载会话信息</div>
        )}
      </div>
    </div>
  );
}

// ---- 树节点 ----

function TreeNodeView({
  node,
  selectedId,
  onSelect,
  depth,
}: {
  node: TreeNode;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const s = node.session;
  const hasChildren = node.children.length > 0;
  const isSelected = s.id === selectedId;

  return (
    <div className="tree-node-group">
      <div
        className={`tree-node ${isSelected ? 'selected' : ''} status-${s.status}`}
        style={{ marginLeft: depth * 24 }}
        onClick={() => onSelect(s.id)}
      >
        {/* 展开/折叠 */}
        <button
          className="tree-node-toggle"
          onClick={e => { e.stopPropagation(); setExpanded(!expanded); }}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
        >
          {expanded ? '▾' : '▸'}
        </button>

        {/* 状态点 */}
        <span className="tree-node-status" style={{ background: statusColor[s.status] || '#888' }} />

        {/* 标题与元信息 */}
        <div className="tree-node-info">
          <span className="tree-node-title">{s.title || s.name}</span>
          <span className="tree-node-meta">
            {statusLabel[s.status] || s.status}
            {s.createdBy && s.createdBy !== 'user' && ` · ${s.createdBy}`}
            {` · ${formatTime(s.createdAt)}`}
          </span>
        </div>

        {/* 子会话数 */}
        {hasChildren && <span className="tree-node-badge">{node.children.length}</span>}
      </div>

      {/* 连接线 + inputContext */}
      {hasChildren && expanded && (
        <div className="tree-node-children">
          {node.children.map(child => (
            <div key={child.session.id} className="tree-child-wrapper">
              {/* 数据流标注 */}
              {child.session.inputContext && (
                <div className="tree-flow-label" style={{ marginLeft: (depth + 1) * 24 }}>
                  <span className="tree-flow-arrow">↓</span>
                  <span className="tree-flow-text">{truncate(child.session.inputContext, 80)}</span>
                </div>
              )}
              <TreeNodeView
                node={child}
                selectedId={selectedId}
                onSelect={onSelect}
                depth={depth + 1}
              />
              {/* 子会话返回结果 */}
              {child.session.result && (
                <div className="tree-flow-label result" style={{ marginLeft: (depth + 1) * 24 }}>
                  <span className="tree-flow-arrow">↑</span>
                  <span className="tree-flow-text">{truncate(child.session.result, 80)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 会话详情面板 ----

function SessionDetailView({ detail }: { detail: SessionDetail }) {
  const s = detail.session;
  const chatMessages = buildChatMessages(detail.messages);

  return (
    <div className="session-detail">
      <div className="session-detail-header">
        <h3>{s.title || s.name}</h3>
        <span className="session-detail-status" style={{ color: statusColor[s.status] }}>
          {statusLabel[s.status]}
        </span>
      </div>

      {/* 元信息 */}
      <div className="session-detail-meta">
        <div><strong>ID:</strong> {s.id}</div>
        <div><strong>创建时间:</strong> {new Date(s.createdAt).toLocaleString('zh-CN')}</div>
        {s.parentId && <div><strong>父会话:</strong> {s.parentId}</div>}
        {s.createdBy && <div><strong>创建者:</strong> {s.createdBy}</div>}
        {s.children.length > 0 && <div><strong>子会话数:</strong> {s.children.length}</div>}
      </div>

      {/* 输入上下文 */}
      {s.inputContext && (
        <div className="session-detail-context">
          <div className="context-label">来自父会话的指令</div>
          <div className="context-content">{s.inputContext}</div>
        </div>
      )}

      {/* 返回结果 */}
      {s.result && (
        <div className="session-detail-result">
          <div className="context-label">给父会话的结果</div>
          <div className="context-content">{s.result}</div>
        </div>
      )}

      {/* 消息历史 */}
      <div className="session-detail-messages">
        <h4>消息记录 ({detail.messages.length})</h4>
        {chatMessages.length === 0 ? (
          <div className="no-messages">暂无消息记录</div>
        ) : (
          <div className="message-list">
            {chatMessages.map((msg, i) => (
              <DetailMessageView key={i} msg={msg} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 渲染单条 ChatMessage（支持工具调用折叠） */
function DetailMessageView({ msg }: { msg: ChatMessage }) {
  const roleLabel = msg.role === 'user' ? '用户' : '助手';

  if (msg.role === 'assistant' && msg.segments && msg.segments.length > 0) {
    return (
      <div className={`detail-message ${msg.role}`}>
        <div className="detail-msg-role">{roleLabel}</div>
        <div className="detail-msg-content">
          {msg.segments.map((seg, j) =>
            seg.type === 'text' ? (
              seg.content ? <div key={j} className="detail-text-segment">{seg.content}</div> : null
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
        {msg.timestamp > 0 && (
          <div className="detail-msg-time">{formatTime(msg.timestamp)}</div>
        )}
      </div>
    );
  }

  return (
    <div className={`detail-message ${msg.role}`}>
      <div className="detail-msg-role">{roleLabel}</div>
      <div className="detail-msg-content">{msg.content}</div>
      {msg.timestamp > 0 && (
        <div className="detail-msg-time">{formatTime(msg.timestamp)}</div>
      )}
    </div>
  );
}
