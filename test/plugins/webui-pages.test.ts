import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { storage } from '../../packages/api-storage/src/index.js';
import {
  type BoundWebui,
  type PageHandle,
  type PageView,
  type TableRow,
  type WebuiAdminEvent,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import { App, definePlugin, type Logger, optional, provide } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 声明式页面经真实 webui-server 与 HTTP：页面表、数据源与动作的服务端闸门、单元格里的媒体与文件、会话面板、
// invalidate 推到 /admin。存储是临时家目录上的 storage-local，会话管理是只答 getSession 的替身。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-webui-pages-token-placeholder-0';
const COOKIE = `aalis_webui_token=${TOKEN}`;
/** 带作用域的插件名：路径里的实例 id 要 encodeURIComponent，斜杠也在其中 */
const OWNER = '@zz/page-owner';

/** Node 自带的 WebSocket（undici）接受 headers，DOM 类型里没有这个重载 */
type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const apps: App[] = [];
const homes: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** 表格 rows 依次返回的几批行：形状不对的各一批 */
const rows: TableRow[][] = [];

/** 插件经门面登记的页面；received 记下处理函数与数据源收到的参数 */
function definePages(webui: BoundWebui, received: unknown[]) {
  const jobs = webui.definePage({
    key: 'jobs',
    title: '任务',
    icon: 'calendar-clock',
    order: 2,
    actions: {
      create: {
        label: '新建',
        effect: 'write',
        input: {
          name: { type: 'string', label: '名字', required: true },
          times: { type: 'number', label: '次数', default: 1 },
          mode: {
            type: 'select',
            label: '方式',
            default: 'once',
            options: [
              { label: '一次', value: 'once' },
              { label: '每天', value: 'daily' },
            ],
          },
        },
        handler: ({ input }) => {
          received.push(input);
          return `已新建 ${input.name}`;
        },
      },
      pause: {
        label: '暂停',
        effect: 'write',
        row: true,
        handler: args => void received.push(args.rowKey),
      },
      remove: {
        label: '删除',
        effect: 'destructive',
        confirm: '删除后不能恢复',
        row: true,
        handler: ({ rowKey }) => {
          throw new Error(`任务 ${rowKey} 正在运行，不能删除`);
        },
      },
      peek: { label: '查看', effect: 'read', handler: () => 42 as unknown as string },
    },
    content: [
      {
        type: 'table',
        id: 'list',
        rowKey: 'name',
        columns: [
          { key: 'name', label: '名字', primary: true },
          { key: 'thumb', label: '图', kind: 'image' },
          { key: 'report', label: '报告', kind: 'file' },
        ],
        rowActions: [{ action: 'pause', visibleWhen: 'running' }, { action: 'remove' }],
        data: () => [
          { name: 'a', running: true, thumb: 'workspace:/t/a.png', report: 'workspace:/reports/周报.txt' },
          { name: 'b', running: false, thumb: '', report: 'pluginData:/zz/secret.json' },
        ],
        detail: [
          { type: 'markdown', id: 'yaml', data: ({ rowKey }) => `# ${rowKey}` },
          { type: 'actions', actions: ['remove'] },
        ],
      },
      { type: 'actions', actions: ['create', 'peek'] },
      {
        type: 'info',
        id: 'broken',
        data: () => {
          throw new Error('账本读不出来');
        },
      },
      { type: 'markdown', id: 'wrong', data: () => 42 as unknown as string },
      {
        type: 'table',
        id: 'rows',
        rowKey: 'name',
        columns: [{ key: 'name', label: '名字' }],
        rowActions: [{ action: 'pause', visibleWhen: 'running' }],
        data: () => rows.shift() ?? [],
      },
      {
        type: 'graph',
        id: 'graph',
        data: () => ({ nodes: [{ id: 'a', label: '甲' }], edges: [{ source: 'a', target: 'ghost' }] }),
      },
    ],
  });
  const panel = webui.definePage({
    key: 'panel',
    title: '本群',
    placement: 'session',
    applies: session => session.kind === 'room',
    actions: { touch: { label: '碰一下', effect: 'read', handler: ({ ctx }) => ctx.sessionId } },
    content: [
      { type: 'markdown', id: 'who', data: ({ ctx }) => ctx.sessionId },
      { type: 'actions', actions: ['touch'] },
    ],
  });
  webui.definePage({
    key: 'everywhere',
    title: '到处',
    placement: 'session',
    content: [{ type: 'markdown', id: 'x', data: () => '' }],
  });
  webui.definePage({
    key: 'prefs',
    title: '偏好',
    placement: 'settings',
    order: 1,
    content: [{ type: 'markdown', id: 'x', data: () => '' }],
  });
  // 旧写法（JS 插件绕过类型时）：登记时被拒，记错误日志
  webui.definePage({
    key: 'old',
    title: '旧页面',
    refresh: 30,
    content: [{ type: 'stat', label: '数', source: 'count' }],
  } as never);
  return { jobs, panel };
}

async function setup({ withStorage = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aalis-webui-pages-'));
  homes.push(home);
  const port = await freePort();
  const logs: string[] = [];
  const logger: Logger = {
    debug() {},
    info: (...args: unknown[]) => void logs.push(`info ${args.map(String).join(' ')}`),
    warn: (...args: unknown[]) => void logs.push(`warn ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => void logs.push(`error ${args.map(String).join(' ')}`),
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'info', logger });
  apps.push(app);
  provideHostPaths(app, home);
  /** 会话管理的替身：alias 是别名，规范化成 webui:real */
  const sessions: Record<string, Pick<SessionInfo, 'id' | 'kind'>> = {
    'qq:group:1': { id: 'qq:group:1', kind: 'room' },
    'webui:real': { id: 'webui:real', kind: 'owner' },
    alias: { id: 'webui:real', kind: 'owner' },
  };
  app.bind({ provide }).provide.use(sessionManager, { getSession: (id: string) => sessions[id] } as never);
  const received: unknown[] = [];
  let handles: ReturnType<typeof definePages> | undefined;
  const owner = definePlugin({
    name: OWNER,
    uses: { webui: optional(webuiServer) },
    apply: ({ webui }) => {
      handles = definePages(webui.use, received);
    },
  });
  await app.pluginAll([
    ...(withStorage ? [{ definition: storageLocalPlugin, config: {} }] : []),
    {
      definition: webuiServerPlugin,
      config: { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
    },
    { definition: owner },
  ]);
  await app.plugins.idle();
  await app.start();
  await waitListening(port);

  const base = `http://127.0.0.1:${port}`;
  const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie: COOKIE } });
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const at = (pageKey: string, instance = OWNER) =>
    `/api/pages/${encodeURIComponent(instance)}/${encodeURIComponent(pageKey)}`;
  const data = async (pageKey: string, componentId: string, query: Record<string, string> = {}) => {
    const res = await get(`${at(pageKey)}/data/${encodeURIComponent(componentId)}?${new URLSearchParams(query)}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const act = async (pageKey: string, action: string, body: unknown = {}) => {
    const res = await post(`${at(pageKey)}/actions/${encodeURIComponent(action)}`, body);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** 按存储地址放一个文件 */
  const put = (uri: string, content: string) => app.bind({ storage }).storage.use.writeFile(uri, content);
  const admin = async () => {
    const ws = new (WebSocket as unknown as NodeWebSocketCtor)(`ws://127.0.0.1:${port}/admin`, {
      headers: { cookie: COOKIE },
    });
    sockets.push(ws);
    const events: WebuiAdminEvent[] = [];
    ws.onmessage = event => void events.push(JSON.parse(String(event.data)) as WebuiAdminEvent);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('连不上 /admin'));
    });
    return events;
  };
  return { app, logs, received, handles: handles!, get, post, data, act, put, admin };
}

describe('页面表', () => {
  it('列出登记着的页面：声明去掉函数、带上实例与位置，按 order 排；没过门槛的不登记，记一条错误日志', async () => {
    const { get, logs } = await setup();
    const { pages } = (await (await get('/api/pages')).json()) as { pages: PageView[] };
    expect(pages.map(p => [p.key, p.placement, p.instance])).toEqual([
      ['prefs', 'settings', OWNER],
      ['jobs', 'plugin', OWNER],
      ['everywhere', 'session', OWNER],
      ['panel', 'session', OWNER],
    ]);
    const jobs = pages.find(p => p.key === 'jobs');
    expect(jobs?.actions?.remove).toEqual({
      label: '删除',
      effect: 'destructive',
      confirm: '删除后不能恢复',
      row: true,
    });
    expect(jobs?.content).toEqual([
      expect.objectContaining({
        type: 'table',
        id: 'list',
        detail: [expect.objectContaining({ id: 'yaml' }), expect.anything()],
      }),
      { type: 'actions', actions: ['create', 'peek'] },
      { type: 'info', id: 'broken' },
      { type: 'markdown', id: 'wrong' },
      expect.objectContaining({ type: 'table', id: 'rows' }),
      { type: 'graph', id: 'graph' },
    ]);
    expect(JSON.stringify(pages), '函数不下发').not.toMatch(/handler|"data"|applies/);
    expect(logs.filter(l => l.startsWith('error'))).toEqual([
      `error 页面 old（${OWNER}）没过登记校验，未登记：refresh：不认识的字段；content[0].type：不认识的组件 stat（只有 table、graph、info、markdown、actions）`,
    ]);
  });

  it('插件停用时页面同一拍撤回，重新启用后回来；页面表的变化推 plugins.changed', async () => {
    const { app, get, admin } = await setup();
    const events = await admin();
    const keys = async () => ((await (await get('/api/pages')).json()) as { pages: PageView[] }).pages.map(p => p.key);
    await app.plugins.disable(OWNER);
    expect(await keys()).toEqual([]);
    await app.plugins.enable(OWNER);
    await app.plugins.idle();
    expect(await keys()).toEqual(['prefs', 'jobs', 'everywhere', 'panel']);
    expect(events.filter(e => e.type === 'plugins.changed').length).toBeGreaterThanOrEqual(8);
  });
});

describe('数据源的闸门', () => {
  it('只许调声明过的组件；参数只收 rowKey（详情里的组件）与 sessionId（会话面板），多的、缺的都拒', async () => {
    const { data } = await setup();
    expect(await data('jobs', 'nope')).toEqual({ status: 404, body: { error: '页面 jobs 没有组件 nope' } });
    expect((await data('missing', 'list')).status).toBe(404);
    expect(await data('jobs', 'list', { rowKey: 'a' })).toEqual({ status: 400, body: { error: '多余的参数：rowKey' } });
    expect(await data('jobs', 'yaml')).toEqual({ status: 400, body: { error: 'rowKey 要是非空字符串' } });
    expect(await data('jobs', 'yaml', { rowKey: 'a' })).toEqual({ status: 200, body: { data: '# a' } });
    expect(await data('jobs', 'yaml', { rowKey: 'a', sessionId: 'webui:real' })).toEqual({
      status: 400,
      body: { error: '多余的参数：sessionId' },
    });
  });

  it('会话面板：会话 id 要给、要存在，插件收到规范化后的 id', async () => {
    const { data } = await setup();
    expect(await data('panel', 'who')).toEqual({ status: 400, body: { error: 'sessionId 要是非空字符串' } });
    expect(await data('panel', 'who', { sessionId: 'webui:gone' })).toEqual({
      status: 404,
      body: { error: '会话 webui:gone 不存在' },
    });
    expect(await data('panel', 'who', { sessionId: 'alias' })).toEqual({ status: 200, body: { data: 'webui:real' } });
  });

  it('数据源抛错回 500 与原因；返回的形状不对回 500 并记告警', async () => {
    const { data, logs } = await setup();
    expect(await data('jobs', 'broken')).toEqual({ status: 500, body: { error: '账本读不出来' } });
    expect(await data('jobs', 'wrong')).toEqual({
      status: 500,
      body: { error: '数据源 wrong 返回的数据不对：要返回字符串' },
    });
    expect(logs).toContain(`warn 页面 jobs（${OWNER}）的数据源 wrong 返回的数据不对：要返回字符串`);
  });

  it('表格的行：rowKey 要是不重复的非空字符串，visibleWhen 指名的字段要是布尔值；关系图的边要连着节点', async () => {
    const { data } = await setup();
    rows.push(
      [{ name: 'a', running: true }, { running: false }],
      [
        { name: 'a', running: true },
        { name: 'a', running: false },
      ],
      [{ name: 'a', running: 'yes' }],
      [{ name: 'a', running: true }],
    );
    const error = async () => ((await data('jobs', 'rows')).body as { error?: string }).error;
    expect(await error()).toBe('数据源 rows 返回的数据不对：第 2 行的 name 要是不重复的非空字符串');
    expect(await error()).toBe('数据源 rows 返回的数据不对：第 2 行的 name 要是不重复的非空字符串');
    expect(await error()).toBe('数据源 rows 返回的数据不对：第 1 行的 running 要是布尔值');
    expect(await data('jobs', 'rows')).toEqual({ status: 200, body: { data: [{ name: 'a', running: true }] } });
    expect(await data('jobs', 'graph')).toEqual({
      status: 500,
      body: { error: '数据源 graph 返回的数据不对：边的两端要是节点 id' },
    });
  });
});

describe('单元格里的图片与文件', () => {
  it('图片换成 /api/media 地址；文件换成下载句柄，插件私有数据里的只给名字；按句柄当附件下载，伪造的回 403', async () => {
    const { data, get, put } = await setup();
    await put('workspace:/reports/周报.txt', 'zz-report');
    const { body } = await data('jobs', 'list');
    const [a, b] = body.data as Array<Record<string, unknown>>;
    expect(a.thumb).toBe(`/api/media?uri=${encodeURIComponent('workspace:/t/a.png')}`);
    expect(a.report).toEqual({ name: '周报.txt', handle: expect.any(String) });
    expect(b.thumb, '空的不换').toBe('');
    expect(b.report).toEqual({ name: 'secret.json' });
    expect(JSON.stringify(body), '下发的数据里没有存储地址').not.toContain('workspace:/reports');

    const handle = (a.report as { handle: string }).handle;
    const res = await get(`/api/page-file?handle=${encodeURIComponent(handle)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(await res.text()).toBe('zz-report');
    const forged = `${handle.split('.')[0]}.${'A'.repeat(43)}`;
    expect((await get(`/api/page-file?handle=${encodeURIComponent(forged)}`)).status).toBe(403);
  });

  it('存储不在：文件单元格只给名字，不签发句柄，数据照常下发', async () => {
    const { data } = await setup({ withStorage: false });
    const { status, body } = await data('jobs', 'list');
    expect(status).toBe(200);
    expect((body.data as Array<Record<string, unknown>>).map(row => row.report)).toEqual([
      { name: '周报.txt' },
      { name: 'secret.json' },
    ]);
  });
});

describe('动作的闸门', () => {
  it('只许调声明过的动作；请求体只收声明里用得上的键', async () => {
    const { act } = await setup();
    expect(await act('jobs', 'nope')).toEqual({ status: 404, body: { error: '页面 jobs 没有动作 nope' } });
    expect(await act('jobs', 'peek', { rowKey: 'a' })).toEqual({ status: 400, body: { error: '多余的参数：rowKey' } });
    expect(await act('jobs', 'pause', { rowKey: 'a', row: { name: 'a', running: true } })).toEqual({
      status: 400,
      body: { error: '多余的参数：row' },
    });
    expect(await act('jobs', 'pause', {})).toEqual({ status: 400, body: { error: 'rowKey 要是非空字符串' } });
    expect(await act('jobs', 'pause', [])).toEqual({ status: 400, body: { error: '请求体要是对象' } });
  });

  it('行动作只收这一行的 rowKey', async () => {
    const { act, received } = await setup();
    expect(await act('jobs', 'pause', { rowKey: 'a' })).toEqual({ status: 200, body: {} });
    expect(received).toEqual(['a']);
  });

  it('输入按声明的字段校验：类型不对、缺必填、不在可选项里、多余的键都拒；过了的按字段解析、补上默认值', async () => {
    const { act, received } = await setup();
    const wrongType = await act('jobs', 'create', { input: { name: 'x', times: 'many' } });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.issues).toEqual([{ path: 'times', message: expect.any(String), kind: 'invalid' }]);
    expect((await act('jobs', 'create', { input: { times: 2 } })).body.issues).toEqual([
      { path: 'name', message: '必填字段缺失', kind: 'missing' },
    ]);
    expect((await act('jobs', 'create', { input: { name: 'x', mode: 'weekly' } })).body.issues).toEqual([
      { path: 'mode', message: expect.any(String), kind: 'invalid' },
    ]);
    expect(await act('jobs', 'create', { input: { name: 'x', cron: '* * * * *' } })).toEqual({
      status: 400,
      body: { error: 'input 里多余的键：cron' },
    });
    expect(await act('jobs', 'create')).toMatchObject({ status: 400, body: { issues: [{ path: 'name' }] } });
    expect(received, '没过校验的不交给插件').toEqual([]);

    expect(await act('jobs', 'create', { input: { name: '早报', times: '3' } })).toEqual({
      status: 200,
      body: { message: '已新建 早报' },
    });
    expect(received).toEqual([{ name: '早报', times: 3, mode: 'once' }]);
  });

  it('处理函数抛错回 500 与原因；返回的不是一句话按失败处理并记告警', async () => {
    const { act, logs } = await setup();
    expect(await act('jobs', 'remove', { rowKey: 'a' })).toEqual({
      status: 500,
      body: { error: '任务 a 正在运行，不能删除' },
    });
    expect(await act('jobs', 'peek')).toEqual({ status: 500, body: { error: '动作 peek 返回的不是一句话' } });
    expect(logs).toContain(`warn 页面 jobs（${OWNER}）的动作 peek 返回的不是一句话，按失败处理`);
  });

  it('write 与 destructive 记一行 info 日志（动作、实例、来源地址），read 不记', async () => {
    const { act, logs } = await setup();
    await act('jobs', 'pause', { rowKey: 'a' });
    await act('jobs', 'remove', { rowKey: 'a' });
    await act('jobs', 'peek');
    expect(logs.filter(l => l.startsWith('info 页面动作'))).toEqual([
      `info 页面动作 pause（write）：${OWNER} 的页面 jobs，来自 127.0.0.1`,
      `info 页面动作 remove（destructive）：${OWNER} 的页面 jobs，来自 127.0.0.1`,
    ]);
  });

  it('会话面板的动作：会话 id 核过存在再传，插件收到规范化后的 id', async () => {
    const { act } = await setup();
    expect(await act('panel', 'touch')).toEqual({ status: 400, body: { error: 'sessionId 要是非空字符串' } });
    expect(await act('panel', 'touch', { sessionId: 'webui:gone' })).toEqual({
      status: 404,
      body: { error: '会话 webui:gone 不存在' },
    });
    expect(await act('panel', 'touch', { sessionId: 'alias' })).toEqual({
      status: 200,
      body: { message: 'webui:real' },
    });
  });
});

describe('会话面板与 invalidate', () => {
  it('按会话一次算完适用的会话面板页面：applies 收到会话种类', async () => {
    const { get } = await setup();
    const panels = async (sessionId: string) => {
      const res = await get(`/api/session-pages?${new URLSearchParams({ sessionId })}`);
      return { status: res.status, body: await res.json() };
    };
    expect(await panels('qq:group:1')).toEqual({
      status: 200,
      body: {
        pages: [
          { instance: OWNER, pageKey: 'everywhere' },
          { instance: OWNER, pageKey: 'panel' },
        ],
      },
    });
    expect(await panels('webui:real')).toEqual({
      status: 200,
      body: { pages: [{ instance: OWNER, pageKey: 'everywhere' }] },
    });
    expect((await panels('webui:gone')).status).toBe(404);
  });

  it('插件的 invalidate 推到 /admin：带上实例、页面、组件与会话', async () => {
    const { admin, handles } = await setup();
    const events = await admin();
    handles.jobs.invalidate('list');
    handles.jobs.invalidate('list');
    (handles.panel as PageHandle).invalidate('who', 'qq:group:1');
    await vi.waitFor(() => expect(events.filter(e => e.type === 'page.invalidate')).toHaveLength(2));
    expect(events.filter(e => e.type === 'page.invalidate')).toEqual([
      { type: 'page.invalidate', instance: OWNER, pageKey: 'jobs', componentId: 'list' },
      { type: 'page.invalidate', instance: OWNER, pageKey: 'panel', componentId: 'who', sessionId: 'qq:group:1' },
    ]);
  });
});
