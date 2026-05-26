import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { BrainCircuit, Wrench } from 'lucide-react';
import { pageAction } from '../api';
import { buildChatMessages } from '../useSessionManager';
import { useDetailStream } from '../useDetailStream';
import type { RawMessage } from '../useSessionManager';
import type { ChatMessage, ContentSegment } from '../types';
import { preprocessLaTeX } from '../preprocessLaTeX';
import { REMARK_PLUGINS, REHYPE_PLUGINS, MARKDOWN_COMPONENTS } from '../components/markdownConfig';

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
  config?: SessionConfigData;
}

interface SessionConfigData {
  /** 新版字段：会话级 LLM 覆盖。SessionsPage 编辑器只读写此字段，不再发 legacy model/llmProvider。 */
  llm?: { provider: string; model: string };
  /** @deprecated legacy: 旧版 SessionsPage 编辑器写过的 flat 字段；保留仅用于读旧数据并折叠到 llm。 */
  model?: string;
  /** @deprecated legacy */
  llmProvider?: string;
  persona?: string;
  enabledToolGroups?: string[];
  systemPromptExtra?: string;
  maxToolIterations?: number;
  disableOutputFormat?: boolean;
  clientSideJsonRendering?: boolean;
}

interface ConfigOptions {
  personas: string[];
  models: Array<{ id: string; capabilities: string[]; provider?: string; contextId?: string }>;
  toolGroups: Array<{ name: string; label: string }>;
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

/** 递归收集树中所有会话 ID */
function collectIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  for (const n of nodes) {
    ids.push(n.session.id);
    ids.push(...collectIds(n.children));
  }
  return ids;
}

// ===== 配置编辑组件 =====

function SessionConfigEditor({ config, resolvedConfig, inheritedConfig, options, onSave, onCancel }: {
  config: SessionConfigData;
  resolvedConfig?: SessionConfigData | null;
  inheritedConfig?: SessionConfigData | null;
  options: ConfigOptions | null;
  onSave: (config: SessionConfigData) => void;
  onCancel: () => void;
}) {
  // draft 始终基于会话自身 config（非 resolved），保证保存时只写覆盖值。
  // 同时做一次「legacy → llm」折叠（与 SessionSidebar 保持一致逻辑）：DB 中可能
  // 残留早期版本写入的 `config.model` flat 字段，需要在 UI 层把它折叠进 llm，
  // 否则用户看到的选择不会反映他当初的真实意图，保存时还会被后端剥离。
  const initialDraft: SessionConfigData = { ...config };
  const legacyModel = typeof config.model === 'string' ? config.model : undefined;
  const legacyProvider = typeof config.llmProvider === 'string' ? config.llmProvider : undefined;
  if (legacyModel) {
    const provider = legacyProvider ?? config.llm?.provider;
    if (provider) initialDraft.llm = { provider, model: legacyModel };
  }
  delete (initialDraft as Record<string, unknown>).model;
  delete (initialDraft as Record<string, unknown>).llmProvider;
  const [draft, setDraft] = useState<SessionConfigData>(initialDraft);
  // resolved 用于 checkbox 默认勾选（当前生效值，含 session 自身覆盖）
  const resolved = resolvedConfig || {};
  // inherited = platform profile + 父 sessionDefaults（不含 session 自身），用于「继承 (xxx)」提示
  const inherited = inheritedConfig || {};

  const update = <K extends keyof SessionConfigData>(key: K, value: SessionConfigData[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  /** 工具分组有三态：会话显式启用 / 继承启用 / 未启用 */
  const isToolGroupActive = (name: string) => {
    if (draft.enabledToolGroups?.includes(name)) return 'explicit';
    if (inherited.enabledToolGroups?.includes(name) && !draft.enabledToolGroups) return 'inherited';
    return 'off';
  };

  const toggleToolGroup = (name: string) => {
    const state = isToolGroupActive(name);
    if (state === 'inherited') {
      // 继承状态 → 点击后改为显式设置（复制 inherited 列表，移除该项）
      const base = [...(inherited.enabledToolGroups || [])];
      update('enabledToolGroups', base.filter(g => g !== name));
    } else {
      // explicit 或 off → 正常 toggle
      const current = draft.enabledToolGroups || inherited.enabledToolGroups || [];
      const next = current.includes(name)
        ? current.filter(g => g !== name)
        : [...current, name];
      update('enabledToolGroups', next.length > 0 ? next : undefined);
    }
  };

  /** 重置工具分组为继承 */
  const resetToolGroups = () => {
    setDraft(prev => { const { enabledToolGroups: _, ...rest } = prev; return rest; });
  };

  if (!options) {
    return <div className="session-config-editor"><span className="session-config-loading">加载配置选项…</span></div>;
  }

  const inheritLabel = (field: keyof SessionConfigData, inheritedVal: unknown) =>
    !draft[field] && inheritedVal ? ` (继承: ${inheritedVal})` : '';

  // === 模型 select（单级摊平：跨 provider 一级列表，value=`${provider}/${model}`）===
  const selectedLlmKey = draft.llm?.provider && draft.llm?.model
    ? `${draft.llm.provider}/${draft.llm.model}`
    : '';
  const flatLlmOptions = options.models
    .filter(m => !!m.provider)
    .map(m => ({
      key: `${m.provider}/${m.id}`,
      provider: m.provider as string,
      model: m.id,
      label: `${m.provider} / ${m.id}${m.capabilities.length > 0 ? `  [${m.capabilities.join(',')}]` : ''}`,
    }));
  if (selectedLlmKey && !flatLlmOptions.some(o => o.key === selectedLlmKey)) {
    flatLlmOptions.unshift({
      key: selectedLlmKey,
      provider: draft.llm!.provider,
      model: draft.llm!.model,
      label: `${draft.llm!.provider} / ${draft.llm!.model}  (已离线)`,
    });
  }
  const inheritedLlmLabel = inherited.llm
    ? `${inherited.llm.provider} / ${inherited.llm.model}`
    : undefined;

  return (
    <div className="session-config-editor" onClick={e => e.stopPropagation()}>
      <label className="session-config-field">
        <span>模型{!draft.llm && inheritedLlmLabel ? ` (继承: ${inheritedLlmLabel})` : ''}</span>
        <select
          value={selectedLlmKey}
          onChange={e => {
            const key = e.target.value;
            if (!key) { update('llm', undefined); return; }
            const opt = flatLlmOptions.find(o => o.key === key);
            if (opt) update('llm', { provider: opt.provider, model: opt.model });
          }}
        >
          <option value="">{inheritedLlmLabel ? `继承 (${inheritedLlmLabel})` : '继承默认'}</option>
          {flatLlmOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </label>
      <label className="session-config-field">
        <span>人设{inheritLabel('persona', inherited.persona)}</span>
        <select value={draft.persona || ''} onChange={e => update('persona', e.target.value || undefined)}>
          <option value="">{inherited.persona ? `继承 (${inherited.persona})` : '继承默认'}</option>
          {options.personas.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      {options.toolGroups.length > 0 && (
        <div className="session-config-field">
          <span>工具分组{draft.enabledToolGroups ? '' : ' (继承)'}</span>
          <div className="session-config-chips">
            {options.toolGroups.map(g => {
              const state = isToolGroupActive(g.name);
              return (
                <button
                  key={g.name}
                  className={`session-config-chip ${state === 'explicit' ? 'active' : state === 'inherited' ? 'active inherited' : ''}`}
                  onClick={() => toggleToolGroup(g.name)}
                  title={`${g.name}${state === 'inherited' ? ' (继承)' : state === 'explicit' ? ' (已覆盖)' : ''}`}
                >{g.label || g.name}</button>
              );
            })}
            {draft.enabledToolGroups && (
              <button className="session-config-chip reset" onClick={resetToolGroups} title="恢复为继承">↺ 重置</button>
            )}
          </div>
        </div>
      )}
      <label className="session-config-field">
        <span>额外提示</span>
        <textarea
          rows={2}
          value={draft.systemPromptExtra || ''}
          onChange={e => update('systemPromptExtra', e.target.value || undefined)}
          placeholder="追加到系统提示之后…"
        />
      </label>
      <label className="session-config-field">
        <span>工具迭代上限</span>
        <input
          type="number"
          min={0}
          max={50}
          value={draft.maxToolIterations ?? ''}
          onChange={e => update('maxToolIterations', e.target.value ? Number(e.target.value) : undefined)}
          placeholder={inherited.maxToolIterations ? `继承 (${inherited.maxToolIterations})` : '默认'}
        />
      </label>
      <div className="session-config-toggles">
        <label>
          <input type="checkbox"
            checked={draft.disableOutputFormat ?? resolved.disableOutputFormat ?? false}
            onChange={e => update('disableOutputFormat', e.target.checked || undefined)}
          />
          <span>禁用结构化输出{draft.disableOutputFormat === undefined && inherited.disableOutputFormat ? ' (继承)' : ''}</span>
        </label>
        <label>
          <input type="checkbox"
            checked={draft.clientSideJsonRendering ?? resolved.clientSideJsonRendering ?? false}
            onChange={e => update('clientSideJsonRendering', e.target.checked || undefined)}
          />
          <span>客户端 JSON 渲染{draft.clientSideJsonRendering === undefined && inherited.clientSideJsonRendering ? ' (继承)' : ''}</span>
        </label>
      </div>
      <div className="session-config-actions">
        <button className="session-config-btn save" onClick={() => onSave(draft)}>保存</button>
        <button className="session-config-btn cancel" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

// ===== 主组件 =====

export function SessionsPage({ pluginName, activeSessionId, onSwitchSession, onStartNewChat, refreshSignal }: { pluginName: string; activeSessionId?: string; onSwitchSession?: (id: string) => void; onStartNewChat?: () => void; refreshSignal?: number }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 批量模式
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 编辑
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  // 删除确认
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [configEditingId, setConfigEditingId] = useState<string | null>(null);
  const [configOptions, setConfigOptions] = useState<ConfigOptions | null>(null);
  const [resolvedConfig, setResolvedConfig] = useState<SessionConfigData | null>(null);
  // 「继承默认」包 - 不含 session 自身 config，仅 platform profile + 父 sessionDefaults。
  // 用于 UI 「继承 (xxx)」提示，避免显示用户自己的覆盖值。
  const [inheritedConfig, setInheritedConfig] = useState<SessionConfigData | null>(null);

  const fetchTree = useCallback(() => {
    pageAction<TreeNode[]>(pluginName, 'getSessionTree')
      .then(data => { if (Array.isArray(data)) setTree(data); })
      .catch(() => setError('无法加载会话树'));
  }, [pluginName]);

  useEffect(() => {
    fetchTree();
    const iv = setInterval(fetchTree, 30000);
    return () => clearInterval(iv);
  }, [fetchTree]);

  // WS sessions_changed 推送时刷新 tree + 当前打开的 resolvedConfig
  useEffect(() => {
    if (!refreshSignal) return; // 跳过初始值 0
    fetchTree();
    // 如果配置编辑器打开中，重新拉取 resolved + inherited
    if (configEditingId) {
      Promise.all([
        pageAction<SessionConfigData>(pluginName, 'getResolvedConfig', { sessionId: configEditingId, platform: 'webui' }),
        pageAction<SessionConfigData>(pluginName, 'getInheritedDefaults', { sessionId: configEditingId, platform: 'webui' }),
      ])
        .then(([r, inh]) => { if (r) setResolvedConfig(r); if (inh) setInheritedConfig(inh); })
        .catch(() => {});
    }
  }, [refreshSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = useCallback((id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    pageAction<SessionDetail>(pluginName, 'getSessionDetail', { id })
      .then(d => setDetail(d))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false));
  }, [pluginName]);

  // ---- 会话操作 ----

  const handleCreate = async () => {
    try {
      await pageAction(pluginName, 'createSession', {});
      fetchTree();
    } catch { /* ignore */ }
  };

  const handleCreateChild = async (parentId: string) => {
    try {
      await pageAction(pluginName, 'createSession', { parentId });
      fetchTree();
    } catch { /* ignore */ }
  };

  const handleRename = async (id: string) => {
    if (!editTitle.trim()) { setEditingId(null); return; }
    try {
      await pageAction(pluginName, 'renameSession', { id, title: editTitle.trim() });
      fetchTree();
    } catch { /* ignore */ }
    setEditingId(null);
  };

  const handleArchive = async (id: string) => {
    try {
      await pageAction(pluginName, 'archiveSession', { id });
      fetchTree();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      const wasActive = id === activeSessionId;
      await pageAction(pluginName, 'deleteSession', { id });
      fetchTree();
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
      // 删除的是当前正在聊的会话，自动进入新对话
      if (wasActive && onStartNewChat) onStartNewChat();
    } catch { /* ignore */ }
    setPendingDeleteId(null);
  };

  const handleOpenConfig = async (id: string) => {
    if (configEditingId === id) { setConfigEditingId(null); setResolvedConfig(null); setInheritedConfig(null); return; }
    setConfigEditingId(id);
    setResolvedConfig(null);
    setInheritedConfig(null);
    try {
      const [opts, resolved, inherited] = await Promise.all([
        configOptions ? Promise.resolve(configOptions) : pageAction<ConfigOptions>(pluginName, 'getConfigOptions'),
        pageAction<SessionConfigData>(pluginName, 'getResolvedConfig', { sessionId: id, platform: 'webui' }),
        pageAction<SessionConfigData>(pluginName, 'getInheritedDefaults', { sessionId: id, platform: 'webui' }),
      ]);
      if (opts && !configOptions) setConfigOptions(opts);
      if (resolved) setResolvedConfig(resolved);
      if (inherited) setInheritedConfig(inherited);
    } catch { /* ignore */ }
  };

  const handleSaveConfig = async (id: string, config: SessionConfigData) => {
    try {
      await pageAction(pluginName, 'updateSessionConfig', { id, config });
      fetchTree();
      setConfigEditingId(null);
    } catch (err) {
      // 不再静默：用户切换模型失败必须能感知。保持编辑面板打开，方便重试。
      const msg = err instanceof Error ? err.message : String(err);
      alert(`保存会话配置失败：${msg}`);
    }
  };

  // ---- 批量操作 ----

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    const allIds = collectIds(tree);
    setSelected(new Set(allIds));
  };

  const deselectAll = () => setSelected(new Set());

  const handleBatchArchive = async () => {
    if (selected.size === 0) return;
    try {
      await pageAction(pluginName, 'batchArchive', { ids: [...selected] });
      setSelected(new Set());
      fetchTree();
    } catch { /* ignore */ }
  };

  const handleBatchDelete = async () => {
    if (selected.size === 0) return;
    if (!confirm(`确认删除选中的 ${selected.size} 个会话？此操作不可恢复。`)) return;
    try {
      await pageAction(pluginName, 'batchDelete', { ids: [...selected] });
      setSelected(new Set());
      if (selectedId && selected.has(selectedId)) { setSelectedId(null); setDetail(null); }
      fetchTree();
    } catch { /* ignore */ }
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelected(new Set());
  };

  if (error) {
    return <div className="tree-page-error">{error}</div>;
  }

  return (
    <div className="session-tree-page">
      {/* 左侧：树形 + 管理 */}
      <div className="tree-visual-panel">
        <div className="tree-visual-header">
          <h3>会话</h3>
          <div className="tree-header-actions">
            {batchMode ? (
              <>
                <button className="tree-batch-btn" onClick={selectAll} title="全选">全选</button>
                <button className="tree-batch-btn" onClick={deselectAll} title="取消全选">取消</button>
                <button className="tree-batch-btn archive" onClick={handleBatchArchive} disabled={selected.size === 0}>归档 ({selected.size})</button>
                <button className="tree-batch-btn danger" onClick={handleBatchDelete} disabled={selected.size === 0}>删除 ({selected.size})</button>
                <button className="tree-batch-btn" onClick={exitBatchMode}>退出批量</button>
              </>
            ) : (
              <>
                <button className="tree-action-btn" onClick={handleCreate} title="新建会话">＋</button>
                <button className="tree-action-btn" onClick={() => setBatchMode(true)} title="批量管理">☐</button>
                <button className="tree-refresh-btn" onClick={fetchTree}>⟳</button>
              </>
            )}
          </div>
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
                activeSessionId={activeSessionId}
                onSelect={loadDetail}
                depth={0}
                batchMode={batchMode}
                selected={selected}
                onToggleSelect={toggleSelect}
                onCreateChild={handleCreateChild}
                onRename={(id, title) => { setEditingId(id); setEditTitle(title); }}
                onArchive={handleArchive}
                onDelete={(id) => setPendingDeleteId(id)}
                onOpenConfig={handleOpenConfig}
                editingId={editingId}
                editTitle={editTitle}
                onEditTitleChange={setEditTitle}
                onCommitRename={handleRename}
                onCancelEdit={() => setEditingId(null)}
                configEditingId={configEditingId}
                configOptions={configOptions}
                resolvedConfig={resolvedConfig}
                inheritedConfig={inheritedConfig}
                onSaveConfig={handleSaveConfig}
                onCancelConfig={() => setConfigEditingId(null)}
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
          <SessionDetailView detail={detail} onSwitchSession={onSwitchSession} onRefresh={() => loadDetail(detail.session.id)} />
        ) : (
          <div className="tree-detail-placeholder">无法加载会话信息</div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      {pendingDeleteId && (
        <div className="delete-confirm-overlay" onClick={() => setPendingDeleteId(null)}>
          <div className="delete-confirm-dialog" onClick={e => e.stopPropagation()}>
            <p>确定要删除此会话吗？子会话也会被一并删除，此操作无法撤销。</p>
            <div className="delete-confirm-actions">
              <button className="btn btn-sm btn-danger" onClick={() => handleDelete(pendingDeleteId)}>删除</button>
              <button className="btn btn-sm" onClick={() => setPendingDeleteId(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 树节点 ----

function TreeNodeView({
  node,
  selectedId,
  activeSessionId,
  onSelect,
  depth,
  batchMode,
  selected,
  onToggleSelect,
  onCreateChild,
  onRename,
  onArchive,
  onDelete,
  onOpenConfig,
  editingId,
  editTitle,
  onEditTitleChange,
  onCommitRename,
  onCancelEdit,
  configEditingId,
  configOptions,
  resolvedConfig,
  inheritedConfig,
  onSaveConfig,
  onCancelConfig,
}: {
  node: TreeNode;
  selectedId: string | null;
  activeSessionId?: string;
  onSelect: (id: string) => void;
  depth: number;
  batchMode: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onCreateChild: (parentId: string) => void;
  onRename: (id: string, currentTitle: string) => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenConfig: (id: string) => void;
  editingId: string | null;
  editTitle: string;
  onEditTitleChange: (v: string) => void;
  onCommitRename: (id: string) => void;
  onCancelEdit: () => void;
  configEditingId: string | null;
  configOptions: ConfigOptions | null;
  resolvedConfig: SessionConfigData | null;
  inheritedConfig: SessionConfigData | null;
  onSaveConfig: (id: string, config: SessionConfigData) => void;
  onCancelConfig: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const s = node.session;
  const hasChildren = node.children.length > 0;
  const isSelected = s.id === selectedId;
  const isActiveChat = s.id === activeSessionId;
  const isEditing = editingId === s.id;
  const isChecked = selected.has(s.id);

  return (
    <div className="tree-node-group">
      <div
        className={`tree-node ${isSelected ? 'selected' : ''} ${isActiveChat ? 'active-chat' : ''} status-${s.status}`}
        style={{ marginLeft: depth * 24 }}
        onClick={() => batchMode ? onToggleSelect(s.id) : onSelect(s.id)}
      >
        {/* 批量选择框 */}
        {batchMode && (
          <input
            type="checkbox"
            className="tree-node-checkbox"
            checked={isChecked}
            onChange={() => onToggleSelect(s.id)}
            onClick={e => e.stopPropagation()}
          />
        )}

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

        {/* 标题 */}
        <div className="tree-node-info">
          {isEditing ? (
            <input
              className="tree-node-rename-input"
              value={editTitle}
              onChange={e => onEditTitleChange(e.target.value)}
              onBlur={() => onCommitRename(s.id)}
              onKeyDown={e => { if (e.key === 'Enter') onCommitRename(s.id); if (e.key === 'Escape') onCancelEdit(); }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <>
              <span className="tree-node-title">{s.title || s.name}</span>
              <span className="tree-node-meta">
                {statusLabel[s.status] || s.status}
                {s.createdBy && s.createdBy !== 'user' && ` · ${s.createdBy}`}
                {` · ${formatTime(s.createdAt)}`}
              </span>
            </>
          )}
        </div>

        {/* 子会话数 */}
        {hasChildren && <span className="tree-node-badge">{node.children.length}</span>}

        {/* 操作按钮（非批量模式） */}
        {!batchMode && (
          <div className="tree-node-actions" onClick={e => e.stopPropagation()}>
            <button className="tree-node-action-btn" title="新建子会话" onClick={() => onCreateChild(s.id)}>➕</button>
            <button className="tree-node-action-btn" title="配置" onClick={() => onOpenConfig(s.id)}>⚙</button>
            <button className="tree-node-action-btn" title="重命名" onClick={() => onRename(s.id, s.title || s.name)}>✎</button>
            {s.status === 'active' && (
              <button className="tree-node-action-btn" title="归档" onClick={() => onArchive(s.id)}>▪</button>
            )}
            <button className="tree-node-action-btn danger" title="删除" onClick={() => onDelete(s.id)}>✕</button>
          </div>
        )}
      </div>

      {/* 配置编辑 */}
      {configEditingId === s.id && (
        <div style={{ marginLeft: depth * 24 + 24 }}>
          <SessionConfigEditor
            config={s.config || {}}
            resolvedConfig={resolvedConfig}
            inheritedConfig={inheritedConfig}
            options={configOptions}
            onSave={(config) => onSaveConfig(s.id, config)}
            onCancel={onCancelConfig}
          />
        </div>
      )}

      {/* 子节点 */}
      {hasChildren && expanded && (
        <div className="tree-node-children">
          {node.children.map(child => (
            <div key={child.session.id} className="tree-child-wrapper">
              {child.session.inputContext && (
                <div className="tree-flow-label" style={{ marginLeft: (depth + 1) * 24 }}>
                  <span className="tree-flow-arrow">↓</span>
                  <span className="tree-flow-text">{truncate(child.session.inputContext, 80)}</span>
                </div>
              )}
              <TreeNodeView
                node={child}
                selectedId={selectedId}
                activeSessionId={activeSessionId}
                onSelect={onSelect}
                depth={depth + 1}
                batchMode={batchMode}
                selected={selected}
                onToggleSelect={onToggleSelect}
                onCreateChild={onCreateChild}
                onRename={onRename}
                onArchive={onArchive}
                onDelete={onDelete}
                onOpenConfig={onOpenConfig}
                editingId={editingId}
                editTitle={editTitle}
                onEditTitleChange={onEditTitleChange}
                onCommitRename={onCommitRename}
                onCancelEdit={onCancelEdit}
                configEditingId={configEditingId}
                configOptions={configOptions}
                resolvedConfig={resolvedConfig}
                inheritedConfig={inheritedConfig}
                onSaveConfig={onSaveConfig}
                onCancelConfig={onCancelConfig}
              />
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

function SessionDetailView({ detail, onSwitchSession, onRefresh }: { detail: SessionDetail; onSwitchSession?: (id: string) => void; onRefresh?: () => void }) {
  const s = detail.session;
  const chatMessages = buildChatMessages(detail.messages);
  const [stream, resetStream] = useDetailStream(s.id, s.status);

  // 流式生成完成后自动刷新历史
  useEffect(() => {
    if (stream.done) {
      resetStream();
      onRefresh?.();
    }
  }, [stream.done, resetStream, onRefresh]);

  return (
    <div className="session-detail">
      <div className="session-detail-header">
        <h3>{s.title || s.name}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {onSwitchSession && (
            <button className="btn btn-sm btn-primary" onClick={() => onSwitchSession(s.id)}>进入对话</button>
          )}
          <span className="session-detail-status" style={{ color: statusColor[s.status] }}>
            {statusLabel[s.status]}
          </span>
        </div>
      </div>
      <div className="session-detail-meta">
        <div><strong>ID:</strong> {s.id}</div>
        <div><strong>创建时间:</strong> {new Date(s.createdAt).toLocaleString('zh-CN')}</div>
        {s.parentId && <div><strong>父会话:</strong> {s.parentId}</div>}
        {s.createdBy && <div><strong>创建者:</strong> {s.createdBy}</div>}
        {s.children.length > 0 && <div><strong>子会话数:</strong> {s.children.length}</div>}
      </div>
      {s.inputContext && (
        <div className="session-detail-context">
          <div className="context-label">来自父会话的指令</div>
          <div className="context-content">{s.inputContext}</div>
        </div>
      )}
      {s.result && (
        <div className="session-detail-result">
          <div className="context-label">给父会话的结果</div>
          <div className="context-content">{s.result}</div>
        </div>
      )}
      <div className="session-detail-messages">
        <h4>消息记录 ({detail.messages.length})</h4>
        {chatMessages.length === 0 && !stream.isStreaming ? (
          <div className="no-messages">暂无消息记录</div>
        ) : (
          <div className="message-list">
            {chatMessages.map((msg, i) => (
              <DetailMessageView key={i} msg={msg} />
            ))}
            {/* 流式输出中的实时内容（统一时间线） */}
            {stream.isStreaming && stream.segments.length > 0 && (
              <div className="detail-message assistant streaming">
                <div className="detail-msg-role">助手 <span className="streaming-indicator">●</span></div>
                <div className="detail-msg-content detail-msg-md">
                  {(() => {
                    const blocks: React.ReactNode[] = [];
                    let i = 0;
                    while (i < stream.segments.length) {
                      const seg = stream.segments[i];
                      if (seg.type === 'reasoning_text') {
                        let text = '';
                        while (i < stream.segments.length && stream.segments[i].type === 'reasoning_text') {
                          text += (stream.segments[i] as Extract<ContentSegment, { type: 'reasoning_text' }>).content;
                          i++;
                        }
                        if (text) {
                          blocks.push(
                            <details key={`r-${i}`} className="thinking-block" open>
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
                      blocks.push(<DetailSegment key={i} seg={seg} />);
                      i++;
                    }
                    return blocks;
                  })()}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 渲染单个 segment（文本用 Markdown，工具调用用折叠块） */
function DetailSegment({ seg }: { seg: ContentSegment }) {
  if (seg.type === 'text' || seg.type === 'reasoning_text') {
    return seg.content ? (
      <div className="detail-text-segment">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {preprocessLaTeX(seg.content)}
        </ReactMarkdown>
      </div>
    ) : null;
  }
  return (
    <details className="tool-call-block">
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
  );
}

/** 渲染单条 ChatMessage（支持工具调用折叠 + Markdown） */
function DetailMessageView({ msg }: { msg: ChatMessage }) {
  const roleLabel = msg.role === 'user' ? '用户' : '助手';

  // 用户消息：纯文本
  if (msg.role === 'user') {
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

  // 助手消息有 segments：按统一时间线渲染，相邻 reasoning_text 合并为折叠块
  if (msg.role === 'assistant' && msg.segments && msg.segments.length > 0) {
    const blocks: React.ReactNode[] = [];
    let i = 0;
    while (i < msg.segments.length) {
      const seg = msg.segments[i];
      if (seg.type === 'reasoning_text') {
        let text = '';
        while (i < msg.segments.length && msg.segments[i].type === 'reasoning_text') {
          text += (msg.segments[i] as Extract<ContentSegment, { type: 'reasoning_text' }>).content;
          i++;
        }
        if (text) {
          blocks.push(
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
      blocks.push(<DetailSegment key={i} seg={seg} />);
      i++;
    }
    return (
      <div className={`detail-message ${msg.role}`}>
        <div className="detail-msg-role">{roleLabel}</div>
        <div className="detail-msg-content detail-msg-md">{blocks}</div>
        {msg.timestamp > 0 && (
          <div className="detail-msg-time">{formatTime(msg.timestamp)}</div>
        )}
      </div>
    );
  }

  // 老数据 fallback：reasoning + content 两段式
  const fallbackThinking = msg.role === 'assistant' && msg.reasoningContent ? (
    <details className="thinking-block">
      <summary className="thinking-summary"><BrainCircuit size={14} /> 思考过程</summary>
      <div className="thinking-content">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {preprocessLaTeX(msg.reasoningContent)}
        </ReactMarkdown>
      </div>
    </details>
  ) : null;

  return (
    <div className={`detail-message ${msg.role}`}>
      <div className="detail-msg-role">{roleLabel}</div>
      {fallbackThinking}
      <div className="detail-msg-content detail-msg-md">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {preprocessLaTeX(msg.content)}
        </ReactMarkdown>
      </div>
      {msg.timestamp > 0 && (
        <div className="detail-msg-time">{formatTime(msg.timestamp)}</div>
      )}
    </div>
  );
}
