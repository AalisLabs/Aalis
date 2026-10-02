import type { SettingRow as Row } from '@aalis/api-session-protocol';
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { composing } from '../keys';
import { effectiveOf, type Field, formatValue, hasChoices, type Option, valueKey, withCurrent } from './field';
import { useFieldOptions } from './options';
import './SettingRow.css';

// 设置的一行：名称、来源徽标与生效值（不是「继承」两个字），点这一行就地修改、改完即存；开关直接拨。
// 被这一层覆盖时行尾有「恢复继承」。会话的设置与设置区的「会话默认」共用，只是存到不同的层

const SOURCES = {
  session: '本会话',
  parent: '父会话',
  audience: '受众',
  platform: '平台档',
  defaults: '默认',
} as const;

/** 写进这一层：给值即写入，null 恢复继承；写不进去时抛错 */
type Save = (value: unknown) => Promise<void>;

/** 编辑控件交出新值的方式：read 读出要写的值，读不出（写法不对）时抛错，原因与写入失败一样写在行下 */
type Commit = (read: () => unknown) => void;

/** 编辑框里的文字 ↔ 取值：列表一行一项，映射一行一个「键=值」 */
function toText(field: Field, value: unknown): string {
  if (value === undefined) return '';
  if (field.type === 'list') return Array.isArray(value) ? value.join('\n') : '';
  if (field.type === 'map') {
    return typeof value === 'object' && value !== null
      ? Object.entries(value)
          .map(([key, item]) => `${key}=${String(item)}`)
          .join('\n')
      : '';
  }
  return String(value);
}

function fromText(field: Field, text: string): unknown {
  if (field.type === 'number') {
    const number = Number(text.trim());
    if (text.trim() === '' || !Number.isFinite(number)) throw new Error('要填一个数');
    return number;
  }
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (field.type === 'list') return lines.map(line => line.trim());
  if (field.type === 'map') {
    return Object.fromEntries(
      lines.map(line => {
        const at = line.indexOf('=');
        if (at <= 0) throw new Error(`「${line}」要写成「键=值」`);
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
    );
  }
  return text;
}

const TEXT_TYPES = new Set(['string', 'number', 'textarea', 'list', 'map']);

export function SettingRow({ row, save }: { row: Row; save: Save }) {
  const { field } = row;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shown = effectiveOf(row);

  const commit: Commit = read => {
    setError(undefined);
    let value: unknown;
    try {
      value = read();
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    setBusy(true);
    save(value).then(
      () => {
        setBusy(false);
        setEditing(false);
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };

  const editable = hasChoices(field) || field.type === 'multiselect' || TEXT_TYPES.has(field.type);
  const head = (
    <>
      <span className="setting-row-label">{field.label}</span>
      {row.source && <Badge>{SOURCES[row.source]}</Badge>}
    </>
  );

  return (
    <fieldset className="setting-row" aria-label={field.label} aria-busy={busy || undefined}>
      <div className="setting-row-grid">
        {field.type === 'boolean' ? (
          <div className="setting-row-main">
            {head}
            <Toggle
              label={field.label}
              checked={shown === true}
              disabled={busy}
              onChange={checked => commit(() => checked)}
            />
          </div>
        ) : editing ? (
          <div className="setting-row-edit">
            <div className="setting-row-main">{head}</div>
            <Editor row={row} busy={busy} onCommit={commit} onClose={() => setEditing(false)} />
            {field.description && <p className="setting-row-description">{field.description}</p>}
          </div>
        ) : (
          <button
            type="button"
            className="setting-row-main"
            disabled={!editable}
            onClick={() => {
              setError(undefined);
              setEditing(true);
            }}
          >
            {head}
            <span className="setting-row-value" data-unset={shown === undefined || undefined}>
              {shown === undefined ? '未设置' : formatValue(field, shown)}
            </span>
          </button>
        )}
        {row.value !== undefined && (
          <Button variant="text" size="sm" disabled={busy} onClick={() => commit(() => null)}>
            恢复继承
          </Button>
        )}
        {error && (
          <p className="setting-row-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </fieldset>
  );
}

interface EditorProps {
  row: Row;
  busy: boolean;
  onCommit: Commit;
  onClose(): void;
}

/** Esc 放弃修改，不再交给外面（外面的 Esc 是停止生成） */
const onEscape = (onClose: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  onClose();
};

/** 按字段类型给出编辑控件，打开时焦点落在控件上 */
function Editor(props: EditorProps) {
  const { field } = props.row;
  if (hasChoices(field)) return <ChoiceEditor {...props} />;
  if (field.type === 'multiselect') return <MultiEditor {...props} />;
  return <TextEditor {...props} />;
}

function useFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

function ChoiceEditor({ row, busy, onCommit, onClose }: EditorProps) {
  const { field } = row;
  const ref = useFocus<HTMLSelectElement>();
  const { options, error } = useFieldOptions(field);
  const current = effectiveOf(row);
  const choices = withCurrent(field, options, current);
  return (
    <>
      <select
        ref={ref}
        aria-label={field.label}
        value={current === undefined ? '' : valueKey(field, current)}
        disabled={busy}
        onChange={event => {
          const chosen = choices.find(option => option.key === event.target.value);
          if (chosen) onCommit(() => chosen.value);
        }}
        onBlur={onClose}
        onKeyDown={onEscape(onClose)}
      >
        {current === undefined && (
          <option value="" disabled>
            未设置
          </option>
        )}
        {choices.map(option => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="setting-row-description">可选项没取到：{error.message}</p>}
    </>
  );
}

function MultiEditor({ row, busy, onCommit, onClose }: EditorProps) {
  const { field } = row;
  const ref = useFocus<HTMLFieldSetElement>();
  const { options, error } = useFieldOptions(field);
  const effective = effectiveOf(row);
  const current = Array.isArray(effective) ? effective : [];
  const chosen = new Set(current.map(item => valueKey(field, item)));
  const [custom, setCustom] = useState('');
  const toggle = (option: Option, on: boolean) =>
    onCommit(() => (on ? [...current, option.value] : current.filter(item => valueKey(field, item) !== option.key)));
  const all = [
    ...options,
    ...current.flatMap(item =>
      options.some(option => option.key === valueKey(field, item))
        ? []
        : [{ key: valueKey(field, item), label: String(item), value: item }],
    ),
  ];
  return (
    <fieldset ref={ref} className="setting-row-choices" tabIndex={-1} disabled={busy} onKeyDown={onEscape(onClose)}>
      <legend className="visually-hidden">{field.label}</legend>
      {all.map(option => (
        <label key={option.key} className="setting-row-choice">
          <input
            type="checkbox"
            checked={chosen.has(option.key)}
            onChange={event => toggle(option, event.target.checked)}
          />
          {option.label}
        </label>
      ))}
      {field.allowCustom && (
        <input
          aria-label={`添加${field.label}`}
          placeholder="添加一项，回车确认"
          value={custom}
          onChange={event => setCustom(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || composing(event.nativeEvent) || !custom.trim()) return;
            event.preventDefault();
            onCommit(() => [...current, custom.trim()]);
            setCustom('');
          }}
        />
      )}
      {error && <p className="setting-row-description">可选项没取到：{error.message}</p>}
      <Button variant="text" size="sm" onClick={onClose}>
        完成
      </Button>
    </fieldset>
  );
}

function TextEditor({ row, busy, onCommit, onClose }: EditorProps) {
  const { field } = row;
  const ref = useFocus<HTMLInputElement & HTMLTextAreaElement>();
  const cancel = onEscape(onClose);
  const initial = toText(field, effectiveOf(row));
  // 回车即存，焦点留在框里，写不进去时接着改；离开时也存
  const submit = (text: string) => {
    if (busy) return;
    if (text === initial) onClose();
    else onCommit(() => fromText(field, text));
  };
  const common = {
    ref,
    'aria-label': field.label,
    defaultValue: initial,
    disabled: busy,
    onBlur: (event: { currentTarget: { value: string } }) => submit(event.currentTarget.value),
  };
  const multiline = field.type === 'textarea' || field.type === 'list' || field.type === 'map';
  return multiline ? (
    <textarea
      {...common}
      rows={4}
      onKeyDown={event => {
        cancel(event);
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event.currentTarget.value);
      }}
    />
  ) : (
    <input
      {...common}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      onKeyDown={event => {
        cancel(event);
        if (event.key !== 'Enter' || composing(event.nativeEvent)) return;
        event.preventDefault();
        submit(event.currentTarget.value);
      }}
    />
  );
}
