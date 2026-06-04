import { useState } from 'react';
import { pageAction } from '../api';

// ===== 类型 =====

export interface SessionItem {
  id: string;
  name: string;
  title?: string;
  displayTitle?: string;
  status: string;
  children: string[];
  childCount: number;
  parentId?: string;
  inputContext?: string;
  result?: string;
  createdAt: number;
  config?: SessionConfigData;
}

interface SessionConfigData {
  /** 会话使用的 LLM 模型引用：`{ provider, model }` 二元组。
   *  与 `@aalis/plugin-session-manager-api` 的 `SessionConfig.llm` 字段同义。 */
  llm?: { provider: string; model: string };
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

interface Props {
  activeSessionId: string;
  onSwitchSession: (id: string) => void;
  onRefreshSessions: () => void;
  /** 创建新会话（可带 parentId），返回新 ID */
  onCreateSession: (parentId?: string) => Promise<string | null>;
  sessionList: SessionItem[];
  /** 提供会话管理服务的插件名（从 pageDefs 动态获取） */
  pluginName: string;
}

// ===== 配置编辑组件 =====

function SessionConfigEditor({ config, options, onSave, onCancel }: {
  config: SessionConfigData;
  options: ConfigOptions | null;
  onSave: (config: SessionConfigData) => void;
  onCancel: () => void;
}) {
  // 初始化 draft 时做一次「legacy → llm」折叠：
  //   早期版本把用户选择的模型写到 `config.model: string`（flat 字段），后期
  //   修复改用 `config.llm`。DB 中可能两个字段并存且不一致——此时 legacy
  //   字段代表用户更晚的 UI 修改意图，应该覆盖 llm（与 scripts/migrate-session-llm.mjs
  //   一致）。这里在 UI 层做一次幂等折叠，让用户看到的选择就是他当初点的那个。
  const initialDraft: SessionConfigData = { ...config };
  const legacyRaw = config as unknown as { model?: unknown; llmProvider?: unknown };
  const legacyModel = typeof legacyRaw.model === 'string' ? legacyRaw.model : undefined;
  const legacyProvider = typeof legacyRaw.llmProvider === 'string' ? legacyRaw.llmProvider : undefined;
  if (legacyModel) {
    // provider 优先用 legacy，其次沿用现 llm.provider（迁移脚本同样的退化策略）
    const provider = legacyProvider ?? config.llm?.provider;
    if (provider) initialDraft.llm = { provider, model: legacyModel };
  }
  // 删除可能被 spread 进来的 legacy key，避免 onSave 时回传
  delete (initialDraft as Record<string, unknown>).model;
  delete (initialDraft as Record<string, unknown>).llmProvider;
  const [draft, setDraft] = useState<SessionConfigData>(initialDraft);

  const update = <K extends keyof SessionConfigData>(key: K, value: SessionConfigData[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const toggleToolGroup = (name: string) => {
    const current = draft.enabledToolGroups || [];
    const next = current.includes(name)
      ? current.filter(g => g !== name)
      : [...current, name];
    update('enabledToolGroups', next.length > 0 ? next : undefined);
  };

  if (!options) {
    return <div className="session-config-editor"><span className="session-config-loading">加载配置选项…</span></div>;
  }

  // 当前选中态用 `${provider}/${model}` 唯一编码（空 ref → ''）
  const selectedLlmKey = draft.llm?.provider && draft.llm?.model
    ? `${draft.llm.provider}/${draft.llm.model}`
    : '';
  // 摊平：跨 provider 一级列表。option.value = `${provider}/${model}`，便于反查
  // provider+model 二元组，避免旧版「只保存 model id 丢失 provider」的 bug 重现。
  const flatLlmOptions = options.models
    .filter(m => !!m.provider)
    .map(m => ({
      key: `${m.provider}/${m.id}`,
      provider: m.provider as string,
      model: m.id,
      label: `${m.provider} / ${m.id}${m.capabilities.length > 0 ? `  [${m.capabilities.join(',')}]` : ''}`,
    }));
  // 旧 ref 不在当前 entries 中（provider 未启动 / model 已下线）→ 顶部插一条占位
  if (selectedLlmKey && !flatLlmOptions.some(o => o.key === selectedLlmKey)) {
    flatLlmOptions.unshift({
      key: selectedLlmKey,
      provider: draft.llm!.provider,
      model: draft.llm!.model,
      label: `${draft.llm!.provider} / ${draft.llm!.model}  (已离线)`,
    });
  }

  return (
    <div className="session-config-editor" onClick={e => e.stopPropagation()}>
      {/* 模型（单级摊平 select：跨 provider 列出每个具体 entry） */}
      <label className="session-config-field">
        <span>模型</span>
        <select
          value={selectedLlmKey}
          onChange={e => {
            const key = e.target.value;
            if (!key) {
              update('llm', undefined);
              return;
            }
            const opt = flatLlmOptions.find(o => o.key === key);
            if (opt) update('llm', { provider: opt.provider, model: opt.model });
          }}
        >
          <option value="">继承默认</option>
          {flatLlmOptions.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </label>

      {/* 人设 */}
      <label className="session-config-field">
        <span>人设</span>
        <select value={draft.persona || ''} onChange={e => update('persona', e.target.value || undefined)}>
          <option value="">继承默认</option>
          {options.personas.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>

      {/* 工具分组 */}
      {options.toolGroups.length > 0 && (
        <div className="session-config-field">
          <span>工具分组</span>
          <div className="session-config-chips">
            {options.toolGroups.map(g => (
              <button
                key={g.name}
                className={`session-config-chip ${(draft.enabledToolGroups || []).includes(g.name) ? 'active' : ''}`}
                onClick={() => toggleToolGroup(g.name)}
                title={g.name}
              >{g.label || g.name}</button>
            ))}
          </div>
        </div>
      )}

      {/* 额外系统提示 */}
      <label className="session-config-field">
        <span>额外提示</span>
        <textarea
          rows={2}
          value={draft.systemPromptExtra || ''}
          onChange={e => update('systemPromptExtra', e.target.value || undefined)}
          placeholder="追加到系统提示之后…"
        />
      </label>

      {/* 最大工具迭代 */}
      <label className="session-config-field">
        <span>工具迭代上限</span>
        <input
          type="number"
          min={0}
          max={50}
          value={draft.maxToolIterations ?? ''}
          onChange={e => update('maxToolIterations', e.target.value ? Number(e.target.value) : undefined)}
          placeholder="默认"
        />
      </label>

      {/* 开关选项 */}
      <div className="session-config-toggles">
        <label>
          <input type="checkbox" checked={!!draft.disableOutputFormat} onChange={e => update('disableOutputFormat', e.target.checked || undefined)} />
          <span>禁用结构化输出</span>
        </label>
        <label>
          <input type="checkbox" checked={!!draft.clientSideJsonRendering} onChange={e => update('clientSideJsonRendering', e.target.checked || undefined)} />
          <span>客户端 JSON 渲染</span>
        </label>
      </div>

      {/* 操作按钮 */}
      <div className="session-config-actions">
        <button className="session-config-btn save" onClick={() => onSave(draft)}>保存</button>
        <button className="session-config-btn cancel" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

// ===== 组件 =====

export function SessionSidebar({ activeSessionId, onSwitchSession, onRefreshSessions, onCreateSession, sessionList, pluginName }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [configEditingId, setConfigEditingId] = useState<string | null>(null);
  const [configOptions, setConfigOptions] = useState<ConfigOptions | null>(null);

  // 构建 id → session 映射
  const sessionMap = new Map(sessionList.map(s => [s.id, s]));
  // 根 session（无 parentId 或 parentId 不在列表中）
  const rootSessions = sessionList.filter(s => !s.parentId || !sessionMap.has(s.parentId));

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCreateChild = async (parentId: string) => {
    await onCreateSession(parentId);
    // 展开父节点
    setExpanded(prev => new Set(prev).add(parentId));
  };

  const handleRename = async (id: string) => {
    if (!editTitle.trim()) { setEditingId(null); return; }
    try {
      await pageAction(pluginName, 'renameSession', { id, title: editTitle.trim() });
      onRefreshSessions();
    } catch { /* ignore */ }
    setEditingId(null);
  };

  const handleArchive = async (id: string) => {
    try {
      await pageAction(pluginName, 'archiveSession', { id });
      onRefreshSessions();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    try {
      await pageAction(pluginName, 'deleteSession', { id });
      onRefreshSessions();
    } catch { /* ignore */ }
  };

  const handleOpenConfig = async (id: string) => {
    if (configEditingId === id) { setConfigEditingId(null); return; }
    setConfigEditingId(id);
    if (!configOptions) {
      try {
        const opts = await pageAction<ConfigOptions>(pluginName, 'getConfigOptions');
        if (opts) setConfigOptions(opts);
      } catch { /* ignore */ }
    }
  };

  const handleSaveConfig = async (id: string, config: SessionConfigData) => {
    try {
      await pageAction(pluginName, 'updateSessionConfig', { id, config });
      onRefreshSessions();
    } catch { /* ignore */ }
    setConfigEditingId(null);
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case 'active': return '●';
      case 'completed': return '✓';
      case 'archived': return '▪';
      case 'error': return '✗';
      case 'waiting': return '◌';
      default: return '○';
    }
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'active': return 'var(--color-success, #4caf50)';
      case 'completed': return 'var(--color-info, #2196f3)';
      case 'archived': return 'var(--color-muted, #888)';
      case 'error': return 'var(--color-error, #f44336)';
      case 'waiting': return 'var(--color-warning, #ff9800)';
      default: return 'var(--color-muted, #888)';
    }
  };

  const renderSessionNode = (session: SessionItem, depth: number = 0) => {
    const hasChildren = session.children.length > 0;
    const isExpanded = expanded.has(session.id);
    const isActive = session.id === activeSessionId;
    const isEditing = editingId === session.id;

    // 子 session 列表
    const childSessions = session.children
      .map(cid => sessionMap.get(cid))
      .filter((s): s is SessionItem => !!s);

    return (
      <div key={session.id} className="session-node">
        <div
          className={`session-node-row ${isActive ? 'active' : ''} ${session.status === 'archived' ? 'archived' : ''}`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => onSwitchSession(session.id)}
          title={`${session.name}\n${session.id}\n状态: ${session.status}`}
        >
          {/* 展开/折叠 */}
          <button
            className="session-expand-btn"
            onClick={(e) => { e.stopPropagation(); toggleExpand(session.id); }}
            style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          >
            {isExpanded ? '▾' : '▸'}
          </button>

          {/* 状态图标 */}
          <span className="session-status-icon" style={{ color: statusColor(session.status) }}>
            {statusIcon(session.status)}
          </span>

          {/* 标题 */}
          {isEditing ? (
            <input
              className="session-rename-input"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onBlur={() => handleRename(session.id)}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(session.id); if (e.key === 'Escape') setEditingId(null); }}
              onClick={e => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="session-title">
              {session.title || session.displayTitle || session.name}
            </span>
          )}

          {/* 子会话数量 */}
          {hasChildren && (
            <span className="session-child-badge">{session.children.length}</span>
          )}

          {/* 操作按钮 */}
          <div className="session-actions" onClick={e => e.stopPropagation()}>
            <button
              className="session-action-btn"
              title="新建子会话"
              onClick={() => handleCreateChild(session.id)}
            >➕</button>
            <button
              className="session-action-btn"
              title="配置"
              onClick={() => handleOpenConfig(session.id)}
            >⚙</button>
            <button
              className="session-action-btn"
              title="重命名"
              onClick={() => { setEditingId(session.id); setEditTitle(session.title || session.displayTitle || session.name); }}
            >✎</button>
            {session.status === 'active' && session.parentId && (
              <button className="session-action-btn" title="归档" onClick={() => handleArchive(session.id)}>▪</button>
            )}
            <button className="session-action-btn danger" title="删除" onClick={() => handleDelete(session.id)}>✕</button>
          </div>
        </div>

        {/* 配置编辑面板 */}
        {configEditingId === session.id && (
          <SessionConfigEditor
            config={session.config || {}}
            options={configOptions}
            onSave={(config) => handleSaveConfig(session.id, config)}
            onCancel={() => setConfigEditingId(null)}
          />
        )}

        {/* 子会话 */}
        {isExpanded && childSessions.length > 0 && (
          <div className="session-children">
            {childSessions.map(child => renderSessionNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  if (collapsed) {
    return (
      <div className="session-sidebar collapsed" onClick={() => setCollapsed(false)} title="展开会话列表">
        <span className="session-sidebar-toggle">◁</span>
      </div>
    );
  }

  return (
    <div className="session-sidebar">
      <div className="session-sidebar-header">
        <span className="session-sidebar-title">会话</span>
        <div className="session-sidebar-actions">
          <button className="session-sidebar-btn" onClick={() => setCollapsed(true)} title="收起">▷</button>
        </div>
      </div>
      <div className="session-sidebar-list">
        {rootSessions.map(s => renderSessionNode(s))}
      </div>
    </div>
  );
}
