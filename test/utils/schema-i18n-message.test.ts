import { defineTexts, resolveText, type TextRef } from '@aalis/schema-i18n';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 消息格式（ICU 子集）的语义：t() 生成 source 时按原文语言渲染，与出口经 resolveText 渲染走同一套代码。
// 渲染失败一律不抛：t() 的 source 退成原文模板原样，resolveText 退成 text.source。
// 期望值按 Node 24 自带的 ICU 数据写。
// ════════════════════════════════════════════════════════════

const SOURCE = {
  hello: 'Hello {name}',
  port: 'Port {port}',
  number: '{n, number} in total',
  plural: '{n, plural, =0 {none} one {# item} other {# items}}',
  exact: '{n, plural, =1 {exactly one} one {one} other {many}}',
  poundScope: '{n, plural, other {# {s, select, a {#} other {x}}}}',
  poundNested: '{a, plural, other {{b, plural, other {#}} #}}',
  select: '{mode, select, sim {simulated} real {live} other {unknown}}',
  apostrophe: "can't stop {name}",
  quotedArg: "Plugin '{name}' not found",
  doubled: "it''s {name}",
  quotedPound: "{n, plural, other {'#' is #}}",
  poundOutside: "'#' and #",
  poundQuotedBefore: "{n, plural, one {'#'} other {# {x}}}",
  unclosed: "a '{b",
  quotedBraces: "'{'{x}'}'",
  list: '{items, list}',
  lines: '{rows, lines}',
  duration: '{ms, duration}',
  size: '{bytes, size}',
  code: 'Saved to {path, code}',
  missingOther: '{n, plural, one {x}}',
  unbalancedOpen: 'a {name',
  unbalancedClose: 'a } b',
  unknownType: '{x, foo}',
  offset: '{n, plural, offset:1 other {#}}',
  nonAscii: '{模拟盘}',
  duplicate: '{s, select, a {1} a {2} other {3}}',
} as const;

const t = defineTexts({ ns: 'test/schema-i18n-message', language: 'en', source: SOURCE });

const md = { escape: 'markdown' } as const;

const zh = defineTexts({
  ns: 'test/schema-i18n-message-zh',
  language: 'zh-CN',
  source: { list: '{items, list}', duration: '{ms, duration}', size: '{bytes, size}' } as const,
});

describe('参数与类型', () => {
  it('简单参数：字符串原样，数原样转字符串（不按地区分组）', () => {
    expect(t('hello', { name: 'Ann' }).source).toBe('Hello Ann');
    expect(t('port', { port: 8080 }).source).toBe('Port 8080');
  });

  it('number 按语言的 NumberFormat', () => {
    expect(t('number', { n: 1234.5 }).source).toBe('1,234.5 in total');
  });

  it('参数里的文字对象：source 里用它的 source', () => {
    expect(t('hello', { name: t('hello', { name: 'Bob' }) }).source).toBe('Hello Hello Bob');
  });

  it('select 按分支键选，没有对应分支走 other', () => {
    expect(t('select', { mode: 'sim' }).source).toBe('simulated');
    expect(t('select', { mode: 'paper' }).source).toBe('unknown');
  });

  it('select 只收字符串，交来数算渲染失败', () => {
    expect(
      resolveText({ i18n: 'test/schema-i18n-message', key: 'select', params: { mode: 1 }, source: 'S' }, ['en']),
    ).toBe('S');
  });
});

describe('plural', () => {
  it('=N 精确匹配先于类别，类别取 PluralRules', () => {
    expect(t('plural', { n: 0 }).source).toBe('none');
    expect(t('plural', { n: 1 }).source).toBe('1 item');
    expect(t('plural', { n: 1234 }).source).toBe('1,234 items');
    expect(t('exact', { n: 1 }).source).toBe('exactly one');
  });

  it('# 只在直接所在的 plural 分支里替换，嵌在 select 里的是字面', () => {
    expect(t('poundScope', { n: 5, s: 'a' }).source).toBe('5 #');
  });

  it('嵌套 plural 的 # 取最近一层的数', () => {
    expect(t('poundNested', { a: 1, b: 2 }).source).toBe('2 1');
  });
});

describe('引号', () => {
  it("单个撇号是字面：can't", () => {
    expect(t('apostrophe', { name: 'Ann' }).source).toBe("can't stop Ann");
  });

  it("'{name}' 引用成字面，不替换参数", () => {
    expect(t('quotedArg').source).toBe('Plugin {name} not found');
  });

  it("'' 是一个撇号", () => {
    expect(t('doubled', { name: 'Ann' }).source).toBe("it's Ann");
  });

  it("撇号紧跟 # 时开始引用，plural 内外一致：'#' 是字面的 #", () => {
    expect(t('quotedPound', { n: 3 }).source).toBe('# is 3');
    expect(t('poundOutside').source).toBe('# and #');
    expect(t('poundQuotedBefore', { n: 2, x: 'X' }).source).toBe('2 X');
  });

  it('未闭合的引用延续到串尾；引用可以只包住一个花括号', () => {
    expect(t('unclosed').source).toBe('a {b');
    expect(t('quotedBraces', { x: 1 }).source).toBe('{1}');
  });
});

describe('list 与 lines', () => {
  it('list 用 ListFormat 的 conjunction，按语言', () => {
    expect(t('list', { items: ['a', 'b', 'c'] }).source).toBe('a, b, and c');
    expect(zh('list', { items: ['a', 'b', 'c'] }).source).toBe('a、b和c');
  });

  it('lines 按行连接，元素各自渲染', () => {
    expect(t('lines', { rows: ['a', 1, t('hello', { name: 'Ann' })] }).source).toBe('a\n1\nHello Ann');
  });
});

describe('duration', () => {
  it.each([
    [0, '0 sec'],
    [1499, '1 sec'],
    [59_600, '1 min'],
    [90_000, '1 min, 30 sec'],
    [3_599_600, '1 hr'],
    [5_430_000, '1 hr, 31 min'],
    [90_061_000, '1 day, 1 hr'],
    [-90_000, '-1 min, 30 sec'],
    [-300, '0 sec'],
  ])('%d 毫秒 → %s（天时分秒最多两级，按最小一级四舍五入）', (ms, expected) => {
    expect(t('duration', { ms }).source).toBe(expected);
  });

  it('中文按 unit 列表连接', () => {
    expect(zh('duration', { ms: 90_000 }).source).toBe('1分钟30秒');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('%d 不是有限数：渲染失败', ms => {
    expect(t('duration', { ms }).source).toBe(SOURCE.duration);
  });
});

describe('size', () => {
  it.each([
    [0, '0B'],
    [512, '512B'],
    [1536, '1.5kB'],
    [5 * 1024 ** 3, '5GB'],
    [-2048, '-2kB'],
    [1023.6, '1kB'],
    [1_048_575, '1MB'],
    [1024 * 1024 * 1023.96, '1GB'],
  ])('%d 字节 → %s', (bytes, expected) => {
    expect(t('size', { bytes }).source).toBe(expected);
  });

  it('中文', () => {
    expect(zh('size', { bytes: 1536 }).source).toBe('1.5 kB');
  });

  it('NaN 渲染失败', () => {
    expect(t('size', { bytes: Number.NaN }).source).toBe(SOURCE.size);
  });
});

describe('code', () => {
  it('按参数里最长的反引号串选围栏，Markdown 转义时也不加反斜杠', () => {
    expect(t('code', { path: 'a/b.txt' }).source).toBe('Saved to `a/b.txt`');
    expect(t('code', { path: 'a``b' }).source).toBe('Saved to ```a``b```');
    expect(t('code', { path: '`x' }).source).toBe('Saved to `` `x ``');
    expect(t('code', { path: 8080 }).source).toBe('Saved to `8080`');
    expect(resolveText(t('code', { path: 'journal-1.jsonl' }), ['en'], md)).toBe('Saved to `journal-1.jsonl`');
  });

  it('不收文字对象', () => {
    const params = { path: t('hello', { name: 'Ann' }) };
    expect(resolveText({ i18n: 'test/schema-i18n-message', key: 'code', params, source: 'S' }, ['en'])).toBe('S');
  });
});

describe('解析失败与参数不符：不抛，退回', () => {
  it.each([
    ['plural 缺 other', () => t('missingOther', { n: 1 }), SOURCE.missingOther],
    ['花括号没闭合', () => t('unbalancedOpen'), SOURCE.unbalancedOpen],
    ['多出右花括号', () => t('unbalancedClose'), SOURCE.unbalancedClose],
    ['未知类型', () => t('unknownType', { x: 1 }), SOURCE.unknownType],
    ['offset', () => t('offset', { n: 1 }), SOURCE.offset],
    ['参数名不是 ASCII 标识符', () => t('nonAscii'), SOURCE.nonAscii],
    ['重复的分支键', () => t('duplicate', { s: 'a' }), SOURCE.duplicate],
  ])('%s：source 是原文模板原样', (_label, make: () => TextRef, template: string) => {
    const text = make();
    expect(text.source).toBe(template);
    expect(resolveText(text, ['en'])).toBe(template);
  });

  it('数量参数传字符串：plural 与 number 要求有限数', () => {
    const plural = { i18n: 'test/schema-i18n-message', key: 'plural', params: { n: '3' }, source: '旧原文' };
    const number = { i18n: 'test/schema-i18n-message', key: 'number', params: { n: '1,234' }, source: '旧原文' };
    expect(resolveText(plural, ['en'])).toBe('旧原文');
    expect(resolveText(number, ['en'])).toBe('旧原文');
  });

  it('list 与 lines 要求数组，缺参数也算失败', () => {
    expect(
      resolveText({ i18n: 'test/schema-i18n-message', key: 'list', params: { items: 'a' }, source: 'S' }, ['en']),
    ).toBe('S');
    expect(resolveText({ i18n: 'test/schema-i18n-message', key: 'lines', params: {}, source: 'S' }, ['en'])).toBe('S');
    expect(resolveText({ i18n: 'test/schema-i18n-message', key: 'hello', source: 'S' }, ['en'])).toBe('S');
  });
});
