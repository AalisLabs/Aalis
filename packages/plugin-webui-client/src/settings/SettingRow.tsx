import { isBuiltinFieldType } from '@aalis/schema-config';
import { type KeyboardEvent, useEffect, useId, useReducer, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { composing } from '../keys';
import { FieldInput, type FieldOptions, UNREADABLE } from './FieldInput';
import { type Dependency, type Field, formatValue, isModelField, valueKey } from './field';
import { useFieldOptions } from './options';
import './SettingRow.css';

// 设置的一行：名称、来源徽标、生效时机与生效值，点这一行就地修改、改完即存；开关直接拨。编辑控件就是表单用的 FieldInput，
// 可选项由这一行取一次交给它：选择与多选选了即存，其余回车或离开时存，Esc 放弃；数字清空、选择选空的一项写 null，与行尾的
// 恢复按钮一样回到下一层，文字与列表清空写的是空值。存的时候编辑控件不可用。
// 值按可选项的标签显示（动态可选项一并取来）；没有值时模型跟随服务偏好，可选项接口标了默认的写那一项，其余不写。可选项
// 依赖另一项的，那一项眼下给不出可选项时不能改、写明不能调，生效值不在可选项里时写明按默认

/** 模型字段没有值时：跟随 llm 服务的偏好 */
const FOLLOW_PREFERENCE = '跟随服务偏好';

interface SettingRowProps {
  field: Field;
  /** 生效值；哪里都没设时是字段的默认值，没有默认值时为 undefined */
  value: unknown;
  /** 生效值出自哪里：默认、配置文件、平台档、本会话等 */
  source?: string;
  /** 什么时候生效，例如要重启的写「重启后生效」 */
  timing?: string;
  /** 这一处写了值时行尾的恢复按钮上的字（恢复继承、恢复默认），点了写 null */
  reset?: string;
  /** 可选项依赖的另一项（设置项的 dependsOn） */
  dependency?: Dependency;
  /** 写进这一处：给值即写入，null 回到下一层；写不进去时抛错 */
  save(value: unknown): Promise<void>;
}

export function SettingRow({ field, value, source, timing, reset, dependency, save }: SettingRowProps) {
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { options, loaded, error: optionsError } = useFieldOptions(field, version, dependency?.value);
  const labelId = useId();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /** 写进去；keepOpen 时写完编辑控件留着（多选一项一项地勾） */
  const commit = (next: unknown, keepOpen = false) => {
    setError(undefined);
    setBusy(true);
    save(next).then(
      () => {
        setBusy(false);
        if (!keepOpen) setEditing(false);
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };

  const shown =
    value === undefined
      ? isModelField(field)
        ? FOLLOW_PREFERENCE
        : options.find(option => option.isDefault)?.label
      : formatValue(field, value, options);
  const fixed = dependency !== undefined && loaded && options.length === 0;
  const note =
    dependency === undefined || !loaded
      ? undefined
      : fixed
        ? `当前${dependency.label}不能调`
        : value !== undefined && !options.some(option => option.key === valueKey(field, value))
          ? `当前${dependency.label}没有这一档，按默认`
          : undefined;
  const head = (
    <>
      <span id={labelId} className="setting-row-label">
        {field.label}
      </span>
      {source && <Badge>{source}</Badge>}
      {timing && <span className="setting-row-timing">{timing}</span>}
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
              checked={value === true}
              disabled={busy}
              onChange={checked => commit(checked)}
            />
          </div>
        ) : editing ? (
          <div className="setting-row-edit">
            <div className="setting-row-main">{head}</div>
            <Editor
              field={field}
              value={value}
              options={{ options, error: optionsError, refetch }}
              labelId={labelId}
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
            disabled={fixed || (!isModelField(field) && !isBuiltinFieldType(field.type))}
            onClick={() => {
              setError(undefined);
              setEditing(true);
            }}
          >
            {head}
            {shown !== undefined && <span className="setting-row-value">{shown}</span>}
            {note && <span className="setting-row-note">{note}</span>}
          </button>
        )}
        {reset && (
          <Button variant="text" disabled={busy} onClick={() => commit(null)}>
            {reset}
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
  field: Field;
  value: unknown;
  options: FieldOptions;
  labelId: string;
  busy: boolean;
  onCommit(value: unknown, keepOpen?: boolean): void;
  onClose(): void;
}

/** 编辑控件：打开时焦点落在控件上 */
function Editor({ field, value, options, labelId, busy, onCommit, onClose }: EditorProps) {
  const ref = useRef<HTMLFieldSetElement>(null);
  const id = useId();
  const [draft, setDraft] = useState(value);
  /** 按了 Esc：之后的失焦不再存 */
  const cancelled = useRef(false);
  const instant = field.type === 'select' || field.type === 'multiselect' || isModelField(field);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, select, textarea, fieldset')?.focus();
  }, []);

  /** 打字的控件：写法读不出的不存（原因写在控件下面），没改的直接收起，数字清空（undefined）写 null */
  const submit = () => {
    if (busy || cancelled.current || draft === UNREADABLE) return;
    if (JSON.stringify(draft) === JSON.stringify(value)) onClose();
    else onCommit(draft ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    if (event.key === 'Escape') {
      // 不再交给外面：外面的 Esc 是停止生成
      event.preventDefault();
      cancelled.current = true;
      onClose();
      return;
    }
    if (instant || event.key !== 'Enter' || composing(event.nativeEvent)) return;
    const multiline = event.target instanceof HTMLTextAreaElement;
    if (multiline ? !(event.metaKey || event.ctrlKey) : !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    submit();
  };

  // 一组编辑控件（模型旁的刷新、多选的「完成」与控件一起）：焦点离开这一组才算离开。有的浏览器点按钮不把焦点给它，
  // 按下时就先失焦，所以组里的按钮按下时不动焦点。存的时候整组不可用，控件失焦不算离开
  return (
    <fieldset
      ref={ref}
      className="setting-row-control"
      disabled={busy}
      onKeyDown={onKeyDown}
      onMouseDown={event => {
        if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
      }}
      onBlur={event => {
        if (busy || event.currentTarget.contains(event.relatedTarget)) return;
        if (instant) onClose();
        else submit();
      }}
    >
      <FieldInput
        field={field}
        value={instant ? value : draft}
        onChange={next => (instant ? onCommit(next ?? null, field.type === 'multiselect') : setDraft(next))}
        common={{ id, 'aria-labelledby': labelId }}
        options={options}
      />
      {field.type === 'multiselect' && (
        <Button variant="text" onClick={onClose}>
          完成
        </Button>
      )}
    </fieldset>
  );
}
