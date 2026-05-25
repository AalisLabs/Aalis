import { useState, useEffect, useCallback, useRef, type ReactElement, type CSSProperties } from 'react';
import { Puzzle, Clock, Globe, Brain, Wrench, Sparkles, BarChart2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api, pageAction } from '../api';
import { SchemaForm, type LLMProviderEntry } from './SchemaForm';
import { RelationGraph } from './RelationGraph';
import type {
  WebuiComponent, WebuiStatComponent, WebuiTableComponent,
  WebuiFormComponent, WebuiActionsComponent, WebuiInfoComponent,
  WebuiMarkdownComponent, WebuiTabsComponent, WebuiPageDef,
} from '../types';

const dynStatIconMap: Record<string, ReactElement> = {
  skills: <Puzzle size={18} />, scheduler: <Clock size={18} />, browser: <Globe size={18} />, memory: <Brain size={18} />,
  tools: <Wrench size={18} />, agent: <Sparkles size={18} />, default: <BarChart2 size={18} />,
};

function DynStat({ comp, pluginName, refreshTick }: { comp: WebuiStatComponent; pluginName: string; refreshTick: number }) {
  const [value, setValue] = useState<string | number>('—');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    pageAction<{ value: string | number }>(pluginName, comp.source)
      .then(r => { if (r) setValue(r.value); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pluginName, comp.source, refreshTick]);

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
    // 延迟刷新，让"执行中"显示片刻
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

/** 可展开/收起的长文本单元格：默认单行截断，点击展开完整内容（限高 80px） */
function ExpandableTextCell({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  return (
    <div className={`dyn-cell-expandable${expanded ? ' expanded' : ''}`}>
      <span className="dyn-cell-expandable-text">{text}</span>
      <button
        type="button"
        className="dyn-cell-expandable-toggle"
        onClick={() => setExpanded(v => !v)}
        title={expanded ? '收起' : '展开'}
      >
        {expanded ? '收起' : '展开'}
      </button>
    </div>
  );
}

function DynTable({ comp, pluginName, refreshTick }: { comp: WebuiTableComponent; pluginName: string; refreshTick: number }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState('');

  const fetchData = useCallback(() => {
    setLoading(true);
    pageAction<Record<string, unknown>[]>(pluginName, comp.source)
      .then(r => { if (Array.isArray(r)) setRows(r); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pluginName, comp.source]);

  useEffect(() => {
    fetchData();
    if (comp.refresh && comp.refresh > 0) {
      const timer = setInterval(fetchData, comp.refresh * 1000);
      return () => clearInterval(timer);
    }
  }, [fetchData, comp.refresh, refreshTick]);

  const handleAction = async (action: NonNullable<WebuiTableComponent['actions']>[number], row: Record<string, unknown>) => {
    if (action.confirm && !confirm(action.confirm)) return;
    const result = await pageAction<Record<string, unknown>>(pluginName, action.method, row);
    if (action.danger || action.confirm) {
      fetchData();
    } else if (result && typeof result === 'object' && !Array.isArray(result)) {
      setDetail(result);
    } else {
      fetchData();
    }
  };

  // 把列的宽度约束抽成一个 helper，header/body 共用，避免不同步。
  const colStyle = (col: WebuiTableComponent['columns'][number]): CSSProperties | undefined => {
    if (!col.minWidth && !col.maxWidth) return undefined;
    const s: CSSProperties = {};
    if (col.minWidth) s.minWidth = `${col.minWidth}px`;
    if (col.maxWidth) s.maxWidth = `${col.maxWidth}px`;
    return s;
  };

  // 本地文本搜索（searchable=true 时启用）：空格分隔多 token，AND 语义，
  // 对所有 column key 对应的字段值做不区分大小写子串匹配。不联网、不重拉，纯前端过滤。
  const filteredRows = (() => {
    if (!comp.searchable) return rows;
    const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return rows;
    return rows.filter(row => {
      const haystack = comp.columns.map(c => String(row[c.key] ?? '')).join(' ').toLowerCase();
      return tokens.every(t => haystack.includes(t));
    });
  })();

  return (
    <div className="dyn-table-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      {comp.searchable ? (
        <div style={{ marginBottom: 6 }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={comp.searchPlaceholder ?? '搜索（空格分隔多个关键词，AND 语义）'}
            style={{
              width: '100%',
              maxWidth: 360,
              padding: '4px 8px',
              fontSize: 12,
              border: '1px solid var(--border-color, #ddd)',
              borderRadius: 4,
              background: 'transparent',
              color: 'inherit',
            }}
          />
          {search ? (
            <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              {filteredRows.length}/{rows.length}
            </span>
          ) : null}
        </div>
      ) : null}
      {loading && rows.length === 0 ? (
        <div className="empty-hint">加载中...</div>
      ) : filteredRows.length === 0 ? (
        <div className="empty-hint">{search ? '无匹配' : '暂无数据'}</div>
      ) : (
        <div className="dyn-table-scroll">
        <table className="dyn-table">
          <thead>
            <tr>
              {comp.columns.map(col => (
                <th
                  key={col.key}
                  className={col.nowrap ? 'dyn-cell-nowrap' : undefined}
                  style={colStyle(col)}
                >
                  {col.label}
                </th>
              ))}
              {comp.actions && comp.actions.length > 0 && <th>操作</th>}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, i) => (
              <tr key={i}>
                {comp.columns.map(col => (
                  <td
                    key={col.key}
                    className={col.nowrap ? 'dyn-cell-nowrap' : undefined}
                    style={colStyle(col)}
                  >
                    {col.render === 'countdown'
                      ? <CountdownCell target={Number(row[col.key]) || 0} onZero={fetchData} />
                      : col.render === 'status-badge'
                        ? <span className={`dyn-badge dyn-badge-${String(row[col.key])}`}>{String(row[col.key] ?? '')}</span>
                        : col.render === 'code'
                          ? <code>{String(row[col.key] ?? '')}</code>
                          : col.render === 'expandable-text'
                            ? <ExpandableTextCell text={String(row[col.key] ?? '')} />
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
        </div>
      )}

      {detail && (
        <div className="dyn-detail-overlay" onClick={() => setDetail(null)}>
          <div className="dyn-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="dyn-detail-header">
              <span className="dyn-detail-title">{String(detail.name || detail.title || '详情')}</span>
              <button className="dyn-detail-close" onClick={() => setDetail(null)}>×</button>
            </div>
            <div className="dyn-detail-body">
              {Object.entries(detail).map(([k, v]) => {
                const val = v == null ? '' : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
                const isLong = val.length > 120 || val.includes('\n');
                return (
                  <div className="dyn-detail-field" key={k}>
                    <div className="dyn-detail-key">{k}</div>
                    {isLong
                      ? <pre className="dyn-detail-pre">{val}</pre>
                      : <div className="dyn-detail-val">{val}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
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
  const [llmProviders, setLLMProviders] = useState<LLMProviderEntry[] | undefined>(undefined);

  useEffect(() => {
    setLoading(true);
    pageAction<Record<string, unknown>>(pluginName, comp.source)
      .then(r => { if (r) setDraft(r); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pluginName, comp.source]);

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      await pageAction(pluginName, comp.save, draft);
      setMsg('已保存');
    } catch { setMsg('保存失败'); }
    setSaving(false);
  };

  const handleFetchModels = (service: string) => {
    api<{
      models: string[];
      providers?: Array<{ value: string; model: string; provider: string; contextId: string }>;
    }>(`/api/models/${service}`)
      .then(r => {
        const items = (r.providers && r.providers.length > 0)
          ? r.providers.map(p => ({ label: `${p.provider} / ${p.model}`, value: p.value }))
          : (r.models ?? []).map(m => ({ label: m, value: m }));
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

  const handleFetchLLMProviders = () => {
    if (llmProviders) return;
    api<{ providers: LLMProviderEntry[] }>('/api/llm-providers')
      .then(r => setLLMProviders(r.providers ?? []))
      .catch(() => setLLMProviders([]));
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
        llmProviders={llmProviders}
        onFetchLLMProviders={handleFetchLLMProviders}
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

function DynActions({ comp, pluginName, onRefresh }: { comp: WebuiActionsComponent; pluginName: string; onRefresh: () => void }) {
  const [actionMsg, setActionMsg] = useState<Record<string, string>>({});

  const handleClick = async (item: WebuiActionsComponent['items'][number]) => {
    if (item.confirm && !confirm(item.confirm)) return;
    setActionMsg(prev => ({ ...prev, [item.method]: '执行中...' }));
    try {
      await pageAction(pluginName, item.method);
      setActionMsg(prev => ({ ...prev, [item.method]: '完成' }));
      // 立即触发同页面其它组件刷新；不等待用户手动刷新
      onRefresh();
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

function DynInfo({ comp, pluginName, refreshTick }: { comp: WebuiInfoComponent; pluginName: string; refreshTick: number }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    pageAction<Record<string, unknown>>(pluginName, comp.source)
      .then(r => { if (r) setData(r); })
      .catch(() => {});
  }, [pluginName, comp.source, refreshTick]);

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

function DynMarkdown({ comp, pluginName, refreshTick }: { comp: WebuiMarkdownComponent; pluginName: string; refreshTick: number }) {
  const [content, setContent] = useState('');

  useEffect(() => {
    pageAction<{ content: string }>(pluginName, comp.source)
      .then(r => { if (r) setContent(r.content); })
      .catch(() => {});
  }, [pluginName, comp.source, refreshTick]);

  return (
    <div className="dyn-markdown-block">
      {comp.label && <h3 className="dyn-section-title">{comp.label}</h3>}
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight as never]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function DynTabs({ comp, pluginName, refreshTick, onRefresh }: { comp: WebuiTabsComponent; pluginName: string; refreshTick: number; onRefresh: () => void }) {
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
          <DynamicComponent key={i} component={c} pluginName={pluginName} refreshTick={refreshTick} onRefresh={onRefresh} />
        ))}
      </div>
    </div>
  );
}

function DynamicComponent({ component, pluginName, refreshTick, onRefresh }: { component: WebuiComponent; pluginName: string; refreshTick: number; onRefresh: () => void }) {
  switch (component.type) {
    case 'stat': return <DynStat comp={component} pluginName={pluginName} refreshTick={refreshTick} />;
    case 'table': return <DynTable comp={component} pluginName={pluginName} refreshTick={refreshTick} />;
    case 'form': return <DynForm comp={component} pluginName={pluginName} />;
    case 'actions': return <DynActions comp={component} pluginName={pluginName} onRefresh={onRefresh} />;
    case 'info': return <DynInfo comp={component} pluginName={pluginName} refreshTick={refreshTick} />;
    case 'markdown': return <DynMarkdown comp={component} pluginName={pluginName} refreshTick={refreshTick} />;
    case 'tabs': return <DynTabs comp={component} pluginName={pluginName} refreshTick={refreshTick} onRefresh={onRefresh} />;
    case 'graph': return <RelationGraph comp={component} pluginName={pluginName} refreshTick={refreshTick} onRefresh={onRefresh} />;
    default: return null;
  }
}

export function DynamicPage({ page }: { page: WebuiPageDef }) {
  const [refreshTick, setRefreshTick] = useState(0);
  const bump = useCallback(() => setRefreshTick(t => t + 1), []);

  // 监听 WS 推送：当某插件后端发生需要前端同步的事件（如 /doctor 命令完成后 plugin-doctor 广播）
  // 自动 bump 当前页（如 pluginName 匹配或缺省）。其它页面不显示故无副作用。
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ pluginName?: string }>).detail;
      if (!detail.pluginName || detail.pluginName === page.plugin) bump();
    };
    window.addEventListener('aalis:page-refresh', handler as EventListener);
    return () => window.removeEventListener('aalis:page-refresh', handler as EventListener);
  }, [page.plugin, bump]);

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

  // 含关系图（或其他 graph）的页面：上半固定（stats + graph），下半 tabs 独立滚动，
  // 避免滚动数据列表时把图也带着滚出视野。
  const hasGraph = groups.some(g => g.type === 'component' && g.item.type === 'graph');

  return (
    <div className={`page-content dynamic-page${hasGraph ? ' has-graph' : ''}`}>
      {groups.map((g, i) => {
        const isTabsBelowGraph =
          hasGraph && g.type === 'component' && g.item.type === 'tabs';
        if (g.type === 'stat-grid') {
          return (
            <div className="dyn-stat-grid" key={i}>
              {g.items.map((comp, j) => (
                <DynStat key={j} comp={comp} pluginName={page.plugin} refreshTick={refreshTick} />
              ))}
            </div>
          );
        }
        return (
          <div
            key={i}
            className={isTabsBelowGraph ? 'dyn-scroll-region' : undefined}
          >
            <DynamicComponent component={g.item} pluginName={page.plugin} refreshTick={refreshTick} onRefresh={bump} />
          </div>
        );
      })}
    </div>
  );
}
