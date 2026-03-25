import { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';

// ===== 类型 =====

type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; result?: string };

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoningContent?: string;
  segments?: ContentSegment[];
  /** 思考阶段的 segments（文本与工具调用交替） */
  reasoningSegments?: ContentSegment[];
  timestamp: number;
}

interface LogEntry {
  timestamp: string;
  level: string;
  scope: string;
  message: string;
}

interface CommandInfo {
  name: string;
  description: string;
  authority?: number;
  safety?: string;
  asTools?: boolean;
}

interface SystemStatus {
  name: string;
  services: Record<string, boolean>;
  tools: string[];
  commands: CommandInfo[];
}

interface ExtendDeclaration {
  events?: string[];
  hooks?: string[];
  mixins?: Record<string, string[]>;
}

interface PluginInfo {
  name: string;
  state: string;
  provides: string[];
  core: boolean;
  extends?: ExtendDeclaration;
  config: Record<string, unknown>;
  configSchema?: ConfigSchema;
  defaultConfig?: Record<string, unknown>;
  error?: string;
}

// ----- ConfigSchema 类型 (镜像 core) -----

type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect';

interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;
  options?: Array<{ label: string; value: string | number }>;
  dynamicOptions?: string;
}

interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}

interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  items: Record<string, SchemaField>;
  default?: unknown[];
}

type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;

// ----- 平台适配器类型 -----

interface PlatformConnectionInfo {
  id: string;
  platform: string;
  selfId?: string;
  status: 'online' | 'offline' | 'connecting';
  detail?: Record<string, unknown>;
}

interface PlatformInfo {
  adapterName: string;
  platform: string;
  contextId: string;
  connections: PlatformConnectionInfo[];
}

interface ServiceProviderInfo {
  contextId: string;
  capabilities: string[];
}

interface ServiceInfo {
  providers: ServiceProviderInfo[];
  active: string | undefined;
}

type PageTab = 'dashboard' | 'marketplace' | 'plugin-config' | 'platforms' | 'authority' | 'logs';

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

function IconPlatform() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function IconAuthority() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
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
  onMessage: (content: string, reasoningContent?: string) => void,
  onStream: (contentDelta?: string, reasoningDelta?: string, done?: boolean) => void,
  onLog: (entry: LogEntry) => void,
  onToolCall: (toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => void,
  onStateChanged?: () => void,
  onRestarting?: () => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnected(true);
        ws.send(JSON.stringify({ type: 'subscribe_logs' }));
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'stream') {
            onStream(data.contentDelta, data.reasoningDelta, data.done);
          } else if (data.type === 'message' && data.content) {
            onMessage(data.content, data.reasoningContent);
          } else if (data.type === 'tool_call' && data.toolName) {
            onToolCall(data.toolName, data.toolArgs ?? {}, data.toolPhase, data.toolResult);
          } else if (data.type === 'log' && data.log) {
            onLog(data.log);
          } else if (data.type === 'state_changed') {
            onStateChanged?.();
          } else if (data.type === 'restarting') {
            onRestarting?.();
          }
        } catch { /* ignore */ }
      };
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [onMessage, onStream, onLog, onToolCall, onStateChanged, onRestarting]);

  const send = useCallback((content: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content,
        sessionId: SESSION_ID,
      }));
    }
  }, []);

  const sendRaw = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, sendRaw, connected };
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
  const errorCount = plugins.filter(p => p.state === 'error').length;
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
      showToast(res.error ?? '未知错误');
    }
    setBusy(null);
  };

  const serviceEntries = servicesData
    ? Object.entries(servicesData).filter(([name]) => name !== 'platform' && name !== 'app')
    : [];

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
        {errorCount > 0 && (
          <div className="overview-card overview-card-error">
            <div className="overview-card-icon">⚠️</div>
            <div className="overview-card-body">
              <div className="overview-card-label">错误插件</div>
              <div className="overview-card-value">{errorCount}</div>
            </div>
          </div>
        )}
        <div className="overview-card">
          <div className="overview-card-icon">🛠</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册工具</div>
            <div className="overview-card-value">{status?.tools.length ?? 0}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">⌘</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册指令</div>
            <div className="overview-card-value">{status?.commands?.length ?? 0}</div>
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

      {/* 指令列表 */}
      <div className="section-label">已注册指令</div>
      <div className="tools-grid">
        {!status || !status.commands || status.commands.length === 0
          ? <div className="empty-hint">无指令</div>
          : status.commands.map(c => (
            <span className="tool-chip cmd-chip" key={c.name} title={c.description}>
              /{c.name}
              {c.authority != null && c.authority > 1 && (
                <span className="chip-badge chip-auth">🔒{c.authority}</span>
              )}
              {c.safety === 'dangerous' && (
                <span className="chip-badge chip-danger">⚠️</span>
              )}
            </span>
          ))
        }
      </div>
    </div>
  );
}

// ===== 递归配置值渲染（只读） =====

function ConfigValue({ label, value, depth = 0, secret, description }: { label: string; value: unknown; depth?: number; secret?: boolean; description?: string }) {
  const [open, setOpen] = useState(depth < 1);

  // 数组：每项展开为 #1, #2, ...
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="config-item" style={{ paddingLeft: depth * 12 }}>
          <span className="key">
            <code className="field-key">{label}</code>
            {description && <span className="field-hint"> / {description}</span>}
          </span>
          <span className="val">(空)</span>
        </div>
      );
    }
    return (
      <div className="config-nested" style={{ paddingLeft: depth * 12 }}>
        <div className="config-nested-header" onClick={() => setOpen(o => !o)}>
          <span className={`config-block-toggle ${open ? 'open' : ''}`}>▶</span>
          <span className="key">
            <code className="field-key">{label}</code>
            {description && <span className="field-hint"> / {description}</span>}
          </span>
          <span className="config-nested-count">{value.length} 项</span>
        </div>
        {open && (
          <div className="config-nested-body">
            {value.map((item, idx) => (
              <ConfigValue key={idx} label={`#${idx + 1}`} value={item} depth={depth + 1} secret={secret} />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    const isSensitive = secret || /apiKey|password|secret|token/i.test(label);
    const raw = value === null || value === undefined ? '-' : String(value);
    const display = isSensitive && raw.length > 4 ? raw.slice(0, 4) + '••••••' : raw;
    return (
      <div className="config-item" style={{ paddingLeft: depth * 12 }}>
        <span className="key">
          <code className="field-key">{label}</code>
          {description && <span className="field-hint"> / {description}</span>}
        </span>
        <span className="val" title={isSensitive ? '••••••' : raw}>{display}</span>
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
            <ConfigValue key={k} label={k} value={v} depth={depth + 1} secret={secret} />
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

// ===== Schema 辅助 =====

function isSchemaField(entry: SchemaField | SchemaGroup | SchemaArray): entry is SchemaField {
  return 'type' in entry && (entry as SchemaArray).type !== 'array';
}

function isSchemaArray(entry: SchemaField | SchemaGroup | SchemaArray): entry is SchemaArray {
  return 'type' in entry && (entry as SchemaArray).type === 'array';
}

/** 从 configSchema + 当前 config 构建 draft 对象 */
function buildDraftFromSchema(schema: ConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (isSchemaArray(entry)) {
      // SchemaArray: 保留已有数组，否则取默认值
      const existing = config[key];
      draft[key] = Array.isArray(existing) ? existing : (entry.default ?? []);
    } else if (isSchemaField(entry)) {
      draft[key] = config[key] ?? entry.default ?? (entry.type === 'number' ? 0 : entry.type === 'boolean' ? false : entry.type === 'multiselect' ? [] : '');
    } else {
      // SchemaGroup
      const group: Record<string, unknown> = {};
      const src = (config[key] ?? {}) as Record<string, unknown>;
      for (const [fk, field] of Object.entries(entry.fields)) {
        group[fk] = src[fk] ?? field.default ?? (field.type === 'number' ? 0 : field.type === 'boolean' ? false : field.type === 'multiselect' ? [] : '');
      }
      draft[key] = group;
    }
  }
  // 保留 schema 中未定义但 config 中已有的字段
  for (const [key, val] of Object.entries(config)) {
    if (!(key in draft)) draft[key] = val;
  }
  return draft;
}

// ===== SchemaForm 组件 =====

function SchemaFormField({
  field,
  fieldKey,
  value,
  onChange,
  modelCache,
  onFetchModels,
}: {
  field: SchemaField;
  fieldKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
  modelCache: Record<string, string[]>;
  onFetchModels: (service: string) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <label className="config-edit-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
        {field.label}
      </label>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value as string[] : [];
    const allOptions = field.options ?? [];
    const toggle = (v: string) => {
      const next = selected.includes(v) ? selected.filter(s => s !== v) : [...selected, v];
      onChange(next);
    };
    return (
      <div className="multiselect-group">
        {allOptions.map(o => (
          <label key={String(o.value)} className="multiselect-item">
            <input
              type="checkbox"
              checked={selected.includes(String(o.value))}
              onChange={() => toggle(String(o.value))}
            />
            {o.label}
          </label>
        ))}
      </div>
    );
  }

  if (field.type === 'select') {
    const dynamicKey = field.dynamicOptions;
    const dynamicModels = dynamicKey ? modelCache[dynamicKey] : undefined;

    // 触发一次远端模型拉取
    useEffect(() => {
      if (dynamicKey && !modelCache[dynamicKey]) {
        onFetchModels(dynamicKey);
      }
    }, [dynamicKey]);

    // 合并静态选项 + 动态选项
    const staticOpts = field.options ?? [];
    const dynOpts = (dynamicModels ?? []).map(m => ({ label: m, value: m }));
    const allOptions = [...staticOpts];
    for (const d of dynOpts) {
      if (!allOptions.some(o => String(o.value) === String(d.value))) allOptions.push(d);
    }
    // 如果当前值不在列表中，也加进去
    const cur = String(value ?? '');
    if (cur && !allOptions.some(o => String(o.value) === cur)) {
      allOptions.unshift({ label: cur, value: cur });
    }

    return (
      <select
        className="config-edit-input"
        value={cur}
        onChange={e => onChange(e.target.value)}
      >
        {allOptions.length === 0 && <option value="">加载中...</option>}
        {allOptions.map(o => (
          <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
        ))}
      </select>
    );
  }

  if (field.type === 'number') {
    return (
      <input
        className="config-edit-input"
        type="number"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={e => {
          const v = e.target.value;
          onChange(v === '' ? '' : Number(v));
        }}
      />
    );
  }

  // string (default)
  const isSensitive = field.secret || /apiKey|password|secret|token/i.test(fieldKey);
  return (
    <input
      className="config-edit-input"
      type={isSensitive ? 'password' : 'text'}
      value={String(value ?? '')}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function SchemaForm({
  schema,
  draft,
  onChange,
  modelCache,
  onFetchModels,
}: {
  schema: ConfigSchema;
  draft: Record<string, unknown>;
  onChange: (newDraft: Record<string, unknown>) => void;
  modelCache: Record<string, string[]>;
  onFetchModels: (service: string) => void;
}) {
  return (
    <div className="config-edit-form">
      {Object.entries(schema).map(([key, entry]) => {
        if (isSchemaField(entry)) {
          const hint = entry.description || entry.label;
          return (
            <div className="config-edit-row" key={key}>
              <label className="config-edit-label" title={entry.description}>
                <code className="field-key">{key}</code>
                {hint && <span className="field-hint"> / {hint}</span>}
                {entry.required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
              </label>
              <SchemaFormField
                field={entry}
                fieldKey={key}
                value={draft[key]}
                onChange={v => onChange({ ...draft, [key]: v })}
                modelCache={modelCache}
                onFetchModels={onFetchModels}
              />
            </div>
          );
        }

        // SchemaArray
        if (isSchemaArray(entry)) {
          const arr = (Array.isArray(draft[key]) ? draft[key] : []) as Record<string, unknown>[];
          const updateArr = (newArr: Record<string, unknown>[]) => onChange({ ...draft, [key]: newArr });

          const addItem = () => {
            const newItem: Record<string, unknown> = {};
            for (const [fk, field] of Object.entries(entry.items)) {
              newItem[fk] = field.default ?? (field.type === 'number' ? 0 : field.type === 'boolean' ? false : '');
            }
            updateArr([...arr, newItem]);
          };

          const removeItem = (idx: number) => {
            updateArr(arr.filter((_, i) => i !== idx));
          };

          const updateItem = (idx: number, fieldKey: string, value: unknown) => {
            const newArr = arr.map((item, i) => i === idx ? { ...item, [fieldKey]: value } : item);
            updateArr(newArr);
          };

          return (
            <div className="config-edit-group" key={key}>
              <div className="config-edit-group-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {entry.label}
                <button
                  className="config-edit-btn"
                  style={{ fontSize: 12, padding: '2px 8px' }}
                  onClick={addItem}
                >+ 添加</button>
              </div>
              {entry.description && <span className="config-edit-hint" style={{ marginBottom: 8, display: 'block' }}>{entry.description}</span>}
              {arr.length === 0 && <div style={{ color: '#888', fontSize: 13, padding: '4px 0' }}>暂无条目，点击"添加"新建</div>}
              {arr.map((item, idx) => (
                <div className="config-edit-array-item" key={idx} style={{
                  border: '1px solid var(--border, #333)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 8,
                  position: 'relative',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: '#888' }}>#{idx + 1}</span>
                    <button
                      className="config-edit-btn"
                      style={{ fontSize: 11, padding: '1px 6px', color: '#ef4444' }}
                      onClick={() => removeItem(idx)}
                    >删除</button>
                  </div>
                  {Object.entries(entry.items).map(([fk, field]) => {
                    const itemHint = field.description || field.label;
                    return (
                    <div className="config-edit-row" key={fk}>
                      <label className="config-edit-label" title={field.description}>
                        <code className="field-key">{fk}</code>
                        {itemHint && <span className="field-hint"> / {itemHint}</span>}
                        {field.required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
                      </label>
                      <SchemaFormField
                        field={field}
                        fieldKey={fk}
                        value={item[fk]}
                        onChange={v => updateItem(idx, fk, v)}
                        modelCache={modelCache}
                        onFetchModels={onFetchModels}
                      />
                    </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        }

        // SchemaGroup
        const group = entry as SchemaGroup;
        const groupData = (draft[key] ?? {}) as Record<string, unknown>;
        return (
          <div className="config-edit-group" key={key}>
            {group.label && <div className="config-edit-group-label">{group.label}</div>}
            {group.description && <span className="config-edit-hint" style={{ marginBottom: 8, display: 'block' }}>{group.description}</span>}
            {Object.entries(group.fields).map(([fk, field]) => {
              const groupHint = field.description || field.label;
              return (
              <div className="config-edit-row" key={fk}>
                <label className="config-edit-label" title={field.description}>
                  <code className="field-key">{fk}</code>
                  {groupHint && <span className="field-hint"> / {groupHint}</span>}
                  {field.required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
                </label>
                <SchemaFormField
                  field={field}
                  fieldKey={fk}
                  value={groupData[fk]}
                  onChange={v => onChange({ ...draft, [key]: { ...groupData, [fk]: v } })}
                  modelCache={modelCache}
                  onFetchModels={onFetchModels}
                />
              </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ===== 插件配置页 =====

function PluginConfigPage({
  plugins,
  config,
  onRefresh,
  onConfigSaved,
  onRestart,
}: {
  plugins: PluginInfo[];
  config: Record<string, unknown> | null;
  onRefresh: () => void;
  onConfigSaved: () => void;
  onRestart: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<Record<string, string>>({});
  const [schemaDraft, setSchemaDraft] = useState<Record<string, unknown>>({});
  const [modelCache, setModelCache] = useState<Record<string, string[]>>({});
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
      showToast(res.error ?? '未知错误');
    }
    setBusy(null);
  };

  const startEdit = (plugin: PluginInfo) => {
    const config = (plugin.config ?? {}) as Record<string, unknown>;
    if (plugin.configSchema) {
      setSchemaDraft(buildDraftFromSchema(plugin.configSchema, config));
    } else {
      setEditBuffer(flattenConfig(config));
    }
    setEditingPlugin(plugin.name);
  };

  const fetchModels = useCallback(async (service: string) => {
    if (modelCache[service]) return;
    try {
      const res = await api<{ models: string[] }>(`/api/models/${encodeURIComponent(service)}`);
      setModelCache(prev => ({ ...prev, [service]: res.models ?? [] }));
    } catch {
      setModelCache(prev => ({ ...prev, [service]: [] }));
    }
  }, [modelCache]);

  const restoreDefaults = (plugin: PluginInfo) => {
    const defaults = plugin.defaultConfig ?? {};
    if (plugin.configSchema) {
      setSchemaDraft(buildDraftFromSchema(plugin.configSchema, defaults));
    } else {
      setEditBuffer(flattenConfig(defaults));
    }
  };

  const savePluginConfig = async (pluginName: string, hasSchema: boolean) => {
    const parsed = hasSchema ? schemaDraft : unflattenConfig(editBuffer);
    setBusy(pluginName);
    await api(`/api/plugins/${encodeURIComponent(pluginName)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config: parsed }),
    });
    showToast(`${pluginName} 配置已更新，正在重载…`);
    setEditingPlugin(null);
    onRefresh();
    // 插件重载是异步的，延迟再刷新一次以获取最终状态
    setTimeout(() => onRefresh(), 1500);
    setBusy(null);
  };

  const stateLabel: Record<string, string> = {
    active: '运行中',
    disabled: '已禁用',
    pending: '等待中',
    disposed: '已释放',
    error: '运行错误',
  };

  const stateBadge: Record<string, string> = {
    active: 'active',
    disabled: 'disposed',
    pending: 'pending',
    error: 'error',
  };

  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const [editingGlobal, setEditingGlobal] = useState(false);
  const [globalDraft, setGlobalDraft] = useState<Record<string, unknown>>({});

  // 从 API 返回的 _schema 抽取核心配置 schema
  const coreSchema: ConfigSchema | undefined = config && (config as Record<string, unknown>)._schema
    ? (config as Record<string, unknown>)._schema as ConfigSchema
    : undefined;

  // 当 config / schema 变化时同步 draft
  useEffect(() => {
    if (config && coreSchema) {
      setGlobalDraft(buildDraftFromSchema(coreSchema, config as Record<string, unknown>));
    }
  }, [config, coreSchema]);

  const handleSaveGlobal = async () => {
    setSaving(true);
    const res = await api<{ ok?: boolean; error?: string; restart?: boolean }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(globalDraft),
    });
    setSaving(false);
    if (res.ok) {
      setEditingGlobal(false);
      onConfigSaved();
      if (res.restart) {
        onRestart();
      } else {
        showToast('全局配置已保存');
      }
    } else {
      showToast(res.error ?? '未知错误');
    }
  };

  return (
    <div className="page-content page-plugin-config">
      {toast && <div className="toast">{toast}</div>}

      {/* 全局配置 */}
      <div className="config-header-row">
        <div className="section-label" style={{ marginBottom: 0 }}>全局配置</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {!editingGlobal ? (
            <button className="btn btn-sm" onClick={() => setEditingGlobal(true)}>编辑</button>
          ) : (
            <>
              <button className="btn btn-primary btn-sm" onClick={handleSaveGlobal} disabled={saving}>
                {saving ? '保存中...' : '保存'}
              </button>
              <button className="btn btn-sm" onClick={() => setEditingGlobal(false)}>取消</button>
            </>
          )}
        </div>
      </div>
      {config && coreSchema && (
        <div className="config-block" style={{ marginTop: 8, marginBottom: 20 }}>
          <div className="config-block-body" style={{ paddingTop: 10 }}>
            {editingGlobal ? (
              <SchemaForm
                schema={coreSchema}
                draft={globalDraft}
                onChange={setGlobalDraft}
                modelCache={modelCache}
                onFetchModels={fetchModels}
              />
            ) : (
              <>
                {Object.entries(coreSchema).map(([key, entry]) => {
                  const val = (config as Record<string, unknown>)[key];
                  const field = entry as SchemaField;
                  const hint = field.description || field.label;
                  return (
                    <div className="config-item" key={key}>
                      <span className="key">
                        <code className="field-key">{key}</code>
                        {hint && <span className="field-hint"> / {hint}</span>}
                      </span>
                      <span className="val">
                        {field.type === 'boolean'
                          ? (val ? '✓ 开启' : '✗ 关闭')
                          : (val === '' || val == null) ? '(空)' : String(val)}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}

      {/* 插件列表 */}
      <div className="section-label">插件管理</div>
      {plugins.length === 0 && <div className="empty-hint">无插件</div>}
      {plugins.map(p => {
        const isEditing = editingPlugin === p.name;
        const isOpen = openSections.has(p.name);
        const hasExtends = p.extends && (p.extends.events?.length || p.extends.hooks?.length || p.extends.mixins && Object.keys(p.extends.mixins).length);
        const hasDetail = p.provides.length > 0 || hasExtends || (p.config && Object.keys(p.config).length > 0) || !!p.configSchema;
        const hasSchema = !!p.configSchema;
        return (
          <div className={`plugin-card ${p.state === 'disabled' ? 'disabled' : ''} ${p.state === 'error' ? 'errored' : ''}`} key={p.name}>
            <div className="plugin-card-header">
              <div className="plugin-card-info" style={{ cursor: hasDetail ? 'pointer' : 'default' }} onClick={() => hasDetail && toggleSection(p.name)}>
                {hasDetail && <span className={`config-block-toggle ${isOpen ? 'open' : ''}`}>▶</span>}
                <span className="plugin-card-name">{p.name}</span>
                <span className={`badge ${stateBadge[p.state] ?? 'pending'}`}>
                  {stateLabel[p.state] ?? p.state}
                </span>
                {p.core && <span className="badge core-badge">核心</span>}
                {p.provides.length > 0 && (
                  <span className="plugin-provides-inline">
                    {p.provides.map(s => <span className="provides-chip" key={s}>{s}</span>)}
                  </span>
                )}
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

            {p.state === 'error' && p.error && (
              <div className="plugin-error-msg">⚠ {p.error}</div>
            )}

            {isOpen && p.provides.length > 0 && (
              <div className="plugin-card-provides">
                {p.provides.map(s => <span className="tool-chip" key={s}>{s}</span>)}
              </div>
            )}

            {isOpen && hasExtends && (
              <div className="plugin-card-extends">
                <span className="extends-label">扩展 Core:</span>
                {p.extends!.events?.map(e => <span className="extends-chip event" key={`e-${e}`}>📡 {e}</span>)}
                {p.extends!.hooks?.map(h => <span className="extends-chip hook" key={`h-${h}`}>🪝 {h}</span>)}
                {p.extends!.mixins && Object.entries(p.extends!.mixins).map(([svc, methods]) =>
                  methods.map(m => <span className="extends-chip mixin" key={`m-${svc}-${m}`}>🔗 ctx.{m}()</span>)
                )}
              </div>
            )}

            {isOpen && (p.config && Object.keys(p.config).length > 0 || hasSchema) && (
              <div className="plugin-card-config">
                {!isEditing ? (
                  <>
                    <div className="config-block-body" style={{ paddingTop: 6 }}>
                      {Object.entries(p.config).map(([k, v]) => {
                        const schemaEntry = p.configSchema?.[k];
                        const isSecret = schemaEntry && 'secret' in schemaEntry ? (schemaEntry as SchemaField).secret : undefined;
                        const fieldDesc = schemaEntry && 'description' in schemaEntry ? (schemaEntry as SchemaField).description
                          : schemaEntry && 'label' in schemaEntry ? (schemaEntry as SchemaField).label
                          : undefined;
                        return <ConfigValue key={k} label={k} value={v} secret={isSecret} description={fieldDesc} />;
                      })}
                    </div>
                    <button className="btn btn-sm" onClick={() => startEdit(p)}>编辑配置</button>
                  </>
                ) : hasSchema ? (
                  <>
                    <SchemaForm
                      schema={p.configSchema!}
                      draft={schemaDraft}
                      onChange={setSchemaDraft}
                      modelCache={modelCache}
                      onFetchModels={fetchModels}
                    />
                    <div className="config-edit-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => savePluginConfig(p.name, true)} disabled={busy === p.name}>保存</button>
                      {p.defaultConfig && Object.keys(p.defaultConfig).length > 0 && (
                        <button className="btn btn-warn btn-sm" onClick={() => restoreDefaults(p)}>恢复默认</button>
                      )}
                      <button className="btn btn-sm" onClick={() => setEditingPlugin(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="config-edit-form">
                      {Object.keys(editBuffer).map(k => (
                        <div className="config-edit-row" key={k}>
                          <label className="config-edit-label">{k}</label>
                          <input
                            className="config-edit-input"
                            type={/apiKey|password|secret|token/i.test(k) ? 'password' : 'text'}
                            value={editBuffer[k]}
                            onChange={e => setEditBuffer(prev => ({ ...prev, [k]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="config-edit-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => savePluginConfig(p.name, false)} disabled={busy === p.name}>保存</button>
                      {p.defaultConfig && Object.keys(p.defaultConfig).length > 0 && (
                        <button className="btn btn-warn btn-sm" onClick={() => restoreDefaults(p)}>恢复默认</button>
                      )}
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

// ===== 插件市场页 =====

function MarketplacePage({
  plugins,
  onRefresh,
}: {
  plugins: PluginInfo[];
  onRefresh: () => void;
}) {
  const [installPkg, setInstallPkg] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleScan = async () => {
    setBusy(true);
    const res = await api<{ ok?: boolean; loaded?: string[]; message?: string; error?: string }>(
      '/api/plugins/scan',
      { method: 'POST' },
    );
    if (res.ok) {
      showToast(res.message ?? '扫描完成');
      onRefresh();
    } else {
      showToast(res.error ?? '扫描失败');
    }
    setBusy(false);
  };

  const handleInstall = async () => {
    const pkg = installPkg.trim();
    if (!pkg) return;
    setBusy(true);
    const res = await api<{ ok?: boolean; message?: string; error?: string }>(
      '/api/plugins/install',
      { method: 'POST', body: JSON.stringify({ name: pkg }) },
    );
    if (res.ok) {
      showToast(res.message ?? '安装成功');
      setInstallPkg('');
      onRefresh();
    } else {
      showToast(res.error ?? res.message ?? '安装失败');
    }
    setBusy(false);
  };

  const handleUninstall = async (pluginName: string) => {
    setUninstalling(pluginName);
    const res = await api<{ ok?: boolean; message?: string; error?: string }>(
      `/api/plugins/${encodeURIComponent(pluginName)}/uninstall`,
      { method: 'POST' },
    );
    if (res.ok) {
      showToast(res.message ?? '卸载成功');
      onRefresh();
    } else {
      showToast(res.error ?? '卸载失败');
    }
    setUninstalling(null);
  };

  const stateLabel: Record<string, string> = {
    active: '运行中',
    disabled: '已禁用',
    pending: '等待中',
    error: '错误',
    disposed: '已释放',
  };

  const stateBadge: Record<string, string> = {
    active: 'active',
    disabled: 'disposed',
    pending: 'pending',
    error: 'error',
  };

  return (
    <div className="page-content page-marketplace">
      {toast && <div className="toast">{toast}</div>}

      {/* 安装区 */}
      <div className="section-label">安装插件</div>
      <div className="marketplace-install-row">
        <input
          className="marketplace-install-input"
          placeholder="npm 包名，如 @aalis/plugin-example"
          value={installPkg}
          onChange={e => setInstallPkg(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleInstall()}
          disabled={busy}
        />
        <button className="btn btn-primary btn-sm" onClick={handleInstall} disabled={busy || !installPkg.trim()}>
          {busy ? '安装中...' : '安装'}
        </button>
        <button className="btn btn-sm" onClick={handleScan} disabled={busy}>
          重新扫描
        </button>
      </div>

      {/* 已安装插件列表 */}
      <div className="section-label" style={{ marginTop: 24 }}>已安装插件 ({plugins.length})</div>
      {plugins.length === 0 && <div className="empty-hint">无插件</div>}
      <div className="marketplace-plugin-list">
        {plugins.map(p => (
          <div className={`plugin-card ${p.state === 'disabled' ? 'disabled' : ''}`} key={p.name}>
            <div className="plugin-card-header">
              <div className="plugin-card-info">
                <span className="plugin-card-name">{p.name}</span>
                <span className={`badge ${stateBadge[p.state] ?? 'pending'}`}>
                  {stateLabel[p.state] ?? p.state}
                </span>
                {p.core && <span className="badge core-badge">核心</span>}
              </div>
              {!p.core && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => handleUninstall(p.name)}
                  disabled={uninstalling === p.name}
                >
                  {uninstalling === p.name ? '卸载中...' : '卸载'}
                </button>
              )}
            </div>
            {p.provides.length > 0 && (
              <div className="plugin-card-provides">
                {p.provides.map(s => <span className="tool-chip" key={s}>{s}</span>)}
              </div>
            )}
            {p.error && <div className="plugin-error-msg">⚠ {p.error}</div>}
          </div>
        ))}
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
            {msg.role === 'assistant' && msg.reasoningSegments && msg.reasoningSegments.length > 0 && (
              <details className="thinking-block">
                <summary className="thinking-summary">💭 思考过程</summary>
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
              </details>
            )}
            {msg.role === 'assistant' && msg.segments && msg.segments.length > 0 ? (
              <div className="message-bubble">
                {msg.segments.map((seg, j) =>
                  seg.type === 'text' ? (
                    seg.content ? (
                      <ReactMarkdown key={j} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {seg.content}
                      </ReactMarkdown>
                    ) : null
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
            ) : (
              <div className="message-bubble">
                {msg.role === 'assistant' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {msg.content}
                  </ReactMarkdown>
                ) : (
                  msg.content
                )}
              </div>
            )}
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

// ===== 平台接入页 =====

function PlatformPage() {
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ platforms: PlatformInfo[] }>('/api/platforms');
      setPlatforms(data.platforms ?? []);
    } catch {
      setPlatforms([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const totalConnections = platforms.reduce((sum, p) => sum + p.connections.length, 0);
  const onlineConnections = platforms.reduce(
    (sum, p) => sum + p.connections.filter(c => c.status === 'online').length,
    0,
  );

  return (
    <div className="page-content page-platforms">
      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon">🔌</div>
          <div className="overview-card-body">
            <div className="overview-card-label">适配器</div>
            <div className="overview-card-value">{platforms.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">🌐</div>
          <div className="overview-card-body">
            <div className="overview-card-label">连接数</div>
            <div className="overview-card-value">{onlineConnections} / {totalConnections}</div>
          </div>
        </div>
      </div>

      <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        适配器列表
        <button className="btn-sm" onClick={refresh} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {platforms.length === 0 && !loading && (
        <div className="empty-hint">暂无平台适配器。请启用并配置平台适配器插件。</div>
      )}

      {platforms.map(p => (
        <div className="platform-card" key={p.contextId}>
          <div className="platform-card-header">
            <span className="platform-card-name">{p.adapterName}</span>
            <span className="platform-card-id">{p.platform}</span>
          </div>
          {p.connections.length === 0 ? (
            <div className="platform-no-connections">无活跃连接</div>
          ) : (
            <div className="platform-connections">
              {p.connections.map(conn => (
                <div className="platform-connection" key={conn.id}>
                  <span className={`platform-status-dot ${conn.status}`} />
                  <span className="platform-conn-id">{conn.selfId ?? conn.id}</span>
                  <span className={`platform-conn-status ${conn.status}`}>
                    {conn.status === 'online' ? '在线' : conn.status === 'connecting' ? '连接中' : '离线'}
                  </span>
                  {conn.detail && Object.keys(conn.detail).length > 0 && (
                    <span className="platform-conn-detail">
                      {Object.entries(conn.detail).map(([k, v]) => `${k}: ${String(v)}`).join(', ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ===== 权限管理页 =====

interface AuthorityUser {
  platform: string;
  userId: string;
  authority: number;
}

interface AuthorityOwner {
  platform: string;
  userId: string;
}

interface AuthorityCommand {
  name: string;
  description: string;
  authority: number;
  safety: string;
  baseAuthority: number;
  baseSafety: string;
  overridden: boolean;
  pluginName: string;
}

interface AuthorityTool {
  name: string;
  description: string;
  authority: number;
  safety: string;
  baseAuthority: number;
  baseSafety: string;
  overridden: boolean;
  pluginName: string;
}

interface AuthorityData {
  users: AuthorityUser[];
  owners: AuthorityOwner[];
  defaultAuthority: number;
  ownerAuthority: number;
  commandPrefix: string;
  commandAsTools: boolean;
  commands: AuthorityCommand[];
  commandOverrides: Record<string, { authority?: number; safety?: string }>;
  tools: AuthorityTool[];
  toolOverrides: Record<string, { authority?: number; safety?: string }>;
  dangerousPolicy: {
    allow?: string[];
    duration?: number;
  };
}

function AuthorityPage() {
  const [data, setData] = useState<AuthorityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  // 展开/折叠区段
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['config']));
  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // 编辑状态
  const [editConfig, setEditConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState({ defaultAuthority: 1, ownerAuthority: 5 });
  const [editDangerous, setEditDangerous] = useState(false);
  const [dangerousDraft, setDangerousDraft] = useState({ allow: '', duration: 0 });
  const [editUser, setEditUser] = useState<{ platform: string; userId: string; authority: number } | null>(null);
  const [newUser, setNewUser] = useState({ platform: '', userId: '', authority: 1 });
  const [showAddUser, setShowAddUser] = useState(false);
  const [newOwner, setNewOwner] = useState({ platform: '', userId: '' });
  const [showAddOwner, setShowAddOwner] = useState(false);
  const [editingCmd, setEditingCmd] = useState<string | null>(null);
  const [cmdDraft, setCmdDraft] = useState({ authority: 1, safety: 'safe' });
  const [editingTool, setEditingTool] = useState<string | null>(null);
  const [toolDraft, setToolDraft] = useState({ authority: 1, safety: 'safe' });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<AuthorityData>('/api/authority');
      setData(d);
      setConfigDraft({ defaultAuthority: d.defaultAuthority, ownerAuthority: d.ownerAuthority });
      setDangerousDraft({
        allow: (d.dangerousPolicy?.allow ?? []).join(', '),
        duration: d.dangerousPolicy?.duration ?? 0,
      });
    } catch {
      setData(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const flash = (msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 2000);
  };

  // ---- 用户操作 ----
  const saveUserAuthority = async (platform: string, userId: string, authority: number) => {
    await api('/api/authority/user', { method: 'PUT', body: JSON.stringify({ platform, userId, authority }) });
    setEditUser(null);
    flash(`已设置 ${platform}:${userId} → ${authority}`);
    refresh();
  };
  const deleteUser = async (platform: string, userId: string) => {
    await api('/api/authority/user', { method: 'DELETE', body: JSON.stringify({ platform, userId }) });
    flash(`已重置 ${platform}:${userId}`);
    refresh();
  };
  const addUser = async () => {
    if (!newUser.platform || !newUser.userId) return;
    await saveUserAuthority(newUser.platform, newUser.userId, newUser.authority);
    setNewUser({ platform: '', userId: '', authority: 1 });
    setShowAddUser(false);
  };

  // ---- Owner 操作 ----
  const addOwner = async () => {
    if (!data || !newOwner.platform || !newOwner.userId) return;
    const owners = [...data.owners, { platform: newOwner.platform, userId: newOwner.userId }];
    await api('/api/authority/owners', { method: 'PUT', body: JSON.stringify({ owners }) });
    setNewOwner({ platform: '', userId: '' });
    setShowAddOwner(false);
    flash('Owner 已添加');
    refresh();
  };
  const removeOwner = async (idx: number) => {
    if (!data) return;
    const owners = data.owners.filter((_, i) => i !== idx);
    await api('/api/authority/owners', { method: 'PUT', body: JSON.stringify({ owners }) });
    flash('Owner 已移除');
    refresh();
  };

  // ---- 配置操作 ----
  const saveConfig = async () => {
    await api('/api/authority/config', { method: 'PUT', body: JSON.stringify(configDraft) });
    setEditConfig(false);
    flash('权限配置已保存');
    refresh();
  };
  const saveDangerous = async () => {
    const allow = dangerousDraft.allow.split(',').map(s => s.trim()).filter(Boolean);
    await api('/api/authority/dangerous', { method: 'PUT', body: JSON.stringify({ policy: { allow, duration: dangerousDraft.duration } }) });
    setEditDangerous(false);
    flash('高危策略已保存');
    refresh();
  };

  // ---- 指令权限操作 ----
  const saveCommandOverride = async (name: string) => {
    await api('/api/authority/command', { method: 'PUT', body: JSON.stringify({ name, authority: cmdDraft.authority, safety: cmdDraft.safety }) });
    setEditingCmd(null);
    flash(`指令 ${name} 权限已更新`);
    refresh();
  };
  const resetCommandOverride = async (name: string) => {
    await api('/api/authority/command', { method: 'DELETE', body: JSON.stringify({ name }) });
    flash(`指令 ${name} 已恢复默认`);
    refresh();
  };

  // ---- 工具权限操作 ----
  const saveToolOverride = async (name: string) => {
    await api('/api/authority/tool', { method: 'PUT', body: JSON.stringify({ name, authority: toolDraft.authority, safety: toolDraft.safety }) });
    setEditingTool(null);
    flash(`工具 ${name} 权限已更新`);
    refresh();
  };
  const resetToolOverride = async (name: string) => {
    await api('/api/authority/tool', { method: 'DELETE', body: JSON.stringify({ name }) });
    flash(`工具 ${name} 已恢复默认`);
    refresh();
  };

  if (loading && !data) {
    return <div className="page-content"><div className="empty-hint">加载中...</div></div>;
  }
  if (!data) {
    return <div className="page-content"><div className="empty-hint">获取权限数据失败</div></div>;
  }

  return (
    <div className="page-content page-authority">
      {message && <div className="toast">{message}</div>}

      {/* 概览 */}
      <div className="section-label">概览</div>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-icon">👤</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册用户</div>
            <div className="overview-card-value">{data.users.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">👑</div>
          <div className="overview-card-body">
            <div className="overview-card-label">Owner 数</div>
            <div className="overview-card-value">{data.owners.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">⌘</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册指令</div>
            <div className="overview-card-value">{data.commands.length}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">🔧</div>
          <div className="overview-card-body">
            <div className="overview-card-label">已注册工具</div>
            <div className="overview-card-value">{data.tools?.length ?? 0}</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="overview-card-icon">⚠️</div>
          <div className="overview-card-body">
            <div className="overview-card-label">高危白名单</div>
            <div className="overview-card-value">{data.dangerousPolicy?.allow?.length ?? 0}</div>
          </div>
        </div>
      </div>

      {/* 权限配置 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('config')}>
          <span className="config-block-title">权限配置</span>
          <span className="config-block-hint">控制新用户默认的权限等级及 Owner 的权限上限</span>
          <span className={`config-block-toggle ${openSections.has('config') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('config') && (
          <div className="config-block-body">
            {editConfig ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">defaultAuthority</label>
                  <input type="number" className="config-edit-input" min={0}
                    value={configDraft.defaultAuthority}
                    onChange={e => setConfigDraft(v => ({ ...v, defaultAuthority: parseInt(e.target.value) || 0 }))} />
                  <span className="config-edit-hint">新用户默认权限等级</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">ownerAuthority</label>
                  <input type="number" className="config-edit-input" min={1}
                    value={configDraft.ownerAuthority}
                    onChange={e => setConfigDraft(v => ({ ...v, ownerAuthority: parseInt(e.target.value) || 5 }))} />
                  <span className="config-edit-hint">Owner 用户权限等级</span>
                </div>
                <div className="config-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveConfig}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditConfig(false)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item">
                  <span className="key">defaultAuthority</span>
                  <span className="val">{data.defaultAuthority}</span>
                </div>
                <div className="config-item">
                  <span className="key">ownerAuthority</span>
                  <span className="val">{data.ownerAuthority}</span>
                </div>
                <div style={{ padding: '6px 0 2px' }}>
                  <button className="btn-sm" onClick={() => setEditConfig(true)}>编辑</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 指令权限 (internal-framework 风格) */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('commands')}>
          <span className="config-block-title">指令权限</span>
          <span className="config-block-hint">自定义每条指令的所需权限等级与安全等级，修改后优先于插件默认值</span>
          <span className={`config-block-toggle ${openSections.has('commands') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('commands') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            {data.commands.length === 0 ? (
              <div className="empty-hint" style={{ padding: 12 }}>暂无已注册指令</div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header">
                  <span>指令</span>
                  <span>来源</span>
                  <span>权限等级</span>
                  <span>安全等级</span>
                  <span>操作</span>
                </div>
                {data.commands.map(c => {
                  const isEditing = editingCmd === c.name;
                  return (
                    <div className={`authority-cmd-row ${c.overridden ? 'overridden' : ''}`} key={c.name}>
                      <span className="authority-cmd-name" title={c.description}>
                        {data.commandPrefix}{c.name}
                      </span>
                      <span className="authority-cmd-plugin">{c.pluginName}</span>
                      <span>
                        {isEditing ? (
                          <input type="number" className="config-edit-input authority-inline-input" min={0}
                            value={cmdDraft.authority}
                            onChange={e => setCmdDraft(v => ({ ...v, authority: parseInt(e.target.value) || 0 }))}
                            autoFocus />
                        ) : (
                          <span className={`authority-badge ${c.authority >= data.ownerAuthority ? 'owner' : c.authority >= 3 ? 'high' : ''}`}>
                            {c.authority}
                          </span>
                        )}
                      </span>
                      <span>
                        {isEditing ? (
                          <select className="config-edit-input authority-inline-select"
                            value={cmdDraft.safety}
                            onChange={e => setCmdDraft(v => ({ ...v, safety: e.target.value }))}>
                            <option value="safe">safe</option>
                            <option value="dangerous">dangerous</option>
                          </select>
                        ) : (
                          <span className={`authority-safety-tag ${c.safety}`}>{c.safety}</span>
                        )}
                      </span>
                      <span className="authority-actions">
                        {isEditing ? (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => saveCommandOverride(c.name)}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditingCmd(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => {
                              setEditingCmd(c.name);
                              setCmdDraft({ authority: c.authority, safety: c.safety });
                            }}>编辑</button>
                            {c.overridden && (
                              <button className="btn btn-sm" onClick={() => resetCommandOverride(c.name)} title="恢复插件默认值">重置</button>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 工具权限 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('tools')}>
          <span className="config-block-title">工具权限</span>
          <span className="config-block-hint">自定义每个 AI 工具的所需权限等级与安全等级，修改后优先于插件默认值</span>
          <span className={`config-block-toggle ${openSections.has('tools') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('tools') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            {!data.tools || data.tools.length === 0 ? (
              <div className="empty-hint" style={{ padding: 12 }}>暂无已注册工具</div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header">
                  <span>工具</span>
                  <span>来源</span>
                  <span>权限等级</span>
                  <span>安全等级</span>
                  <span>操作</span>
                </div>
                {data.tools.map(t => {
                  const isEditing = editingTool === t.name;
                  return (
                    <div className={`authority-cmd-row ${t.overridden ? 'overridden' : ''}`} key={t.name}>
                      <span className="authority-cmd-name" title={t.description}>
                        {t.name}
                      </span>
                      <span className="authority-cmd-plugin">{t.pluginName}</span>
                      <span>
                        {isEditing ? (
                          <input type="number" className="config-edit-input authority-inline-input" min={0}
                            value={toolDraft.authority}
                            onChange={e => setToolDraft(v => ({ ...v, authority: parseInt(e.target.value) || 0 }))}
                            autoFocus />
                        ) : (
                          <span className={`authority-badge ${t.authority >= data.ownerAuthority ? 'owner' : t.authority >= 3 ? 'high' : ''}`}>
                            {t.authority}
                          </span>
                        )}
                      </span>
                      <span>
                        {isEditing ? (
                          <select className="config-edit-input authority-inline-select"
                            value={toolDraft.safety}
                            onChange={e => setToolDraft(v => ({ ...v, safety: e.target.value }))}>
                            <option value="safe">safe</option>
                            <option value="dangerous">dangerous</option>
                          </select>
                        ) : (
                          <span className={`authority-safety-tag ${t.safety}`}>{t.safety}</span>
                        )}
                      </span>
                      <span className="authority-actions">
                        {isEditing ? (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => saveToolOverride(t.name)}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditingTool(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => {
                              setEditingTool(t.name);
                              setToolDraft({ authority: t.authority, safety: t.safety });
                            }}>编辑</button>
                            {t.overridden && (
                              <button className="btn btn-sm" onClick={() => resetToolOverride(t.name)} title="恢复插件默认值">重置</button>
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Owner 管理 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('owners')}>
          <span className="config-block-title">Owner 管理</span>
          <span className="config-block-hint">Owner 自动获得最高权限等级，WebUI 控制台始终为 Owner</span>
          <span className={`config-block-toggle ${openSections.has('owners') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('owners') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            <div style={{ padding: '8px 12px' }}>
              <button className="btn-sm" onClick={() => setShowAddOwner(!showAddOwner)}>
                {showAddOwner ? '取消' : '+ 添加 Owner'}
              </button>
            </div>
            {showAddOwner && (
              <div className="authority-add-form" style={{ padding: '0 12px 8px' }}>
                <input className="config-edit-input" placeholder="平台 (如 onebot)"
                  value={newOwner.platform} onChange={e => setNewOwner(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" placeholder="用户 ID"
                  value={newOwner.userId} onChange={e => setNewOwner(v => ({ ...v, userId: e.target.value }))} />
                <button className="btn btn-primary btn-sm" onClick={addOwner} disabled={!newOwner.platform || !newOwner.userId}>确认</button>
              </div>
            )}
            {data.owners.length === 0 ? (
              <div className="empty-hint" style={{ padding: '0 12px 12px' }}>
                暂无 Owner。WebUI 控制台用户始终拥有最高权限。
              </div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header authority-owner-header">
                  <span>平台</span>
                  <span>用户 ID</span>
                  <span>操作</span>
                </div>
                {data.owners.map((o, idx) => (
                  <div className="authority-cmd-row authority-owner-row" key={`${o.platform}:${o.userId}`}>
                    <span className="authority-cell-platform">{o.platform}</span>
                    <span className="authority-cell-id">{o.userId}</span>
                    <span>
                      <button className="btn btn-danger btn-sm" onClick={() => removeOwner(idx)}>移除</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 用户权限 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('users')}>
          <span className="config-block-title">用户权限</span>
          <span className="config-block-hint">已自定义权限的用户列表，未列出的用户使用 defaultAuthority</span>
          <span className={`config-block-toggle ${openSections.has('users') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('users') && (
          <div className="config-block-body" style={{ padding: 0 }}>
            <div style={{ padding: '8px 12px', display: 'flex', gap: 6 }}>
              <button className="btn-sm" onClick={() => setShowAddUser(!showAddUser)}>
                {showAddUser ? '取消' : '+ 添加用户'}
              </button>
              <button className="btn-sm" onClick={refresh} disabled={loading}>
                {loading ? '刷新中...' : '刷新'}
              </button>
            </div>
            {showAddUser && (
              <div className="authority-add-form" style={{ padding: '0 12px 8px' }}>
                <input className="config-edit-input" placeholder="平台 (如 onebot)"
                  value={newUser.platform} onChange={e => setNewUser(v => ({ ...v, platform: e.target.value }))} />
                <input className="config-edit-input" placeholder="用户 ID"
                  value={newUser.userId} onChange={e => setNewUser(v => ({ ...v, userId: e.target.value }))} />
                <input className="config-edit-input" type="number" placeholder="权限等级" min={0}
                  value={newUser.authority} onChange={e => setNewUser(v => ({ ...v, authority: parseInt(e.target.value) || 0 }))} />
                <button className="btn btn-primary btn-sm" onClick={addUser} disabled={!newUser.platform || !newUser.userId}>确认</button>
              </div>
            )}
            {data.users.length === 0 ? (
              <div className="empty-hint" style={{ padding: '0 12px 12px' }}>
                暂无已设置权限的用户。新用户将获得默认等级 {data.defaultAuthority}。
              </div>
            ) : (
              <div className="authority-cmd-list">
                <div className="authority-cmd-header authority-user-header">
                  <span>平台</span>
                  <span>用户 ID</span>
                  <span>权限等级</span>
                  <span>操作</span>
                </div>
                {data.users.map(u => {
                  const key = `${u.platform}:${u.userId}`;
                  const isEditing = editUser && editUser.platform === u.platform && editUser.userId === u.userId;
                  return (
                    <div className="authority-cmd-row authority-user-row" key={key}>
                      <span className="authority-cell-platform">{u.platform}</span>
                      <span className="authority-cell-id">{u.userId}</span>
                      <span>
                        {isEditing ? (
                          <input type="number" className="config-edit-input authority-inline-input" min={0}
                            value={editUser!.authority}
                            onChange={e => setEditUser(prev => prev ? { ...prev, authority: parseInt(e.target.value) || 0 } : null)}
                            autoFocus />
                        ) : (
                          <span className={`authority-badge ${u.authority >= data.ownerAuthority ? 'owner' : u.authority >= 3 ? 'high' : ''}`}>
                            {u.authority}
                          </span>
                        )}
                      </span>
                      <span className="authority-actions">
                        {isEditing ? (
                          <>
                            <button className="btn btn-primary btn-sm" onClick={() => saveUserAuthority(editUser!.platform, editUser!.userId, editUser!.authority)}>保存</button>
                            <button className="btn btn-sm" onClick={() => setEditUser(null)}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="btn btn-sm" onClick={() => setEditUser({ platform: u.platform, userId: u.userId, authority: u.authority })}>编辑</button>
                            <button className="btn btn-danger btn-sm" onClick={() => deleteUser(u.platform, u.userId)}>重置</button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 高危操作策略 */}
      <div className="config-block">
        <div className="config-block-header" onClick={() => toggleSection('dangerous')}>
          <span className="config-block-title">高危操作策略</span>
          <span className="config-block-hint">控制哪些危险指令/工具允许执行，未在白名单中的 dangerous 操作会被拒绝</span>
          <span className={`config-block-toggle ${openSections.has('dangerous') ? 'open' : ''}`}>▶</span>
        </div>
        {openSections.has('dangerous') && (
          <div className="config-block-body">
            {editDangerous ? (
              <div className="config-edit-form">
                <div className="config-edit-row">
                  <label className="config-edit-label">allow</label>
                  <input className="config-edit-input"
                    value={dangerousDraft.allow}
                    onChange={e => setDangerousDraft(v => ({ ...v, allow: e.target.value }))}
                    placeholder="shutdown, restart 或 *" />
                  <span className="config-edit-hint">逗号分隔，* 表示全部放行</span>
                </div>
                <div className="config-edit-row">
                  <label className="config-edit-label">duration</label>
                  <input type="number" className="config-edit-input" min={0}
                    value={dangerousDraft.duration}
                    onChange={e => setDangerousDraft(v => ({ ...v, duration: parseInt(e.target.value) || 0 }))} />
                  <span className="config-edit-hint">有效期 (秒)，0 = 永久</span>
                </div>
                <div className="config-edit-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveDangerous}>保存</button>
                  <button className="btn btn-sm" onClick={() => setEditDangerous(false)}>取消</button>
                </div>
              </div>
            ) : (
              <>
                <div className="config-item">
                  <span className="key">allow</span>
                  <span className="val">{(data.dangerousPolicy?.allow ?? []).join(', ') || '(无)'}</span>
                </div>
                <div className="config-item">
                  <span className="key">duration</span>
                  <span className="val">{data.dangerousPolicy?.duration ?? 0}s {data.dangerousPolicy?.duration === 0 ? '(永久)' : ''}</span>
                </div>
                <div style={{ padding: '6px 0 2px' }}>
                  <button className="btn-sm" onClick={() => setEditDangerous(true)}>编辑</button>
                </div>
              </>
            )}
          </div>
        )}
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
  const [activeTab, setActiveTab] = useState<PageTab>(() => {
    const hash = location.hash.replace('#', '');
    const valid: PageTab[] = ['dashboard', 'marketplace', 'plugin-config', 'platforms', 'authority', 'logs'];
    return valid.includes(hash as PageTab) ? (hash as PageTab) : 'dashboard';
  });

  useEffect(() => {
    location.hash = activeTab;
  }, [activeTab]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [servicesData, setServicesData] = useState<Record<string, ServiceInfo> | null>(null);
  const [chatWidth, setChatWidth] = useState(420);

  // 重启中状态
  const [restarting, setRestarting] = useState(false);

  const streamingRef = useRef(false);

  const handleIncoming = useCallback((content: string, reasoningContent?: string) => {
    // message:send 到达时，用完整内容更新最后一个文本段，保留所有 segments
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && streamingRef.current) {
        streamingRef.current = false;
        const segments = [...(last.segments ?? [])];
        // 更新最后一个 text segment 为最终完整内容
        const lastSeg = segments[segments.length - 1];
        if (lastSeg && lastSeg.type === 'text') {
          segments[segments.length - 1] = { type: 'text', content };
        } else {
          segments.push({ type: 'text', content });
        }
        // 保留流式阶段已构建好的 reasoningSegments（含 tool_call 结构），
        // 不用 message:send 的扁平合并文本覆盖
        const reasoningSegments = last.reasoningSegments;
        return [...prev.slice(0, -1), {
          ...last,
          content,
          reasoningContent: reasoningContent ?? last.reasoningContent,
          reasoningSegments: reasoningSegments ?? last.reasoningSegments,
          segments,
        }];
      }
      streamingRef.current = false;
      return [...prev, { role: 'assistant' as const, content, reasoningContent, segments: [{ type: 'text' as const, content }], timestamp: Date.now() }];
    });
    setLoading(false);
  }, []);

  const handleStream = useCallback((contentDelta?: string, reasoningDelta?: string, done?: boolean) => {
    if (done) {
      // 流结束标记 — 不做额外操作，等 message:send 带完整内容
      return;
    }

    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && streamingRef.current) {
        const updated = { ...last };
        if (reasoningDelta) {
          updated.reasoningContent = (updated.reasoningContent ?? '') + reasoningDelta;
          // 追加到 reasoningSegments
          const rSegs = [...(updated.reasoningSegments ?? [])];
          const lastRS = rSegs[rSegs.length - 1];
          if (lastRS && lastRS.type === 'text') {
            rSegs[rSegs.length - 1] = { type: 'text', content: lastRS.content + reasoningDelta };
          } else {
            rSegs.push({ type: 'text', content: reasoningDelta });
          }
          updated.reasoningSegments = rSegs;
        }
        if (contentDelta) {
          updated.content += contentDelta;
          const segments = [...(updated.segments ?? [])];
          const lastSeg = segments[segments.length - 1];
          if (lastSeg && lastSeg.type === 'text') {
            segments[segments.length - 1] = { type: 'text', content: lastSeg.content + contentDelta };
          } else {
            // 工具调用后的新文本段
            segments.push({ type: 'text', content: contentDelta });
          }
          updated.segments = segments;
        }
        return [...prev.slice(0, -1), updated];
      }
      // 创建新的助手消息
      streamingRef.current = true;
      return [...prev, {
        role: 'assistant' as const,
        content: contentDelta ?? '',
        reasoningContent: reasoningDelta,
        reasoningSegments: reasoningDelta ? [{ type: 'text' as const, content: reasoningDelta }] : [],
        segments: contentDelta ? [{ type: 'text' as const, content: contentDelta }] : [],
        timestamp: Date.now(),
      }];
    });
    setLoading(false);
  }, []);

  const handleLog = useCallback((entry: LogEntry) => {
    setLogs(prev => {
      const next = [...prev, entry];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const handleToolCall = useCallback((toolName: string, toolArgs: Record<string, unknown>, toolPhase: 'start' | 'end', toolResult?: string) => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (toolPhase === 'start') {
        if (last && last.role === 'assistant') {
          // 判断是否处于"思考"阶段：有 reasoning 但还没有内容文本
          const isThinking = !last.content && (last.reasoningContent || (!last.segments?.length));
          if (isThinking) {
            const rSegs = [...(last.reasoningSegments ?? [])];
            rSegs.push({ type: 'tool_call', name: toolName, args: toolArgs });
            return [...prev.slice(0, -1), { ...last, reasoningSegments: rSegs }];
          }
          const segments = [...(last.segments ?? [])];
          segments.push({ type: 'tool_call', name: toolName, args: toolArgs });
          return [...prev.slice(0, -1), { ...last, segments }];
        }
        streamingRef.current = true;
        return [...prev, {
          role: 'assistant' as const,
          content: '',
          reasoningSegments: [{ type: 'tool_call' as const, name: toolName, args: toolArgs }],
          timestamp: Date.now(),
        }];
      }
      // toolPhase === 'end'——填充结果，先查 reasoningSegments 再查 segments
      if (last && last.role === 'assistant') {
        if (last.reasoningSegments) {
          const rSegs = [...last.reasoningSegments];
          const idx = rSegs.findIndex(s => s.type === 'tool_call' && s.name === toolName && s.result == null);
          if (idx !== -1) {
            const seg = rSegs[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
            rSegs[idx] = { ...seg, result: toolResult };
            return [...prev.slice(0, -1), { ...last, reasoningSegments: rSegs }];
          }
        }
        if (last.segments) {
          const segments = [...last.segments];
          const idx = segments.findIndex(s => s.type === 'tool_call' && s.name === toolName && s.result == null);
          if (idx !== -1) {
            const seg = segments[idx] as Extract<ContentSegment, { type: 'tool_call' }>;
            segments[idx] = { ...seg, result: toolResult };
            return [...prev.slice(0, -1), { ...last, segments }];
          }
        }
      }
      return prev;
    });
  }, []);

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

  const handleStateChanged = useCallback(() => {
    refreshPlugins();
    refreshServices();
    api<SystemStatus>('/api/status').then(setStatus).catch(() => {});
  }, [refreshPlugins, refreshServices]);

  const handleRestarting = useCallback(() => {
    setRestarting(true);
  }, []);

  const { send, sendRaw, connected } = useWebSocket(handleIncoming, handleStream, handleLog, handleToolCall, handleStateChanged, handleRestarting);

  // 重启完成后自动刷新页面
  useEffect(() => {
    if (restarting && connected) {
      window.location.reload();
    }
  }, [restarting, connected]);

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
    { key: 'platforms', label: '平台接入', icon: <IconPlatform /> },
    { key: 'authority', label: '权限管理', icon: <IconAuthority /> },
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
          {activeTab === 'marketplace' && (
            <MarketplacePage plugins={plugins} onRefresh={refreshPlugins} />
          )}
          {activeTab === 'plugin-config' && (
            <PluginConfigPage
              plugins={plugins}
              config={config}
              onRefresh={refreshPlugins}
              onConfigSaved={refreshConfig}
              onRestart={() => setRestarting(true)}
            />
          )}
          {activeTab === 'platforms' && <PlatformPage />}
          {activeTab === 'authority' && <AuthorityPage />}
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

      {/* 重启中遮罩 */}
      {restarting && (
        <div className="restart-overlay">
          <div className="restart-dialog">
            <div className="restart-spinner" />
            <h3>正在重启…</h3>
            <p className="restart-desc">应用正在重新启动，请稍候</p>
          </div>
        </div>
      )}
    </div>
  );
}
