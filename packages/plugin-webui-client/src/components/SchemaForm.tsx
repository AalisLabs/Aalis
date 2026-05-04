import { useState, useEffect, useRef } from 'react';
import type { ConfigSchema, SchemaField, SchemaGroup, SchemaArray, ServiceProviderInfo } from '../types';
import { api } from '../api';

// ===== 数字输入框（解决小数输入被截断问题） =====
// 受控 number input 在输入 0.0x 时会被 Number() 取整覆盖，
// 用本地字符串状态隔离，只在值合法且"完整"时才向外 onChange。
function NumberInput({ value, onChange, className }: { value: unknown; onChange: (v: number | '') => void; className?: string }) {
  const externalStr = value === undefined || value === null || value === '' ? '' : String(value);
  const [inputStr, setInputStr] = useState(externalStr);
  const externalRef = useRef(externalStr);

  // 外部值变化时同步（但不覆盖用户正在输入的中间态）
  useEffect(() => {
    const newExt = value === undefined || value === null || value === '' ? '' : String(value);
    if (newExt !== externalRef.current) {
      externalRef.current = newExt;
      // 只有外部值与当前输入解析结果不同时才覆盖（用户未在编辑小数尾部）
      const parsed = inputStr === '' ? '' : Number(inputStr);
      if (String(parsed) !== inputStr) {
        // 用户正在输入中间态（如 "0."），不覆盖
        return;
      }
      setInputStr(newExt);
    }
  }, [value]);

  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      value={inputStr}
      onChange={e => {
        const v = e.target.value;
        setInputStr(v);
        if (v === '' || v === '-') {
          onChange('');
        } else if (!v.endsWith('.') && !v.endsWith('0') && !isNaN(Number(v))) {
          // 完整数字：立即通知
          onChange(Number(v));
        } else if (!v.endsWith('.') && !isNaN(Number(v))) {
          // 末尾带 0 的小数（如 0.10）也通知，但不改 inputStr
          onChange(Number(v));
        }
      }}
      onBlur={e => {
        const v = e.target.value;
        if (v === '' || v === '-') {
          onChange('');
          setInputStr('');
        } else {
          const n = Number(v);
          if (!isNaN(n)) {
            onChange(n);
            externalRef.current = String(n);
            // blur 时不重置 inputStr，保留用户输入的小数形式
          } else {
            setInputStr(externalRef.current);
          }
        }
      }}
    />
  );
}

// ===== 扁平化 / 还原嵌套对象（编辑用） =====

export function flattenConfig(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
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

export function unflattenConfig(flat: Record<string, string>): Record<string, unknown> {
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

export function isSchemaField(entry: SchemaField | SchemaGroup | SchemaArray): entry is SchemaField {
  return 'type' in entry && (entry as SchemaArray).type !== 'array';
}

export function isSchemaArray(entry: SchemaField | SchemaGroup | SchemaArray): entry is SchemaArray {
  return 'type' in entry && (entry as SchemaArray).type === 'array';
}

export function buildDraftFromSchema(schema: ConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (isSchemaArray(entry)) {
      const existing = config[key];
      draft[key] = Array.isArray(existing) ? existing : (entry.default ?? []);
    } else if (isSchemaField(entry)) {
      draft[key] = config[key] ?? entry.default ?? (entry.type === 'number' ? 0 : entry.type === 'boolean' ? false : entry.type === 'multiselect' ? [] : '');
    } else {
      const group: Record<string, unknown> = {};
      const src = (config[key] ?? {}) as Record<string, unknown>;
      for (const [fk, field] of Object.entries(entry.fields)) {
        group[fk] = src[fk] ?? field.default ?? (field.type === 'number' ? 0 : field.type === 'boolean' ? false : field.type === 'multiselect' ? [] : '');
      }
      draft[key] = group;
    }
  }
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
  providerCache,
  onFetchProviders,
}: {
  field: SchemaField;
  fieldKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
  modelCache: Record<string, Array<{ label: string; value: string }>>;
  onFetchModels: (service: string) => void;
  providerCache: Record<string, Array<{ contextId: string; displayName?: string }>>;
  onFetchProviders: (service: string) => void;
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
    const dynamicKey = field.dynamicOptions;
    const dynamicModels = dynamicKey ? modelCache[dynamicKey] : undefined;

    useEffect(() => {
      if (dynamicKey && !modelCache[dynamicKey]) {
        onFetchModels(dynamicKey);
      }
    }, [dynamicKey]);

    const staticOpts = field.options ?? [];
    const dynOpts = dynamicModels ?? [];
    const allOptions = [...staticOpts];
    for (const d of dynOpts) {
      if (!allOptions.some(o => String(o.value) === String(d.value))) allOptions.push(d);
    }
    for (const s of selected) {
      if (!allOptions.some(o => String(o.value) === s)) {
        allOptions.push({ label: s, value: s });
      }
    }

    const toggle = (v: string) => {
      const next = selected.includes(v) ? selected.filter(s => s !== v) : [...selected, v];
      onChange(next);
    };

    const [customInput, setCustomInput] = useState('');
    const addCustom = () => {
      const trimmed = customInput.trim();
      if (trimmed && !selected.includes(trimmed)) {
        onChange([...selected, trimmed]);
      }
      setCustomInput('');
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
        {field.allowCustom && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <input
              className="config-edit-input"
              style={{ flex: 1, fontSize: 12 }}
              type="text"
              placeholder="手动输入..."
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }}
            />
            <button className="config-edit-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={addCustom}>添加</button>
          </div>
        )}
      </div>
    );
  }

  if (field.type === 'select' || (field.type === 'string' && (field.options?.length || field.dynamicOptions || field.dynamicProviders))) {
    const dynamicKey = field.dynamicOptions;
    const dynamicModels = dynamicKey ? modelCache[dynamicKey] : undefined;
    const providerKey = field.dynamicProviders;
    const dynamicProviders = providerKey ? providerCache[providerKey] : undefined;

    useEffect(() => {
      if (dynamicKey && !modelCache[dynamicKey]) {
        onFetchModels(dynamicKey);
      }
      if (providerKey && !providerCache[providerKey]) {
        onFetchProviders(providerKey);
      }
    }, [dynamicKey, providerKey]);

    const staticOpts = field.options ?? [];
    // Provider-based options (contextId as value, displayName or contextId as label)
    const provOpts = (dynamicProviders ?? []).map(p => ({
      label: p.displayName ? `[${p.displayName}] ${p.contextId}` : p.contextId,
      value: p.contextId,
    }));
    const dynOpts = dynamicModels ?? [];
    const allOptions = [...staticOpts];
    for (const d of [...provOpts, ...dynOpts]) {
      if (!allOptions.some(o => String(o.value) === String(d.value))) allOptions.push(d);
    }
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
      <NumberInput
        className="config-edit-input"
        value={value}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        className="config-edit-input config-textarea"
        value={String(value ?? '')}
        onChange={e => onChange(e.target.value)}
        rows={3}
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

export function SchemaForm({
  schema,
  draft,
  onChange,
  modelCache,
  onFetchModels,
  providerCache,
  onFetchProviders,
}: {
  schema: ConfigSchema;
  draft: Record<string, unknown>;
  onChange: (newDraft: Record<string, unknown>) => void;
  modelCache: Record<string, Array<{ label: string; value: string }>>;
  onFetchModels: (service: string) => void;
  providerCache: Record<string, Array<{ contextId: string; displayName?: string }>>;
  onFetchProviders: (service: string) => void;
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
                providerCache={providerCache}
                onFetchProviders={onFetchProviders}
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
                        providerCache={providerCache}
                        onFetchProviders={onFetchProviders}
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
                  providerCache={providerCache}
                  onFetchProviders={onFetchProviders}
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
