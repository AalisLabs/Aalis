import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, Radio, Workflow, Link2, Loader2 } from 'lucide-react';
import { api } from '../api';
import { SchemaForm, buildDraftFromSchema, flattenConfig, unflattenConfig, type LLMProviderEntry } from '../components/SchemaForm';
import { ConfigValue } from '../components/ConfigValue';
import type { PluginInfo, ConfigSchema, SchemaField, ServiceInfo } from '../types';

export function PluginConfigPage({
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
  const [busySet, setBusySet] = useState<Set<string>>(new Set());
  const prevPluginsRef = useRef(plugins);
  const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<Record<string, string>>({});
  const [schemaDraft, setSchemaDraft] = useState<Record<string, unknown>>({});
  const [modelCache, setModelCache] = useState<Record<string, Array<{ label: string; value: string }>>>({});
  const [providerCache, setProviderCache] = useState<Record<string, Array<{ contextId: string; displayName?: string }>>>({});
  const [llmProviders, setLLMProviders] = useState<LLMProviderEntry[] | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [pluginSearch, setPluginSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [newInstanceTarget, setNewInstanceTarget] = useState<string | null>(null);
  const [newInstanceSuffix, setNewInstanceSuffix] = useState('');

  // 当插件列表更新（state_changed WS 事件触发 refreshPlugins）时，自动清除 busy 状态
  useEffect(() => {
    if (prevPluginsRef.current !== plugins && busySet.size > 0) {
      setBusySet(new Set());
    }
    prevPluginsRef.current = plugins;
  }, [plugins, busySet]);

  const markBusy = (id: string) => setBusySet(prev => new Set(prev).add(id));
  const isBusy = (id: string) => busySet.has(id);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleToggle = async (plugin: PluginInfo) => {
    if (plugin.core) return;
    markBusy(plugin.instanceId);
    const action = plugin.state === 'disabled' ? 'enable' : 'disable';
    const res = await api<{ ok?: boolean; error?: string }>(
      `/api/plugins/${encodeURIComponent(plugin.instanceId)}/${action}`,
      { method: 'POST' },
    );
    if (res.ok) {
      showToast(`${plugin.instanceId} 已${action === 'enable' ? '启用' : '禁用'}`);
      onRefresh();
    } else {
      showToast(res.error ?? '未知错误');
      setBusySet(prev => { const next = new Set(prev); next.delete(plugin.instanceId); return next; });
    }
  };

  const startEdit = (plugin: PluginInfo) => {
    const config = (plugin.config ?? {}) as Record<string, unknown>;
    if (plugin.configSchema) {
      setSchemaDraft(buildDraftFromSchema(plugin.configSchema, config));
    } else {
      setEditBuffer(flattenConfig(config));
    }
    setEditingPlugin(plugin.instanceId);
  };

  const fetchModels = useCallback(async (service: string) => {
    if (modelCache[service]) return;
    try {
      const res = await api<{
        models: string[];
        providers?: Array<{ value: string; model: string; provider: string; contextId: string }>;
      }>(`/api/models/${encodeURIComponent(service)}`);
      // 优先从 providers 构造（含复合 value 与 "provider / model" label）；
      // 未提供 providers 的服务回退到 plain models 列表。
      const items = (res.providers && res.providers.length > 0)
        ? res.providers.map(p => ({ label: `${p.provider} / ${p.model}`, value: p.value }))
        : (res.models ?? []).map(m => ({ label: m, value: m }));
      setModelCache(prev => ({ ...prev, [service]: items }));
    } catch {
      setModelCache(prev => ({ ...prev, [service]: [] }));
    }
  }, [modelCache]);

  const fetchProviders = useCallback(async (service: string) => {
    if (providerCache[service]) return;
    try {
      const res = await api<{ services: Record<string, ServiceInfo> }>('/api/services');
      const svc = res.services?.[service];
      setProviderCache(prev => ({
        ...prev,
        [service]: svc?.providers?.map(p => ({ contextId: p.contextId, displayName: p.displayName })) ?? [],
      }));
    } catch {
      setProviderCache(prev => ({ ...prev, [service]: [] }));
    }
  }, [providerCache]);

  const fetchLLMProviders = useCallback(async () => {
    if (llmProviders) return;
    try {
      const res = await api<{ providers: LLMProviderEntry[] }>('/api/llm-providers');
      setLLMProviders(res.providers ?? []);
    } catch {
      setLLMProviders([]);
    }
  }, [llmProviders]);

  const restoreDefaults = (plugin: PluginInfo) => {
    const defaults = plugin.defaultConfig ?? {};
    if (plugin.configSchema) {
      setSchemaDraft(buildDraftFromSchema(plugin.configSchema, defaults));
    } else {
      setEditBuffer(flattenConfig(defaults));
    }
  };

  const savePluginConfig = async (instanceId: string, hasSchema: boolean) => {
    const parsed = hasSchema ? schemaDraft : unflattenConfig(editBuffer);
    markBusy(instanceId);
    await api(`/api/plugins/${encodeURIComponent(instanceId)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config: parsed }),
    });
    showToast(`${instanceId} 配置已更新，正在重载…`);
    setEditingPlugin(null);
    onRefresh();
  };

  const handleCreateInstance = async (moduleName: string) => {
    const suffix = newInstanceSuffix.trim();
    if (!suffix) return;
    markBusy(moduleName);
    const res = await api<{ ok?: boolean; instanceId?: string; error?: string }>(
      `/api/plugins/${encodeURIComponent(moduleName)}/instances`,
      { method: 'POST', body: JSON.stringify({ suffix }) },
    );
    if (res.ok) {
      showToast(`已创建实例 ${res.instanceId}`);
      setNewInstanceTarget(null);
      setNewInstanceSuffix('');
      onRefresh();
    } else {
      showToast(res.error ?? '创建失败');
      setBusySet(prev => { const next = new Set(prev); next.delete(moduleName); return next; });
    }
  };

  const handleRemoveInstance = async (instanceId: string) => {
    if (!confirm(`确定删除实例 "${instanceId}"？配置将一并移除。`)) return;
    markBusy(instanceId);
    const res = await api<{ ok?: boolean; error?: string }>(
      `/api/plugins/${encodeURIComponent(instanceId)}/instance`,
      { method: 'DELETE' },
    );
    if (res.ok) {
      showToast(`已删除实例 ${instanceId}`);
      onRefresh();
    } else {
      showToast(res.error ?? '删除失败');
      setBusySet(prev => { const next = new Set(prev); next.delete(instanceId); return next; });
    }
  };

  /** 判断是否为多实例的子实例（instanceId 含冒号后缀） */
  const isSubInstance = (p: PluginInfo) => p.instanceId !== p.name;

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

  const coreSchema: ConfigSchema | undefined = config && (config as Record<string, unknown>)._schema
    ? (config as Record<string, unknown>)._schema as ConfigSchema
    : undefined;

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
                providerCache={providerCache}
                onFetchProviders={fetchProviders}
                llmProviders={llmProviders}
                onFetchLLMProviders={fetchLLMProviders}
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
      <div className="section-label" style={{ marginBottom: 0 }}>插件管理</div>
      <div className="plugin-search-row">
        <input
          className="plugin-search-input"
          placeholder="搜索插件..."
          value={pluginSearch}
          onChange={e => setPluginSearch(e.target.value)}
        />
        {pluginSearch && (
          <button className="plugin-search-clear" onClick={() => setPluginSearch('')}>✕</button>
        )}
      </div>
      {plugins.length === 0 && <div className="empty-hint">无插件</div>}
      {(() => {
        const q = pluginSearch.toLowerCase();
        const filtered = q
          ? plugins.filter(p =>
              p.name.toLowerCase().includes(q) ||
              p.instanceId.toLowerCase().includes(q) ||
              (p.displayName && p.displayName.toLowerCase().includes(q)) ||
              p.provides.some(s => s.toLowerCase().includes(q)))
          : plugins;

        const categoryMap: Record<string, string> = {};
        const categoryOrder = [
          '系统', 'LLM 模型', '智能体', '存储', '嵌入模型',
          '向量存储', '工具', '界面', '适配器', '自动化', '其他',
        ];
        for (const p of filtered) {
          const n = p.name; // 用模块名分类，而非 instanceId
          const cat =
            p.core ? '系统'
            : /^(@aalis\/)?plugin-(openai|deepseek|ollama)$/.test(n) ? 'LLM 模型'
            : /^(@aalis\/)?plugin-agent/.test(n) || /^(@aalis\/)?plugin-persona$/.test(n) ? '智能体'
            : /^(@aalis\/)?plugin-memory-/.test(n) ? '存储'
            : /^(@aalis\/)?plugin-embedding-/.test(n) ? '嵌入模型'
            : /^(@aalis\/)?plugin-vectorstore-/.test(n) ? '向量存储'
            : /^(@aalis\/)?plugin-(tool-|tools-|websearch-)/.test(n) ? '工具'
            : /^(@aalis\/)?plugin-(webui-|cli)/.test(n) ? '界面'
            : /^(@aalis\/)?plugin-adapter-/.test(n) ? '适配器'
            : /^(@aalis\/)?plugin-(scheduler|skills)$/.test(n) ? '自动化'
            : /^(@aalis\/)?plugin-(commands|authority)$/.test(n) ? '系统'
            : '其他';
          categoryMap[p.instanceId] = cat;
        }

        const grouped = new Map<string, PluginInfo[]>();
        for (const cat of categoryOrder) grouped.set(cat, []);
        for (const p of filtered) {
          const cat = categoryMap[p.instanceId] || '其他';
          grouped.get(cat)!.push(p);
        }

        const toggleCategory = (cat: string) => {
          setCollapsedCategories(prev => {
            const next = new Set(prev);
            next.has(cat) ? next.delete(cat) : next.add(cat);
            return next;
          });
        };

        return Array.from(grouped.entries())
          .filter(([, items]) => items.length > 0)
          .map(([cat, items]) => {
            const isCollapsed = collapsedCategories.has(cat);
            return (
              <div className="plugin-category" key={cat}>
                <div className="plugin-category-header" onClick={() => toggleCategory(cat)}>
                  <span className={`config-block-toggle ${!isCollapsed ? 'open' : ''}`}>▶</span>
                  <span className="plugin-category-name">{cat}</span>
                  <span className="plugin-category-count">{items.length}</span>
                </div>
                {!isCollapsed && items.map(p => {
        const iid = p.instanceId;
        const isEditing = editingPlugin === iid;
        const isOpen = openSections.has(iid);
        const isSub = isSubInstance(p);
        const suffix = isSub ? iid.slice(p.name.length + 1) : undefined;
        const hasExtends = p.extends && (p.extends.events?.length || p.extends.hooks?.length || p.extends.mixins && Object.keys(p.extends.mixins).length);
        const hasDetail = hasExtends || (p.config && Object.keys(p.config).length > 0) || !!p.configSchema;
        const hasSchema = !!p.configSchema;
        return (
          <div className={`plugin-card ${p.state === 'disabled' ? 'disabled' : ''} ${p.state === 'error' ? 'errored' : ''}`} key={iid} style={{ position: 'relative' }}>
            {isBusy(iid) && (
              <div className="plugin-reload-overlay">
                <Loader2 size={20} className="plugin-reload-spinner" />
                <span>重载中…</span>
              </div>
            )}
            <div className="plugin-card-header">
              <div className="plugin-card-info" style={{ cursor: hasDetail ? 'pointer' : 'default' }} onClick={() => hasDetail && toggleSection(iid)}>
                {hasDetail && <span className={`config-block-toggle ${isOpen ? 'open' : ''}`}>▶</span>}
                <span className="plugin-card-name">
                  {p.displayName ?? p.name}
                  {p.displayName && <span className="plugin-card-module-name">{p.name}</span>}
                  {suffix && <span className="plugin-instance-suffix">:{suffix}</span>}
                </span>
                <span className={`badge ${stateBadge[p.state] ?? 'pending'}`}>
                  {stateLabel[p.state] ?? p.state}
                </span>
                {p.core && <span className="badge core-badge">核心</span>}
                {p.reusable && !isSub && <span className="badge" style={{ background: '#7c5cfc', color: '#fff', fontSize: 10 }}>多实例</span>}
                {p.provides.length > 0 && (
                  <span className="plugin-provides-inline">
                    {p.provides.map(s => <span className="provides-chip" key={s}>{s}</span>)}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isSub && (
                  <button className="btn btn-sm" style={{ color: '#e55', fontSize: 11 }} onClick={() => handleRemoveInstance(iid)} disabled={isBusy(iid)}>删除</button>
                )}
                {p.reusable && !isSub && (
                  <button className="btn btn-sm" style={{ fontSize: 11 }} onClick={() => { setNewInstanceTarget(newInstanceTarget === p.name ? null : p.name); setNewInstanceSuffix(''); }}>+ 实例</button>
                )}
                <label className={`toggle-switch ${p.core ? 'core-locked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={p.state !== 'disabled'}
                    onChange={() => handleToggle(p)}
                    disabled={p.core || isBusy(iid)}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>

            {/* 新建实例输入行 */}
            {newInstanceTarget === p.name && !isSub && (
              <div className="plugin-new-instance-row" style={{ display: 'flex', gap: 6, padding: '6px 12px', alignItems: 'center' }}>
                <span style={{ fontSize: 12, opacity: .7 }}>{p.name}:</span>
                <input
                  style={{ flex: 1, fontSize: 12 }}
                  className="plugin-search-input"
                  placeholder="输入实例后缀（如 vision）"
                  value={newInstanceSuffix}
                  onChange={e => setNewInstanceSuffix(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateInstance(p.name)}
                />
                <button className="btn btn-primary btn-sm" onClick={() => handleCreateInstance(p.name)} disabled={!newInstanceSuffix.trim() || isBusy(p.name)}>创建</button>
                <button className="btn btn-sm" onClick={() => setNewInstanceTarget(null)}>取消</button>
              </div>
            )}

            {p.state === 'error' && p.error && (
              <div className="plugin-error-msg"><AlertTriangle size={14} /> {p.error}</div>
            )}

            {isOpen && p.provides.length > 0 && (
              <div className="plugin-card-provides">
                {p.provides.map(s => <span className="tool-chip" key={s}>{s}</span>)}
              </div>
            )}

            {isOpen && hasExtends && (
              <div className="plugin-card-extends">
                <span className="extends-label">扩展 Core:</span>
                {p.extends!.events?.map(e => <span className="extends-chip event" key={`e-${e}`}><Radio size={12} /> {e}</span>)}
                {p.extends!.hooks?.map(h => <span className="extends-chip hook" key={`h-${h}`}><Workflow size={12} /> {h}</span>)}
                {p.extends!.mixins && Object.entries(p.extends!.mixins).map(([svc, methods]) =>
                  methods.map(m => <span className="extends-chip mixin" key={`m-${svc}-${m}`}><Link2 size={12} /> ctx.{m}()</span>)
                )}
              </div>
            )}

            {isOpen && (p.config && Object.keys(p.config).length > 0 || hasSchema) && (
              <div className="plugin-card-config">
                {!isEditing ? (
                  <>
                    <div className="config-block-body" style={{ paddingTop: 6 }}>
                      {(hasSchema
                        ? Object.keys(p.configSchema!).map(k => [k, p.config[k]] as const)
                        : Object.entries(p.config)
                      ).map(([k, v]) => {
                        const schemaEntry = p.configSchema?.[k];
                        const isSecret = schemaEntry && 'secret' in schemaEntry ? (schemaEntry as SchemaField).secret : undefined;
                        const fieldDesc = schemaEntry && 'description' in schemaEntry ? (schemaEntry as SchemaField).description
                          : schemaEntry && 'label' in schemaEntry ? (schemaEntry as SchemaField).label
                          : undefined;
                        const defaultValue = schemaEntry && 'default' in schemaEntry ? (schemaEntry as SchemaField).default : undefined;
                        return <ConfigValue key={k} label={k} value={v} secret={isSecret} description={fieldDesc} defaultValue={defaultValue} />;
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
                      providerCache={providerCache}
                      onFetchProviders={fetchProviders}
                      llmProviders={llmProviders}
                      onFetchLLMProviders={fetchLLMProviders}
                    />
                    <div className="config-edit-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => savePluginConfig(iid, true)} disabled={isBusy(iid)}>保存</button>
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
                            type={/(apiKey|password|secret|token)(?![a-zA-Z])/i.test(k) ? 'password' : 'text'}
                            value={editBuffer[k]}
                            onChange={e => setEditBuffer(prev => ({ ...prev, [k]: e.target.value }))}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="config-edit-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => savePluginConfig(iid, false)} disabled={isBusy(iid)}>保存</button>
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
          });
      })()}
    </div>
  );
}
