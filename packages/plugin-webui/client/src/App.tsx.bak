import { useState, useRef, useEffect, useCallback } from 'react';

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

type SidebarTab = 'status' | 'plugins' | 'config' | 'logs';

const SESSION_ID = 'webui-default';

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

// ===== 侧边栏：状态面板 =====

function StatusPanel({ status }: { status: SystemStatus | null }) {
  if (!status) return <div className="panel-section"><div className="panel-label">加载中...</div></div>;

  const serviceEntries = Object.entries(status.services);

  return (<>
    <div className="panel-section">
      <div className="panel-label">服务状态</div>
      <div className="status-card">
        {serviceEntries.map(([name, active]) => (
          <div className="status-card-row" key={name}>
            <span className="label">{name}</span>
            <span className={`badge ${active ? 'active' : 'error'}`}>
              {active ? '运行中' : '未就绪'}
            </span>
          </div>
        ))}
      </div>
    </div>

    <div className="panel-section">
      <div className="panel-label">已注册工具</div>
      <div className="status-card">
        {status.tools.length === 0
          ? <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>无工具</div>
          : status.tools.map(t => <span className="tool-chip" key={t}>{t}</span>)
        }
      </div>
    </div>
  </>);
}

// ===== 递归配置值渲染（只读） =====

function ConfigValue({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 1);

  // 非对象基本值 — 直接 key: value 一行
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

  // 对象值 — 可折叠
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
    // 解析值类型
    try { cur[last] = JSON.parse(raw); } catch { cur[last] = raw; }
  }
  return result;
}

// ===== 侧边栏：插件面板 =====

function PluginsPanel({
  plugins,
  onRefresh,
}: {
  plugins: PluginInfo[];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);

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

  return (<>
    {toast && <div className="toast">{toast}</div>}
    <div className="panel-section">
      <div className="panel-label">已注册插件</div>
      {plugins.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.82rem', padding: 8 }}>无插件</div>
      )}
      {plugins.map(p => {
        const isEditing = editingPlugin === p.name;
        return (
          <div className={`plugin-card ${p.state === 'disabled' ? 'disabled' : ''}`} key={p.name}>
            <div className="plugin-card-header">
              <div className="plugin-card-info">
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

            {p.provides.length > 0 && (
              <div className="plugin-card-provides">
                {p.provides.map(s => <span className="tool-chip" key={s}>{s}</span>)}
              </div>
            )}

            {/* 配置区域 */}
            {p.config && Object.keys(p.config).length > 0 && (
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
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => savePluginConfig(p.name)}
                        disabled={busy === p.name}
                      >
                        保存
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => setEditingPlugin(null)}
                      >
                        取消
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </>);
}

// ===== 侧边栏：配置面板 =====

function ConfigPanel({
  config,
  onSaved,
}: {
  config: Record<string, unknown> | null;
  onSaved: () => void;
}) {
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  if (!config) return <div className="panel-section"><div className="panel-label">加载中...</div></div>;

  const toggle = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const topLevel: [string, unknown][] = [];
  const pluginsConfig: Record<string, Record<string, unknown>> = {};

  for (const [key, val] of Object.entries(config)) {
    if (key === 'plugins' && typeof val === 'object' && val !== null) {
      Object.assign(pluginsConfig, val);
    } else {
      topLevel.push([key, val]);
    }
  }

  const handleSave = async () => {
    setSaving(true);
    const res = await api<{ ok?: boolean; error?: string }>('/api/config/save', {
      method: 'POST',
    });
    setSaving(false);
    if (res.ok) {
      setToast('配置已保存到磁盘');
      onSaved();
    } else {
      setToast(res.error ?? '保存失败');
    }
    setTimeout(() => setToast(null), 2500);
  };

  return (<>
    {toast && <div className="toast">{toast}</div>}

    <div className="panel-section">
      <div className="config-header-row">
        <div className="panel-label" style={{ marginBottom: 0 }}>全局配置</div>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存到磁盘'}
        </button>
      </div>
      <div className="config-block" style={{ marginTop: 8 }}>
        <div className="config-block-body" style={{ paddingTop: 10 }}>
          {topLevel.map(([key, val]) => (
            <ConfigValue key={key} label={key} value={val} />
          ))}
        </div>
      </div>
    </div>

    <div className="panel-section">
      <div className="panel-label">插件配置</div>
      {Object.entries(pluginsConfig).map(([pluginName, pluginConf]) => {
        const isOpen = openSections.has(pluginName);
        const entries = Object.entries(pluginConf as Record<string, unknown>);
        return (
          <div className="config-block" key={pluginName}>
            <div className="config-block-header" onClick={() => toggle(pluginName)}>
              <span className="config-block-title">{pluginName}</span>
              <span className={`config-block-toggle ${isOpen ? 'open' : ''}`}>▶</span>
            </div>
            {isOpen && (
              <div className="config-block-body">
                {entries.map(([key, val]) => (
                  <ConfigValue key={key} label={key} value={val} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </>);
}

// ===== 侧边栏：日志面板 =====

function LogPanel({ logs }: { logs: LogEntry[] }) {
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

  return (<>
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
    <div
      className="log-list"
      ref={listRef}
      onScroll={handleScroll}
      style={{ maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' }}
    >
      {filteredLogs.map((entry, i) => (
        <div className="log-entry" key={i}>
          <span className="log-time">{entry.timestamp}</span>
          <span className={`log-level ${entry.level}`}>{entry.level.toUpperCase().padEnd(5)}</span>
          <span className="log-scope">{entry.scope}</span>
          <span className="log-msg" title={entry.message}>{entry.message}</span>
        </div>
      ))}
      {filteredLogs.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', padding: 8 }}>暂无日志</div>
      )}
    </div>
  </>);
}

// ===== 主组件 =====

export function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<SidebarTab>('status');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  // 加载初始数据
  useEffect(() => {
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
    refreshConfig();
    refreshPlugins();
    api<LogEntry[]>('/api/logs').then(setLogs).catch(() => {});
  }, [refreshPlugins, refreshConfig]);

  // 定期刷新状态+插件
  useEffect(() => {
    const timer = setInterval(() => {
      api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
      refreshPlugins();
    }, 10000);
    return () => clearInterval(timer);
  }, [refreshPlugins]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setMessages(prev => [...prev, { role: 'user', content: trimmed, timestamp: Date.now() }]);
    send(trimmed);
    setInput('');
    setLoading(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const tabLabels: Record<SidebarTab, string> = {
    status: '状态',
    plugins: '插件',
    config: '配置',
    logs: '日志',
  };

  return (
    <div className="app-layout">
      {/* 侧边栏 */}
      <aside className={`sidebar ${sidebarOpen ? '' : 'collapsed'}`}>
        <div className="sidebar-header">
          <span className="sidebar-logo">Aalis</span>
          <span className="sidebar-version">v0.1.0</span>
          <div style={{ flex: 1 }} />
          <span className={`badge ${connected ? 'online' : 'offline'}`}>
            {connected ? '已连接' : '离线'}
          </span>
        </div>

        <div className="sidebar-nav">
          {(Object.keys(tabLabels) as SidebarTab[]).map(tab => (
            <button
              key={tab}
              className={activeTab === tab ? 'active' : ''}
              onClick={() => setActiveTab(tab)}
            >
              {tabLabels[tab]}
            </button>
          ))}
        </div>

        <div className="sidebar-content">
          {activeTab === 'status' && <StatusPanel status={status} />}
          {activeTab === 'plugins' && <PluginsPanel plugins={plugins} onRefresh={refreshPlugins} />}
          {activeTab === 'config' && <ConfigPanel config={config} onSaved={refreshConfig} />}
          {activeTab === 'logs' && <LogPanel logs={logs} />}
        </div>
      </aside>

      {/* 主聊天区 */}
      <main className="main-area">
        <div className="main-header">
          <button
            className="toggle-sidebar-btn"
            onClick={() => setSidebarOpen(p => !p)}
            title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <span className="main-title">
            {status?.name ?? 'Aalis'} 对话
          </span>
          <div className={`connection-dot ${connected ? 'online' : 'offline'}`} />
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty">
              <div className="empty-icon">💬</div>
              开始和 Aalis 对话吧
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i} className={`message-group ${msg.role}`}>
              <div className="message-sender">
                {msg.role === 'user' ? 'You' : status?.name ?? 'Aalis'}
              </div>
              <div className="message-bubble">{msg.content}</div>
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
            onClick={handleSend}
            disabled={!connected || loading || !input.trim()}
          >
            ↑
          </button>
        </div>
      </main>
    </div>
  );
}
