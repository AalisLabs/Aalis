import {
  defineTexts,
  fingerprint,
  indexPacks,
  type LanguagePack,
  normalizeLanguages,
  resolveText,
  type TextRef,
} from '@aalis/schema-i18n';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 解析与语言链：读者链里逐项找文字相同的 → 语言相同、文字不同的 → en → 原文；
// 命中原文语言就用原文；字典自带译文优先于语言包；ns 或键不在目录、渲染失败时用 text.source。
// ════════════════════════════════════════════════════════════

const NS = 'test/schema-i18n-resolve';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: {
    hi: '你好',
    bye: '再见',
    who: '{name} 来了',
    all: '共有 {items, list}',
    count: '{count} 项',
    md: '**名称**：{name}',
    when: '{t, datetime, short}',
    day: '{t, date, long}',
    twice: '{name} 与 {name}',
  } as const,
  locales: {
    en: {
      hi: 'Hello',
      who: '{name} came',
      all: 'There are {items, list}',
      // 原文 {count} 不是数量参数，这条译文收不下原文交来的字符串：不兼容，不参与选择
      count: '{count, plural, one {# item} other {# items}}',
      md: '**Name**: {name}',
      when: '{t, datetime, short}',
      day: '{t, date, long}',
      twice: '{name} and {name}',
    },
  },
});

const md = { escape: 'markdown' } as const;

/** 英文原文、带简体中文译文的第三方字典 */
const third = defineTexts({
  ns: 'test/schema-i18n-resolve-third',
  language: 'en',
  source: { hi: 'Hello', colour: 'Colour' } as const,
  locales: { 'zh-CN': { hi: '你好' }, 'en-GB': { colour: 'Colour (GB)' } },
});

describe('语言链', () => {
  it.each([
    [['zh'], '你好'],
    [['zh-Hans-CN'], '你好'],
    [['zh-CN', 'en'], '你好'],
    [['zh-SG'], '你好'],
    [['en'], 'Hello'],
    [['en-US'], 'Hello'],
    [['ja'], 'Hello'],
    [[], 'Hello'],
    [['zh-TW'], '你好'],
    [['fr', 'zh-HK'], '你好'],
    [['zh-TW', 'en'], 'Hello'],
  ])('%j → %s', (chain, expected) => {
    expect(resolveText(t('hi'), chain)).toBe(expected);
  });

  it('读者标签先规范化：下划线、编码后缀、大小写；不合法的丢掉', () => {
    expect(resolveText(t('hi'), ['zh_CN.UTF-8'])).toBe('你好');
    expect(resolveText(t('hi'), ['zh-cn'])).toBe('你好');
    expect(resolveText(t('hi'), ['!!', 'zh'])).toBe('你好');
  });

  it('英文原文的字典：zh、zh-Hans-CN 读者拿到 zh-CN 译文', () => {
    expect(resolveText(third('hi'), ['zh'])).toBe('你好');
    expect(resolveText(third('hi'), ['zh-Hans-CN'])).toBe('你好');
    expect(resolveText(third('hi'), ['de'])).toBe('Hello');
  });

  it('同文字内地区相同者优先，都不同时按字典里的先后', () => {
    expect(resolveText(third('colour'), ['en-GB'])).toBe('Colour (GB)');
    expect(resolveText(third('colour'), ['en-AU'])).toBe('Colour');
    expect(resolveText(third('colour'), ['en'])).toBe('Colour');
  });

  it('缺译文的键用原文', () => {
    expect(resolveText(t('bye'), ['en'])).toBe('再见');
  });
});

describe('回落到 source', () => {
  it('ns 不在目录、键不存在时用 text.source', () => {
    expect(resolveText({ i18n: 'test/no-such-ns', key: 'hi', source: '落盘时的原文' }, ['en'])).toBe('落盘时的原文');
    expect(resolveText({ i18n: NS, key: 'removed', source: '落盘时的原文' }, ['en'])).toBe('落盘时的原文');
  });

  it('目录条目的协议版本不认识时用 text.source', () => {
    const catalog = (globalThis as Record<symbol, { entries: Map<string, unknown> }>)[Symbol.for('aalis.i18n.catalog')];
    catalog.entries.set('test/future-version', { v: 2, ns: 'test/future-version' });
    expect(resolveText({ i18n: 'test/future-version', key: 'hi', source: 'S' }, ['en'])).toBe('S');
  });

  it('与原文参数不兼容的译文不参与选择，交来的值碰巧收得下也不用', () => {
    expect(resolveText(t('count', { count: '3' }), ['en'])).toBe('3 项');
    expect(resolveText(t('count', { count: 3 }), ['en'])).toBe('3 项');
  });

  it('渲染失败（落盘记录的参数与模板对不上）时用 source', () => {
    expect(resolveText({ i18n: NS, key: 'all', params: { items: 'x' }, source: '旧' }, ['en'])).toBe('旧');
  });

  it('escape markdown 时回落的 source 整句转义', () => {
    const source = '[点我](https://e.com) *x*';
    const escaped = '\\[点我\\]\\(https://e\\.com\\) \\*x\\*';
    expect(resolveText({ i18n: 'test/no-such-ns', key: 'hi', source }, ['en'], md)).toBe(escaped);
    expect(resolveText({ i18n: NS, key: 'all', params: { items: 'x' }, source }, ['en'], md)).toBe(escaped);
    expect(resolveText(t('who', { name: { i18n: 'test/no-such-ns', key: 'k', source } }), ['en'], md)).toBe(
      `${escaped} came`,
    );
  });

  it('参数里的文字对象嵌套超过 8 层时用那一层的 source：伪造的深层嵌套不放大、环不挂死', () => {
    let forged: TextRef = { i18n: NS, key: 'twice', params: { name: 'x' }, source: 'S' };
    for (let i = 0; i < 30; i++) forged = { i18n: NS, key: 'twice', params: { name: forged }, source: 'S' };
    expect(resolveText(forged, ['en']).length).toBeLessThan(5000);
    const cycle = { i18n: NS, key: 'twice', params: {} as Record<string, TextRef>, source: 'S' };
    cycle.params.name = cycle;
    expect(resolveText(cycle, ['en']).length).toBeLessThan(5000);
  });
});

describe('参数', () => {
  it('参数里的文字对象用同一条链递归', () => {
    expect(resolveText(t('who', { name: t('hi') }), ['en'])).toBe('Hello came');
    expect(resolveText(t('all', { items: [t('hi'), 'x'] }), ['en'])).toBe('There are Hello and x');
    expect(resolveText(t('all', { items: [t('hi'), 'x'] }), ['zh-CN'])).toBe('共有 你好和x');
  });

  it('escape markdown：字符串参数转义，字典里的 Markdown 原样；嵌套文字对象的参数同样转义', () => {
    const name = '[点我](https://e.com) *b*';
    expect(resolveText(t('md', { name }), ['en'], { escape: 'markdown' })).toBe(
      '**Name**: \\[点我\\]\\(https://e\\.com\\) \\*b\\*',
    );
    expect(resolveText(t('who', { name: t('md', { name: '_x_' }) }), ['en'], { escape: 'markdown' })).toBe(
      '**Name**: \\_x\\_ came',
    );
    expect(resolveText(t('md', { name }), ['en'])).toBe(`**Name**: ${name}`);
  });

  it('timeZone 用于日期与时间；不合法的时区算渲染失败', () => {
    expect(resolveText(t('when', { t: 0 }), ['en'], { timeZone: 'UTC' })).toBe('1/1/70, 12:00 AM');
    expect(resolveText(t('when', { t: 0 }), ['en'], { timeZone: 'Asia/Shanghai' })).toBe('1/1/70, 8:00 AM');
    expect(resolveText(t('when', { t: 0 }), ['en'], { timeZone: 'Mars/Base' })).toBe(t('when', { t: 0 }).source);
  });

  it('日期按选中的语言格式化', () => {
    expect(resolveText(t('day', { t: 0 }), ['en'], { timeZone: 'UTC' })).toBe('January 1, 1970');
    expect(resolveText(t('day', { t: 0 }), ['zh-CN'], { timeZone: 'UTC' })).toBe('1970年1月1日');
  });
});

describe('语言包', () => {
  const pack = (id: string, language: string, entries: LanguagePack['entries']): LanguagePack => ({
    id,
    language,
    entries,
  });
  const packs = indexPacks([
    pack('b', 'ja', { [NS]: { hi: { text: 'こんにちは（b）', from: fingerprint('你好') } } }),
    pack('a', 'ja', { [NS]: { hi: { text: 'こんにちは', from: fingerprint('你好') } } }),
    pack('c', 'en', {
      [NS]: { hi: { text: 'Hi (pack)', from: fingerprint('你好') }, bye: { text: 'Bye', from: fingerprint('再见') } },
    }),
    pack('d', 'fr', { [NS]: { hi: { text: 'Salut', from: fingerprint('旧的原文') } } }),
    pack('e', 'not a tag!', { [NS]: { hi: { text: '坏标签', from: fingerprint('你好') } } }),
    pack('f', 'de', { 'test/no-such-ns': { hi: { text: 'Hallo', from: fingerprint('你好') } } }),
  ]);

  it('补字典没有的语言；多个包给同一条时按包名排序取先', () => {
    expect(resolveText(t('hi'), ['ja'], { packs })).toBe('こんにちは');
  });

  it('只补缺：字典自带同语言同键时不生效', () => {
    expect(resolveText(t('hi'), ['en'], { packs })).toBe('Hello');
    expect(resolveText(t('bye'), ['en'], { packs })).toBe('Bye');
  });

  it('from 与当前原文的指纹不符时当作缺失', () => {
    expect(resolveText(t('hi'), ['fr'], { packs })).toBe('Hello');
  });

  it('解析失败的译文不参与选择：坏条目不挡住读者链后面的 en', () => {
    const broken = indexPacks([
      pack('j', 'ja', { [NS]: { who: { text: '{name 来', from: fingerprint('{name} 来了') } } }),
    ]);
    expect(resolveText(t('who', { name: 'X' }), ['ja', 'en'], { packs: broken })).toBe('X came');
  });

  it('形状不对的包跳过，不影响别的包', () => {
    const malformed = [
      { id: 'm1', language: 'ja', entries: undefined },
      { id: 'm2', language: 7, entries: {} },
      { id: 'm3', language: 'ja', entries: { [NS]: null } },
      null,
    ] as unknown as LanguagePack[];
    const mixed = indexPacks([
      ...malformed,
      pack('z', 'ja', { [NS]: { hi: { text: 'やあ', from: fingerprint('你好') } } }),
    ]);
    expect(resolveText(t('hi'), ['ja'], { packs: mixed })).toBe('やあ');
  });

  it('ns 不在目录时语言包也不生效', () => {
    expect(resolveText({ i18n: 'test/no-such-ns', key: 'hi', source: 'S' }, ['de'], { packs })).toBe('S');
  });

  it('指纹：同一原文相同，原文变了就不同', () => {
    expect(fingerprint('你好')).toBe(fingerprint('你好'));
    expect(fingerprint('你好')).not.toBe(fingerprint('你好！'));
    expect(fingerprint('你好')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('normalizeLanguages', () => {
  it('下划线换连字符、去掉编码后缀、规范大小写，不合法的丢掉，去重保序', () => {
    expect(normalizeLanguages(['zh_CN.UTF-8', 'en-us', 'bad tag!', 'C', 'zh-CN', 'EN-US', 'ja'])).toEqual([
      'zh-CN',
      'en-US',
      'ja',
    ]);
  });

  it('不是字符串的项丢掉', () => {
    expect(normalizeLanguages(['zh', null, 7, 'en'] as unknown as string[])).toEqual(['zh', 'en']);
  });
});
