import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type I18nService, i18n, outputLanguageFor } from '../../packages/api-i18n/src/index.js';
import { isSessionConfigError, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, provide } from '../../packages/core/src/index.js';
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
import { startSessionManager } from '../fixtures/session-settings.js';
import { withSystemLocale } from '../fixtures/system-locale.js';

// ════════════════════════════════════════════════════════════
// plugin-i18n 的 i18n 服务：两种读者的语言链（会话读者取会话设置，宿主读者与 owner 会话取全局默认层，哪一层都没设时按 en）、
// 按语言链渲染（语言包补缺，escape 与 skip 透传，时间按服务进程的时区）、有文字可用的语言。语言包取自贡献点
// i18n:pack，用时与贡献点对照、变了就重建。会话管理多是只实现两个读口的替身，会话设置 language 的登记与取用用真的会话
// 管理；贡献点用默认提供者（内存里的登记表）
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

/**
 * 会话管理的替身：会话 s1 经 onebot 进来时设了 ['ja', 'en']；全局默认层设了 language（缺省 zh-CN，原样交给 i18n，不先整理）。
 * 会话表是空的（读者的会话都不在表里）；语言设置项的登记收下不管
 */
const sessionsWith = (language: unknown = ['zh-CN']) => ({
  registerSetting: () => () => {},
  getSession: () => undefined,
  resolveConfig: (sessionId: string, platform?: string) =>
    sessionId === 's1' && platform === 'onebot' ? { language: ['ja', 'en'] } : {},
  getLayer: (layer: { scope: string }) => (layer.scope === 'defaults' ? { language } : {}),
  listLayers: () => [{ scope: 'defaults' }],
});
const sessions = sessionsWith();
/** 全局默认层设了日语的会话管理替身：渲染用例按 { host: true } 取日语 */
const japanese = sessionsWith(['ja']);
const host = { host: true } as const;

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

describe('chainOf：两种读者的语言链', () => {
  it('设置的值规范化去重，不是字符串的项丢掉；规范化后一种都没有（不是数组、为空、全不合法）时按 en', async () => {
    const long = 'en-US-u-ca-gregory-co-phonebk-hc-h23-nu-latn';
    const tags = ['zh_CN.UTF-8', 'en-us', long, 'bad tag!', 'zh-CN', 'ja'];
    const chain = async (language: unknown) =>
      (await boot({ sessions: sessionsWith(language) })).svc.chainOf({ host: true });
    expect(await chain(tags)).toEqual(['zh-CN', 'en-US', long, 'ja']);
    expect(await chain([null, 'ja'])).toEqual(['ja']);
    for (const language of ['ja', [], ['bad tag!']]) expect(await chain(language), String(language)).toEqual(['en']);
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

describe('会话设置 language', () => {
  /** 预置在会话表里的房间 */
  const ROOM = 'onebot:bot:group:1';
  /** 真的会话管理（layers 是宿主配置文档里的 sessionConfig，会话表里有房间 ROOM）连同 i18n */
  async function withSessions(layers?: Parameters<typeof startSessionManager>[0]['layers']) {
    const { app, sm } = await startSessionManager({ settings: [], layers, stored: { [ROOM]: storedRoom(ROOM) } });
    apps.push(app);
    await app.plugin(i18nPlugin);
    await app.plugins.idle();
    return { app, sm, svc: app.bind({ i18n }).i18n.use };
  }

  const withSystem = (locale: string, layers?: Parameters<typeof startSessionManager>[0]['layers']) =>
    withSystemLocale(locale, () => withSessions(layers));

  it('列表里的 auto 是服务进程的系统语言（激活时取一次），排在哪里就在哪里生效，与重复项合并', async () => {
    const ja = await withSystem('ja-JP', { defaults: { language: ['zh-CN', 'auto', 'en'] } });
    expect(ja.svc.chainOf({ host: true })).toEqual(['zh-CN', 'ja-JP', 'en']);
    // Docker 里没设 LANG 时 Node 报 en-US：auto 就是英语
    const docker = await withSystem('en-US', { defaults: { language: ['auto', 'zh-CN', 'en'] } });
    expect(docker.svc.chainOf({ host: true })).toEqual(['en-US', 'zh-CN', 'en']);
    const zh = await withSystem('zh-CN', { defaults: { language: ['auto', 'zh-CN', 'en'] } });
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

  it('会话设置收 auto；可选项第一项是「跟随系统（当前：系统语言的自称）」', async () => {
    const { app, sm, svc } = await withSystem('ja-JP');
    await sm.updateSession(ROOM, { config: { language: ['auto', 'en'] } });
    expect(sm.getOwnConfig(ROOM).language).toEqual(['auto', 'en']);
    const first = await firstOption(app);
    expect(first?.value).toBe('auto');
    expect(svc.render(first?.label, { host: true })).toBe('Follow system (currently: 日本語 (日本))');
    await sm.updateLayer({ scope: 'defaults' }, { language: ['zh-CN'] });
    expect(svc.render(first?.label, { host: true })).toBe('跟随系统（当前：日本語 (日本)）');
  });

  it('系统语言是 und（LANG 或 LC_ALL 设成空串）时当作 en-US：跟随系统写 American English，写给模型的语言也是它', async () => {
    const { app, svc } = await withSystem('und', { defaults: { language: ['auto'] } });
    expect(svc.render((await firstOption(app))?.label, host)).toBe('Follow system (currently: American English)');
    expect(outputLanguageFor(app.bind({ i18n }).i18n, host, 'zh-CN')).toBe('American English（en-US）');
  });

  it('登记为有序多选：可选项来自 i18n-languages，显眼程度 common，只适用于房间；规范化后不合法的标签被拒，重复项去掉', async () => {
    const { sm, svc } = await withSessions();
    expect(sm.listSettings().find(setting => setting.key === 'language')).toMatchObject({
      field: { type: 'multiselect', ordered: true, dynamicOptions: 'i18n-languages' },
      appliesTo: ['room'],
      liveOnly: true,
      prominence: 'common',
      plugin: i18nPlugin.name,
    });
    const id = ROOM;
    const refused = await sm.updateSession(id, { config: { language: ['en', 'bad tag!'] } }).catch(err => err);
    expect(isSessionConfigError(refused)).toBe(true);
    expect(svc.render(textOf(refused), { host: true })).toBe(
      'Invalid value for session setting language: bad tag! is not a valid language tag',
    );
    await sm.updateSession(id, { config: { language: ['zh-CN', 'en', 'zh-CN'] } });
    expect(sm.getOwnConfig(id).language).toEqual(['zh-CN', 'en']);
    // 系统写法与读的一侧同一个规范化：收下，读时整理成 zh-CN
    await sm.updateSession(id, { config: { language: ['zh_CN'] } });
    expect(svc.chainOf({ sessionId: id })).toEqual(['zh-CN']);
    const typo = await sm.updateSession(id, { config: { language: [5] } as never }).catch(err => err);
    expect(isSessionConfigError(typo)).toBe(true);
  });

  it('房间读者的语言链取自会话设置（按继承链），host 读者取全局默认层', async () => {
    const { sm, svc } = await withSessions({ defaults: { language: ['zh-CN'] } });
    expect([svc.chainOf({ host: true }), svc.chainOf({ sessionId: ROOM })]).toEqual([['zh-CN'], ['zh-CN']]);
    await sm.updateSession(ROOM, { config: { language: ['en'] } });
    expect(svc.chainOf({ sessionId: ROOM })).toEqual(['en']);
    expect(svc.render(t('hi'), { sessionId: ROOM })).toBe('Hello');
  });

  it('子会话跟根会话：owner 会话与它的子会话按全局默认层（存着的旧值不算），房间的子会话跟着房间，语言不随建子会话复制', async () => {
    const { sm, svc } = await withSessions({ defaults: { language: ['zh-CN'] } });
    const owner = await sm.createSession({ name: '<会话>', config: { language: ['ja'] } });
    expect(svc.chainOf({ sessionId: owner.id })).toEqual(['zh-CN']);
    const task = await sm.createChildSession(owner.id, { config: sm.childConfig(owner.id, 'webui') });
    await sm.updateLayer({ scope: 'defaults' }, { language: ['en'] });
    expect(svc.chainOf({ sessionId: task.id })).toEqual(['en']);

    await sm.updateSession(ROOM, { config: { language: ['ja'] } });
    const roomTask = await sm.createChildSession(ROOM, { config: sm.childConfig(ROOM, 'onebot') });
    expect(sm.getOwnConfig(roomTask.id).language).toBeUndefined();
    await sm.updateSession(ROOM, { config: { language: ['ko'] } });
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
    const { app, svc } = await boot({ hubs: true, sessions: japanese });
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
    app.bind({ provide }).provide.use(sessionManager, japanese as never);
    let seen: string | undefined;
    const reader = definePlugin({
      name: 'test-reader',
      uses: { i18n },
      apply({ i18n }) {
        seen = i18n.use.render(t('hi'), host);
      },
    });
    await app.pluginAll([i18nPlugin, packPlugin('ja', 'ja', 'こんにちは'), reader].map(definition => ({ definition })));
    await app.plugins.idle();
    expect(seen).toBe('こんにちは');
  });

  it('语言包与贡献点一致：运行中交付、撤回，没有插件变动也立即生效', async () => {
    const { app, svc } = await boot({ hubs: true, sessions: sessionsWith(['ko']) });
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
    app.bind({ provide }).provide.use(sessionManager, japanese as never);
    await app.plugin(packPlugin('ok', 'ja', 'こんにちは'));
    await app.plugin(i18nPlugin);
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
