import { isBuiltinFieldType } from '@aalis/schema-config';
import { type KeyboardEvent, useEffect, useId, useReducer, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { composing } from '../keys';
import { tr } from '../language';
import { FieldInput, type FieldOptions, UNREADABLE } from './FieldInput';
import { type Dependency, type Field, formatValue, isModelField, optionLabel, valueKey } from './field';
import { useFieldOptions } from './options';
import './SettingRow.css';

// 设置的一行：名称、徽标（来源或「默认」）、生效时机与生效值，值下面另写一句（「来自：…」、作者默认等），点这一行就地修改、
// 改完即存；开关直接拨。编辑控件就是表单用的 FieldInput，
// 可选项由这一行取一次交给它：选择与多选选了即存，其余回车或离开时存，Esc 放弃；数字清空、选择选空的一项写 null，与行尾的
// 恢复按钮一样回到下一层，文字与列表清空写的是空值。存的时候编辑控件不可用；写进去了、只是没落盘时写回来的那一句。
// 值按可选项的标签显示（动态可选项一并取来，不在可选项里的按来源另给的名字）；没有值时写可选项接口标了默认的那一项，
// 没有就写声明给的「没设时」。可选项依赖另一项的，那一项眼下给不出可选项时不能改、写明不能调，生效值不在可选项里时
// 写明按默认的哪一项

interface SettingRowProps {
  field: Field;
  /** 生效值；哪里都没设时是字段的默认值，没有默认值时为 undefined */
  value: unknown;
  /** 名称旁的徽标：来源（配置文件、默认）或作者默认的「默认」 */
  source?: string;
  /** 值下面的一句：来源（「来自：工作区『论文』」）、被下层盖住的提示等 */
  note?: string;
  /** 作者默认的那一句（「默认：30」，见 field.ts 的 authorDefault）：只占一行，悬停看全文 */
  defaultNote?: string;
  /** 什么时候生效，例如要重启的写「重启后生效」 */
  timing?: string;
  /** 这一处写了值时行尾的恢复按钮上的字（恢复继承、恢复默认），点了写 null */
  reset?: string;
  /** 可选项依赖的另一项（设置项的 dependsOn） */
  dependency?: Dependency;
  /** 没有生效值时这一项的含义（声明给的，或此刻实际在用的值） */
  unset?: string;
  /** 写进这一处：给值即写入，null 回到下一层；写不进去时抛错，写进去了、只是没落盘时交回那一句（文字） */
  save(value: unknown): Promise<unknown>;
}

export function SettingRow({
  field,
  value,
  source,
  note: extra,
  defaultNote,
  timing,
  reset,
  dependency,
  unset,
  save,
}: SettingRowProps) {
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { options, names, loaded, error: optionsError } = useFieldOptions(field, version, dependency?.value);
  const labelId = useId();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [unsaved, setUnsaved] = useState<string>();

  /** 写进去；keepOpen 时写完编辑控件留着（多选一项一项地勾） */
  const commit = (next: unknown, keepOpen = false) => {
    setError(undefined);
    setUnsaved(undefined);
    setBusy(true);
    save(next).then(
      written => {
        setBusy(false);
        setUnsaved(typeof written === 'string' ? written : undefined);
        if (!keepOpen) setEditing(false);
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };

  const fallback = options.find(option => option.isDefault);
  const shown =
    value === undefined
      ? fallback
        ? optionLabel(fallback)
        : unset
      : formatValue(field, value, [...options, ...names]);
  const fixed = dependency !== undefined && loaded && options.length === 0;
  const note =
    dependency === undefined || !loaded
      ? extra
      : fixed
        ? tr('dependencyFixed', { dependency: dependency.label })
        : value !== undefined && !options.some(option => option.key === valueKey(field, value))
          ? fallback
            ? tr('dependencyNoLevelFallback', { dependency: dependency.label, fallback: fallback.label })
            : tr('dependencyNoLevel', { dependency: dependency.label })
          : extra;
  const defaultLine = defaultNote && (
    <span className="setting-row-note field-default" title={defaultNote}>
      {defaultNote}
    </span>
  );
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
            {value === undefined && unset && <span className="setting-row-note">{unset}</span>}
            {extra && <span className="setting-row-note">{extra}</span>}
            {defaultLine}
          </div>
        ) : editing ? (
          <div className="setting-row-edit">
            <div className="setting-row-main">{head}</div>
            <Editor
              field={field}
              value={value}
              options={{ options, names, error: optionsError, refetch }}
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
            {defaultLine}
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
        {unsaved && (
          <p className="setting-row-error" role="status">
            {unsaved}
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
  /** 失焦之后等一拍：焦点落回这一组（含选择器挂在 body 上的弹层，它的焦点事件经 React 的组件树传到这里）就不算离开 */
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const instant = field.type === 'select' || field.type === 'multiselect' || isModelField(field);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, [role="combobox"], fieldset')?.focus();
    return () => clearTimeout(leaving.current);
  }, []);

  /** 打字的控件：写法读不出的不存（原因写在控件下面），没改的直接收起，数字清空（undefined）写 null */
  const submit = () => {
    if (busy || cancelled.current || draft === UNREADABLE) return;
    if (JSON.stringify(draft) === JSON.stringify(value)) onClose();
    else onCommit(draft ?? null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFieldSetElement>) => {
    // 选择器的弹层已经处理过的键（Esc 先关弹层）
    if (event.defaultPrevented) return;
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
      onFocus={() => clearTimeout(leaving.current)}
      onBlur={() => {
        if (busy) return;
        leaving.current = setTimeout(instant ? onClose : submit);
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
          {tr('done')}
        </Button>
      )}
    </fieldset>
  );
}
