// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SessionMethodResult, SettingLayer, SettingRow } from '../../packages/api-session-protocol/src/index.js';
import { SESSION_LAYERS } from '../../packages/api-session-settings/src/index.js';
import {
  BUILTIN_THEMES,
  type DeclarativePageView,
  type PluginTheme,
  parseTheme,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  THEME_TOKENS,
  type ThemeFile,
} from '../../packages/api-webui/src/index.js';
import { SESSION_PROTOCOL } from '../../packages/plugin-webui-client/src/plugins/list.js';
import { resolveText } from '../../packages/schema-i18n/src/index.js';
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  choose,
  type FakeRequest,
  type FakeRest,
  type Harness,
  INIT,
  installDialog,
  LAYER_ORDER,
  language,
  optionsOf,
  pluginRow as plugin,
  renderApp,
  requests,
  restCalls,
  server,
} from './harness.js';
import { row } from './items.js';
import { dataPath, hostTab, hostTabs, layoutStore, NOTES, pageTab, refOf, SETTINGS_PAGE } from './pages.js';

// ════════════════════════════════════════════════════════════
// 设置：宿主分区（会话默认、外观、系统）与插件分区（位置为设置的页面）同一个目录、同一套路由。
// - 会话默认先选层（全局、平台档、平台类型档与场所四组，可搜索，所选的层记进地址；宽屏左右并排、手机两屏），
//   再改这一层的项；层的称呼与继承先后取自会话服务给的层表，行与会话设置同一套组件；全局层写作者默认、按钮叫「恢复默认」；
//   会话服务不在、功能位 settings 为假时整个分区不出现；
// - 插件分区从目录与地址都能进入，手动刷新让页面重取；
// - 外观：主题选择（跟随系统时深浅各选一个）、导入与导出、插件经贡献点提供的主题，快捷栏与会话面板标签的排序与开关；
// - 系统：宿主配置（来源与生效时机，要重启的键保存后出「重启以生效」）、服务偏好（全局偏好，模型服务照常一行）与数据目录。
// ════════════════════════════════════════════════════════════

let app: Harness | undefined;
let restoreDialog: () => void;
let viewport: ReturnType<typeof stubViewport>;

beforeAll(() => {
  restoreDialog = installDialog();
  // jsdom 的 Blob 没有 text()：按浏览器的行为用 FileReader 补上
  Blob.prototype.text ??= function (this: Blob) {
    return new Promise<string>(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(this);
    });
  };
});
afterAll(() => restoreDialog());

beforeEach(() => {
  FakeWebSocket.install();
  stubPlatform('MacIntel');
  viewport = stubViewport(1440);
});

afterEach(() => {
  app?.close();
  app = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  const root = document.documentElement;
  delete root.dataset.theme;
  root.removeAttribute('style');
});

/** 插件列表的一项 */
const SESSIONS = plugin('zz-sessions', { displayName: '会话服务', provides: [SESSION_PROTOCOL] });
const AUTH = plugin('zz-auth', { displayName: '权限插件' });
const THEMES = plugin('zz-themes', { displayName: '主题包' });

/** 第二个设置页：排在权限之后 */
const SKILLS: DeclarativePageView = {
  instance: 'zz-skills',
  key: 'skills',
  title: '技能',
  placement: 'settings',
  content: [{ type: 'markdown', id: 'about' }],
};

function settingsRest(extra: FakeRest = {}, rows = [SESSIONS, AUTH, THEMES]): FakeRest {
  return {
    '/api/plugins': () => ({ plugins: rows, secretRefCounts: {} }),
    '/api/pages': { pages: [SETTINGS_PAGE, SKILLS] },
    '/api/themes': { themes: [] },
    [dataPath(SETTINGS_PAGE, 'about')]: { data: '权限说明' },
    [dataPath(SKILLS, 'about')]: { data: '技能说明' },
    ...extra,
  };
}

const directory = () => within(screen.getByRole('navigation', { name: '设置' }));
const section = () => within(screen.getByRole('main'));
const sectionNames = () =>
  directory()
    .getAllByRole('link')
    .map(link => link.textContent);
const admin = () => FakeWebSocket.at('/admin');
const calls = (path: string, method = 'GET') =>
  restCalls().filter(call => call.path === path && call.method === method);

describe('目录与路由', () => {
  it('宿主分区与插件分区在同一个目录：会话默认、插件分区（按页面先后）、外观、系统；桌面上 /settings 跳到第一节，当前节是当前项', async () => {
    app = await renderApp('/settings', {}, settingsRest());
    await vi.waitFor(() => expect(app?.where()).toBe('/settings/session-defaults'));
    expect(sectionNames()).toEqual(['会话默认', '权限', '技能', '外观', '系统']);
    expect(directory().getByRole('link', { name: '会话默认' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(directory().getByRole('link', { name: '外观' }));
    expect(app.where()).toBe('/settings/appearance');
    expect(directory().getByRole('link', { name: '外观' }).getAttribute('aria-current')).toBe('page');
    expect(section().getByRole('heading', { level: 2, name: '外观' })).toBeTruthy();

    fireEvent.click(directory().getByRole('link', { name: '权限' }));
    expect(app.where()).toBe(`/settings/p/${SETTINGS_PAGE.instance}/${SETTINGS_PAGE.key}`);
    expect(directory().getByRole('link', { name: '权限' }).getAttribute('aria-current')).toBe('page');
    expect(await section().findByText('权限说明')).toBeTruthy();
  });

  it('会话服务没启用时目录里没有「会话默认」，/settings 跳到第一个插件分区；直接打开它的地址写明会话服务未启用，链到提供者', async () => {
    const stopped = { ...SESSIONS, state: 'disabled' };
    app = await renderApp('/settings', {}, settingsRest({}, [stopped, AUTH]));
    await vi.waitFor(() => expect(app?.where()).toBe(`/settings/p/${SETTINGS_PAGE.instance}/${SETTINGS_PAGE.key}`));
    expect(sectionNames()).toEqual(['权限', '技能', '外观', '系统']);
    app.close();

    app = await renderApp('/settings/session-defaults', {}, settingsRest({}, [stopped, AUTH]));
    expect(await section().findByText('会话服务未启用')).toBeTruthy();
    expect(section().getByRole('link', { name: '去处理' }).getAttribute('href')).toBe('/plugins/zz-sessions');
  });

  it('插件列表没取到：目录与会话默认写明原因、可以重试，不当成会话服务没启用', async () => {
    let fail = true;
    const rest = settingsRest({
      '/api/plugins': () =>
        fail
          ? Response.json({ error: '插件管理服务不可用' }, { status: 500 })
          : { plugins: [SESSIONS, AUTH], secretRefCounts: {} },
    });
    app = await renderApp('/settings/session-defaults', {}, rest);
    expect((await directory().findByRole('alert')).textContent).toContain('插件列表没取到：插件管理服务不可用');
    expect(await section().findByText('插件列表没取到')).toBeTruthy();
    expect(section().queryByText('会话服务未启用')).toBeNull();
    expect(screen.queryByRole('link', { name: '查看日志' }), '插件列表没取到就指不出来源').toBeNull();
    fail = false;
    fireEvent.click(section().getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(sectionNames()).toEqual(['会话默认', '权限', '技能', '外观', '系统']));
    expect(directory().queryByRole('alert')).toBeNull();
    expect(section().queryByText('插件列表没取到')).toBeNull();
  });

  it('插件分区直接打开地址也能进入；手动刷新让页面重取；所属插件停用时显示占位，链到插件详情，重新登记后回来', async () => {
    let pages: DeclarativePageView[] = [SETTINGS_PAGE, SKILLS];
    app = await renderApp(
      `/settings/p/${SKILLS.instance}/${SKILLS.key}`,
      {},
      settingsRest({ '/api/pages': () => ({ pages }) }),
    );
    expect(await section().findByText('技能说明')).toBeTruthy();
    expect(section().getByRole('heading', { level: 2, name: '技能' })).toBeTruthy();
    expect(calls(dataPath(SKILLS, 'about'))).toHaveLength(1);
    fireEvent.click(section().getByRole('button', { name: '刷新' }));
    await vi.waitFor(() => expect(calls(dataPath(SKILLS, 'about'))).toHaveLength(2));

    pages = [SETTINGS_PAGE];
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await section().findByText('这个页面所属的插件已停用')).toBeTruthy();
    expect(section().getByRole('link', { name: '去插件详情' }).getAttribute('href')).toBe('/plugins/zz-skills');
    expect(sectionNames()).toEqual(['会话默认', '权限', '外观', '系统']);

    pages = [SETTINGS_PAGE, SKILLS];
    act(() => admin().push({ type: 'plugins.changed' }));
    expect(await section().findByText('技能说明')).toBeTruthy();
  });

  it('认不出的分节回到设置的第一节', async () => {
    app = await renderApp('/settings/nowhere', {}, settingsRest());
    await vi.waitFor(() => expect(app?.where()).toBe('/settings/session-defaults'));
  });

  it('手机上 /settings 是目录这一层，点一节进下一层，返回回到目录', async () => {
    stubViewport(390);
    app = await renderApp('/settings', {}, settingsRest());
    await directory().findByRole('link', { name: '外观' });
    expect(document.querySelector('.shell')?.getAttribute('data-phone')).toBe('left');
    expect(app.where()).toBe('/settings');
    fireEvent.click(directory().getByRole('link', { name: '外观' }));
    expect(app.where()).toBe('/settings/appearance');
    expect(document.querySelector('.shell')?.getAttribute('data-phone')).toBe('main');
    fireEvent.click(section().getByRole('button', { name: '返回' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/settings'));
  });
});

describe('会话默认', () => {
  const GLOBAL: SettingLayer = { scope: 'global' };
  const ONEBOT_GROUP: SettingLayer = { scope: 'platformType', platform: 'onebot', type: 'group' };
  const WINDOW: SettingLayer = { scope: 'place', key: 'onebot:group:20001' };
  const LAYERS: SessionMethodResult<'session/config/layers'>['layers'] = [
    { layer: GLOBAL },
    { layer: { scope: 'platform', platform: 'cli' } },
    { layer: { scope: 'platform', platform: 'onebot' } },
    { layer: { scope: 'platform', platform: 'webui' } },
    { layer: { scope: 'platformType', platform: 'onebot', type: 'channel' } },
    { layer: ONEBOT_GROUP, label: '群' },
    { layer: { scope: 'platformType', platform: 'onebot', type: 'private' }, label: '私聊' },
    { layer: { scope: 'place', key: 'workspace:default' }, label: '默认工作区' },
    { layer: { scope: 'place', key: 'workspace:w1' }, label: '工作区「论文」' },
    { layer: WINDOW, label: '群「读书会」', platform: 'onebot', type: 'group' },
  ];
  const MODEL = { type: 'llm-ref', label: '模型', session: { preference: 'llm', unset: '跟随服务偏好' } } as const;
  const chat = (model: string) => ({ provider: 'zz-llm', model });
  const ITERATIONS = { type: 'number', label: '最大工具迭代', default: 30 } as const;
  const ROWS: Record<string, SettingRow[]> = {
    global: [
      row('llm', {
        field: MODEL,
        plugin: 'zz-agent',
        prominence: 'composer',
        actual: { value: chat('zz-chat'), label: 'zz-chat' },
      }),
      row('persona', {
        field: { type: 'string', label: '人设', default: '<默认人设>' },
        value: '<默认人设>',
        effective: '<默认人设>',
        source: 'global',
      }),
      row('iterations', { field: ITERATIONS, plugin: 'zz-agent', value: 50, effective: 50, source: 'global' }),
      row('groups', {
        field: { type: 'multiselect', label: '工具分组', default: [], options: [{ label: '网页', value: 'web' }] },
        value: [],
        effective: [],
        source: 'global',
      }),
      row('extra', {
        field: { type: 'textarea', label: '额外提示', default: '' },
        value: '<额外>',
        effective: '<额外>',
        source: 'global',
      }),
    ],
    group: [
      row('persona', {
        field: { type: 'string', label: '人设', default: '<默认人设>' },
        value: '<群人设>',
        effective: '<群人设>',
        source: 'platformType',
      }),
      row('iterations', { field: ITERATIONS, plugin: 'zz-agent', effective: 50, source: 'global' }),
    ],
    /** 窗口场所：这一层没写，都是继承来的 */
    place: [
      row('persona', {
        field: { type: 'string', label: '人设', default: '<默认人设>' },
        effective: '<群人设>',
        source: 'platformType',
      }),
      row('iterations', { field: ITERATIONS, plugin: 'zz-agent', effective: 50, source: 'global' }),
    ],
  };
  const rowsOf = (layer: SettingLayer) =>
    ROWS[layer.scope === 'global' || layer.scope === 'place' ? layer.scope : 'group'];

  function handlers(layers = LAYERS, order = LAYER_ORDER) {
    return {
      'session/config/layers': () => ({ layers, order }),
      'session/config/layer/get': ({ layer }: { layer: SettingLayer }) => ({ items: rowsOf(layer) }),
      'session/config/layer/update': ({ layer }: { layer: SettingLayer }) => ({ items: rowsOf(layer) }),
    };
  }
  const layerList = () => within(section().getByRole('navigation', { name: '会话设置的层' }));
  /** 各组的层：组名（全局没有组名）与组里各层的名字 */
  const groups = () =>
    layerList()
      .getAllByRole('list')
      .map(list => [
        list.getAttribute('aria-label'),
        within(list)
          .getAllByRole('link')
          .map(link => link.textContent),
      ]);
  const settingRow = (label: string) => within(section().getByRole('group', { name: label }));

  it('第一步选层：全局、平台档、平台类型档、场所四组，组名取自层表，平台类型写声明的显示名（没有时写类型名），窗口场所在称呼后用括号补平台；第二步改这一层的项，所选的层记进地址；宽屏左右并排', async () => {
    app = await renderApp('/settings/session-defaults', handlers(), settingsRest());
    await layerList().findByRole('link', { name: '全局（插件配置）' });
    expect(groups()).toEqual([
      ['全局（插件配置）', ['全局（插件配置）']],
      ['平台档', ['cli', 'onebot', 'webui']],
      ['平台类型档', ['onebot · channel', 'onebot · 群', 'onebot · 私聊']],
      ['场所', ['默认工作区', '工作区「论文」', '群「读书会」（onebot）']],
    ]);
    expect(section().getByText('先在左边选一层')).toBeTruthy();
    expect(requests('session/config/layer/get')).toEqual([]);

    fireEvent.click(layerList().getByRole('link', { name: 'onebot · 群' }));
    expect(app.where()).toBe('/settings/session-defaults?layer=platformType%3Aonebot%3Agroup');
    await vi.waitFor(() => expect(requests('session/config/layer/get')).toEqual([{ layer: ONEBOT_GROUP }]));
    expect(section().getByRole('heading', { name: '平台类型档「onebot · 群」' })).toBeTruthy();
    expect(layerList().getByRole('link', { name: 'onebot · 群' }).getAttribute('aria-current')).toBe('page');
    await section().findByRole('group', { name: '人设' });
    expect(settingRow('人设').getByText('<群人设>')).toBeTruthy();
    expect(settingRow('人设').queryByText(/^来自：/), '这一层自己设的不写来源').toBeNull();
    expect(settingRow('人设').getByRole('button', { name: '恢复继承' })).toBeTruthy();
    expect(settingRow('最大工具迭代').getByText('来自：全局（插件配置）')).toBeTruthy();
    expect(
      section().getByText(
        '会话设置按本会话、场所、平台类型档、平台档、全局（插件配置）的先后，取第一个设了值的一层；哪一层都没设时按各项自己的默认。改动从下一轮起生效。',
      ),
    ).toBeTruthy();
    expect(section().queryByText(/类型档互不包含/)).toBeNull();

    fireEvent.click(settingRow('人设').getByRole('button', { name: '恢复继承' }));
    await vi.waitFor(() =>
      expect(requests('session/config/layer/update')).toEqual([
        { layer: ONEBOT_GROUP, plugin: '@aalis/demo', key: 'persona', value: null },
      ]),
    );
  });

  it('地址带着层打开就是那一层；场所的标题写场所的称呼与层名、不带平台；地址里的层不在了时回到选层', async () => {
    app = await renderApp('/settings/session-defaults?layer=platformType%3Aonebot%3Agroup', handlers(), settingsRest());
    expect(await section().findByRole('heading', { name: '平台类型档「onebot · 群」' })).toBeTruthy();
    await vi.waitFor(() => expect(requests('session/config/layer/get')).toEqual([{ layer: ONEBOT_GROUP }]));
    app.close();

    app = await renderApp(
      `/settings/session-defaults?layer=${encodeURIComponent('place:onebot:group:20001')}`,
      handlers(),
      settingsRest(),
    );
    expect(await section().findByRole('heading', { name: '群「读书会」（场所）' })).toBeTruthy();
    await vi.waitFor(() => expect(requests('session/config/layer/get')).toEqual([{ layer: WINDOW }]));
    app.close();

    app = await renderApp('/settings/session-defaults?layer=platform%3Agone', handlers(), settingsRest());
    expect(await section().findByText('先在左边选一层')).toBeTruthy();
  });

  it('别的层存着不合法的值（生效值落到下一层）：写明这一层的值不合法、按哪层生效，行尾「恢复继承」清掉它', async () => {
    const invalid = [
      row('iterations', { field: ITERATIONS, plugin: 'zz-agent', value: -5, effective: 50, source: 'global' }),
    ];
    app = await renderApp(
      '/settings/session-defaults?layer=platformType%3Aonebot%3Agroup',
      {
        ...handlers(),
        'session/config/layer/get': () => ({ items: invalid }),
        'session/config/layer/update': () => ({ items: invalid }),
      },
      settingsRest(),
    );
    expect(
      await settingRow('最大工具迭代').findByText('这一层存的值不合法，生效的是全局（插件配置）的值'),
    ).toBeTruthy();
    expect(settingRow('最大工具迭代').queryByText(/^来自：/)).toBeNull();
    fireEvent.click(settingRow('最大工具迭代').getByRole('button', { name: '恢复继承' }));
    await vi.waitFor(() =>
      expect(requests('session/config/layer/update')).toEqual([
        { layer: ONEBOT_GROUP, plugin: 'zz-agent', key: 'iterations', value: null },
      ]),
    );
  });

  it.each([
    ['中文', [], '这一层存的值不合法，生效的是默认值'],
    ['英文', ['en'], 'The value stored on this layer is invalid; the default value is in effect'],
  ])('别的层存着不合法的值、生效的是作者默认：%s另用一句，不拿「默认」当层名去套', async (_case, chain, text) => {
    const invalid = [
      row('iterations', { field: ITERATIONS, plugin: 'zz-agent', value: -5, effective: 30, source: 'default' }),
    ];
    app = await renderApp(
      '/settings/session-defaults?layer=platformType%3Aonebot%3Agroup',
      { ...handlers(), 'session/config/layer/get': () => ({ items: invalid }) },
      settingsRest(chain.length > 0 ? language(chain) : {}),
    );
    expect(await settingRow('最大工具迭代').findByText(text)).toBeTruthy();
  });

  it('窗口场所这一层：从平台档、平台类型档继承来的项写明取的是哪一份', async () => {
    app = await renderApp(
      `/settings/session-defaults?${new URLSearchParams({ layer: 'place:onebot:group:20001' })}`,
      handlers(),
      settingsRest(),
    );
    expect(await settingRow('人设').findByText('来自：平台类型档「onebot · 群」')).toBeTruthy();
  });

  it('搜索：按层的称呼、平台名、类型名与类型的显示名、场所名与场所键过滤', async () => {
    app = await renderApp('/settings/session-defaults', handlers(), settingsRest());
    const search = await section().findByRole('searchbox', { name: '搜索层' });
    fireEvent.change(search, { target: { value: 'onebot' } });
    expect(groups()).toEqual([
      ['平台档', ['onebot']],
      ['平台类型档', ['onebot · channel', 'onebot · 群', 'onebot · 私聊']],
      ['场所', ['群「读书会」（onebot）']],
    ]);
    fireEvent.change(search, { target: { value: 'private' } });
    expect(groups()).toEqual([['平台类型档', ['onebot · 私聊']]]);
    fireEvent.change(search, { target: { value: '私聊' } });
    expect(groups()).toEqual([['平台类型档', ['onebot · 私聊']]]);
    fireEvent.change(search, { target: { value: 'group:20001' } });
    expect(groups()).toEqual([['场所', ['群「读书会」（onebot）']]]);
  });

  it('全局层：每项写作者默认，等于默认标「默认」，不等写「默认：<值>」（空列表、空文字写「无」），行尾「恢复默认」写 null；模型没设时写「跟随全局偏好（此刻：<模型名>）」', async () => {
    app = await renderApp('/settings/session-defaults?layer=global', handlers(), settingsRest());
    expect(await section().findByRole('heading', { name: '全局（插件配置）' })).toBeTruthy();
    expect(await settingRow('模型').findByText('跟随全局偏好（此刻：zz-chat）')).toBeTruthy();
    expect(settingRow('人设').getByText('默认')).toBeTruthy();
    expect(settingRow('人设').queryByRole('button', { name: '恢复默认' })).toBeNull();
    expect(settingRow('最大工具迭代').getByText('默认：30')).toBeTruthy();
    expect(settingRow('工具分组').getByText('无')).toBeTruthy();
    expect(settingRow('额外提示').getByText('默认：无')).toBeTruthy();
    expect(settingRow('最大工具迭代').queryByText(/^来自：/)).toBeNull();
    fireEvent.click(settingRow('最大工具迭代').getByRole('button', { name: '恢复默认' }));
    await vi.waitFor(() =>
      expect(requests('session/config/layer/update')).toEqual([
        { layer: GLOBAL, plugin: 'zz-agent', key: 'iterations', value: null },
      ]),
    );
  });

  it('全局层：可选项是动态的字段，「默认：<值>」与值按同一份可选项写称呼', async () => {
    const languages = row('language', {
      field: {
        type: 'multiselect',
        label: '语言',
        ordered: true,
        dynamicOptions: 'zz-languages',
        default: ['en'],
      },
      value: ['zh-CN', 'en'],
      effective: ['zh-CN', 'en'],
      source: 'global',
    });
    app = await renderApp(
      '/settings/session-defaults?layer=global',
      { ...handlers(), 'session/config/layer/get': () => ({ items: [languages] }) },
      settingsRest({
        '/api/models/zz-languages': {
          details: [
            { value: 'zh-CN', label: '中文（中国）' },
            { value: 'en', label: 'English' },
          ],
        },
      }),
    );
    expect(await settingRow('语言').findByText('中文（中国）、English')).toBeTruthy();
    expect(settingRow('语言').getByText('默认：English')).toBeTruthy();
  });

  it('写进配置文件失败：这一行下面写回包里 unsaved 的那一句', async () => {
    app = await renderApp(
      '/settings/session-defaults?layer=global',
      {
        ...handlers(),
        'session/config/layer/update': () => ({
          items: ROWS.global,
          unsaved: '已在运行态生效，但未写入配置文件（<原因>）',
        }),
      },
      settingsRest(),
    );
    fireEvent.click(await settingRow('最大工具迭代').findByRole('button', { name: '恢复默认' }));
    expect(await settingRow('最大工具迭代').findByText('已在运行态生效，但未写入配置文件（<原因>）')).toBeTruthy();
  });

  it('手机上两屏：先选层，选了进这一层的项，「换一层」回到选层', async () => {
    stubViewport(390);
    app = await renderApp('/settings/session-defaults', handlers(), settingsRest());
    fireEvent.click(await layerList().findByRole('link', { name: 'onebot · 群' }));
    expect(await section().findByRole('heading', { name: '平台类型档「onebot · 群」' })).toBeTruthy();
    expect(section().queryByRole('navigation', { name: '会话设置的层' })).toBeNull();
    fireEvent.click(section().getByRole('link', { name: '换一层' }));
    await vi.waitFor(() => expect(app?.where()).toBe('/settings/session-defaults'));
    expect(await layerList().findByRole('link', { name: 'onebot · 群' })).toBeTruthy();
    expect(section().queryByRole('heading', { name: '平台类型档「onebot · 群」' })).toBeNull();
  });

  it('英文界面：层的称呼与先后说明按英文', async () => {
    const order = SESSION_LAYERS.map(({ name, label }) => ({ name, label: resolveText(label, ['en']) }));
    app = await renderApp(
      '/settings/session-defaults?layer=global',
      handlers(LAYERS, order),
      settingsRest(language(['en'])),
    );
    expect(await section().findByRole('heading', { name: 'Global (plugin config)' })).toBeTruthy();
    expect(
      section().getByText(
        'Session settings take the first layer that has a value, in the order This session, Place, Platform-type profile, Platform profile, Global (plugin config); when no layer sets an item, its own default applies. Changes take effect from the next turn.',
      ),
    ).toBeTruthy();
  });

  it('没取到时写明原因，可以重试，「查看日志」链到提供会话协议的实例的日志', async () => {
    let fail = true;
    app = await renderApp(
      '/settings/session-defaults?layer=global',
      {
        ...handlers(),
        'session/config/layer/get': () => {
          if (fail) throw new Error('设置读不出');
          return { items: ROWS.global };
        },
      },
      settingsRest(),
    );
    const alert = await section().findByRole('alert');
    expect(alert.textContent).toContain('会话默认没取到：设置读不出');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-sessions',
    );
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await section().findByRole('group', { name: '人设' })).toBeTruthy();
    expect(section().queryByRole('alert')).toBeNull();
  });

  it('设置项或层变了（session/config/changed、插件启停）时重取', async () => {
    app = await renderApp('/settings/session-defaults?layer=platformType%3Aonebot%3Agroup', handlers(), settingsRest());
    await vi.waitFor(() => expect(requests('session/config/layer/get')).toHaveLength(1));
    act(() => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(requests('session/config/layers')).toHaveLength(2));
    await vi.waitFor(() => expect(requests('session/config/layer/get')).toHaveLength(2));
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(requests('session/config/layers')).toHaveLength(3));
  });

  it('可选项依赖另一项的行按这一层的生效值取，依赖的模型没设时按它此刻实际在用的模型', async () => {
    const levels = `/api/models/llm-thinking?dependency=${encodeURIComponent('zz-llm/zz-chat')}`;
    const think = row('think', {
      field: {
        type: 'select',
        label: '深度思考',
        dynamicOptions: 'llm-thinking',
        session: { dependsOn: 'llm', unset: '按模型的默认档' },
      },
      plugin: 'zz-agent',
    });
    app = await renderApp(
      '/settings/session-defaults?layer=global',
      { ...handlers(), 'session/config/layer/get': () => ({ items: [ROWS.global[0], think] }) },
      settingsRest({
        '/api/models/llm': { providers: [] },
        [levels]: { details: [{ value: 'high', label: '高', default: true }] },
      }),
    );
    expect(await settingRow('深度思考').findByText('高（默认）')).toBeTruthy();
    expect(calls(levels)).toHaveLength(1);
  });

  it('功能位 settings 为假：目录里没有「会话默认」', async () => {
    app = await renderApp(
      '/settings',
      { initialize: () => ({ ...INIT, features: { ...INIT.features, settings: false } }) },
      settingsRest(),
    );
    await vi.waitFor(() => expect(sectionNames()).toEqual(['权限', '技能', '外观', '系统']));
  });
});

describe('外观', () => {
  const theme = (name: string, kind: 'dark' | 'light', colors: ThemeFile['colors'] = {}): ThemeFile => ({
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    name,
    kind,
    colors,
  });
  const fileOf = (content: unknown, name = 'theme.json') =>
    new File([typeof content === 'string' ? content : JSON.stringify(content)], name, { type: 'application/json' });
  const picker = (label: string) => section().getByRole('combobox', { name: label });
  const optionNames = (label: string) => optionsOf(picker(label));
  const applied = () => document.documentElement.dataset.theme;
  const inline = (token: string) => document.documentElement.style.getPropertyValue(token);
  const stored = (key: string) => JSON.parse(localStorage.getItem(`aalis.${key}`) ?? 'null');
  const themeFiles = () => within(section().getByRole('list', { name: '主题文件' }));
  /** 主题文件里的一行：名字开头，写着出处 */
  const fileRow = (name: string, origin = '') =>
    within(
      themeFiles()
        .getAllByRole('listitem')
        .find(item => item.textContent?.startsWith(name) && item.textContent.includes(origin)) as HTMLElement,
    );
  async function importFile(file: File) {
    await act(async () => {
      fireEvent.change(section().getByLabelText('导入主题文件'), { target: { files: [file] } });
    });
  }

  /** 导出：截下交给下载链接的文件 */
  function captureDownloads() {
    const blobs: Array<{ blob: Blob; name: string }> = [];
    const made = new Map<string, Blob>();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL(blob: Blob) {
          const url = `blob:zz-${made.size}`;
          made.set(url, blob);
          return url;
        }
        static revokeObjectURL(url: string) {
          made.delete(url);
        }
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      const blob = made.get(this.getAttribute('href') ?? '');
      if (blob) blobs.push({ blob, name: this.download });
    });
    return blobs;
  }

  it('默认跟随系统：深色用偏中性深色、浅色用偏中性浅色；系统切换时跟着换；选的存在本浏览器', async () => {
    app = await renderApp('/settings/appearance', {}, settingsRest());
    const follow = await section().findByRole('switch', { name: '跟随系统' });
    expect(follow.getAttribute('aria-checked')).toBe('true');
    expect(picker('深色用').textContent).toBe('偏中性深色');
    expect(picker('浅色用').textContent).toBe('偏中性浅色');
    expect(optionNames('深色用')).toEqual(['偏中性深色', '品牌柔和深色', '文档站原色深色', '安静中性深色']);
    await vi.waitFor(() => expect(applied()).toBe('calm-dark'));

    choose(picker('深色用'), '品牌柔和深色');
    expect(applied()).toBe('aalis-dark');
    act(() => viewport.scheme(false));
    expect(applied()).toBe('calm-light');
    choose(picker('浅色用'), '文档站原色浅色');
    expect(applied()).toBe('brand-light');
    expect(stored('appearance')).toMatchObject({ follow: true, dark: 'aalis-dark', light: 'brand-light' });

    fireEvent.click(follow);
    expect(picker('主题').textContent).toBe('文档站原色浅色');
    expect(optionNames('主题')).toHaveLength(8);
    choose(picker('主题'), '安静中性深色');
    act(() => viewport.scheme(true));
    act(() => viewport.scheme(false));
    expect(applied()).toBe('neutral-dark');
    expect(stored('appearance')).toMatchObject({ follow: false, theme: 'neutral-dark' });
  });

  it('导入：只写了几个令牌的主题按同种类的偏中性补齐，出现在主题文件与选择里，选中后逐个写进令牌；对比度不达标的列出来，仍可使用', async () => {
    app = await renderApp('/settings/appearance', {}, settingsRest());
    await section().findByRole('switch', { name: '跟随系统' });
    await importFile(fileOf(theme('夜读', 'dark', { '--color-bg': '#101012', '--color-text-3': '#333333' })));
    const status = await vi.waitFor(() => section().getByRole('status'));
    expect(status.textContent).toContain('已导入「夜读」');
    expect(status.textContent).toMatch(/弱化字 \/ 主区 [\d.]+（要 4\.5）/);
    expect(fileRow('夜读').getByText('深色 · 导入')).toBeTruthy();
    expect(optionNames('深色用')).toContain('夜读（导入）');

    choose(picker('深色用'), '夜读（导入）');
    expect(applied()).toBe('imported:dark:夜读');
    expect(inline('--color-bg')).toBe('#101012');
    expect(inline('--color-accent')).toBe(BUILTIN_THEMES['calm-dark'].colors['--color-accent']);
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
    // 首帧脚本读的：选中的不是内置主题时连同令牌一起存着
    expect(stored('appearance').palettes['imported:dark:夜读'].colors['--color-bg']).toBe('#101012');
    expect(stored('themes')).toHaveLength(1);

    // 换回内置主题：写进去的令牌撤掉
    choose(picker('深色用'), '偏中性深色');
    expect(inline('--color-bg')).toBe('');
    expect(stored('appearance').palettes).toEqual({});
  });

  it('导入被拒：不在令牌表里的名字、不是颜色的值（含 url()）、超出大小上限、不是 JSON，逐条写明原因，什么都不加', async () => {
    app = await renderApp('/settings/appearance', {}, settingsRest());
    await section().findByRole('switch', { name: '跟随系统' });
    const before = themeFiles().getAllByRole('listitem').length;
    const refused = async (file: File, reason: RegExp) => {
      await importFile(file);
      await vi.waitFor(() => expect(section().getByRole('alert').textContent).toMatch(reason));
    };
    await refused(fileOf(theme('坏的', 'dark', { '--color-bogus': '#000000' } as never)), /--color-bogus 不在令牌表里/);
    await refused(
      fileOf(theme('外链', 'dark', { '--color-bg': 'url(https://evil.invalid/x.png)' })),
      /--color-bg 的值不是颜色/,
    );
    await refused(fileOf(`{"name":"${'很'.repeat(20_000)}"}`), /超过 16 KB/);
    await refused(fileOf('{不是 JSON'), /不是 JSON/);
    expect(themeFiles().getAllByRole('listitem')).toHaveLength(before);
    expect(localStorage.getItem('aalis.themes')).toBeNull();
  });

  it('英文界面导入被拒：主题文件的校验原因与界面自己的原因都按英文', async () => {
    app = await renderApp('/settings/appearance', {}, settingsRest(language(['en'])));
    await section().findByRole('switch', { name: 'Follow system' });
    const refused = async (file: File, reasons: string[]) => {
      await act(async () => {
        fireEvent.change(section().getByLabelText('Import a theme file'), { target: { files: [file] } });
      });
      const listed = () => [...section().getByRole('alert').querySelectorAll('li')].map(item => item.textContent);
      await vi.waitFor(() => expect(listed()).toEqual(reasons));
    };
    await refused(fileOf(theme('坏的', 'dark', { '--color-bogus': '#000000', '--color-bg': 'red' } as never)), [
      '--color-bogus isn’t in the token table',
      'The value of --color-bg isn’t a color: red',
    ]);
    await refused(fileOf('{不是 JSON'), ['Not a JSON file']);
  });

  it('内置主题导出再导入后与原主题逐令牌相同；导入的主题可以移除，正在用的回到同深浅的偏中性', async () => {
    const downloads = captureDownloads();
    app = await renderApp('/settings/appearance', {}, settingsRest());
    await section().findByRole('switch', { name: '跟随系统' });
    fireEvent.click(fileRow('品牌柔和浅色').getByRole('button', { name: '导出' }));
    expect(downloads.map(download => download.name)).toEqual(['品牌柔和浅色.json']);
    const exported = JSON.parse(await downloads[0].blob.text()) as ThemeFile;
    expect(exported).toEqual({ ...BUILTIN_THEMES['aalis-light'], name: '品牌柔和浅色' });

    await importFile(fileOf(exported));
    await vi.waitFor(() => expect(section().getByRole('status').textContent).toContain('已导入「品牌柔和浅色」'));
    const entry = stored('themes')[0];
    const parsed = parseTheme(entry);
    expect(parsed.ok && parsed.theme.colors).toEqual(BUILTIN_THEMES['aalis-light'].colors);
    for (const token of THEME_TOKENS) {
      expect(parsed.ok && parsed.theme.colors[token], token).toBe(BUILTIN_THEMES['aalis-light'].colors[token]);
    }

    act(() => viewport.scheme(false));
    choose(picker('浅色用'), '品牌柔和浅色（导入）');
    expect(applied()).toBe('imported:light:品牌柔和浅色');
    fireEvent.click(fileRow('品牌柔和浅色', '导入').getByRole('button', { name: '移除' }));
    expect(applied()).toBe('calm-light');
    expect(stored('themes')).toEqual([]);
  });

  it('导出的下载地址过一分钟才撤销：立即撤销时有的浏览器来不及开始下载', async () => {
    const downloads = captureDownloads();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    app = await renderApp('/settings/appearance', {}, settingsRest());
    await section().findByRole('switch', { name: '跟随系统' });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    fireEvent.click(fileRow('品牌柔和浅色').getByRole('button', { name: '导出' }));
    expect(downloads).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('插件经贡献点提供的主题列在选择里、写明出处；插件停用后它消失，正在用的回到同深浅的偏中性', async () => {
    const dusk: PluginTheme = {
      id: 'zz-themes/dusk',
      instance: 'zz-themes',
      theme: { name: '黄昏', kind: 'dark', colors: { ...BUILTIN_THEMES['calm-dark'].colors, '--color-bg': '#201a18' } },
    };
    let themes = [dusk];
    app = await renderApp('/settings/appearance', {}, settingsRest({ '/api/themes': () => ({ themes }) }));
    await vi.waitFor(() => expect(optionNames('深色用')).toContain('黄昏（主题包）'));
    expect(fileRow('黄昏').getByText('深色 · 主题包')).toBeTruthy();
    choose(picker('深色用'), '黄昏（主题包）');
    expect(inline('--color-bg')).toBe('#201a18');

    themes = [];
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(applied()).toBe('calm-dark'));
    expect(inline('--color-bg')).toBe('');
    expect(optionNames('深色用')).not.toContain('黄昏（主题包）');
    expect(stored('appearance').palettes).toEqual({});

    themes = [dusk];
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(applied()).toBe('plugin:zz-themes/dusk'));
  });

  it('上次选的插件主题：插件主题取回之前先用存着的令牌，页面不先闪成偏中性；取回后插件已不提供它时回到同深浅的偏中性', async () => {
    const dusk = {
      name: '黄昏',
      kind: 'dark',
      colors: { ...BUILTIN_THEMES['calm-dark'].colors, '--color-bg': '#201a18' },
    };
    localStorage.setItem(
      'aalis.appearance',
      JSON.stringify({
        follow: true,
        dark: 'plugin:zz-themes/dusk',
        light: 'calm-light',
        palettes: { 'plugin:zz-themes/dusk': dusk },
      }),
    );
    let release: (body: unknown) => void = () => {};
    const pending = new Promise(resolve => {
      release = resolve;
    });
    app = await renderApp('/settings/appearance', {}, settingsRest({ '/api/themes': () => pending }));
    expect(applied()).toBe('plugin:zz-themes/dusk');
    expect(inline('--color-bg')).toBe('#201a18');

    await act(async () => release({ themes: [] }));
    await vi.waitFor(() => expect(applied()).toBe('calm-dark'));
    expect(inline('--color-bg')).toBe('');
    expect(stored('appearance')).toMatchObject({ dark: 'plugin:zz-themes/dusk', palettes: {} });
  });

  it('插件提供的主题与布局记录没取到：各写一行原因，可以重试，「查看日志」链到提供界面的实例的日志', async () => {
    let fail = true;
    const failing = (ok: unknown) => () => (fail ? Response.json({ error: '存储服务不在' }, { status: 500 }) : ok);
    app = await renderApp(
      '/settings/appearance',
      {},
      settingsRest(
        { '/api/themes': failing({ themes: [] }), '/api/layout': failing({ pinned: [], panelTabs: hostTabs() }) },
        [SESSIONS, THEMES, plugin('zz-ui', { self: true })],
      ),
    );
    const titles = () =>
      section()
        .queryAllByRole('alert')
        .map(alert => alert.textContent?.split('：')[0]);
    await vi.waitFor(() => expect(titles()).toEqual(['插件提供的主题没取到', '布局记录没取到', '布局记录没取到']));
    const alerts = section().getAllByRole('alert');
    for (const alert of alerts) {
      expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
        '/health/logs?plugin=zz-ui',
      );
    }
    fail = false;
    fireEvent.click(within(alerts[0]).getByRole('button', { name: '重试' }));
    fireEvent.click(within(alerts[1]).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(titles()).toEqual([]));
    expect(section().getByRole('list', { name: '会话面板标签' })).toBeTruthy();
  });

  it('快捷栏：已固定的页面按顺序列出，可以上移、下移、取消固定；所属插件没启用的标「未启用」', async () => {
    const BOARD_PAGE: DeclarativePageView = { ...NOTES, key: 'board', title: '看板', placement: 'plugin' };
    const layout = layoutStore({
      pinned: [refOf(BOARD_PAGE), { instance: 'zz-gone', pageKey: 'stats' }],
    });
    app = await renderApp(
      '/settings/appearance',
      {},
      settingsRest({
        '/api/pages': { pages: [BOARD_PAGE] },
        '/api/layout': (request: FakeRequest) => layout.route(request),
      }),
    );
    const list = within(await section().findByRole('list', { name: '快捷栏' }));
    const items = () => list.getAllByRole('listitem').map(item => item.firstElementChild?.textContent);
    expect(items()).toEqual(['看板', 'zz-gone · stats未启用']);
    const first = within(list.getAllByRole('listitem')[0]);
    expect((first.getByRole('button', { name: '上移' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(first.getByRole('button', { name: '下移' }));
    await vi.waitFor(() => expect(items()[0]).toMatch(/^zz-gone/));
    fireEvent.click(within(list.getAllByRole('listitem')[1]).getByRole('button', { name: '取消固定' }));
    await vi.waitFor(() => expect(items()).toHaveLength(1));
    const ops = restCalls()
      .filter(call => call.path === '/api/layout' && call.method === 'POST')
      .map(call => call.body);
    expect(ops).toEqual([
      { op: 'move-down', page: refOf(BOARD_PAGE) },
      { op: 'unpin', page: refOf(BOARD_PAGE) },
    ]);
  });

  it('会话面板标签：宿主标签与插件标签按记录的顺序，可以上移、下移、显示、隐藏；插件标签另可移出，没启用的标「未启用」、不能再显示', async () => {
    const GONE = { instance: 'zz-gone', pageKey: 'files' };
    const layout = layoutStore({
      panelTabs: [
        hostTab('plan'),
        hostTab('settings', false),
        hostTab('usage'),
        pageTab(NOTES),
        { tab: GONE, open: false },
      ],
    });
    app = await renderApp(
      '/settings/appearance',
      {},
      settingsRest({
        '/api/pages': { pages: [NOTES] },
        '/api/layout': (request: FakeRequest) => layout.route(request),
      }),
    );
    const list = within(await section().findByRole('list', { name: '会话面板标签' }));
    const rowOf = (name: string) =>
      within(list.getAllByRole('listitem').find(item => item.textContent?.startsWith(name)) as HTMLElement);
    expect(list.getAllByRole('listitem').map(item => item.firstElementChild?.textContent)).toEqual([
      '计划',
      '设置',
      '用量',
      '笔记',
      'zz-gone · files未启用',
    ]);
    expect(rowOf('计划').queryByRole('button', { name: '移出' })).toBeNull();
    expect(rowOf('设置').getByRole('switch', { name: '显示设置' }).getAttribute('aria-checked')).toBe('false');
    expect((rowOf('zz-gone').getByRole('switch', { name: '显示zz-gone · files' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(rowOf('设置').getByRole('switch', { name: '显示设置' }));
    await vi.waitFor(() =>
      expect(rowOf('设置').getByRole('switch', { name: '显示设置' }).getAttribute('aria-checked')).toBe('true'),
    );
    fireEvent.click(rowOf('笔记').getByRole('button', { name: '上移' }));
    fireEvent.click(rowOf('计划').getByRole('button', { name: '下移' }));
    fireEvent.click(rowOf('笔记').getByRole('switch', { name: '显示笔记' }));
    fireEvent.click(rowOf('zz-gone').getByRole('button', { name: '移出' }));
    await vi.waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(4));
    const ops = restCalls()
      .filter(call => call.path === '/api/layout' && call.method === 'POST')
      .map(call => call.body);
    expect(ops).toEqual([
      { op: 'open-tab', tab: { host: 'settings' } },
      { op: 'tab-up', tab: refOf(NOTES) },
      { op: 'tab-down', tab: { host: 'plan' } },
      { op: 'close-tab', tab: refOf(NOTES) },
      { op: 'remove-tab', tab: GONE },
    ]);
  });
});

describe('系统', () => {
  const SCHEMA = {
    'zz-text': { type: 'string', label: '示例文本', default: 'Aalis' },
    logLevel: {
      type: 'select',
      label: '日志等级',
      default: 'info',
      options: [
        { label: 'info', value: 'info' },
        { label: 'debug', value: 'debug' },
      ],
    },
  };
  const SERVICES = {
    services: {
      llm: {
        providers: [
          { contextId: 'zz-llm-b', displayName: '备用模型', priority: 0, exclusive: false },
          { contextId: 'zz-llm-a', displayName: '主模型', priority: 0, exclusive: false },
        ],
        preferred: 'zz-llm-b',
      },
      memory: { providers: [{ contextId: 'zz-memory', priority: 0, exclusive: false }], preferred: null },
    },
  };
  const settingRow = (label: string) => within(section().getByRole('group', { name: label }));

  function systemRest(extra: FakeRest = {}) {
    let config: Record<string, unknown> = { 'zz-text': 'Bot' };
    return settingsRest({
      '/api/config': (request: FakeRequest) => {
        if (request.method === 'PUT') {
          const body = request.body as Record<string, unknown>;
          for (const [key, value] of Object.entries(body)) {
            if (value === null) delete config[key];
            else config[key] = value;
          }
          config = { ...config };
          const restartNeeded = 'logLevel' in body;
          return { ok: true, message: '已保存', restartNeeded };
        }
        return { config, schema: SCHEMA, restartKeys: ['logLevel'], dataDir: '/srv/zz-bot/data' };
      },
      '/api/services': SERVICES,
      '/api/services/llm/prefer': { ok: true },
      '/api/restart': { ok: true, message: '正在重启应用' },
      ...extra,
    });
  }

  it('宿主配置每行写生效值、来源（配置文件、默认）与要重启的键；数据目录写出来', async () => {
    app = await renderApp('/settings/system', {}, systemRest());
    await section().findByRole('group', { name: '示例文本' });
    expect(settingRow('示例文本').getByText('Bot')).toBeTruthy();
    expect(settingRow('示例文本').getByText('配置文件')).toBeTruthy();
    expect(settingRow('示例文本').queryByText('重启后生效')).toBeNull();
    expect(settingRow('日志等级').getByText('info')).toBeTruthy();
    expect(settingRow('日志等级').getByText('默认')).toBeTruthy();
    expect(settingRow('日志等级').getByText('重启后生效')).toBeTruthy();
    expect(section().getByText('/srv/zz-bot/data')).toBeTruthy();
  });

  it('英文界面：目录、宿主配置的来源与生效时机、数据目录按英文', async () => {
    app = await renderApp('/settings/system', {}, systemRest(language(['en'])));
    await section().findByRole('group', { name: '示例文本' });
    expect(
      within(screen.getByRole('navigation', { name: 'Settings' }))
        .getAllByRole('link')
        .map(link => link.textContent),
    ).toEqual(['Session defaults', '权限', '技能', 'Appearance', 'System']);
    expect(settingRow('示例文本').getByText('Config file')).toBeTruthy();
    expect(settingRow('日志等级').getByText('Default')).toBeTruthy();
    expect(settingRow('日志等级').getByText('Applies after restart')).toBeTruthy();
    expect(section().getByRole('region', { name: 'Data directory' })).toBeTruthy();
  });

  it('改要重启的键：只送这一个键，保存后出「重启以生效」与重启按钮；改别的键不出；恢复默认与选空的一项送 null', async () => {
    app = await renderApp('/settings/system', {}, systemRest());
    await section().findByRole('group', { name: '示例文本' });
    fireEvent.click(settingRow('示例文本').getByRole('button', { name: /示例文本/ }));
    const box = settingRow('示例文本').getByRole('textbox', { name: '示例文本' });
    fireEvent.change(box, { target: { value: 'Aalis Two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(calls('/api/config', 'PUT').map(call => call.body)).toEqual([{ 'zz-text': 'Aalis Two' }]),
    );
    expect(section().queryByRole('button', { name: '重启' })).toBeNull();

    fireEvent.click(settingRow('日志等级').getByRole('button', { name: /日志等级/ }));
    choose(settingRow('日志等级').getByRole('combobox', { name: '日志等级' }), 'debug');
    await vi.waitFor(() => expect(calls('/api/config', 'PUT').at(-1)?.body).toEqual({ logLevel: 'debug' }));
    expect((await section().findByRole('status')).textContent).toContain('重启以生效');
    fireEvent.click(section().getByRole('button', { name: '重启' }));
    await vi.waitFor(() => expect(calls('/api/restart', 'POST')).toHaveLength(1));

    fireEvent.click(settingRow('示例文本').getByRole('button', { name: '恢复默认' }));
    await vi.waitFor(() => expect(calls('/api/config', 'PUT').at(-1)?.body).toEqual({ 'zz-text': null }));

    // 选空的一项与「恢复默认」一样写 null
    await vi.waitFor(() => expect(settingRow('日志等级').getByText('debug')).toBeTruthy());
    fireEvent.click(settingRow('日志等级').getByRole('button', { name: /日志等级/ }));
    choose(settingRow('日志等级').getByRole('combobox', { name: '日志等级' }), '不选');
    await vi.waitFor(() => expect(calls('/api/config', 'PUT').at(-1)?.body).toEqual({ logLevel: null }));
  });

  it('服务偏好：有几个提供者的服务列出来，写当前用的与来源；改选送偏好，恢复默认清除偏好；只有一个提供者的不列', async () => {
    app = await renderApp('/settings/system', {}, systemRest({ '/api/services/llm/prefer': { ok: true } }));
    const llm = within(await section().findByRole('group', { name: 'llm' }));
    expect(llm.getByText('备用模型')).toBeTruthy();
    expect(llm.getByText('服务偏好')).toBeTruthy();
    expect(section().queryByRole('group', { name: 'memory' })).toBeNull();

    fireEvent.click(llm.getByRole('button', { name: /llm/ }));
    choose(llm.getByRole('combobox', { name: 'llm' }), '主模型');
    await vi.waitFor(() =>
      expect(calls('/api/services/llm/prefer', 'POST').map(call => call.body)).toEqual([{ contextId: 'zz-llm-a' }]),
    );
    const reset = llm.getByRole('button', { name: '恢复默认' }) as HTMLButtonElement;
    await vi.waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    await vi.waitFor(() => expect(calls('/api/services/llm/prefer', 'DELETE')).toHaveLength(1));
  });

  it('模型服务的偏好（全局偏好）照常列成一行：标题生成、摘要等没设本插件偏好的插件用它', async () => {
    app = await renderApp('/settings/system', {}, systemRest());
    const llm = within(await section().findByRole('group', { name: 'llm' }));
    expect(llm.getByText('备用模型')).toBeTruthy();
    expect(section().queryByText(/会话默认/)).toBeNull();
    expect(requests('session/config/layer/get')).toEqual([]);
  });

  it('宿主配置没取到：写明原因、可以重试，「查看日志」链到提供界面的实例的日志', async () => {
    let fail = true;
    const rest = systemRest();
    const config = rest['/api/config'];
    app = await renderApp(
      '/settings/system',
      {},
      {
        ...rest,
        '/api/plugins': { plugins: [SESSIONS, plugin('zz-ui', { self: true })], secretRefCounts: {} },
        '/api/config': (request: FakeRequest) =>
          fail
            ? Response.json({ error: '配置文件读不出' }, { status: 500 })
            : (config as (request: FakeRequest) => unknown)(request),
      },
    );
    const alert = await section().findByRole('alert');
    expect(alert.textContent).toContain('宿主配置没取到');
    expect(alert.textContent).toContain('配置文件读不出');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-ui',
    );
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await section().findByRole('group', { name: '示例文本' })).toBeTruthy();
  });
  it('服务列表没取到：写明原因，可以重试，「查看日志」链到提供界面的实例的日志', async () => {
    let fail = true;
    app = await renderApp(
      '/settings/system',
      {},
      systemRest({
        '/api/plugins': { plugins: [SESSIONS, plugin('zz-ui', { self: true })], secretRefCounts: {} },
        '/api/services': () => (fail ? Response.json({ error: '服务表读不出' }, { status: 500 }) : SERVICES),
      }),
    );
    const alert = await section().findByRole('alert');
    expect(alert.textContent).toContain('服务列表没取到：服务表读不出');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-ui',
    );
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await section().findByRole('group', { name: 'llm' })).toBeTruthy();
  });

  it('保存之后重取宿主配置失败：写「宿主配置没刷新成功」与原因，可以重试，重试成功后显示新值', async () => {
    let failGet = false;
    const rest = systemRest();
    const config = rest['/api/config'] as (request: FakeRequest) => unknown;
    app = await renderApp(
      '/settings/system',
      {},
      {
        ...rest,
        '/api/plugins': { plugins: [SESSIONS, plugin('zz-ui', { self: true })], secretRefCounts: {} },
        '/api/config': (request: FakeRequest) => {
          if (request.method === 'GET' && failGet) return Response.json({ error: '配置文件读不出' }, { status: 500 });
          if (request.method === 'PUT') failGet = true;
          return config(request);
        },
      },
    );
    await section().findByRole('group', { name: '示例文本' });
    fireEvent.click(settingRow('示例文本').getByRole('button', { name: /示例文本/ }));
    const box = settingRow('示例文本').getByRole('textbox', { name: '示例文本' });
    fireEvent.change(box, { target: { value: 'Aalis Two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const alert = await section().findByRole('alert');
    expect(alert.textContent).toContain('宿主配置没刷新成功：配置文件读不出');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-ui',
    );
    failGet = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(settingRow('示例文本').getByText('Aalis Two')).toBeTruthy());
    expect(section().queryByRole('alert')).toBeNull();
  });
});
