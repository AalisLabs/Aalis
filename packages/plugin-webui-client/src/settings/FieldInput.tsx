import { RotateCw } from 'lucide-react';
import { type ReactNode, useId, useReducer, useState } from 'react';
import { IconButton } from '../components/IconButton';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import { composing } from '../keys';
import { isRecord, postJson } from '../rest';
import { type Field, isModelField, type Option, optionLabel, valueKey, withChosen, withCurrent } from './field';
import { useFieldOptions } from './options';
import './FieldInput.css';

// 按 schema-config 字段的类型给出编辑控件，交出的是取值：开关是布尔，选择是选中的取值，多选是取值的数组，数字是数，
// 列表与映射一行一项、一行一个「键=值」。写法读不出时交出 UNREADABLE，原因写在控件下面，由表单拦下不送。
// 选择、多选与模型的可选项由调用方给出时直接用，不然自己取；模型字段旁有「刷新模型列表」，让会自己发现模型的服务重新探测
// 一遍。FieldRow 是表单里的一行（标签与「必填」、控件、说明与问题），页面动作的表单与插件配置共用

/** 写法读不出的取值（数字框里不是数、映射里有一行没写等号） */
export const UNREADABLE = Symbol('unreadable');

/** 控件的 id 与读屏、校验、焦点的属性，交给主要的那个控件 */
export interface FieldCommon {
  id: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  'aria-labelledby'?: string;
  'data-autofocus'?: boolean;
}

/** 字段的可选项与不在可选项里的取值的名字；refetch 让它重取（模型服务重新探测之后） */
export interface FieldOptions {
  options: Option[];
  names?: readonly Option[];
  error?: Error;
  refetch(): void;
}

interface FieldInputProps {
  field: Field;
  value: unknown;
  onChange(value: unknown): void;
  common: FieldCommon;
  /** 文字框里没有值时的提示 */
  placeholder?: string;
  /** 文字框用密码框 */
  masked?: boolean;
  /** 可选项依赖的那一项的生效值（设置项的 dependsOn） */
  dependency?: unknown;
  /** 调用方已经取到的可选项：给了就不再另取 */
  options?: FieldOptions;
}

type ChoiceProps = FieldInputProps & { options: FieldOptions };

export function FieldInput(props: FieldInputProps) {
  const { field, value, onChange, common, options } = props;
  if (field.type === 'boolean') {
    return <input {...common} type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />;
  }
  if (isModelField(field) || field.type === 'select' || field.type === 'multiselect') {
    if (!options) return <OwnOptions {...props} />;
    if (isModelField(field)) return <ModelInput {...props} options={options} />;
    if (field.type === 'select') return <Choices {...props} options={options} />;
    return <MultiInput {...props} options={options} />;
  }
  if (field.type === 'number') return <NumberInput {...props} />;
  if (field.type === 'list' || field.type === 'map') return <LinesInput {...props} />;
  const text = value === undefined || value === null || typeof value === 'object' ? '' : String(value);
  if (field.type === 'textarea') {
    return (
      <textarea
        {...common}
        rows={3}
        value={text}
        placeholder={props.placeholder}
        onChange={e => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      {...common}
      type={props.masked ? 'password' : 'text'}
      // new-password：浏览器不把存着的登录口令自动填进来
      autoComplete={props.masked ? 'new-password' : 'off'}
      value={text}
      placeholder={props.placeholder}
      onChange={e => onChange(e.target.value)}
    />
  );
}

/** 调用方没给可选项：自己取 */
function OwnOptions(props: FieldInputProps) {
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { options, names, error } = useFieldOptions(props.field, version, props.dependency);
  return <FieldInput {...props} options={{ options, names, error, refetch }} />;
}

/** 选择：不是必填的可以选空的一项（交出 undefined）；empty 是空的那一项的名字 */
function Choices({ field, value, onChange, common, options, empty = '不选' }: ChoiceProps & { empty?: string }) {
  const choices = withCurrent(field, options.options, value, options.names);
  return (
    <>
      <Select
        {...common}
        value={value === undefined ? '' : valueKey(field, value)}
        options={[
          ...(field.required ? [] : [{ value: '', label: empty }]),
          ...choices.map(option => ({ value: option.key, label: optionLabel(option) })),
        ]}
        placeholder="请选择"
        onChange={key => onChange(choices.find(option => option.key === key)?.value)}
      />
      {options.error && <p className="field-note">可选项没取到：{options.error.message}</p>}
    </>
  );
}

/** 模型：不选就跟随默认；选了模型时可以让它的服务重新探测模型列表 */
function ModelInput(props: ChoiceProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const provider = isRecord(props.value) && typeof props.value.provider === 'string' ? props.value.provider : undefined;
  const refresh = () => {
    setBusy(true);
    postJson(`/api/llm-providers/${encodeURIComponent(provider as string)}/refresh`, {})
      .then(
        reply => {
          const counts = isRecord(reply) ? reply : {};
          const added = Array.isArray(counts.added) ? counts.added.length : 0;
          const removed = Array.isArray(counts.removed) ? counts.removed.length : 0;
          toast({ kind: 'success', text: `模型列表已刷新：新增 ${added} 个、移除 ${removed} 个` });
          props.options.refetch();
        },
        (err: Error) => toast({ kind: 'danger', text: `刷新模型列表失败：${err.message}`, source: provider }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="field-model">
      <Choices {...props} empty="跟随默认" />
      <IconButton icon={RotateCw} label="刷新模型列表" disabled={!provider || busy} onClick={refresh} />
    </div>
  );
}

function MultiInput({ field, value, onChange, common, options }: ChoiceProps) {
  const [custom, setCustom] = useState('');
  const chosen = Array.isArray(value) ? value : [];
  const keys = new Set(chosen.map(item => valueKey(field, item)));
  return (
    <fieldset {...common} className="field-choices" tabIndex={-1}>
      {withChosen(field, options.options, chosen).map(option => (
        <label key={option.key} className="field-check">
          <input
            type="checkbox"
            checked={keys.has(option.key)}
            onChange={e =>
              onChange(
                e.target.checked
                  ? [...chosen, option.value]
                  : chosen.filter(item => valueKey(field, item) !== option.key),
              )
            }
          />
          {option.label}
        </label>
      ))}
      {field.allowCustom && (
        <input
          aria-label={`添加${field.label}`}
          placeholder="添加一项，回车确认"
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter' || composing(e.nativeEvent)) return;
            e.preventDefault();
            const added = custom.trim();
            if (added && !keys.has(added)) onChange([...chosen, added]);
            setCustom('');
          }}
        />
      )}
      {options.error && <p className="field-note">可选项没取到：{options.error.message}</p>}
    </fieldset>
  );
}

/** 数字：清空即不填；写到一半（「0.」）照样交出读得出的数，框里留着原样 */
function NumberInput({ value, onChange, common, placeholder }: FieldInputProps) {
  const [text, setText] = useState(() => (typeof value === 'number' ? String(value) : ''));
  const unreadable = value === UNREADABLE;
  return (
    <>
      <input
        {...common}
        aria-invalid={unreadable || common['aria-invalid']}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={e => {
          const next = e.target.value;
          const number = Number(next.trim());
          setText(next);
          onChange(next.trim() === '' ? undefined : Number.isFinite(number) ? number : UNREADABLE);
        }}
      />
      {unreadable && <p className="field-problem">要填一个数</p>}
    </>
  );
}

/** 列表与映射写成编辑框里的文字：列表一行一项，映射一行一个「键=值」 */
function toText(field: Field, value: unknown): string {
  if (field.type === 'list') return Array.isArray(value) ? value.join('\n') : '';
  return isRecord(value)
    ? Object.entries(value)
        .map(([key, item]) => `${key}=${String(item)}`)
        .join('\n')
    : '';
}

/** 编辑框里的文字读回列表或映射；读不出（映射有一行没写等号）时抛错，原因给人看 */
function fromText(field: Field, text: string): string[] | Record<string, string> {
  const lines = text.split('\n').filter(line => line.trim() !== '');
  if (field.type === 'list') return lines.map(line => line.trim());
  return Object.fromEntries(
    lines.map(line => {
      const at = line.indexOf('=');
      if (at <= 0) throw new Error(`「${line}」要写成「键=值」`);
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
  );
}

/** 数字与布尔写成文字：逐行编辑时它们回来都是文字，不算改动 */
const asText = (value: object): unknown =>
  Array.isArray(value)
    ? value.map(item => (typeof item === 'number' || typeof item === 'boolean' ? String(item) : item))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          typeof item === 'number' || typeof item === 'boolean' ? String(item) : item,
        ]),
      );

/** 逐行写得出来：写成文字再读回来与原值相同（项里有换行、空白项、嵌套的对象等写不出） */
function linesExpressible(field: Field, value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  try {
    return JSON.stringify(fromText(field, toText(field, value))) === JSON.stringify(asText(value));
  } catch {
    return false;
  }
}

/** 列表一行一项，映射一行一个「键=值」。逐行写不出的值只读，在配置文件里改，免得一改就连带改写没动过的行 */
function LinesInput({ field, value, onChange, common, placeholder }: FieldInputProps) {
  const [text, setText] = useState(() => (value === UNREADABLE ? '' : toText(field, value)));
  const [problem, setProblem] = useState<string>();
  if (value !== UNREADABLE && !linesExpressible(field, value)) {
    return (
      <>
        <textarea {...common} rows={3} readOnly value={JSON.stringify(value, null, 2)} />
        <p className="field-note">含换行、空白项或不是文字的值，请在配置文件里改</p>
      </>
    );
  }
  return (
    <>
      <textarea
        {...common}
        aria-invalid={problem !== undefined || common['aria-invalid']}
        rows={3}
        value={text}
        placeholder={placeholder ?? (field.type === 'map' ? '每行一条 键=值' : '每行一项')}
        onChange={e => {
          setText(e.target.value);
          try {
            onChange(fromText(field, e.target.value));
            setProblem(undefined);
          } catch (err) {
            onChange(UNREADABLE);
            setProblem((err as Error).message);
          }
        }}
      />
      {problem && <p className="field-problem">{problem}</p>}
    </>
  );
}

interface FieldRowProps {
  field: Field;
  problem?: string;
  /** 表单打开时焦点落在它上面 */
  autofocus?: boolean;
  /** 改了没保存 */
  changed?: boolean;
  /** 行尾，例如撤销 */
  trailing?: ReactNode;
  /** 控件：拿到 id 与读屏、校验、焦点的属性 */
  children(common: FieldCommon): ReactNode;
}

/** 表单里的一行：标签与「必填」、控件、说明与问题。多选的控件是一组，标签是一段文字，控件组经 aria-labelledby 认它 */
export function FieldRow({ field, problem, autofocus, changed, trailing, children }: FieldRowProps) {
  const id = useId();
  const group = field.type === 'multiselect';
  const describedBy = [field.description && `${id}-description`, problem && `${id}-problem`].filter(Boolean).join(' ');
  const common: FieldCommon = {
    id,
    'aria-invalid': problem ? true : undefined,
    'aria-describedby': describedBy || undefined,
    'aria-labelledby': group ? `${id}-label` : undefined,
    'data-autofocus': autofocus || undefined,
  };
  return (
    <div className="field-row" data-changed={changed || undefined}>
      <div className="field-row-label">
        {group ? <span id={`${id}-label`}>{field.label}</span> : <label htmlFor={id}>{field.label}</label>}
        {field.required && <span className="field-row-required">必填</span>}
      </div>
      <div className="field-row-control">
        {children(common)}
        {field.description && (
          <p id={`${id}-description`} className="field-note">
            {field.description}
          </p>
        )}
        {problem && (
          <p id={`${id}-problem`} className="field-problem">
            {problem}
          </p>
        )}
      </div>
      {trailing}
    </div>
  );
}
