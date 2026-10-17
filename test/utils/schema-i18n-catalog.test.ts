import { catalogEntries, catalogIssues, checkTexts, defineTexts, resolveText } from '@aalis/schema-i18n';
import { describe, expect, it } from 'vitest';

// ════════════════════════════════════════════════════════════
// 原文字典登记进进程级目录：语言标签规范化、同一 ns 再次登记按键合并并记下冲突；
// checkTexts 给第三方在单测里一行自检。
// ════════════════════════════════════════════════════════════

const entryOf = (ns: string) => catalogEntries().find(entry => entry.ns === ns);

describe('defineTexts', () => {
  it('语言标签过 getCanonicalLocales：规范大小写，非法即抛', () => {
    const t = defineTexts({
      ns: 'test/catalog-canonical',
      language: 'zh-cn',
      source: { a: '甲' },
      locales: { 'EN-us': {} },
    });
    expect(t.language).toBe('zh-CN');
    expect(Object.keys(t.locales)).toEqual(['en-US']);
    expect(entryOf('test/catalog-canonical')).toMatchObject({ v: 1, language: 'zh-CN', source: { a: '甲' } });
    expect(() => defineTexts({ ns: 'test/catalog-bad-language', language: 'zh_CN', source: {} })).toThrow(RangeError);
    expect(() =>
      defineTexts({ ns: 'test/catalog-bad-locale', language: 'en', source: {}, locales: { 'not a tag': {} } }),
    ).toThrow(RangeError);
  });

  it('不存在的键抛错（类型挡得住，这里防 JS 调用方）', () => {
    const t = defineTexts({ ns: 'test/catalog-unknown-key', language: 'en', source: { a: 'A' } });
    expect(() => (t as unknown as (key: string) => unknown)('b')).toThrow(RangeError);
  });
});

describe('进程级目录', () => {
  it('存在 globalThis 的 Symbol.for 槽里，两份包共用', () => {
    defineTexts({ ns: 'test/catalog-shared', language: 'en', source: { a: 'A' } });
    const slot = (globalThis as Record<symbol, { entries: Map<string, unknown> }>)[Symbol.for('aalis.i18n.catalog')];
    expect(slot.entries.get('test/catalog-shared')).toEqual({
      v: 1,
      ns: 'test/catalog-shared',
      language: 'en',
      source: { a: 'A' },
      locales: {},
    });
  });

  it('同一 ns 再次登记按键合并：已有键保留先登记的，新键补入，冲突记进目录', () => {
    const ns = 'test/catalog-merge';
    const first = defineTexts({ ns, language: 'zh-CN', source: { a: '甲', b: '乙' }, locales: { en: { a: 'A' } } });
    const second = defineTexts({
      ns,
      language: 'zh-CN',
      source: { a: '甲', b: '乙（新）', c: '丙' },
      locales: { en: { a: 'A (new)', c: 'C' } },
    });
    expect(entryOf(ns)).toEqual({
      v: 1,
      ns,
      language: 'zh-CN',
      source: { a: '甲', b: '乙', c: '丙' },
      locales: { en: { a: 'A', c: 'C' } },
    });
    expect(catalogIssues().filter(issue => issue.ns === ns)).toEqual([
      { ns, kind: 'source', key: 'b' },
      { ns, kind: 'locale', language: 'en', key: 'a' },
    ]);
    expect(resolveText(second('c'), ['en'])).toBe('C');
    expect(resolveText(second('b'), ['zh-CN'])).toBe('乙');
    expect(resolveText(first('a'), ['en'])).toBe('A');
  });

  it('内容相同的重复登记不记冲突', () => {
    const ns = 'test/catalog-same';
    defineTexts({ ns, language: 'en', source: { a: 'A' } });
    defineTexts({ ns, language: 'en', source: { a: 'A' } });
    expect(catalogIssues().filter(issue => issue.ns === ns)).toEqual([]);
  });

  it('原文语言不同的再次登记不合并，记一条冲突', () => {
    const ns = 'test/catalog-language';
    defineTexts({ ns, language: 'zh-CN', source: { a: '甲' } });
    defineTexts({ ns, language: 'en', source: { a: 'A', b: 'B' } });
    expect(entryOf(ns)?.source).toEqual({ a: '甲' });
    expect(catalogIssues().filter(issue => issue.ns === ns)).toEqual([{ ns, kind: 'language', language: 'en' }]);
  });

  it('catalogIssues 返回副本，改它不影响目录', () => {
    const issues = catalogIssues() as unknown[];
    const before = catalogIssues().length;
    issues.push('x');
    expect(catalogIssues()).toHaveLength(before);
  });
});

describe('checkTexts', () => {
  it('干净的字典没有问题', () => {
    const t = defineTexts({
      ns: 'test/check-clean',
      language: 'zh-CN',
      source: { saved: '已保存 {count, number} 项', query: "搜索词写成 '{query}'" } as const,
      locales: { en: { saved: 'Saved {count, plural, one {# item} other {# items}}', query: "Write '{query}'" } },
    });
    expect(checkTexts(t)).toEqual([]);
  });

  it('报出解析失败、参数不兼容、可疑引号与各语言缺的键', () => {
    const issues = checkTexts({
      ns: 'test/check-dirty',
      language: 'zh-CN',
      source: {
        broken: '{n, plural, one {x}}',
        count: '{count} 项',
        who: '找不到插件「{name}」',
        kind: '{n, number} 个',
        ok: '好',
      },
      locales: {
        en: {
          count: '{count, plural, one {# item} other {# items}}',
          who: "Plugin '{name}' not found",
          kind: '{n, list} and {extra}',
          ok: 'OK {',
        },
        ja: { ok: 'よし' },
      },
    });
    expect(issues).toEqual([
      { kind: 'parse', language: 'zh-CN', key: 'broken' },
      { kind: 'params', language: 'en', key: 'count', params: ['count'] },
      { kind: 'quote', language: 'en', key: 'who' },
      { kind: 'params', language: 'en', key: 'kind', params: ['n', 'extra'] },
      { kind: 'parse', language: 'en', key: 'ok' },
      { kind: 'missing', language: 'en', keys: ['broken'] },
      { kind: 'missing', language: 'ja', keys: ['broken', 'count', 'who', 'kind'] },
    ]);
  });

  it('list 与 list, or 收的都是数组，互相兼容', () => {
    const issues = checkTexts({
      ns: 'test/check-list-or',
      language: 'zh-CN',
      source: { and: '{items, list}', or: '{items, list, or}', both: '{items, list} 或 {items, list, or}' },
      locales: { en: { and: '{items, list, or}', or: '{items, list}', both: '{items, list, or}' } },
    });
    expect(issues).toEqual([]);
  });

  it('原文里同一参数的用法互不相容（既是数又是列表）', () => {
    const issues = checkTexts({
      ns: 'test/check-conflict',
      language: 'zh-CN',
      source: { conflict: '{a, number} 与 {a, list}', fine: '{a} 与 {a, number}' },
      locales: {},
    });
    expect(issues).toEqual([{ kind: 'params', language: 'zh-CN', key: 'conflict', params: ['a'] }]);
  });

  it('反引号里直接写参数：Markdown 出口转义后会显出反斜杠，要写成 {名, code}', () => {
    const issues = checkTexts({
      ns: 'test/check-code',
      language: 'zh-CN',
      source: { at: '完整记录在 `{uri}`。', pair: '- `{category}/{id}` 已停用', ok: '记录在 {uri, code}' },
      locales: { en: { at: 'Full log at {uri}.', pair: '- {category}/{id} disabled', ok: 'Log at `{uri}`' } },
    });
    expect(issues).toEqual([
      { kind: 'code', language: 'zh-CN', key: 'at' },
      { kind: 'code', language: 'zh-CN', key: 'pair' },
      { kind: 'code', language: 'en', key: 'ok' },
    ]);
  });

  it('嵌套不超过 16 层；超过算解析失败', () => {
    const nest = (depth: number) => `${'{s, select, other {'.repeat(depth)}x${'}}'.repeat(depth)}`;
    const domain = (depth: number) => ({
      ns: 'test/check-depth',
      language: 'en',
      source: { deep: nest(depth) },
      locales: {},
    });
    expect(checkTexts(domain(16))).toEqual([]);
    expect(checkTexts(domain(17))).toEqual([{ kind: 'parse', language: 'en', key: 'deep' }]);
  });
});
