import { useState, useEffect, useRef } from 'react';
import type { ConfigSchema, SchemaField, SchemaFieldType, SchemaGroup, SchemaArray } from '../types';

// ===== 数字输入框（解决小数输入被截断问题） =====
// 受控 number input 在输入 0.0x 时会被 Number() 取整覆盖，
// 用本地字符串状态隔离，只在值合法且"完整"时才向外 onChange。
// 清空发 undefined（不是 ''）：undefined 键被 JSON.stringify 丢弃，服务端按
// schema 默认值合并回落——"留空 = 走默认"。'' 会被服务端校验判为 invalid 拒存。
function NumberInput({ value, onChange, className }: { value: unknown; onChange: (v: number | undefined) => void; className?: string }) {
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
          onChange(undefined);
        } else if (!v.endsWith('.') && !isNaN(Number(v))) {
          onChange(Number(v));
        }
      }}
      onBlur={e => {
        const v = e.target.value;
        if (v === '' || v === '-') {
          onChange(undefined);
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

// ===== list / map：多行文本编辑 =====
// list 每行一项（空白行忽略）；map 每行一条 KEY=VALUE（按第一个 = 切分，键去首尾空白，值原样，
// 缺 = 或键为空的行不保存）。旧版存下的空串在草稿里即按 [] / {}（见 buildDraftFromSchema）；
// 其余字符串值原样显示，一经编辑即按行解析。

function formatList(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('\n');
  return typeof value === 'string' ? value : '';
}

function parseList(text: string): string[] {
  return text.split('\n').filter(line => line.trim() !== '');
}

function formatMap(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).map(([k, v]) => `${k}=${String(v)}`).join('\n');
  }
  return typeof value === 'string' ? value : '';
}

function parseMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (key) out[key] = line.slice(eq + 1);
  }
  return out;
}

// 数字、布尔按 String(x) 显示，编辑后规整为字符串（与 mcp-client 读 args / env 时的 String(x) 容错一致），
// 算作能逐行表达；其余非字符串值原样参与比较
function scalarsAsText(value: object): unknown {
  const asText = (x: unknown) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x);
  return Array.isArray(value)
    ? value.map(asText)
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, asText(v)]));
}

// 编辑期保留原文（本地状态），每次输入解析后向外 onChange；只有外部值与原文的解析结果不同
// （恢复默认、重新加载）时才用外部值重写原文——否则回车产生的空行会在解析后被吃掉。
// 每次编辑都重新解析整段文本：数组 / 映射里有逐行文本表达不了的内容（项或值含换行、list 的空白项、
// null、嵌套的数组或对象等，即「格式化再解析」回不到原值）时，任何一次编辑都会连带改写没动过的行，
// 所以这类值只读展示。
function LinesInput({
  value,
  onChange,
  format,
  parse,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  format: (v: unknown) => string;
  parse: (text: string) => unknown;
  placeholder: string;
}) {
  const [text, setText] = useState(() => format(value));

  useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(value)) setText(format(value));
  }, [value]);

  if (value !== null && typeof value === 'object' && JSON.stringify(parse(format(value))) !== JSON.stringify(scalarsAsText(value))) {
    return (
      <div>
        <textarea className="config-edit-input config-textarea" value={JSON.stringify(value, null, 2)} readOnly rows={3} />
        <span className="config-edit-hint">含换行、空白项或非标量等无法逐行表达的值，请在配置文件中修改</span>
      </div>
    );
  }

  return (
    <textarea
      className="config-edit-input config-textarea"
      value={text}
      placeholder={placeholder}
      onChange={e => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
      rows={3}
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

// 旧版 WebUI 给 list / map 存下的空串：含义只能是「空」，草稿里按 [] / {}，原样保存即写回合法形态
function isLegacyEmpty(field: SchemaField, value: unknown): boolean {
  return value === '' && (field.type === 'list' || field.type === 'map');
}

// 字段未配置且无 default 时的表单初值。number 无 default 不预填（undefined=留空走服务端默认）：
// 预填 0 会撞 min 约束，预填 min 则把「用户没填」静默写成 min、压过插件运行时兜底——与「未填≠预填」政策一致。
function emptyFieldValue(type: SchemaFieldType): unknown {
  switch (type) {
    case 'number':
      return undefined;
    case 'boolean':
      return false;
    case 'multiselect':
    case 'list':
      return [];
    case 'map':
      return {};
    default:
      return '';
  }
}

export function buildDraftFromSchema(schema: ConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(schema)) {
    if (isSchemaArray(entry)) {
      const existing = config[key];
      const items = Object.entries(entry.items ?? {});
      draft[key] = Array.isArray(existing)
        ? existing.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
            const out = { ...(item as Record<string, unknown>) };
            for (const [fk, field] of items) if (isLegacyEmpty(field, out[fk])) out[fk] = emptyFieldValue(field.type);
            return out;
          })
        : (entry.default ?? []);
    } else if (isSchemaField(entry)) {
      draft[key] = isLegacyEmpty(entry, config[key])
        ? emptyFieldValue(entry.type)
        : (config[key] ?? entry.default ?? emptyFieldValue(entry.type));
    } else {
      const group: Record<string, unknown> = {};
      const src = (config[key] ?? {}) as Record<string, unknown>;
      for (const [fk, field] of Object.entries(entry.fields)) {
        group[fk] = isLegacyEmpty(field, src[fk])
          ? emptyFieldValue(field.type)
          : (src[fk] ?? field.default ?? emptyFieldValue(field.type));
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

export interface LLMProviderEntry {
  contextId: string;
  label?: string;
  models: Array<{ id: string; capabilities: string[]; contextLength?: number }>;
}

/**
 * llm-ref 字段渲染：单级 select，跨 provider 摊平所有已注册 model entries。
 *
 * 设计动机（2026-05 重构）：原先「先选 provider 再选 model」两级 select 在用户视角
 * 引入了 plugin 与 model 的虚假绑定（用户并不关心 model 由哪个 plugin 注册），且
 * 容易在切换 provider 时把 model 重置为空字符串而不自知。改为单级摊平后，每个 option
 * 直接对应一个具体 entry，避免歧义。
 *
 * value 形如 `{ provider: string; model: string }`，保持兼容 `resolveLLMModel`
 * 的 Case 1 严格匹配（entryId = `${provider}/${model}`）。未注册但已被存档的旧 ref
 * 会原样保留并加上 `(已离线)` 提示，便于用户辨识并切换。
 */
function LLMRefField({
  value,
  onChange,
  llmProviders,
  onFetchLLMProviders,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  llmProviders: LLMProviderEntry[] | undefined;
  onFetchLLMProviders: () => void;
}) {
  useEffect(() => {
    if (!llmProviders) onFetchLLMProviders();
  }, []);

  const ref = (value && typeof value === 'object') ? (value as { provider?: string; model?: string }) : {};
  const provider = ref.provider ?? '';
  const model = ref.model ?? '';
  // 选中态用 `${provider}/${model}` 唯一编码（空 ref → ''）
  const selectedKey = provider && model ? `${provider}/${model}` : '';

  const [refreshState, setRefreshState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [refreshMsg, setRefreshMsg] = useState<string>('');

  const handleRefresh = async () => {
    if (!provider) return;
    setRefreshState('loading');
    setRefreshMsg('刷新中…');
    try {
      const res = await fetch(`/api/llm-providers/${encodeURIComponent(provider)}/refresh`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefreshState('error');
        setRefreshMsg(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      onFetchLLMProviders();
      const added = Array.isArray(body.added) ? body.added.length : 0;
      const removed = Array.isArray(body.removed) ? body.removed.length : 0;
      setRefreshState('ok');
      setRefreshMsg(added || removed ? `+${added} / -${removed}` : `共 ${body.total ?? 0} 个`);
      setTimeout(() => setRefreshState('idle'), 3000);
    } catch (err) {
      setRefreshState('error');
      setRefreshMsg((err as Error).message);
    }
  };

  // 摊平：跨 provider 列出每个 entry。option label 形如 `<providerLabel> / <modelId>  [caps]`
  const flatOptions: Array<{ key: string; provider: string; model: string; label: string }> = [];
  for (const p of llmProviders ?? []) {
    const providerLabel = p.label ?? p.contextId;
    for (const m of p.models) {
      const caps = m.capabilities.length > 0 ? `  [${m.capabilities.join(',')}]` : '';
      flatOptions.push({
        key: `${p.contextId}/${m.id}`,
        provider: p.contextId,
        model: m.id,
        label: `${providerLabel} / ${m.id}${caps}`,
      });
    }
  }
  // 旧 ref 不在列表中（provider 未启动或 model 已下线）→ 顶部插入「(已离线)」占位
  if (selectedKey && !flatOptions.some(o => o.key === selectedKey)) {
    flatOptions.unshift({
      key: selectedKey,
      provider,
      model,
      label: `${provider} / ${model}  (已离线)`,
    });
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <select
        className="config-edit-input"
        style={{ flex: '1 1 320px', minWidth: 0 }}
        value={selectedKey}
        onChange={e => {
          const key = e.target.value;
          if (!key) {
            onChange(undefined);
            return;
          }
          const opt = flatOptions.find(o => o.key === key);
          if (opt) onChange({ provider: opt.provider, model: opt.model });
        }}
      >
        <option value="">— 继承默认 —</option>
        {flatOptions.map(o => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      <button
        type="button"
        className="config-edit-btn"
        style={{ fontSize: 11, padding: '2px 8px' }}
        onClick={handleRefresh}
        disabled={!provider || refreshState === 'loading'}
        title={provider ? `重新探测 ${provider} 的远端模型列表（仅对动态发现型 provider 如 Ollama 生效）` : '先选模型后才能刷新对应 provider'}
      >
        {refreshState === 'loading' ? '⟳' : '⟳ 刷新'}
      </button>
      {refreshMsg && (
        <span style={{ fontSize: 11, color: refreshState === 'error' ? '#c62828' : refreshState === 'ok' ? '#2e7d32' : '#666' }}>
          {refreshMsg}
        </span>
      )}
    </div>
  );
}

function SchemaFormField({
  field,
  fieldKey,
  value,
  onChange,
  modelCache,
  onFetchModels,
  llmProviders,
  onFetchLLMProviders,
}: {
  field: SchemaField;
  fieldKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
  modelCache: Record<string, Array<{ label: string; value: string }>>;
  onFetchModels: (service: string) => void;
  llmProviders: LLMProviderEntry[] | undefined;
  onFetchLLMProviders: () => void;
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
      // 仅去除首尾换行/制表符，保留内部空格（如 ", " 逗号+空格是有效的多字符切割序列）
      const trimmed = customInput.replace(/^[\r\n\t]+|[\r\n\t]+$/g, '');
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

  if (field.type === 'llm-ref') {
    return (
      <LLMRefField value={value} onChange={onChange} llmProviders={llmProviders} onFetchLLMProviders={onFetchLLMProviders} />
    );
  }

  if (field.type === 'select' || (field.type === 'string' && (field.options?.length || field.dynamicOptions))) {
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

  if (field.type === 'list') {
    return <LinesInput value={value} onChange={onChange} format={formatList} parse={parseList} placeholder="每行一项" />;
  }

  if (field.type === 'map') {
    return (
      <LinesInput value={value} onChange={onChange} format={formatMap} parse={parseMap} placeholder="每行一条 KEY=VALUE" />
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
  // 字段名正则要求关键词后不接字母，避免 tokenBudget / secretLength 这类合成词被误判。
  const isSensitive = field.secret || /(apiKey|password|secret|token)(?![a-zA-Z])/i.test(fieldKey);
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
  llmProviders,
  onFetchLLMProviders,
}: {
  schema: ConfigSchema;
  draft: Record<string, unknown>;
  onChange: (newDraft: Record<string, unknown>) => void;
  modelCache: Record<string, Array<{ label: string; value: string }>>;
  onFetchModels: (service: string) => void;
  llmProviders?: LLMProviderEntry[];
  onFetchLLMProviders: () => void;
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
                llmProviders={llmProviders}
                onFetchLLMProviders={onFetchLLMProviders}
              />
            </div>
          );
        }

        // SchemaArray
        if (isSchemaArray(entry)) {
          const arr = (Array.isArray(draft[key]) ? draft[key] : []) as Record<string, unknown>[];
          const updateArr = (newArr: Record<string, unknown>[]) => onChange({ ...draft, [key]: newArr });

          // 防御：插件若未声明 items（违反 SchemaArray 契约），addItem 会因 Object.entries(undefined) 抛错；
          // 此处兜底为空对象，避免 WebUI 看似无响应。仍然记录到控制台便于排查。
          const items = entry.items ?? {};
          if (!entry.items) {
            // biome-ignore lint/suspicious/noConsole: 调试提示
            console.warn(`[SchemaForm] 数组字段 "${key}" 缺少 items 定义，添加按钮将创建空对象`);
          }

          const addItem = () => {
            // 仅给 required 字段或显式声明了 default 的字段预填值；其余字段留空，
            // 避免数字字段被默认填 0 而误把"未填"变成"覆盖为 0"。
            // 后端 parse 只接受类型正确的值，undefined/'' 都会自动穿透到顶层默认。
            const newItem: Record<string, unknown> = {};
            for (const [fk, field] of Object.entries(items)) {
              if (field.default !== undefined) {
                newItem[fk] = field.default;
              } else if (field.required) {
                newItem[fk] =
                  field.type === 'number' ? 0
                  : field.type === 'boolean' ? false
                  : field.type === 'list' ? []
                  : field.type === 'map' ? {}
                  : '';
              }
              // 其他字段保持 undefined → 输入框渲染为空 → 不参与覆盖
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
                  {Object.entries(items).map(([fk, field]) => {
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
                        llmProviders={llmProviders}
                        onFetchLLMProviders={onFetchLLMProviders}
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
                  llmProviders={llmProviders}
                  onFetchLLMProviders={onFetchLLMProviders}
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
