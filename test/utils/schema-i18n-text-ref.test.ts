import {
  asText,
  defineTexts,
  isTextError,
  isTextRef,
  linesOf,
  localize,
  resolveText,
  sameText,
  TextError,
  type TextRef,
  textClauses,
  textLines,
  textOf,
  toSource,
  toSourceReplacer,
  truncateParams,
  withText,
} from '@aalis/schema-i18n';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 文字对象本身：形状判定、换成原文、按出口渲染时的遍历，以及挂文字对象的错误。
// 目录是进程级的，本文件的字典用独有的 ns，不与别的用例相撞。
// ════════════════════════════════════════════════════════════

const SOURCE = { saved: '已保存 {count, number} 项', hello: '你好' } as const;
const t = defineTexts({
  ns: 'test/schema-i18n-text-ref',
  language: 'zh-CN',
  source: SOURCE,
  locales: { en: { saved: 'Saved {count, plural, one {# item} other {# items}}', hello: 'Hello' } },
});

const upper = (text: TextRef) => text.source.toUpperCase();

describe('文字对象', () => {
  it('t() 产出纯数据：所属包、键、参数与按原文渲染的整句；无参数的键不带 params', () => {
    expect(t('saved', { count: 3 })).toEqual({
      i18n: 'test/schema-i18n-text-ref',
      key: 'saved',
      params: { count: 3 },
      source: '已保存 3 项',
    });
    expect(Object.keys(t('hello'))).toEqual(['i18n', 'key', 'source']);
    expect(JSON.parse(JSON.stringify(t('saved', { count: 3 })))).toEqual(t('saved', { count: 3 }));
  });

  it('isTextRef 按四个键的形状判：从 JSON 读回的、另一份包产出的都认', () => {
    expect(isTextRef(JSON.parse(JSON.stringify(t('hello'))))).toBe(true);
    expect(isTextRef({ i18n: 'x', key: 'k', source: 's' })).toBe(true);
    expect(isTextRef({ i18n: 'x', key: 'k', params: { a: 1 }, source: 's' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['字符串', 'x'],
    ['数组', ['x']],
    ['缺 source', { i18n: 'x', key: 'k' }],
    ['source 不是字符串', { i18n: 'x', key: 'k', source: 1 }],
    ['params 不是对象', { i18n: 'x', key: 'k', params: 'a', source: 's' }],
    ['params 是数组', { i18n: 'x', key: 'k', params: [], source: 's' }],
    ['多出别的键', { i18n: 'x', key: 'k', source: 's', extra: 1 }],
  ])('isTextRef 不认%s', (_label, value) => {
    expect(isTextRef(value)).toBe(false);
  });

  it('asText 把展示值收窄成文字：字符串与文字对象原样，其余 undefined', () => {
    const hello = t('hello');
    expect(asText('名')).toBe('名');
    expect(asText(hello)).toBe(hello);
    expect(asText(undefined)).toBeUndefined();
    expect(asText(42)).toBeUndefined();
    expect(asText({ name: 'x' })).toBeUndefined();
  });

  it('textLines 把字符串与文字对象按行连成一个文字对象，按读者语言逐段渲染', () => {
    const lines = textLines(['第一行', t('hello'), t('saved', { count: 1 })]);
    expect(lines.i18n).toBe('@aalis/schema-i18n');
    expect(lines.source).toBe('第一行\n你好\n已保存 1 项');
    expect(resolveText(lines, ['en'])).toBe('第一行\nHello\nSaved 1 item');
  });

  it('linesOf 是 textLines 的逆：textLines 生成的（落盘读回的也算）给出各段，别的文字对象为 undefined', () => {
    const parts = ['第一行', t('hello')];
    expect(linesOf(textLines(parts))).toEqual(parts);
    expect(linesOf(JSON.parse(JSON.stringify(textLines(parts))))).toEqual(parts);
    expect(linesOf(t('hello'))).toBeUndefined();
    expect(linesOf(textClauses(['甲', '乙']))).toBeUndefined();
    expect(
      linesOf({ i18n: '@aalis/schema-i18n', key: 'lines', params: { items: '甲' }, source: '甲' }),
    ).toBeUndefined();
  });

  it('textClauses 把若干分句连成一句：原文以「；」相连，英文以「; 」；几十句也不碰嵌套层数的上限', () => {
    const clauses = textClauses(['甲', t('hello'), t('saved', { count: 1 })]);
    expect(clauses.i18n).toBe('@aalis/schema-i18n');
    expect(clauses.source).toBe('甲；你好；已保存 1 项');
    expect(resolveText(clauses, ['en'])).toBe('甲; Hello; Saved 1 item');
    expect([textClauses([]), textClauses([t('hello')])].map(text => resolveText(text, ['en']))).toEqual(['', 'Hello']);
    expect(resolveText(textClauses(Array.from({ length: 64 }, () => t('hello'))), ['en'])).toBe(
      Array(64).fill('Hello').join('; '),
    );
  });

  it('参数在生成时复制：调用方之后改原数组或原对象，文字对象不变', () => {
    const parts = ['甲'];
    const lines = textLines(parts);
    parts.push('乙');
    expect(resolveText(lines, ['en'])).toBe('甲');
    const params = { count: 1 };
    const saved = t('saved', params);
    params.count = 2;
    expect(resolveText(saved, ['en'])).toBe('Saved 1 item');
  });
});

describe('换成原文', () => {
  it('toSource 把值里的文字对象换成 source', () => {
    expect(toSource(t('hello'))).toBe('你好');
    expect(toSource({ a: [t('hello'), 'x'], b: { c: t('saved', { count: 2 }) }, n: 1 })).toEqual({
      a: ['你好', 'x'],
      b: { c: '已保存 2 项' },
      n: 1,
    });
  });

  it('toSourceReplacer 给 JSON.stringify 用', () => {
    expect(JSON.stringify({ a: t('hello'), b: [t('saved', { count: 2 })] }, toSourceReplacer)).toBe(
      '{"a":"你好","b":["已保存 2 项"]}',
    );
  });
});

describe('是不是同一句', () => {
  /** 落盘读回的文字对象：参数键的先后与生成时不同，source 是旧的措辞 */
  const stored = (text: TextRef, params: Record<string, unknown>): TextRef =>
    ({ ...text, params, source: '<旧的措辞>' }) as TextRef;
  /** 参数 item 取给定值的文字对象 */
  const outer = (item: unknown) => ({ i18n: 'test/x', key: 'k', params: { item }, source: 'x' }) as TextRef;

  it('文字对象之间按所属包、键与参数认：参数键的先后与 source 不算', () => {
    const fresh = t('saved', { count: 2 });
    expect(sameText(fresh, stored(fresh, { count: 2 }))).toBe(true);
    expect(sameText(fresh, t('saved', { count: 3 }))).toBe(false);
    expect(sameText(fresh, { ...fresh, i18n: 'test/other' })).toBe(false);
    expect(sameText(t('hello'), { ...t('hello'), key: 'saved' })).toBe(false);
    expect(sameText(t('hello'), { ...t('hello'), params: {} })).toBe(true);
    const two = { i18n: 'test/x', key: 'k', params: { a: 1, b: 'x' }, source: 'x' };
    expect(sameText(two, { ...two, params: { b: 'x', a: 1 } })).toBe(true);
    expect(sameText(two, { ...two, params: { a: 1 } })).toBe(false);
  });

  it('参数里的文字对象同样按包、键与参数认，数组逐个按位置比', () => {
    const inner = t('saved', { count: 2 });
    expect(sameText(outer(inner), outer(stored(inner, { count: 2 })))).toBe(true);
    expect(sameText(outer(inner), outer(t('saved', { count: 3 })))).toBe(false);
    expect(sameText(outer(inner), outer(inner.source))).toBe(false);
    expect(sameText(outer([inner, 'a', 1]), outer([stored(inner, { count: 2 }), 'a', 1]))).toBe(true);
    expect(sameText(outer(['a', 'b']), outer(['b', 'a']))).toBe(false);
    expect(sameText(outer(['a']), outer(['a', 'a']))).toBe(false);
    expect(sameText(outer(1), outer('1'))).toBe(false);
  });

  it('参数值是 null 一类（手改的状态文件读回的）时按 === 比，不抛', () => {
    expect(sameText(outer(null), outer(t('saved', { count: 2 })))).toBe(false);
    expect(sameText(outer(t('saved', { count: 2 })), outer(null))).toBe(false);
    expect(sameText(outer(null), outer(null))).toBe(true);
    expect(sameText(outer(undefined), outer(false))).toBe(false);
    expect(sameText(outer(true), outer(true))).toBe(true);
  });

  it('有一方是字符串（旧版写的、宿主原样的）时按原文比', () => {
    expect(sameText('你好', '你好')).toBe(true);
    expect(sameText('你好', t('hello'))).toBe(true);
    expect(sameText(t('saved', { count: 2 }), '已保存 3 项')).toBe(false);
  });
});

describe('截参数', () => {
  const cut = defineTexts({
    ns: 'test/schema-i18n-truncate',
    language: 'zh-CN',
    source: { failed: '失败：{error}（第 {n, number} 次）', detail: '原因 {why}', all: '{items, list}' } as const,
    locales: { en: { failed: 'Failed: {error} (attempt {n, number})', detail: 'Reason {why}' } },
  });
  const long = (n: number) => '长'.repeat(n);

  it('字符串参数截到给定的码点数，数原样；source 按截后的参数重新按原文渲染', () => {
    const text = truncateParams(cut('failed', { error: long(300), n: 2 }), 200);
    expect(text).toEqual(cut('failed', { error: long(200), n: 2 }));
    expect(resolveText(text as TextRef, ['en'])).toBe(`Failed: ${long(200)} (attempt 2)`);
  });

  it('参数里的文字对象与列表元素逐个截', () => {
    const text = truncateParams(cut('failed', { error: cut('detail', { why: long(300) }), n: 1 }), 200);
    expect(text).toEqual(cut('failed', { error: cut('detail', { why: long(200) }), n: 1 }));
    const list = truncateParams(cut('all', { items: [long(300), cut('detail', { why: long(300) }), 3] }), 200);
    expect(list).toEqual(cut('all', { items: [long(200), cut('detail', { why: long(200) }), 3] }));
  });

  it('按码点截，不从代理对中间切开', () => {
    const text = truncateParams(cut('detail', { why: `${'x'.repeat(199)}😀${'y'.repeat(50)}` }), 200);
    expect(text).toMatchObject({ params: { why: `${'x'.repeat(199)}😀` } });
  });

  it('没有参数、参数没超长时原样；所属字典不在目录里时 source 也截到给定的码点数，有没有参数都截', () => {
    const hello = t('hello');
    expect(truncateParams(hello, 200)).toBe(hello);
    expect(truncateParams(cut('detail', { why: '短' }), 200)).toEqual(cut('detail', { why: '短' }));
    const foreign = { i18n: 'test/schema-i18n-absent', key: 'k', params: { why: long(300) }, source: long(300) };
    expect(truncateParams(foreign, 200)).toEqual({ ...foreign, params: { why: long(200) }, source: long(200) });
    const bare = { i18n: 'test/schema-i18n-absent', key: 'k', source: long(300) };
    expect(truncateParams(bare, 200)).toEqual({ ...bare, source: long(200) });
  });

  it('截完参数的总字数仍超过给定字数的 16 倍（几百条分句）时，退为截到给定字数的原文字符串；十几条照旧是文字对象', () => {
    const many = textClauses(Array.from({ length: 300 }, () => cut('detail', { why: long(500) })));
    expect(truncateParams(many, 200)).toBe(`原因 ${long(197)}`);
    const some = truncateParams(textClauses(Array.from({ length: 12 }, () => cut('detail', { why: long(500) }))), 200);
    expect(isTextRef(some)).toBe(true);
  });
});

describe('localize', () => {
  it('没有文字对象时原样返回同一引用，不复制', () => {
    const value = { a: [1, { b: 'x' }], c: null, d: undefined };
    expect(localize(value, upper)).toBe(value);
    const list = ['a', 1];
    expect(localize(list, upper)).toBe(list);
    const withNaN = { a: [1, Number.NaN], b: Number.NaN };
    expect(localize(withNaN, upper)).toBe(withNaN);
    expect(localize(withNaN, upper).a).toBe(withNaN.a);
  });

  it('只复制通往文字对象的路径，其余子树与原值共享', () => {
    const keep = { x: 1 };
    const value = { keep, arr: [t('hello'), 'y'], deep: { inner: { label: t('hello') } } };
    const out = localize(value, upper);
    expect(out).toEqual({ keep: { x: 1 }, arr: ['你好', 'y'], deep: { inner: { label: '你好' } } });
    expect(out.keep).toBe(keep);
    expect(value.arr[0]).toEqual(t('hello'));
  });

  it('顶层就是文字对象时直接渲染', () => {
    expect(localize(t('hello'), text => `[${text.key}]`)).toBe('[hello]');
  });

  it('skip 为真的子树不进：原样数据里形如文字对象的值保持原样', () => {
    const forged = { i18n: 'x', key: 'k', source: '（空）', params: { secret: 'payload' } };
    const value = { label: t('hello'), args: { note: forged }, facts: [forged] };
    const out = localize(value, upper, key => key === 'args' || key === 'facts');
    expect(out.label).toBe('你好');
    expect(out.args).toBe(value.args);
    expect(out.facts).toBe(value.facts);
  });

  it('不进类实例：Date 与 Map 原样保留', () => {
    const date = new Date(0);
    const map = new Map([['k', t('hello')]]);
    const value = { date, map, label: t('hello') };
    const out = localize(value, upper);
    expect(out.date).toBe(date);
    expect(out.map).toBe(map);
  });
});

describe('挂文字对象的错误', () => {
  it('TextError：message 是 source，带 status 与 cause', () => {
    const cause = new Error('底层');
    const err = new TextError(t('saved', { count: 2 }), { status: 409, cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TextError');
    expect(err.message).toBe('已保存 2 项');
    expect(err.text.key).toBe('saved');
    expect(err.status).toBe(409);
    expect(err.cause).toBe(cause);
    expect('cause' in new TextError(t('hello'))).toBe(false);
    expect(new TextError(t('hello')).status).toBeUndefined();
  });

  it('withText 给任意 Error 挂上文字对象，保留原 name 与实例', () => {
    class ConfigError extends Error {
      override name = 'ConfigError';
    }
    const original = new ConfigError('配置有误');
    const err = withText(original, t('hello'));
    expect(err).toBe(original);
    expect(err.name).toBe('ConfigError');
    expect(err.message).toBe('配置有误');
    expect(err.text).toEqual(t('hello'));
    expect(isTextError(err)).toBe(true);
  });

  it('isTextError 按结构判：另一份包的 TextError、改了 name 的子类都认', () => {
    class OtherCopyTextError extends Error {
      override name = 'TextError';
      constructor(readonly text: TextRef) {
        super(text.source);
      }
    }
    class Refused extends TextError {
      override name = 'ConfigSaveRefusedError';
    }
    expect(isTextError(new OtherCopyTextError(t('hello')))).toBe(true);
    expect(isTextError(new Refused(t('hello')))).toBe(true);
    expect(isTextError(new Error('x'))).toBe(false);
    expect(isTextError(Object.assign(new Error('x'), { text: 'x' }))).toBe(false);
    expect(isTextError({ name: 'TextError', message: 'x', text: t('hello') })).toBe(false);
    expect(isTextError(undefined)).toBe(false);
  });

  it('textOf：有文字对象取它，否则 message，再否则 String(err)', () => {
    expect(textOf(new TextError(t('hello')))).toEqual(t('hello'));
    expect(textOf(withText(new Error('x'), t('hello')))).toEqual(t('hello'));
    expect(textOf(new Error('出错了'))).toBe('出错了');
    expect(textOf('裸字符串')).toBe('裸字符串');
    expect(textOf(42)).toBe('42');
    expect(textOf(undefined)).toBe('undefined');
  });

  it('textOf：抛出的普通对象取 message；转不成字符串的值不抛', () => {
    expect(textOf({ message: '对象报错' })).toBe('对象报错');
    expect(textOf(Object.create(null))).toBe('[object Object]');
  });
});
