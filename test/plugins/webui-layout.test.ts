import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type LayoutRecords,
  MAX_LAYOUT_ENTRIES,
  type WebuiAdminEvent,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import { App, definePlugin, type Logger, optional } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { createLayoutStore } from '../../packages/plugin-webui-server/src/layout.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// owner 的布局记录：图标栏上固定的页面与会话面板的标签（宿主标签与插件标签同一张表，各带开关），存在 webui-server 的
// 插件数据里（state/plugins/webui-server），按操作写入。真 storage-local、真 webui-server、真 HTTP 与 /admin。
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-webui-layout-token-placeholder-';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const OWNER = 'layout-owner';

type NodeWebSocketCtor = new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const apps: App[] = [];
const homes: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const markdown = { type: 'markdown', id: 'm', data: () => '' } as const;

/** 登记 plugin 位置的页面 p0..p(n-1)、一个设置页与会话面板页 n0..n(m-1) */
const pageOwner = (pluginPages: number, panelPages: number) =>
  definePlugin({
    name: OWNER,
    uses: { webui: optional(webuiServer) },
    apply: ({ webui }) => {
      for (let i = 0; i < pluginPages; i++) webui.definePage({ key: `p${i}`, title: `页${i}`, content: [markdown] });
      webui.definePage({ key: 'prefs', title: '偏好', placement: 'settings', content: [markdown] });
      for (let i = 0; i < panelPages; i++) {
        webui.definePage({ key: `n${i}`, title: `面板${i}`, placement: 'session', content: [markdown] });
      }
    },
  });

async function setup(options: { home?: string; pluginPages?: number; panelPages?: number; storage?: boolean } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'aalis-webui-layout-'));
  if (!options.home) homes.push(home);
  const port = await freePort();
  const warns: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
    error() {},
    child: () => logger,
  };
  const app = new App({ name: 'T', logLevel: 'warn', logger });
  apps.push(app);
  const paths = provideHostPaths(app, home);
  await app.pluginAll([
    ...(options.storage === false ? [] : [{ definition: storageLocalPlugin, config: {} }]),
    {
      definition: webuiServerPlugin,
      config: { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
    },
    { definition: pageOwner(options.pluginPages ?? 3, options.panelPages ?? 3) },
  ]);
  await app.plugins.idle();
  await app.start();
  await waitListening(port);

  const base = `http://127.0.0.1:${port}`;
  const read = async () => {
    const res = await fetch(`${base}/api/layout`, { headers: { cookie: COOKIE } });
    return { status: res.status, body: (await res.json()) as LayoutRecords & { error?: string } };
  };
  const op = async (body: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/layout`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as LayoutRecords & { error?: string } };
  };
  const pin = (pageKey: string, verb = 'pin') => op({ op: verb, page: ref(pageKey) });
  /** 会话面板标签的操作：字符串是本插件的页面 key，对象是宿主标签 */
  const tab = (verb: string, target: string | { host: string }) =>
    op({ op: verb, tab: typeof target === 'string' ? ref(target) : target });
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
  const file = join(paths.state, 'plugins', 'webui-server', 'layout.json');
  return { app, home, file, warns, read, op, pin, tab, admin };
}

const ref = (pageKey: string) => ({ instance: OWNER, pageKey });
const host = (name: string, open = true) => ({ tab: { host: name }, open });
const page = (pageKey: string, open = true) => ({ tab: ref(pageKey), open });
/** 新记录的会话面板标签：宿主的三个，按计划、设置、用量，都开着 */
const HOSTS = [host('plan'), host('settings'), host('usage')];

/** 先写好布局文件，再起一个读它的 webui-server */
async function withFile(content: unknown) {
  const first = await setup();
  await first.app.stop();
  mkdirSync(dirname(first.file), { recursive: true });
  writeFileSync(first.file, typeof content === 'string' ? content : JSON.stringify(content));
  return setup({ home: first.home });
}

const changes = (events: WebuiAdminEvent[]) => events.filter(e => e.type === 'layout.changed').length;

describe('固定的页面', () => {
  it('从页面标题栏固定与取消；上移、下移按 owner 排的顺序；重复固定、挪到头的不变', async () => {
    const { read, pin } = await setup();
    expect((await read()).body).toEqual({ pinned: [], panelTabs: HOSTS });
    await pin('p0');
    await pin('p1');
    expect((await pin('p2')).body.pinned).toEqual([ref('p0'), ref('p1'), ref('p2')]);
    expect((await pin('p2', 'move-up')).body.pinned).toEqual([ref('p0'), ref('p2'), ref('p1')]);
    expect((await pin('p0', 'move-down')).body.pinned).toEqual([ref('p2'), ref('p0'), ref('p1')]);
    expect((await pin('p2', 'move-up')).body.pinned, '已在最前').toEqual([ref('p2'), ref('p0'), ref('p1')]);
    expect((await pin('p0')).body.pinned, '已固定的再固定不变').toHaveLength(3);
    expect((await pin('p0', 'unpin')).body.pinned).toEqual([ref('p2'), ref('p1')]);
    expect((await read()).body.pinned).toEqual([ref('p2'), ref('p1')]);
  });

  it('只有位置为插件详情、此刻登记着的页面能固定；操作的形状不对回 400', async () => {
    const { pin, op } = await setup();
    expect(await pin('prefs')).toEqual({ status: 400, body: { error: '只有位置为插件详情的页面能固定' } });
    expect(await pin('n0')).toEqual({ status: 400, body: { error: '只有位置为插件详情的页面能固定' } });
    expect(await pin('ghost')).toEqual({ status: 404, body: { error: `页面 ghost（${OWNER}）不存在` } });
    expect(await op({ op: 'pin' })).toEqual({
      status: 400,
      body: {
        error:
          '操作要是 { op, page } 或 { op, tab }：pin、unpin、move-up、move-down 带 page（{ instance, pageKey }），' +
          'open-tab、close-tab、tab-up、tab-down 带 tab（{ host } 或 { instance, pageKey }），' +
          'remove-tab 只带插件标签 tab（{ instance, pageKey }），宿主标签只能关闭、不能移出',
      },
    });
    for (const body of [
      { op: 'pin', instance: OWNER, pageKey: 'p0' },
      { op: 'replace', page: ref('p0') },
      { op: 'pin', page: ref('p0'), pinned: [] },
      { op: 'pin', page: { instance: '', pageKey: 'p0' } },
      { op: 'pin', page: { instance: OWNER, pageKey: 'x'.repeat(513) } },
      { op: 'pin', page: { ...ref('p0'), at: 1 } },
      { op: 'pin', page: { host: 'plan' } },
      { op: 'pin', tab: ref('p0') },
      { op: 'open-tab', page: ref('n0') },
      { op: 'open-tab', tab: { host: 'chat' } },
      { op: 'open-tab', tab: { host: 'plan', open: true } },
      { op: 'open-tab', tab: { ...ref('n0'), host: 'plan' } },
    ]) {
      expect((await op(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
  });

  it(`最多 ${MAX_LAYOUT_ENTRIES} 条，满了回 409，记录不变`, async () => {
    const { pin, read } = await setup({ pluginPages: MAX_LAYOUT_ENTRIES + 1 });
    for (let i = 0; i < MAX_LAYOUT_ENTRIES; i++) expect((await pin(`p${i}`)).status).toBe(200);
    expect(await pin(`p${MAX_LAYOUT_ENTRIES}`)).toEqual({
      status: 409,
      body: { error: `最多 ${MAX_LAYOUT_ENTRIES} 条，先取消一些` },
    });
    expect((await read()).body.pinned).toHaveLength(MAX_LAYOUT_ENTRIES);
  });

  it('两台设备同时固定不同页面、打开不同的面板标签，各项都在；落盘的文件与读到的一致', async () => {
    const { pin, tab, read, file } = await setup();
    await Promise.all([pin('p0'), pin('p1'), tab('open-tab', 'n0'), pin('p2'), tab('open-tab', 'n1')]);
    const records = (await read()).body;
    expect([...records.pinned].map(r => r.pageKey).sort()).toEqual(['p0', 'p1', 'p2']);
    expect(records.panelTabs.slice(0, 3)).toEqual(HOSTS);
    expect(records.panelTabs.slice(3)).toEqual(expect.arrayContaining([page('n0'), page('n1')]));
    expect(records.panelTabs).toHaveLength(5);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(records);
  });

  it('换一个浏览器、本插件重载之后仍在；所属插件停用时记录保留，仍能取消与挪动，重新启用后照旧', async () => {
    const { app, pin, read, home } = await setup();
    await pin('p0');
    await pin('p1');
    await app.plugins.disable(OWNER);
    expect((await read()).body.pinned).toEqual([ref('p0'), ref('p1')]);
    expect((await pin('p1', 'move-up')).body.pinned).toEqual([ref('p1'), ref('p0')]);
    expect(await pin('p2'), '停用时固定不了').toMatchObject({ status: 404 });
    await app.plugins.enable(OWNER);
    await app.plugins.idle();
    expect((await read()).body.pinned).toEqual([ref('p1'), ref('p0')]);
    await app.stop();

    const again = await setup({ home });
    expect((await again.read()).body).toEqual({ pinned: [ref('p1'), ref('p0')], panelTabs: HOSTS });
  });
});

describe('会话面板的标签', () => {
  it('宿主标签关了标为关、位置保留，再打开回到原位；关着的再关、开着的再开不变', async () => {
    const { tab, read } = await setup();
    const closed = [host('plan', false), host('settings'), host('usage')];
    expect((await tab('close-tab', { host: 'plan' })).body.panelTabs).toEqual(closed);
    expect((await tab('close-tab', { host: 'plan' })).body.panelTabs).toEqual(closed);
    expect((await tab('open-tab', { host: 'plan' })).body.panelTabs).toEqual(HOSTS);
    expect((await tab('open-tab', { host: 'settings' })).body.panelTabs).toEqual(HOSTS);
    expect((await read()).body.panelTabs).toEqual(HOSTS);
  });

  it('插件标签默认不在表里：第一次打开追加在末尾、开着；关了留在原位标为关，再打开回到原位；没打开过的关了也不进表', async () => {
    const { tab, read } = await setup();
    expect((await tab('open-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n0')]);
    expect((await tab('open-tab', 'n1')).body.panelTabs).toEqual([...HOSTS, page('n0'), page('n1')]);
    expect((await tab('close-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n0', false), page('n1')]);
    expect((await tab('open-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n0'), page('n1')]);
    expect((await tab('close-tab', 'n2')).body.panelTabs).toEqual([...HOSTS, page('n0'), page('n1')]);
    expect((await read()).body.panelTabs).toEqual([...HOSTS, page('n0'), page('n1')]);
  });

  it('打开插件标签只收此刻登记着、位置为会话面板的页面', async () => {
    const { tab } = await setup();
    const refusal = { status: 400, body: { error: '只有会话面板的页面能在面板里打开' } };
    expect(await tab('open-tab', 'p0')).toEqual(refusal);
    expect(await tab('open-tab', 'prefs')).toEqual(refusal);
    expect(await tab('open-tab', 'ghost')).toEqual({ status: 404, body: { error: `页面 ghost（${OWNER}）不存在` } });
  });

  it('tab-up、tab-down 与表里的邻居对调，宿主标签与插件标签同一套写法；挪到头的、不在表里的不变', async () => {
    const { tab } = await setup();
    await tab('open-tab', 'n0');
    expect((await tab('tab-up', 'n0')).body.panelTabs).toEqual([
      host('plan'),
      host('settings'),
      page('n0'),
      host('usage'),
    ]);
    expect((await tab('tab-up', { host: 'plan' })).body.panelTabs[0], '已在最前').toEqual(host('plan'));
    expect((await tab('tab-down', { host: 'plan' })).body.panelTabs).toEqual([
      host('settings'),
      host('plan'),
      page('n0'),
      host('usage'),
    ]);
    const last = [host('settings'), host('plan'), host('usage'), page('n0')];
    expect((await tab('tab-down', 'n0')).body.panelTabs).toEqual(last);
    expect((await tab('tab-down', 'n0')).body.panelTabs, '已在最后').toEqual(last);
    expect((await tab('tab-up', 'n1')).body.panelTabs, '不在表里').toEqual(last);
  });

  it('所属插件停用时，插件标签仍能关闭与挪动，打开不了；重新启用后照旧', async () => {
    const { app, tab, read } = await setup();
    await tab('open-tab', 'n0');
    await tab('open-tab', 'n1');
    await app.plugins.disable(OWNER);
    expect((await tab('tab-up', 'n1')).body.panelTabs).toEqual([...HOSTS, page('n1'), page('n0')]);
    expect((await tab('close-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n1'), page('n0', false)]);
    expect(await tab('open-tab', 'n0'), '停用时打开不了').toMatchObject({ status: 404 });
    await app.plugins.enable(OWNER);
    await app.plugins.idle();
    expect((await read()).body.panelTabs).toEqual([...HOSTS, page('n1'), page('n0', false)]);
    expect((await tab('open-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n1'), page('n0')]);
  });

  it(`连同宿主标签最多 ${MAX_LAYOUT_ENTRIES} 个：满了打开新的回 409、记录不变；表里关着的照样能打开`, async () => {
    const room = MAX_LAYOUT_ENTRIES - HOSTS.length;
    const { tab, read } = await setup({ panelPages: room + 1 });
    for (let i = 0; i < room; i++) expect((await tab('open-tab', `n${i}`)).status).toBe(200);
    expect(await tab('open-tab', `n${room}`)).toEqual({
      status: 409,
      body: { error: `会话面板最多记 ${MAX_LAYOUT_ENTRIES} 个标签` },
    });
    expect((await read()).body.panelTabs).toHaveLength(MAX_LAYOUT_ENTRIES);
    await tab('close-tab', 'n0');
    expect((await tab('open-tab', 'n0')).body.panelTabs[HOSTS.length]).toEqual(page('n0'));
  });
});

describe('移出插件标签', () => {
  it('移出把插件标签从表里删掉，再打开时追加在末尾；不在表里的移出不变', async () => {
    const { tab, read } = await setup();
    await tab('open-tab', 'n0');
    await tab('open-tab', 'n1');
    expect((await tab('remove-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n1')]);
    expect((await tab('remove-tab', 'n0')).body.panelTabs, '已不在表里').toEqual([...HOSTS, page('n1')]);
    expect((await tab('open-tab', 'n0')).body.panelTabs).toEqual([...HOSTS, page('n1'), page('n0')]);
    expect((await read()).body.panelTabs).toEqual([...HOSTS, page('n1'), page('n0')]);
  });

  it('宿主标签只能关、不能移出：服务端拒收，记录不变', async () => {
    const { tab, read } = await setup();
    const refused = await tab('remove-tab', { host: 'plan' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('宿主标签只能关闭、不能移出');
    expect((await read()).body.panelTabs).toEqual(HOSTS);
  });

  it('所属插件停用时也能移出', async () => {
    const { app, tab } = await setup();
    await tab('open-tab', 'n0');
    await app.plugins.disable(OWNER);
    expect((await tab('remove-tab', 'n0')).body.panelTabs).toEqual(HOSTS);
  });

  it(`记录满到 ${MAX_LAYOUT_ENTRIES} 个后移出一个插件标签，就能再打开新的`, async () => {
    const room = MAX_LAYOUT_ENTRIES - HOSTS.length;
    const { tab } = await setup({ panelPages: room + 1 });
    for (let i = 0; i < room; i++) expect((await tab('open-tab', `n${i}`)).status).toBe(200);
    expect((await tab('open-tab', `n${room}`)).status).toBe(409);
    await tab('remove-tab', 'n0');
    const reopened = await tab('open-tab', `n${room}`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.panelTabs.at(-1)).toEqual(page(`n${room}`));
    expect(reopened.body.panelTabs).toHaveLength(MAX_LAYOUT_ENTRIES);
  });
});

describe('读出记录', () => {
  it('补上缺的宿主标签（按宿主顺序、在末尾、开着），丢掉认不出的、形状不对的与重复的', async () => {
    const { read, pin, file } = await withFile({
      pinned: [ref('p1'), { instance: OWNER }, ref('p1')],
      panelTabs: [
        page('n1', false),
        host('usage', false),
        host('chat'),
        { tab: { host: 'plan' }, open: 'no' },
        { ...page('n0'), at: 1 },
        { tab: { host: 'settings', open: true }, open: true },
        { tab: { instance: OWNER }, open: true },
        host('usage'),
        'plan',
      ],
    });
    const panelTabs = [page('n1', false), host('usage', false), host('plan'), host('settings')];
    expect((await read()).body).toEqual({ pinned: [ref('p1')], panelTabs });
    await pin('p0');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pinned: [ref('p1'), ref('p0')], panelTabs });
  });

  it('只读 pinned 与 panelTabs，别的键不认', async () => {
    const { read, pin, file } = await withFile({ pinned: [ref('p0')], panels: [ref('n0')] });
    expect((await read()).body).toEqual({ pinned: [ref('p0')], panelTabs: HOSTS });
    await pin('p1');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pinned: [ref('p0'), ref('p1')], panelTabs: HOSTS });
  });

  it(`插件标签读出时最多留到连同宿主标签 ${MAX_LAYOUT_ENTRIES} 个，宿主标签总在`, async () => {
    const recorded = Array.from({ length: MAX_LAYOUT_ENTRIES + 5 }, (_, i) => page(`gone${i}`));
    const { read } = await withFile({ pinned: [], panelTabs: recorded });
    expect((await read()).body.panelTabs).toEqual([...recorded.slice(0, MAX_LAYOUT_ENTRIES - HOSTS.length), ...HOSTS]);
  });
});

describe('layout.changed', () => {
  it('记录变了推给每条 /admin 连接，没变的操作不推', async () => {
    const { pin, tab, admin } = await setup();
    const first = await admin();
    const second = await admin();
    await pin('p0');
    await vi.waitFor(() => expect(changes(second)).toBe(1));
    expect(changes(first)).toBe(1);
    await pin('p0');
    await pin('p0', 'move-up');
    await tab('open-tab', { host: 'plan' });
    await tab('close-tab', 'n0');
    await tab('tab-up', { host: 'plan' });
    await tab('open-tab', 'n0');
    await vi.waitFor(() => expect(changes(second)).toBe(2));
    await tab('close-tab', { host: 'usage' });
    await vi.waitFor(() => expect(changes(second)).toBe(3));
    expect(changes(first)).toBe(3);
  });
});

describe('存储', () => {
  it('文件内容坏了：告警后按没有记录起步，下次改动时覆盖', async () => {
    const { read, pin, warns, file } = await withFile('{不是 JSON');
    expect((await read()).body).toEqual({ pinned: [], panelTabs: HOSTS });
    expect(warns.some(w => w.startsWith('布局记录 pluginData:/webui-server/layout.json 读不懂'))).toBe(true);
    await pin('p0');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pinned: [ref('p0')], panelTabs: HOSTS });
  });

  it('落盘失败：这次操作报错，记录不变；之后的操作照常', async () => {
    const files = new Map<string, string>();
    let failNext = false;
    const store = createLayoutStore(
      {
        readFile: async (uri: string) => {
          const text = files.get(uri);
          if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          return text;
        },
        writeFile: async (uri: string, data: string) => {
          if (failNext) {
            failNext = false;
            throw new Error('磁盘满了');
          }
          files.set(uri, data);
        },
      } as never,
      { debug() {}, info() {}, warn() {}, error() {}, child: () => ({}) as never } as Logger,
    );
    await store.apply({ op: 'pin', page: ref('p0') });
    failNext = true;
    await expect(store.apply({ op: 'pin', page: ref('p1') })).rejects.toThrow('磁盘满了');
    failNext = true;
    await expect(store.apply({ op: 'close-tab', tab: { host: 'plan' } })).rejects.toThrow('磁盘满了');
    expect(await store.read()).toEqual({ pinned: [ref('p0')], panelTabs: HOSTS });
    expect((await store.apply({ op: 'pin', page: ref('p2') })).records.pinned).toEqual([ref('p0'), ref('p2')]);
  });

  it('存储服务不在时回 503', async () => {
    const { read, pin } = await setup({ storage: false });
    expect(await read()).toEqual({ status: 503, body: { error: '存储服务不在，布局记录读写不了' } });
    expect((await pin('p0')).status).toBe(503);
  });
});
