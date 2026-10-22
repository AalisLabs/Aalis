import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type I18nService, i18n, outputLanguageFor } from '../../packages/api-i18n/src/index.js';
import { isSessionSettingsError } from '../../packages/api-session-settings/src/index.js';
import { App, definePlugin } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { t as pluginTexts } from '../../packages/plugin-i18n/src/texts.js';
import {
  checkTexts,
  defineTexts,
  fingerprint,
  type LanguagePack,
  textOf,
} from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { expectProcessTimeZoneDistinct } from '../fixtures/process-time-zone.js';
import { storedRoom } from '../fixtures/rooms.js';
import { sessionValuesPlugin, startSettings } from '../fixtures/session-settings.js';
import { withSystemLocale } from '../fixtures/system-locale.js';

// ════════════════════════════════════════════════════════════
// plugin-i18n 的 i18n 服务：两种读者的语言链（会话读者按会话设置的 language，宿主读者取全局层即本插件配置里的 language，
// 哪一层都没设时按作者默认 en）、按语言链渲染（语言包补缺，escape 与 skip 透传，时间按服务进程的时区）、有文字可用的语言。
// 语言包取自贡献点 i18n:pack，用时与贡献点对照、变了就重建。会话设置与会话管理都不在时语言照样取本插件配置。按会话的
// 取用用真的会话管理与会话设置，或只给各会话本会话层的会话设置替身；贡献点用默认提供者（内存里的登记表）
// ════════════════════════════════════════════════════════════

const I18N = i18nPlugin.name;
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

const host = { host: true } as const;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * 没有宿主文档的 i18n：language 给了就写进本插件配置（全局层）；sessions 给了就装只给各会话本会话层的会话设置替身
 */
async function boot(
  options: { hubs?: boolean; language?: unknown; sessions?: Record<string, Record<string, unknown>> } = {},
): Promise<{ app: App; svc: I18nService }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  if (options.hubs) await registerHubs(app);
  if (options.sessions) await app.plugin(sessionValuesPlugin(options.sessions));
  await app.plugin(i18nPlugin, options.language === undefined ? {} : { language: options.language });
  await app.plugins.idle();
  expect(app.plugins.getPlugin(I18N)?.state, 'i18n 未激活').toBe('active');
  return { app, svc: app.bind({ i18n }).i18n.use };
}

describe('chainOf：两种读者的语言链', () => {
  it('全局层的语言规范化去重；写坏了（不是数组、有非字符串的项、有不合法的标签）按作者默认 en，空列表同样按 en', async () => {
    const long = 'en-US-u-ca-gregory-co-phonebk-hc-h23-nu-latn';
    const chain = async (language: unknown) => (await boot({ language })).svc.chainOf(host);
    expect(await chain(['zh_CN.UTF-8', 'en-us', long, 'zh-CN', 'ja'])).toEqual(['zh-CN', 'en-US', long, 'ja']);
    for (const language of ['ja', [null, 'ja'], ['bad tag!'], []]) {
      expect(await chain(language), JSON.stringify(language)).toEqual(['en']);
    }
  });

  it('sessionId 读者按会话取（带上入口平台）；会话上没设的按全局层', async () => {
    const { svc } = await boot({ language: ['zh-CN'], sessions: { s1: { language: ['ja', 'en'] } } });
    expect(svc.chainOf({ sessionId: 's1', platform: 'onebot' })).toEqual(['ja', 'en']);
    expect(svc.chainOf({ sessionId: 'other' })).toEqual(['zh-CN']);
  });

  it('host 读者取全局层，即本插件配置里的语言', async () => {
    const { svc } = await boot({ language: ['zh-CN'], sessions: { s1: { language: ['ja'] } } });
    expect(svc.chainOf(host)).toEqual(['zh-CN']);
  });

  it('会话设置与会话管理都不在：会话与宿主读者都按本插件配置里的语言；配置里没写时按作者默认 en', async () => {
    const { svc } = await boot({ language: ['ja'] });
    expect([svc.chainOf({ sessionId: 's1', platform: 'onebot' }), svc.chainOf(host)]).toEqual([['ja'], ['ja']]);
    expect((await boot()).svc.chainOf(host)).toEqual(['en']);
  });
});

describe('按会话设的 language', () => {
  /** 预置在会话表里的房间 */
  const ROOM = 'onebot:bot:group:1';
  /** 真的会话管理与会话设置（会话表里有房间 ROOM），i18n 按宿主文档登记；language 写进本插件的配置段 */
  async function withSessions(language?: string[]) {
    const started = await startSettings({
      doc: language ? { plugins: { [I18N]: { language } } } : {},
      stored: { [ROOM]: storedRoom(ROOM) },
      fields: [i18nPlugin],
    });
    apps.push(started.app);
    const svc = started.app.bind({ i18n }).i18n.use;
    const set = (sessionId: string, value: unknown) =>
      started.admin.update({ sessionId }, { plugin: I18N, key: 'language', value });
    const setGlobal = (value: unknown) =>
      started.admin.update({ layer: { scope: 'global' } }, { plugin: I18N, key: 'language', value });
    return { ...started, svc, set, setGlobal };
  }

  const withSystem = (locale: string, language?: string[]) => withSystemLocale(locale, () => withSessions(language));

  it('字段：有序多选，可选项来自 i18n-languages，common，只适用于房间，1 级可改，作者默认 en', () => {
    expect((i18nPlugin.configSchema as Record<string, unknown>).language).toMatchObject({
      type: 'multiselect',
      ordered: true,
      dynamicOptions: 'i18n-languages',
      default: ['en'],
      session: { appliesTo: ['room'], prominence: 'common', minLevel: 1 },
    });
  });

  it('列表里的 auto 是服务进程的系统语言（激活时取一次），排在哪里就在哪里生效，与重复项合并', async () => {
    const ja = await withSystem('ja-JP', ['zh-CN', 'auto', 'en']);
    expect(ja.svc.chainOf(host)).toEqual(['zh-CN', 'ja-JP', 'en']);
    // Docker 里没设 LANG 时 Node 报 en-US：auto 就是英语
    const docker = await withSystem('en-US', ['auto', 'zh-CN', 'en']);
    expect(docker.svc.chainOf(host)).toEqual(['en-US', 'zh-CN', 'en']);
    const zh = await withSystem('zh-CN', ['auto', 'zh-CN', 'en']);
    expect(zh.svc.chainOf({ sessionId: ROOM })).toEqual(['zh-CN', 'en']);
  });

  /** 可选项来源 i18n-languages 的第一项 */
  const firstOption = async (app: App) => {
    const source = app
      .bind({ contributions })
      .contributions.use.collect('webui:options')
      .find(handle => handle.spec.id === 'i18n-languages')?.spec;
    const [first] = (await source?.list()) ?? [];
    return first;
  };

  it('收 auto；可选项第一项是「跟随系统（当前：系统语言的自称）」，按全局层的语言显示', async () => {
    const { app, admin, svc, set, setGlobal } = await withSystem('ja-JP');
    await set(ROOM, ['auto', 'en']);
    expect(admin.rows({ sessionId: ROOM }).find(row => row.key === 'language')?.value).toEqual(['auto', 'en']);
    const first = await firstOption(app);
    expect(first?.value).toBe('auto');
    expect(svc.render(first?.label, host)).toBe('Follow system (currently: 日本語 (日本))');
    await setGlobal(['zh-CN']);
    expect(svc.render(first?.label, host)).toBe('跟随系统（当前：日本語 (日本)）');
  });

  it('系统语言是 und（LANG 或 LC_ALL 设成空串）时当作 en-US：跟随系统写 American English，写给模型的语言也是它', async () => {
    const { app, svc } = await withSystem('und', ['auto']);
    expect(svc.render((await firstOption(app))?.label, host)).toBe('Follow system (currently: American English)');
    expect(outputLanguageFor(app.bind({ i18n }).i18n, host, 'zh-CN')).toBe('American English（en-US）');
  });

  it('规范化后不合法的标签与不是字符串的项被拒，重复项去掉，系统写法收下、读时整理', async () => {
    const { admin, svc, set } = await withSessions();
    const refused = await set(ROOM, ['en', 'bad tag!']).catch(err => err);
    expect(isSessionSettingsError(refused)).toBe(true);
    expect(svc.render(textOf(refused), host)).toBe('Invalid value for language: bad tag! is not a valid language tag');
    await set(ROOM, ['zh-CN', 'en', 'zh-CN']);
    expect(admin.rows({ sessionId: ROOM }).find(row => row.key === 'language')?.value).toEqual(['zh-CN', 'en']);
    await set(ROOM, ['zh_CN']);
    expect(svc.chainOf({ sessionId: ROOM })).toEqual(['zh-CN']);
    expect(isSessionSettingsError(await set(ROOM, [{}]).catch(err => err))).toBe(true);
  });

  it('房间读者按房间解析，host 读者取全局层', async () => {
    const { svc, set } = await withSessions(['zh-CN']);
    expect([svc.chainOf(host), svc.chainOf({ sessionId: ROOM })]).toEqual([['zh-CN'], ['zh-CN']]);
    await set(ROOM, ['en']);
    expect([svc.chainOf(host), svc.chainOf({ sessionId: ROOM })]).toEqual([['zh-CN'], ['en']]);
    expect(svc.render(t('hi'), { sessionId: ROOM })).toBe('Hello');
  });

  it('子会话跟根会话：owner 会话与它的子会话只取全局层，房间的子会话跟着房间', async () => {
    const { sm, svc, set, setGlobal } = await withSessions(['zh-CN']);
    const owner = await sm.createSession({ name: '<会话>' }, { createdFrom: 'webui' });
    expect(isSessionSettingsError(await set(owner.id, ['ja']).catch(err => err)), '不适用于 owner 的会话').toBe(true);
    const task = await sm.createChildSession(owner.id, {});
    expect(svc.chainOf({ sessionId: task.id })).toEqual(['zh-CN']);
    await setGlobal(['en']);
    expect([svc.chainOf({ sessionId: owner.id }), svc.chainOf({ sessionId: task.id })]).toEqual([['en'], ['en']]);

    await set(ROOM, ['ja']);
    const roomTask = await sm.createChildSession(ROOM, {});
    expect(svc.chainOf({ sessionId: roomTask.id })).toEqual(['ja']);
    await set(ROOM, ['ko']);
    expect(svc.chainOf({ sessionId: roomTask.id })).toEqual(['ko']);
  });
});

describe('render', () => {
  it('escape 与 skip 透传，日期按服务进程的时区', async () => {
    expectProcessTimeZoneDistinct();
    const { svc } = await boot();
    const forged = { i18n: NS, key: 'hi', source: '伪造' };
    const value = { text: t('md', { name: '_x_' }), when: t('when', { t: 0 }), raw: forged };
    const out = svc.render(value, host, { escape: 'markdown', skip: key => key === 'raw' });
    const when = new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'short' }).format(0);
    expect(out).toEqual({ text: '**Name**: \\_x\\_', when, raw: forged });
  });

  it('语言包随贡献它的插件生效，插件停用后重建、不再生效', async () => {
    const { app, svc } = await boot({ hubs: true, language: ['ja'] });
    expect(svc.render(t('hi'), host)).toBe('Hello');
    await app.plugin(packPlugin('ja', 'ja', 'こんにちは'));
    await app.plugins.idle();
    expect(svc.render(t('hi'), host)).toBe('こんにちは');
    await app.plugins.unload('test-pack-ja');
    await app.plugins.idle();
    expect(svc.render(t('hi'), host)).toBe('Hello');
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
        seen = i18n.use.render(t('hi'), host);
      },
    });
    await app.pluginAll([
      { definition: i18nPlugin, config: { language: ['ja'] } },
      ...[packPlugin('ja', 'ja', 'こんにちは'), reader].map(definition => ({ definition })),
    ]);
    await app.plugins.idle();
    expect(seen).toBe('こんにちは');
  });

  it('语言包与贡献点一致：运行中交付、撤回，没有插件变动也立即生效', async () => {
    const { app, svc } = await boot({ hubs: true, language: ['ko'] });
    const pack: LanguagePack = {
      id: 'ko',
      language: 'ko',
      entries: { [NS]: { hi: { text: '안녕', from: fingerprint('你好') } } },
    };
    const withdraw = app.bind({ contributions }).contributions.use.contribute('i18n:pack', pack);
    expect(svc.render(t('hi'), host)).toBe('안녕');
    withdraw();
    expect(svc.render(t('hi'), host)).toBe('Hello');
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
    await app.plugin(i18nPlugin, { language: ['ja'] });
    await app.plugins.idle();
    expect(app.plugins.getPlugin(i18nPlugin.name)?.state).toBe('active');
    expect(app.bind({ i18n }).i18n.use.render(t('hi'), host)).toBe('こんにちは');
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
