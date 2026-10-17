import {
  type SchemaArray as DeclaredArray,
  type SchemaField as DeclaredField,
  type SchemaGroup as DeclaredGroup,
  type ConfigSchema as DeclaredSchema,
  isSecretRef,
  type SecretRef,
} from '@aalis/schema-config';
import type { Localized } from '@aalis/schema-i18n';
import { Plus } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { tr } from '../language';
import { isRecord, putJson, RestError } from '../rest';
import { type FieldCommon, FieldInput, FieldRow, UNREADABLE } from '../settings/FieldInput';
import { type PluginRow, usePlugins } from './list';
import './ConfigForm.css';

// 插件配置：按 schema 画的整张表，改完再保存（保存会重载插件）。改了没保存的项左边一条竖线、行尾可以撤销，底部一条写着几项
// 未保存，保存的结果也写在这条上。只送改了的顶层键（分组、数组整块），清空的顶层键送 null，由服务端回到默认值。
// 密钥只写不回显：文档里是引用，引用原样留着即保持原值；「更换」后写的新值替换，「清除」送空值；顶层与分组里的替换写进
// 原来的键（别处共用这个键的一并改到），数组元素里的另建新键。插件停用或失败时照样能改

// 插件列表交来的 schema：给人看的文字已按读者语言渲染成字符串
type ConfigSchema = Localized<DeclaredSchema>;
type SchemaArray = Localized<DeclaredArray>;
type SchemaField = Localized<DeclaredField>;
type SchemaGroup = Localized<DeclaredGroup>;
type Entry = ConfigSchema[string];
const isArrayEntry = (entry: Entry): entry is SchemaArray => 'type' in entry && entry.type === 'array';
const isGroupEntry = (entry: Entry): entry is SchemaGroup => 'fields' in entry;

/** 没有值时编辑框里的样子：开关是关，列表与映射是空的，其余不填 */
function emptyOf(field: SchemaField): unknown {
  if (field.type === 'boolean') return false;
  if (field.type === 'multiselect' || field.type === 'list') return [];
  if (field.type === 'map') return {};
  return undefined;
}

/** 字段的草稿：密钥字段按文档原样（不填默认值，免得默认值被当成新密钥存起来） */
function fieldDraft(field: SchemaField, value: unknown): unknown {
  if (field.secret === true) return value;
  return value ?? field.default ?? emptyOf(field);
}

/** 表单的草稿：每个 schema 键一项，分组是各字段的草稿，数组按文档原样（没有时取数组的默认值） */
function buildDraft(schema: ConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, entry]) => {
      if (isArrayEntry(entry)) {
        const existing = config[key];
        return [key, Array.isArray(existing) ? existing : (entry.default ?? [])];
      }
      if (isGroupEntry(entry)) {
        const source = isRecord(config[key]) ? config[key] : {};
        return [
          key,
          Object.fromEntries(
            Object.entries(entry.fields).map(([name, field]) => [name, fieldDraft(field, source[name])]),
          ),
        ];
      }
      return [key, fieldDraft(entry, config[key])];
    }),
  );
}

/**
 * 「恢复默认」的底稿：默认值不含密钥字段，顶层与分组里的密钥沿用文档里现有的值（引用原样留着即保持原值），不因恢复默认
 * 被清掉；数组整份换成默认值，原条目连同其中的密钥一并去掉
 */
function keepStoredSecrets(
  schema: ConfigSchema,
  defaults: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...defaults };
  for (const [key, entry] of Object.entries(schema)) {
    if (isArrayEntry(entry)) continue;
    if (!isGroupEntry(entry)) {
      if (entry.secret === true && Object.hasOwn(stored, key)) out[key] = stored[key];
      continue;
    }
    const source = stored[key];
    if (!isRecord(source)) continue;
    for (const [name, field] of Object.entries(entry.fields)) {
      if (field.secret !== true || !Object.hasOwn(source, name)) continue;
      out[key] = { ...(isRecord(out[key]) ? out[key] : {}), [name]: source[name] };
    }
  }
  return out;
}

/** 草稿与存着的值一样没有：空串与没填算一样，值为 undefined 的键当作没有（JSON 丢掉它们） */
function same(a: unknown, b: unknown): boolean {
  if (a === b || ((a === '' || a === undefined) && (b === '' || b === undefined))) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = (value: Record<string, unknown>) => Object.keys(value).filter(key => value[key] !== undefined);
    return keys(a).length === keys(b).length && keys(a).every(key => same(a[key], b[key]));
  }
  return false;
}

const unreadable = (value: unknown): boolean =>
  value === UNREADABLE ||
  (Array.isArray(value) ? value.some(unreadable) : isRecord(value) && Object.values(value).some(unreadable));

/** 改了的项数：顶层字段、分组里的字段各算一项，数组整块算一项 */
function countChanges(schema: ConfigSchema, base: Record<string, unknown>, draft: Record<string, unknown>): number {
  let count = 0;
  for (const [key, entry] of Object.entries(schema)) {
    if (!isGroupEntry(entry)) count += same(draft[key], base[key]) ? 0 : 1;
    else {
      const [now, before] = [draft[key], base[key]] as Array<Record<string, unknown>>;
      for (const name of Object.keys(entry.fields)) count += same(now[name], before[name]) ? 0 : 1;
    }
  }
  return count;
}

/** 字段名像凭据（没写 secret 时据此用密码框）；关键词后不接字母，tokenBudget 这类合成词不算 */
const SECRET_NAME = /(apiKey|password|secret|token)(?![a-zA-Z])/i;

/** 路径类字段的提示（与 schema-config 的 format 对应） */
function formatPlaceholder(format: SchemaField['format']): string | undefined {
  if (format === 'absolute-path') return tr('formatAbsolutePath');
  if (format === 'executable') return tr('formatExecutable');
  return undefined;
}

interface ConfigFormProps {
  row: PluginRow;
  schema: ConfigSchema;
  /** 写进配置文件之后：由上层重取插件列表、换上新的表单，回执写在底部那条上 */
  onSaved(message: string): Promise<void>;
  /** 上一次保存的回执 */
  result?: string;
}

/** 服务端逐项的问题：路径对上这一项，或落在它里面（列表的第几项、映射的某个键） */
type Issue = RestError['issues'][number];
const problemAt = (issues: readonly Issue[], path: string) =>
  issues.find(issue => issue.path === path || issue.path.startsWith(`${path}[`) || issue.path.startsWith(`${path}.`))
    ?.message;

export function ConfigForm({ row, schema, onSaved, result }: ConfigFormProps) {
  const { refresh, secretRefCounts } = usePlugins();
  const base = useMemo(() => buildDraft(schema, row.config), [schema, row.config]);
  const [draft, setDraft] = useState(base);
  // 控件的版本：恢复默认、放弃时全部重建，逐项撤销时只重建这一项（控件里正在写的文字与「更换」的状态随之丢掉）
  const [epoch, setEpoch] = useState(0);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<readonly Issue[]>([]);
  const changes = countChanges(schema, base, draft);

  const replaceAll = (next: Record<string, unknown>) => {
    setDraft(next);
    setEpoch(n => n + 1);
    setError(undefined);
    setIssues([]);
  };
  const revert = (path: string, apply: (current: Record<string, unknown>) => Record<string, unknown>) => {
    setDraft(apply);
    setRevisions(current => ({ ...current, [path]: (current[path] ?? 0) + 1 }));
  };

  const save = async () => {
    const patch = Object.fromEntries(
      Object.keys(schema)
        .filter(key => !same(draft[key], base[key]))
        .map(key => [key, draft[key] === undefined ? null : draft[key]]),
    );
    if (unreadable(patch)) {
      setError(tr('configInvalid'));
      return;
    }
    setSaving(true);
    setError(undefined);
    setIssues([]);
    try {
      const reply = await putJson(`/api/plugins/${encodeURIComponent(row.instanceId)}/config`, { config: patch });
      await onSaved(isRecord(reply) && typeof reply.message === 'string' ? reply.message : tr('saved'));
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof RestError) setIssues(err.issues);
      // 没写进配置文件，但运行态可能已经变了（回执带 applied）：重取状态，草稿留着
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const keyOf = (path: string) => `${path}:${epoch}:${revisions[path] ?? 0}`;

  return (
    <div className="config-form">
      <div className="config-head">
        <h3 className="page-block-label">{tr('configuration')}</h3>
        {Object.keys(row.defaultConfig).length > 0 && (
          <Button
            variant="text"
            onClick={() => replaceAll(buildDraft(schema, keepStoredSecrets(schema, row.defaultConfig, row.config)))}
          >
            {tr('resetDefault')}
          </Button>
        )}
      </div>
      {Object.entries(schema).map(([key, entry]) => {
        if (isArrayEntry(entry)) {
          return (
            <ArrayBlock
              key={keyOf(key)}
              name={key}
              entry={entry}
              items={draft[key] as unknown[]}
              changed={!same(draft[key], base[key])}
              issues={issues}
              onChange={items => setDraft(current => ({ ...current, [key]: items }))}
              onRevert={() => revert(key, current => ({ ...current, [key]: base[key] }))}
            />
          );
        }
        if (isGroupEntry(entry)) {
          const group = draft[key] as Record<string, unknown>;
          const stored = base[key] as Record<string, unknown>;
          return (
            <Section key={key} title={entry.label ?? key} description={entry.description}>
              {Object.entries(entry.fields).map(([name, field]) => {
                const path = `${key}.${name}`;
                return (
                  <ConfigRow
                    key={keyOf(path)}
                    name={name}
                    field={field}
                    problem={problemAt(issues, path)}
                    value={group[name]}
                    changed={!same(group[name], stored[name])}
                    refCount={secretCount(secretRefCounts, group[name], stored[name])}
                    onChange={value => setDraft(current => ({ ...current, [key]: { ...group, [name]: value } }))}
                    onRevert={() =>
                      revert(path, current => ({
                        ...current,
                        [key]: { ...(current[key] as Record<string, unknown>), [name]: stored[name] },
                      }))
                    }
                  />
                );
              })}
            </Section>
          );
        }
        return (
          <ConfigRow
            key={keyOf(key)}
            name={key}
            field={entry}
            problem={problemAt(issues, key)}
            value={draft[key]}
            changed={!same(draft[key], base[key])}
            refCount={secretCount(secretRefCounts, draft[key], base[key])}
            onChange={value => setDraft(current => ({ ...current, [key]: value }))}
            onRevert={() => revert(key, current => ({ ...current, [key]: base[key] }))}
          />
        );
      })}
      {(changes > 0 || error || result) && (
        <div className="config-bar">
          {error ? (
            <p className="config-bar-text" role="alert">
              {error}
            </p>
          ) : (
            <p className="config-bar-text">{changes > 0 ? tr('configUnsaved', { count: changes }) : result}</p>
          )}
          {changes > 0 && (
            <>
              <Button variant="text" disabled={saving} onClick={() => replaceAll(base)}>
                {tr('discard')}
              </Button>
              <Button variant="primary" busy={saving} onClick={() => void save()}>
                {row.state === 'disabled' ? tr('save') : tr('saveAndReload')}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 文档里这个密钥键被引用的处数（顶层与分组里替换时写进它，别处共用的一并改到） */
function secretCount(counts: Readonly<Record<string, number>>, value: unknown, stored: unknown): number {
  const ref = isSecretRef(value) ? value : isSecretRef(stored) ? stored : undefined;
  return ref ? (counts[ref.$secret] ?? 0) : 0;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="config-group" aria-labelledby={id}>
      <h4 id={id} className="config-group-title">
        {title}
      </h4>
      {description && <p className="field-note">{description}</p>}
      {children}
    </section>
  );
}

// 数组条目的 React key 跟着条目对象走，不用下标：删掉前面的条目时，后面条目的控件状态（含密钥记住的引用）不错位到
// 别的条目上。改字段产生的新对象沿用旧对象的 key；草稿重建（恢复默认、放弃）即换新 key
const itemKeys = new WeakMap<object, number>();
let nextItemKey = 0;

function itemKey(item: unknown, index: number): string {
  if (!isRecord(item)) return `#${index}`;
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

interface ArrayBlockProps {
  name: string;
  entry: SchemaArray;
  items: unknown[];
  changed: boolean;
  issues: readonly Issue[];
  onChange(items: unknown[]): void;
  onRevert(): void;
}

/** 对象数组：整块算一项；新条目只预填有默认值的字段，密钥字段不预填（默认值会被当成新密钥存起来） */
function ArrayBlock({ name, entry, items, changed, issues, onChange, onRevert }: ArrayBlockProps) {
  const add = () => {
    const item: Record<string, unknown> = {};
    for (const [field, spec] of Object.entries(entry.items)) {
      if (spec.secret !== true && spec.default !== undefined) item[field] = spec.default;
    }
    onChange([...items, item]);
  };
  return (
    <section className="config-group" data-changed={changed || undefined} aria-label={entry.label}>
      <div className="config-head">
        <h4 className="config-group-title">{entry.label}</h4>
        {changed && (
          <Button variant="text" onClick={onRevert}>
            {tr('undo')}
          </Button>
        )}
        <Button variant="text" icon={Plus} onClick={add}>
          {tr('addEntry')}
        </Button>
      </div>
      {entry.description && <p className="field-note">{entry.description}</p>}
      {items.length === 0 && <p className="field-note">{tr('configNoEntries')}</p>}
      {items.map((item, index) => {
        const record = isRecord(item) ? item : {};
        return (
          <div key={itemKey(item, index)} className="config-item">
            <div className="config-head">
              <span className="config-item-title">{tr('configEntry', { index: index + 1 })}</span>
              <Button
                variant="text"
                danger
                aria-label={tr('configEntryDelete', { index: index + 1 })}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                {tr('delete')}
              </Button>
            </div>
            {Object.entries(entry.items).map(([field, spec]) => {
              const path = `${name}[${index}].${field}`;
              return (
                <ConfigRow
                  key={field}
                  name={field}
                  field={spec}
                  value={record[field]}
                  problem={problemAt(issues, path)}
                  refCount={0}
                  inArray
                  onChange={value =>
                    onChange(
                      items.map((current, i) =>
                        i === index ? keepItemKey(record, { ...record, [field]: value }) : current,
                      ),
                    )
                  }
                />
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

interface ConfigRowProps {
  /** 字段的键：没写 secret 时按它判断要不要用密码框 */
  name: string;
  field: SchemaField;
  value: unknown;
  problem?: string;
  /** 密钥键被引用的处数 */
  refCount: number;
  /** 在数组元素里：替换密钥另建新键，改动随整个数组算 */
  inArray?: boolean;
  /** 改了没保存（数组元素里的不单算） */
  changed?: boolean;
  onChange(value: unknown): void;
  onRevert?(): void;
}

function ConfigRow({ name, field, value, problem, refCount, inArray, changed, onChange, onRevert }: ConfigRowProps) {
  return (
    <FieldRow
      field={field}
      problem={problem}
      changed={changed}
      trailing={
        changed &&
        onRevert && (
          <Button variant="text" aria-label={tr('undoField', { label: field.label })} onClick={onRevert}>
            {tr('undo')}
          </Button>
        )
      }
    >
      {common =>
        field.secret === true ? (
          <SecretInput
            field={field}
            value={value}
            onChange={onChange}
            common={common}
            refCount={refCount}
            inArray={inArray}
          />
        ) : (
          <FieldInput
            field={field}
            value={value}
            onChange={onChange}
            common={common}
            masked={field.secret === undefined && SECRET_NAME.test(name)}
            placeholder={formatPlaceholder(field.format)}
          />
        )
      }
    </FieldRow>
  );
}

/** 密钥字段上的「没填」：''、空列表、空映射（引用不算） */
const blankSecret = (value: unknown) =>
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && !isSecretRef(value) && Object.keys(value).length === 0);

interface SecretInputProps {
  field: SchemaField;
  value: unknown;
  onChange(value: unknown): void;
  common: FieldCommon;
  refCount: number;
  inArray?: boolean;
}

/**
 * 密钥：文档里是引用 { $secret: 键 }，原值在宿主的密钥存储里，接口不给。有引用时只写「已设置」与键名，「更换」后输入的
 * 新值替换，留空保持原值；「清除」送空值，撤销在行尾。没有引用（没设置过，或宿主没有密钥存储、文档里是明文）时照常编辑，
 * 留空即不填。列表与映射整份重填
 */
function SecretInput({ field, value, onChange, common, refCount, inArray }: SecretInputProps) {
  // 记住见过的引用：输入过再删空也回到保持
  const seen = useRef<SecretRef>(undefined);
  if (isSecretRef(value)) seen.current = value;
  const ref = seen.current;
  const [replacing, setReplacing] = useState(false);
  const lines = field.type === 'list' || field.type === 'map';
  useEffect(() => {
    if (replacing) document.getElementById(common.id)?.focus();
  }, [replacing, common.id]);

  const editor = (shown: unknown, placeholder?: string) => (
    <FieldInput
      field={lines || field.type === 'textarea' ? field : { ...field, type: 'string' }}
      value={shown}
      onChange={next => onChange(blankSecret(next) ? ref : next)}
      common={common}
      masked={!lines && field.type !== 'textarea'}
      placeholder={placeholder}
    />
  );

  if (!ref) {
    const fallback =
      typeof field.default === 'string' && field.default !== ''
        ? tr('secretDefaultHint', { value: field.default })
        : tr('secretUnset');
    return editor(value, formatPlaceholder(field.format) ?? fallback);
  }
  if (blankSecret(value)) return <p className="config-secret">{tr('secretClearOnSave', { key: ref.$secret })}</p>;
  if (isSecretRef(value) && !replacing) {
    return (
      <div className="config-secret">
        <span>{tr('secretSet', { key: ref.$secret })}</span>
        <Button
          variant="text"
          aria-label={tr('replaceField', { label: field.label })}
          onClick={() => setReplacing(true)}
        >
          {tr('secretReplace')}
        </Button>
        <Button
          variant="text"
          danger
          aria-label={tr('clearField', { label: field.label })}
          onClick={() => onChange(field.type === 'list' ? [] : field.type === 'map' ? {} : '')}
        >
          {tr('secretClear')}
        </Button>
      </div>
    );
  }
  const kept = isSecretRef(value);
  return (
    <>
      {editor(kept ? undefined : value, lines ? tr('secretRefill') : tr('secretReplaceHint'))}
      <p className="field-note">
        {kept
          ? tr('secretKeyKept', { key: ref.$secret })
          : inArray
            ? tr('secretKeyNew', { key: ref.$secret })
            : tr('secretKeyReplaced', { key: ref.$secret })}
      </p>
      {!inArray && refCount > 1 && (
        <p className="config-warning">{tr('secretShared', { count: refCount, others: refCount - 1 })}</p>
      )}
    </>
  );
}
