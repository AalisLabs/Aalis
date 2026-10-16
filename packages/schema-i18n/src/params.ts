// 从原文模板推出 t() 的参数类型。与运行时的解析器同一套文法：按花括号配平递归下降，只在 { } , 处跳转；
// 只认消息层的 {名} 与 {名, 类型…}，plural 与 select 的分支体递归进去，分支键与分支里的单词不算参数；引号先剥。
import type { TextRef } from './text-ref.js';

/** 普通参数（{name}）收的值 */
type Plain = string | number | TextRef;
/** list 与 lines 收的值 */
type List = readonly (string | number | TextRef)[];

type Space = ' ' | '\t' | '\n' | '\r';
type TrimStart<S extends string> = S extends `${Space}${infer R}` ? TrimStart<R> : S;
type TrimEnd<S extends string> = S extends `${infer R}${Space}` ? TrimEnd<R> : S;
type Trim<S extends string> = TrimEnd<TrimStart<S>>;

// 参数名限 ASCII 标识符，与运行时一致：分支外误写的 {模拟盘} 是解析错误，不推成参数
type Chars<S extends string, Found = never> = S extends `${infer C}${infer R}` ? Chars<R, Found | C> : Found;
type NameHead = Chars<'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_'>;
type NameTail = NameHead | Chars<'0123456789'>;
type IsTail<S extends string> = S extends `${infer C}${infer R}` ? (C extends NameTail ? IsTail<R> : false) : true;
type IsName<S extends string> = S extends `${infer C}${infer R}` ? (C extends NameHead ? IsTail<R> : false) : false;

// 引号：'' 是一个撇号；' 紧跟 {、} 或 # 时引用到下一个单独的 '（引用里的 '' 仍是撇号），没闭合就到串尾
type SkipQuoted<S extends string> = S extends `${string}'${infer R}`
  ? R extends `'${infer R2}`
    ? SkipQuoted<R2>
    : R
  : '';
type StripQuotes<S extends string, Done extends string = ''> = S extends `${infer A}'${infer B}`
  ? B extends `'${infer R}`
    ? StripQuotes<R, `${Done}${A}`>
    : B extends `${'{' | '}' | '#'}${string}`
      ? StripQuotes<SkipQuoted<B>, `${Done}${A}`>
      : StripQuotes<B, `${Done}${A}`>
  : `${Done}${S}`;

// 同名参数取更具体的类型：普通参数让位给数量、列表与 select
type IsPlain<T> = [T] extends [Plain] ? ([Plain] extends [T] ? true : false) : false;
type Merge<A, B> = IsPlain<A> extends true ? B : IsPlain<B> extends true ? A : A & B;
type Add<P, N extends string, T> =
  IsName<N> extends true
    ? { [K in keyof P | N]: K extends N ? (K extends keyof P ? Merge<P[K], T> : T) : K extends keyof P ? P[K] : never }
    : P;

type NumberType = 'plural' | 'number' | 'date' | 'time' | 'datetime' | 'duration' | 'size';
type ListType = 'list' | 'lines';
type TypeOf<T extends string> = T extends NumberType
  ? number
  : T extends ListType
    ? List
    : T extends 'code'
      ? string | number
      : Plain;

/** 消息体：读到串尾或第一个没配平的 }，得 [参数, } 之后的剩余] */
type ParseMessage<S extends string, P> = S extends `${infer Before}{${infer After}`
  ? Before extends `${string}}${infer Rest}`
    ? [P, `${Rest}{${After}`]
    : ParseArgument<After, P>
  : S extends `${string}}${infer Rest}`
    ? [P, Rest]
    : [P, ''];

/** { 之后：不带逗号的是普通参数，带逗号的按类型往下读 */
type ParseArgument<S extends string, P> = S extends `${infer Head}}${infer Rest}`
  ? Head extends `${infer Name},${infer Spec}`
    ? ParseTyped<Trim<Name>, `${Spec}}${Rest}`, P>
    : ParseMessage<Rest, Add<P, Trim<Head>, Plain>>
  : [P, ''];

type ParseTyped<N extends string, S extends string, P> = S extends `${infer Head}}${infer Rest}`
  ? Head extends `${infer Type},${infer Spec}`
    ? Trim<Type> extends 'plural'
      ? ParseBranches<`${Spec}}${Rest}`, Add<P, N, number>, never> extends [infer P2, string, infer R2 extends string]
        ? ParseMessage<R2, P2>
        : never
      : Trim<Type> extends 'select'
        ? ParseBranches<`${Spec}}${Rest}`, P, never> extends [infer P2, infer K extends string, infer R2 extends string]
          ? ParseMessage<R2, Add<P2, N, Exclude<K, 'other'> | (string & {})>>
          : never
        : ParseMessage<Rest, Add<P, N, TypeOf<Trim<Type>>>>
    : ParseMessage<Rest, Add<P, N, TypeOf<Trim<Head>>>>
  : [P, ''];

/** 分支：「选择子 {消息}」若干，读到收尾的 } 回到外层，得 [参数, 选择子, } 之后的剩余] */
type ParseBranches<S extends string, P, K extends string> =
  TrimStart<S> extends `}${infer Rest}`
    ? [P, K, Rest]
    : S extends `${infer Key}{${infer Body}`
      ? ParseMessage<Body, P> extends [infer P2, infer R2 extends string]
        ? ParseBranches<R2, P2, K | Trim<Key>>
        : never
      : [P, K, ''];

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * 原文模板推出的参数：plural、number、date、time、datetime、duration、size 为 number，list、lines 为数组，
 * select 为分支键的联合并上 string，code 为 `string | number`，其余为 `string | number | TextRef`
 */
export type Params<M extends string> = Simplify<ParseMessage<StripQuotes<M>, Record<never, never>>[0]>;

/** 几个模板参数的交集：键是联合类型（三元选键）时要交齐各键的参数 */
type AllParams<M extends string> = (M extends unknown ? (params: Params<M>) => void : never) extends (
  params: infer P,
) => void
  ? P
  : never;

/** t() 在键之后收的参数：没有参数的键不收第二参 */
export type TextArgs<M extends string> = keyof AllParams<M> extends never ? [] : [params: Simplify<AllParams<M>>];
