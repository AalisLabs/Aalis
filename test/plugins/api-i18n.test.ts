import { describe, expect, it, vi } from 'vitest';
import { type I18nService, localizeFor } from '../../packages/api-i18n/src/index.js';
import { defineTexts, type LocalizeSkip } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// localizeFor：出口的统一写法。i18n 在场时交给服务的 render，缺席时按原文语言重新渲染（带读者时区与转义）；
// render 抛错时交给出口的 onError，这次同缺席。各支同一个 skip，原样数据里形如文字对象的值不被换掉
// ════════════════════════════════════════════════════════════

const t = defineTexts({
  ns: 'test/api-i18n',
  language: 'zh-CN',
  source: { md: '**名称**：{name}', when: '{t, datetime, short}' } as const,
  locales: { en: { md: '**Name**: {name}', when: '{t, datetime, short}' } },
});

const skip: LocalizeSkip = key => key === 'raw';
const forged = { i18n: 'test/api-i18n', key: 'md', source: '伪造' };
const value = { text: t('md', { name: '_x_' }), when: t('when', { t: 0 }), raw: forged };
const reader = { languages: ['en'], timeZone: 'America/New_York' };
/** 按原文语言渲染的结果：英文读者也是原文，带读者时区与转义，skip 的子树原样 */
const SOURCE = { text: '**名称**：\\_x\\_', when: '1969/12/31 19:00', raw: forged };

describe('localizeFor', () => {
  it('i18n 在场：交给 render，值、读者与渲染选项原样转交，不调 onError', () => {
    const calls: unknown[][] = [];
    const service: I18nService = {
      render: (value, audience, opts) => {
        calls.push([value, audience, opts]);
        return 'rendered' as never;
      },
      chainOf: () => [],
      languages: () => [],
    };
    const onError = vi.fn();
    expect(localizeFor({ present: true, use: service }, value, reader, { escape: 'markdown', skip, onError })).toBe(
      'rendered',
    );
    expect(calls).toEqual([[value, reader, { escape: 'markdown', skip }]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('i18n 缺席：按原文语言渲染', () => {
    const onError = vi.fn();
    expect(
      localizeFor({ present: false, use: undefined as never }, value, reader, { escape: 'markdown', skip, onError }),
    ).toEqual(SOURCE);
    expect(onError).not.toHaveBeenCalled();
  });

  it('i18n 在场但 render 抛错：抛出的错交给 onError，这次按原文语言渲染，同缺席', () => {
    const broken = new Error('<render 坏了>');
    const service: I18nService = {
      render: () => {
        throw broken;
      },
      chainOf: () => {
        throw broken;
      },
      languages: () => [],
    };
    const onError = vi.fn();
    expect(localizeFor({ present: true, use: service }, value, reader, { escape: 'markdown', skip, onError })).toEqual(
      SOURCE,
    );
    expect(onError.mock.calls).toEqual([[broken]]);
  });
});
