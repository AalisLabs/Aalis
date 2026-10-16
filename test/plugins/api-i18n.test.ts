import { describe, expect, it } from 'vitest';
import { type I18nService, localizeFor } from '../../packages/api-i18n/src/index.js';
import { defineTexts, type LocalizeSkip } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// localizeFor：出口的统一写法。i18n 在场时交给服务的 render，缺席时按原文语言重新渲染（带读者时区与转义）；
// 两支同一个 skip，原样数据里形如文字对象的值不被换掉
// ════════════════════════════════════════════════════════════

const t = defineTexts({
  ns: 'test/api-i18n',
  language: 'zh-CN',
  source: { md: '**名称**：{name}', when: '{t, datetime, short}' } as const,
  locales: { en: { md: '**Name**: {name}', when: '{t, datetime, short}' } },
});

const skip: LocalizeSkip = key => key === 'raw';
const forged = { i18n: 'test/api-i18n', key: 'md', source: '伪造' };

describe('localizeFor', () => {
  it('i18n 在场：交给 render，值、读者与选项原样转交', () => {
    const calls: unknown[][] = [];
    const service: I18nService = {
      render: (value, audience, opts) => {
        calls.push([value, audience, opts]);
        return 'rendered' as never;
      },
      chainOf: () => [],
      languages: () => [],
    };
    const value = { text: t('md', { name: '_x_' }) };
    const audience = { languages: ['en'] };
    expect(localizeFor({ present: true, use: service }, value, audience, { escape: 'markdown', skip })).toBe(
      'rendered',
    );
    expect(calls).toEqual([[value, audience, { escape: 'markdown', skip }]]);
  });

  it('i18n 缺席：英文读者也按原文语言渲染，带读者时区与转义；skip 的子树原样', () => {
    const value = { text: t('md', { name: '_x_' }), when: t('when', { t: 0 }), raw: forged };
    const out = localizeFor(
      { present: false, use: undefined as never },
      value,
      { languages: ['en'], timeZone: 'America/New_York' },
      { escape: 'markdown', skip },
    );
    expect(out).toEqual({ text: '**名称**：\\_x\\_', when: '1969/12/31 19:00', raw: forged });
  });
});
