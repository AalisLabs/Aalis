import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type HostConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type BoundWebui, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, defineService, type Logger, optional, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { textsBlock } from '../../packages/plugin-webui-server/src/html.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { missingConfigError } from '../../packages/schema-config/src/index.js';
import { defineTexts, fingerprint, TextError } from '../../packages/schema-i18n/src/index.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的 REST 出口按读者语言渲染文字对象：读者语言先看 cookie aalis-lang，没有再看 Accept-Language；i18n 是真的
// plugin-i18n，缺席时一律原文。夹具插件在页面声明、页面数据、动作结果与提示里交出文字对象，平台适配器抛出 TextError；
// 插件配置值、schema 与动作输入字段的默认值、插件前端的数据是原样数据，里面伪造的文字对象不被换掉。另有缺服务与缺配置的
// 两个夹具插件，核插件状态与回执里的
// 原因；宿主配置文档只在要用 /api/config 的用例里给。webui-server 自己的文字（接口报错、登录页与恢复页、access.txt）、
// 可选项来源与 /api/i18n 的两条路由另成一组：贡献点与语言包、存储与会话管理的替身只在要用的用例里给。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-webui-i18n-token-placeholder-000';
const OWNER = '@zz/i18n-owner';
const LACKING = '@zz/i18n-lacking';
const FAILING = '@zz/i18n-failing';

/** 没有插件提供的服务 */
const absent = defineService<object>('zz-i18n-absent');

const t = defineTexts({
  ns: OWNER,
  language: 'zh-CN',
  source: {
    title: '任务',
    tab: '概况',
    label: '列表',
    description: '全部任务',
    empty: '没有任务',
    column: '名字',
    kind: '人物',
    create: '新建',
    remove: '删除',
    confirm: '删除后不能恢复',
    running: '运行中',
    paused: '已暂停',
    count: '数量',
    node: '甲',
    edge: '认识',
    file: '文件 {name}',
    created: '已新建 {name}',
    notice: '{count, number} 件待处理',
    detail: '去设置里看',
    down: '平台掉线',
    times: '次数',
  } as const,
  locales: {
    en: {
      title: 'Jobs',
      tab: 'Overview',
      label: 'List',
      description: 'All jobs',
      empty: 'No jobs',
      column: 'Name',
      kind: 'Person',
      create: 'Create',
      remove: 'Remove',
      confirm: 'This cannot be undone',
      running: 'Running',
      paused: 'Paused',
      count: 'Count',
      node: 'A',
      edge: 'knows',
      file: 'File {name}',
      created: 'Created {name}',
      notice: '{count, plural, one {# item} other {# items}} to handle',
      detail: 'See settings',
      down: 'Platform down',
      times: 'Times',
    },
  },
});

/** 形如文字对象的原样数据：真被渲染了，英文读者会看到 Jobs */
const FORGED = { i18n: OWNER, key: 'title', source: '伪造' };

const CHINESE = {
  declaration: ['任务', '概况', '列表', '全部任务', '没有任务', '名字', '人物', '新建', '删除后不能恢复'],
  table: [{ id: 'a', state: { text: '运行中', state: 'running' }, note: '已暂停' }],
  graph: {
    nodes: [
      { id: 'a', label: '甲' },
      { id: 'b', label: 'b' },
    ],
    edges: [{ source: 'a', target: 'b', label: '认识' }],
  },
  info: [{ label: '数量', value: '已暂停' }],
  markdown: '文件 a\\_b',
  action: '已新建 a_b',
  notice: [['3 件待处理', '去设置里看']],
};

const ENGLISH = {
  declaration: ['Jobs', 'Overview', 'List', 'All jobs', 'No jobs', 'Name', 'Person', 'Create', 'This cannot be undone'],
  table: [{ id: 'a', state: { text: 'Running', state: 'running' }, note: 'Paused' }],
  graph: {
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'b' },
    ],
    edges: [{ source: 'a', target: 'b', label: 'knows' }],
  },
  info: [{ label: 'Count', value: 'Paused' }],
  markdown: 'File a\\_b',
  action: 'Created a_b',
  notice: [['3 items to handle', 'See settings']],
};

/** 文档级 CSP：登录页与恢复页照旧带它 */
const DOCUMENT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

/**
 * 语言包：日语补夹具字典的 title，另给一个别的 ns（核按 ns 筛），把 webui-server 的 pageLanguage 译成不合法的语言标签；
 * 英语只给那个别的 ns
 */
const packs = definePlugin({
  name: '@zz/i18n-packs',
  uses: { contributions },
  apply({ contributions }) {
    contributions.use.contribute('i18n:pack', {
      id: 'ja',
      language: 'ja',
      entries: {
        [OWNER]: { title: { text: 'ジョブ', from: fingerprint('任务') } },
        '@zz/other': { hi: { text: 'やあ', from: fingerprint('你好') } },
        '@aalis/plugin-webui-server': {
          pageLanguage: { text: 'ja" onmouseover="alert(1)', from: fingerprint('zh-CN') },
        },
      },
    });
    contributions.use.contribute('i18n:pack', {
      id: 'en',
      language: 'en',
      entries: { '@zz/other': { hi: { text: 'Hi', from: fingerprint('你好') } } },
    });
  },
});

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 插件前端所在的插件包：包根的 package.json 名为插件名，webui/ 里有入口。回声明页面的模块地址 */
function framePackage(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-webui-i18n-')));
  dirs.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: OWNER }));
  mkdirSync(join(root, 'webui'));
  writeFileSync(join(root, 'webui', 'index.html'), '<!doctype html><title>原样</title>');
  return pathToFileURL(join(root, 'index.js')).href;
}

function definePages(webui: BoundWebui, frameModule: string) {
  webui.definePage({
    key: 'jobs',
    title: t('title'),
    actions: {
      create: { label: t('create'), effect: 'write', handler: () => t('created', { name: 'a_b' }) },
      fail: {
        label: '失败',
        effect: 'read',
        handler: () => {
          throw new TextError(t('down'));
        },
      },
      gone: {
        label: '不在',
        effect: 'read',
        handler: () => {
          throw new TextError(t('down'), { status: 404 });
        },
      },
      remove: { label: t('remove'), effect: 'destructive', confirm: t('confirm'), handler: () => {} },
      repeat: {
        label: '重复',
        effect: 'write',
        input: {
          times: { type: 'number', label: t('times') },
          note: { type: 'string', label: '备注', default: FORGED },
        },
        handler: () => {},
      },
    },
    content: {
      tabs: [
        {
          key: 'main',
          title: t('tab'),
          content: [
            {
              type: 'table',
              id: 'list',
              label: t('label'),
              description: t('description'),
              empty: t('empty'),
              rowKey: 'id',
              columns: [
                { key: 'id', label: t('column') },
                { key: 'state', label: '状态', kind: 'status' },
              ],
              data: () => [{ id: 'a', state: { text: t('running'), state: 'running' }, note: t('paused') }],
            },
            {
              type: 'graph',
              id: 'graph',
              nodeKinds: [{ kind: 'person', label: t('kind'), tone: 1 }],
              data: () => ({
                nodes: [
                  { id: 'a', label: t('node') },
                  { id: 'b', label: 'b' },
                ],
                edges: [{ source: 'a', target: 'b', label: t('edge') }],
              }),
            },
            { type: 'info', id: 'info', data: () => [{ label: t('count'), value: t('paused') }] },
            { type: 'markdown', id: 'md', data: () => t('file', { name: 'a_b' }) },
            { type: 'markdown', id: 'languages', data: ({ ctx }) => ctx.languages.join(' ') },
            { type: 'actions', actions: ['create', 'remove'] },
          ],
        },
      ],
    },
  });
  webui.definePage({
    key: 'board',
    title: '看板',
    frame: { module: frameModule },
    sources: { raw: { data: () => ({ note: FORGED }) } },
  });
  webui.notify({ id: 'todo', level: 'action', title: t('notice', { count: 3 }), detail: t('detail') });
}

/** 宿主配置文档：只读核心键 */
function hostDoc(): HostConfig {
  return { getAll: () => ({ name: 'T', logLevel: 'info' }), getPluginConfig: () => ({}) } as unknown as HostConfig;
}

/** 存储的替身：只记下写进去的文件 */
function memoryStorage(written: Map<string, string>): StorageService {
  return {
    listRoots: () => [],
    writeFile: async (uri: string, data: string) => void written.set(uri, data),
    readFile: async (uri: string) => {
      throw Object.assign(new Error(`ENOENT: ${uri}`), { code: 'ENOENT' });
    },
  } as unknown as StorageService;
}

interface SetupOptions {
  withI18n?: boolean;
  /** 给了就用这个替身代替 plugin-i18n */
  i18nService?: I18nService;
  withDoc?: boolean;
  /** 贡献点与日语语言包 */
  withHubs?: boolean;
  /** 会话管理的替身：全局默认层设的语言（i18n 登记的语言设置项收下不管）；另给存储的替身，写下的文件记在 written */
  hostLanguage?: string;
  written?: Map<string, string>;
}

async function setup({
  withI18n = true,
  i18nService,
  withDoc = false,
  withHubs = false,
  hostLanguage,
  written,
}: SetupOptions = {}) {
  const port = await freePort();
  const quiet = () => {};
  const logger: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, child: () => logger };
  const app = new App({ name: 'T', logLevel: 'info', logger });
  apps.push(app);
  const frameModule = framePackage();
  const fault: { error?: Error } = {};
  const owner = definePlugin({
    name: OWNER,
    displayName: t('title'),
    configSchema: {
      seed: { type: 'string', label: '种子', default: FORGED },
      level: { type: 'number', label: '级别', min: 1 },
      group: { label: '分组', fields: { inner: { type: 'string', label: '内层', default: FORGED } } },
      rows: {
        type: 'array',
        label: '行',
        items: { cell: { type: 'string', label: '格', default: FORGED } },
        default: [{ cell: FORGED }],
      },
    },
    uses: { webui: optional(webuiServer), provide },
    apply: ({ webui, provide }) => {
      definePages(webui.use, frameModule);
      provide.use(platform, {
        adapterName: 'zz',
        platform: 'zz',
        getConnections: () => {
          if (fault.error) throw fault.error;
          return [];
        },
        sendMessage: async () => {},
      });
    },
  });
  const host = definePlugin({
    name: '@zz/i18n-host',
    provides: [hostConfig],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(hostConfig, hostDoc());
    },
  });
  const doubles = definePlugin({
    name: '@zz/i18n-doubles',
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(sessionManager, {
        getLayer: () => ({ language: [hostLanguage] }),
        resolveConfig: () => ({}),
        getSession: () => undefined,
        registerSetting: () => () => {},
      } as never);
      provide.use(storage, memoryStorage(written ?? new Map()));
    },
  });
  await app.pluginAll([
    ...(withHubs ? [...HUB_PLUGINS, packs].map(definition => ({ definition })) : []),
    ...(hostLanguage === undefined ? [] : [{ definition: doubles }]),
    ...(withI18n && !i18nService ? [{ definition: i18nPlugin }] : []),
    ...(i18nService
      ? [
          {
            definition: definePlugin({
              name: '@zz/i18n-double',
              uses: { provide },
              apply: ({ provide }) => {
                provide.use(i18n, i18nService);
              },
            }),
          },
        ]
      : []),
    ...(withDoc ? [{ definition: host }] : []),
    { definition: definePlugin({ name: LACKING, uses: { absent }, apply() {} }) },
    {
      definition: definePlugin({
        name: FAILING,
        apply() {
          throw missingConfigError('apiKey');
        },
      }),
    },
    {
      definition: webuiServerPlugin,
      config: { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
    },
    { definition: owner, config: { blob: FORGED } },
  ]);
  await app.plugins.idle();
  await app.start();
  await waitListening(port);

  /** 带登录 cookie 与读者的语言（cookie 的值与 Accept-Language）请求 */
  const reader =
    ({ lang, accept }: { lang?: string; accept?: string }) =>
    (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {
          cookie: [`aalis_webui_token=${TOKEN}`, ...(lang === undefined ? [] : [`aalis-lang=${lang}`])].join('; '),
          ...(accept === undefined ? {} : { 'accept-language': accept }),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
  /** 不带登录 cookie、只带读者语言的请求：登录页 */
  const anonymous = (lang: string) => fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: `aalis-lang=${lang}` } });
  return { reader, fault, port, anonymous };
}

type Request = ReturnType<Awaited<ReturnType<typeof setup>>['reader']>;
const json = async (response: Promise<Response>) => (await response).json();
const at = (pageKey: string) => `/api/pages/${encodeURIComponent(OWNER)}/${pageKey}`;

/** 读者看到的：页面声明、各组件的数据、动作结果、提示，以及插件收到的语言链 */
async function shown(request: Request) {
  const { pages } = await json(request('/api/pages'));
  const jobs = pages.find((page: { key: string }) => page.key === 'jobs');
  const tab = jobs.content.tabs[0];
  const [table, graph] = tab.content;
  const data = async (id: string) => (await json(request(`${at('jobs')}/data/${id}`))).data;
  const { items } = await json(request('/api/attention'));
  return {
    declaration: [
      jobs.title,
      tab.title,
      table.label,
      table.description,
      table.empty,
      table.columns[0].label,
      graph.nodeKinds[0].label,
      jobs.actions.create.label,
      jobs.actions.remove.confirm,
    ],
    table: await data('list'),
    graph: await data('graph'),
    info: await data('info'),
    markdown: await data('md'),
    action: (await json(request(`${at('jobs')}/actions/create`, { method: 'POST', body: '{}' }))).message,
    notice: items
      .filter((item: { kind: string }) => item.kind === 'notice')
      .map((item: { title: string; detail: string }) => [item.title, item.detail]),
    languages: await data('languages'),
  };
}

describe('REST 回应按读者语言渲染', () => {
  it('cookie 为 en 时拿到英文，为 zh-CN 时拿到原文（cookie 先于 Accept-Language）；插件收到语言链，回应带 Vary', async () => {
    const { reader } = await setup();
    expect(await shown(reader({ lang: 'en' }))).toEqual({ ...ENGLISH, languages: 'en' });
    expect(await shown(reader({ lang: 'zh-CN|en', accept: 'en' }))).toEqual({ ...CHINESE, languages: 'zh-CN en' });
    expect((await reader({ lang: 'en' })('/api/pages')).headers.get('vary')).toBe('Cookie, Accept-Language');
  });

  it('没有 cookie 时看 Accept-Language；不按可用语言筛，zh 读者命中 zh-CN', async () => {
    const { reader } = await setup();
    expect(await shown(reader({ accept: 'en-US,en;q=0.9' }))).toEqual({ ...ENGLISH, languages: 'en-US en' });
    expect(await shown(reader({ accept: 'zh, en;q=0.5' }))).toEqual({ ...CHINESE, languages: 'zh en' });
  });

  it('cookie 里的语言按语言部分都对不上可用语言（语言包卸了）时当作没给，看 Accept-Language；zh 照样命中 zh-CN', async () => {
    const { reader } = await setup();
    expect(await shown(reader({ lang: 'fr', accept: 'zh-CN' }))).toEqual({ ...CHINESE, languages: 'zh-CN' });
    expect(await shown(reader({ lang: 'zh', accept: 'en' }))).toEqual({ ...CHINESE, languages: 'zh' });
  });

  it.each([
    ['zh-CN', CHINESE],
    ['en', ENGLISH],
  ])('cookie 给不出能用的语言、Accept-Language 给不出语言（没有或全不合法）时按全局默认层（设为 %s）', async (hostLanguage, expected) => {
    const { reader } = await setup({ hostLanguage });
    expect(await shown(reader({}))).toEqual({ ...expected, languages: hostLanguage });
    expect(await shown(reader({ lang: 'fr', accept: 'bad tag!' }))).toEqual({ ...expected, languages: hostLanguage });
  });

  it('Accept-Language 去掉 q=0 的，按 q 从高到低；无效的标签先剔除，再取前 8 项；合法的长标签照收', async () => {
    const { reader } = await setup();
    expect(await shown(reader({ accept: 'en;q=0, zh-CN;q=0.5, ja;q=0.8' }))).toEqual({
      ...CHINESE,
      languages: 'ja zh-CN',
    });
    const junk = Array.from({ length: 8 }, (_, i) => `a${i}`);
    expect(await shown(reader({ accept: [...junk, 'zh-CN'].join(',') }))).toEqual({ ...CHINESE, languages: 'zh-CN' });
    const long = 'en-US-u-ca-gregory-nu-latn-hc-h23-x-foo';
    expect(await shown(reader({ accept: `${long},zh-CN` }))).toEqual({
      ...ENGLISH,
      languages: 'en-US-u-ca-gregory-hc-h23-nu-latn-x-foo zh-CN',
    });
  });

  it('i18n 缺席时一律原文，插件收到的语言链为空', async () => {
    const { reader } = await setup({ withI18n: false });
    expect(await shown(reader({ lang: 'en' }))).toEqual({ ...CHINESE, languages: '' });
  });

  it('i18n 渲染抛错：回应照常是 200，文字按原文；插件收到的语言链为空', async () => {
    const fail = () => {
      throw new Error('<i18n 坏了>');
    };
    const { reader } = await setup({ i18nService: { render: fail, chainOf: fail, languages: () => [] } });
    const response = await reader({ lang: 'en' })('/api/pages');
    expect(response.status).toBe(200);
    const { pages } = await response.json();
    expect(pages.find((page: { key: string }) => page.key === 'jobs').title).toBe('任务');
    expect(await shown(reader({ lang: 'en' }))).toEqual({ ...CHINESE, languages: '' });
  });

  it('抛出的 TextError 按读者语言写进 error，状态码取它的 status，没有时 400', async () => {
    const { reader, fault } = await setup();
    fault.error = new TextError(t('down'), { status: 503 });
    const outage = await reader({ lang: 'en' })('/api/platforms');
    expect([outage.status, await outage.json()]).toEqual([503, { error: 'Platform down' }]);
    fault.error = new TextError(t('down'));
    const refused = await reader({ lang: 'zh-CN' })('/api/platforms');
    expect([refused.status, await refused.json()]).toEqual([400, { error: '平台掉线' }]);
  });

  it('插件的配置值、schema 与动作输入字段的默认值、插件前端的数据原样返回，里面伪造的文字对象不被换掉', async () => {
    const { reader } = await setup();
    const request = reader({ lang: 'en' });
    const { plugins } = await json(request('/api/plugins'));
    const item = plugins.find((plugin: { instanceId: string }) => plugin.instanceId === OWNER);
    const rows = [{ cell: FORGED }];
    expect([item.config, item.defaultConfig]).toEqual([
      { blob: FORGED },
      { seed: FORGED, group: { inner: FORGED }, rows },
    ]);
    const { seed, group, rows: array } = item.configSchema;
    expect([seed.default, group.fields.inner.default, array.default, array.items.cell.default]).toEqual([
      FORGED,
      FORGED,
      rows,
      FORGED,
    ]);
    const { pages } = await json(request('/api/pages'));
    const { input } = pages.find((page: { key: string }) => page.key === 'jobs').actions.repeat;
    expect([input.note.default, input.times.label]).toEqual([FORGED, 'Times']);
    expect(await json(request(`${at('board')}/data/raw`))).toEqual({ data: { note: FORGED } });
  });
});

describe('配置表单、校验问题与插件状态的原因按读者语言', () => {
  it('核心配置表单经 /api/config 按读者语言给出；没过校验时的说明也是', async () => {
    const { reader } = await setup({ withDoc: true });
    const english = reader({ lang: 'en' });
    const labels = async (request: Request) => {
      const { schema } = await json(request('/api/config'));
      return [schema.name.label, schema.logLevel.label, schema.slowThresholdMs.label];
    };
    expect(await labels(english)).toEqual(['App name', 'Log level', 'Slow operation threshold (ms)']);
    expect(await labels(reader({ lang: 'zh-CN' }))).toEqual(['应用名称', '日志等级', '慢操作阈值（毫秒）']);
    const refused = await english('/api/config', { method: 'PUT', body: JSON.stringify({ logLevel: 'loud' }) });
    expect([refused.status, await refused.json()]).toEqual([
      400,
      { error: 'logLevel: not one of the options ("debug", "info", "warn", and "error")' },
    ]);
  });

  it('动作的输入字段与没过校验时的说明按读者语言', async () => {
    const { reader } = await setup();
    const english = reader({ lang: 'en' });
    const { pages } = await json(english('/api/pages'));
    expect(pages.find((page: { key: string }) => page.key === 'jobs').actions.repeat.input.times.label).toBe('Times');
    const refused = await english(`${at('jobs')}/actions/repeat`, {
      method: 'POST',
      body: JSON.stringify({ input: { times: 'many' } }),
    });
    expect([refused.status, (await refused.json()).error]).toEqual([
      400,
      'Input failed validation: times: expected a finite number, got string',
    ]);
  });

  it('没过校验的逐项问题：message 按读者语言，线上不另带 text（动作的输入与插件配置）', async () => {
    const { reader } = await setup({ withDoc: true });
    const english = reader({ lang: 'en' });
    const input = await english(`${at('jobs')}/actions/repeat`, {
      method: 'POST',
      body: JSON.stringify({ input: { times: 'many' } }),
    });
    expect((await input.json()).issues).toEqual([
      { path: 'times', kind: 'invalid', code: 'type', message: 'expected a finite number, got string' },
    ]);
    const config = await english(`/api/plugins/${encodeURIComponent(OWNER)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config: { level: 0 } }),
    });
    expect([config.status, (await config.json()).issues]).toEqual([
      400,
      [{ path: 'level', kind: 'invalid', code: 'min', message: 'less than the minimum 1' }],
    ]);
  });

  it('插件失败的说明（插件列表与需要处理）与回执里缺服务的链按读者语言', async () => {
    const { reader } = await setup();
    const english = reader({ lang: 'en' });
    const { plugins } = await json(english('/api/plugins'));
    const failed = 'Missing config item apiKey; set it in the WebUI or the config file to apply';
    expect(plugins.find((plugin: { instanceId: string }) => plugin.instanceId === FAILING).error).toBe(failed);
    const { items } = await json(english('/api/attention'));
    expect(items.find((item: { instance?: string }) => item.instance === FAILING).error).toBe(failed);
    const reloaded = await english(`/api/plugins/${encodeURIComponent(LACKING)}/reload`, {
      method: 'POST',
      body: '{}',
    });
    expect(await reloaded.json()).toEqual({
      ok: true,
      message: `Plugin ${LACKING} reloaded; not yet active: missing service zz-i18n-absent (no installed plugin provides it)`,
    });
  });
});

/** 页面里给外链脚本的文字 */
function textsOf(html: string): Record<string, string> {
  const block = /<script type="application\/json" id="texts">(.*?)<\/script>/s.exec(html)?.[1];
  if (block === undefined) throw new Error(`页面里没有 texts 块：${html}`);
  return JSON.parse(block);
}

/** 页面上语言切换的选项：标签、自称、是否选中 */
const switchOf = (html: string) =>
  [...html.matchAll(/<option value="([^"]+)"( selected)?>([^<]+)<\/option>/g)].map(([, tag, selected, name]) => [
    tag,
    name,
    selected !== undefined,
  ]);

describe('webui-server 自己的文字按读者语言', () => {
  it('接口报错：未知 API、插件不存在、页面动作抛出的 TextError（经 guarded 接住，带 400–599 的 status 时用它）', async () => {
    const { reader } = await setup();
    const english = reader({ lang: 'en' });
    const unknown = await english('/api/zz-unknown');
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: 'Unknown API: GET /api/zz-unknown' }]);
    const missing = await english('/api/plugins/zz-none/reload', { method: 'POST', body: '{}' });
    expect([missing.status, await missing.json()]).toEqual([404, { error: 'Plugin zz-none does not exist' }]);
    const failed = await english(`${at('jobs')}/actions/fail`, { method: 'POST', body: '{}' });
    expect([failed.status, await failed.json()]).toEqual([500, { error: 'Platform down' }]);
    const gone = await english(`${at('jobs')}/actions/gone`, { method: 'POST', body: '{}' });
    expect([gone.status, await gone.json()]).toEqual([404, { error: 'Platform down' }]);
  });

  it('请求体解析不了时给字典里的整句，不透传库的原句', async () => {
    const { reader } = await setup();
    const put = (lang: string, body: string, headers?: Record<string, string>) =>
      reader({ lang })('/api/config', { method: 'PUT', body, headers });
    const answer = async (response: Promise<Response>) => {
      const got = await response;
      return [got.status, await got.json()];
    };
    const notJson = { error: 'The request body must be a valid JSON object or array' };
    expect(await answer(put('en', '{bad json'))).toEqual([400, notJson]);
    expect(await answer(put('en', 'null'))).toEqual([400, notJson]);
    expect(await answer(put('zh-CN', '{bad json'))).toEqual([400, { error: '请求体要是合法的 JSON 对象或数组' }]);
    expect(await answer(put('en', '{}', { 'content-type': 'application/json; charset=klingon' }))).toEqual([
      415,
      { error: 'The charset or content encoding of the request body is not supported' },
    ]);
  });

  it('未登录的 API 请求回 401，说明按读者语言', async () => {
    const { port } = await setup();
    const unauthenticated = (lang: string) =>
      fetch(`http://127.0.0.1:${port}/api/plugins`, { headers: { cookie: `aalis-lang=${lang}` } });
    const english = await unauthenticated('en');
    expect([english.status, await english.json()]).toEqual([401, { error: 'Not signed in' }]);
    expect(await (await unauthenticated('zh-CN')).json()).toEqual({ error: '未登录' });
  });

  it('插件的显示名经插件列表与服务列表交出，按读者语言', async () => {
    const { reader } = await setup();
    const english = reader({ lang: 'en' });
    const { plugins } = await json(english('/api/plugins'));
    expect(plugins.find((plugin: { instanceId: string }) => plugin.instanceId === OWNER).displayName).toBe('Jobs');
    const { services } = await json(english('/api/services'));
    expect(services.platform.providers.find((p: { contextId: string }) => p.contextId === OWNER).displayName).toBe(
      'Jobs',
    );
  });

  it('登录页：<html lang> 跟随读者，外链脚本要的文字在 texts 块里，语言切换列出可用语言，CSP 照旧', async () => {
    const { anonymous } = await setup();
    const english = await anonymous('en');
    const html = await english.text();
    expect(english.status).toBe(401);
    expect(english.headers.get('content-security-policy')).toBe(DOCUMENT_CSP);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<button type="submit" id="b">Sign in</button>');
    expect(textsOf(html)).toEqual({ tokenWrong: 'Incorrect token', networkError: 'Network error' });
    expect(switchOf(html)).toEqual([
      ['en', 'English', true],
      ['zh-CN', '中文（中国）', false],
    ]);
    const chinese = await (await anonymous('zh-CN')).text();
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(textsOf(chinese)).toEqual({ tokenWrong: 'token 不正确', networkError: '网络错误' });
  });

  it('pageLanguage 的译文不是合法的语言标签时，<html lang> 与选中项用读者语言链的第一项', async () => {
    const { anonymous } = await setup({ withHubs: true });
    const html = await (await anonymous('ja')).text();
    expect(html).toContain('<html lang="ja">');
    expect(switchOf(html)).toEqual([
      ['en', 'English', false],
      ['ja', '日本語', true],
      ['zh-CN', '中文（中国）', false],
    ]);
  });

  it('i18n 缺席：登录页是原文，没有语言切换', async () => {
    const { anonymous } = await setup({ withI18n: false });
    const html = await (await anonymous('en')).text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(textsOf(html)).toEqual({ tokenWrong: 'token 不正确', networkError: '网络错误' });
    expect(html).not.toContain('<select');
  });

  it('恢复页 /__clients 按读者语言输出，带参数的文字留着占位给脚本填', async () => {
    const { reader } = await setup();
    const response = await reader({ lang: 'en' })('/__clients');
    const html = await response.text();
    expect(response.headers.get('content-security-policy')).toBe(DOCUMENT_CSP);
    expect(html).toContain('<html lang="en">');
    expect(textsOf(html)).toMatchObject({ switching: 'Switching…', failed: 'Switch failed: {detail}{hint}' });
  });

  it('texts 块里的 < 写成 \\u003c，内容结束不了这个块', () => {
    const block = textsBlock({ x: '</script><img src=x>' });
    expect(block).not.toContain('</script><img');
    expect(JSON.parse(/>(.*)<\/script>$/s.exec(block)?.[1] ?? '')).toEqual({ x: '</script><img src=x>' });
  });

  it.each([
    ['en', '# Aalis WebUI access credentials (generated)', 'One-click sign-in: '],
    ['zh-CN', '# Aalis WebUI 访问凭据（自动生成）', '一键登录: '],
  ])('access.txt 的说明行按全局默认层的语言写（%s）', async (hostLanguage, title, login) => {
    const written = new Map<string, string>();
    const { port } = await setup({ hostLanguage, written });
    await vi.waitFor(() => expect(written.has('data:/webui/access.txt')).toBe(true));
    const lines = written.get('data:/webui/access.txt')?.split('\n') ?? [];
    expect(lines[0]).toBe(title);
    expect(lines).toContain(`${login}http://127.0.0.1:${port}/?token=${TOKEN}`);
  });
});

describe('可选项来源与 /api/i18n 的两条路由', () => {
  it('/api/models/i18n-languages 经贡献点 webui:options 给出可选项：值是语言标签，标签是自称', async () => {
    const { reader } = await setup({ withHubs: true });
    expect(await json(reader({ lang: 'en' })('/api/models/i18n-languages'))).toEqual({
      models: ['en', 'ja', 'zh-CN'],
      details: [
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'zh-CN', label: '中文（中国）' },
      ],
    });
  });

  it('GET /api/i18n/languages 给有文字可用的语言，i18n 缺席时为空', async () => {
    const present = await setup({ withHubs: true });
    expect(await json(present.reader({})('/api/i18n/languages'))).toEqual({
      languages: [
        { tag: 'en', name: 'English' },
        { tag: 'ja', name: '日本語' },
        { tag: 'zh-CN', name: '中文（中国）' },
      ],
    });
    const absent = await setup({ withI18n: false, withHubs: true });
    expect(await json(absent.reader({})('/api/i18n/languages'))).toEqual({ languages: [] });
  });

  it('GET /api/i18n/messages 给这些 ns 在语言链下语言包的补充：按 ns 与语言筛（en 总留着），i18n 缺席时为空', async () => {
    const { reader } = await setup({ withHubs: true });
    const request = reader({});
    const ns = encodeURIComponent(OWNER);
    const other = encodeURIComponent('@zz/other');
    const title = { language: 'ja', text: 'ジョブ', from: fingerprint('任务') };
    expect(await json(request(`/api/i18n/messages?ns=${ns}&lang=ja-JP`))).toEqual({
      entries: { [OWNER]: { title: [title] } },
    });
    expect(await json(request(`/api/i18n/messages?ns=${ns}&lang=${encodeURIComponent('fr|en')}`))).toEqual({
      entries: {},
    });
    // 没给 lang（含空的 lang=）时按这次请求的读者
    const hi = (language: string, text: string) => ({ language, text, from: fingerprint('你好') });
    expect(await json(reader({ lang: 'ja' })(`/api/i18n/messages?ns=${ns},${other}`))).toEqual({
      entries: { [OWNER]: { title: [title] }, '@zz/other': { hi: [hi('en', 'Hi'), hi('ja', 'やあ')] } },
    });
    expect(await json(reader({ lang: 'ja' })(`/api/i18n/messages?ns=${ns}&lang=`))).toEqual({
      entries: { [OWNER]: { title: [title] } },
    });
    const absent = await setup({ withI18n: false, withHubs: true });
    expect(await json(absent.reader({})(`/api/i18n/messages?ns=${other}&lang=en`))).toEqual({ entries: {} });
  });
});
