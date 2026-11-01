import { ArrowDown, ArrowUp, RotateCw } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Disclosure } from '../components/Disclosure';
import { IconButton } from '../components/IconButton';
import { Select } from '../components/Select';
import { useToast } from '../components/Toast';
import { composing } from '../keys';
import { tr } from '../language';
import { isRecord, postJson } from '../rest';
import {
  type Field,
  isModelField,
  type Option,
  type Others,
  optionLabel,
  valueKey,
  withChosen,
  withCurrent,
} from './field';
import { useFieldOptions } from './options';
import './FieldInput.css';

// 按 schema-config 字段的类型给出编辑控件，交出的是取值：开关是布尔，选择是选中的取值，多选是取值的数组（有序的另能
// 上移下移），数字是数，列表与映射一行一项、一行一个「键=值」。写法读不出时交出 UNREADABLE，原因写在控件下面，由表单拦下不送。
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

/**
 * 字段的可选项、不在可选项里的取值的名字与不属于任何可选项的成员；refetch 让它重取（模型服务重新探测之后）
 */
export interface FieldOptions {
  options: Option[];
  names?: readonly Option[];
  others?: Others;
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
  /** 可选项依赖的那一项的取值写成的 dependency（字段声明的 dependsOn，见 field.ts 的 dependencyText） */
  dependency?: string;
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

/** 编辑控件的可选项：取一次，refetch 让它重取；调用方自己也要用可选项（如写作者默认的称呼）时取了交给 FieldInput */
export function useInputOptions(field: Field, dependency?: string): FieldOptions {
  const [version, refetch] = useReducer((n: number) => n + 1, 0);
  const { options, names, others, error } = useFieldOptions(field, version, dependency);
  return { options, names, others, error, refetch };
}

/** 调用方没给可选项：自己取 */
function OwnOptions(props: FieldInputProps) {
  return <FieldInput {...props} options={useInputOptions(props.field, props.dependency)} />;
}

/** 选择：不是必填的可以选空的一项（交出 undefined）；empty 是空的那一项的名字 */
function Choices({
  field,
  value,
  onChange,
  common,
  options,
  empty = tr('selectNone'),
}: ChoiceProps & { empty?: string }) {
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
        placeholder={tr('selectPlaceholder')}
        onChange={key => onChange(choices.find(option => option.key === key)?.value)}
      />
      {options.error && <p className="field-note">{tr('optionsFailed', { error: options.error.message })}</p>}
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
          toast({ kind: 'success', text: tr('modelsRefreshed', { added, removed }) });
          props.options.refetch();
        },
        (err: Error) =>
          toast({
            kind: 'danger',
            text: tr('actionFailed', { action: tr('refreshModels'), error: err.message }),
            source: provider,
          }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="field-model">
      <Choices {...props} empty={tr('followDefault')} />
      <IconButton icon={RotateCw} label={tr('refreshModels')} disabled={!provider || busy} onClick={refresh} />
    </div>
  );
}

/** 移动按钮的方向：上移是 -1 */
type Step = -1 | 1;

/**
 * 多选：一列复选框。有序的（field.ordered）选中的按取值的先后排在前面，各带上移、下移，写回的取值就是这个顺序；没选的接在
 * 后面，勾上的排到最后。勾选、取消与移动之后焦点留在那一项上。带成员的项下面另起一行是「包含 N 项」的展开；来源另给了
 * 不属于任何可选项的成员时，末尾一行写它的名字、同样能展开。
 * 可选项里有代表其余全部的一项（all）时：勾它只存它，取消它即全不选；选着它时各项都显示勾上，不分先后，取值里另写的名字
 * 不列出、也不另加，取消某一项存其余各项。各项都勾上的固定名单不算选着它
 */
function MultiInput({ field, value, onChange, common, options }: ChoiceProps) {
  const [custom, setCustom] = useState('');
  const group = useRef<HTMLFieldSetElement>(null);
  /** 刚勾选、取消或移动（带方向）的那一项：重画之后把焦点放回它的复选框或移动按钮 */
  const touched = useRef<{ key: string; step?: Step }>(undefined);
  /** 复选框与移动按钮，键是「方向\n选项的键」，复选框的方向是 0 */
  const controls = useRef(new Map<string, HTMLInputElement | HTMLButtonElement>());
  const chosen = Array.isArray(value) ? value : [];
  const keys = new Set(chosen.map(item => valueKey(field, item)));
  const whole = options.options.find(option => option.all);
  const everything = whole !== undefined && keys.has(whole.key);
  const all = everything ? options.options : withChosen(field, options.options, chosen);
  const ordered = field.ordered && !everything;
  const picked = ordered ? [...keys].map(key => all.find(option => option.key === key) as Option) : [];
  const listed = ordered ? [...picked, ...all.filter(option => !keys.has(option.key))] : all;
  const checked = (option: Option) => everything || keys.has(option.key);
  /** 勾或取消一项之后的取值 */
  const toggled = (option: Option, on: boolean) => {
    if (option === whole) return on ? [whole.value] : [];
    if (everything) return all.filter(other => other !== whole && other !== option).map(other => other.value);
    return on ? [...chosen, option.value] : chosen.filter(item => valueKey(field, item) !== option.key);
  };

  // 移动的同一方向到头了用另一个按钮。存的时候整组不可用，等可用了再放；控件自己不可用（到了两头）或不在了（那一项不选了）
  // 就不再等。焦点去了组外（不在这一组里，也没落到 body 上）时不放，免得抢走用户正在用的控件
  useLayoutEffect(() => {
    const last = touched.current;
    if (!last) return;
    const active = document.activeElement;
    const away = active !== document.body && !group.current?.contains(active);
    const usable = (last.step ? [last.step, -last.step] : [0])
      .flatMap(direction => controls.current.get(`${direction}\n${last.key}`) ?? [])
      .filter(control => !control.disabled);
    const target = usable.find(control => !control.matches(':disabled'));
    if (!away && !target && usable.length > 0) return;
    touched.current = undefined;
    if (!away) target?.focus();
  });

  const keep = (direction: Step | 0, key: string) => (control: HTMLInputElement | HTMLButtonElement | null) => {
    if (control) controls.current.set(`${direction}\n${key}`, control);
    else controls.current.delete(`${direction}\n${key}`);
  };
  const move = (index: number, step: Step) => {
    const next = [...picked];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    touched.current = { key: picked[index].key, step };
    onChange(next.map(option => option.value));
  };
  const moveButton = (option: Option, index: number, step: Step) => (
    <IconButton
      ref={keep(step, option.key)}
      icon={step < 0 ? ArrowUp : ArrowDown}
      label={tr(step < 0 ? 'moveItemUp' : 'moveItemDown', { item: option.label })}
      disabled={index + step < 0 || index + step >= picked.length}
      onClick={() => move(index, step)}
    />
  );

  return (
    <fieldset {...common} ref={group} className="field-choices" tabIndex={-1}>
      {listed.map((option, index) => {
        // 带说明的项：名字另起一个 id 作读屏名，说明作描述
        const described = option.description === undefined ? undefined : `${common.id}-${index}`;
        const check = (
          <label className="field-check">
            <input
              ref={keep(0, option.key)}
              type="checkbox"
              aria-labelledby={described && `${described}-name`}
              aria-describedby={described}
              checked={checked(option)}
              onChange={e => {
                touched.current = { key: option.key };
                onChange(toggled(option, e.target.checked));
              }}
            />
            {described ? (
              <span className="field-check-text">
                <span id={`${described}-name`}>{option.label}</span>
                <span id={described} className="field-note">
                  {option.description}
                </span>
              </span>
            ) : (
              option.label
            )}
          </label>
        );
        // 每项包一层，勾选与取消时外层不变，复选框不重挂
        return (
          <div key={option.key} className="field-option">
            {ordered ? (
              <div className="field-ordered">
                {check}
                {keys.has(option.key) && moveButton(option, index, -1)}
                {keys.has(option.key) && moveButton(option, index, 1)}
              </div>
            ) : (
              check
            )}
            {option.members && (
              <Members
                text={tr('optionMembers', { count: option.members.length })}
                label={tr('optionMembersOf', { option: option.label, count: option.members.length })}
                members={option.members}
              />
            )}
          </div>
        );
      })}
      {options.others && (
        <div className="field-others">
          <Members text={options.others.label} members={options.others.members} />
        </div>
      )}
      {field.allowCustom && !everything && (
        <input
          aria-label={tr('addField', { label: field.label })}
          placeholder={tr('addOnePlaceholder')}
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
      {options.error && <p className="field-note">{tr('optionsFailed', { error: options.error.message })}</p>}
    </fieldset>
  );
}

/**
 * 成员的展开：默认收起，点开列出成员的名字；在复选框的 label 之外，点它不改勾选。label 是读屏名（带上它属于哪一项，几个
 * 选项的展开读屏分得开）
 */
function Members({ text, label, members }: { text: string; label?: string; members: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Disclosure expanded={open} onToggle={() => setOpen(!open)} label={label}>
        {text}
      </Disclosure>
      {open && (
        <ul className="field-members">
          {members.map(member => (
            <li key={member}>{member}</li>
          ))}
        </ul>
      )}
    </>
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
      {unreadable && <p className="field-problem">{tr('needNumber')}</p>}
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
      if (at <= 0) throw new Error(tr('mapLineInvalid', { line }));
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
export function linesExpressible(field: Field, value: unknown): boolean {
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
        <p className="field-note">{tr('linesUnexpressible')}</p>
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
        placeholder={placeholder ?? (field.type === 'map' ? tr('mapPlaceholder') : tr('listPlaceholder'))}
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
  /** 标签旁的标记，例如插件配置的「默认」「可按会话设置」 */
  badges?: ReactNode;
  /** 说明与问题下面另放的，例如作者默认的那一句 */
  after?: ReactNode;
  /** 行尾，例如撤销 */
  trailing?: ReactNode;
  /** 控件：拿到 id 与读屏、校验、焦点的属性 */
  children(common: FieldCommon): ReactNode;
}

/** 表单里的一行：标签与「必填」、控件、说明与问题。多选的控件是一组，标签是一段文字，控件组经 aria-labelledby 认它 */
export function FieldRow({ field, problem, autofocus, changed, badges, after, trailing, children }: FieldRowProps) {
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
        {field.required && <span className="field-row-required">{tr('fieldRequired')}</span>}
        {badges}
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
        {after}
      </div>
      {trailing}
    </div>
  );
}
