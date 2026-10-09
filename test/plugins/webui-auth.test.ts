import { timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_THEMES, DEFAULT_THEMES } from '../../packages/api-webui/src/index.js';
import { App, type Logger } from '../../packages/core/src/index.js';
import {
  createAuthSystem,
  LOGIN_FAILURE_ADDRESSES_MAX,
  originAllowed,
} from '../../packages/plugin-webui-server/src/auth.js';
import { createRouteGate, type RouteGate } from '../../packages/plugin-webui-server/src/gate.js';
import webuiServer from '../../packages/plugin-webui-server/src/index.js';

// ════════════════════════════════════════════════════════════
// webui-server auth — 单 token（单 owner）
//
// 认证挂到一个按登记先后分派的假 app 上（只认方法与完整路径），用最小 req/res mock 走登录/识别/注销流程、token 比较、
// 来源判定与登录失败限速，不起 HTTP 服务器。
// 固定 token 的长度校验在插件激活时做，那一组只激活插件、不启动应用，同样不监听端口。
// ════════════════════════════════════════════════════════════

// 定时安全比较的调用记下来，核对 token 比较走的是它、比的是等长的摘要；判定仍由原函数做
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

interface MockRes {
  statusCode: number;
  jsonBody: unknown;
  headers: Record<string, string | string[]>;
  htmlBody?: string;
  redirectTo?: string;
}

function makeRes(): MockRes & Record<string, unknown> {
  const res: MockRes & Record<string, unknown> = {
    statusCode: 200,
    jsonBody: undefined,
    headers: {},
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.jsonBody = body;
    return res;
  };
  res.setHeader = (name: string, value: string | string[]) => {
    res.headers[name] = value;
    return res;
  };
  res.type = () => res;
  res.send = (body: string) => {
    res.htmlBody = body;
    return res;
  };
  res.redirect = (_code: number, url: string) => {
    res.redirectTo = url;
    return res;
  };
  res.end = () => res;
  return res;
}

function makeReq(over: {
  path?: string;
  method?: string;
  cookie?: string;
  body?: unknown;
  query?: Record<string, string>;
  /** 来源地址，默认本机回环 */
  address?: string;
  /** 其余请求头（origin、host、sec-fetch-site） */
  headers?: Record<string, string>;
}) {
  const path = over.path ?? '/';
  const search = new URLSearchParams(over.query).toString();
  return {
    path,
    originalUrl: search ? `${path}?${search}` : path,
    method: over.method ?? 'GET',
    query: over.query ?? {},
    headers: { cookie: over.cookie, ...over.headers },
    body: over.body,
    socket: { remoteAddress: over.address ?? '127.0.0.1' },
  };
}

/** 从 Set-Cookie 头里取指定 cookie 的 `name=value` 对（供后续请求回带） */
function extractCookie(res: MockRes, name: string): string | undefined {
  const raw = res.headers['Set-Cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find(c => c.startsWith(`${name}=`));
  return hit?.split(';')[0];
}

const TOKEN = 'test-token-abc';

function makeAuth() {
  return createAuthSystem(() => TOKEN);
}

type Handler = (req: unknown, res: unknown, next: () => Promise<void>) => unknown;

/** 把认证挂上的中间件与路由按登记先后排成一列；路由只在方法与完整路径都对上时接手 */
function stackOf(auth: ReturnType<typeof makeAuth>) {
  const stack: Array<{ method?: string; path?: string; handle: Handler }> = [];
  const routeOf =
    (method: string) =>
    (path: string, ...handlers: Handler[]) =>
      stack.push(...handlers.map(handle => ({ method, path, handle })));
  auth.install({
    use: (handle: Handler) => stack.push({ handle }),
    get: routeOf('GET'),
    post: routeOf('POST'),
  } as never);
  return stack;
}

/** 走一遍认证：nexted 为 true 表示交给了后面的路由 */
async function run(
  auth: ReturnType<typeof makeAuth>,
  req: ReturnType<typeof makeReq>,
): Promise<{ res: MockRes; nexted: boolean }> {
  const res = makeRes();
  const stack = stackOf(auth);
  let nexted = false;
  let i = 0;
  const next = async (): Promise<void> => {
    while (i < stack.length) {
      const layer = stack[i++];
      if (layer.method && (layer.method !== req.method || layer.path !== req.path)) continue;
      await layer.handle(req, res, next);
      return;
    }
    nexted = true;
  };
  await next();
  return { res, nexted };
}

describe('单 token 登录', () => {
  it('token 登录 → identify 解析为 webui:console，认证后请求放行', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } }));
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ ok: true, identity: { platform: 'webui', userId: 'console' } });
    const cookie = extractCookie(res, 'aalis_webui_token');
    expect(auth.identify({ headers: { cookie } })).toEqual({ platform: 'webui', userId: 'console' });
    expect(auth.verifyWsClient({ headers: { cookie } } as never)).toBe(true);
    expect((await run(auth, makeReq({ path: '/api/plugins', cookie }))).nexted).toBe(true);
  });

  it('错误 token → 401', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: 'nope' } }));
    expect(res.statusCode).toBe(401);
  });

  it('?token= 命中 → 设 cookie 并 302 到同一路径，只去掉 token，其余查询串照留', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/', query: { token: TOKEN } }));
    expect(res.redirectTo).toBe('/');
    expect(extractCookie(res, 'aalis_webui_token')).toBeTruthy();

    const logs = await run(
      auth,
      makeReq({ path: '/health/logs', query: { level: 'error', token: TOKEN, plugin: '@x/p:2', text: 'a b' } }),
    );
    expect(logs.res.redirectTo).toBe('/health/logs?level=error&plugin=%40x%2Fp%3A2&text=a+b');
  });

  it('注销清除 token：identify 回到 undefined', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } }));
    const logout = await run(
      auth,
      makeReq({ path: '/api/auth/logout', method: 'POST', cookie: extractCookie(res, 'aalis_webui_token') }),
    );
    // 注销返回清空 cookie 头；之后无 cookie 的请求 identify 为 undefined
    expect(logout.res.jsonBody).toMatchObject({ ok: true });
    expect(auth.identify({ headers: {} })).toBeUndefined();
  });
});

describe('token 比较', () => {
  it('cookie、?token= 与登录三处都以等长的摘要做定时安全比较：正确、错误、长度不同的 token 判定照旧', async () => {
    const compare = vi.mocked(timingSafeEqual);
    const lengths = new Set<number>();
    for (const [given, ok] of [
      [TOKEN, true],
      ['test-token-abd', false],
      ['short', false],
      [`${TOKEN}-and-more`, false],
    ] as const) {
      const auth = makeAuth();
      compare.mockClear();
      expect(auth.verifyWsClient({ headers: { cookie: `aalis_webui_token=${given}` } } as never)).toBe(ok);
      const viaQuery = await run(auth, makeReq({ path: '/', query: { token: given } }));
      expect(viaQuery.res.redirectTo === '/').toBe(ok);
      const viaLogin = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: given } }));
      expect(viaLogin.res.statusCode).toBe(ok ? 200 : 401);
      // 每处一次比较，两边等长，且长度与给的 token 无关：比较的耗时不透露 token 的长度
      expect(compare).toHaveBeenCalledTimes(3);
      for (const [a, b] of compare.mock.calls) {
        expect(a.byteLength).toBe(b.byteLength);
        lengths.add(a.byteLength);
      }
    }
    expect(lengths.size).toBe(1);
  });
});

describe('同源判定', () => {
  const allowed = (origin: string | undefined, host: string | undefined) =>
    originAllowed({ headers: { origin, host } });

  it('Origin 与 Host 两边去掉默认端口再比：https 的 443、http 的 80 写不写都算同源', () => {
    expect(allowed('https://a.example', 'a.example:443')).toBe(true);
    expect(allowed('https://a.example:443', 'a.example')).toBe(true);
    expect(allowed('http://a.example', 'a.example:80')).toBe(true);
    expect(allowed('http://127.0.0.1:3000', '127.0.0.1:3000')).toBe(true);
    expect(allowed('http://[::1]:3000', '[::1]:3000')).toBe(true);
  });

  it('别的端口、默认端口对不上协议、换个主机名、Origin 为 null、没有 Host 都不算同源；没有 Origin 的交给 token', () => {
    expect(allowed('https://a.example', 'a.example:444')).toBe(false);
    expect(allowed('http://a.example', 'a.example:443')).toBe(false);
    expect(allowed('http://127.0.0.1:3001', '127.0.0.1:3000')).toBe(false);
    expect(allowed('http://localhost:3000', '127.0.0.1:3000')).toBe(false);
    expect(allowed('null', 'a.example')).toBe(false);
    expect(allowed('https://a.example', undefined)).toBe(false);
    expect(allowed('http://undefined', undefined), '没有 Host 时不拿字面量 undefined 去比').toBe(false);
    expect(allowed(undefined, 'a.example')).toBe(true);
  });
});

describe('登录失败限速', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const login = (auth: ReturnType<typeof makeAuth>, token: string, address?: string) =>
    run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token }, address }));
  const viaQuery = (auth: ReturnType<typeof makeAuth>, token: string, address?: string) =>
    run(auth, makeReq({ path: '/', query: { token }, address }));

  it('同一地址失败满 10 次后，登录与 ?token= 都回 429，正确的 token 也不收；本机回环同样计数，别的地址不受影响', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const auth = makeAuth();
    for (let i = 0; i < 5; i++) expect((await login(auth, 'wrong')).res.statusCode).toBe(401);
    for (let i = 0; i < 5; i++) expect((await viaQuery(auth, 'wrong')).res.statusCode).toBe(401);

    const locked = await login(auth, TOKEN);
    expect(locked.res.statusCode).toBe(429);
    expect(locked.res.headers['Retry-After']).toBe('600');
    expect(locked.res.jsonBody).toEqual({ error: expect.stringContaining('10 分钟') });
    expect(extractCookie(locked.res, 'aalis_webui_token')).toBeUndefined();
    const lockedQuery = await viaQuery(auth, TOKEN);
    expect(lockedQuery.res.statusCode).toBe(429);
    expect(lockedQuery.res.redirectTo).toBeUndefined();
    expect(lockedQuery.res.htmlBody).toContain('登录失败次数过多');

    expect((await login(auth, TOKEN, '192.0.2.7')).res.statusCode).toBe(200);
  });

  it('从第一次失败算起 10 分钟后自动解除，计数从零重来', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const auth = makeAuth();
    await login(auth, 'wrong');
    vi.advanceTimersByTime(5 * 60_000);
    for (let i = 0; i < 9; i++) await login(auth, 'wrong');
    vi.advanceTimersByTime(5 * 60_000 - 1);
    const stillLocked = await login(auth, TOKEN);
    expect(stillLocked.res.statusCode).toBe(429);
    expect(stillLocked.res.headers['Retry-After']).toBe('1');
    vi.advanceTimersByTime(1);
    // 解除之后没有登录成功过，新的窗口照样数满 10 次才拒
    for (let i = 0; i < 10; i++) expect((await login(auth, 'wrong')).res.statusCode).toBe(401);
    expect((await login(auth, TOKEN)).res.statusCode).toBe(429);
    vi.advanceTimersByTime(10 * 60_000);
    expect((await login(auth, TOKEN)).res.statusCode).toBe(200);
  });

  it('登录成功清零：?token= 与登录接口成功之后，都重新从零计数', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const auth = makeAuth();
    for (let i = 0; i < 9; i++) await login(auth, 'wrong');
    expect((await viaQuery(auth, TOKEN)).res.redirectTo).toBe('/');
    for (let i = 0; i < 9; i++) expect((await login(auth, 'wrong')).res.statusCode).toBe(401);
    expect((await login(auth, TOKEN)).res.statusCode).toBe(200);
    // 从零数满 10 次才拒
    for (let i = 0; i < 10; i++) expect((await login(auth, 'wrong')).res.statusCode).toBe(401);
    expect((await login(auth, TOKEN)).res.statusCode).toBe(429);
  });

  it('别的网页借 owner 的浏览器发起的登录不计失败：跨源的登录回 403，别的站点打开的 ?token= 不比对；之后正确的 token 照常登录', async () => {
    const auth = makeAuth();
    const host = '127.0.0.1:3000';
    const crossLogin = (token?: string) =>
      run(
        auth,
        makeReq({
          path: '/api/auth/login',
          method: 'POST',
          body: token === undefined ? {} : { token },
          headers: { origin: 'http://127.0.0.1:5173', host },
        }),
      );
    // 跨源的 text/plain 简单请求：body 解析不出 token
    for (let i = 0; i < 10; i++) expect((await crossLogin()).res.statusCode).toBe(403);
    const crossWithToken = await crossLogin(TOKEN);
    expect(crossWithToken.res.statusCode, '跨源带着正确的 token 也不登录').toBe(403);
    expect(extractCookie(crossWithToken.res, 'aalis_webui_token')).toBeUndefined();

    for (const site of ['cross-site', 'same-site']) {
      for (let i = 0; i < 10; i++) {
        const r = await run(auth, makeReq({ path: '/', query: { token: 'x' }, headers: { 'sec-fetch-site': site } }));
        expect(r.res.statusCode, site).toBe(401);
        expect(r.res.htmlBody, site).toContain('访问 token');
      }
      const r = await run(auth, makeReq({ path: '/', query: { token: TOKEN }, headers: { 'sec-fetch-site': site } }));
      expect(r.res.redirectTo, `${site} 带着正确的 token 也不设 cookie`).toBeUndefined();
      expect(extractCookie(r.res, 'aalis_webui_token')).toBeUndefined();
    }
    // 已登录的页面被别的站点带着乱写的 token 打开：照常放行
    const authed = await run(
      auth,
      makeReq({
        path: '/',
        query: { token: 'x' },
        cookie: `aalis_webui_token=${TOKEN}`,
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    );
    expect(authed.nexted).toBe(true);

    // 以上都没计数：同源的登录与粘贴的链接（Sec-Fetch-Site 为 none）照常成功
    const sameOrigin = await run(
      auth,
      makeReq({
        path: '/api/auth/login',
        method: 'POST',
        body: { token: TOKEN },
        headers: { origin: `http://${host}`, host },
      }),
    );
    expect(sameOrigin.res.statusCode).toBe(200);
    const pasted = await run(
      auth,
      makeReq({ path: '/', query: { token: TOKEN }, headers: { 'sec-fetch-site': 'none' } }),
    );
    expect(pasted.res.redirectTo).toBe('/');
  });

  it('计数表有上限：失败过的地址到了上限，再记新地址时丢掉最早的那条，表不随地址数无限增长', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const auth = makeAuth();
    const first = '192.0.2.1';
    for (let i = 0; i < 10; i++) await login(auth, 'wrong', first);
    expect((await login(auth, TOKEN, first)).res.statusCode).toBe(429);
    const others = Array.from({ length: LOGIN_FAILURE_ADDRESSES_MAX }, (_, i) => `2001:db8::${i.toString(16)}`);
    const last = others.pop() as string;
    for (const address of others) await login(auth, 'wrong', address);
    expect((await login(auth, TOKEN, first)).res.statusCode, '表刚满，最早的那条还在').toBe(429);
    await login(auth, 'wrong', last);
    expect((await login(auth, TOKEN, first)).res.statusCode, '最早的那条被挤掉').toBe(200);
    // 后来的照常计数
    for (let i = 0; i < 9; i++) await login(auth, 'wrong', last);
    expect((await login(auth, TOKEN, last)).res.statusCode).toBe(429);
  });
});

describe('改状态的请求校验来源', () => {
  const host = '127.0.0.1:3000';
  const cookie = `aalis_webui_token=${TOKEN}`;
  const request = (method: string, origin?: string) =>
    run(
      makeAuth(),
      makeReq({ path: '/api/plugins/x/enable', method, cookie, headers: { host, ...(origin && { origin }) } }),
    );

  it('非 GET 的请求与 WebSocket 用同一个判定：Origin 不同源回 403，带着有效的 cookie 也不放行', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const origin of ['http://127.0.0.1:5173', 'http://evil.example', 'null']) {
        const { res, nexted } = await request(method, origin);
        expect([method, origin, res.statusCode, nexted]).toEqual([method, origin, 403, false]);
      }
    }
  });

  it('同源的照常放行；没有 Origin 的（脚本、命令行）交给 token；GET 不看 Origin', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await request(method, `http://${host}`)).nexted, method).toBe(true);
      expect((await request(method)).nexted, method).toBe(true);
    }
    expect((await request('GET', 'http://evil.example')).nexted).toBe(true);
    const noToken = await run(
      makeAuth(),
      makeReq({ path: '/api/plugins/x/enable', method: 'POST', headers: { host } }),
    );
    expect(noToken.res.statusCode).toBe(401);
  });

  it('跨源的注销也被拒，cookie 不被清掉', async () => {
    const { res } = await run(
      makeAuth(),
      makeReq({ path: '/api/auth/logout', method: 'POST', cookie, headers: { host, origin: 'http://evil.example' } }),
    );
    expect(res.statusCode).toBe(403);
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });
});

describe('未认证拦截', () => {
  it('API 请求 401 JSON；GET 页面返回登录页（仅 token 表单）', async () => {
    const auth = makeAuth();
    const api = await run(auth, makeReq({ path: '/api/plugins' }));
    expect(api.res.statusCode).toBe(401);
    expect(api.nexted).toBe(false);
    const page = await run(auth, makeReq({ path: '/' }));
    expect(page.res.statusCode).toBe(401);
    expect(page.res.htmlBody).toContain('访问 token');
    expect(page.res.htmlBody).not.toContain('用户名');
    // 文档级 CSP 只许同源脚本：登录页不带内联脚本，脚本另由不需登录的同源地址给出
    expect(page.res.htmlBody).toMatch(/<script src="\/api\/auth\/login\.js"><\/script>/);
    expect(page.res.htmlBody).not.toMatch(/<script>/);
    const script = await run(auth, makeReq({ path: '/api/auth/login.js' }));
    expect(script.res.statusCode).toBe(200);
    expect(script.res.htmlBody).toContain('/api/auth/login');
  });

  it('登录页写明 token 在哪：启动日志不打印 token，只给 access.txt 的位置；fixed 模式是配置项 fixedToken，值在 secrets.yaml 里', async () => {
    const page = await run(makeAuth(), makeReq({ path: '/' }));
    const hint = page.res.htmlBody?.match(/<h1>Aalis WebUI<\/h1>\s*<p>([^<]*)<\/p>/)?.[1];
    expect(hint).toBe(
      '访问 token 在家目录的 state/webui/access.txt 里，启动日志「访问凭据已写入」那行给出它的完整路径；' +
        'tokenMode 为 fixed 时它是配置项 fixedToken，启动后值存在家目录的 secrets.yaml 里（配置文件里是引用）。',
    );
  });

  it('登录页按默认主题的令牌着色，深浅跟随系统；不用卡片、不加阴影，圆角只用小档', async () => {
    const page = await run(makeAuth(), makeReq({ path: '/' }));
    const style = page.res.htmlBody?.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '';
    const [darkPart, lightPart = ''] = style.split('@media (prefers-color-scheme: light)');
    const declared = (part: string) =>
      Object.fromEntries([...part.matchAll(/(--color-[a-z0-9-]+):([^;}]+)/g)].map(m => [m[1], m[2]]));
    for (const [part, id] of [
      [darkPart, DEFAULT_THEMES.dark],
      [lightPart, DEFAULT_THEMES.light],
    ] as const) {
      expect(declared(part), id).toEqual(expect.objectContaining(BUILTIN_THEMES[id].colors));
    }
    expect(style).toContain('color-scheme:light dark');
    // 规则里的颜色只引用令牌：去掉令牌的声明之后没有颜色字面量
    const rules = style.replace(/--color-[a-z0-9-]+:[^;}]+;?/g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(rules).toContain('var(--color-bg)');
    expect(style).not.toContain('box-shadow');
    expect(page.res.htmlBody).not.toContain('class="card"');
    expect(new Set([...style.matchAll(/border-radius:([^;}]+)/g)].map(m => m[1]))).toEqual(new Set(['4px']));
  });

  it('status 端点：匿名 authed=false；token 登录后含 console 身份', async () => {
    const auth = makeAuth();
    const anon = await run(auth, makeReq({ path: '/api/auth/status' }));
    expect(anon.res.jsonBody).toMatchObject({ authed: false });
    const { res } = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } }));
    const cookie = extractCookie(res, 'aalis_webui_token');
    const authed = await run(auth, makeReq({ path: '/api/auth/status', cookie }));
    expect(authed.res.jsonBody).toMatchObject({ authed: true, identity: { userId: 'console' } });
  });
});

describe('REST 路由 owner 闸（单 owner 终态）', () => {
  function pass(middleware: ReturnType<RouteGate>): { status: number; nexted: boolean } {
    const res = makeRes();
    let nexted = false;
    middleware({ headers: {} }, res as unknown as Parameters<typeof middleware>[1], () => {
      nexted = true;
    });
    return { status: res.statusCode, nexted };
  }

  it('身份解析得到（持 token ⟺ console ⟺ owner）→ 放行', () => {
    const gate = createRouteGate(() => ({ platform: 'webui', userId: 'console' }));
    expect(pass(gate()).nexted).toBe(true);
  });

  it('身份解析为空（未认证，理论上连接级认证已先拦）→ 403', () => {
    const gate = createRouteGate(() => undefined);
    const r = pass(gate());
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });
});

describe('固定 token 的长度', () => {
  const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
  const apps: App[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
  });

  /** 只激活、不启动应用：webui-server 在应用就绪时才监听，这里不占端口 */
  async function activate(fixedToken: string) {
    const app = new App({ name: 'T', logLevel: 'error', logger: silent });
    apps.push(app);
    await app.plugin(webuiServer, { host: '127.0.0.1', autoOpen: false, tokenMode: 'fixed', fixedToken });
    await app.plugins.idle();
    return app.plugins.getPlugin(webuiServer.name);
  }

  it('fixed 模式的 token 去掉首尾空白后不足 32 个字符：激活失败并写明原因', async () => {
    const short = await activate(`  ${'k'.repeat(31)}  `);
    expect(short?.state).toBe('error');
    expect(short?.error).toContain('fixedToken');
    expect(short?.error).toContain('32');
  });

  it('够 32 个字符的照常激活；留空的仍按 persist 处理', async () => {
    expect((await activate('k'.repeat(32)))?.state).toBe('active');
    expect((await activate(''))?.state).toBe('active');
  });
});
