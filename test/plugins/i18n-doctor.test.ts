import { afterEach, describe, expect, it } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type CheckResult, type DoctorService, doctor } from '../../packages/api-doctor/src/index.js';
import type { AalisConfig } from '../../packages/api-host-config/src/index.js';
import { i18n } from '../../packages/api-i18n/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { type App, definePlugin, provide, services } from '../../packages/core/src/index.js';
import doctorPlugin from '../../packages/plugin-doctor/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { fingerprint } from '../../packages/schema-i18n/src/index.js';
import { pageHost } from '../fixtures/page-host.js';
import { startSettings } from '../fixtures/session-settings.js';
import { withSystemLocale } from '../fixtures/system-locale.js';

// ════════════════════════════════════════════════════════════
// plugin-i18n 的诊断 i18n.languages：各层（全局即本插件配置、平台档、平台类型档、场所）写的语言列表里有没有任何字典或
// 语言包提供的语言（含跟随系统解析出的）时给 warn，写明是哪一层、实际用的语言与怎么办；都有提供时给 ok。结论与详情是本插件
// 字典的文字对象，出口按读者语言渲染。同一份结论另进 WebUI 的「需要处理」：激活时、会话设置或宿主配置变了、插件变了（语言包
// 随之交付或撤回）时重算，都有提供时撤回。本文件的进程里只有第一方字典（中文原文、英文译文），没有语言包
// ════════════════════════════════════════════════════════════

const I18N = i18nPlugin.name;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/**
 * 真的会话管理与会话设置、i18n 与诊断，WebUI 是页面测试台；language 是本插件配置里的语言，sessionConfig 是宿主配置文档里的
 * 那一段；系统语言固定成 system
 */
async function boot(
  system: string,
  {
    language,
    sessionConfig,
    places,
  }: {
    language?: string[];
    sessionConfig?: AalisConfig['sessionConfig'];
    places?: Record<string, Record<string, unknown>>;
  },
) {
  const pages = pageHost();
  const webui = definePlugin({
    name: 'zz-webui',
    provides: [webuiServer],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(webuiServer, pages.service);
    },
  });
  const started = await withSystemLocale(system, () =>
    startSettings({
      doc: { ...(language ? { plugins: { [I18N]: { language } } } : {}), sessionConfig },
      places,
      first: [webui],
      fields: [i18nPlugin, doctorPlugin],
    }),
  );
  apps.push(started.app);
  const registry = started.app.bind({ services }).services.use.get(doctor) as DoctorService;
  const svc = started.app.bind({ i18n }).i18n.use;
  const check = async (): Promise<CheckResult[]> =>
    (await registry.runChecks()).checks.filter(result => result.id === 'i18n.languages');
  /** 本插件登记在「需要处理」的提示，按全局层的语言渲染 */
  const notices = () =>
    pages
      .notices()
      .filter(notice => notice.instance === I18N)
      .map(({ id, level, title, detail }) => svc.render({ id, level, title, detail }, { host: true }));
  const setGlobal = (value: string[]) =>
    started.admin.update({ layer: { scope: 'global' } }, { plugin: I18N, key: 'language', value });
  return { ...started, svc, check, notices, setGlobal };
}

describe('诊断 i18n.languages', () => {
  it('语言列表里有没有插件提供的语言时 warn：跟随系统与写明的各一条，结论按读者语言渲染', async () => {
    const { svc, check, setGlobal } = await boot('ja-JP', { language: ['auto', 'zh-CN', 'en'] });
    const [auto, ...rest] = await check();
    expect(rest).toEqual([]);
    expect(auto).toMatchObject({ category: 'config', level: 'warn' });
    expect(svc.render(auto.message, { host: true })).toBe(
      '跟随系统当前是 日本語 (日本)，没有插件提供，实际用 中文（中国）',
    );
    expect(svc.render(auto.detail, { host: true })).toBe(
      '装上提供这种语言的语言包（在插件市场或 npm 按关键词 aalis-lang-ja-jp或aalis-lang-ja 找），或在会话设置的全局（插件配置）里调整「语言」列表',
    );

    await setGlobal(['ja', 'en']);
    const [named] = await check();
    expect(named.level).toBe('warn');
    expect(svc.render(named.message, { host: true })).toBe(
      '日本語 in the language list is not provided by any plugin; English is used instead',
    );
    expect(svc.render(named.detail, { host: true })).toBe(
      'Install a language pack that provides it (search the plugin market or npm for the keyword aalis-lang-ja), or adjust the “Language” list in the session settings for Global (plugin config)',
    );
  });

  it('列表里的语言都有插件提供时 ok：跟随系统解析出的 en-US 按基础语言 en 认', async () => {
    const { check } = await boot('en-US', { language: ['auto', 'zh-CN', 'en'] });
    const results = await check();
    expect(results.map(({ level }) => level)).toEqual(['ok']);
  });

  it('全局层之外的层也查：写明是哪一层，实际用的语言按那一层的列表选；不收语言设置的工作区场所不查', async () => {
    /** 场所记录：这个场所写了 language */
    const place = (key: string, kind: string, language: string[]) => ({
      key,
      kind,
      name: '<群名>',
      createdAt: 1,
      updatedAt: 1,
      metadata: { 'session-settings': { values: [{ plugin: I18N, key: 'language', value: language }] } },
    });
    const { svc, check } = await boot('ja-JP', {
      language: ['zh-CN'],
      sessionConfig: {
        platforms: { onebot: { [I18N]: { language: ['ja'] } } },
        platformTypes: { onebot: { group: { [I18N]: { language: ['auto', 'en'] } } } },
      },
      places: {
        'onebot:group:20001': place('onebot:group:20001', 'window', ['fr']),
        'workspace:default': place('workspace:default', 'workspace', ['de']),
      },
    });
    const results = await check();
    expect(results.map(({ level }) => level)).toEqual(['warn', 'warn', 'warn']);
    expect(results.map(({ message, detail }) => svc.render({ message, detail }, { host: true }))).toEqual([
      {
        message: '平台档 onebot里的 日本語 没有插件提供，实际用 English',
        detail:
          '装上提供这种语言的语言包（在插件市场或 npm 按关键词 aalis-lang-ja 找），或在会话设置的平台档 onebot里调整「语言」列表',
      },
      {
        message: '平台类型档 onebot · group里的跟随系统当前是 日本語 (日本)，没有插件提供，实际用 English',
        detail:
          '装上提供这种语言的语言包（在插件市场或 npm 按关键词 aalis-lang-ja-jp或aalis-lang-ja 找），或在会话设置的平台类型档 onebot · group里调整「语言」列表',
      },
      {
        message: '场所『<群名>』里的 français 没有插件提供，实际用 English',
        detail:
          '装上提供这种语言的语言包（在插件市场或 npm 按关键词 aalis-lang-fr 找），或在会话设置的场所『<群名>』里调整「语言」列表',
      },
    ]);
  });
});

describe('「需要处理」', () => {
  it('不跑诊断也在，结论与详情同诊断；改了语言列表、交付了语言包都重算，都有提供时撤回', async () => {
    const { app, svc, check, notices, setGlobal } = await boot('zh-CN', { language: ['ja', 'zh-CN'] });
    const shown = notices();
    expect(shown).toEqual([
      {
        id: 'i18n.languages.0',
        level: 'action',
        title: '语言列表里的 日本語 没有插件提供，实际用 中文（中国）',
        detail: expect.stringContaining('aalis-lang-ja'),
      },
    ]);
    const [result] = await check();
    expect(svc.render([result.message, result.detail], { host: true })).toEqual([shown[0].title, shown[0].detail]);

    await setGlobal(['zh-CN']);
    expect(notices()).toEqual([]);

    await setGlobal(['ja', 'zh-CN']);
    expect(notices()).toHaveLength(1);
    await app.plugin(
      definePlugin({
        name: 'zz-pack-ja',
        uses: { contributions },
        apply({ contributions }) {
          contributions.use.contribute('i18n:pack', {
            id: 'ja',
            language: 'ja',
            entries: { '@aalis/plugin-i18n': { displayName: { text: '多言語', from: fingerprint('多语言') } } },
          });
        },
      }),
    );
    await app.plugins.idle();
    expect(notices()).toEqual([]);
  });
});
