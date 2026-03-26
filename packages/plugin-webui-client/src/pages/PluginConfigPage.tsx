import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { SchemaForm, buildDraftFromSchema, flattenConfig, unflattenConfig, isSchemaField } from '../components/SchemaForm';
import { ConfigValue } from '../components/ConfigValue';
import type { PluginInfo, ConfigSchema, SchemaField } from '../types';

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
  const [busy, setBusy] = useState<string | null>(null);
  const [editingPlugin, setEditingPlugin] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<Record<string, string>>({});
  const [schemaDraft, setSchemaDraft] = useState<Record<string, unknown>>({});
  const [modelCache, setModelCache] = useState<Record<string, string[]>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [pluginSearch, setPluginSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

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
              p.provides.some(s => s.toLowerCase().includes(q)))
          : plugins;

        const categoryMap: Record<string, string> = {};
        const categoryOrder = [
          '系统', 'LLM 模型', '智能体', '存储', '嵌入模型',
          '向量存储', '工具', '界面', '适配器', '自动化', '其他',
        ];
        for (const p of filtered) {
          const n = p.name;
          const cat =
            p.core ? '系统'
            : /^(@aalis\/)?plugin-(openai|deepseek)$/.test(n) ? 'LLM 模型'
            : /^(@aalis\/)?plugin-agent/.test(n) || /^(@aalis\/)?plugin-(chat-flow|persona)$/.test(n) ? '智能体'
            : /^(@aalis\/)?plugin-memory-/.test(n) ? '存储'
            : /^(@aalis\/)?plugin-embedding-/.test(n) ? '嵌入模型'
            : /^(@aalis\/)?plugin-vectorstore-/.test(n) ? '向量存储'
            : /^(@aalis\/)?plugin-(tool-|tools-|websearch-)/.test(n) ? '工具'
            : /^(@aalis\/)?plugin-(webui-|cli)/.test(n) ? '界面'
            : /^(@aalis\/)?plugin-adapter-/.test(n) ? '适配器'
            : /^(@aalis\/)?plugin-(scheduler|skills)$/.test(n) ? '自动化'
            : /^(@aalis\/)?plugin-(commands|authority)$/.test(n) ? '系统'
            : '其他';
          categoryMap[n] = cat;
        }

        const grouped = new Map<string, PluginInfo[]>();
        for (const cat of categoryOrder) grouped.set(cat, []);
        for (const p of filtered) {
          const cat = categoryMap[p.name] || '其他';
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
          });
      })()}
    </div>
  );
}
