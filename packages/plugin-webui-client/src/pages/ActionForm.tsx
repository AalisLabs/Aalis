import type { ActionInputFields, PageRow } from '@aalis/api-webui';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { RestError } from '../rest';
import { type Field, fromText, hasChoices, toText, valueKey, withChosen, withCurrent } from '../settings/field';
import { useFieldOptions } from '../settings/options';

// 带输入的动作的表单（放在对话框里，提交按钮在对话框底部）：字段按类型给控件，单列排；行动作里与行字段同名的输入项用这一行的值预填，其余取字段的默认值。
// 提交时文字按字段类型换成取值（读不出的写在字段下），空着的可选项不送，由服务端补默认值并校验；服务端逐项的问题写回对应的字段

const isBoolean = (field: Field) => field.type === 'boolean';
const isMulti = (field: Field) => field.type === 'multiselect';

/** 一个字段正在填的样子：文字框是文字，开关是布尔，选择是选中的取值，多选是取值的数组 */
function initialDraft(field: Field, rowValue: unknown): unknown {
  const value = rowValue !== undefined && rowValue !== null && typeof rowValue !== 'object' ? rowValue : field.default;
  if (isBoolean(field)) return value === true;
  if (isMulti(field)) return Array.isArray(value) ? value : [];
  if (hasChoices(field)) return value;
  return toText(field, value);
}

/** 填好的样子换成要送的取值；空着的不送 */
function inputOf(field: Field, draft: unknown): unknown {
  if (hasChoices(field)) return draft;
  if (isMulti(field)) return (draft as unknown[]).length > 0 ? draft : undefined;
  return (draft as string).trim() === '' ? undefined : fromText(field, draft as string);
}

interface ActionFormProps {
  /** 表单的 id：提交按钮在对话框底部，经它关联 */
  id: string;
  /** destructive 动作写在表单开头的警示 */
  warning?: string;
  fields: ActionInputFields;
  /** 行动作：这一行的值，给同名的输入项预填 */
  row?: PageRow;
  /** 送出去，成功时由它关上表单；失败时抛错（输入没过校验时是带逐项问题的 RestError） */
  submit(input: Record<string, unknown>): Promise<void>;
}

export function ActionForm({ id, warning, fields, row, submit }: ActionFormProps) {
  const [drafts, setDrafts] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, initialDraft(field, row?.[key])])),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const input: Record<string, unknown> = {};
    const unreadable: Record<string, string> = {};
    for (const [key, field] of Object.entries(fields)) {
      try {
        const value = inputOf(field, drafts[key]);
        if (value !== undefined) input[key] = value;
      } catch (err) {
        unreadable[key] = (err as Error).message;
      }
    }
    setProblems(unreadable);
    setError(undefined);
    if (Object.keys(unreadable).length > 0) return;
    try {
      await submit(input);
    } catch (err) {
      const issues = err instanceof RestError ? err.issues.filter(issue => Object.hasOwn(fields, issue.path)) : [];
      if (issues.length > 0) setProblems(Object.fromEntries(issues.map(issue => [issue.path, issue.message])));
      else setError((err as Error).message);
    }
  };

  return (
    <form id={id} className="page-form" noValidate onSubmit={onSubmit}>
      {warning && <p>{warning}</p>}
      {Object.entries(fields).map(([key, field], index) => (
        <FieldControl
          key={key}
          field={field}
          draft={drafts[key]}
          problem={problems[key]}
          first={index === 0}
          onChange={draft => setDrafts(current => ({ ...current, [key]: draft }))}
        />
      ))}
      {error && (
        <p className="page-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

interface ControlProps {
  field: Field;
  draft: unknown;
  /** 控件的 id 与读屏、校验、焦点的属性 */
  common: Record<string, unknown>;
  onChange(draft: unknown): void;
}

interface FieldControlProps extends Omit<ControlProps, 'common'> {
  problem?: string;
  /** 第一个字段：表单打开时焦点落在它上面 */
  first: boolean;
}

function FieldControl({ field, draft, problem, first, onChange }: FieldControlProps) {
  const id = useId();
  const describedBy = [field.description && `${id}-description`, problem && `${id}-problem`].filter(Boolean).join(' ');
  const common = {
    id,
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': describedBy || undefined,
    'data-autofocus': first || undefined,
  };
  const required = field.required && <span className="page-field-required">必填</span>;
  let control: ReactNode;
  if (isBoolean(field)) {
    control = (
      <label className="page-field-check">
        <input
          {...common}
          type="checkbox"
          checked={draft === true}
          onChange={event => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  } else if (isMulti(field)) {
    control = (
      <MultiControl
        field={field}
        draft={draft}
        common={common}
        onChange={onChange}
        legend={
          <>
            {field.label}
            {required}
          </>
        }
      />
    );
  } else {
    control = (
      <>
        <div className="page-field-label">
          <label htmlFor={id}>{field.label}</label>
          {required}
        </div>
        {hasChoices(field) ? (
          <ChoiceControl field={field} draft={draft} common={common} onChange={onChange} />
        ) : (
          <TextControl field={field} draft={draft} common={common} onChange={onChange} />
        )}
      </>
    );
  }
  return (
    <div className="page-field">
      {control}
      {field.description && (
        <p id={`${id}-description`} className="page-field-description">
          {field.description}
        </p>
      )}
      {problem && (
        <p id={`${id}-problem`} className="page-field-problem">
          {problem}
        </p>
      )}
    </div>
  );
}

function ChoiceControl({ field, draft, common, onChange }: ControlProps) {
  const { options, error } = useFieldOptions(field);
  const choices = withCurrent(field, options, draft);
  return (
    <>
      <select
        {...common}
        value={draft === undefined ? '' : valueKey(field, draft)}
        onChange={event => onChange(choices.find(option => option.key === event.target.value)?.value)}
      >
        {(draft === undefined || !field.required) && <option value="" />}
        {choices.map(option => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="page-field-description">可选项没取到：{error.message}</p>}
    </>
  );
}

function MultiControl({ field, draft, common, onChange, legend }: ControlProps & { legend: ReactNode }) {
  const { options, error } = useFieldOptions(field);
  const chosen = draft as unknown[];
  const all = withChosen(field, options, chosen);
  const keys = new Set(chosen.map(item => valueKey(field, item)));
  return (
    <fieldset {...common} className="page-field-choices" tabIndex={-1}>
      <legend className="page-field-label">{legend}</legend>
      {all.map(option => (
        <label key={option.key} className="page-field-check">
          <input
            type="checkbox"
            checked={keys.has(option.key)}
            onChange={event =>
              onChange(
                event.target.checked
                  ? [...chosen, option.value]
                  : chosen.filter(item => valueKey(field, item) !== option.key),
              )
            }
          />
          {option.label}
        </label>
      ))}
      {error && <p className="page-field-description">可选项没取到：{error.message}</p>}
    </fieldset>
  );
}

function TextControl({ field, draft, common, onChange }: ControlProps) {
  const text = draft as string;
  if (field.type === 'textarea' || field.type === 'list' || field.type === 'map') {
    return <textarea {...common} rows={4} value={text} onChange={event => onChange(event.target.value)} />;
  }
  return (
    <input
      {...common}
      type={field.secret ? 'password' : 'text'}
      inputMode={field.type === 'number' ? 'decimal' : undefined}
      autoComplete="off"
      value={text}
      onChange={event => onChange(event.target.value)}
    />
  );
}
