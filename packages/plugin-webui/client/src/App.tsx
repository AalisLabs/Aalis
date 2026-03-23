import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';

// ===== 类型 =====

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface LogEntry {
  timestamp: string;
  level: string;
  scope: string;
  message: string;
}

interface SystemStatus {
  name: string;
  services: Record<string, boolean>;
  tools: string[];
}

interface PluginInfo {
  name: string;
  state: string;
  provides: string[];
  core: boolean;
  config: Record<string, unknown>;
}

interface ServiceProviderInfo {
  contextId: string;
  capabilities: string[];
}

interface ServiceInfo {
  providers: ServiceProviderInfo[];
  active: string | undefined;
}

type PageTab = 'dashboard' | 'marketplace' | 'plugin-config' | 'logs';

const SESSION_ID = 'webui-default';

// ===== SVG 图标 =====

function IconDashboard() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function IconMarketplace() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconPluginConfig() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconLogs() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14,2 14,8 20,8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

// ===== API 封装 =====

async function api<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return res.json() as Promise<T>;
}

// ===== WebSocket Hook =====

function useWebSocket(
  onMessage: (content: string) => void,
  onLog: (entry: LogEntry) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        ws.send(JSON.stringify({ type: 'subscribe_logs' }));
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'message' && data.content) {
            onMessage(data.content);
          } else if (data.type === 'log' && data.log) {
            onLog(data.log);
          }
        } catch { /* ignore */ }
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [onMessage, onLog]);

  const send = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content,
        sessionId: SESSION_ID,
      }));
    }
  }, []);

  return { send, connected };
}

// ===== 仪表盘页 =====

function DashboardPage({
  status,
  connected,
  plugins,
  servicesData,
  onRefreshServices,
}: {
  status: SystemStatus | null;
  connected: boolean;
  plugins: PluginInfo[];
  servicesData: Record<string, ServiceInfo> | null;
  onRefreshServices: () => void;
}) {
  const activeCount = plugins.filter(p => p.state === 'active').length;
  const totalCount = plugins.length;
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handlePrefer = async (serviceName: string, contextId: string) => {
    setBusy(serviceName);
    const res = await api<{ ok?: boolean; error?: string }>(
      `/api/services/${encodeURIComponent(serviceName)}/prefer`,
      { method: 'POST', body: JSON.stringify({ contextId }) },
    );
    if (res.ok) {
      showToast(`${serviceName} 已切换到 ${contextId}`);
      onRefreshServices();
    } else {
      showToast(res.error ?? '操作失败');
    }
    setBusy(null);
  };

  const serviceEntries = servicesData ? Object.entries(servicesData) : [];

  return (
    <div className="page-content page-dashboard">
      {toast && <div className="toast">{toast}</div>}

      {/* 概览卡片 */}
      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon">
            <span className={`status-dot-lg ${connected ? 'online' : 'offline'}`} />
          </div>
          <div className="overview-card-body">
            <div className="overview-card-label">连接状态</div>
            <div className="overview-card-value">{connected ? '已连接' : '离线'}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">✦</div>
          <div className="overview-card-body">
            <div className="overview-card-label">应用名称</div>
            <div className="overview-card-value">{status?.name ?? '-'}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">⚡</div>
          <div className="overview-card-body">
            <div className="overview-card-label">活跃插件</div>
            <div className="overview-card-value">{activeCount} / {totalCount}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">🛠</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册工具</div>
            <div className="overview-card-value">{status?.tools.length ?? 0}</div>
          </div>
        </div>
      </div>

      {/* 核心服务槽位 */}
      <div className="section-label">核心服务</div>
      <div className="services-grid">
        {serviceEntries.length === 0 && (
          <div className="empty-hint">加载中...</div>
        )}
        {serviceEntries.map(([name, info]) => (
          <div className="service-slot-card" key={name}>
            <div className="service-slot-header">
              <span className="service-slot-name">{name}</span>
              <span className={`badge ${info.providers.length > 0 ? 'active' : 'error'}`}>
                {info.providers.length > 0 ? '就绪' : '未就绪'}
              </span>
            </div>

            {info.providers.length > 1 ? (
              <div className="service-slot-select-row">
                <span className="service-slot-label">活跃提供者</span>
                <select
                  className="service-select"
                  value={info.active ?? ''}
                  disabled={busy === name}
                  onChange={e => handlePrefer(name, e.target.value)}
                >
                  {info.providers.map(p => (
                    <option key={p.contextId} value={p.contextId}>
                      {p.contextId}
                    </option>
                  ))}
                </select>
              </div>
            ) : info.providers.length === 1 ? (
              <div className="service-slot-single">
                <span className="service-slot-label">提供者</span>
                <span className="service-slot-provider-name">{info.providers[0].contextId}</span>
              </div>
            ) : (
              <div className="service-slot-single">
                <span className="empty-hint">无提供者</span>
              </div>
            )}

            {info.providers.length > 0 && (
              <div className="service-slot-caps">
                {info.providers
                  .find(p => p.contextId === info.active)
                  ?.capabilities.map(c => (
                    <span className="tool-chip" key={c}>{c}</span>
                  ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 工具列表 */}
      <div className="section-label">已注册工具</div>
      <div className="tools-grid">
        {!status || status.tools.length === 0
          ? <div className="empty-hint">无工具</div>
          : status.tools.map(t => <span className="tool-chip" key={t}>{t}</span>)
        }
      </div>
    </div>
  );
}

// ===== 递归配置值渲染（只读） =====

function ConfigValue({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 1);

  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    const display = value === null || value === undefined ? '-'
      : Array.isArray(value) ? JSON.stringify(value)
      : String(value);
    return (
      <div className="config-item" style={{ paddingLeft: depth * 12 }}>
        <span className="key">{label}</span>
        <span className="val" title={display}>{display}</span>
      </div>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <div className="config-nested" style={{ paddingLeft: depth * 12 }}>
      <div className="config-nested-header" onClick={() => setOpen(o => !o)}>
        <span className={`config-block-toggle ${open ? 'open' : ''}`}>▶</span>
        <span className="key">{label}</span>
        <span className="config-nested-count">{entries.length} 项</span>
      </div>
      {open && (
        <div className="config-nested-body">
          {entries.map(([k, v]) => (
            <ConfigValue key={k} label={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ===== 扁平化 / 还原嵌套对象（编辑用） =====

function flattenConfig(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenConfig(v as Record<string, unknown>, path));
    } else {
      result[path] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  }
  return result;
}

function unflattenConfig(flat: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [path, raw] of Object.entries(flat)) {
    const keys = path.split('.');
    let cur = result;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(keys[i] in cur) || typeof cur[keys[i]] !== 'object') {
        cur[keys[i]] = {};
      }
      cur = cur[keys[i]] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    try { cur[last] = JSON.parse(raw); } catch { cur[last] = raw; }
  }
  return result;
}

// ===== 插件配置页 =====

function PluginConfigPage({
  plugins,
  config,
  onRefresh,
  onConfigSaved,
}: {
  plugins: PluginInfo[];
  config: Record<string, unknown> | null;
  onRefresh: () => void;
  onConfigSaved: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleToggle = async (plugin: PluginInfo) => {
    if (plugin.core) return;
    setBusy(plugin.name);
    const action = plugin.state === 'disabled' ? 'enable' : 'disable';
    const res = await api<{ ok?: boolean; error?: string }>(
      `/api/plugins/${encodeURIComponent(plugin.name)}/${action}`,
      { method: 'POST' },
    );
    if (res.ok) {
      showToast(`${plugin.name} 已${action === 'enable' ? '启用' : '禁用'}`);
      onRefresh();
    } else {
      showToast(res.error ?? '操作失败');
    }
    setBusy(null);
  };

  const startEdit = (plugin: PluginInfo) => {
    setEditBuffer(flattenConfig((plugin.config ?? {}) as Record<string, unknown>));
    setEditingPlugin(plugin.name);
  };

  const savePluginConfig = async (pluginName: string) => {
    const parsed = unflattenConfig(editBuffer);
    setBusy(pluginName);
    await api(`/api/plugins/${encodeURIComponent(pluginName)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config: parsed }),
    });
    showToast(`${pluginName} 配置已更新`);
    setEditingPlugin(null);
    onRefresh();
    setBusy(null);
  };

  const stateLabel: Record<string, string> = {
    active: '运行中',
    disabled: '已禁用',
    pending: '等待中',
    disposed: '已释放',
  };

  const stateBadge: Record<string, string> = {
    active: 'active',
    disabled: 'disposed',
    pending: 'pending',
  };

  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // 全局配置部分
  const topLevel: [string, unknown][] = [];
  const pluginsConfig: Record<string, Record<string, unknown>> = {};
  if (config) {
    for (const [key, val] of Object.entries(config)) {
      if (key === 'plugins' && typeof val === 'object' && val !== null) {
        Object.assign(pluginsConfig, val);
      } else {
        topLevel.push([key, val]);
      }
    }
  }

  const handleSaveGlobal = async () => {
    setSaving(true);
    const res = await api<{ ok?: boolean; error?: string }>('/api/config/save', { method: 'POST' });
    setSaving(false);
    if (res.ok) {
      showToast('配置已保存到磁盘');
      onConfigSaved();
    } else {
      showToast(res.error ?? '保存失败');
    }
  };

  return (
    <div className="page-content page-plugin-config">
      {toast && <div className="toast">{toast}</div>}

      {/* 全局配置 */}
      <div className="config-header-row">
        <div className="section-label" style={{ marginBottom: 0 }}>全局配置</div>
        <button className="btn btn-primary btn-sm" onClick={handleSaveGlobal} disabled={saving}>
          {saving ? '保存中...' : '保存到磁盘'}
        </button>
      </div>
      {config && (
        <div className="config-block" style={{ marginTop: 8, marginBottom: 20 }}>
          <div className="config-block-body" style={{ paddingTop: 10 }}>
            {topLevel.map(([key, val]) => (
              <ConfigValue key={key} label={key} value={val} />
            ))}
          </div>
        </div>
      )}

      {/* 插件列表 */}
      <div className="section-label">插件管理</div>
      {plugins.length === 0 && <div className="empty-hint">无插件</div>}
      {plugins.map(p => {
        const isEditing = editingPlugin === p.name;
        const isOpen = openSections.has(p.name);
        const hasDetail = p.provides.length > 0 || (p.config && Object.keys(p.config).length > 0);
        return (
          <div className={`plugin-card ${p.state === 'disabled' ? 'disabled' : ''}`} key={p.name}>
            <div className="plugin-card-header">
              <div className="plugin-card-info" style={{ cursor: hasDetail ? 'pointer' : 'default' }} onClick={() => hasDetail && toggleSection(p.name)}>
                {hasDetail && <span className={`config-block-toggle ${isOpen ? 'open' : ''}`}>▶</span>}
                <span className="plugin-card-name">{p.name}</span>
                <span className={`badge ${stateBadge[p.state] ?? 'pending'}`}>
                  {stateLabel[p.state] ?? p.state}
                </span>
                {p.core && <span className="badge core-badge">核心</span>}
              </div>
              <label className={`toggle-switch ${p.core ? 'core-locked' : ''}`}>
                <input
                  type="checkbox"
                  checked={p.state !== 'disabled'}
                  onChange={() => handleToggle(p)}
                  disabled={p.core || busy === p.name}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            {isOpen && p.provides.length > 0 && (
              <div className="plugin-card-provides">
                {p.provides.map(s => <span className="tool-chip" key={s}>{s}</span>)}
              </div>
            )}

            {isOpen && p.config && Object.keys(p.config).length > 0 && (
              <div className="plugin-card-config">
                {!isEditing ? (
                  <>
                    <div className="config-block-body" style={{ paddingTop: 6 }}>
                      {Object.entries(p.config).map(([k, v]) => (
                        <ConfigValue key={k} label={k} value={v} />
                      ))}
                    </div>
                    <button className="btn btn-sm" onClick={() => startEdit(p)}>编辑配置</button>
                  </>
                ) : (
                  <>
                    <div className="config-edit-form">
                      {Object.keys(editBuffer).map(k => (
                        <div className="config-edit-row" key={k}>
                          <label className="config-edit-label">{k}</label>
                          <input
                            className="config-edit-input"
                            value={editBuffer[k]}
                            onChange={e => setEditBuffer(prev => ({ ...prev, [k]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="config-edit-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => savePluginConfig(p.name)} disabled={busy === p.name}>保存</button>
                      <button className="btn btn-sm" onClick={() => setEditingPlugin(null)}>取消</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===== 插件市场页（占位） =====

function MarketplacePage() {
  return (
    <div className="page-content page-marketplace">
      <div className="marketplace-placeholder">
        <div className="marketplace-icon">🏪</div>
        <h2>插件市场</h2>
        <p>即将推出 — 在这里浏览和安装社区插件</p>
      </div>
    </div>
  );
}

// ===== 聊天面板（固定右侧） =====

function ChatPanel({
  messages,
  loading,
  connected,
  status,
  input,
  setInput,
  onSend,
  width,
}: {
  messages: ChatMessage[];
  loading: boolean;
  connected: boolean;
  status: SystemStatus | null;
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  width: number;
}) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        <div className={`connection-dot ${connected ? 'online' : 'offline'}`} />
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
            <div className="message-bubble">
              {msg.role === 'assistant' ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {msg.content}
                </ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
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
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={!connected}
          rows={1}
        />
        <button
          className="send-btn"
          onClick={onSend}
          disabled={!connected || loading || !input.trim()}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

// ===== 日志页 =====

function LogPage({ logs }: { logs: LogEntry[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const filteredLogs = filter ? logs.filter(l => l.level === filter) : logs;

  useEffect(() => {
    if (autoScrollRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filteredLogs.length]);

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  const levels = ['debug', 'info', 'warn', 'error'];

  return (
    <div className="page-logs">
      <div className="log-controls">
        {levels.map(l => (
          <button
            key={l}
            className={`log-filter ${filter === l ? 'active' : ''}`}
            onClick={() => setFilter(prev => prev === l ? null : l)}
          >
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="log-list" ref={listRef} onScroll={handleScroll}>
        {filteredLogs.map((entry, i) => (
          <div className="log-entry" key={i}>
            <span className="log-time">{entry.timestamp}</span>
            <span className={`log-level ${entry.level}`}>{entry.level.toUpperCase().padEnd(5)}</span>
            <span className="log-scope">{entry.scope}</span>
            <span className="log-msg" title={entry.message}>{entry.message}</span>
          </div>
        ))}
        {filteredLogs.length === 0 && (
          <div className="empty-hint" style={{ padding: 16 }}>暂无日志</div>
        )}
      </div>
    </div>
  );
}

// ===== 主组件 =====

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<PageTab>('dashboard');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [servicesData, setServicesData] = useState<Record<string, ServiceInfo> | null>(null);
  const [chatWidth, setChatWidth] = useState(420);

  const handleIncoming = useCallback((content: string) => {
    setMessages(prev => [...prev, { role: 'assistant', content, timestamp: Date.now() }]);
    setLoading(false);
  }, []);

  const handleLog = useCallback((entry: LogEntry) => {
    setLogs(prev => {
      const next = [...prev, entry];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const { send, connected } = useWebSocket(handleIncoming, handleLog);

  const refreshPlugins = useCallback(() => {
    api<{ plugins: PluginInfo[] }>('/api/plugins')
      .then(d => setPlugins(d.plugins ?? []))
      .catch(() => {});
  }, []);

  const refreshConfig = useCallback(() => {
    api<Record<string, unknown>>('/api/config').then(setConfig).catch(() => {});
  }, []);

  const refreshServices = useCallback(() => {
    api<{ services: Record<string, ServiceInfo> }>('/api/services')
      .then(d => setServicesData(d.services ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
    refreshConfig();
    refreshPlugins();
    refreshServices();
    api<LogEntry[]>('/api/logs').then(setLogs).catch(() => {});
  }, [refreshPlugins, refreshConfig, refreshServices]);

  useEffect(() => {
    const timer = setInterval(() => {
      api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
      refreshPlugins();
      refreshServices();
    }, 10000);
    return () => clearInterval(timer);
  }, [refreshPlugins, refreshServices]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setMessages(prev => [...prev, { role: 'user', content: trimmed, timestamp: Date.now() }]);
    send(trimmed);
    setInput('');
    setLoading(true);
  };

  const tabs: { key: PageTab; label: string; icon: React.ReactNode }[] = [
    { key: 'dashboard', label: '仪表盘', icon: <IconDashboard /> },
    { key: 'marketplace', label: '插件市场', icon: <IconMarketplace /> },
    { key: 'plugin-config', label: '插件配置', icon: <IconPluginConfig /> },
    { key: 'logs', label: '日志', icon: <IconLogs /> },
  ];

  return (
    <div className="app-layout">
      {/* 左侧导航 */}
      <nav className="nav-rail">
        <div className="nav-rail-top">
          <div className="nav-logo">A</div>
          {tabs.map(tab => (
            <button
              key={tab.key}
              className={`nav-item ${activeTab === tab.key ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className="nav-item-icon">{tab.icon}</span>
              <span className="nav-item-label">{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="nav-rail-bottom">
          <div className={`nav-status ${connected ? 'online' : 'offline'}`} title={connected ? '已连接' : '离线'} />
        </div>
      </nav>

      {/* 左侧内容区 */}
      <main className="content-area">
        <div className="content-header">
          <span className="content-title">
            {tabs.find(t => t.key === activeTab)?.label}
          </span>
        </div>

        <div className="content-body">
          {activeTab === 'dashboard' && (
            <DashboardPage
              status={status}
              connected={connected}
              plugins={plugins}
              servicesData={servicesData}
              onRefreshServices={refreshServices}
            />
          )}
          {activeTab === 'marketplace' && <MarketplacePage />}
          {activeTab === 'plugin-config' && (
            <PluginConfigPage
              plugins={plugins}
              config={config}
              onRefresh={refreshPlugins}
              onConfigSaved={refreshConfig}
            />
          )}
          {activeTab === 'logs' && <LogPage logs={logs} />}
        </div>
      </main>

      {/* 拖拽分隔条 */}
      <div
        className="resize-handle"
        onMouseDown={e => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = chatWidth;
          const onMove = (ev: MouseEvent) => {
            const appW = document.querySelector('.app-layout')!.clientWidth;
            const navW = document.querySelector('.nav-rail')!.clientWidth;
            const minContent = 360;
            const minChat = 280;
            const maxChat = appW - navW - minContent;
            const raw = startW - (ev.clientX - startX);
            setChatWidth(Math.max(minChat, Math.min(maxChat, raw)));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
          };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
      />

      {/* 右侧固定聊天面板 */}
      <ChatPanel
        messages={messages}
        loading={loading}
        connected={connected}
        status={status}
        input={input}
        setInput={setInput}
        onSend={handleSend}
        width={chatWidth}
      />
    </div>
  );
}
