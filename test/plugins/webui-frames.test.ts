import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import {
  type BoundWebui,
  type FramePageView,
  type PageDefinition,
  type PageView,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import { App, definePlugin, type Logger, optional, provide } from '../../packages/core/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { createPageRegistry } from '../../packages/plugin-webui-server/src/pages.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';

// ════════════════════════════════════════════════════════════
// 插件前端的服务端：登记时从声明页面的模块找到插件包根、核 webui/ 与入口；/frames/:token/ 托管 webui/ 里的文件
// （不看 cookie，扩展名白名单与 realpath 两道，不合的一律 404、不发 3xx，响应头带框架 CSP）；数据源与动作走声明式
// 页面同一道闸门；GET /api/pages 里只有框架地址、申请的能力与 actions，没有本机路径。插件包是临时目录里搭的，不起浏览器。
// ════════════════════════════════════════════════════════════

const OWNER = '@zz/frame-owner';
const TOKEN = 'zz-webui-frames-token-placeholder-00';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const INDEX = '<!doctype html><title>看板</title><script type="module" src="app.js"></script>';

const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-webui-frames-')));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 搭一个带插件前端的插件包：双格式构建的 dist/esm/ 里有只写 type 的 package.json（要跳过），包根的 package.json 名为 name。
 * webui/ 外放一份不该被取到的文件，webui/ 里放各种越界与不在白名单里的东西。回声明页面的模块地址与包根
 */
function framePackage(base: string, name = OWNER) {
  const root = join(base, 'pkg');
  write(join(root, 'package.json'), JSON.stringify({ name, files: ['dist', 'webui'] }));
  write(join(root, 'dist', 'esm', 'package.json'), JSON.stringify({ type: 'module' }));
  write(join(root, 'secret.txt'), 'zz-outside-webui');
  write(join(base, 'outside.js'), 'zz-outside-package');
  const webui = join(root, 'webui');
  write(join(webui, 'index.html'), INDEX);
  write(join(webui, 'app.js'), 'export const app = 1;');
  write(join(webui, 'style.css'), 'body{margin:0}');
  write(join(webui, 'sub', 'page.html'), '<!doctype html><title>子页</title>');
  write(join(webui, 'sub', 'index.html'), '<!doctype html><title>子目录的索引</title>');
  write(join(webui, 'dir.html', 'index.html'), '<!doctype html><title>目录的索引</title>');
  write(join(webui, '.env'), 'ZZ_SECRET=1');
  write(join(webui, '.hidden.js'), 'export const hidden = 1;');
  write(join(webui, 'data.json'), '{"zz":1}');
  write(join(webui, 'app.js.map'), '{}');
  symlinkSync(join(base, 'outside.js'), join(webui, 'link-out.js'));
  symlinkSync(join(webui, 'app.js'), join(webui, 'link-in.js'));
  return { root, module: pathToFileURL(join(root, 'dist', 'esm', 'index.js')).href };
}

// ----- 登记 -----

function registry() {
  const logs: string[] = [];
  const quiet = () => {};
  const logger: Logger = {
    debug: quiet,
    info: quiet,
    warn: (...args: unknown[]) => void logs.push(`warn ${args.map(String).join(' ')}`),
    error: (...args: unknown[]) => void logs.push(`error ${args.map(String).join(' ')}`),
    child: () => logger,
  };
  const pages = createPageRegistry({ logger, send: quiet, sessions: () => undefined, signFile: () => undefined });
  /** 登记着的插件前端页面的框架地址里的 token */
  const tokenOf = (key: string) => {
    const page = pages.views().find(view => view.key === key);
    return page?.frame?.src.split('/')[2];
  };
  return { pages, logs, tokenOf };
}

const framePage = (module: string, frame: Record<string, unknown> = {}): PageDefinition =>
  ({ key: 'board', title: '看板', frame: { module, ...frame } }) as PageDefinition;

describe('插件前端的登记', () => {
  it('从模块往上找最近一个带 name 的 package.json 当包根（只写 type 的跳过），托管它的 webui/', () => {
    const base = tempDir();
    const { root, module } = framePackage(base);
    const { pages, logs, tokenOf } = registry();
    pages.addPage(framePage(module), OWNER);
    expect(logs).toEqual([]);
    const token = tokenOf('board');
    expect(token).toMatch(/^[\w-]{22}$/);
    expect(pages.frameDir(token as string)).toBe(join(root, 'webui'));
    pages.dispose();
  });

  it('插件名取实例 id 第一个「:」之前的部分', () => {
    const { module } = framePackage(tempDir());
    const { pages, logs, tokenOf } = registry();
    pages.addPage(framePage(module), `${OWNER}:second`);
    expect(logs).toEqual([]);
    expect(tokenOf('board')).toBeDefined();
    pages.dispose();
  });

  it('入口可以在 webui/ 的子目录里，框架地址按段编码', () => {
    const base = tempDir();
    const { root, module } = framePackage(base);
    write(join(root, 'webui', 'a b', '看板#1.html'), INDEX);
    const { pages, logs } = registry();
    pages.addPage(framePage(module, { entry: 'a b/看板#1.html' }), OWNER);
    expect(logs).toEqual([]);
    const src = pages.views()[0]?.frame?.src ?? '';
    expect(src).toMatch(/^\/frames\/[\w-]{22}\//);
    expect(src.slice(src.indexOf('/', 8) + 1)).toBe(`a%20b/${encodeURIComponent('看板#1.html')}`);
    pages.dispose();
  });

  it('不过就不登记，记一条错误日志写明原因', () => {
    const base = tempDir();
    const { root, module } = framePackage(base);
    const refused = (definition: PageDefinition, instance = OWNER) => {
      const { pages, logs } = registry();
      pages.addPage(definition, instance);
      expect(pages.views(), JSON.stringify(definition)).toEqual([]);
      pages.dispose();
      return logs;
    };
    const reason = (logs: string[]) => {
      expect(logs).toHaveLength(1);
      return logs[0].replace(/^error 页面 board（[^）]+）没过登记校验，未登记：/, '');
    };

    expect(reason(refused(framePage('https://example.com/zz/index.js')))).toBe(
      'frame.module：要是 file: 地址（写 import.meta.url）',
    );
    expect(reason(refused(framePage('./dist/index.js')))).toBe('frame.module：要是 file: 地址（写 import.meta.url）');

    expect(reason(refused(framePage(module), '@zz/other-plugin'))).toBe(
      `frame.module：包根 ${root} 的 package.json 名为 ${OWNER}，不是插件名 @zz/other-plugin`,
    );

    const orphan = tempDir();
    write(join(orphan, 'lib', 'package.json'), JSON.stringify({ type: 'module' }));
    expect(reason(refused(framePage(pathToFileURL(join(orphan, 'lib', 'index.js')).href)))).toBe(
      `frame.module：从 ${join(orphan, 'lib')} 往上找不到带 name 的 package.json`,
    );

    const bare = join(tempDir(), 'bare');
    write(join(bare, 'package.json'), JSON.stringify({ name: OWNER }));
    expect(reason(refused(framePage(pathToFileURL(join(bare, 'index.js')).href)))).toBe(
      `frame.module：包根 ${bare} 下没有 webui/ 目录`,
    );
    const flat = join(tempDir(), 'flat');
    write(join(flat, 'package.json'), JSON.stringify({ name: OWNER }));
    write(join(flat, 'webui'), 'not a directory');
    expect(reason(refused(framePage(pathToFileURL(join(flat, 'index.js')).href)))).toBe(
      `frame.module：包根 ${flat} 下没有 webui/ 目录`,
    );

    expect(reason(refused(framePage(module, { entry: 'missing.html' })))).toBe(
      'frame.entry：webui/missing.html 不是 webui/ 里的文件',
    );
    mkdirSync(join(root, 'webui', 'folder.html'));
    expect(reason(refused(framePage(module, { entry: 'folder.html' })))).toBe(
      'frame.entry：webui/folder.html 不是 webui/ 里的文件',
    );
    write(join(base, 'outside.html'), INDEX);
    symlinkSync(join(base, 'outside.html'), join(root, 'webui', 'escape.html'));
    expect(reason(refused(framePage(module, { entry: 'escape.html' })))).toBe(
      'frame.entry：webui/escape.html 不是 webui/ 里的文件',
    );
  });

  it('每次登记随机一个 token：撤回后、重新登记后旧的都找不到', () => {
    const { module } = framePackage(tempDir());
    const { pages, tokenOf } = registry();
    const withdraw = pages.addPage(framePage(module), OWNER);
    const first = tokenOf('board') as string;
    expect(pages.frameDir(first)).toBeDefined();
    pages.addPage(framePage(module), OWNER);
    const second = tokenOf('board') as string;
    expect(second).not.toBe(first);
    expect(pages.frameDir(first), '重新登记后旧的 token').toBeUndefined();
    expect(pages.frameDir(second)).toBeDefined();
    withdraw();
    expect(pages.frameDir(second), '撤回的是上一次登记，这一次的还在').toBeDefined();
    pages.addPage(framePage(module), OWNER)();
    expect(pages.views()).toEqual([]);
    expect(pages.frameDir(second), '页面撤回后').toBeUndefined();
    pages.dispose();
  });
});

// ----- 经真实 webui-server -----

/** 发一个原样的请求：路径不规范化，Host 可以自己写 */
function raw(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function definePages(webui: BoundWebui, module: string, received: unknown[]) {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  webui.definePage({
    key: 'board',
    title: '看板',
    icon: 'layout-grid',
    frame: { module, host: ['sessions:read'] },
    sources: {
      cards: { data: () => [{ id: 'a', title: '第一张' }] },
      card: {
        input: { id: { type: 'string', label: '卡片', required: true }, limit: { type: 'number', label: '上限' } },
        data: ({ input }) => {
          received.push(input);
          return { id: input.id };
        },
      },
      big: { data: () => 1n },
      cyclic: { data: () => cyclic },
      nothing: { data: () => undefined },
    },
    actions: {
      archive: {
        label: '归档',
        effect: 'destructive',
        confirm: '归档后不能恢复',
        input: { id: { type: 'string', label: '卡片', required: true } },
        handler: ({ input }) => `已归档 ${input.id}`,
      },
    },
  });
  webui.definePage({
    key: 'panel',
    title: '面板',
    placement: 'session',
    frame: { module, entry: 'sub/page.html' },
    sources: { who: { data: ({ ctx }) => ctx.sessionId } },
    actions: { touch: { label: '碰一下', effect: 'read', handler: ({ ctx }) => ctx.sessionId } },
  });
}

async function setup() {
  const { module } = framePackage(tempDir());
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
  provideHostPaths(app, tempDir());
  const sessions: Record<string, Pick<SessionInfo, 'id' | 'kind'>> = {
    'webui:real': { id: 'webui:real', kind: 'owner' },
    alias: { id: 'webui:real', kind: 'owner' },
  };
  app.bind({ provide }).provide(sessionManager, { getSession: (id: string) => sessions[id] } as never);
  const received: unknown[] = [];
  const owner = definePlugin({
    name: OWNER,
    uses: { webui: optional(webuiServer) },
    apply: ({ webui }) => definePages(webui, module, received),
  });
  await app.pluginAll([
    { definition: storageLocalPlugin, config: {} },
    {
      definition: webuiServerPlugin,
      config: { host: '127.0.0.1', port, autoOpen: false, tokenMode: 'fixed', fixedToken: TOKEN },
    },
    { definition: owner },
  ]);
  await app.plugins.idle();
  await app.start();
  await waitListening(port);

  const origin = `http://127.0.0.1:${port}`;
  const pageList = async () =>
    ((await (await fetch(`${origin}/api/pages`, { headers: { cookie: COOKIE } })).json()) as { pages: PageView[] })
      .pages;
  const frameOf = async (key: string) => {
    const page = (await pageList()).find(view => view.key === key) as FramePageView;
    return page.frame;
  };
  const at = (key: string) => `/api/pages/${encodeURIComponent(OWNER)}/${key}`;
  const data = async (key: string, source: string, query: Record<string, string> = {}) => {
    const res = await fetch(`${origin}${at(key)}/data/${source}?${new URLSearchParams(query)}`, {
      headers: { cookie: COOKIE },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const act = async (key: string, action: string, body: unknown = {}) => {
    const res = await fetch(`${origin}${at(key)}/actions/${action}`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { app, port, logs, received, pageList, frameOf, data, act };
}

/**
 * 框架 CSP 的全文：除脚本外不按来源限，只留两道——脚本只认这一页的目录与公用目录（来源按 Host 写成带路径、不带协议的
 * 来源），框架里不能再嵌别的网页；另有沙箱与只许宿主嵌它
 */
const frameCsp = (host: string, token: string) =>
  [
    'sandbox allow-scripts',
    `script-src ${host}/frames/${token}/ ${host}/frames/_base/`,
    "frame-src 'none'",
    "object-src 'none'",
    `frame-ancestors ${host}`,
  ].join('; ');

describe('GET /api/pages 里的插件前端页面', () => {
  it('只有框架地址、申请的能力与 actions：按字段组装，不带数据源、模块与入口字段，回包里没有 file:', async () => {
    const { pageList } = await setup();
    const pages = await pageList();
    const board = pages.find(page => page.key === 'board');
    expect(board).toEqual({
      instance: OWNER,
      key: 'board',
      title: '看板',
      icon: 'layout-grid',
      placement: 'plugin',
      frame: { src: expect.stringMatching(/^\/frames\/[\w-]{22}\/index\.html$/), host: ['sessions:read'] },
      actions: {
        archive: {
          label: '归档',
          effect: 'destructive',
          confirm: '归档后不能恢复',
          input: { id: { type: 'string', label: '卡片', required: true } },
        },
      },
    });
    expect(pages.find(page => page.key === 'panel')).toMatchObject({
      placement: 'session',
      frame: { src: expect.stringMatching(/^\/frames\/[\w-]{22}\/sub\/page\.html$/), host: [] },
    });
    const text = JSON.stringify(pages);
    expect(text).not.toContain('file:');
    expect(text).not.toMatch(/sources|module|entry|cards/);
  });
});

describe('/frames/:token/ 的托管', () => {
  it('对的 token 取得到入口，不要 cookie；响应头逐个对上，全局的文档级 CSP 没有混进来', async () => {
    const { port, frameOf } = await setup();
    const { src } = await frameOf('board');
    const token = src.split('/')[2];
    const res = await raw(port, src);
    expect(res.status).toBe(200);
    expect(res.body).toBe(INDEX);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['content-security-policy']).toBe(frameCsp(`127.0.0.1:${port}`, token));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers.etag).toBeDefined();
    const again = await raw(port, src, { headers: { 'if-none-match': res.headers.etag as string } });
    expect(again.status, '按 ETag 再验证').toBe(304);
    const head = await raw(port, src, { method: 'HEAD' });
    expect([head.status, head.body]).toEqual([200, '']);
  });

  it('webui/ 里的脚本、样式、子目录的页面与指向 webui/ 之内的符号链接照常取', async () => {
    const { port, frameOf } = await setup();
    const dir = (await frameOf('board')).src.replace(/index\.html$/, '');
    for (const [path, type] of [
      ['app.js', /javascript/],
      ['style.css', /^text\/css/],
      ['sub/page.html', /^text\/html/],
      ['link-in.js', /javascript/],
    ] as const) {
      const res = await raw(port, `${dir}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type'], path).toMatch(type);
      expect(res.headers['content-security-policy'], path).toMatch(/^sandbox allow-scripts; /);
    }
  });

  it('越界、点开头的段、白名单外的扩展名、目录与缺失的文件一律 404，没有 3xx', async () => {
    const { port, frameOf } = await setup();
    const dir = (await frameOf('board')).src.replace(/index\.html$/, '');
    for (const path of [
      '../secret.txt',
      '../../outside.js',
      '%2e%2e/%2e%2e/outside.js',
      '%2E%2E%2F%2E%2E%2Foutside.js',
      'sub/../../../outside.js',
      'link-out.js',
      '.env',
      '.hidden.js',
      'data.json',
      'app.js.map',
      'sub',
      'sub/',
      'dir.html',
      'dir.html/',
      'missing.js',
      '',
      '%E0%A4%A',
      'app.js%00.html',
    ]) {
      const res = await raw(port, `${dir}${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.location, path).toBeUndefined();
      expect(res.body, path).not.toMatch(/zz-outside|ZZ_SECRET|hidden|"zz"|索引/);
    }
  });

  it('错的 token 与解不开的 token 段回 404、不带正文；只收 GET 与 HEAD，别的方法回 405', async () => {
    const { port, frameOf } = await setup();
    const { src } = await frameOf('board');
    expect((await raw(port, '/frames/AAAAAAAAAAAAAAAAAAAAAA/index.html')).status).toBe(404);
    expect((await raw(port, `${src.slice(0, -'index.html'.length - 2)}/index.html`)).status).toBe(404);
    expect(await raw(port, '/frames/%E0%A4%A/index.html')).toMatchObject({ status: 404, body: '' });
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await raw(port, src, { method, headers: { cookie: COOKIE } });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow, method).toBe('GET, HEAD');
    }
  });

  it('Host 带 :80、:443 时 CSP 里去掉；IPv6 字面地址与带非法字符的 Host 回 400', async () => {
    const { port, frameOf } = await setup();
    const { src } = await frameOf('board');
    const token = src.split('/')[2];
    const csp = async (host: string) => {
      const res = await raw(port, src, { headers: { host } });
      return { status: res.status, csp: res.headers['content-security-policy'] };
    };
    expect(await csp('aalis.example:443')).toEqual({ status: 200, csp: frameCsp('aalis.example', token) });
    expect(await csp('192.168.1.5:80')).toEqual({ status: 200, csp: frameCsp('192.168.1.5', token) });
    expect(await csp('aalis.example:8443')).toEqual({ status: 200, csp: frameCsp('aalis.example:8443', token) });
    for (const host of [
      '[::1]:3000',
      '[::1]',
      'a.example;script-src *',
      'a.example/frames',
      "a.example 'unsafe-eval'",
    ]) {
      expect((await csp(host)).status, host).toBe(400);
    }
  });

  it('/frames/_base/ 给出 api-webui 随包带的助手与样式基线：不要 cookie，响应头同一套；别的文件与越界一律 404', async () => {
    const { port } = await setup();
    for (const [path, type] of [
      ['frame.js', /javascript/],
      ['frame.css', /^text\/css/],
    ] as const) {
      const res = await raw(port, `/frames/_base/${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers['content-type'], path).toMatch(type);
      expect(res.headers['content-security-policy'], path).toBe(frameCsp(`127.0.0.1:${port}`, '_base'));
      expect(res.headers['access-control-allow-origin'], path).toBe('*');
      expect(res.headers['x-content-type-options'], path).toBe('nosniff');
      expect(res.headers['cache-control'], path).toBe('no-cache');
    }
    expect((await raw(port, '/frames/_base/frame.js')).body).toContain('export function connect');
    for (const path of ['index.js', '../index.js', '../package.json', '%2e%2e/index.js', 'missing.js', '']) {
      const res = await raw(port, `/frames/_base/${path}`);
      expect(res.status, path).toBe(404);
      expect(res.headers.location, path).toBeUndefined();
    }
  });

  it('插件停用后旧地址回 404；重新启用换了新 token，新的取得到、旧的仍是 404', async () => {
    const { app, port, frameOf, pageList } = await setup();
    const before = (await frameOf('board')).src;
    await app.plugins.disable(OWNER);
    expect(await pageList()).toEqual([]);
    expect((await raw(port, before)).status).toBe(404);
    await app.plugins.enable(OWNER);
    await app.plugins.idle();
    const after = (await frameOf('board')).src;
    expect(after).not.toBe(before);
    expect((await raw(port, after)).status).toBe(200);
    expect((await raw(port, before)).status).toBe(404);
  });
});

describe('插件前端的数据源与动作走同一道闸门', () => {
  it('没声明的数据源回 404；查询参数只收会话面板的 sessionId 与声明了输入的数据源的 input', async () => {
    const { data } = await setup();
    expect(await data('board', 'nope')).toEqual({ status: 404, body: { error: '页面 board 没有数据源 nope' } });
    expect(await data('board', 'cards')).toEqual({ status: 200, body: { data: [{ id: 'a', title: '第一张' }] } });
    expect(await data('board', 'cards', { input: '{}' })).toEqual({
      status: 400,
      body: { error: '多余的参数：input' },
    });
    expect(await data('board', 'card', { input: '{"id":"a"}', rowKey: 'a' })).toEqual({
      status: 400,
      body: { error: '多余的参数：rowKey' },
    });
    expect(await data('board', 'card', { input: '{"id":"a"}', sessionId: 'webui:real' })).toEqual({
      status: 400,
      body: { error: '多余的参数：sessionId' },
    });
  });

  it('input 的 JSON 坏了、不是对象、类型不对、缺必填、带多余的键都回 400；过了的按字段解析', async () => {
    const { data, received } = await setup();
    expect(await data('board', 'card', { input: '{id:' })).toEqual({
      status: 400,
      body: { error: 'input 不是合法的 JSON' },
    });
    expect(await data('board', 'card', { input: '["a"]' })).toEqual({ status: 400, body: { error: 'input 要是对象' } });
    const wrongType = await data('board', 'card', { input: '{"id":"a","limit":"many"}' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.issues).toEqual([{ path: 'limit', message: expect.any(String), kind: 'invalid' }]);
    expect((await data('board', 'card', { input: '{}' })).body.issues).toEqual([
      { path: 'id', message: '必填字段缺失', kind: 'missing' },
    ]);
    expect((await data('board', 'card')).body.issues, '没给 input 按空对象核').toEqual([
      { path: 'id', message: '必填字段缺失', kind: 'missing' },
    ]);
    expect(await data('board', 'card', { input: '{"id":"a","instance":"@zz/other"}' })).toEqual({
      status: 400,
      body: { error: 'input 里多余的键：instance' },
    });
    expect(received, '没过校验的不交给插件').toEqual([]);
    expect(await data('board', 'card', { input: '{"id":"a","limit":"3"}' })).toEqual({
      status: 200,
      body: { data: { id: 'a' } },
    });
    expect(received).toEqual([{ id: 'a', limit: 3 }]);
  });

  it('同一个参数给了两次回 400', async () => {
    const { port } = await setup();
    const res = await fetch(
      `http://127.0.0.1:${port}/api/pages/${encodeURIComponent(OWNER)}/board/data/card?input=%7B%7D&input=%7B%7D`,
      { headers: { cookie: COOKIE } },
    );
    expect([res.status, await res.json()]).toEqual([400, { error: 'input 要是一个 JSON 字符串' }]);
  });

  it('数据源返回不能 JSON 化的值时回 500 并记告警', async () => {
    const { data, logs } = await setup();
    for (const source of ['big', 'cyclic', 'nothing']) {
      const reply = await data('board', source);
      expect(reply.status, source).toBe(500);
      expect(reply.body.error, source).toMatch(new RegExp(`^数据源 ${source} 返回的数据不对：不能转成 JSON`));
      expect(
        logs.some(line =>
          line.startsWith(`warn 页面 board（${OWNER}）的数据源 ${source} 返回的数据不对：不能转成 JSON`),
        ),
      ).toBe(true);
    }
  });

  it('会话面板：缺 sessionId 回 400，会话不存在回 404，插件收到规范化后的 id', async () => {
    const { data, act } = await setup();
    expect(await data('panel', 'who')).toEqual({ status: 400, body: { error: 'sessionId 要是非空字符串' } });
    expect(await data('panel', 'who', { sessionId: 'webui:gone' })).toEqual({
      status: 404,
      body: { error: '会话 webui:gone 不存在' },
    });
    expect(await data('panel', 'who', { sessionId: 'alias' })).toEqual({ status: 200, body: { data: 'webui:real' } });
    expect(await act('panel', 'touch', { sessionId: 'alias' })).toEqual({
      status: 200,
      body: { message: 'webui:real' },
    });
  });

  it('动作带 rowKey 回 400；输入照声明核；destructive 记一行 info 日志', async () => {
    const { act, logs } = await setup();
    expect(await act('board', 'archive', { rowKey: 'a', input: { id: 'a' } })).toEqual({
      status: 400,
      body: { error: '多余的参数：rowKey' },
    });
    expect(await act('board', 'archive', { input: { id: 'a', extra: 1 } })).toEqual({
      status: 400,
      body: { error: 'input 里多余的键：extra' },
    });
    expect(await act('board', 'nope')).toEqual({ status: 404, body: { error: '页面 board 没有动作 nope' } });
    expect(await act('board', 'archive', { input: { id: 'a' } })).toEqual({
      status: 200,
      body: { message: '已归档 a' },
    });
    expect(logs).toContain(`info 页面动作 archive（destructive）：${OWNER} 的页面 board，来自 127.0.0.1`);
  });
});
