import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type HostConfig, hostConfig } from '../../packages/api-host-config/src/index.js';
import { type I18nService, i18n } from '../../packages/api-i18n/src/index.js';
import { platform } from '../../packages/api-platform/src/index.js';
import { type StorageService, storage } from '../../packages/api-storage/src/index.js';
import { type BoundWebui, webuiServer } from '../../packages/api-webui/src/index.js';
import { App, definePlugin, defineService, type Logger, optional, provide } from '../../packages/core/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import { textsBlock } from '../../packages/plugin-webui-server/src/html.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { missingConfigError } from '../../packages/schema-config/src/index.js';
import { defineTexts, fingerprint, TextError } from '../../packages/schema-i18n/src/index.js';
import { provideHostLanguage } from '../fixtures/host-language.js';
import { HUB_PLUGINS } from '../fixtures/hubs.js';
import { expectProcessTimeZoneDistinct } from '../fixtures/process-time-zone.js';
import { withSystemLocale } from '../fixtures/system-locale.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// WebUI 的 REST 出口按全局默认层的语言渲染文字对象（读者是 owner 自己，不看浏览器的语言与时区）；i18n 是真的
// plugin-i18n，会话管理是只给全局默认层的替身，i18n 缺席时一律原文。夹具插件在页面声明、页面数据、动作结果与提示里交出文字对象，平台适配器抛出 TextError；
// 插件配置值、schema 与动作输入字段的默认值、插件前端的数据是原样数据，里面伪造的文字对象不被换掉。另有缺服务与缺配置的
// 两个夹具插件，核插件状态与回执里的
// 原因；宿主配置文档只在要用 /api/config 的用例里给。webui-server 自己的文字（接口报错、登录页与恢复页、access.txt）、
// 可选项来源与 /api/i18n 的两条路由另成一组：贡献点与语言包、存储的替身只在要用的用例里给。
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
    when: '{t, time, short}',
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
      when: '{t, time, short}',
    },
  },
});

/** 时间戳 0 按服务进程的时区写成的时刻 */
const processTime = (language: string) => new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(0);

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
            { type: 'markdown', id: 'when', data: () => t('when', { t: 0 }) },
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
  /** 全局默认层的语言，缺省 zh-CN，setLanguage 改它（会话管理是只给这一层的替身） */
  language?: string[];
  /** 给了就另给存储的替身，写下的文件记在这里 */
  written?: Map<string, string>;
}

async function setup({
  withI18n = true,
  i18nService,
  withDoc = false,
  withHubs = false,
  language = ['zh-CN'],
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
  const setLanguage = provideHostLanguage(app, language);
  if (written) app.bind({ provide }).provide.use(storage, memoryStorage(written));
  await app.pluginAll([
    ...(withHubs ? [...HUB_PLUGINS, packs].map(definition => ({ definition })) : []),
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

  /** 已登录的请求；browser 为真时另带浏览器自己的语言（BROWSER） */
  const client =
    (browser = false) =>
    (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: {
          ...(browser ? BROWSER : {}),
          cookie: [`aalis_webui_token=${TOKEN}`, ...(browser ? [BROWSER.cookie] : [])].join('; '),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
  /** 不带登录 cookie 的请求：登录页 */
  const anonymous = (browser = false) => fetch(`http://127.0.0.1:${port}/`, { headers: browser ? BROWSER : {} });
  return { request: client(), client, fault, port, anonymous, setLanguage };
}

/** 浏览器自己的语言与时区：语言 cookie、时区 cookie 与 Accept-Language 都是英语与东京，服务端不看它们 */
const BROWSER = { cookie: 'aalis-lang=en; aalis-tz=Asia%2FTokyo', 'accept-language': 'en' };

type Request = Awaited<ReturnType<typeof setup>>['request'];
const json = async (response: Promise<Response>) => (await response).json();
const at = (pageKey: string) => `/api/pages/${encodeURIComponent(OWNER)}/${pageKey}`;

/** 读者看到的：页面声明、各组件的数据、动作结果与提示 */
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
  };
}

describe('REST 回应按全局默认层的语言渲染', () => {
  it('不看浏览器的语言与时区：全局默认层是 zh-CN 时回应、登录页与语言包的补充按 zh-CN，时间按服务进程的时区；改成 en 之后按 en；回应不带 Vary', async () => {
    expectProcessTimeZoneDistinct();
    const { client, anonymous, setLanguage } = await setup({ withHubs: true });
    const browser = client(true);
    expect(await shown(browser)).toEqual(CHINESE);
    expect((await json(browser(`${at('jobs')}/data/when`))).data).toBe(processTime('zh-CN'));
    expect((await browser('/api/pages')).headers.get('vary')).toBeNull();
    expect(await (await anonymous(true)).text()).toContain('<html lang="zh-CN">');
    const ns = encodeURIComponent(OWNER);
    expect(await json(browser(`/api/i18n/messages?ns=${ns}&lang=ja`))).toEqual({ entries: {} });
    setLanguage(['en']);
    expect(await shown(browser)).toEqual(ENGLISH);
    expect(await (await anonymous(true)).text()).toContain('<html lang="en">');
  });

  it('i18n 缺席时一律原文', async () => {
    const { request } = await setup({ withI18n: false, language: ['en'] });
    expect(await shown(request)).toEqual(CHINESE);
  });

  it('i18n 渲染抛错：回应照常是 200，文字按原文', async () => {
    const fail = () => {
      throw new Error('<i18n 坏了>');
    };
    const { request } = await setup({
      i18nService: { render: fail, chainOf: fail, languages: () => [] },
      language: ['en'],
    });
    const response = await request('/api/pages');
    expect(response.status).toBe(200);
    const { pages } = await response.json();
    expect(pages.find((page: { key: string }) => page.key === 'jobs').title).toBe('任务');
    expect(await shown(request)).toEqual(CHINESE);
  });

  it('抛出的 TextError 按全局默认层的语言写进 error，状态码取它的 status，没有时 400', async () => {
    const { request, fault, setLanguage } = await setup({ language: ['en'] });
    fault.error = new TextError(t('down'), { status: 503 });
    const outage = await request('/api/platforms');
    expect([outage.status, await outage.json()]).toEqual([503, { error: 'Platform down' }]);
    fault.error = new TextError(t('down'));
    setLanguage(['zh-CN']);
    const refused = await request('/api/platforms');
    expect([refused.status, await refused.json()]).toEqual([400, { error: '平台掉线' }]);
  });

  it('插件的配置值、schema 与动作输入字段的默认值、插件前端的数据原样返回，里面伪造的文字对象不被换掉', async () => {
    const { request } = await setup({ language: ['en'] });
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

describe('配置表单、校验问题与插件状态的原因按全局默认层的语言', () => {
  it('核心配置表单经 /api/config 按全局默认层的语言给出；没过校验时的说明也是', async () => {
    const { request, setLanguage } = await setup({ withDoc: true, language: ['en'] });
    const labels = async () => {
      const { schema } = await json(request('/api/config'));
      return [schema.name.label, schema.logLevel.label, schema.slowThresholdMs.label];
    };
    expect(await labels()).toEqual(['App name', 'Log level', 'Slow operation threshold (ms)']);
    const refused = await request('/api/config', { method: 'PUT', body: JSON.stringify({ logLevel: 'loud' }) });
    expect([refused.status, await refused.json()]).toEqual([
      400,
      { error: 'logLevel: not one of the options ("debug", "info", "warn", and "error")' },
    ]);
    setLanguage(['zh-CN']);
    expect(await labels()).toEqual(['应用名称', '日志等级', '慢操作阈值（毫秒）']);
  });

  it('动作的输入字段与没过校验时的说明按全局默认层的语言', async () => {
    const { request } = await setup({ language: ['en'] });
    const { pages } = await json(request('/api/pages'));
    expect(pages.find((page: { key: string }) => page.key === 'jobs').actions.repeat.input.times.label).toBe('Times');
    const refused = await request(`${at('jobs')}/actions/repeat`, {
      method: 'POST',
      body: JSON.stringify({ input: { times: 'many' } }),
    });
    expect([refused.status, (await refused.json()).error]).toEqual([
      400,
      'Input failed validation: times: expected a finite number, got string',
    ]);
  });

  it('没过校验的逐项问题：message 按全局默认层的语言，线上不另带 text（动作的输入与插件配置）', async () => {
    const { request } = await setup({ withDoc: true, language: ['en'] });
    const input = await request(`${at('jobs')}/actions/repeat`, {
      method: 'POST',
      body: JSON.stringify({ input: { times: 'many' } }),
    });
    expect((await input.json()).issues).toEqual([
      { path: 'times', kind: 'invalid', code: 'type', message: 'expected a finite number, got string' },
    ]);
    const config = await request(`/api/plugins/${encodeURIComponent(OWNER)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config: { level: 0 } }),
    });
    expect([config.status, (await config.json()).issues]).toEqual([
      400,
      [{ path: 'level', kind: 'invalid', code: 'min', message: 'less than the minimum 1' }],
    ]);
  });

  it('插件失败的说明（插件列表与需要处理）与回执里缺服务的链按全局默认层的语言', async () => {
    const { request } = await setup({ language: ['en'] });
    const { plugins } = await json(request('/api/plugins'));
    const failed = 'Missing config item apiKey; set it in the WebUI or the config file to apply';
    expect(plugins.find((plugin: { instanceId: string }) => plugin.instanceId === FAILING).error).toBe(failed);
    const { items } = await json(request('/api/attention'));
    expect(items.find((item: { instance?: string }) => item.instance === FAILING).error).toBe(failed);
    const reloaded = await request(`/api/plugins/${encodeURIComponent(LACKING)}/reload`, {
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

describe('webui-server 自己的文字按全局默认层的语言', () => {
  it('接口报错：未知 API、插件不存在、页面动作抛出的 TextError（经 guarded 接住，带 400–599 的 status 时用它）', async () => {
    const { request } = await setup({ language: ['en'] });
    const unknown = await request('/api/zz-unknown');
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: 'Unknown API: GET /api/zz-unknown' }]);
    const missing = await request('/api/plugins/zz-none/reload', { method: 'POST', body: '{}' });
    expect([missing.status, await missing.json()]).toEqual([404, { error: 'Plugin zz-none does not exist' }]);
    const failed = await request(`${at('jobs')}/actions/fail`, { method: 'POST', body: '{}' });
    expect([failed.status, await failed.json()]).toEqual([500, { error: 'Platform down' }]);
    const gone = await request(`${at('jobs')}/actions/gone`, { method: 'POST', body: '{}' });
    expect([gone.status, await gone.json()]).toEqual([404, { error: 'Platform down' }]);
  });

  it('请求体解析不了时给字典里的整句，不透传库的原句', async () => {
    const { request, setLanguage } = await setup({ language: ['en'] });
    const put = (body: string, headers?: Record<string, string>) =>
      request('/api/config', { method: 'PUT', body, headers });
    const answer = async (response: Promise<Response>) => {
      const got = await response;
      return [got.status, await got.json()];
    };
    const notJson = { error: 'The request body must be a valid JSON object or array' };
    expect(await answer(put('{bad json'))).toEqual([400, notJson]);
    expect(await answer(put('null'))).toEqual([400, notJson]);
    expect(await answer(put('{}', { 'content-type': 'application/json; charset=klingon' }))).toEqual([
      415,
      { error: 'The charset or content encoding of the request body is not supported' },
    ]);
    setLanguage(['zh-CN']);
    expect(await answer(put('{bad json'))).toEqual([400, { error: '请求体要是合法的 JSON 对象或数组' }]);
  });

  it('未登录的 API 请求回 401，说明按全局默认层的语言', async () => {
    const { port, setLanguage } = await setup({ language: ['en'] });
    const unauthenticated = () => fetch(`http://127.0.0.1:${port}/api/plugins`);
    const english = await unauthenticated();
    expect([english.status, await english.json()]).toEqual([401, { error: 'Not signed in' }]);
    setLanguage(['zh-CN']);
    expect(await (await unauthenticated()).json()).toEqual({ error: '未登录' });
  });

  it('插件的显示名经插件列表与服务列表交出，按全局默认层的语言', async () => {
    const { request } = await setup({ language: ['en'] });
    const { plugins } = await json(request('/api/plugins'));
    expect(plugins.find((plugin: { instanceId: string }) => plugin.instanceId === OWNER).displayName).toBe('Jobs');
    const { services } = await json(request('/api/services'));
    expect(services.platform.providers.find((p: { contextId: string }) => p.contextId === OWNER).displayName).toBe(
      'Jobs',
    );
  });

  it('登录页：<html lang> 跟随全局默认层，外链脚本要的文字在 texts 块里，没有语言切换，CSP 照旧', async () => {
    const { anonymous, setLanguage } = await setup({ language: ['en'] });
    const english = await anonymous();
    const html = await english.text();
    expect(english.status).toBe(401);
    expect(english.headers.get('content-security-policy')).toBe(DOCUMENT_CSP);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<button type="submit" id="b">Sign in</button>');
    expect(textsOf(html)).toEqual({ tokenWrong: 'Incorrect token', networkError: 'Network error' });
    expect(html).not.toContain('<select');
    setLanguage(['zh-CN']);
    const chinese = await (await anonymous()).text();
    expect(chinese).toContain('<html lang="zh-CN">');
    expect(textsOf(chinese)).toEqual({ tokenWrong: 'token 不正确', networkError: '网络错误' });
  });

  it('pageLanguage 的译文不是合法的语言标签时，<html lang> 用全局默认层语言链的第一项', async () => {
    const { anonymous } = await setup({ withHubs: true, language: ['ja'] });
    expect(await (await anonymous()).text()).toContain('<html lang="ja">');
  });

  it('i18n 缺席：登录页是原文', async () => {
    const { anonymous } = await setup({ withI18n: false, language: ['en'] });
    const html = await (await anonymous()).text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(textsOf(html)).toEqual({ tokenWrong: 'token 不正确', networkError: '网络错误' });
  });

  it('恢复页 /__clients 按全局默认层的语言输出，带参数的文字留着占位给脚本填，没有语言切换', async () => {
    const { request } = await setup({ language: ['en'] });
    const response = await request('/__clients');
    const html = await response.text();
    expect(response.headers.get('content-security-policy')).toBe(DOCUMENT_CSP);
    expect(html).toContain('<html lang="en">');
    expect(textsOf(html)).toMatchObject({ switching: 'Switching…', failed: 'Switch failed: {detail}{hint}' });
    expect(html).not.toContain('id="lang"');
  });

  it('texts 块里的 < 写成 \\u003c，内容结束不了这个块', () => {
    const block = textsBlock({ x: '</script><img src=x>' });
    expect(block).not.toContain('</script><img');
    expect(JSON.parse(/>(.*)<\/script>$/s.exec(block)?.[1] ?? '')).toEqual({ x: '</script><img src=x>' });
  });

  it.each([
    ['en', '# Aalis WebUI access credentials (generated)', 'One-click sign-in: '],
    ['zh-CN', '# Aalis WebUI 访问凭据（自动生成）', '一键登录: '],
  ])('access.txt 的说明行按全局默认层的语言写（%s）', async (language, title, login) => {
    const written = new Map<string, string>();
    const { port } = await setup({ language: [language], written });
    await vi.waitFor(() => expect(written.has('data:/webui/access.txt')).toBe(true));
    const lines = written.get('data:/webui/access.txt')?.split('\n') ?? [];
    expect(lines[0]).toBe(title);
    expect(lines).toContain(`${login}http://127.0.0.1:${port}/?token=${TOKEN}`);
  });
});

describe('可选项来源与 /api/i18n 的两条路由', () => {
  it('/api/models/i18n-languages 经贡献点 webui:options 给出可选项：先是跟随系统，再是各语言（值是语言标签，标签是自称）', async () => {
    const { request } = await withSystemLocale('ja-JP', () => setup({ withHubs: true, language: ['en'] }));
    expect(await json(request('/api/models/i18n-languages'))).toEqual({
      models: ['auto', 'en', 'ja', 'zh-CN'],
      details: [
        { value: 'auto', label: 'Follow system (currently: 日本語 (日本))' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
        { value: 'zh-CN', label: '中文（中国）' },
      ],
    });
  });

  it('GET /api/i18n/languages 给有文字可用的语言，i18n 缺席时为空', async () => {
    const present = await setup({ withHubs: true });
    expect(await json(present.request('/api/i18n/languages'))).toEqual({
      languages: [
        { tag: 'en', name: 'English' },
        { tag: 'ja', name: '日本語' },
        { tag: 'zh-CN', name: '中文（中国）' },
      ],
    });
    const absent = await setup({ withI18n: false, withHubs: true });
    expect(await json(absent.request('/api/i18n/languages'))).toEqual({ languages: [] });
  });

  it('GET /api/i18n/messages 给这些 ns 在全局默认层语言链下语言包的补充：按 ns 与语言筛（en 总留着），i18n 缺席时为空', async () => {
    const { request, setLanguage } = await setup({ withHubs: true, language: ['ja-JP'] });
    const ns = encodeURIComponent(OWNER);
    const other = encodeURIComponent('@zz/other');
    const title = { language: 'ja', text: 'ジョブ', from: fingerprint('任务') };
    const hi = (language: string, text: string) => ({ language, text, from: fingerprint('你好') });
    expect(await json(request(`/api/i18n/messages?ns=${ns},${other}`))).toEqual({
      entries: { [OWNER]: { title: [title] }, '@zz/other': { hi: [hi('en', 'Hi'), hi('ja', 'やあ')] } },
    });
    setLanguage(['fr', 'en']);
    expect(await json(request(`/api/i18n/messages?ns=${ns}`))).toEqual({ entries: {} });
    const absent = await setup({ withI18n: false, withHubs: true });
    expect(await json(absent.request(`/api/i18n/messages?ns=${other}`))).toEqual({ entries: {} });
  });
});
