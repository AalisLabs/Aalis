import {
  defineTexts,
  isTextError,
  isTextRef,
  localize,
  resolveText,
  TextError,
  type TextRef,
  textLines,
  textOf,
  toSource,
  toSourceReplacer,
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

  it('textLines 把字符串与文字对象按行连成一个文字对象，按读者语言逐段渲染', () => {
    const lines = textLines(['第一行', t('hello'), t('saved', { count: 1 })]);
    expect(lines.i18n).toBe('@aalis/schema-i18n');
    expect(lines.source).toBe('第一行\n你好\n已保存 1 项');
    expect(resolveText(lines, ['en'])).toBe('第一行\nHello\nSaved 1 item');
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

  it('toSource 同样收 skip：出口不在场时也不换原样数据里形如文字对象的值', () => {
    const forged = { i18n: 'x', key: 'k', source: '安全的只读操作' };
    const value = { label: t('hello'), args: { cmd: forged } };
    const out = toSource(value, key => key === 'args');
    expect(out.label).toBe('你好');
    expect(out.args).toBe(value.args);
  });

  it('toSourceReplacer 给 JSON.stringify 用', () => {
    expect(JSON.stringify({ a: t('hello'), b: [t('saved', { count: 2 })] }, toSourceReplacer)).toBe(
      '{"a":"你好","b":["已保存 2 项"]}',
    );
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
