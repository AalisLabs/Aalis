import { afterEach, describe, expect, it, vi } from 'vitest';
import { type I18nService, i18n, localizeFor, outputLanguageFor } from '../../packages/api-i18n/src/index.js';
import { App } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { defineTexts, type LocalizeSkip } from '../../packages/schema-i18n/src/index.js';
import { provideHostLanguage } from '../fixtures/host-language.js';
import { expectProcessTimeZoneDistinct } from '../fixtures/process-time-zone.js';

// ════════════════════════════════════════════════════════════
// localizeFor：出口的统一写法。i18n 在场时交给服务的 render，缺席时按原文语言重新渲染（带转义，时间按服务进程的时区）；
// render 抛错时交给出口的 onError，这次同缺席。各支同一个 skip，原样数据里形如文字对象的值不被换掉。
// outputLanguageFor：写给模型的输出语言，在场时取读者语言链的第一项，缺席时用提示词原文的语言
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
const reader = { sessionId: 's1' };
/** 按原文语言渲染的结果：带转义，时间按服务进程的时区，skip 的子树原样 */
const SOURCE = {
  text: '**名称**：\\_x\\_',
  when: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(0),
  raw: forged,
};

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
    expectProcessTimeZoneDistinct();
    const onError = vi.fn();
    expect(
      localizeFor({ present: false, use: undefined as never }, value, reader, { escape: 'markdown', skip, onError }),
    ).toEqual(SOURCE);
    expect(onError).not.toHaveBeenCalled();
  });

  it('i18n 在场但 render 抛错：抛出的错交给 onError，这次按原文语言渲染，同缺席', () => {
    expectProcessTimeZoneDistinct();
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

describe('outputLanguageFor', () => {
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
  });

  it('i18n 在场：取读者语言链的第一项，写成「自称（标签）」；没有语言包的语言照取', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    const setLanguage = provideHostLanguage(app, ['ja-JP', 'zh-CN']);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    const selection = app.bind({ i18n }).i18n;
    expect(outputLanguageFor(selection, { host: true }, 'zh-CN')).toBe('日本語 (日本)（ja-JP）');
    setLanguage(['en', 'zh-CN']);
    expect(outputLanguageFor(selection, { host: true }, 'zh-CN')).toBe('English（en）');
  });

  it('i18n 缺席：用调用方给的原文语言', () => {
    expect(outputLanguageFor({ present: false, use: undefined as never }, { host: true }, 'zh-CN')).toBe(
      '中文（中国）（zh-CN）',
    );
  });
});
