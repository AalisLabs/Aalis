import { useState, useEffect, useCallback, useRef, type ReactElement } from 'react';
import { Puzzle, Clock, Globe, Brain, Wrench, Sparkles, BarChart2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api, pageAction } from '../api';
import { SchemaForm } from './SchemaForm';
import type {
  ConfigSchema,
  WebuiComponent, WebuiStatComponent, WebuiTableComponent,
  WebuiFormComponent, WebuiActionsComponent, WebuiInfoComponent,
  WebuiMarkdownComponent, WebuiTabsComponent, WebuiIframeComponent, WebuiPageDef,
} from '../types';

const dynStatIconMap: Record<string, ReactElement> = {
  skills: <Puzzle size={18} />, scheduler: <Clock size={18} />, browser: <Globe size={18} />, memory: <Brain size={18} />,
  tools: <Wrench size={18} />, agent: <Sparkles size={18} />, default: <BarChart2 size={18} />,
};

function DynStat({ comp, pluginName }: { comp: WebuiStatComponent; pluginName: string }) {
  const [value, setValue] = useState<string | number>('—');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    pageAction<{ ok: boolean; data: { value: string | number } }>(pluginName, comp.source)
      .then(r => { if (r.ok && r.data) setValue(r.data.value); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pluginName, comp.source]);

  const icon = dynStatIconMap[comp.icon ?? ''] ?? dynStatIconMap.default;

  return (
    <div className="dyn-stat-card">
      <div className="dyn-stat-icon">{icon}</div>
      <div className="dyn-stat-body">
        <div className="dyn-stat-label">{comp.label}</div>
        <div className="dyn-stat-value">{loading ? '...' : value}</div>
      </div>
    </div>
  );
}

/** 倒计时单元格：每秒更新，归零时显示提示并触发刷新 */
function CountdownCell({ target, onZero }: { target: number; onZero?: () => void }) {
  const [now, setNow] = useState(Date.now());
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target]);

  if (!target || target <= 0) return <span>-</span>;

  const diff = Math.max(0, Math.round((target - now) / 1000));

  if (diff === 0 && !firedRef.current) {
    firedRef.current = true;
    if (onZero) setTimeout(onZero, 3000);
    return <span className="countdown-fired">⏳ 执行中</span>;
  }
  if (diff === 0) return <span className="countdown-fired">⏳ 执行中</span>;

  let text: string;
  if (diff < 60) {
    text = `${diff}秒`;
  } else if (diff < 3600) {
    const m = Math.floor(diff / 60);
    const s = diff % 60;
    text = s > 0 ? `${m}分${s}秒` : `${m}分`;
  } else {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    text = m > 0 ? `${h}时${m}分` : `${h}时`;
  }
  return <span className={diff <= 5 ? 'countdown-imminent' : ''}>{text}</span>;
}

function DynTable({ comp, pluginName }: { comp: WebuiTableComponent; pluginName: string }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(() => {
    setLoading(true);
    pageAction<{ ok: boolean; data: Record<string, unknown>[] }>(pluginName, comp.source)
      .then(r => { if (r.ok && Array.isArray(r.data)) setRows(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pluginName, comp.source]);

  useEffect(() => {
    fetchData();
    if (comp.refresh && comp.refresh > 0) {
      const timer = setInterval(fetchData, comp.refresh * 1000);
      return () => clearInterval(timer);
    }
  }, [fetchData, comp.refresh]);

  const handleAction = async (action: NonNullable<WebuiTableComponent['actions']>[number], row: Record<string, unknown>) => {
    if (action.confirm && !confirm(action.confirm)) return;
    await pageAction(pluginName, action.method, row);
    fetchData();
  };

  return (
    <div className="dyn-table-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      {loading && rows.length === 0 ? (
        <div className="empty-hint">加载中...</div>
      ) : rows.length === 0 ? (
        <div className="empty-hint">暂无数据</div>
      ) : (
        <table className="dyn-table">
          <thead>
            <tr>
              {comp.columns.map(col => <th key={col.key}>{col.label}</th>)}
              {comp.actions && comp.actions.length > 0 && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {comp.columns.map(col => (
                  <td key={col.key}>
                    {col.render === 'countdown'
                      ? <CountdownCell target={Number(row[col.key]) || 0} onZero={fetchData} />
                      : col.render === 'status-badge'
                        ? <span className={`dyn-badge dyn-badge-${String(row[col.key])}`}>{String(row[col.key] ?? '')}</span>
                        : col.render === 'code'
                          ? <code>{String(row[col.key] ?? '')}</code>
                          : String(row[col.key] ?? '')}
                  </td>
                ))}
                {comp.actions && comp.actions.length > 0 && (
                  <td className="dyn-table-actions">
                    {comp.actions.map((act, ai) => (
                      <button
                        key={ai}
                        className={`btn btn-sm${act.danger ? ' btn-danger' : ''}`}
                        onClick={() => handleAction(act, row)}
                      >
                        {act.label}
                      </button>
                    ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DynForm({ comp, pluginName }: { comp: WebuiFormComponent; pluginName: string }) {
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const modelCache = useRef<Record<string, Array<{ label: string; value: string }>>>({});
  const providerCacheRef = useRef<Record<string, Array<{ contextId: string; displayName?: string }>>>({});

  useEffect(() => {
    setLoading(true);
    pageAction<{ ok: boolean; data: Record<string, unknown> }>(pluginName, comp.source)
      .then(r => { if (r.ok && r.data) setDraft(r.data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pluginName, comp.source]);

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const r = await pageAction<{ ok: boolean; error?: string }>(pluginName, comp.save, draft);
      setMsg(r.ok ? '已保存' : (r.error ?? '保存失败'));
    } catch { setMsg('保存失败'); }
    setSaving(false);
  };

  const handleFetchModels = (service: string) => {
    api<{ models: string[]; providers?: Array<{ model: string; provider: string }> }>(`/api/models/${service}`)
      .then(r => {
        const provMap = new Map<string, string>();
        for (const p of r.providers ?? []) provMap.set(p.model, p.provider);
        const items = (r.models ?? []).map(m => ({
          label: provMap.has(m) ? `${provMap.get(m)} / ${m}` : m,
          value: m,
        }));
        modelCache.current = { ...modelCache.current, [service]: items };
      })
      .catch(() => {});
  };

  const handleFetchProviders = (service: string) => {
    api<{ services: Record<string, { providers: Array<{ contextId: string; displayName?: string }> }> }>('/api/services')
      .then(r => {
        const svc = r.services?.[service];
        providerCacheRef.current = { ...providerCacheRef.current, [service]: svc?.providers ?? [] };
      })
      .catch(() => {});
  };

  if (loading) return <div className="empty-hint">加载中...</div>;

  return (
    <div className="dyn-form-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      <SchemaForm
        schema={comp.schema}
        draft={draft}
        onChange={setDraft}
        modelCache={modelCache.current}
        onFetchModels={handleFetchModels}
        providerCache={providerCacheRef.current}
        onFetchProviders={handleFetchProviders}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button className="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </button>
        {msg && <span style={{ fontSize: 13, color: msg === '已保存' ? '#22c55e' : '#ef4444' }}>{msg}</span>}
      </div>
    </div>
  );
}

function DynActions({ comp, pluginName }: { comp: WebuiActionsComponent; pluginName: string }) {
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});

  const handleClick = async (item: WebuiActionsComponent['items'][number]) => {
    if (item.confirm && !confirm(item.confirm)) return;
    setActionMsg(prev => ({ ...prev, [item.method]: '执行中...' }));
    try {
      const r = await pageAction<{ ok: boolean; error?: string }>(pluginName, item.method);
      setActionMsg(prev => ({ ...prev, [item.method]: r.ok ? '完成' : (r.error ?? '失败') }));
    } catch {
      setActionMsg(prev => ({ ...prev, [item.method]: '失败' }));
    }
  };

  return (
    <div className="dyn-actions-block">
      {comp.label && <div className="dyn-section-title">{comp.label}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {comp.items.map((item, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <button
              className={`btn btn-sm${item.danger ? ' btn-danger' : item.variant === 'primary' ? ' btn-primary' : ''}`}
              onClick={() => handleClick(item)}
            >
              {item.label}
            </button>
            {actionMsg[item.method] && (
              <span className="dyn-action-msg">{actionMsg[item.method]}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function DynInfo({ comp, pluginName }: { comp: WebuiInfoComponent; pluginName: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    pageAction<{ ok: boolean; data: Record<string, unknown> }>(pluginName, comp.source)
      .then(r => { if (r.ok && r.data) setData(r.data); })
      .catch(() => {});
  }, [pluginName, comp.source]);

  return (
    <div className="dyn-info-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      {data ? (
        <div className="dyn-info-grid">
          {Object.entries(data).map(([k, v]) => (
            <div className="dyn-info-item" key={k}>
              <span className="dyn-info-key">{k}</span>
              <span className="dyn-info-val">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-hint">加载中...</div>
      )}
    </div>
  );
}

function DynMarkdown({ comp, pluginName }: { comp: WebuiMarkdownComponent; pluginName: string }) {
  const [content, setContent] = useState('');

  useEffect(() => {
    pageAction<{ ok: boolean; data: { content: string } }>(pluginName, comp.source)
      .then(r => { if (r.ok && r.data) setContent(r.data.content); })
      .catch(() => {});
  }, [pluginName, comp.source]);

  return (
    <div className="dyn-markdown-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight as never]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function DynTabs({ comp, pluginName }: { comp: WebuiTabsComponent; pluginName: string }) {
  const [activeKey, setActiveKey] = useState(comp.items[0]?.key ?? '');
  const activeItem = comp.items.find(i => i.key === activeKey);

  return (
    <div className="dyn-tabs-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      <div className="dyn-tabs-header">
        {comp.items.map(item => (
          <button
            key={item.key}
            className={`dyn-tab-btn${activeKey === item.key ? ' active' : ''}`}
            onClick={() => setActiveKey(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="dyn-tabs-body">
        {activeItem && activeItem.content.map((c, i) => (
          <DynamicComponent key={i} component={c} pluginName={pluginName} />
        ))}
      </div>
    </div>
  );
}

function DynIframe({ comp, pluginName }: { comp: WebuiIframeComponent; pluginName: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const source = comp.source;
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('/')) {
      setSrc(source);
    } else {
      pageAction<{ ok: boolean; data: { html: string } }>(pluginName, source)
        .then(r => { if (r.ok && r.data?.html) setHtml(r.data.html); })
        .catch(() => {});
    }
  }, [pluginName, comp.source]);

  const height = comp.height ?? '100%';

  return (
    <div className="dyn-iframe-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      {src ? (
        <iframe src={src} style={{ width: '100%', height, border: 'none' }} sandbox="allow-scripts allow-same-origin" />
      ) : html ? (
        <iframe srcDoc={html} style={{ width: '100%', height, border: 'none' }} sandbox="allow-scripts" />
      ) : (
        <div className="empty-hint">加载中...</div>
      )}
    </div>
  );
}

function DynamicComponent({ component, pluginName }: { component: WebuiComponent; pluginName: string }) {
  switch (component.type) {
    case 'stat': return <DynStat comp={component} pluginName={pluginName} />;
    case 'table': return <DynTable comp={component} pluginName={pluginName} />;
    case 'form': return <DynForm comp={component} pluginName={pluginName} />;
    case 'actions': return <DynActions comp={component} pluginName={pluginName} />;
    case 'info': return <DynInfo comp={component} pluginName={pluginName} />;
    case 'markdown': return <DynMarkdown comp={component} pluginName={pluginName} />;
    case 'tabs': return <DynTabs comp={component} pluginName={pluginName} />;
    case 'iframe': return <DynIframe comp={component} pluginName={pluginName} />;
    default: return null;
  }
}

export function DynamicPage({ page }: { page: WebuiPageDef }) {
  if (!page.content || page.content.length === 0) {
    return <div className="empty-hint" style={{ padding: 24 }}>此页面未提供内容</div>;
  }

  const groups: Array<{ type: 'stat-grid'; items: WebuiStatComponent[] } | { type: 'component'; item: WebuiComponent }> = [];
  for (const comp of page.content) {
    if (comp.type === 'stat') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'stat-grid') {
        last.items.push(comp);
      } else {
        groups.push({ type: 'stat-grid', items: [comp] });
      }
    } else {
      groups.push({ type: 'component', item: comp });
    }
  }

  return (
    <div className="page-content dynamic-page">
      {groups.map((g, i) =>
        g.type === 'stat-grid' ? (
          <div className="dyn-stat-grid" key={i}>
            {g.items.map((comp, j) => (
              <DynStat key={j} comp={comp} pluginName={page.plugin} />
            ))}
          </div>
        ) : (
          <DynamicComponent key={i} component={g.item} pluginName={page.plugin} />
        )
      )}
    </div>
  );
}
