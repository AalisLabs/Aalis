import {
  defineLocale,
  defineTexts,
  type Localized,
  type Params,
  type TextArgs,
  type TextRef,
} from '@aalis/schema-i18n';
import { describe, expect, it } from 'vitest';
import { runTscProbe } from '../helpers/tsc-probe.js';

// ════════════════════════════════════════════════════════════
// 类型推参与 Localized。本文件由 tsconfig.test.json 做类型检查（test/architecture/test-types.test.ts 跑它）：
// 正向断言写成 assertType<Equal<…>>()，负向写成 @ts-expect-error——多余的 @ts-expect-error 本身就是错，
// 所以「该报的没报」同样让类型检查失败。
// ════════════════════════════════════════════════════════════

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {}

type Plain = string | number | TextRef;
type List = readonly (string | number | TextRef)[];

describe('Params：按花括号配平的递归下降推参', () => {
  it('普通参数、数量与格式化类型', () => {
    assertType<Equal<Params<'已保存'>, Record<never, never>>>();
    assertType<Equal<Params<'{name} 来了'>, { name: Plain }>>();
    assertType<Equal<Params<'{ name }'>, { name: Plain }>>();
    assertType<Equal<Params<'已保存 {count, number} 项'>, { count: number }>>();
    assertType<
      Equal<
        Params<'{t, date, short} {u, time} {v, datetime, long} {d, duration} {s, size}'>,
        { t: number; u: number; v: number; d: number; s: number }
      >
    >();
    assertType<Equal<Params<'{items, list} / {rows, lines}'>, { items: List; rows: List }>>();
  });

  it('plural 分支里的单词与 =0 分支不算参数，分支里的真参数算', () => {
    assertType<Equal<Params<'Saved {count, plural, one {# item} other {# items}}'>, { count: number }>>();
    assertType<Equal<Params<'Delete {count, plural, =0 {nothing} one {it} other {them}}?'>, { count: number }>>();
    assertType<Equal<Params<'{n, plural, one {in {folder}} other {# in {folder}}}'>, { n: number; folder: Plain }>>();
  });

  it('select 推为分支键的联合并上 string，嵌套三层也认', () => {
    assertType<
      Equal<Params<'{mode, select, sim {模拟盘} real {实盘} other {未知}}'>, { mode: 'sim' | 'real' | (string & {}) }>
    >();
    assertType<
      Equal<
        Params<'{a, select, x {{b, plural, one {#} other {# {c}}}} other {}}'>,
        { a: 'x' | (string & {}); b: number; c: Plain }
      >
    >();
  });

  it('引号：先剥再推', () => {
    assertType<Equal<Params<"Plugin '{name}' not found">, Record<never, never>>>();
    assertType<Equal<Params<"can't find {name}">, { name: Plain }>>();
    assertType<Equal<Params<"it''s {name}">, { name: Plain }>>();
    assertType<Equal<Params<"搜索 '{query}' 的结果 {n, number}">, { n: number }>>();
    assertType<Equal<Params<"'{'{x}'}'">, { x: Plain }>>();
    assertType<Equal<Params<"{n, plural, one {'#'} other {# {x}}}">, { n: number; x: Plain }>>();
    assertType<Equal<Params<"'#' {x}">, { x: Plain }>>();
  });

  it('code 收字符串与数', () => {
    assertType<Equal<Params<'记录在 {uri, code}'>, { uri: string | number }>>();
  });

  it('同名取更具体的类型；参数名限 ASCII 标识符', () => {
    assertType<Equal<Params<'{a} 与 {a, number}'>, { a: number }>>();
    assertType<Equal<Params<'{a, number} 与 {a}'>, { a: number }>>();
    assertType<Equal<Params<'{模拟盘}'>, Record<never, never>>>();
  });

  it('无参数的键不收第二参', () => {
    assertType<Equal<TextArgs<'标题'>, []>>();
    assertType<Equal<TextArgs<'{n, number} 项'>, [params: { n: number }]>>();
  });
});

const SOURCE = {
  saved: '已保存 {count, number} 项',
  title: '标题',
  who: '{name} 来了',
  mode: '{m, select, sim {模拟盘} other {其他}}',
} as const;
type Source = typeof SOURCE;

describe('defineTexts 与 defineLocale', () => {
  it('t() 按键推参', () => {
    const en = defineLocale<Source>()({ saved: 'Saved {count, plural, one {# item} other {# items}}', title: 'Title' });
    const t = defineTexts({ ns: 'test/schema-i18n-types', language: 'zh-CN', source: SOURCE, locales: { en } });
    assertType<Equal<Parameters<typeof t<'saved'>>, [key: 'saved', params: { count: number }]>>();
    expect(t('saved', { count: 3 }).source).toBe('已保存 3 项');
    expect(t('title').source).toBe('标题');
    expect(t('who', { name: t('title') }).source).toBe('标题 来了');
    expect(t('mode', { m: 'sim' }).source).toBe('模拟盘');

    // @ts-expect-error 无参数的键不收第二参
    t('title', {});
    // @ts-expect-error 缺参数
    t('saved');
    // @ts-expect-error 数量参数要数
    t('saved', { count: '3' });
    // @ts-expect-error 多出的参数
    t('title', { extra: 1 });
    // @ts-expect-error 没有这个键
    expect(() => t('nope')).toThrow(RangeError);
  });

  it('内联写的原文同样推参', () => {
    const t = defineTexts({ ns: 'test/schema-i18n-types-inline', language: 'en', source: { hi: 'Hi {name}' } });
    expect(t('hi', { name: 'Ann' }).source).toBe('Hi Ann');
    // @ts-expect-error 内联原文也推出 name
    t('hi');
  });

  it('键是联合类型时要交齐各键的参数', () => {
    const t = defineTexts({ ns: 'test/schema-i18n-types-union', language: 'zh-CN', source: SOURCE });
    const flag = (n: number) => n > 0;
    expect(t(flag(0) ? 'saved' : 'title', { count: 1 }).source).toBe('标题');
    expect(t(flag(0) ? 'saved' : 'who', { count: 1, name: 'x' }).source).toBe('x 来了');
    // @ts-expect-error 联合里有要参数的键
    t(flag(1) ? 'saved' : 'title');
    // @ts-expect-error 缺 who 的 name
    t(flag(1) ? 'saved' : 'who', { count: 1 });
  });

  it('defineLocale：作废与拼错的键、参数不兼容都编译报错，缺的键允许', () => {
    const locale = defineLocale<Source>();
    expect(locale({ saved: 'Saved {count}', who: '{name} came' })).toEqual({
      saved: 'Saved {count}',
      who: '{name} came',
    });
    locale({});
    // @ts-expect-error 拼错的键
    locale({ titel: 'Title' });
    // @ts-expect-error 参数名拼错
    locale({ who: '{nmae} came' });
    // @ts-expect-error select 参数在译文里当数量用
    locale({ mode: '{m, number}' });
    const COUNT = { n: '{count} 项' } as const;
    // @ts-expect-error 原文 {count} 不是数量参数，译文用 plural 不兼容
    defineLocale<typeof COUNT>()({ n: '{count, plural, one {# item} other {# items}}' });
    const loose: string = 'Title';
    // @ts-expect-error 译文不是字面量，核不了参数
    locale({ title: loose });
  });

  it('漏写 as const 的报错写明原因', () => {
    const errors = runTscProbe(`import { defineTexts } from '@aalis/schema-i18n';
const loose = { saved: '已保存 {count} 项' };
defineTexts({ ns: 'probe', language: 'zh-CN', source: loose });
`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('as const');
  });
});

describe('Localized', () => {
  it('Localized 把文字对象换成字符串，其余不动', () => {
    type Produced = {
      a: TextRef;
      b: string | TextRef;
      c: readonly TextRef[];
      d: number;
      e?: TextRef;
      f: { g: TextRef | null };
      h: (x: TextRef) => void;
    };
    assertType<
      Equal<
        Localized<Produced>,
        {
          a: string;
          b: string;
          c: readonly string[];
          d: number;
          e?: string;
          f: { g: string | null };
          h: (x: TextRef) => void;
        }
      >
    >();
  });
});
