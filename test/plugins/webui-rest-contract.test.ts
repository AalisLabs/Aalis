import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { METHODS } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Approval, type ApprovalService, approvals } from '../../packages/api-approval/src/index.js';
import { commands } from '../../packages/api-commands/src/index.js';
import { contributions } from '../../packages/api-contributions/src/index.js';
import { type LLMModel, llm } from '../../packages/api-llm/src/index.js';
import { packageManager } from '../../packages/api-package-manager/src/index.js';
import { type PlatformAdapter, platform } from '../../packages/api-platform/src/index.js';
import { pluginSource } from '../../packages/api-plugin-source/src/index.js';
import { type SessionInfo, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { sessionProtocol } from '../../packages/api-session-protocol/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import {
  type PageListResponse,
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  webuiClient,
  webuiServer,
} from '../../packages/api-webui/src/index.js';
import {
  type App,
  config,
  definePlugin,
  defineService,
  type Logger,
  lifecycle,
  provide,
} from '../../packages/core/src/index.js';
import contributionsPlugin from '../../packages/plugin-contributions/src/index.js';
import storageLocalPlugin from '../../packages/plugin-storage-local/src/index.js';
import webuiServerPlugin from '../../packages/plugin-webui-server/src/index.js';
import { formatLogLine } from '../../packages/schema-log/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { provideHostPaths } from '../fixtures/host-paths.js';
import { freePort, waitListening } from '../helpers/net.js';
import { runTscProbe } from '../helpers/tsc-probe.js';
import { contractRoutes } from '../helpers/webui-contract.js';

// ════════════════════════════════════════════════════════════
// 管理面 REST 的回应与契约对得上：起真的 webui-server，契约路由表里的每条路由都走一遍成功的路径，记下实际回来的 JSON
// （回文件的记下响应头），连同几种失败的回应（含请求体不是 JSON、路径参数解不开、处理函数抛错），一次交给 tsc 按
// api-webui 的 rest.ts 检查：多出的字段、缺的字段、类型不对都报。启动时在 express 上记下实际登记的路由，与契约的路由表
// 逐条对上。各服务是契约层面的替身；市场的检索源与安装源、图片代理的上游在 fetch 上截下，不发真实请求
// ════════════════════════════════════════════════════════════

const TOKEN = 'zz-rest-contract-token-placeholder-0';
const COOKIE = `aalis_webui_token=${TOKEN}`;
const PROBE = 'zz-rest-probe';
const SEARCH = 'https://search.example.invalid';
const INSTALL = 'https://install.example.invalid';
/** 图片代理的上游：公网 IP 字面量过得了地址校验，请求在 fetch 上截下 */
const IMAGE = 'https://1.1.1.1/zz.png';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
/** 只留 warn：取下拉可选值时失败的提供者要点名 */
const warns: string[] = [];
const logger: Logger = {
  debug() {},
  info() {},
  warn: (...args: unknown[]) => void warns.push(args.map(String).join(' ')),
  error() {},
  child: () => logger,
};

/** 不比的响应头：传输层的与 express 自带的 */
const TRANSPORT_HEADERS = new Set([
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'etag',
  'last-modified',
  'accept-ranges',
  'x-powered-by',
  'vary',
]);

const APPROVAL: Approval = {
  id: 'zz-approval',
  sessionId: 's-1',
  origin: { kind: 'owner', platform: 'webui', userId: 'console' },
  target: 'tool',
  tool: 'exec',
  facts: { command: 'ls', params: {} },
  options: ['approve', 'deny'],
  contentHash: 'hash-zz',
  state: 'pending',
};

/** 契约的各服务：审批、会话、会话协议、平台、模型、工具、指令、插件来源与包管理，另有带 listModels 的服务 */
const names = defineService<{ listModels(): Promise<string[]> }>('zz-names');
/** 胜出的提供者没有 listModels、排在后面的有，最后一个取不到 */
const mixed = defineService<{ listModels?(): Promise<string[]> }>('zz-mixed');
/** 置上时平台适配器取连接抛错：处理函数抛错的样本 */
let connectionsThrow = false;
const doubles = definePlugin({
  name: 'zz-rest-doubles',
  uses: { provide },
  apply({ provide }) {
    const service: ApprovalService = {
      request: () => Promise.reject(new Error('替身不发起审批')),
      list: () => [APPROVAL],
      attachSurface: () => ({
        attend: () => ({
          presence() {},
          respond: () => ({ ok: false, refusal: 'unavailable', message: '替身不应答' }),
          leave() {},
        }),
        detach() {},
      }),
    };
    provide(approvals, service);
    provide(sessionManager, {
      getSession: (id: string) => ({ id, name: id, title: '整理周报', kind: 'owner' }) as unknown as SessionInfo,
    } as never);
    provide(sessionProtocol, {
      connect: () => ({ receive: async () => {}, close() {} }),
      resolveFile: () => ({ uri: 'tmp:/zz.txt', name: 'zz.txt' }),
    });
    const adapter: PlatformAdapter = {
      adapterName: 'ZZ',
      platform: 'zz',
      sessionTypes: ['group'],
      getConnections: () => {
        if (connectionsThrow) throw new Error('/zz/secret/path 读不出');
        return [{ id: 'zz-1', platform: 'zz', status: 'online', selfId: '10000' }];
      },
      sendMessage: async () => {},
    } as unknown as PlatformAdapter;
    provide(platform, adapter);
    provide(tools, {
      getAll: () => [{ name: 'zz_probe', pluginName: PROBE, groups: ['zz-group'] }],
      getGroups: () => [
        { name: 'zz-group', label: '探针', description: '探针工具\n给模型看的说明', pluginName: PROBE },
      ],
    } as never);
    provide(commands, { getAll: () => [{ name: 'zz', pluginName: PROBE }] } as never);
    provide(pluginSource, { rescan: async () => [] });
    provide(packageManager, {
      install: async () => ({ ok: true, message: '已安装 zz-plugin-remote', plugin: PROBE }),
      uninstall: async () => ({ ok: false, message: '它提供的服务还有人在用' }),
      update: async () => ({ ok: false, message: '没过预检', conflicts: ['zz 要 core >=9'] }),
      registry: async () => INSTALL,
      serviceDependents: () => [PROBE],
    });
    provide(names, { listModels: async () => ['zz-name'] });
    provide(mixed, {}, { entryId: 'zz-mixed/first' });
    provide(mixed, { listModels: async () => ['zz-late'] }, { entryId: 'zz-mixed/second' });
    provide(
      mixed,
      {
        listModels: async () => {
          throw new Error('人设目录读不出');
        },
      },
      { entryId: 'zz-mixed/broken' },
    );
  },
});

/** 模型：能调思考、能刷新 */
const model = definePlugin({
  name: 'zz-rest-llm',
  uses: { provide, lifecycle },
  apply({ provide, lifecycle }) {
    const refresh = async () => ({ added: ['zz-new'], removed: [], total: 2 });
    const handle = {
      id: 'zz-model',
      providerId: lifecycle.id,
      contextLength: 8192,
      capabilities: ['chat'],
      thinking: {
        levels: [
          { id: 'off', label: '关' },
          { id: 'high', label: '高' },
        ],
        default: 'high',
      },
      chat: async () => ({ content: '' }),
      refresh,
    } as unknown as LLMModel;
    provide(llm, handle, { entryId: `${lifecycle.id}/zz-model` });
  },
});

/** 起不来的插件：「需要处理」里有插件故障 */
const failing = definePlugin({
  name: 'zz-rest-failing',
  apply() {
    throw new Error('缺少服务地址');
  },
});

/** 带页面、提示与主题的插件，可以多实例 */
function probe(home: string) {
  return definePlugin({
    name: PROBE,
    reusable: true,
    configSchema: { level: { type: 'number', label: '级别', default: 0 } },
    uses: { webui: webuiServer, contributions, config },
    apply({ webui, contributions }) {
      webui.definePage({
        key: 'board',
        title: '看板',
        actions: { touch: { label: '标记', effect: 'write', handler: () => '已标记' } },
        content: [
          {
            type: 'table',
            id: 'rows',
            rowKey: 'name',
            columns: [
              { key: 'name', label: '名字', primary: true },
              { key: 'file', label: '文件', kind: 'file' },
            ],
            data: () => [{ name: 'a', file: 'tmp:/zz.txt' }],
          },
          { type: 'actions', actions: ['touch'] },
        ],
      });
      webui.definePage({
        key: 'side',
        title: '侧栏',
        placement: 'session',
        content: [{ type: 'info', id: 'facts', data: () => [{ label: '条数', value: 1 }] }],
      });
      webui.definePage({
        key: 'canvas',
        title: '画布',
        frame: { module: pathToFileURL(join(home, 'probe', 'dist', 'index.js')).href },
      });
      webui.notify({ id: 'review', level: 'action', title: '1 件待裁决', open: { page: 'board' } });
      contributions.contribute('webui:theme', {
        id: 'dusk',
        theme: {
          format: THEME_FILE_FORMAT,
          version: THEME_FILE_VERSION,
          name: '黄昏',
          kind: 'dark',
          colors: { '--color-bg': '#201a18' },
        },
      });
    },
  });
}

interface Sample {
  key: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const write = (path: string, content: string | Buffer) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

/** 带路径的登记：方法与路径写成契约的键，挂载（use 带路径）按「GET 挂载点/{*path}」，route() 链式登记写 ROUTE */
function keyOf(name: string, args: unknown[]): string | undefined {
  const [path] = args;
  if (typeof path !== 'string') return undefined;
  if (name === 'use') return `GET ${path}/{*path}`;
  if (name === 'route') return `ROUTE ${path}`;
  // app.get 只带一个参数是读设置
  if (name === 'get' && args.length === 1) return undefined;
  return `${name === 'all' ? 'ALL' : name.toUpperCase()} ${path}`;
}

/**
 * 在 webui-server 用的那份 express 的应用与 Router 原型上记下带路径的登记。应用的方法里套着 Router 的方法，只记最外层那次
 */
function recordRegistrations(): string[] {
  const express = createRequire(join(import.meta.dirname, '../../packages/plugin-webui-server/package.json'))(
    'express',
  ) as { application: Record<string, unknown>; Router: { prototype: Record<string, unknown> } };
  const names = [...METHODS.map(method => method.toLowerCase()), 'all', 'route', 'use'];
  const registered: string[] = [];
  let depth = 0;
  for (const target of [express.application, express.Router.prototype]) {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      vi.spyOn(target as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const key = depth === 0 ? keyOf(name, args) : undefined;
        if (key) registered.push(key);
        depth++;
        try {
          return original.apply(this, args);
        } finally {
          depth--;
        }
      });
    }
  }
  return registered;
}

describe('管理面 REST 的回应与契约', () => {
  const json: Sample[] = [];
  const files: Sample[] = [];
  const errors: Sample[] = [];
  let registered: string[] = [];
  let mixedModels: unknown;
  let home: string;
  let app: App;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'aalis-rest-contract-')));
    write(join(home, 'client', 'index.html'), '<!doctype html><title>前端</title>');
    write(join(home, 'package.json'), JSON.stringify({ dependencies: { '@zz/api-probe': '^0.1.0' } }));
    write(
      join(home, 'node_modules', '@zz', 'api-probe', 'package.json'),
      JSON.stringify({
        name: '@zz/api-probe',
        version: '0.1.0',
        keywords: ['aalis', 'aalis-api'],
        description: '契约',
      }),
    );
    write(join(home, 'probe', 'package.json'), JSON.stringify({ name: PROBE, files: ['dist', 'webui'] }));
    write(join(home, 'probe', 'webui', 'index.html'), '<!doctype html><title>画布</title>');
    write(join(home, 'state', 'zz.png'), PNG);
    write(join(home, 'tmp', 'zz.txt'), 'zz');
    write(
      join(home, 'logs', 'latest.log'),
      [1, 2]
        .map(seq =>
          formatLogLine({
            seq,
            timestamp: '2026-10-04T08:00:00.000+08:00',
            level: 'warn',
            scope: `aalis:${PROBE}`,
            message: `第 ${seq} 条`,
          }),
        )
        .join(''),
    );

    const realFetch = globalThis.fetch;
    const reply = (body: unknown) => Response.json(body);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(`${SEARCH}/-/v1/search`)) {
        const text = new URL(url).searchParams.get('text') ?? '';
        return reply({
          objects: text.startsWith('keywords:aalis-plugin')
            ? [
                {
                  package: {
                    name: 'zz-plugin-remote',
                    version: '9.9.9',
                    description: '远端插件',
                    keywords: ['aalis-plugin', 'zz'],
                    date: '2026-10-01T00:00:00.000Z',
                    links: { npm: 'https://www.npmjs.com/package/zz-plugin-remote' },
                    publisher: { username: 'zz' },
                  },
                  score: { final: 0.5 },
                  downloads: { monthly: 12 },
                },
              ]
            : [],
        });
      }
      if (url === `${INSTALL}/zz-plugin-remote/latest`) {
        return reply({ name: 'zz-plugin-remote', version: '3.0.0', aalis: { service: { provides: ['zz-remote'] } } });
      }
      if (url === `${INSTALL}/@zz/api-probe/latest`) return reply({ name: '@zz/api-probe', version: '0.2.0' });
      if (url === `${INSTALL}/@zz%2Fapi-probe`) {
        return reply({
          'dist-tags': { latest: '0.2.0' },
          versions: {
            '0.2.0': {
              dependencies: { '@aalis/zz-dep': '^1.0.0' },
              aalis: { service: { provides: ['zz-svc'], required: ['events'] } },
            },
          },
        });
      }
      if (url === IMAGE) return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      if (url.startsWith(SEARCH) || url.startsWith(INSTALL)) return new Response('not found', { status: 404 });
      return realFetch(input, init);
    });

    const port = await freePort();
    ({ app } = hostedApp(
      { plugins: { [PROBE]: { level: 1 } } },
      { logger, provider: { save() {} }, restartStrategy: { restart() {} } },
    ));
    provideHostPaths(app, home);
    app.bind({ provide }).provide(webuiClient, { getClientDir: () => join(home, 'client') });
    await app.pluginAll(
      [storageLocalPlugin, contributionsPlugin, doubles, model, failing, probe(home)].map(definition => ({
        definition,
        config: definition.name === PROBE ? { level: 1 } : {},
      })),
    );
    registered = recordRegistrations();
    await app.plugin(webuiServerPlugin, {
      port,
      host: '127.0.0.1',
      autoOpen: false,
      tokenMode: 'fixed',
      fixedToken: TOKEN,
      marketplaceRegistry: SEARCH,
    });
    await app.start();
    await waitListening(port);

    const base = `http://127.0.0.1:${port}`;
    const send = (key: string, path: string, body?: unknown, cookie = true) =>
      fetch(`${base}${path}`, {
        method: key.slice(0, key.indexOf(' ')),
        headers: {
          ...(cookie ? { Cookie: COOKIE } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const ok = async (key: string, path: string, body?: unknown, cookie = true) => {
      const res = await send(key, path, body, cookie);
      const sample = { key, status: res.status, body: await res.json() };
      json.push(sample);
      return sample.body as Record<string, unknown>;
    };
    const file = async (key: string, path: string, cookie = true) => {
      const res = await send(key, path, undefined, cookie);
      await res.arrayBuffer();
      const headers = Object.fromEntries([...res.headers].filter(([name]) => !TRANSPORT_HEADERS.has(name)));
      files.push({ key, status: res.status, headers });
    };
    /** 失败的回应：不是 JSON 时原样记下文字，交给类型检查时报出来 */
    const record = async (key: string, res: Response) => {
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {}
      errors.push({ key, status: res.status, body });
    };
    const fail = async (key: string, path: string, body?: unknown, cookie = true) =>
      record(key, await send(key, path, body, cookie));
    const enc = encodeURIComponent;

    // 认证
    await file('GET /api/auth/login.js', '/api/auth/login.js', false);
    await ok('POST /api/auth/login', '/api/auth/login', { token: TOKEN }, false);
    await ok('GET /api/auth/status', '/api/auth/status');
    await ok('POST /api/auth/logout', '/api/auth/logout');

    // 读
    await ok('GET /api/plugins', '/api/plugins');
    await ok('GET /api/config', '/api/config');
    await ok('GET /api/services', '/api/services');
    await ok('GET /api/attention', '/api/attention');
    await ok('GET /api/platforms', '/api/platforms');
    await ok('GET /api/logs/tail', '/api/logs/tail?limit=5');
    await ok('GET /api/logs/range', '/api/logs/range?before=2&limit=5');
    await ok('GET /api/themes', '/api/themes');
    for (const service of ['llm', 'llm-thinking', 'platform', 'gateway-scopes', 'toolGroups', 'zz-names']) {
      await ok('GET /api/models/:service', `/api/models/${service}`);
    }
    mixedModels = await ok('GET /api/models/:service', '/api/models/zz-mixed');
    await ok(
      'GET /api/models/:service',
      `/api/models/llm-thinking?dependency=${enc(JSON.stringify({ provider: 'zz-rest-llm', model: 'zz-model' }))}`,
    );
    await ok('POST /api/llm-providers/:contextId/refresh', '/api/llm-providers/zz-rest-llm/refresh');

    // 页面、布局与文件
    const { pages } = (await ok('GET /api/pages', '/api/pages')) as unknown as PageListResponse;
    await ok('GET /api/session-pages', '/api/session-pages?sessionId=s-1');
    const rows = await ok('GET /api/pages/:instance/:pageKey/data/:componentId', `/api/pages/${PROBE}/board/data/rows`);
    await ok(
      'GET /api/pages/:instance/:pageKey/data/:componentId',
      `/api/pages/${PROBE}/side/data/facts?sessionId=s-1`,
    );
    await ok('POST /api/pages/:instance/:pageKey/actions/:action', `/api/pages/${PROBE}/board/actions/touch`, {});
    await ok('GET /api/layout', '/api/layout');
    await ok('POST /api/layout', '/api/layout', { op: 'pin', page: { instance: PROBE, pageKey: 'board' } });
    const [{ file: cell }] = rows.data as Array<{ file: { handle: string } }>;
    await file('GET /api/page-file', `/api/page-file?handle=${enc(cell.handle)}`);
    await file('GET /api/session-file', '/api/session-file?sessionId=s-1&handle=zz');
    await file('GET /api/media', `/api/media?uri=${enc('data:/zz.png')}`);
    await file('GET /api/proxy/image', `/api/proxy/image?url=${enc(IMAGE)}`);
    const frame = pages.find(page => page.key === 'canvas')?.frame?.src ?? '';
    await file('GET /frames/:token/{*path}', frame, false);
    await file('GET /frames/_base/frame.js', '/frames/_base/frame.js', false);
    await file('GET /frames/_base/frame.css', '/frames/_base/frame.css', false);
    await file('GET /__clients', '/__clients');
    await file('GET /__clients.js', '/__clients.js');
    await file('GET /{*path}', '/s/zz');

    // 市场
    await ok('GET /api/marketplace', '/api/marketplace?q=');
    await ok('GET /api/system-components', '/api/system-components');
    await ok('GET /api/marketplace/depgraph', `/api/marketplace/depgraph?name=${enc('@zz/api-probe')}`);
    await ok('POST /api/marketplace/install', '/api/marketplace/install', { name: 'zz-plugin-remote' });
    await ok('POST /api/marketplace/uninstall', '/api/marketplace/uninstall', {
      name: 'zz-plugin-remote',
      removeConfig: true,
    });
    await ok('POST /api/marketplace/update', '/api/marketplace/update', {
      targets: [{ name: '@zz/api-probe', version: '0.2.0' }],
    });

    // 管理动作
    await ok('PUT /api/plugins/:name/config', `/api/plugins/${PROBE}/config`, { config: { level: 2 } });
    await ok('POST /api/plugins/:name/disable', `/api/plugins/${PROBE}/disable`);
    await ok('POST /api/plugins/:name/enable', `/api/plugins/${PROBE}/enable`);
    await ok('POST /api/plugins/:name/reload', `/api/plugins/${PROBE}/reload`);
    await ok('POST /api/plugins/scan', '/api/plugins/scan');
    await ok('POST /api/plugins/:name/instances', `/api/plugins/${PROBE}/instances`, { suffix: 'b' });
    await ok('DELETE /api/plugins/:instanceId/instance', `/api/plugins/${enc(`${PROBE}:b`)}/instance`);
    await ok('PUT /api/config', '/api/config', { name: 'T2' });
    await ok('POST /api/services/:name/prefer', '/api/services/platform/prefer', { contextId: 'zz-rest-doubles' });
    await ok('DELETE /api/services/:name/prefer', '/api/services/platform/prefer');

    // 失败
    await fail('GET /api/plugins', '/api/plugins', undefined, false);
    await fail('GET /api/zz-unknown', '/api/zz-unknown');
    await fail('GET /api/logs/tail', '/api/logs/tail?level=nope');
    await fail('PUT /api/config', '/api/config', { zz: 1 });
    await fail('POST /api/layout', '/api/layout', { op: 'nope' });
    await fail('POST /api/pages/:instance/:pageKey/actions/:action', `/api/pages/${PROBE}/board/actions/zz`, {});
    // 请求体不是 JSON：解析在认证之前，没登录也走到这里
    await record(
      'POST /api/layout',
      await fetch(`${base}/api/layout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      }),
    );
    await fail('GET /api/pages/:instance/:pageKey/data/:componentId', '/api/pages/%E0%A4%A/board/data/rows');
    connectionsThrow = true;
    await fail('GET /api/platforms', '/api/platforms');
    connectionsThrow = false;

    await ok('POST /api/restart', '/api/restart');
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.stop();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('契约里的每条路由都走过一遍成功的路径', () => {
    const { json: jsonKeys, file: fileKeys } = contractRoutes();
    const succeeded = (samples: Sample[]) =>
      new Set(samples.filter(sample => sample.status >= 200 && sample.status < 300).map(sample => sample.key));
    const failed = [...json, ...files].filter(sample => sample.status < 200 || sample.status >= 300);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(jsonKeys.filter(key => !succeeded(json).has(key))).toEqual([]);
    expect(fileKeys.filter(key => !succeeded(files).has(key))).toEqual([]);
    expect(errors.map(sample => sample.status)).toEqual([401, 404, 400, 400, 400, 404, 400, 400, 500]);
    // 出错的原因只进日志，回应里不带
    expect(JSON.stringify(errors.at(-1)?.body)).not.toContain('/zz/secret/path');
  });

  it('webui-server 实际登记的路由与契约的路由表逐条对上，多一条少一条都不行', () => {
    const { json: jsonKeys, file: fileKeys } = contractRoutes();
    // /frames/_base/ 下的文件由插件前端的挂载托管
    const expected = [...jsonKeys, ...fileKeys].filter(key => !key.startsWith('GET /frames/_base/'));
    expect(registered).toContain('GET /api/plugins');
    expect([...registered].sort()).toEqual(expected.sort());
  });

  it('/api/models 合起各提供者的 listModels()：胜出的提供者没有它时照样取排在后面的；取不到的跳过，记 warn 点名', () => {
    expect(mixedModels).toEqual({ models: ['zz-late'] });
    expect(warns.filter(w => w.startsWith('取 zz-mixed '))).toEqual([
      '取 zz-mixed 的可选值时 zz-mixed/broken 失败，它的取值不在下拉里: Error: 人设目录读不出',
    ]);
  });

  it('JSON 的回应、文件的响应头与失败的回应都与契约的类型对得上', () => {
    const literal = (value: unknown) => JSON.stringify(value);
    const source = [
      "import type { ErrorResponse, WebuiFileRoutes, WebuiRestRoutes } from '@aalis/api-webui';",
      ...json.map(({ key, body }) => `(${literal(body)}) satisfies WebuiRestRoutes['${key}']['response'];`),
      ...files.map(({ key, headers }) => `(${literal(headers)}) satisfies WebuiFileRoutes['${key}']['headers'];`),
      ...errors.map(({ body }) => `(${literal(body)}) satisfies ErrorResponse;`),
      '',
    ].join('\n');
    const errs = runTscProbe(source);
    const lines = source.split('\n');
    const located = errs.map(err => {
      const line = Number(/fixture\.ts\((\d+),/.exec(err)?.[1]);
      return `${err}\n    ${lines[line - 1]?.slice(0, 400)}`;
    });
    expect(located, located.join('\n')).toEqual([]);
  });
});
