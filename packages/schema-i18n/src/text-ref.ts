/**
 * 文字对象：一句给人看的文字，取自所属包原文字典里的一个键，由出口按读者语言渲染。
 *
 * 纯数据，可序列化、可落盘。`i18n` 是所属包名（字典的 ns），兼作识别标记；`source` 是生成时按原文渲染的整句
 * （原文渲染失败时为原文模板原样），日志、给模型的文字与不认识这个结构的消费者都用它。
 */
export interface TextRef {
  readonly i18n: string;
  readonly key: string;
  readonly params?: Readonly<Record<string, TextParam>>;
  readonly source: string;
}

/** 文字对象的参数值：参数里的文字对象与读者用同一条语言链渲染 */
export type TextParam = string | number | TextRef | readonly (string | number | TextRef)[];

const TEXT_REF_KEYS = new Set(['i18n', 'key', 'params', 'source']);

/**
 * 是不是文字对象：只按形状判（i18n、key、source 是字符串，params 缺省或为普通对象，没有别的键），
 * 从 JSON 读回的、另一份本包产出的都认
 */
export function isTextRef(value: unknown): value is TextRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.i18n !== 'string' || typeof v.key !== 'string' || typeof v.source !== 'string') return false;
  if (v.params !== undefined && (typeof v.params !== 'object' || v.params === null || Array.isArray(v.params))) {
    return false;
  }
  return Object.keys(v).every(key => TEXT_REF_KEYS.has(key));
}

/** 展示值（core 的插件显示名、服务 label 这类 unknown 字段）收窄成文字：字符串与文字对象原样，其余 undefined */
export function asText(value: unknown): string | TextRef | undefined {
  return typeof value === 'string' || isTextRef(value) ? value : undefined;
}

/**
 * 两段文字是不是同一句：有一方是字符串（旧版写的、宿主原样的）时按原文比；文字对象之间按所属包、键与参数认，原文的措辞
 * 变了也还是同一句。参数按结构比：参数键的先后不算，参数里的文字对象同样按包、键与参数认，数组逐个按位置比，
 * 别的值（落盘读回的 null 一类）按 === 比
 */
export function sameText(a: string | TextRef, b: string | TextRef): boolean {
  if (typeof a === 'string' || typeof b === 'string') return toSource(a) === toSource(b);
  if (a.i18n !== b.i18n || a.key !== b.key) return false;
  const left = a.params ?? {};
  const right = b.params ?? {};
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && sameParam(left[key], right[key]))
  );
}

const isList = (value: TextParam): value is readonly (string | number | TextRef)[] => Array.isArray(value);

function sameParam(a: TextParam, b: TextParam): boolean {
  if (isList(a) || isList(b)) {
    return isList(a) && isList(b) && a.length === b.length && a.every((item, i) => sameParam(item, b[i]));
  }
  return isTextRef(a) && isTextRef(b) ? sameText(a, b) : a === b;
}

/** 值里的文字对象换成字符串之后的类型（出口渲染的结果、前端读到的线上类型） */
export type Localized<T> = T extends TextRef
  ? string
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { [K in keyof T]: Localized<T[K]> }
      : T;

/** 出口给 {@link localize} 的跳过判定：为真的属性不进 */
export type LocalizeSkip = (key: string, parent: Readonly<Record<string, unknown>>) => boolean;

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 把值里的文字对象换成 `render(text)`。只进普通对象与数组（类实例原样），没有文字对象的子树原样返回、不复制，
 * 有改动时只复制通往文字对象的那一路。`skip(key, parent)` 为真的属性不进：出口用它避开原样数据
 * （工具参数与结果、审批的逐字参数、用户消息正文），那里形如文字对象的值可能是伪造的。
 */
export function localize<T>(value: T, render: (text: TextRef) => string, skip?: LocalizeSkip): Localized<T> {
  const walk = (v: unknown): unknown => {
    if (typeof v !== 'object' || v === null) return v;
    if (isTextRef(v)) return render(v);
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      v.forEach((item, i) => {
        const next = walk(item);
        if (Object.is(next, item)) return;
        out ??= [...v];
        out[i] = next;
      });
      return out ?? v;
    }
    if (!isPlainObject(v)) return v;
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(v)) {
      if (skip?.(key, v)) continue;
      const next = walk(item);
      if (Object.is(next, item)) continue;
      out ??= { ...v };
      out[key] = next;
    }
    return out ?? v;
  };
  return walk(value) as Localized<T>;
}

/** 值里的文字对象换成 source（生成时的整句）：写日志、交给模型时用 */
export function toSource<T>(value: T): Localized<T> {
  return localize(value, text => text.source);
}

/** 给 `JSON.stringify` 的 replacer：文字对象写成 source */
export function toSourceReplacer(_key: string, value: unknown): unknown {
  return isTextRef(value) ? value.source : value;
}
