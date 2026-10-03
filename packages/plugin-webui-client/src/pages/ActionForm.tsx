import type { ActionInputFields, PageRow } from '@aalis/api-webui';
import { type FormEvent, useState } from 'react';
import { isRecord, RestError } from '../rest';
import { FieldInput, FieldRow, UNREADABLE } from '../settings/FieldInput';
import type { Field } from '../settings/field';

// 带输入的动作的表单（放在对话框里，提交按钮在对话框底部）：字段按类型给控件，单列排；行动作里与行字段同名的输入项用这一行的值预填，其余取字段的默认值。
// 写法读不出的拦下不送，空着的可选项不送，由服务端补默认值并校验；服务端逐项的问题写回对应的字段

/** 打开表单时的取值：行里同名的标量，没有时取默认值 */
function initialValue(field: Field, rowValue: unknown): unknown {
  const value = rowValue !== undefined && rowValue !== null && typeof rowValue !== 'object' ? rowValue : field.default;
  return field.type === 'boolean' ? value === true : value;
}

/** 空着：没填、只有空白、空的列表与映射 */
const blank = (value: unknown) =>
  value === undefined ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

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
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, initialValue(field, row?.[key])])),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblems({});
    setError(undefined);
    if (Object.values(values).includes(UNREADABLE)) return;
    try {
      await submit(Object.fromEntries(Object.entries(values).filter(([, value]) => !blank(value))));
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
        <FieldRow key={key} field={field} problem={problems[key]} autofocus={index === 0}>
          {common => (
            <FieldInput
              field={field}
              value={values[key]}
              onChange={value => setValues(current => ({ ...current, [key]: value }))}
              common={common}
              masked={field.secret === true}
            />
          )}
        </FieldRow>
      ))}
      {error && (
        <p className="page-form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
