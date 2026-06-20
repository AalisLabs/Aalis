import type { Logger } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { AuthorityManager } from '../../packages/plugin-authority/src/authority-manager.js';
import { createAuthSystem } from '../../packages/plugin-webui-server/src/auth.js';
import { createRouteGate } from '../../packages/plugin-webui-server/src/gate.js';

// ════════════════════════════════════════════════════════════
// webui-server auth — 单 token（单 owner）
//
// 纯 middleware 单测：用最小 req/res mock 走登录/识别/注销流程，不起 HTTP 服务器。
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

function makeAuth() {
  return createAuthSystem(TOKEN, makeLogger());
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

  it('?token= 命中 → 设 cookie 并 302 到干净路径', async () => {
    const auth = makeAuth();
    const { res } = await run(auth, makeReq({ path: '/', query: { token: TOKEN } }));
    expect(res.redirectTo).toBe('/');
    expect(extractCookie(res, 'aalis_webui_token')).toBeTruthy();
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

describe('REST 路由权限闸（gate × authorize · 档位）', () => {
  // owner=true 把 alice 配为 owner；tier 给 alice 设档（档位裁决：restricted webui 路由 minTier=信任）。
  function makeGate(opts: { owner?: boolean; tier?: 'banned' | 'visitor' | 'friend' | 'trusted' } = {}) {
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
    if (opts.tier) {
      manager.setUserTier({ platform: 'webui', userId: 'alice' }, opts.tier);
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

  it('默认档(访客)：public 放行，restricted 拒绝', () => {
    const gate = makeGate();
    expect(pass(gate('webui:status:read', 'public')).nexted).toBe(true);
    expect(pass(gate('webui:logs:read', 'restricted')).status).toBe(403);
    expect(pass(gate('webui:config:write', 'restricted')).status).toBe(403);
  });

  it('信任档可过 restricted 路由', () => {
    const gate = makeGate({ tier: 'trusted' });
    expect(pass(gate('webui:files:read', 'restricted')).nexted).toBe(true);
    expect(pass(gate('webui:config:write', 'restricted')).nexted).toBe(true);
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
