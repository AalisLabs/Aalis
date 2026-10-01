import { useState, useEffect, useRef } from 'react';
import type { ConfigSchema, SchemaField, SchemaFieldType, SchemaGroup, SchemaArray, SecretRef } from '../types';
import { isMasked, isSecretRef } from '../utils/secret';

// ===== 数字输入框（解决小数输入被截断问题） =====
// 受控 number input 在输入 0.0x 时会被 Number() 取整覆盖，
// 用本地字符串状态隔离，只在值合法且"完整"时才向外 onChange。
// 清空发 undefined（不是 ''，'' 会被服务端校验判为 invalid 拒存）：插件配置页保存时把顶层的 undefined
// 换成 null，分组里的随 JSON 丢掉，服务端都按 schema 默认值补齐——"留空 = 走默认"（数组元素不补默认值，
// 丢掉的键由插件按缺省处理）。
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
      // 密钥字段：文档里没有就留空，不填 schema 默认值。宿主不把密钥的默认值写进文档，草稿填进默认值再保存，
      // 默认值就会被当成新密钥存进 secrets.yaml，插件也会因为配置「变了」被重建
      draft[key] =
        entry.secret === true
          ? config[key]
          : isLegacyEmpty(entry, config[key])
            ? emptyFieldValue(entry.type)
            : (config[key] ?? entry.default ?? emptyFieldValue(entry.type));
    } else {
      const group: Record<string, unknown> = {};
      const src = (config[key] ?? {}) as Record<string, unknown>;
      for (const [fk, field] of Object.entries(entry.fields)) {
        group[fk] =
          field.secret === true
            ? src[fk]
            : isLegacyEmpty(field, src[fk])
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

/**
 * 「恢复默认」的底稿：默认值不含 secret 字段（密钥的默认值不进配置文档），顶层与分组里的 secret 字段沿用
 * stored（配置文档里这一段）现有的值，引用原样留着即保持原值，不因恢复默认被清掉。
 * 数组整份换成默认值，原条目连同其中的密钥一并去掉
 */
export function keepStoredSecrets(
  schema: ConfigSchema,
  defaults: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...defaults };
  for (const [key, entry] of Object.entries(schema)) {
    if (isSchemaArray(entry)) continue;
    if (isSchemaField(entry)) {
      if (entry.secret === true && Object.hasOwn(stored, key)) out[key] = stored[key];
      continue;
    }
    const src = stored[key];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [fk, field] of Object.entries(entry.fields)) {
      if (field.secret !== true || !Object.hasOwn(src, fk)) continue;
      const group = out[key];
      out[key] = {
        ...(group && typeof group === 'object' && !Array.isArray(group) ? group : {}),
        [fk]: (src as Record<string, unknown>)[fk],
      };
    }
  }
  return out;
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

/** 路径类字段的占位提示（与 schema-config 的 format 对应） */
const FORMAT_PLACEHOLDER: Record<string, string | undefined> = {
  'absolute-path': '绝对路径，例如 /opt/models/model.bin',
  executable: '命令名（按 PATH 查找）或绝对路径',
};

// ===== secret 字段 =====

const EMPTY_LIST: string[] = [];
const EMPTY_MAP: Record<string, string> = {};

/** 文本框里显示的值：对象（手改配置文件留下的非引用对象）不显示成 [object Object] */
function textOf(value: unknown): string {
  return value === undefined || value === null || typeof value === 'object' ? '' : String(value);
}

/** 密钥字段上的「没填」：''、空 list、空 map（引用不算） */
function isBlankSecret(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && !isSecretRef(value) && Object.keys(value).length === 0;
}

/**
 * secret: true 的字段。配置文档里存的是引用 { $secret: 键 }，原值在宿主的密钥存储里，接口不给。
 * 草稿里：引用 = 保持原值；明文 = 替换（map、list 整份）；'' / [] / {} = 清除。
 * 有引用时输入框从空开始，留空即保持；输入过再删空也回到保持，所以记住见过的引用（数组条目的 key 跟着条目走，
 * 删掉前面的条目不会把记住的引用错配给别的条目）。顶层与分组里的字段替换时写进它引用的那个键，键被别处共用时
 * 一并改到那些地方；数组元素里的另建新键。没有引用（未设置，或宿主没有密钥存储、这里是明文）时照常编辑。
 * list / map 之外的类型都按文本（密码框）编辑：凭据是文本
 */
function SecretField({
  field,
  value,
  onChange,
  refCounts,
  inArray,
}: {
  field: SchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
  refCounts?: Record<string, number>;
  inArray: boolean;
}) {
  const seen = useRef<SecretRef | undefined>(undefined);
  if (isSecretRef(value)) seen.current = value;
  const ref = seen.current;
  const isList = field.type === 'list';
  const isMap = field.type === 'map';

  const editor = (shown: unknown, change: (v: unknown) => void, placeholder?: string) => {
    if (isList) {
      return <LinesInput value={shown} onChange={change} format={formatList} parse={parseList} placeholder={placeholder ?? '每行一项'} />;
    }
    if (isMap) {
      return (
        <LinesInput value={shown} onChange={change} format={formatMap} parse={parseMap} placeholder={placeholder ?? '每行一条 KEY=VALUE'} />
      );
    }
    if (field.type === 'textarea') {
      return (
        <textarea
          className="config-edit-input config-textarea"
          value={textOf(shown)}
          placeholder={placeholder}
          spellCheck={false}
          onChange={e => change(e.target.value)}
          rows={3}
        />
      );
    }
    // new-password：别让浏览器把保存的登录口令自动填进空着的密钥框（填进去就成了替换）
    return (
      <input
        className="config-edit-input"
        type="password"
        autoComplete="new-password"
        value={textOf(shown)}
        placeholder={placeholder}
        onChange={e => change(e.target.value)}
      />
    );
  };

  // 没有引用：照常编辑。留空表示没填（发 undefined，不写进文档），插件按 schema 默认值解析
  if (!ref) {
    const fallback = typeof field.default === 'string' && field.default !== '' ? `留空使用默认值 ${field.default}` : undefined;
    return editor(value, v => onChange(isBlankSecret(v) ? undefined : v), FORMAT_PLACEHOLDER[field.format ?? ''] ?? fallback);
  }

  const kept = isSecretRef(value);
  const cleared = !kept && isBlankSecret(value);
  const count = refCounts?.[ref.$secret] ?? 0;
  const state = kept ? '' : cleared ? ' · 保存后清除' : inArray ? ' · 保存后存为新键' : ' · 保存后替换这个键的值';
  return (
    <div>
      {kept && (isList || isMap) && <span className="config-edit-hint">已设置（只写，改时整份重填）</span>}
      {editor(
        kept ? (isList ? EMPTY_LIST : isMap ? EMPTY_MAP : '') : value,
        v => onChange(isBlankSecret(v) ? ref : v),
        kept ? (isList || isMap ? undefined : '已设置（不显示）') : cleared ? '保存后清除' : undefined,
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="config-edit-hint">
          键 <code>{ref.$secret}</code>
          {state}
        </span>
        <button
          type="button"
          className="config-edit-btn"
          style={{ fontSize: 11, padding: '1px 6px' }}
          onClick={() => onChange(kept ? (isList ? [] : isMap ? {} : '') : ref)}
        >
          {kept ? '清除' : '撤销'}
        </button>
      </div>
      {!inArray && !cleared && count > 1 && (
        <span className="config-edit-hint" style={{ color: 'var(--warning)' }}>
          此密钥被 {count} 处引用，替换会同时改到另外 {count - 1} 处
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
  secretRefCounts,
  inArray = false,
}: {
  field: SchemaField;
  fieldKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
  modelCache: Record<string, Array<{ label: string; value: string }>>;
  onFetchModels: (service: string) => void;
  llmProviders: LLMProviderEntry[] | undefined;
  onFetchLLMProviders: () => void;
  secretRefCounts?: Record<string, number>;
  inArray?: boolean;
}) {
  if (field.secret === true) {
    return <SecretField field={field} value={value} onChange={onChange} refCounts={secretRefCounts} inArray={inArray} />;
  }

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
        {allOptions.length === 0 && <option value="">{dynamicKey && dynamicModels === undefined ? '加载中...' : '无可选项'}</option>}
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

  // string (default)；路径类字段的写法由服务端按 format 校验，这里只给提示。
  // secret: true 的已在上面处理；没写 secret 的按字段名判断是否用密码框，写了 false 的不遮蔽
  return (
    <input
      className="config-edit-input"
      type={isMasked(field.secret, fieldKey) ? 'password' : 'text'}
      value={String(value ?? '')}
      onChange={e => onChange(e.target.value)}
      placeholder={FORMAT_PLACEHOLDER[field.format ?? '']}
    />
  );
}

// 数组条目的 React key 跟着条目对象走，不用下标：删掉前面的条目时，后面条目的输入框状态（含 secret 字段记住的引用）
// 不会错位到别的条目上。改字段产生的新对象沿用旧对象的 key；草稿重建（开始编辑、恢复默认）即换新 key
const itemKeys = new WeakMap<object, number>();
let nextItemKey = 0;

function itemKey(item: unknown, idx: number): string {
  if (!item || typeof item !== 'object') return `#${idx}`;
  let key = itemKeys.get(item);
  if (key === undefined) {
    key = nextItemKey++;
    itemKeys.set(item, key);
  }
  return String(key);
}

function keepItemKey<T extends object>(from: object, to: T): T {
  const key = itemKeys.get(from);
  if (key !== undefined) itemKeys.set(to, key);
  return to;
}

export function SchemaForm({
  schema,
  draft,
  onChange,
  modelCache,
  onFetchModels,
  llmProviders,
  onFetchLLMProviders,
  secretRefCounts,
}: {
  schema: ConfigSchema;
  draft: Record<string, unknown>;
  onChange: (newDraft: Record<string, unknown>) => void;
  modelCache: Record<string, Array<{ label: string; value: string }>>;
  onFetchModels: (service: string) => void;
  llmProviders?: LLMProviderEntry[];
  onFetchLLMProviders: () => void;
  /** 配置文档里每个密钥键被引用的处数（GET /api/plugins 的 secretRefCounts），共用的密钥在替换前提示 */
  secretRefCounts?: Record<string, number>;
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
                secretRefCounts={secretRefCounts}
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
              // 密钥字段不预填：默认值会被当成新密钥存进 secrets.yaml
              if (field.secret === true) continue;
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
            const newArr = arr.map((item, i) => i === idx ? keepItemKey(item, { ...item, [fieldKey]: value }) : item);
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
                <div className="config-edit-array-item" key={itemKey(item, idx)} style={{
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
                        secretRefCounts={secretRefCounts}
                        inArray
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
                  secretRefCounts={secretRefCounts}
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
