// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { SettingLayer } from '../../packages/api-session-protocol/src/index.js';
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
import { stubPlatform, stubViewport } from '../helpers/browser.js';
import { FakeWebSocket } from '../helpers/fake-websocket.js';
import {
  choose,
  type FakeRequest,
  type FakeRest,
  type Harness,
  installDialog,
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
// - 会话默认按层读写，行与会话设置同一套组件，会话服务不在时整个分区不出现；
// - 插件分区从目录与地址都能进入，手动刷新让页面重取；
// - 外观：主题选择（跟随系统时深浅各选一个）、导入与导出、插件经贡献点提供的主题，快捷栏与会话面板标签的排序与开关；
// - 系统：宿主配置（来源与生效时机，要重启的键保存后出「重启以生效」）、服务偏好与家目录。
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
    expect(section().getByRole('link', { name: '去插件详情' }).getAttribute('href')).toBe('/plugins/zz-sessions');
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
  const DEFAULTS: SettingLayer = { scope: 'defaults' };
  const WEBUI: SettingLayer = { scope: 'platform', platform: 'webui' };
  const QQ: SettingLayer = { scope: 'platform', platform: 'qq' };
  const QQ_GROUP: SettingLayer = { scope: 'audience', platform: 'qq', audience: 'group' };
  const ROWS = {
    defaults: [
      row('llm', {
        field: { type: 'llm-ref', label: '模型' },
        plugin: 'zz-agent',
        prominence: 'composer',
        unset: '跟随服务偏好',
      }),
      row('persona', {
        field: { type: 'string', label: '人设' },
        value: '<默认人设>',
        effective: '<默认人设>',
        source: 'defaults',
      }),
      row('iterations', {
        field: { type: 'number', label: '最大工具迭代' },
        plugin: 'zz-agent',
        prominence: 'advanced',
      }),
    ],
    qq: [row('persona', { field: { type: 'string', label: '人设' }, effective: '<默认人设>', source: 'defaults' })],
    group: [
      row('persona', {
        field: { type: 'string', label: '人设' },
        value: '<群人设>',
        effective: '<群人设>',
        source: 'audience',
      }),
    ],
  };
  const layerKey = (layer: SettingLayer) =>
    layer.scope === 'defaults' ? 'defaults' : layer.scope === 'platform' ? 'qq' : 'group';

  function handlers(layers: SettingLayer[] = [DEFAULTS, QQ, QQ_GROUP, WEBUI]) {
    return {
      'session/config/layers': () => ({ layers }),
      'session/config/layer/get': ({ layer }: { layer: SettingLayer }) => ({ items: ROWS[layerKey(layer)] }),
      'session/config/layer/update': ({ layer }: { layer: SettingLayer }) => ({ items: ROWS[layerKey(layer)] }),
    };
  }
  const picker = () => section().getByRole('combobox', { name: '层' });
  const settingRow = (label: string) => within(section().getByRole('group', { name: label }));

  it('层选择器列出服务端给的层，平台档与群、私聊条目写明是哪个平台；行与会话设置同一套：常用在前、「高级」折叠，每行写生效值与来源', async () => {
    app = await renderApp('/settings/session-defaults', handlers(), settingsRest());
    await section().findByRole('group', { name: '人设' });
    expect(optionsOf(picker())).toEqual(['全局默认', '平台档：qq', '平台档：qq · 群', '平台档：webui']);
    expect(requests('session/config/layer/get')).toEqual([{ layer: DEFAULTS }]);
    expect(settingRow('人设').getByText('<默认人设>')).toBeTruthy();
    expect(settingRow('人设').getByText('默认')).toBeTruthy();
    expect(settingRow('模型').getByText('跟随服务偏好')).toBeTruthy();
    expect(section().queryByRole('group', { name: '最大工具迭代' })).toBeNull();
    expect(section().getByRole('button', { name: '高级' }).getAttribute('aria-expanded')).toBe('false');
    expect(section().queryByText(/按平台名生效/)).toBeNull();

    choose(picker(), '平台档：qq · 群');
    await vi.waitFor(() => expect(requests('session/config/layer/get').at(-1)).toEqual({ layer: QQ_GROUP }));
    await vi.waitFor(() => expect(settingRow('人设').getByText('<群人设>')).toBeTruthy());
    expect(settingRow('人设').getByText('受众')).toBeTruthy();
    expect(section().getByText(/平台档按平台名生效，不区分实例/)).toBeTruthy();
  });

  it('改一项写进选中的这一层；被这一层覆盖的行有「恢复继承」，写 null', async () => {
    app = await renderApp('/settings/session-defaults', handlers(), settingsRest());
    choose(await section().findByRole('combobox', { name: '层' }), '平台档：qq · 群');
    await vi.waitFor(() => expect(settingRow('人设').getByText('<群人设>')).toBeTruthy());
    fireEvent.click(settingRow('人设').getByRole('button', { name: /人设/ }));
    const box = settingRow('人设').getByRole('textbox', { name: '人设' });
    fireEvent.change(box, { target: { value: '<新的群人设>' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() =>
      expect(requests('session/config/layer/update')).toEqual([
        { layer: QQ_GROUP, patch: { persona: '<新的群人设>' } },
      ]),
    );
    const reset = settingRow('人设').getByRole('button', { name: '恢复继承' }) as HTMLButtonElement;
    await vi.waitFor(() => expect(reset.disabled).toBe(false));
    fireEvent.click(reset);
    await vi.waitFor(() =>
      expect(requests('session/config/layer/update').at(-1)).toEqual({ layer: QQ_GROUP, patch: { persona: null } }),
    );
  });

  it('没取到时写明原因，可以重试，「查看日志」链到提供会话协议的实例的日志', async () => {
    let fail = true;
    app = await renderApp(
      '/settings/session-defaults',
      {
        ...handlers(),
        'session/config/layer/get': ({ layer }: { layer: SettingLayer }) => {
          if (fail) throw new Error('设置读不出');
          return { items: ROWS[layerKey(layer)] };
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

  it('设置项或层变了（session/config/changed、插件启停）时重取；选中的层没了回到全局默认', async () => {
    let layers = [DEFAULTS, QQ, QQ_GROUP, WEBUI];
    app = await renderApp(
      '/settings/session-defaults',
      { ...handlers(), 'session/config/layers': () => ({ layers }) },
      settingsRest(),
    );
    choose(await section().findByRole('combobox', { name: '层' }), '平台档：qq');
    await vi.waitFor(() => expect(requests('session/config/layer/get').at(-1)).toEqual({ layer: QQ }));

    act(() => server().notify('session/config/changed', {}));
    await vi.waitFor(() => expect(requests('session/config/layers')).toHaveLength(2));
    await vi.waitFor(() => expect(requests('session/config/layer/get')).toHaveLength(3));
    expect(requests('session/config/layer/get').at(-1)).toEqual({ layer: QQ });

    layers = [DEFAULTS, WEBUI];
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(requests('session/config/layers')).toHaveLength(3));
    await vi.waitFor(() => expect(picker().textContent).toBe('全局默认'));
    expect(requests('session/config/layer/get').at(-1)).toEqual({ layer: DEFAULTS });

    // 那一层之后再出现也不自己切回去：改动照旧写进看着的全局默认
    layers = [DEFAULTS, QQ, QQ_GROUP, WEBUI];
    act(() => admin().push({ type: 'plugins.changed' }));
    await vi.waitFor(() => expect(requests('session/config/layers')).toHaveLength(4));
    await vi.waitFor(() => expect(optionsOf(picker())).toHaveLength(4));
    expect(picker().textContent).toBe('全局默认');
    expect(requests('session/config/layer/get').at(-1)).toEqual({ layer: DEFAULTS });
  });

  it('可选项依赖另一项的行按这一层的生效值取：换了层，按那一层的模型重取深度思考的档位', async () => {
    const model = (name: string) => ({ provider: 'zz-llm', model: name });
    const levels = (name: string) =>
      `/api/models/llm-thinking?dependency=${encodeURIComponent(JSON.stringify(model(name)))}`;
    const rowsFor = (name: string) => [
      row('llm', { field: { type: 'llm-ref', label: '模型' }, effective: model(name), source: 'defaults' }),
      row('think', {
        field: { type: 'select', label: '深度思考', dynamicOptions: 'llm-thinking' },
        dependsOn: 'llm',
        effective: 'high',
        source: 'defaults',
      }),
    ];
    app = await renderApp(
      '/settings/session-defaults',
      {
        ...handlers(),
        'session/config/layer/get': ({ layer }: { layer: SettingLayer }) => ({
          items: rowsFor(layer.scope === 'defaults' ? 'deep' : 'plain'),
        }),
      },
      settingsRest({
        '/api/models/llm': { providers: [] },
        [levels('deep')]: {
          details: [
            { value: 'off', label: '关' },
            { value: 'high', label: '高', default: true },
          ],
        },
        [levels('plain')]: { details: [] },
      }),
    );
    await section().findByRole('group', { name: '深度思考' });
    expect(await settingRow('深度思考').findByText('高')).toBeTruthy();
    choose(picker(), '平台档：qq');
    await vi.waitFor(() => expect(settingRow('深度思考').getByText('当前模型不能调')).toBeTruthy());
    expect(calls(levels('plain'))).toHaveLength(1);
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
    name: { type: 'string', label: '应用名称', default: 'Aalis' },
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
    let config: Record<string, unknown> = { name: 'Bot' };
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
        return { config, schema: SCHEMA, restartKeys: ['logLevel'], home: '/home/zz/.aalis' };
      },
      '/api/services': SERVICES,
      '/api/services/llm/prefer': { ok: true },
      '/api/restart': { ok: true, message: '正在重启应用' },
      ...extra,
    });
  }

  it('宿主配置每行写生效值、来源（配置文件、默认）与要重启的键；家目录写出来', async () => {
    app = await renderApp('/settings/system', {}, systemRest());
    await section().findByRole('group', { name: '应用名称' });
    expect(settingRow('应用名称').getByText('Bot')).toBeTruthy();
    expect(settingRow('应用名称').getByText('配置文件')).toBeTruthy();
    expect(settingRow('应用名称').queryByText('重启后生效')).toBeNull();
    expect(settingRow('日志等级').getByText('info')).toBeTruthy();
    expect(settingRow('日志等级').getByText('默认')).toBeTruthy();
    expect(settingRow('日志等级').getByText('重启后生效')).toBeTruthy();
    expect(section().getByText('/home/zz/.aalis')).toBeTruthy();
  });

  it('改要重启的键：只送这一个键，保存后出「重启以生效」与重启按钮；改别的键不出；恢复默认与选空的一项送 null', async () => {
    app = await renderApp('/settings/system', {}, systemRest());
    await section().findByRole('group', { name: '应用名称' });
    fireEvent.click(settingRow('应用名称').getByRole('button', { name: /应用名称/ }));
    const box = settingRow('应用名称').getByRole('textbox', { name: '应用名称' });
    fireEvent.change(box, { target: { value: 'Aalis Two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await vi.waitFor(() => expect(calls('/api/config', 'PUT').map(call => call.body)).toEqual([{ name: 'Aalis Two' }]));
    expect(section().queryByRole('button', { name: '重启' })).toBeNull();

    fireEvent.click(settingRow('日志等级').getByRole('button', { name: /日志等级/ }));
    choose(settingRow('日志等级').getByRole('combobox', { name: '日志等级' }), 'debug');
    await vi.waitFor(() => expect(calls('/api/config', 'PUT').at(-1)?.body).toEqual({ logLevel: 'debug' }));
    expect((await section().findByRole('status')).textContent).toContain('重启以生效');
    fireEvent.click(section().getByRole('button', { name: '重启' }));
    await vi.waitFor(() => expect(calls('/api/restart', 'POST')).toHaveLength(1));

    fireEvent.click(settingRow('应用名称').getByRole('button', { name: '恢复默认' }));
    await vi.waitFor(() => expect(calls('/api/config', 'PUT').at(-1)?.body).toEqual({ name: null }));

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
    expect(await section().findByRole('group', { name: '应用名称' })).toBeTruthy();
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
    await section().findByRole('group', { name: '应用名称' });
    fireEvent.click(settingRow('应用名称').getByRole('button', { name: /应用名称/ }));
    const box = settingRow('应用名称').getByRole('textbox', { name: '应用名称' });
    fireEvent.change(box, { target: { value: 'Aalis Two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const alert = await section().findByRole('alert');
    expect(alert.textContent).toContain('宿主配置没刷新成功：配置文件读不出');
    expect(within(alert).getByRole('link', { name: '查看日志' }).getAttribute('href')).toBe(
      '/health/logs?plugin=zz-ui',
    );
    failGet = false;
    fireEvent.click(within(alert).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(settingRow('应用名称').getByText('Aalis Two')).toBeTruthy());
    expect(section().queryByRole('alert')).toBeNull();
  });
});
