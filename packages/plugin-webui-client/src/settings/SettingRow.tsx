import type { SettingRow as Row } from '@aalis/api-session-protocol';
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { composing } from '../keys';
import {
  effectiveOf,
  formatValue,
  fromText,
  hasChoices,
  type Option,
  TEXT_TYPES,
  toText,
  valueKey,
  withChosen,
  withCurrent,
} from './field';
import { useFieldOptions } from './options';
import './SettingRow.css';

// 设置的一行：名称、来源徽标与生效值（不是「继承」两个字），点这一行就地修改、改完即存；开关直接拨。
// 值按可选项的标签显示（动态可选项一并取来），哪一层都没设的按字段的默认值，没有默认值的不写。
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

export function SettingRow({ row, save }: { row: Row; save: Save }) {
  const { field } = row;
  const fieldOptions = useFieldOptions(field);
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
            <Editor
              row={row}
              fieldOptions={fieldOptions}
              busy={busy}
              onCommit={commit}
              onClose={() => setEditing(false)}
            />
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
            {shown !== undefined && (
              <span className="setting-row-value">{formatValue(field, shown, fieldOptions.options)}</span>
            )}
          </button>
        )}
        {row.value !== undefined && (
          <Button variant="text" disabled={busy} onClick={() => commit(() => null)}>
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
  /** 字段的可选项（静态的与动态来源的），没取到时带原因 */
  fieldOptions: ReturnType<typeof useFieldOptions>;
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

function ChoiceEditor({ row, fieldOptions: { options, error }, busy, onCommit, onClose }: EditorProps) {
  const { field } = row;
  const ref = useFocus<HTMLSelectElement>();
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
        {current === undefined && <option value="" disabled />}
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

function MultiEditor({ row, fieldOptions: { options, error }, busy, onCommit, onClose }: EditorProps) {
  const { field } = row;
  const ref = useFocus<HTMLFieldSetElement>();
  const effective = effectiveOf(row);
  const current = Array.isArray(effective) ? effective : [];
  const chosen = new Set(current.map(item => valueKey(field, item)));
  const [custom, setCustom] = useState('');
  const toggle = (option: Option, on: boolean) =>
    onCommit(() => (on ? [...current, option.value] : current.filter(item => valueKey(field, item) !== option.key)));
  const all = withChosen(field, options, current);
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
      <Button variant="text" onClick={onClose}>
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
