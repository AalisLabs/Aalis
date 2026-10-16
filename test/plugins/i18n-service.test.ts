import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { t as pluginTexts } from '../../packages/plugin-i18n/src/texts.js';
import { checkTexts, defineTexts, fingerprint, type LanguagePack } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// plugin-i18n 的 i18n 服务：三种读者的语言链（哪一层都没设时按 en）、按语言链渲染（语言包补缺，escape 与 skip 透传）、
// 有文字可用的语言。语言包取自贡献点 i18n:pack，用时与贡献点对照、变了就重建。会话管理是只实现两个读口的替身，
// 贡献点用默认提供者（内存里的登记表）
// ════════════════════════════════════════════════════════════

const NS = 'test/i18n-service';
const t = defineTexts({
  ns: NS,
  language: 'zh-CN',
  source: { hi: '你好', md: '**名称**：{name}', when: '{t, datetime, short}' } as const,
  locales: { en: { hi: 'Hello', md: '**Name**: {name}', when: '{t, datetime, short}' } },
});
/** 原文为法语、带德语译文的字典：languages() 的并集要收它的两种语言 */
defineTexts({
  ns: 'test/i18n-service-fr',
  language: 'fr',
  source: { hi: 'Bonjour' },
  locales: { de: { hi: 'Hallo' } },
});

/** 交一个语言包的插件 */
const packPlugin = (id: string, language: string, text: string) =>
  definePlugin({
    name: `test-pack-${id}`,
    uses: { contributions },
    apply({ contributions }) {
      const pack: LanguagePack = { id, language, entries: { [NS]: { hi: { text, from: fingerprint('你好') } } } };
      contributions.use.contribute('i18n:pack', pack);
    },
  });

/** 会话管理的替身：会话 s1 经 onebot 进来时设了 ['ja', 'en']；全局默认层设了 zh-CN */
const sessions = {
  resolveConfig: (sessionId: string, platform?: string) =>
    sessionId === 's1' && platform === 'onebot' ? { language: ['ja', 'en'] } : {},
  getLayer: (layer: { scope: string }) => (layer.scope === 'defaults' ? { language: ['zh-CN'] } : {}),
};

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(options: { hubs?: boolean; sessions?: object } = {}): Promise<{ app: App; svc: I18nService }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  if (options.hubs) await registerHubs(app);
  if (options.sessions) app.bind({ provide }).provide.use(sessionManager, options.sessions as never);
  await app.plugin(i18nPlugin);
  await app.plugins.idle();
  expect(app.plugins.getPlugin(i18nPlugin.name)?.state, 'i18n 未激活').toBe('active');
  return { app, svc: app.bind({ i18n }).i18n.use };
}

describe('chainOf：三种读者的语言链', () => {
  it('languages 读者：规范化去重，最多 8 种；不是字符串的项丢掉，不是数组或为空时按 en', async () => {
    const { svc } = await boot();
    const long = 'en-US-u-ca-gregory-co-phonebk-hc-h23-nu-latn';
    const tags = ['zh_CN.UTF-8', 'en-us', long, 'bad tag!', 'zh-CN', 'ja', 'ko', 'fr', 'de', 'es', 'it'];
    expect(svc.chainOf({ languages: tags })).toEqual(['zh-CN', 'en-US', long, 'ja', 'ko', 'fr', 'de', 'es']);
    expect(svc.chainOf({ languages: [null, 'ja'] as unknown as string[] })).toEqual(['ja']);
    expect(svc.chainOf({ languages: 'ja' as unknown as string[] })).toEqual(['en']);
    expect(svc.chainOf({ languages: [] })).toEqual(['en']);
  });

  it('languages 读者给的列表只看前 32 项：超长的列表不逐项规范化', async () => {
    const { svc } = await boot();
    const junk = Array.from({ length: 32 }, () => 'bad tag!');
    expect(svc.chainOf({ languages: [...junk, 'ja'] })).toEqual(['en']);
    expect(svc.chainOf({ languages: [...junk.slice(1), 'ja'] })).toEqual(['ja']);
  });

  it('sessionId 读者：取会话设置的 language（带上入口平台）；没设的按 en', async () => {
    const { svc } = await boot({ sessions });
    expect(svc.chainOf({ sessionId: 's1', platform: 'onebot' })).toEqual(['ja', 'en']);
    expect(svc.chainOf({ sessionId: 'other' })).toEqual(['en']);
  });

  it('host 读者：取全局默认层的设置', async () => {
    const { svc } = await boot({ sessions });
    expect(svc.chainOf({ host: true })).toEqual(['zh-CN']);
  });

  it('会话管理缺席：会话与宿主读者按 en', async () => {
    const { svc } = await boot();
    expect(svc.chainOf({ sessionId: 's1', platform: 'onebot' })).toEqual(['en']);
    expect(svc.chainOf({ host: true })).toEqual(['en']);
  });
});

describe('render', () => {
  it('escape 与 skip 透传，日期按读者的时区', async () => {
    const { svc } = await boot();
    const forged = { i18n: NS, key: 'hi', source: '伪造' };
    const value = { text: t('md', { name: '_x_' }), when: t('when', { t: 0 }), raw: forged };
    const out = svc.render(
      value,
      { languages: ['en'], timeZone: 'America/New_York' },
      { escape: 'markdown', skip: key => key === 'raw' },
    );
    expect(out).toEqual({ text: '**Name**: \\_x\\_', when: '12/31/69, 7:00 PM', raw: forged });
  });

  it('语言包随贡献它的插件生效，插件停用后重建、不再生效', async () => {
    const { app, svc } = await boot({ hubs: true });
    const reader = { languages: ['ja'] };
    expect(svc.render(t('hi'), reader)).toBe('Hello');
    await app.plugin(packPlugin('ja', 'ja', 'こんにちは'));
    await app.plugins.idle();
    expect(svc.render(t('hi'), reader)).toBe('こんにちは');
    await app.plugins.unload('test-pack-ja');
    await app.plugins.idle();
    expect(svc.render(t('hi'), reader)).toBe('Hello');
  });

  it('语言包与贡献点一致：同一轮里晚于 i18n 激活的包，后面的插件在 apply 里就用得上', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    let seen: string | undefined;
    const reader = definePlugin({
      name: 'test-reader',
      uses: { i18n },
      apply({ i18n }) {
        seen = i18n.use.render(t('hi'), { languages: ['ja'] });
      },
    });
    await app.pluginAll([i18nPlugin, packPlugin('ja', 'ja', 'こんにちは'), reader].map(definition => ({ definition })));
    await app.plugins.idle();
    expect(seen).toBe('こんにちは');
  });

  it('语言包与贡献点一致：运行中交付、撤回，没有插件变动也立即生效', async () => {
    const { app, svc } = await boot({ hubs: true });
    const reader = { languages: ['ko'] };
    const pack: LanguagePack = {
      id: 'ko',
      language: 'ko',
      entries: { [NS]: { hi: { text: '안녕', from: fingerprint('你好') } } },
    };
    const withdraw = app.bind({ contributions }).contributions.use.contribute('i18n:pack', pack);
    expect(svc.render(t('hi'), reader)).toBe('안녕');
    withdraw();
    expect(svc.render(t('hi'), reader)).toBe('Hello');
  });

  it('访问时抛错的语言包跳过，不影响 i18n 与别的包', async () => {
    const app = new App({ name: 'T', logLevel: 'error' });
    apps.push(app);
    await registerHubs(app);
    const broken = { id: 'broken', language: 'ja' } as LanguagePack;
    Object.defineProperty(broken, 'entries', {
      enumerable: true,
      get() {
        throw new Error('访问器抛错');
      },
    });
    app.bind({ contributions }).contributions.use.contribute('i18n:pack', broken);
    await app.plugin(packPlugin('ok', 'ja', 'こんにちは'));
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    expect(app.plugins.getPlugin(i18nPlugin.name)?.state).toBe('active');
    expect(app.bind({ i18n }).i18n.use.render(t('hi'), { languages: ['ja'] })).toBe('こんにちは');
  });
});

describe('languages', () => {
  it('目录里字典的原文语言与译文语言、语言包的语言，去重、按 tag 排序，带自称（取不到用 tag）', async () => {
    const { app, svc } = await boot({ hubs: true });
    await app.plugin(packPlugin('ja', 'ja', 'こんにちは'));
    await app.plugin(packPlugin('greg', 'en-u-ca-gregory', 'Hello'));
    await app.plugins.idle();
    expect(svc.languages()).toEqual([
      { tag: 'de', name: 'Deutsch' },
      { tag: 'en', name: 'English' },
      { tag: 'en-u-ca-gregory', name: 'en-u-ca-gregory' },
      { tag: 'fr', name: 'français' },
      { tag: 'ja', name: '日本語' },
      { tag: 'zh-CN', name: '中文（中国）' },
    ]);
  });
});

it('插件自己的字典没有问题', () => {
  expect(checkTexts(pluginTexts)).toEqual([]);
});
