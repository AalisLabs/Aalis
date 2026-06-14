import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { type AccountVerifier, createAuthSystem } from '../../packages/plugin-webui-server/src/auth.js';
import { createRouteGate } from '../../packages/plugin-webui-server/src/gate.js';

// ════════════════════════════════════════════════════════════
// webui-server auth — 账户 session + 单 token 双模式
//
// 纯 middleware 单测：用最小 req/res mock 走登录/识别/注销/锁定流程，
// 不起 HTTP 服务器。
// ════════════════════════════════════════════════════════════

function makeLogger(): Logger {
  const noop = () => undefined;
  const l = { debug: noop, info: noop, warn: noop, error: noop, child: () => l } as unknown as Logger;
  return l;
}

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
}) {
  return {
    path: over.path ?? '/',
    method: over.method ?? 'GET',
    query: over.query ?? {},
    headers: { cookie: over.cookie },
    body: over.body,
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

function makeAuth(accounts?: Partial<AccountVerifier>, tokenLogin?: () => boolean) {
  return createAuthSystem(
    TOKEN,
    makeLogger(),
    {
      verify: accounts?.verify ?? ((u, p) => u === 'alice' && p === 'correct-horse'),
      hasAccounts: accounts?.hasAccounts ?? (() => true),
    },
    tokenLogin,
  );
}

async function run(
  auth: ReturnType<typeof makeAuth>,
  req: ReturnType<typeof makeReq>,
): Promise<{ res: MockRes; nexted: boolean }> {
  const res = makeRes();
  let nexted = false;
  await auth.middleware(req as never, res as never, () => {
    nexted = true;
  });
  return { res, nexted };
}

async function loginAlice(auth: ReturnType<typeof makeAuth>): Promise<{ res: MockRes; cookie?: string }> {
  const { res } = await run(
    auth,
    makeReq({ path: '/api/auth/login', method: 'POST', body: { username: 'alice', password: 'correct-horse' } }),
  );
  return { res, cookie: extractCookie(res, 'aalis_webui_session') };
}

describe('账户登录（session）', () => {
  it('正确账密 → 设置 session cookie，identify 解析为 webui:<username>', async () => {
    const auth = makeAuth();
    const { res, cookie } = await loginAlice(auth);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ ok: true, identity: { platform: 'webui', userId: 'alice' } });
    expect(cookie).toBeTruthy();
    expect(auth.identify({ headers: { cookie } })).toEqual({ platform: 'webui', userId: 'alice' });
    // 认证后的请求被放行
    expect((await run(auth, makeReq({ path: '/api/plugins', cookie }))).nexted).toBe(true);
  });

  it('错误密码 → 401 且不设 cookie', async () => {
    const auth = makeAuth();
    const { res } = await run(
      auth,
      makeReq({ path: '/api/auth/login', method: 'POST', body: { username: 'alice', password: 'wrong' } }),
    );
    expect(res.statusCode).toBe(401);
    expect(extractCookie(res, 'aalis_webui_session')).toBeUndefined();
  });

  it('连续失败触发锁定（429）', async () => {
    const auth = makeAuth();
    const attempt = () =>
      run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { username: 'bob', password: 'x' } }));
    for (let i = 0; i < 5; i++) expect((await attempt()).res.statusCode).toBe(401);
    expect((await attempt()).res.statusCode).toBe(429);
  });

  it('注销清除 session：identify 回到 undefined', async () => {
    const auth = makeAuth();
    const { cookie } = await loginAlice(auth);
    await run(auth, makeReq({ path: '/api/auth/logout', method: 'POST', cookie }));
    expect(auth.identify({ headers: { cookie } })).toBeUndefined();
  });
});

describe('单 token 模式（向后兼容）', () => {
  it('token 登录 → identify 解析为 webui:console', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } }));
    expect(res.statusCode).toBe(200);
    const cookie = extractCookie(res, 'aalis_webui_token');
    expect(auth.identify({ headers: { cookie } })).toEqual({ platform: 'webui', userId: 'console' });
    expect(auth.verifyWsClient({ headers: { cookie } } as never)).toBe(true);
  });

  it('错误 token → 401', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: 'nope' } }));
    expect(res.statusCode).toBe(401);
  });

  it('session 与 token 并存时 session 身份优先', async () => {
    const auth = makeAuth();
    const { cookie } = await loginAlice(auth);
    const both = `${cookie}; aalis_webui_token=${TOKEN}`;
    expect(auth.identify({ headers: { cookie: both } })?.userId).toBe('alice');
  });
});

describe('未认证拦截', () => {
  it('API 请求 401 JSON；GET 页面返回登录页', async () => {
    const auth = makeAuth();
    const api = await run(auth, makeReq({ path: '/api/plugins' }));
    expect(api.res.statusCode).toBe(401);
    expect(api.nexted).toBe(false);
    const page = await run(auth, makeReq({ path: '/' }));
    expect(page.res.statusCode).toBe(401);
    expect(page.res.htmlBody).toContain('用户名');
  });

  it('无账户时登录页只显示 token 表单', async () => {
    const auth = makeAuth({ hasAccounts: () => false });
    const page = await run(auth, makeReq({ path: '/' }));
    expect(page.res.htmlBody).not.toContain('用户名');
    expect(page.res.htmlBody).toContain('token');
  });

  it('status 端点返回 authed=false / 登录后含身份', async () => {
    const auth = makeAuth();
    const anon = await run(auth, makeReq({ path: '/api/auth/status' }));
    expect(anon.res.jsonBody).toMatchObject({ authed: false });
    const { cookie } = await loginAlice(auth);
    const authed = await run(auth, makeReq({ path: '/api/auth/status', cookie }));
    expect(authed.res.jsonBody).toMatchObject({ authed: true, identity: { userId: 'alice' } });
  });
});

describe('tokenMode=disabled（多用户收口）', () => {
  it('存在账户时 token 全面失效：登录 401、既有 token cookie 不再识别、登录页隐藏 token 表单', async () => {
    const auth = makeAuth(undefined, () => false);
    const login = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } }));
    expect(login.res.statusCode).toBe(401);
    expect((login.res.jsonBody as { error?: string }).error).toMatch(/已禁用/);
    expect(auth.identify({ headers: { cookie: `aalis_webui_token=${TOKEN}` } })).toBeUndefined();
    const page = await run(auth, makeReq({ path: '/' }));
    expect(page.res.htmlBody).toContain('用户名');
    expect(page.res.htmlBody).not.toContain('访问 token');
    // 账户登录不受影响
    expect((await loginAlice(auth)).res.statusCode).toBe(200);
  });

  it('无任何账户时 token 兜底生效（防锁死）', async () => {
    const auth = makeAuth({ hasAccounts: () => false }, () => false);
    const login = await run(auth, makeReq({ path: '/api/auth/login', method: 'POST', body: { token: TOKEN } }));
    expect(login.res.statusCode).toBe(200);
    expect(auth.identify({ headers: { cookie: `aalis_webui_token=${TOKEN}` } })).toEqual({
      platform: 'webui',
      userId: 'console',
    });
  });
});

describe('REST 路由能力闸（gate × authorize）', () => {
  // owner=true 时把 alice 配为 owner；grant/deny 对 alice 做能力委托（系统上下文，不校验子集）。
  function makeGate(opts: { owner?: boolean; grant?: string[]; deny?: string[] } = {}) {
    const cfgData: Record<string, unknown> = opts.owner ? { owners: [{ platform: 'webui', userId: 'alice' }] } : {};
    const config = {
      get: (k: string) => cfgData[k],
      set: (k: string, v: unknown) => {
        cfgData[k] = v;
      },
    };
    const manager = new AuthorityManager(
      config as never,
      makeLogger(),
      {} as ConstructorParameters<typeof AuthorityManager>[2],
    );
    if (opts.grant || opts.deny) {
      manager.setUserCapabilities(null, { platform: 'webui', userId: 'alice' }, { grant: opts.grant, deny: opts.deny });
    }
    const ctx = { getService: (n: string) => (n === 'authority' ? manager : undefined), config } as never;
    return createRouteGate(ctx, () => ({ platform: 'webui', userId: 'alice' }));
  }

  function pass(middleware: ReturnType<ReturnType<typeof makeGate>>): { status: number; nexted: boolean } {
    const res = makeRes();
    let nexted = false;
    middleware({ headers: {} }, res, () => {
      nexted = true;
    });
    return { status: res.statusCode, nexted };
  }

  it('默认可见性：public 放行普通账户，restricted（未授予）拒绝', () => {
    const gate = makeGate();
    expect(pass(gate('webui:status:read', 'public')).nexted).toBe(true);
    expect(pass(gate('webui:logs:read', 'restricted')).status).toBe(403);
    expect(pass(gate('webui:config:write', 'restricted')).status).toBe(403);
  });

  it('per-user grant 可单独放行某条 restricted 路由', () => {
    const gate = makeGate({ grant: ['webui:files:read'] });
    expect(pass(gate('webui:files:read', 'restricted')).nexted).toBe(true);
    expect(pass(gate('webui:files:write', 'restricted')).status).toBe(403);
  });

  it('owner 账户全档放行', () => {
    const gate = makeGate({ owner: true });
    expect(pass(gate('webui:config:write', 'restricted')).nexted).toBe(true);
  });

  it('authority 缺席时 fail-closed：public 放行，restricted 503（不裸奔）', () => {
    const config = { get: () => undefined };
    const ctx = { getService: () => undefined, config } as never;
    const gate = createRouteGate(ctx, () => ({ platform: 'webui', userId: 'console' }));
    expect(pass(gate('webui:status:read', 'public')).nexted).toBe(true);
    expect(pass(gate('webui:logs:read', 'restricted')).status).toBe(503);
    expect(pass(gate('webui:config:write', 'restricted')).status).toBe(503);
  });
});
